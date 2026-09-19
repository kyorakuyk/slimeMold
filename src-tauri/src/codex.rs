#[path = "codex_cleanup.rs"]
mod codex_cleanup;
#[path = "codex_process.rs"]
mod codex_process;
#[path = "codex_registry.rs"]
mod codex_registry;

use crate::dev_login_sanitized_env;
use codex_cleanup::{
    await_stdin_write, cleanup_output_artifact, cleanup_output_readers, output_readers_terminal,
    ChildHandle, CodexCleanupHandle, CODEX_CLEANUP_WAIT_TIMEOUT,
};
use codex_process::{run_exec, CodexExecRequest, CodexExecResult};
use codex_registry::{
    active_codex_children, begin_pending_operation, clear_prepared_codex_leases,
    finish_pending_operation, pending_codex_operations, prepared_codex_leases,
    take_cancelled_operation, valid_operation_id, PreparedLease, CODEX_OPERATION_GENERATION,
};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CODEX_PREPARED_LEASE_TTL: Duration = Duration::from_secs(5 * 60);
const CODEX_PREPARED_LEASE_CAP: usize = 128;

#[derive(Clone)]
struct UnscopedRecovery {
    handle: ChildHandle,
    cleanup: CodexCleanupHandle,
}

enum UnscopedRecoverySlot {
    Reserved,
    Retained(UnscopedRecovery),
    Retrying,
}

static UNSCOPED_CODEX_RECOVERIES: OnceLock<Mutex<HashMap<usize, UnscopedRecoverySlot>>> =
    OnceLock::new();
static UNSCOPED_RECOVERY_COUNTER: AtomicU64 = AtomicU64::new(0);
const UNSCOPED_RECOVERY_CAP: usize = 64;

fn unscoped_codex_recoveries() -> &'static Mutex<HashMap<usize, UnscopedRecoverySlot>> {
    UNSCOPED_CODEX_RECOVERIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_unscoped_recovery_slot() -> Result<usize, String> {
    let mut recoveries = unscoped_codex_recoveries()
        .lock()
        .map_err(|_| "Codex unscoped recovery registry 已损坏；side effects unknown".to_string())?;
    if recoveries.len() >= UNSCOPED_RECOVERY_CAP {
        return Err("Codex unscoped recovery registry已达到上限；side effects unknown".into());
    }
    let key = loop {
        let key = UNSCOPED_RECOVERY_COUNTER.fetch_add(1, Ordering::Relaxed) as usize;
        if !recoveries.contains_key(&key) {
            break key;
        }
    };
    recoveries.insert(key, UnscopedRecoverySlot::Reserved);
    Ok(key)
}

fn retain_unscoped_recovery(
    slot: usize,
    handle: &ChildHandle,
    cleanup: &CodexCleanupHandle,
) -> Result<(), String> {
    let mut recoveries = unscoped_codex_recoveries()
        .lock()
        .map_err(|_| "Codex unscoped recovery registry 已损坏；side effects unknown".to_string())?;
    let entry = recoveries
        .get_mut(&slot)
        .ok_or_else(|| "Codex unscoped recovery slot已丢失；side effects unknown".to_string())?;
    if !matches!(entry, UnscopedRecoverySlot::Retained(_)) {
        *entry = UnscopedRecoverySlot::Retained(UnscopedRecovery {
            handle: handle.clone(),
            cleanup: cleanup.clone(),
        });
    }
    Ok(())
}

fn release_unscoped_recovery_slot(slot: usize) -> Result<(), String> {
    let mut recoveries = unscoped_codex_recoveries()
        .lock()
        .map_err(|_| "Codex unscoped recovery registry 已损坏；side effects unknown".to_string())?;
    recoveries
        .remove(&slot)
        .ok_or_else(|| "Codex unscoped recovery slot已丢失；side effects unknown".to_string())?;
    Ok(())
}

fn retry_unscoped_codex_recoveries() -> Result<(), String> {
    let candidates = {
        let mut registry = unscoped_codex_recoveries().lock().map_err(|_| {
            "Codex unscoped recovery registry 已损坏；side effects unknown".to_string()
        })?;
        let keys = registry
            .iter()
            .filter_map(|(key, slot)| {
                matches!(slot, UnscopedRecoverySlot::Retained(_)).then_some(*key)
            })
            .collect::<Vec<_>>();
        let mut candidates = Vec::new();
        for key in keys {
            if let Some(UnscopedRecoverySlot::Retained(owner)) = registry.remove(&key) {
                registry.insert(key, UnscopedRecoverySlot::Retrying);
                candidates.push((key, owner));
            }
        }
        candidates
    };
    let mut errors = Vec::new();
    for (slot, recovery) in candidates {
        if let Err(error) = cleanup_codex_run(&recovery.handle, None, &recovery.cleanup, Some(slot))
        {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(crate) fn clear_codex_session_state() -> Result<(), String> {
    retry_unscoped_codex_recoveries()?;
    let operations = active_codex_children()
        .lock()
        .map_err(|_| "Codex operation registry 已损坏；side effects unknown".to_string())?
        .iter()
        .map(|(operation_id, entry)| (operation_id.clone(), entry.session_generation))
        .collect::<Vec<_>>();
    let mut errors = Vec::new();
    for (operation_id, generation) in operations {
        if let Err(error) = codex_worker_cancel(operation_id, generation) {
            errors.push(error);
        }
    }
    if let Ok(active) = active_codex_children().lock() {
        if !active.is_empty() {
            errors.push(
                "Codex active recovery在session teardown后仍存在；side effects unknown".into(),
            );
        }
    } else {
        errors.push("Codex operation registry 已损坏；side effects unknown".into());
    }
    match pending_codex_operations().lock() {
        Ok(mut pending) => {
            let unresolved = pending.values().any(|entry| !entry.cancellation_requested);
            if unresolved {
                errors.push(
                    "Codex pending operation在session teardown时未取消；side effects unknown"
                        .into(),
                );
            } else {
                pending.retain(|_, entry| !entry.cancellation_requested);
            }
        }
        Err(_) => errors.push("Codex pending registry 已损坏；side effects unknown".into()),
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    clear_prepared_codex_leases()
}

fn same_cwd_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

#[tauri::command]
pub fn codex_worker_prepare(cwd: String, generation: u64) -> Result<String, String> {
    if generation == 0 {
        return Err("Codex Worker session generation 无效".into());
    }
    let _operation_guard = crate::lock_dev_operation();
    crate::assert_session_generation(generation, "codex_worker_prepare")?;
    let worktree = crate::assert_registered_worktree(&cwd)?;
    let (_, identity) = crate::dev_cwd_binding(&cwd)?;
    let token = format!(
        "lease-{}-{}",
        std::process::id(),
        CODEX_OPERATION_GENERATION.fetch_add(1, Ordering::Relaxed)
    );
    let mut leases = prepared_codex_leases()
        .lock()
        .map_err(|_| "Codex prepared lease registry 已损坏".to_string())?;
    let now = Instant::now();
    leases.retain(|_, lease| now.duration_since(lease.created_at) < CODEX_PREPARED_LEASE_TTL);
    if leases.len() >= CODEX_PREPARED_LEASE_CAP {
        return Err("Codex prepared lease数量超过上限".into());
    }
    leases.insert(
        token.clone(),
        PreparedLease {
            session_generation: generation,
            cwd: worktree,
            identity,
            created_at: now,
            cancellation_requested: false,
        },
    );
    Ok(token)
}
fn request_child_tree_kill(child: &mut std::process::Child) -> Vec<String> {
    let mut errors = Vec::new();
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        let result = unsafe { libc::kill(-pid, libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                errors.push(format!("Codex process-group termination failed: {error}"));
            }
        }
    }
    #[cfg(windows)]
    {
        match trusted_windows_system_executable("taskkill.exe") {
            Ok(taskkill) => {
                let pid = child.id().to_string();
                match Command::new(taskkill)
                    .args(["/PID", &pid, "/T", "/F"])
                    .status()
                {
                    Ok(status) if status.success() => {}
                    Ok(status) => errors.push(format!(
                        "Codex taskkill failed with status {}",
                        status
                            .code()
                            .map_or_else(|| "unknown".to_string(), |code| code.to_string())
                    )),
                    Err(error) => errors.push(format!("Codex taskkill failed: {error}")),
                }
            }
            Err(error) => errors.push(error),
        }
    }
    if let Err(error) = child.kill() {
        if error.kind() != std::io::ErrorKind::InvalidInput
            && error.kind() != std::io::ErrorKind::NotFound
        {
            errors.push(format!("Codex direct child termination failed: {error}"));
        }
    }
    errors
}

fn terminate_child_checked(child: &mut std::process::Child) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => {
            return Err(format!(
                "Codex child termination status could not be read: {error}"
            ));
        }
    }
    let errors = request_child_tree_kill(child);
    let deadline = Instant::now() + CODEX_CLEANUP_WAIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                if errors.is_empty() {
                    return Ok(());
                }
                return Err(format!(
                    "Codex child exited but termination fencing failed: {}",
                    errors.join("; ")
                ));
            }
            Ok(None) if Instant::now() >= deadline => {
                let detail = if errors.is_empty() {
                    "termination request did not end the child".to_string()
                } else {
                    errors.join("; ")
                };
                return Err(format!(
                    "Codex child remains alive after bounded termination wait: {detail}"
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                return Err(format!(
                    "Codex child termination status could not be read: {error}; {}",
                    errors.join("; ")
                ));
            }
        }
    }
}

fn apply_env(command: &mut Command, values: HashMap<String, String>) {
    command.env_clear();
    for (key, value) in values {
        command.env(key, value);
    }
}

fn apply_login_sanitized_env(command: &mut Command) {
    apply_env(command, dev_login_sanitized_env());
}

fn unregister_child(operation_id: &str, expected: &ChildHandle) -> Result<(), String> {
    let mut active = active_codex_children()
        .lock()
        .map_err(|_| "Codex operation registry 已损坏；side effects unknown".to_string())?;
    let pending_generation = match active.get(operation_id) {
        Some(current) if Arc::ptr_eq(&current.handle, expected) => current.pending_generation,
        Some(_) => return Err("Codex active child handle mismatch；side effects unknown".into()),
        None => {
            let pending = pending_codex_operations()
                .lock()
                .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
            if !pending
                .get(operation_id)
                .is_some_and(|entry| entry.cancellation_requested)
            {
                return Err("Codex active child registration已丢失；side effects unknown".into());
            }
            let mut handle = expected
                .lock()
                .map_err(|_| "Codex child handle 已损坏；side effects unknown".to_string())?;
            let _ = handle.take();
            return Ok(());
        }
    };
    let pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
    let pending_entry = pending.get(operation_id).ok_or_else(|| {
        "Codex active child对应的pending lease已丢失；side effects unknown".to_string()
    })?;
    if pending_entry.generation != pending_generation {
        return Err(
            "Codex active child与pending lease generation不匹配；side effects unknown".into(),
        );
    }
    let mut handle = expected
        .lock()
        .map_err(|_| "Codex child handle 已损坏；side effects unknown".to_string())?;
    active.remove(operation_id);
    let _ = handle.take();
    Ok(())
}

fn cleanup_codex_run(
    handle: &ChildHandle,
    operation_id: Option<&str>,
    cleanup: &CodexCleanupHandle,
    recovery_slot: Option<usize>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let terminated = match handle.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => match terminate_child_checked(child) {
                Ok(()) => true,
                Err(error) => {
                    errors.push(error);
                    false
                }
            },
            None => true,
        },
        Err(_) => {
            errors.push("Codex child handle 已损坏".to_string());
            false
        }
    };
    if !terminated {
        errors.push("Codex child termination未确认；active handle retained".to_string());
    } else {
        match cleanup_output_readers(cleanup) {
            Ok(()) => {
                if let Err(error) = cleanup_output_artifact(cleanup) {
                    errors.push(error);
                }
            }
            Err(error) => {
                errors.push(error);
                match output_readers_terminal(cleanup) {
                    Ok(true) => {
                        if let Err(error) = cleanup_output_artifact(cleanup) {
                            errors.push(error);
                        }
                    }
                    Ok(false) => {}
                    Err(error) => errors.push(error),
                }
            }
        }
    }
    if errors.is_empty() {
        if let Some(operation_id) = operation_id {
            unregister_child(operation_id, handle)?;
        } else {
            let mut guard = handle
                .lock()
                .map_err(|_| "Codex child handle 已损坏；side effects unknown".to_string())?;
            if let Some(slot) = recovery_slot {
                release_unscoped_recovery_slot(slot)?;
            }
            let _ = guard.take();
        }
        Ok(())
    } else {
        if operation_id.is_none() {
            if let Some(slot) = recovery_slot {
                if let Err(error) = retain_unscoped_recovery(slot, handle, cleanup) {
                    errors.push(error);
                }
            } else {
                errors.push("Codex unscoped recovery slot缺失；side effects unknown".into());
            }
        }
        Err(errors.join("; "))
    }
}

fn append_cleanup_failure(primary: String, cleanup: Result<(), String>) -> String {
    match cleanup {
        Ok(()) => primary,
        Err(error) => format!("{primary}; cleanup failed: {error}; side effects unknown"),
    }
}

fn cleanup_failed_codex_run(
    handle: &ChildHandle,
    operation_id: Option<&str>,
    cleanup: &CodexCleanupHandle,
    recovery_slot: Option<usize>,
    stdin_result: Option<&Receiver<Result<(), String>>>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = cleanup_codex_run(handle, operation_id, cleanup, recovery_slot) {
        errors.push(error);
    }
    if let Err(error) = await_stdin_write(stdin_result) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexAuthStatus {
    pub logged_in: bool,
    pub auth_mode: String,
    pub detail: String,
}

fn trusted_native_file(path: &std::path::Path) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let canonical_metadata = fs::symlink_metadata(&canonical).ok()?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_file() {
        return None;
    }
    Some(canonical)
}

#[cfg(windows)]
fn trusted_windows_system_executable(name: &str) -> Result<PathBuf, String> {
    let root =
        env::var_os("SystemRoot").ok_or_else(|| "未找到可信的 Windows SystemRoot".to_string())?;
    let candidate = PathBuf::from(root).join("System32").join(name);
    trusted_native_file(&candidate).ok_or_else(|| format!("未找到可信的 Windows {name}"))
}

fn codex_program() -> Result<PathBuf, String> {
    let names: &[&str] = if cfg!(windows) {
        &["codex.cmd", "codex.exe", "codex"]
    } else {
        &["codex"]
    };

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            for name in names {
                let candidate = dir.join(name);
                if let Some(trusted) = trusted_native_file(&candidate) {
                    return Ok(trusted);
                }
            }
        }
    }

    if cfg!(windows) {
        if let Some(app_data) = env::var_os("APPDATA") {
            let candidate = PathBuf::from(app_data).join("npm").join("codex.cmd");
            if let Some(trusted) = trusted_native_file(&candidate) {
                return Ok(trusted);
            }
        }
    }

    Err("未找到可信的 Codex CLI。请先安装 @openai/codex，并确保 codex 在 PATH 中。".into())
}

fn command_detail(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stdout.is_empty() {
        stderr
    } else if stderr.is_empty() {
        stdout
    } else {
        format!("{stdout}\n{stderr}")
    }
}

fn trim_detail(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{out}…")
    } else {
        out
    }
}

#[tauri::command]
pub fn codex_login_status() -> Result<CodexAuthStatus, String> {
    let program = codex_program()?;
    let mut command = Command::new(program);
    command.args(["login", "status"]);
    apply_login_sanitized_env(&mut command);
    let result = crate::run_with_timeout(&mut command, Duration::from_secs(10))?;
    let detail = if result.stdout.trim().is_empty() {
        result.stderr.trim().to_string()
    } else if result.stderr.trim().is_empty() {
        result.stdout.trim().to_string()
    } else {
        format!("{}\n{}", result.stdout.trim(), result.stderr.trim())
    };
    let lower = detail.to_lowercase();
    let logged_in = result.code == 0
        && !lower.contains("not logged")
        && (lower.contains("logged in")
            || lower.contains("chatgpt")
            || lower.contains("api key")
            || lower.contains("access token"));
    let auth_mode = if lower.contains("chatgpt") {
        "chatgpt"
    } else if lower.contains("api key") {
        "api"
    } else if lower.contains("access token") {
        "access-token"
    } else {
        "unknown"
    };
    Ok(CodexAuthStatus {
        logged_in,
        auth_mode: auth_mode.into(),
        detail: trim_detail(&detail, 300),
    })
}

#[tauri::command]
pub fn codex_login() -> Result<(), String> {
    let program = codex_program()?;
    let mut command = Command::new(program);
    command.arg("login");
    apply_login_sanitized_env(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法启动 Codex 登录流程：{e}"))
}

#[tauri::command]
pub fn codex_logout() -> Result<(), String> {
    let program = codex_program()?;
    let mut command = Command::new(program);
    command.arg("logout");
    apply_login_sanitized_env(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("无法执行 Codex 登出：{e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Codex 登出失败：{}",
            trim_detail(&command_detail(&output), 300)
        ))
    }
}

struct UnregisteredChildCleanupError {
    message: String,
}

fn cleanup_unregistered_codex_child(
    handle: &ChildHandle,
    cleanup: &CodexCleanupHandle,
) -> Result<(), UnregisteredChildCleanupError> {
    let mut errors = Vec::new();
    let terminated = match handle.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => match terminate_child_checked(child) {
                Ok(()) => {
                    let _ = guard.take();
                    true
                }
                Err(error) => {
                    errors.push(error);
                    false
                }
            },
            None => true,
        },
        Err(_) => {
            errors.push("Codex child handle 已损坏".to_string());
            false
        }
    };
    if !terminated {
        errors.push("Codex child termination未确认；recovery retained".into());
    } else {
        match cleanup_output_readers(cleanup) {
            Ok(()) => {
                if let Err(error) = cleanup_output_artifact(cleanup) {
                    errors.push(error);
                }
            }
            Err(error) => {
                errors.push(error);
                match output_readers_terminal(cleanup) {
                    Ok(true) => {
                        if let Err(error) = cleanup_output_artifact(cleanup) {
                            errors.push(error);
                        }
                    }
                    Ok(false) => {}
                    Err(error) => errors.push(error),
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(UnregisteredChildCleanupError {
            message: errors.join("; "),
        })
    }
}

#[tauri::command]
pub async fn codex_exec(prompt: String, model: Option<String>) -> Result<CodexExecResult, String> {
    if prompt.trim().is_empty() {
        return Err("Codex 请求不能为空。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _operation_guard = crate::lock_dev_operation();
        retry_unscoped_codex_recoveries()?;
        let auth = codex_login_status()?;
        if !auth.logged_in {
            return Err("未检测到 Codex 的 ChatGPT 登录，请先登录。".into());
        }
        if auth.auth_mode != "chatgpt" {
            return Err("当前 Codex 使用的不是 ChatGPT 计划登录（可能是 API Key）。请先执行 Codex 登出，再用 ChatGPT 登录。".into());
        }
        let program = codex_program()?;
        run_exec(CodexExecRequest {
            program,
            prompt,
            model,
            cwd: None,
            sandbox_mode: "read-only",
            operation_id: None,
            session_generation: None,
            pending_operation_generation: None,
            prepared_cwd_identity: None,
        })
    })
    .await
    .map_err(|e| format!("Codex 后台任务失败：{e}"))?
}

/// 在宿主已登记的独立 worktree 内运行可写 Worker。
///
/// 这是与只读 master provider 分开的命令：cwd 必须属于 Rust 登记的
/// worktree，且不接受主仓库根；Worker 失败时由调用方根据结果决定队列状态。
#[tauri::command]
pub async fn codex_worker_exec(
    prompt: String,
    model: Option<String>,
    cwd: String,
    operation_id: String,
    generation: u64,
) -> Result<CodexExecResult, String> {
    if prompt.trim().is_empty() {
        return Err("Codex Worker 请求不能为空。".into());
    }
    if !valid_operation_id(&operation_id) {
        return Err("Codex operation token 非法".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _operation_guard = crate::lock_dev_operation();
        crate::assert_session_generation(generation, "codex_worker_exec")?;
        let worktree = crate::assert_registered_worktree(&cwd)?;
        let (_, current_identity) = crate::dev_cwd_binding(&cwd)?;
        let prepared = prepared_codex_leases()
            .lock()
            .map_err(|_| "Codex prepared lease registry 已损坏".to_string())?
            .get(&operation_id)
            .cloned()
            .ok_or_else(|| "Codex Worker lease不存在或已使用".to_string())?;
        if Instant::now().duration_since(prepared.created_at) >= CODEX_PREPARED_LEASE_TTL {
            prepared_codex_leases()
                .lock()
                .map_err(|_| "Codex prepared lease registry 已损坏".to_string())?
                .remove(&operation_id);
            return Err("Codex Worker lease已过期".into());
        }
        if prepared.session_generation != generation
            || !same_cwd_path(&prepared.cwd, &worktree)
            || prepared.identity != current_identity
        {
            return Err("Codex Worker lease与当前session/cwd不匹配".into());
        }
        let pending_generation = begin_pending_operation(&operation_id, generation)?;
        let prepared = match prepared_codex_leases().lock() {
            Err(error) => {
                let finish_error = finish_pending_operation(&operation_id, pending_generation)
                    .err()
                    .unwrap_or_else(|| "pending lease cleanup attempted".to_string());
                return Err(format!(
                    "Codex prepared lease registry 已损坏：{error}; {finish_error}"
                ));
            }
            Ok(mut leases) => match leases.remove(&operation_id) {
                Some(prepared) => prepared,
                None => {
                    drop(leases);
                    finish_pending_operation(&operation_id, pending_generation)?;
                    return Err("Codex Worker lease在启动前消失".into());
                }
            },
        };
        if prepared.cancellation_requested {
            finish_pending_operation(&operation_id, pending_generation)?;
            return Err("Codex Worker 已取消".into());
        }
        let result = (|| {
            let auth = codex_login_status()?;
            if take_cancelled_operation(&operation_id)? {
                return Err("Codex Worker 已取消".into());
            }
            if !auth.logged_in {
                return Err("未检测到 Codex 的 ChatGPT 登录，请先登录。".into());
            }
            if auth.auth_mode != "chatgpt" {
                return Err("当前 Codex 使用的不是 ChatGPT 计划登录（可能是 API Key）。请先执行 Codex 登出，再用 ChatGPT 登录。".into());
            }
            let program = codex_program()?;
            run_exec(CodexExecRequest {
                program,
                prompt,
                model,
                cwd: Some(worktree),
                sandbox_mode: "workspace-write",
                operation_id: Some(operation_id.clone()),
                session_generation: Some(generation),
                pending_operation_generation: Some(pending_generation),
                prepared_cwd_identity: Some(prepared.identity),
            })
        })();
        let cancelled_during_finalization = finish_pending_operation(&operation_id, pending_generation)?;
        if cancelled_during_finalization {
            Err("Codex Worker 在finalization期间被取消；side effects unknown".into())
        } else {
            result
        }
    })
    .await
    .map_err(|e| format!("Codex Worker 后台任务失败：{e}"))?
}

/// 取消当前 SlimeMold 进程注册的 Codex Worker；未知 operation 视为幂等成功。
#[tauri::command]
pub fn codex_worker_cancel(operation_id: String, generation: u64) -> Result<(), String> {
    if !valid_operation_id(&operation_id) {
        return Err("Codex operation id 非法".into());
    }
    if generation == 0 {
        return Err("Codex Worker session generation 无效".into());
    }
    let mut active = active_codex_children()
        .lock()
        .map_err(|_| "Codex operation registry 已损坏".to_string())?;
    if let Some(entry) = active.get(&operation_id) {
        if entry.session_generation != generation {
            return Ok(());
        }
        {
            let mut pending = pending_codex_operations()
                .lock()
                .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
            let pending_entry = pending.get_mut(&operation_id).ok_or_else(|| {
                "Codex active child对应的pending lease已丢失；side effects unknown".to_string()
            })?;
            if pending_entry.session_generation != generation {
                return Err(
                    "Codex active child与pending lease session generation不匹配；side effects unknown"
                        .into(),
                );
            }
            if pending_entry.generation != entry.pending_generation {
                return Err(
                    "Codex active child与pending lease generation不匹配；side effects unknown"
                        .into(),
                );
            }
            pending_entry.cancellation_requested = true;
        }
        let handle = entry.handle.clone();
        let cleanup = entry.cleanup.clone();
        let mut guard = handle
            .lock()
            .map_err(|_| "Codex child handle 已损坏；side effects unknown".to_string())?;
        if let Some(child) = guard.as_mut() {
            terminate_child_checked(child).map_err(|error| {
                format!(
                    "Codex Worker cancellation termination failed; side effects unknown: {error}"
                )
            })?;
        }
        drop(guard);
        let mut cleanup_errors = Vec::new();
        let readers_terminal = match cleanup_output_readers(&cleanup) {
            Ok(()) => true,
            Err(error) => {
                cleanup_errors.push(error);
                output_readers_terminal(&cleanup).unwrap_or(false)
            }
        };
        if readers_terminal {
            if let Err(error) = cleanup_output_artifact(&cleanup) {
                cleanup_errors.push(error);
            }
        }
        if !cleanup_errors.is_empty() {
            return Err(format!(
                "Codex Worker cancellation cleanup failed; active recovery retained; side effects unknown: {}",
                cleanup_errors.join("; ")
            ));
        }
        active.remove(&operation_id);
    } else {
        let mut prepared = prepared_codex_leases()
            .lock()
            .map_err(|_| "Codex prepared lease registry 已损坏".to_string())?;
        let remove_prepared = prepared
            .get(&operation_id)
            .is_some_and(|entry| entry.session_generation == generation);
        if remove_prepared {
            prepared.remove(&operation_id);
        }
        drop(prepared);
        if let Some(entry) = pending_codex_operations()
            .lock()
            .map_err(|_| "Codex pending registry 已损坏".to_string())?
            .get_mut(&operation_id)
        {
            if entry.session_generation == generation {
                entry.cancellation_requested = true;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::codex_cleanup::{
        create_codex_output, join_cleanup_reader, ChildHandle, CodexCleanupContext,
        CodexOutputReader, CODEX_TEMP_COUNTER,
    };
    use super::codex_process::{build_exec_args, parse_json_events};
    use super::codex_registry::{
        active_codex_children, begin_pending_operation, finish_pending_operation,
        pending_codex_operations, reserve_codex_operation, take_cancelled_operation,
        validate_operation_binding,
    };
    use super::{
        cleanup_codex_run, cleanup_unregistered_codex_child, codex_worker_cancel,
        reserve_unscoped_recovery_slot, unscoped_codex_recoveries, valid_operation_id,
    };
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn worker_exec_uses_workspace_write_without_full_access() {
        let args = build_exec_args("workspace-write");
        assert!(!args
            .windows(2)
            .any(|pair| pair == ["--sandbox", "workspace-write"]));
        assert!(args.iter().any(|arg| arg == "--approve-for-me"));
        assert!(!args.iter().any(|arg| arg == "danger-full-access"));
    }

    #[test]
    fn selects_the_last_agent_message_and_turn_usage() {
        let output = concat!(
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"thinking\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"final\"}}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"cached_input_tokens\":3,\"output_tokens\":5}}\n",
        );
        let (message, usage, failure) = parse_json_events(output);

        assert_eq!(message.as_deref(), Some("final"));
        assert!(failure.is_none());
        let usage = usage.expect("usage should be parsed");
        assert_eq!(usage.prompt_tokens, Some(12));
        assert_eq!(usage.cached_prompt_tokens, Some(3));
        assert_eq!(usage.completion_tokens, Some(5));
        assert_eq!(usage.total_tokens, Some(17));
    }

    #[test]
    fn captures_turn_failure_message() {
        let output = r#"{"type":"turn.failed","error":{"message":"login required"}}"#;
        let (message, usage, failure) = parse_json_events(output);

        assert!(message.is_none());
        assert!(usage.is_none());
        assert_eq!(failure.as_deref(), Some("login required"));
    }

    #[test]
    fn cancellation_is_idempotent_and_operation_ids_are_bounded() {
        codex_worker_cancel("not-running".into(), 1).expect("unknown operation is a no-op");
        assert!(valid_operation_id("worker-abc_123"));
        assert!(!valid_operation_id(""));
        assert!(!valid_operation_id("worker/with-slash"));
        assert!(!valid_operation_id(&"x".repeat(129)));
    }

    #[test]
    fn cancellation_fences_a_pending_login_operation() {
        let operation = format!(
            "pending-{}-{}",
            std::process::id(),
            CODEX_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let generation =
            begin_pending_operation(&operation, 1).expect("pending operation should register");
        codex_worker_cancel(operation.clone(), 1)
            .expect("pending cancellation should be idempotent");
        assert!(take_cancelled_operation(&operation).expect("pending registry should be healthy"));
        let _ = finish_pending_operation(&operation, generation);
    }

    #[test]
    fn stale_pending_finish_cannot_remove_new_generation() {
        let operation = format!(
            "generation-{}-{}",
            std::process::id(),
            CODEX_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let first = begin_pending_operation(&operation, 1).expect("first lease should register");
        let _ = finish_pending_operation(&operation, first);
        let second = begin_pending_operation(&operation, 1).expect("second lease should register");
        let _ = finish_pending_operation(&operation, first);
        assert!(begin_pending_operation(&operation, 1).is_err());
        let _ = finish_pending_operation(&operation, second);
    }

    #[test]
    fn pending_finish_retains_the_active_recovery_fence() {
        let operation = format!(
            "active-recovery-{}-{}",
            std::process::id(),
            CODEX_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let generation =
            begin_pending_operation(&operation, 41).expect("pending operation should register");
        let mut reservation = reserve_codex_operation(&operation, 41, generation)
            .expect("matching operation should reserve");
        let handle: ChildHandle = Arc::new(Mutex::new(None));
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path: PathBuf::new(),
            stdout: None,
            stderr: None,
            stdout_done: true,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        reservation
            .register_child(handle, cleanup)
            .expect("active recovery should register");
        drop(reservation);
        assert!(finish_pending_operation(&operation, generation).is_err());
        assert!(pending_codex_operations()
            .lock()
            .expect("pending registry should remain healthy")
            .contains_key(&operation));
        active_codex_children()
            .lock()
            .expect("active registry should remain healthy")
            .remove(&operation);
        assert!(finish_pending_operation(&operation, generation).is_ok());
    }

    #[test]
    fn unscoped_cleanup_failure_retains_a_host_recovery_owner() {
        let handle: ChildHandle = Arc::new(Mutex::new(None));
        let poison_handle = handle.clone();
        thread::spawn(move || {
            let _guard = poison_handle.lock().expect("handle should initially lock");
            panic!("poison the synthetic child handle");
        })
        .join()
        .expect_err("synthetic poison thread should panic");
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path: PathBuf::new(),
            stdout: None,
            stderr: None,
            stdout_done: true,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        let slot = reserve_unscoped_recovery_slot().expect("recovery slot should reserve");
        assert!(cleanup_codex_run(&handle, None, &cleanup, Some(slot)).is_err());
        assert!(matches!(
            unscoped_codex_recoveries()
                .lock()
                .expect("unscoped registry should remain healthy")
                .remove(&slot),
            Some(super::UnscopedRecoverySlot::Retained(_))
        ));
    }
    #[test]
    fn operation_id_requires_nonzero_session_generation() {
        assert!(validate_operation_binding(None, None, None).is_ok());
        assert!(validate_operation_binding(Some("worker-1"), Some(7), Some(3)).is_ok());
        assert!(validate_operation_binding(Some("worker-1"), None, Some(3)).is_err());
        assert!(validate_operation_binding(Some("worker-1"), Some(0), Some(3)).is_err());
        assert!(validate_operation_binding(Some("worker-1"), Some(7), None).is_err());
        assert!(validate_operation_binding(None, Some(7), None).is_err());
    }

    #[test]
    fn reservation_rejects_cancelled_pending_operation() {
        let operation = format!(
            "cancelled-reservation-{}-{}",
            std::process::id(),
            CODEX_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let generation =
            begin_pending_operation(&operation, 23).expect("pending operation should register");
        codex_worker_cancel(operation.clone(), 23).expect("pending cancellation should succeed");
        assert!(reserve_codex_operation(&operation, 23, generation).is_err());
        let _ = finish_pending_operation(&operation, generation);
    }

    #[test]
    fn reservation_rejects_pending_session_generation_mismatch() {
        let operation = format!(
            "reservation-{}-{}",
            std::process::id(),
            CODEX_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let generation =
            begin_pending_operation(&operation, 17).expect("pending operation should register");
        assert!(reserve_codex_operation(&operation, 18, generation).is_err());
        assert!(reserve_codex_operation(&operation, 17, generation.wrapping_add(1)).is_err());
        let reservations = reserve_codex_operation(&operation, 17, generation)
            .expect("matching generation should reserve");
        drop(reservations);
        let _ = finish_pending_operation(&operation, generation);
    }

    #[test]
    fn reservation_serializes_cancel_before_child_registration() {
        let operation = format!(
            "interleaving-{}-{}",
            std::process::id(),
            CODEX_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let pending_generation =
            begin_pending_operation(&operation, 31).expect("pending operation should register");
        let mut reservation = reserve_codex_operation(&operation, 31, pending_generation)
            .expect("matching reservation should acquire both registry locks");
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let cancel_operation = operation.clone();
        let cancel_thread = thread::spawn(move || {
            started_tx.send(()).expect("cancel thread should start");
            codex_worker_cancel(cancel_operation, 31).expect("cancel should complete");
            finished_tx.send(()).expect("cancel thread should finish");
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancel thread should reach the reservation window");
        assert!(finished_rx.try_recv().is_err());

        let child: ChildHandle = Arc::new(Mutex::new(None));
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path: PathBuf::new(),
            stdout: None,
            stderr: None,
            stdout_done: true,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        reservation
            .register_child(child, cleanup)
            .expect("cancel cannot bypass the held reservation before registration");
        drop(reservation);
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancel should complete after reservation release");
        cancel_thread
            .join()
            .expect("cancel thread should not panic");
        assert!(take_cancelled_operation(&operation).expect("pending registry should be healthy"));
        let _ = finish_pending_operation(&operation, pending_generation);
    }

    #[test]
    fn exited_child_cleanup_consumes_handle_once_and_removes_artifact() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("exited-child fixture should spawn");
        for _ in 0..100 {
            if child
                .try_wait()
                .expect("exited-child status should be readable")
                .is_some()
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let handle: ChildHandle = Arc::new(Mutex::new(Some(child)));
        let output_path = create_codex_output().expect("private output artifact should be created");
        let output_parent = output_path
            .parent()
            .expect("output should have a private parent")
            .to_path_buf();
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path,
            stdout: None,
            stderr: None,
            stdout_done: true,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        let slot = reserve_unscoped_recovery_slot().expect("recovery slot should reserve");
        let result = cleanup_codex_run(&handle, None, &cleanup, Some(slot));
        assert!(result.is_ok(), "cleanup should succeed: {result:?}");
        assert!(handle
            .lock()
            .expect("child handle should remain healthy")
            .is_none());
        assert!(!output_parent.exists());
    }

    #[test]
    fn reader_timeout_retains_reader_for_a_later_cleanup_attempt() {
        let release = Arc::new(std::sync::Barrier::new(2));
        let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
        let reader_release = Arc::clone(&release);
        let thread = thread::spawn(move || {
            reader_release.wait();
            sender
                .send(Ok(b"recovered".to_vec()))
                .expect("reader result should send");
        });
        let reader: CodexOutputReader = (thread, receiver);
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path: PathBuf::new(),
            stdout: Some(reader),
            stderr: None,
            stdout_done: false,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        let first = join_cleanup_reader(&cleanup, true);
        assert!(
            first.is_err(),
            "blocked reader should hit the bounded cleanup wait"
        );
        {
            let state = cleanup.lock().expect("cleanup state should remain healthy");
            assert!(
                state.stdout.is_some(),
                "timed-out reader must remain recoverable"
            );
            assert!(!state.stdout_done);
            assert!(!state.stdout_joining);
        }
        release.wait();
        assert_eq!(
            join_cleanup_reader(&cleanup, true).expect("retry should join reader"),
            b"recovered"
        );
        let state = cleanup.lock().expect("cleanup state should remain healthy");
        assert!(state.stdout.is_none());
        assert!(state.stdout_done);
    }

    #[test]
    fn reader_error_is_terminal_but_remains_observable_for_recovery() {
        let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
        let thread = thread::spawn(move || {
            sender
                .send(Err("synthetic reader failure".into()))
                .expect("reader error should send");
        });
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path: PathBuf::new(),
            stdout: Some((thread, receiver)),
            stderr: None,
            stdout_done: false,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        let first = join_cleanup_reader(&cleanup, true).expect_err("reader error should surface");
        assert_eq!(first, "synthetic reader failure");
        let state = cleanup.lock().expect("cleanup state should remain healthy");
        assert!(state.stdout.is_none());
        assert!(state.stdout_done);
        assert_eq!(
            state.stdout_error.as_deref(),
            Some("synthetic reader failure")
        );
        drop(state);
        assert_eq!(
            join_cleanup_reader(&cleanup, true)
                .expect_err("terminal reader error should remain visible"),
            "synthetic reader failure"
        );
    }
    #[test]
    fn disconnected_reader_is_terminal_and_joined() {
        let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
        drop(sender);
        let thread = thread::spawn(|| {});
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path: PathBuf::new(),
            stdout: Some((thread, receiver)),
            stderr: None,
            stdout_done: false,
            stderr_done: true,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        let error = join_cleanup_reader(&cleanup, true).expect_err("disconnect should fail closed");
        assert!(error.contains("terminal failure"));
        let state = cleanup.lock().expect("cleanup state should remain healthy");
        assert!(state.stdout_done);
        assert!(state.stdout.is_none());
        assert!(state.stdout_error.is_some());
    }
    #[test]
    fn unregistered_child_cleanup_reaps_readers_and_artifact() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("cleanup fixture child should spawn");
        let stdout_thread = child.stdout.take().map(crate::spawn_output_reader);
        let stderr_thread = child.stderr.take().map(crate::spawn_output_reader);
        for _ in 0..100 {
            if child
                .try_wait()
                .expect("fixture child status should be readable")
                .is_some()
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let output_path = create_codex_output().expect("private output artifact should be created");
        let output_parent = output_path
            .parent()
            .expect("output should have a private parent")
            .to_path_buf();
        let cleanup = Arc::new(Mutex::new(CodexCleanupContext {
            output_path,
            stdout: stdout_thread,
            stderr: stderr_thread,
            stdout_done: false,
            stderr_done: false,
            stdout_error: None,
            stderr_error: None,
            stdout_joining: false,
            stderr_joining: false,
        }));
        let handle: ChildHandle = Arc::new(Mutex::new(Some(child)));
        let result = cleanup_unregistered_codex_child(&handle, &cleanup);
        if let Err(error) = result {
            panic!("cleanup failed: {}", error.message);
        }
        assert!(handle
            .lock()
            .expect("child handle should remain healthy")
            .is_none());
        assert!(!output_parent.exists());
    }
}
