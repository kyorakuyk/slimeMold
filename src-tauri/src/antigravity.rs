use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const ANTIGRAVITY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MCP_SERVER_NAME: &str = "slimemold-worker";

static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug, Deserialize)]
pub struct AntigravityWorkerRequest {
    pub prompt: String,
    pub cwd: String,
    #[serde(rename = "operationId")]
    pub operation_id: String,
    pub generation: u64,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub cli_path: Option<String>,
    pub context: Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct AntigravityWorkerResult {
    pub text: String,
    pub outcome: String,
    #[serde(rename = "sessionDir")]
    pub session_dir: String,
}

fn default_mode() -> String {
    "agent".to_string()
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn valid_mode(value: &str) -> bool {
    matches!(value, "ask" | "edit" | "agent" | "custom")
}

fn quote_cmd_arg(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn valid_profile(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ' '))
}

fn allowed_cli_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "antigravity-ide.cmd" | "antigravity-ide.exe" | "antigravity-ide"
            )
        })
        .unwrap_or(false)
}

fn resolve_cli(cli_path: Option<&str>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(value) = cli_path.map(str::trim).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(value));
    }
    if let Some(value) = env::var_os("ANTIGRAVITY_CLI") {
        candidates.push(PathBuf::from(value));
    }
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            candidates.push(dir.join(if cfg!(windows) {
                "antigravity-ide.cmd"
            } else {
                "antigravity-ide"
            }));
        }
    }
    for candidate in candidates {
        if candidate.is_file() && allowed_cli_file(&candidate) {
            return fs::canonicalize(&candidate).map_err(|error| {
                format!(
                    "Antigravity CLI 路径无法 canonicalize：{}（{error}）",
                    candidate.display()
                )
            });
        }
    }
    Err("未找到 Antigravity CLI；请设置 ANTIGRAVITY_CLI 或传入 cliPath".into())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("MCP 配置路径没有父目录：{}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建 Antigravity 配置目录失败：{error}"))?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, content).map_err(|error| format!("写入临时 MCP 配置失败：{error}"))?;
    fs::rename(&temp, path).map_err(|error| format!("提交 MCP 配置失败：{error}"))
}

fn install_workspace_mcp_config(
    worktree: &Path,
    session_dir: &Path,
    script_path: &Path,
) -> Result<PathBuf, String> {
    let agents_dir = worktree.join(".agents");
    let config_path = agents_dir.join("mcp_config.json");
    let mut config = if config_path.is_file() {
        let raw = fs::read_to_string(&config_path)
            .map_err(|error| format!("读取现有 Antigravity MCP 配置失败：{error}"))?;
        serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("现有 Antigravity MCP 配置不是合法 JSON：{error}"))?
    } else {
        json!({ "mcpServers": {} })
    };
    let servers = config
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Antigravity MCP 配置缺少 object 类型的 mcpServers".to_string())?;
    let desired = json!({
        "command": if cfg!(windows) { "node.exe" } else { "node" },
        "args": [script_path.to_string_lossy().to_string()],
        "cwd": worktree.to_string_lossy().to_string(),
        "env": {
            "SLIMEMOLD_ANTIGRAVITY_SESSION_DIR": session_dir.to_string_lossy().to_string()
        }
    });
    if let Some(existing) = servers.get(MCP_SERVER_NAME) {
        if existing != &desired {
            return Err(format!(
                "当前 Worktree 已存在不同的 {MCP_SERVER_NAME} MCP 配置，拒绝覆盖"
            ));
        }
    } else {
        servers.insert(MCP_SERVER_NAME.to_string(), desired);
        let serialized = serde_json::to_string_pretty(&config)
            .map_err(|error| format!("序列化 Antigravity MCP 配置失败：{error}"))?;
        atomic_write(&config_path, &format!("{serialized}\n"))?;
    }
    Ok(config_path)
}

fn build_command(
    cli: &Path,
    worktree: &Path,
    mode: &str,
    profile: Option<&str>,
    prompt: &str,
) -> Command {
    let mut args = vec![
        "chat".to_string(),
        "--mode".to_string(),
        mode.to_string(),
        "--new-window".to_string(),
    ];
    if let Some(profile) = profile.filter(|value| !value.trim().is_empty()) {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    args.push(prompt.to_string());

    if cfg!(windows)
        && cli
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("cmd"))
    {
        let command_line = std::iter::once(quote_cmd_arg(&cli.to_string_lossy()))
            .chain(args.iter().map(|arg| quote_cmd_arg(arg)))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command = Command::new(env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
        command.args(["/D", "/C", &command_line]);
        command.current_dir(worktree);
        return command;
    }

    let mut command = Command::new(cli);
    command.args(args).current_dir(worktree);
    command
}

fn read_result(path: &Path) -> Result<Option<AntigravityWorkerResult>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("读取 Antigravity result 失败：{error}"))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Antigravity result 不是合法 JSON：{error}"))?;
    let outcome = value
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if outcome != "completed" && outcome != "blocked" {
        return Err("Antigravity result 的 outcome 必须是 completed 或 blocked".into());
    }
    if summary.is_empty() {
        return Err("Antigravity result 缺少 summary".into());
    }
    Ok(Some(AntigravityWorkerResult {
        text: summary.to_string(),
        outcome: outcome.to_string(),
        session_dir: path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default(),
    }))
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
pub async fn antigravity_worker_exec(
    request: AntigravityWorkerRequest,
) -> Result<AntigravityWorkerResult, String> {
    if request.prompt.trim().is_empty() {
        return Err("Antigravity Worker 请求不能为空".into());
    }
    if !valid_operation_id(&request.operation_id) {
        return Err("Antigravity operation id 非法".into());
    }
    if !valid_mode(&request.mode) {
        return Err(format!("Antigravity mode 不受支持：{}", request.mode));
    }
    if let Some(profile) = request
        .profile
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !valid_profile(profile) {
            return Err("Antigravity profile 含有不允许的字符".into());
        }
    }
    crate::assert_session_generation(request.generation, "antigravity_worker_exec")?;
    let worktree = crate::assert_registered_worktree(&request.cwd)?;
    let cli = resolve_cli(request.cli_path.as_deref())?;
    let base_repo = crate::dev_base_repo()?;
    let script_path = base_repo
        .join("scripts")
        .join("slimemold-antigravity-mcp.mjs");
    if !script_path.is_file() {
        return Err(format!(
            "SlimeMold MCP server 不存在：{}",
            script_path.display()
        ));
    }
    let session_dir = worktree
        .join(".agents")
        .join("slimemold-worker")
        .join(&request.operation_id);
    fs::create_dir_all(&session_dir)
        .map_err(|error| format!("创建 Antigravity session 目录失败：{error}"))?;
    let context = json!({
        "instruction": request.prompt,
        "context": request.context,
    });
    atomic_write(
        &session_dir.join("context.json"),
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&context).map_err(|error| error.to_string())?
        ),
    )?;
    let config_path = install_workspace_mcp_config(&worktree, &session_dir, &script_path)?;
    atomic_write(
        &session_dir.join("launch.json"),
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "mode": request.mode.clone(),
                "profile": request.profile.clone(),
                "cli": cli.to_string_lossy().to_string(),
                "worktree": worktree.to_string_lossy().to_string(),
                "mcpConfig": config_path.to_string_lossy().to_string(),
            }))
            .map_err(|error| error.to_string())?
        ),
    )?;

    let prompt = "Open the slimemold-worker MCP server, call slimemold_get_task_context, follow its runtime contract, and implement the task in the current workspace.";

    let mut child = build_command(
        &cli,
        &worktree,
        &request.mode,
        request.profile.as_deref(),
        prompt,
    )
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|error| format!("无法启动 Antigravity CLI：{error}"))?;

    let result_path = session_dir.join("result.json");
    let started = Instant::now();
    loop {
        if cancelled().lock().unwrap().remove(&request.operation_id) {
            kill_child(&mut child);
            return Err("Antigravity Worker 已取消".into());
        }
        if let Some(result) = read_result(&result_path)? {
            kill_child(&mut child);
            return Ok(result);
        }
        if started.elapsed() >= ANTIGRAVITY_TIMEOUT {
            kill_child(&mut child);
            return Err("Antigravity Worker 等待 Attempt result 超时（30 分钟）".into());
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[tauri::command]
pub fn antigravity_worker_cancel(operation_id: String) -> Result<(), String> {
    if !valid_operation_id(&operation_id) {
        return Err("Antigravity operation id 非法".into());
    }
    cancelled().lock().unwrap().insert(operation_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{build_command, valid_mode, valid_operation_id};
    use std::path::Path;

    #[test]
    fn accepts_only_supported_agent_modes() {
        assert!(valid_mode("agent"));
        assert!(valid_mode("custom"));
        assert!(!valid_mode("headless"));
    }

    #[test]
    fn rejects_shell_injection_in_operation_id() {
        assert!(valid_operation_id("worker-task-1.attempt-1"));
        assert!(!valid_operation_id("worker task; format"));
    }

    #[test]
    fn builds_a_workspace_scoped_chat_command() {
        let command = build_command(
            Path::new("D:/Family/Antigravity IDE/bin/antigravity-ide.cmd"),
            Path::new("D:/worktrees/task-1"),
            "agent",
            None,
            "do the task",
        );
        let _ = command;
    }
}
