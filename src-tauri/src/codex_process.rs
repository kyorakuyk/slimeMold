use super::codex_cleanup::{
    await_stdin_write, create_codex_output, join_cleanup_reader, read_codex_output,
    remove_codex_output, spawn_stdin_writer, ChildHandle, CodexCleanupContext, CodexCleanupHandle,
};
use super::codex_registry::{
    reserve_codex_operation, take_cancelled_operation, validate_operation_binding,
};
use super::{
    append_cleanup_failure, cleanup_codex_run, cleanup_failed_codex_run,
    cleanup_unregistered_codex_child, release_unscoped_recovery_slot,
    reserve_unscoped_recovery_slot, terminate_child_checked,
};
use crate::dev_login_sanitized_env;
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const CODEX_EXEC_TIMEOUT: Duration = Duration::from_secs(30 * 60);

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

#[derive(Debug)]
pub(crate) struct CodexExecRequest {
    pub(crate) program: PathBuf,
    pub(crate) prompt: String,
    pub(crate) model: Option<String>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) sandbox_mode: &'static str,
    pub(crate) operation_id: Option<String>,
    pub(crate) session_generation: Option<u64>,
    pub(crate) pending_operation_generation: Option<u64>,
    pub(crate) prepared_cwd_identity: Option<crate::StableDirectoryIdentity>,
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

pub(crate) fn parse_json_events(
    stdout: &str,
) -> (Option<String>, Option<CodexUsage>, Option<String>) {
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

pub(crate) fn build_exec_args(sandbox_mode: &str) -> Vec<String> {
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

fn trim_detail(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{out}…")
    } else {
        out
    }
}

pub(crate) fn run_exec(request: CodexExecRequest) -> Result<CodexExecResult, String> {
    let CodexExecRequest {
        program,
        prompt,
        model,
        cwd,
        sandbox_mode,
        operation_id,
        session_generation,
        pending_operation_generation,
        prepared_cwd_identity,
    } = request;
    validate_operation_binding(
        operation_id.as_deref(),
        session_generation,
        pending_operation_generation,
    )?;
    let operation_binding = match (
        operation_id.as_deref(),
        session_generation,
        pending_operation_generation,
    ) {
        (Some(operation_id), Some(session_generation), Some(pending_generation)) => Some((
            operation_id.to_string(),
            session_generation,
            pending_generation,
        )),
        (None, None, None) => None,
        _ => return Err("Codex operation binding invalid".into()),
    };
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
    let mut spawn_reservation = operation_binding
        .as_ref()
        .map(|(operation_id, session_generation, pending_generation)| {
            reserve_codex_operation(operation_id, *session_generation, *pending_generation)
        })
        .transpose()?;

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

    let unscoped_recovery_slot = if operation_binding.is_none() {
        match reserve_unscoped_recovery_slot() {
            Ok(slot) => Some(slot),
            Err(error) => {
                if let Err(cleanup_error) = remove_codex_output(&output_path) {
                    return Err(format!(
                        "{error}; output cleanup failed: {cleanup_error}; side effects unknown"
                    ));
                }
                return Err(error);
            }
        }
    } else {
        None
    };
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(slot) = unscoped_recovery_slot {
                if let Err(slot_error) = release_unscoped_recovery_slot(slot) {
                    return Err(format!("无法启动 Codex CLI：{error}; {slot_error}"));
                }
            }
            if let Err(cleanup_error) = remove_codex_output(&output_path) {
                eprintln!("[codex] {cleanup_error}; side effects unknown");
            }
            return Err(format!("无法启动 Codex CLI：{error}"));
        }
    };
    let stdout_thread = child.stdout.take().map(crate::spawn_output_reader);
    let stderr_thread = child.stderr.take().map(crate::spawn_output_reader);
    let cleanup: CodexCleanupHandle = Arc::new(Mutex::new(CodexCleanupContext {
        output_path: output_path.clone(),
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
    if let Some(reservation) = spawn_reservation.as_mut() {
        if let Err(error) = reservation.register_child(handle.clone(), cleanup.clone()) {
            match cleanup_unregistered_codex_child(&handle, &cleanup) {
                Ok(()) => {
                    return Err(format!(
                        "Codex child registration failed; child/output cleaned: {error}"
                    ));
                }
                Err(cleanup_error) => {
                    reservation.retain_child_for_recovery(handle.clone(), cleanup.clone());
                    return Err(format!(
                        "Codex child registration failed; cleanup failed: {}; side effects unknown: {error}",
                        cleanup_error.message
                    ));
                }
            }
        }
    }
    drop(spawn_reservation);

    let stdin_result = match handle.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => child
                .stdin
                .take()
                .map(|stdin| spawn_stdin_writer(stdin, prompt)),
            None => {
                let cleanup_result = cleanup_failed_codex_run(
                    &handle,
                    operation_id.as_deref(),
                    &cleanup,
                    unscoped_recovery_slot,
                    None,
                );
                return Err(append_cleanup_failure(
                    "Codex child在stdin初始化前丢失；side effects unknown".into(),
                    cleanup_result,
                ));
            }
        },
        Err(_) => {
            let cleanup_result = cleanup_failed_codex_run(
                &handle,
                operation_id.as_deref(),
                &cleanup,
                unscoped_recovery_slot,
                None,
            );
            return Err(append_cleanup_failure(
                "Codex child handle在stdin初始化时损坏；side effects unknown".into(),
                cleanup_result,
            ));
        }
    };

    let started_at = std::time::Instant::now();
    let status = loop {
        let status = match handle.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) => child.try_wait(),
                None => Err(std::io::Error::other("Codex child 已被取消")),
            },
            Err(_) => Err(std::io::Error::other("Codex child handle 已损坏")),
        };
        match status {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() >= CODEX_EXEC_TIMEOUT => {
                let cleanup = cleanup_failed_codex_run(
                    &handle,
                    operation_id.as_deref(),
                    &cleanup,
                    unscoped_recovery_slot,
                    stdin_result.as_ref(),
                );
                return Err(append_cleanup_failure(
                    "Codex 执行超时（30 分钟）".into(),
                    cleanup,
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let cleanup = cleanup_failed_codex_run(
                    &handle,
                    operation_id.as_deref(),
                    &cleanup,
                    unscoped_recovery_slot,
                    stdin_result.as_ref(),
                );
                return Err(append_cleanup_failure(
                    format!("等待 Codex CLI 结束失败：{error}"),
                    cleanup,
                ));
            }
        }
    };
    let post_exit_termination = match handle.lock() {
        Ok(mut guard) => {
            if let Some(child) = guard.as_mut() {
                terminate_child_checked(child)
            } else {
                Ok(())
            }
        }
        Err(_) => Err("Codex child handle 已损坏；side effects unknown".to_string()),
    };
    if let Err(error) = post_exit_termination {
        let cleanup = cleanup_failed_codex_run(
            &handle,
            operation_id.as_deref(),
            &cleanup,
            unscoped_recovery_slot,
            stdin_result.as_ref(),
        );
        return Err(append_cleanup_failure(
            format!(
                "Codex child termination failed after process exit; side effects unknown: {error}"
            ),
            cleanup,
        ));
    }
    if let Err(error) = await_stdin_write(stdin_result.as_ref()) {
        return Err(append_cleanup_failure(
            error,
            cleanup_codex_run(
                &handle,
                operation_id.as_deref(),
                &cleanup,
                unscoped_recovery_slot,
            ),
        ));
    }

    let cancellation_reason = operation_id.as_deref().and_then(|operation_id| {
        match take_cancelled_operation(operation_id) {
            Ok(true) => Some("Codex Worker 已取消；side effects unknown".to_string()),
            Ok(false) => None,
            Err(error) => Some(format!(
                "Codex pending cancellation state unavailable; side effects unknown: {error}"
            )),
        }
    });

    let out_buf = match join_cleanup_reader(&cleanup, true) {
        Ok(buffer) => buffer,
        Err(error) => {
            return Err(append_cleanup_failure(
                format!("Codex output capture failed; side effects unknown: {error}"),
                cleanup_codex_run(
                    &handle,
                    operation_id.as_deref(),
                    &cleanup,
                    unscoped_recovery_slot,
                ),
            ));
        }
    };
    let err_buf = match join_cleanup_reader(&cleanup, false) {
        Ok(buffer) => buffer,
        Err(error) => {
            return Err(append_cleanup_failure(
                format!("Codex output capture failed; side effects unknown: {error}"),
                cleanup_codex_run(
                    &handle,
                    operation_id.as_deref(),
                    &cleanup,
                    unscoped_recovery_slot,
                ),
            ));
        }
    };
    if let Some(reason) = cancellation_reason {
        return Err(append_cleanup_failure(
            reason,
            cleanup_codex_run(
                &handle,
                operation_id.as_deref(),
                &cleanup,
                unscoped_recovery_slot,
            ),
        ));
    }
    let stdout = String::from_utf8_lossy(&out_buf).to_string();
    let stderr = String::from_utf8_lossy(&err_buf).to_string();
    let (event_message, usage, event_failure) = parse_json_events(&stdout);
    let file_message = match read_codex_output(&output_path) {
        Ok(message) => message,
        Err(error) => {
            return Err(append_cleanup_failure(
                format!("Codex output capture failed; side effects unknown: {error}"),
                cleanup_codex_run(
                    &handle,
                    operation_id.as_deref(),
                    &cleanup,
                    unscoped_recovery_slot,
                ),
            ));
        }
    };
    if let Err(error) = cleanup_codex_run(
        &handle,
        operation_id.as_deref(),
        &cleanup,
        unscoped_recovery_slot,
    ) {
        return Err(format!(
            "Codex finalization cleanup failed; side effects unknown: {error}"
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
