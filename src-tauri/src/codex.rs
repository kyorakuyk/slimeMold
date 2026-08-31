use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static CODEX_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    if cfg!(windows) {
        if let Some(app_data) = env::var_os("APPDATA") {
            let candidate = PathBuf::from(app_data).join("npm").join("codex.cmd");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("未找到 Codex CLI。请先安装 @openai/codex，并确保 codex 在 PATH 中。".into())
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
    let output = Command::new(program)
        .args(["login", "status"])
        .output()
        .map_err(|e| format!("无法执行 Codex CLI：{e}"))?;
    let detail = command_detail(&output);
    let lower = detail.to_lowercase();
    let logged_in = output.status.success()
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
    Command::new(program)
        .arg("login")
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
    let output = Command::new(program)
        .arg("logout")
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

fn run_exec(
    program: PathBuf,
    prompt: String,
    model: Option<String>,
) -> Result<CodexExecResult, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = CODEX_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let output_path = env::temp_dir().join(format!(
        "slimemold-codex-{stamp}-{}-{sequence}.txt",
        std::process::id()
    ));

    let mut command = Command::new(program);
    command.args([
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-last-message",
    ]);
    command.arg(&output_path);
    if let Some(model) = model.as_deref().filter(|value| !value.trim().is_empty()) {
        command.args(["--model", model]);
    }
    // SlimeMold 的 Codex provider 明确使用 Codex CLI 的 ChatGPT 登录态，
    // 不把父进程中可能存在的 API key / access token 误带入本次调用。
    for key in ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"] {
        command.env_remove(key);
    }
    command
        .current_dir(env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Codex CLI：{e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(prompt.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&output_path);
            return Err(format!("向 Codex CLI 写入请求失败：{error}"));
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待 Codex CLI 结束失败：{e}"))?;
    let (event_message, usage, event_failure) =
        parse_json_events(&String::from_utf8_lossy(&output.stdout));
    let file_message = fs::read_to_string(&output_path).ok();
    let _ = fs::remove_file(&output_path);

    if !output.status.success() {
        let detail = event_failure
            .or_else(|| {
                let text = command_detail(&output);
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
    tauri::async_runtime::spawn_blocking(move || run_exec(program, prompt, model))
        .await
        .map_err(|e| format!("Codex 后台任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::parse_json_events;

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
}
