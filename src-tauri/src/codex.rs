use crate::dev_login_sanitized_env;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static CODEX_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const CODEX_EXEC_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CODEX_OUTPUT_CAP: usize = 16 * 1024 * 1024;
const CODEX_PREPARED_LEASE_TTL: Duration = Duration::from_secs(5 * 60);
const CODEX_PREPARED_LEASE_CAP: usize = 128;
type ChildHandle = Arc<Mutex<Option<std::process::Child>>>;
struct ActiveChild {
    session_generation: u64,
    handle: ChildHandle,
}

static ACTIVE_CODEX_CHILDREN: OnceLock<Mutex<HashMap<String, ActiveChild>>> = OnceLock::new();

fn active_codex_children() -> &'static Mutex<HashMap<String, ActiveChild>> {
    ACTIVE_CODEX_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
struct PreparedLease {
    session_generation: u64,
    cwd: PathBuf,
    identity: crate::StableDirectoryIdentity,
    created_at: Instant,
    cancellation_requested: bool,
}

static PREPARED_CODEX_LEASES: OnceLock<Mutex<HashMap<String, PreparedLease>>> = OnceLock::new();

fn prepared_codex_leases() -> &'static Mutex<HashMap<String, PreparedLease>> {
    PREPARED_CODEX_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn clear_prepared_codex_leases() -> Result<(), String> {
    prepared_codex_leases()
        .lock()
        .map_err(|_| "Codex prepared lease registry 已损坏".to_string())?
        .clear();
    Ok(())
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
#[derive(Clone, Copy)]
struct PendingOperation {
    generation: u64,
    session_generation: u64,
    cancellation_requested: bool,
}

static PENDING_CODEX_OPERATIONS: OnceLock<Mutex<HashMap<String, PendingOperation>>> =
    OnceLock::new();
static CODEX_OPERATION_GENERATION: AtomicU64 = AtomicU64::new(0);

fn pending_codex_operations() -> &'static Mutex<HashMap<String, PendingOperation>> {
    PENDING_CODEX_OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_pending_operation(operation_id: &str, session_generation: u64) -> Result<u64, String> {
    let mut pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏".to_string())?;
    if pending.contains_key(operation_id) {
        return Err("Codex operation id 已在使用".into());
    }
    let generation = CODEX_OPERATION_GENERATION.fetch_add(1, Ordering::Relaxed);
    pending.insert(
        operation_id.to_string(),
        PendingOperation {
            generation,
            session_generation,
            cancellation_requested: false,
        },
    );
    Ok(generation)
}

fn finish_pending_operation(operation_id: &str, generation: u64) -> Result<bool, String> {
    let mut pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
    let entry = pending
        .get(operation_id)
        .ok_or_else(|| "Codex pending lease已丢失；side effects unknown".to_string())?;
    if entry.generation != generation {
        return Err("Codex pending lease generation不匹配；side effects unknown".into());
    }
    let cancelled = entry.cancellation_requested;
    pending.remove(operation_id);
    Ok(cancelled)
}

fn take_cancelled_operation(operation_id: &str) -> Result<bool, String> {
    let pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
    Ok(pending
        .get(operation_id)
        .is_some_and(|entry| entry.cancellation_requested))
}

fn valid_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= 128
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn create_codex_output() -> Result<PathBuf, String> {
    let temp_root = env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = CODEX_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let directory = temp_root.join(format!(
        "slimemold-codex-{stamp}-{}-{sequence}",
        std::process::id()
    ));
    fs::create_dir(&directory).map_err(|error| format!("创建Codex output私有目录失败：{error}"))?;
    let output_path = directory.join("last-message.txt");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Err(error) = options.open(&output_path) {
        let _ = fs::remove_dir(&directory);
        return Err(format!("创建Codex output exclusive file失败：{error}"));
    }
    Ok(output_path)
}

fn read_codex_output(path: &std::path::Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "读取Codex output-last-message metadata失败：{error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Codex output-last-message 不是regular file".into());
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    };
    #[cfg(not(any(unix, windows)))]
    let file = fs::File::open(path);
    let file = file.map_err(|error| format!("读取Codex output-last-message失败：{error}"))?;
    let mut bytes = Vec::new();
    file.take((CODEX_OUTPUT_CAP + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取Codex output-last-message失败：{error}"))?;
    if bytes.len() > CODEX_OUTPUT_CAP {
        return Err("Codex output-last-message 超过16MiB上限".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| format!("Codex output-last-message不是UTF-8：{error}"))
}

fn remove_codex_output(path: &std::path::Path) -> Result<(), String> {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("删除Codex output-last-message失败：{error}"));
        }
    }
    if let Some(directory) = path.parent() {
        match fs::remove_dir(directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除Codex output私有目录失败：{error}")),
        }
    } else {
        Ok(())
    }
}

fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            let _ = libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(taskkill) = trusted_windows_system_executable("taskkill.exe") {
            let pid = child.id().to_string();
            let _ = Command::new(taskkill)
                .args(["/PID", &pid, "/T", "/F"])
                .status();
        }
    }
    let _ = child.kill();
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

fn unregister_child(operation_id: &str, expected: &ChildHandle) {
    if let Ok(mut active) = active_codex_children().lock() {
        let matches = active
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(&current.handle, expected));
        if matches {
            active.remove(operation_id);
        }
    }
}

fn cleanup_codex_run(
    handle: &ChildHandle,
    operation_id: Option<&str>,
    output_path: &std::path::Path,
) {
    if let Some(operation_id) = operation_id {
        unregister_child(operation_id, handle);
    }
    if let Ok(mut guard) = handle.lock() {
        if let Some(child) = guard.as_mut() {
            kill_child_tree(child);
            let _ = child.wait();
        }
    }
    if let Err(error) = remove_codex_output(output_path) {
        eprintln!("[codex] {error}; side effects unknown");
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexAuthStatus {
    pub logged_in: bool,
    pub auth_mode: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexUsage {
    pub prompt_tokens: Option<u64>,
    pub cached_prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexExecResult {
    pub text: String,
    pub usage: Option<CodexUsage>,
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

fn usage_from_value(value: &Value) -> Option<CodexUsage> {
    let usage = value.get("usage")?;
    let prompt_tokens = usage.get("input_tokens").and_then(Value::as_u64);
    let cached_prompt_tokens = usage.get("cached_input_tokens").and_then(Value::as_u64);
    let completion_tokens = usage.get("output_tokens").and_then(Value::as_u64);
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .or_else(|| prompt_tokens.zip(completion_tokens).map(|(p, c)| p + c));
    if prompt_tokens.is_none()
        && cached_prompt_tokens.is_none()
        && completion_tokens.is_none()
        && total_tokens.is_none()
    {
        return None;
    }
    Some(CodexUsage {
        prompt_tokens,
        cached_prompt_tokens,
        completion_tokens,
        total_tokens,
    })
}

fn parse_json_events(stdout: &str) -> (Option<String>, Option<CodexUsage>, Option<String>) {
    let mut last_message = None;
    let mut usage = None;
    let mut failure = None;

    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("turn.completed") {
            usage = usage_from_value(&value);
        }
        if value.get("type").and_then(Value::as_str) == Some("turn.failed") {
            failure = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }

        let item = value.get("item").unwrap_or(&value);
        if item.get("type").and_then(Value::as_str) == Some("agent_message") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                last_message = Some(text.to_string());
            }
        }
    }

    (last_message, usage, failure)
}

fn build_exec_args(sandbox_mode: &str) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "--json", "--ephemeral"]
        .into_iter()
        .map(str::to_string)
        .collect();
    if sandbox_mode == "workspace-write" {
        args.push("--approve-for-me".to_string());
    } else {
        args.extend(["--sandbox".to_string(), sandbox_mode.to_string()]);
    }
    args.extend(
        [
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--output-last-message",
        ]
        .into_iter()
        .map(str::to_string),
    );
    args
}

fn join_child_output(
    output: Option<(crate::OutputThread, crate::OutputReceiver)>,
) -> Result<Vec<u8>, String> {
    let (thread, receiver) = output.ok_or_else(|| "Codex output reader 未启动".to_string())?;
    crate::receive_output("Codex", thread, receiver)
}

fn spawn_stdin_writer(
    mut stdin: std::process::ChildStdin,
    prompt: String,
) -> Receiver<Result<(), String>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = stdin
            .write_all(prompt.as_bytes())
            .map_err(|error| format!("向 Codex CLI 写入请求失败：{error}"));
        drop(stdin);
        let _ = sender.send(result);
    });
    receiver
}

fn await_stdin_write(receiver: Option<&Receiver<Result<(), String>>>) -> Result<(), String> {
    let Some(receiver) = receiver else {
        return Ok(());
    };
    match receiver.recv_timeout(Duration::from_secs(1)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Codex stdin writer 未在清理窗口内结束；side effects unknown".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Codex stdin writer 已断开；side effects unknown".into())
        }
    }
}

fn run_exec(
    program: PathBuf,
    prompt: String,
    model: Option<String>,
    cwd: Option<PathBuf>,
    sandbox_mode: &str,
    operation_id: Option<String>,
    session_generation: Option<u64>,
    prepared_cwd_identity: Option<crate::StableDirectoryIdentity>,
) -> Result<CodexExecResult, String> {
    if let Some(operation_id) = operation_id.as_deref() {
        if !valid_operation_id(operation_id) {
            return Err("Codex operation id 非法".into());
        }
    }
    let spawn_cwd = cwd.clone().unwrap_or_else(env::temp_dir);
    let expected_cwd_identity = match prepared_cwd_identity {
        Some(identity) => Some(identity),
        None => cwd
            .as_ref()
            .map(|path| {
                crate::dev_cwd_binding(&path.to_string_lossy()).map(|(_, identity)| identity)
            })
            .transpose()?,
    };
    let mut active_reservation: Option<
        std::sync::MutexGuard<'static, HashMap<String, ActiveChild>>,
    > = None;
    let mut pending_reservation: Option<
        std::sync::MutexGuard<'static, HashMap<String, PendingOperation>>,
    > = None;
    if let Some(operation_id) = operation_id.as_deref() {
        let active = active_codex_children()
            .lock()
            .map_err(|_| "Codex operation registry 已损坏；side effects unknown".to_string())?;
        let pending = pending_codex_operations()
            .lock()
            .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
        let cancelled = pending
            .get(operation_id)
            .map(|entry| entry.cancellation_requested)
            .ok_or_else(|| "Codex pending lease已丢失；side effects unknown".to_string())?;
        if cancelled || active.contains_key(operation_id) {
            return Err("Codex Worker 已取消或operation token已在使用".into());
        }
        active_reservation = Some(active);
        pending_reservation = Some(pending);
    }

    let output_path = create_codex_output()?;

    let mut command = Command::new(program);
    command.args(build_exec_args(sandbox_mode));
    command.arg(&output_path);
    if let Some(model) = model.as_deref().filter(|value| !value.trim().is_empty()) {
        command.args(["--model", model]);
    }
    // SlimeMold 的 Codex provider 明确使用 Codex CLI 的 ChatGPT 登录态，
    // 不把父进程中可能存在的 credential family 误带入本次调用。
    command.env_clear();
    for (key, value) in dev_login_sanitized_env() {
        command.env(key, value);
    }
    command
        .current_dir(&spawn_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    if let Some(expected_identity) = expected_cwd_identity {
        let current_identity = match crate::dev_cwd_binding(&spawn_cwd.to_string_lossy()) {
            Ok((_, identity)) => identity,
            Err(error) => {
                if let Err(cleanup_error) = remove_codex_output(&output_path) {
                    eprintln!("[codex] {cleanup_error}; side effects unknown");
                }
                return Err(error);
            }
        };
        if current_identity != expected_identity {
            if let Err(cleanup_error) = remove_codex_output(&output_path) {
                return Err(format!(
                    "Codex cwd identity 在最终spawn前发生变化；output cleanup失败：{cleanup_error}"
                ));
            }
            return Err("Codex cwd identity 在最终spawn前发生变化".into());
        }
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Err(cleanup_error) = remove_codex_output(&output_path) {
                eprintln!("[codex] {cleanup_error}; side effects unknown");
            }
            return Err(format!("无法启动 Codex CLI：{error}"));
        }
    };
    let stdout_thread = child
        .stdout
        .take()
        .map(|stream| crate::spawn_output_reader(stream));
    let stderr_thread = child
        .stderr
        .take()
        .map(|stream| crate::spawn_output_reader(stream));
    let handle: ChildHandle = Arc::new(Mutex::new(Some(child)));
    if let Some(operation_id) = operation_id.as_deref() {
        let active = active_reservation
            .as_mut()
            .ok_or_else(|| "Codex active reservation丢失；side effects unknown".to_string())?;
        let session_generation = session_generation
            .ok_or_else(|| "Codex active child缺少session generation".to_string())?;
        active.insert(
            operation_id.to_string(),
            ActiveChild {
                session_generation,
                handle: handle.clone(),
            },
        );
    }
    drop(pending_reservation);
    drop(active_reservation);

    let stdin_result = handle
        .lock()
        .map_err(|_| "Codex child handle 已损坏".to_string())?
        .as_mut()
        .and_then(|child| child.stdin.take())
        .map(|stdin| spawn_stdin_writer(stdin, prompt));

    let started_at = std::time::Instant::now();
    let status = loop {
        let status = {
            let mut guard = handle
                .lock()
                .map_err(|_| "Codex child handle 已损坏".to_string())?;
            let child = guard
                .as_mut()
                .ok_or_else(|| "Codex child 已被取消".to_string())?;
            child.try_wait()
        };
        match status {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() >= CODEX_EXEC_TIMEOUT => {
                if let Ok(mut guard) = handle.lock() {
                    if let Some(child) = guard.as_mut() {
                        kill_child_tree(child);
                        let _ = child.wait();
                    }
                }
                let stdin_cleanup = await_stdin_write(stdin_result.as_ref());
                if let Some(operation_id) = operation_id.as_deref() {
                    unregister_child(operation_id, &handle);
                }
                let _ = join_child_output(stdout_thread);
                let _ = join_child_output(stderr_thread);
                if let Err(cleanup_error) = remove_codex_output(&output_path) {
                    eprintln!("[codex] {cleanup_error}; side effects unknown");
                }
                if let Err(stdin_error) = stdin_cleanup {
                    return Err(format!("Codex 执行超时；{stdin_error}"));
                }
                return Err("Codex 执行超时（30 分钟）".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                if let Ok(mut guard) = handle.lock() {
                    if let Some(child) = guard.as_mut() {
                        kill_child_tree(child);
                        let _ = child.wait();
                    }
                }
                let stdin_cleanup = await_stdin_write(stdin_result.as_ref());
                if let Some(operation_id) = operation_id.as_deref() {
                    unregister_child(operation_id, &handle);
                }
                let _ = join_child_output(stdout_thread);
                let _ = join_child_output(stderr_thread);
                if let Err(cleanup_error) = remove_codex_output(&output_path) {
                    eprintln!("[codex] {cleanup_error}; side effects unknown");
                }
                if let Err(stdin_error) = stdin_cleanup {
                    return Err(format!("等待 Codex CLI 结束失败；{stdin_error}"));
                }
                return Err(format!("等待 Codex CLI 结束失败：{error}"));
            }
        }
    };
    if let Ok(mut guard) = handle.lock() {
        if let Some(child) = guard.as_mut() {
            kill_child_tree(child);
            let _ = child.wait();
        }
    }

    if let Err(error) = await_stdin_write(stdin_result.as_ref()) {
        cleanup_codex_run(&handle, operation_id.as_deref(), &output_path);
        return Err(error);
    }

    if let Some(operation_id) = operation_id.as_deref() {
        if take_cancelled_operation(operation_id)? {
            cleanup_codex_run(&handle, Some(operation_id), &output_path);
            return Err("Codex Worker 已取消；side effects unknown".into());
        }
    }

    let out_buf = match join_child_output(stdout_thread) {
        Ok(buffer) => buffer,
        Err(error) => {
            cleanup_codex_run(&handle, operation_id.as_deref(), &output_path);
            return Err(format!(
                "Codex output capture failed; side effects unknown: {error}"
            ));
        }
    };
    let err_buf = match join_child_output(stderr_thread) {
        Ok(buffer) => buffer,
        Err(error) => {
            cleanup_codex_run(&handle, operation_id.as_deref(), &output_path);
            return Err(format!(
                "Codex output capture failed; side effects unknown: {error}"
            ));
        }
    };
    let stdout = String::from_utf8_lossy(&out_buf).to_string();
    let stderr = String::from_utf8_lossy(&err_buf).to_string();
    let (event_message, usage, event_failure) = parse_json_events(&stdout);
    let file_message = match read_codex_output(&output_path) {
        Ok(message) => message,
        Err(error) => {
            cleanup_codex_run(&handle, operation_id.as_deref(), &output_path);
            return Err(format!(
                "Codex output capture failed; side effects unknown: {error}"
            ));
        }
    };
    let output_cleanup = remove_codex_output(&output_path);
    let _child = handle
        .lock()
        .map_err(|_| "Codex child handle 已损坏".to_string())?
        .take()
        .ok_or_else(|| "Codex child 已被取消".to_string())?;
    if let Some(operation_id) = operation_id.as_deref() {
        unregister_child(operation_id, &handle);
    }
    if let Err(error) = output_cleanup {
        return Err(format!(
            "Codex output cleanup failed; side effects unknown: {error}"
        ));
    }

    if !status.success() {
        let detail = event_failure
            .or_else(|| {
                let text = if stdout.trim().is_empty() {
                    stderr.trim().to_string()
                } else if stderr.trim().is_empty() {
                    stdout.trim().to_string()
                } else {
                    format!("{}\n{}", stdout.trim(), stderr.trim())
                };
                (!text.is_empty()).then_some(text)
            })
            .unwrap_or_else(|| "未知错误".into());
        return Err(format!("Codex 执行失败：{}", trim_detail(&detail, 500)));
    }

    let text = file_message
        .filter(|value| !value.trim().is_empty())
        .or(event_message)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex 执行完成，但没有返回最终消息。".to_string())?;

    Ok(CodexExecResult { text, usage })
}

#[tauri::command]
pub async fn codex_exec(prompt: String, model: Option<String>) -> Result<CodexExecResult, String> {
    if prompt.trim().is_empty() {
        return Err("Codex 请求不能为空。".into());
    }
    let auth = codex_login_status()?;
    if !auth.logged_in {
        return Err("未检测到 Codex 的 ChatGPT 登录，请先登录。".into());
    }
    if auth.auth_mode != "chatgpt" {
        return Err("当前 Codex 使用的不是 ChatGPT 计划登录（可能是 API Key）。请先执行 Codex 登出，再用 ChatGPT 登录。".into());
    }
    let program = codex_program()?;
    tauri::async_runtime::spawn_blocking(move || {
        run_exec(program, prompt, model, None, "read-only", None, None, None)
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
    crate::assert_session_generation(generation, "codex_worker_exec")?;
    let worktree = crate::assert_registered_worktree(&cwd)?;
    let (_, current_identity) = crate::dev_cwd_binding(&cwd)?;
    if !valid_operation_id(&operation_id) {
        return Err("Codex operation token 非法".into());
    }
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
                if let Err(finish_error) =
                    finish_pending_operation(&operation_id, pending_generation)
                {
                    return Err(finish_error);
                }
                return Err("Codex Worker lease在启动前消失".into());
            }
        },
    };
    if prepared.cancellation_requested {
        if let Err(finish_error) = finish_pending_operation(&operation_id, pending_generation) {
            return Err(finish_error);
        }
        return Err("Codex Worker 已取消".into());
    }
    let operation_for_task = operation_id.clone();
    let prepared_identity = prepared.identity.clone();
    let result = async {
        let auth = codex_login_status()?;
        if take_cancelled_operation(&operation_for_task)? {
            return Err("Codex Worker 已取消".into());
        }
        if !auth.logged_in {
            return Err("未检测到 Codex 的 ChatGPT 登录，请先登录。".into());
        }
        if auth.auth_mode != "chatgpt" {
            return Err("当前 Codex 使用的不是 ChatGPT 计划登录（可能是 API Key）。请先执行 Codex 登出，再用 ChatGPT 登录。".into());
        }
        let program = codex_program()?;
        let generation_for_task = generation;
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _operation_guard = crate::lock_dev_operation();
            crate::assert_session_generation(generation_for_task, "codex_worker_exec")?;
            run_exec(
                program,
                prompt,
                model,
                Some(worktree),
                "workspace-write",
                Some(operation_for_task.clone()),
                Some(generation_for_task),
                Some(prepared_identity),
            )
        })
        .await
        .map_err(|e| format!("Codex Worker 后台任务失败：{e}"))??;
        Ok(result)
    }
    .await;
    let cancelled_during_finalization =
        match finish_pending_operation(&operation_id, pending_generation) {
            Ok(cancelled) => cancelled,
            Err(error) => return Err(error),
        };
    if cancelled_during_finalization {
        Err("Codex Worker 在finalization期间被取消；side effects unknown".into())
    } else {
        result
    }
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
        let handle = entry.handle.clone();
        let mut guard = handle
            .lock()
            .map_err(|_| "Codex child handle 已损坏".to_string())?;
        if let Some(child) = guard.as_mut() {
            kill_child_tree(child);
            let _ = child.wait();
        }
        active.remove(&operation_id);
        if let Some(entry) = pending_codex_operations()
            .lock()
            .map_err(|_| "Codex pending registry 已损坏".to_string())?
            .get_mut(&operation_id)
        {
            if entry.session_generation == generation {
                entry.cancellation_requested = true;
            }
        }
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
    use super::{
        begin_pending_operation, build_exec_args, codex_worker_cancel, finish_pending_operation,
        parse_json_events, take_cancelled_operation, valid_operation_id, CODEX_TEMP_COUNTER,
    };

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
}
