//! SlimeMold 桌面壳（路线 A）：
//! - plugin-http：前端 LLM 等网络请求经 WebView 发起（规避 CORS，并带回 token usage）
//! - plugin-fs：插件目录扫描、工作流文件读写
//! - plugin-dialog：导入导出文件对话框
//! - plugin-opener：打开资产所在文件夹/系统默认程序
//! - plugin-window-state：自动持久化/恢复主窗口的位置、大小、最大化、全屏、可见性等状态
//!   （关闭时写入 AppData，启动时按窗口 label 还原，故 tauri.conf.json 中已移除 center 以避免覆盖）
//! - keyring：接入点 apiKey 的 AES-GCM 主密钥存储；接入点整条落盘于 AppData/endpoints.json
//!   （apiKey 字段加密，磁盘无明文）
//! - set_credential / get_credential / delete_credential / list_credentials：基于 keyring crate，
//!   落盘到 OS 密钥库（Windows Credential Manager / macOS Keychain / Linux secret-service）。
//!
//! 注意：Rust 侧不实现 LLM HTTP 客户端（原 chat_completion 已移除）。普通 API provider
//! 由前端发起；Codex provider 是受控例外，只通过官方 Codex CLI 的 Tauri 命令调用。

use std::collections::HashMap;
use std::fs;
#[cfg(test)]
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod antigravity;
mod cleanup_lineage_policy;
mod codex;
mod credentials;
mod dev_command_policy;
mod dev_process;
mod dev_state;
mod event_store;
mod fs_guard;
mod fs_identity;
mod git_worktree_policy;
mod session_authority;
mod worktree_authority;
mod worktree_policy;

use cleanup_lineage_policy::{cleanup_binding_matches, orphan_target_is_deleted_candidate};
use dev_process::DevExecResult;
pub(crate) use dev_process::{spawn_output_reader, OutputReceiver, OutputThread};
use dev_state::{
    lock_dev_operation, next_session_generation, CleanupBinding, PendingWorktree,
    RegisteredWorktree, DEV_STATE,
};
#[cfg(test)]
use dev_state::{lock_dev_state_tests, DevState};
#[cfg(test)]
pub(crate) use fs_guard::protected_relative_path;
use fs_guard::{
    canonicalize_dev_exec_args, dev_arg_path_lexically_safe, dev_arg_shell_safe,
    dev_exec_validate_paths, dev_strip_verbatim, git_diff_pathspec_allowed, is_git_diff_revision,
    path_compare_key, path_is_same_or_child, protected_path_error,
    protected_path_is_execution_only_script,
};
pub(crate) use fs_identity::{stable_directory_identity, StableDirectoryIdentity};
use git_worktree_policy::validate_git_worktree_porcelain;
use worktree_policy::{is_full_object_id, worker_branch_is_valid};

#[cfg(test)]
pub(crate) use session_authority::dev_cwd_kind;
pub(crate) use session_authority::{
    assert_base_identity_current, assert_registered_worktree, assert_session_generation,
    dev_abs_of, dev_base_repo, dev_cwd_binding, DevCwdKind,
};
pub(crate) use worktree_authority::{
    dev_main_repo_git_allowed_at, invalidate_cleanup_binding, main_repo_worktree_add_spec,
    main_repo_worktree_target_is_valid, new_cleanup_token, pending_worker_target,
    registered_worktree_identity_conflicts, registered_worktree_identity_matches,
    update_pending_worktree_after_success, worktree_add_target_is_safe,
};
#[cfg(test)]
pub(crate) use worktree_authority::{
    main_repo_worktree_args_are_valid, record_pending_worktree_add, worker_root_path,
    worker_target_is_safe_for_existing_operation,
};
#[cfg(test)]
pub(crate) use worktree_policy::worker_name_is_valid;

/// 步骤 11 阶段 C：Git Worktree 真隔离。在 Rust 侧直接调用系统 `git`（不受 Tauri 沙箱限制），
/// 返回 stdout / stderr / 退出码，供前端的 git worktree 沙箱模式使用。
///
/// 安全边界（2026-08-07 P0-S4，后续收紧）：
/// - `cwd` 必填，且必须是已存在的目录；拒绝带 `..` 的路径。
/// - 只接受 Git top-level 上的有限只读 probe；不暴露 worktree add/remove、branch delete、
///   prune、config、merge、checkout、push 等 mutation 能力。
///
/// 调用示例：`invoke('run_git', { args: ['rev-parse', '--is-inside-work-tree'], cwd })`
fn safe_git_revision(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && !value.contains("..")
        && !value.contains("//")
        && !value
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '>' | '<'))
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.'))
}

fn run_git_readonly_args(args: &[String]) -> bool {
    match args {
        [sub, flag] if sub == "rev-parse" && flag == "--is-inside-work-tree" => true,
        [sub, rev] if sub == "rev-parse" && rev == "HEAD" => true,
        [sub, flag] if sub == "status" && (flag == "--porcelain" || flag == "--short") => true,
        [sub, rev] if sub == "diff" && safe_git_revision(rev) => true,
        [sub, flag, rev] if sub == "diff" && flag == "--name-only" && safe_git_revision(rev) => {
            true
        }
        [sub, flag, rev] if sub == "diff" && flag == "--stat" && safe_git_revision(rev) => true,
        [sub, flag, n] if sub == "log" && flag == "-n" && n.parse::<u32>().is_ok() => true,
        [sub, pretty, flag, n]
            if sub == "log"
                && pretty == "--oneline"
                && flag == "-n"
                && n.parse::<u32>().is_ok() =>
        {
            true
        }
        [sub, a, b] if sub == "ls-files" && a == "--others" && b == "--exclude-standard" => true,
        [sub, flag] if sub == "branch" && flag == "--list" => true,
        [sub, action] if sub == "worktree" && action == "list" => true,
        [sub, action, porcelain]
            if sub == "worktree" && action == "list" && porcelain == "--porcelain" =>
        {
            true
        }
        _ => false,
    }
}

fn apply_dev_env(command: &mut Command) {
    command.env_clear();
    for (key, value) in dev_sanitized_env() {
        command.env(key, value);
    }
}

#[tauri::command]
fn run_git(args: Vec<String>, cwd: Option<String>) -> Result<GitResult, String> {
    // 1) cwd 必填且为已存在目录，禁止越界
    let cwd = cwd.ok_or_else(|| "run_git: cwd 必填（不允许在进程当前目录裸调 git）".to_string())?;
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.exists() {
        return Err(format!("run_git: cwd 不存在：{cwd}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("run_git: cwd 不是目录：{cwd}"));
    }
    // 规范化后检查是否有父目录逃逸。
    let canon = cwd_path
        .canonicalize()
        .map_err(|e| format!("run_git: 无法解析 cwd（{cwd}）：{e}"))?;
    if cwd_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("run_git: cwd 禁止包含 '..' 路径逃逸：{cwd}"));
    }

    if !run_git_readonly_args(&args) {
        return Err("run_git: legacy 命令只允许只读 Git probe；worktree 生命周期必须走 H4 WorktreeManager/dev_exec".to_string());
    }
    let mut probe = Command::new(resolve_dev_program("git"));
    probe
        .arg("-C")
        .arg(&canon)
        .args(["rev-parse", "--show-toplevel"]);
    apply_dev_env(&mut probe);
    let probe_output = probe
        .output()
        .map_err(|e| format!("run_git: Git top-level probe 失败：{e}"))?;
    if !probe_output.status.success() {
        return Err("run_git: cwd 不是可验证的 Git top-level".to_string());
    }
    let top = std::path::PathBuf::from(String::from_utf8_lossy(&probe_output.stdout).trim())
        .canonicalize()
        .map_err(|_| "run_git: Git top-level 输出无效".to_string())?;
    if path_compare_key(&top.to_string_lossy()) != path_compare_key(&canon.to_string_lossy()) {
        return Err("run_git: cwd 必须是 Git repository top-level".to_string());
    }

    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.current_dir(&canon)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_dev_env(&mut cmd);
    for a in &args {
        cmd.arg(a);
    }
    let output = run_with_timeout(&mut cmd, std::time::Duration::from_secs(30))?;
    Ok(GitResult {
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.code,
    })
}

#[derive(serde::Serialize)]
struct GitResult {
    stdout: String,
    stderr: String,
    code: i32,
}

/// 步骤 11 阶段 D：工作区信任（Tauri 版「你打开=你授权」）。
///
/// 前端在 `openProject(path)` 时调用本命令，把 `<项目根>/**` 动态注入 `main` 窗口的
/// `fs:scope`。这样无论项目放在哪个目录（D:/2048、E:/xxx），打开即授权，
/// 不再需要在 `capabilities/default.json` 里为每台机器的绝对路径写死白名单。
///
/// 安全边界：
/// - `path` 必填且已存在、为目录；拒绝含 `..` 的路径逃逸。
/// - 注入的 scope 仅 `<path>/**` 一条，不开放父级或其它任意位置。
/// - 依赖 `tauri` 的 `dynamic-acl` feature 提供的 `CapabilityBuilder` +
///   `Manager::capability().insert()`。
#[tauri::command]
fn grant_project_access(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() || !p.is_dir() {
        return Err(format!(
            "grant_project_access: 路径不存在或不是目录：{path}"
        ));
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "grant_project_access: 路径禁止包含 '..' 逃逸：{path}"
        ));
    }
    // canonicalize 归一化真实路径（解析符号链接/`.`/大小写差异），
    // 既保证 scope 注入的是磁盘真实路径，也避免同一目录的不同写法重复授权。
    let canon = p
        .canonicalize()
        .map_err(|e| format!("grant_project_access: 路径解析失败：{path}（{e}）"))?;
    let canon_str = canon.to_string_lossy().to_string();

    // 幂等去重：同路径 1 秒内重复授权直接返回，避免高频调用反复重建 capability
    //（曾致 Rust 主线程死循环、CPU 打满、WebView 输入事件冻结——每条 capability 都会
    //  参与每次 fs 操作的权限校验，列表越滚越长越慢）。
    use std::time::{Duration, Instant};
    static LAST_GRANT: std::sync::Mutex<Option<(String, Instant)>> = std::sync::Mutex::new(None);
    {
        let mut last = LAST_GRANT.lock().unwrap();
        if let Some((prev, at)) = &*last {
            if path_compare_key(prev) == path_compare_key(&canon_str)
                && at.elapsed() < Duration::from_secs(1)
            {
                return Ok(()); // 同路径近期已授权，跳过
            }
        }
        *last = Some((canon_str.clone(), Instant::now()));
    }

    // 使用 Tauri 官方 FsExt::fs_scope().allow_directory()：幂等（重复加同路径自动去重）、
    // 无需重建 capability，也不受 add_capability 累积影响。recursive=true 允许子目录。
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope
        .allow_directory(&canon, true)
        .map_err(|e| format!("grant_project_access: 注入 fs scope 失败：{path}（{e}）"))?;
    eprintln!("[cap] grant_project_access ok: {path}");
    Ok(())
}

/* ---------------- H4 GUI 宿主受控命令通道（Phase 1） ----------------
 * GUI（WebView）无法直接执行系统命令/文件操作（node:child_process 经 vite shim 抛错）。
 * 这里把 DevSession 的执行层下沉到 Rust 宿主：
 * - dev_exec：命令名白名单 + cwd 必须属于「已登记 worktree 或主仓库根」+ 剥离凭据 env + 超时；
 * - dev_read_file / dev_write_file：文件路径必须属于已登记 worktree（防任意读写宿主磁盘）；
 * - dev_init_session / dev_register_worktree / dev_unregister_worktree：维护宿主登记态。
 * 前端仍保留完整的参数级白名单（capabilities DEFAULT_SHELL_RULES/DEFAULT_TEST_RULES），
 * Rust 侧命令名 + cwd 白名单作为纵深防御（WebView 被 XSS 也不能在 worktree 外执行命令）。
 */

/// 命令名白名单（与前端 capabilities 的 DEFAULT_SHELL_RULES / DEFAULT_TEST_RULES 命令名一致）。
const DEV_ALLOWED_CMDS: &[&str] = &[
    "pwd", "echo", "ls", "cat", "find", "head", "tail", "grep", "git", "node", "tsc", "vitest",
    "tsx", "npm",
];

/// Windows 下 PATH 中的 npm/tsx/tsc/vitest 通常是 `.cmd` shim，
/// `std::process::Command::new("npm")` 不会像 shell 一样自动补全扩展名。
/// 命令名已经先经过 DEV_ALLOWED_CMDS 白名单，因此这里只负责确定真实可执行文件。
#[cfg(windows)]
fn resolve_dev_program_from_path(
    name: &str,
    search_path: Option<&std::ffi::OsStr>,
) -> std::path::PathBuf {
    let raw = std::path::PathBuf::from(name);
    if raw.components().count() > 1 || raw.extension().is_some() {
        return raw;
    }

    if let Some(search_path) = search_path {
        for dir in std::env::split_paths(search_path) {
            for extension in [".com", ".exe", ".bat", ".cmd"] {
                let candidate = dir.join(format!("{name}{extension}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
            let direct = dir.join(name);
            if direct.is_file() {
                return direct;
            }
        }
    }
    raw
}

#[cfg(not(windows))]
fn resolve_dev_program_from_path(
    name: &str,
    _search_path: Option<&std::ffi::OsStr>,
) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
}

fn resolve_dev_program(name: &str) -> std::path::PathBuf {
    let resolved = resolve_dev_program_from_path(name, std::env::var_os("PATH").as_deref());
    #[cfg(windows)]
    {
        if let Some(trusted) = trusted_windows_program(&resolved) {
            return trusted;
        }
        return std::path::PathBuf::from(
            r"C:\Windows\System32\__slimemold_untrusted_program__.exe",
        );
    }
    #[cfg(not(windows))]
    {
        resolved
    }
}

/// 主仓库根允许的 git 子命令（严格只读 / worktree 生命周期管理）。
/// 主仓库根是宿主受保护目录——禁止 npm/tsx/写入型 git（apply/commit/push/reset 等），
/// 防止 WebView 直接调 dev_exec 在主仓库执行修改文件的命令。
fn dev_main_repo_git_allowed(args: &[String]) -> bool {
    if args.first().map(|s| s.as_str()) != Some("git") {
        return false;
    }
    let exact = |want: &[&str]| args.iter().map(|s| s.as_str()).eq(want.iter().copied());
    exact(&["git", "rev-parse", "HEAD"])
        || exact(&["git", "rev-parse", "--show-toplevel"])
        || exact(&["git", "worktree", "list"])
        || exact(&["git", "worktree", "list", "--porcelain"])
        || exact(&["git", "branch", "--list"])
        || exact(&["git", "branch", "-a"])
        || exact(&["git", "status", "--porcelain"])
        || exact(&["git", "status", "--short"])
        || exact(&["git", "diff", "--name-only", "HEAD"])
        || exact(&["git", "diff", "--name-only"])
        || exact(&["git", "ls-files", "--others", "--exclude-standard"])
        || (args.len() == 5
            && args[1] == "log"
            && args[2] == "--oneline"
            && args[3] == "-n"
            && args[4].chars().all(|c| c.is_ascii_digit()))
        || (args.len() == 4
            && args[1] == "show-ref"
            && args[2] == "--verify"
            && args[3].starts_with("refs/heads/worker/w-")
            && safe_git_revision_arg(&args[3]))
}

/// 与 Node 侧 sanitizeEnv 对齐：凭据变量采用稳定 suffix 词元而非有限名单。
pub(crate) fn is_safe_env_name(name: &str) -> bool {
    const SAFE: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_MESSAGES",
        "TERM",
        "COLORTERM",
        "CI",
        "FORCE_COLOR",
        "NODE_ENV",
    ];
    let upper = name.to_ascii_uppercase();
    SAFE.iter().any(|safe| upper == *safe)
}

pub(crate) fn is_credential_env_name(name: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "API_KEY",
        "APIKEY",
        "TOKEN",
        "PAT",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PASS",
        "PASSPHRASE",
        "PRIVATE_KEY",
        "ACCESS_KEY",
        "ACCESS_KEY_ID",
        "CLIENT_SECRET",
        "APPLICATION_CREDENTIAL",
        "APPLICATION_CREDENTIALS",
        "CREDENTIAL",
        "CREDENTIALS",
        "AUTH",
        "AUTHORIZATION",
        "SIGNING_KEY",
        "ENCRYPTION_KEY",
        "MASTER_KEY",
        "CERT",
        "CERTIFICATE",
        "KEY",
        "COOKIE",
        "BEARER",
        "CONNECTION_STRING",
        "DATABASE_URL",
        "DB_URL",
        "DSN",
        "USERCONFIG",
        "DOCKER_CONFIG",
        "SESSION",
    ];
    let upper = name.to_ascii_uppercase();
    SUFFIXES
        .iter()
        .any(|suffix| upper == *suffix || upper.ends_with(&format!("_{suffix}")))
}

/// 剥离凭据环境变量 + 注入 git 非交互配置（与前端 sanitizeEnv 对齐）。
pub(crate) fn dev_sanitized_env() -> HashMap<String, String> {
    dev_sanitized_env_with_home(true)
}

pub(crate) fn dev_login_sanitized_env() -> HashMap<String, String> {
    dev_sanitized_env_with_home(false)
}

fn dev_sanitized_env_with_home(isolate_home: bool) -> HashMap<String, String> {
    const DENY: &[&str] = &[
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITLAB_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_API_KEY_1",
        "AZURE_OPENAI_API_KEY_2",
        "HF_TOKEN",
        "HUGGING_FACE_HUB_TOKEN",
        "REPLICATE_API_TOKEN",
    ];
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.retain(|key, _| {
        is_safe_env_name(key) && !is_credential_env_name(key) && !DENY.contains(&key.as_str())
    });
    if isolate_home {
        let home = std::env::temp_dir().join("slimemold-worker-home");
        let home = home.to_string_lossy().to_string();
        env.insert("HOME".into(), home.clone());
        env.insert("USERPROFILE".into(), home.clone());
        env.insert("APPDATA".into(), format!("{home}/appdata"));
        env.insert("LOCALAPPDATA".into(), format!("{home}/localappdata"));
        env.insert("NPM_CONFIG_USERCONFIG".into(), format!("{home}/npmrc"));
        env.insert(
            "NPM_CONFIG_GLOBALCONFIG".into(),
            format!("{home}/global-npmrc"),
        );
        env.insert("NPM_CONFIG_CACHE".into(), format!("{home}/npm-cache"));
    }
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    env
}

/// 统一子进程生命周期入口；实际捕获/超时/等待编排位于 `dev_process`。
fn kill_dev_child_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            let _ = libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new(resolve_dev_program("taskkill"))
            .args(["/PID", &pid, "/T", "/F"])
            .status();
    }
    let _ = child.kill();
}

fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<DevExecResult, String> {
    dev_process::run_with_timeout(cmd, timeout, kill_dev_child_tree)
}

fn grep_option_is_safe(arg: &str) -> bool {
    matches!(
        arg,
        "--" | "-n"
            | "-i"
            | "-E"
            | "-F"
            | "-v"
            | "-w"
            | "-x"
            | "-l"
            | "-h"
            | "-s"
            | "--line-number"
            | "--ignore-case"
            | "--fixed-strings"
            | "--invert-match"
    )
}

fn grep_args_are_safe(args: &[String]) -> bool {
    let mut options = true;
    let mut pattern_index = None;
    for (index, argument) in args.iter().enumerate() {
        if options && argument == "--" {
            options = false;
            continue;
        }
        if options && argument.starts_with('-') {
            if !grep_option_is_safe(argument) {
                return false;
            }
        } else {
            pattern_index = Some(index);
            break;
        }
    }
    let Some(pattern_index) = pattern_index else {
        return false;
    };
    args.iter().skip(pattern_index + 1).all(|argument| {
        !argument.starts_with('-')
            && !argument.contains('*')
            && !argument.contains('?')
            && dev_arg_path_lexically_safe(argument)
    })
}

fn find_option_is_safe(arg: &str) -> bool {
    matches!(
        arg,
        "-P" | "-name"
            | "-iname"
            | "-path"
            | "-ipath"
            | "-type"
            | "-maxdepth"
            | "-mindepth"
            | "-mount"
            | "-xdev"
            | "-prune"
            | "-print"
            | "-print0"
            | "-ls"
            | "-printf"
            | "-regex"
            | "-iregex"
            | "-not"
            | "!"
            | "-o"
            | "-or"
            | "-a"
            | "-and"
            | "-quit"
    )
}

/// 与前端 assertSafeGitRevision 对齐的 base revision 词法校验。
/// 这里只允许作为 git diff 的 revision 操作数，不允许路径逃逸或 shell 语义。
fn safe_git_revision_arg(arg: &str) -> bool {
    arg.len() <= 128 && is_git_diff_revision(arg)
}

/// worktree 内允许的命令参数白名单（与前端 capabilities DEFAULT_SHELL_RULES / DEFAULT_TEST_RULES
/// 对齐；P1 审计：Rust 侧也做完整参数校验，WebView 直调 dev_exec 无法执行白名单外的高风险操作）。
fn dev_worktree_cmd_allowed(args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }
    let name = args[0].as_str();
    let rest = &args[1..];
    let rest_eq = |want: &[&str]| rest.iter().map(|s| s.as_str()).eq(want.iter().copied());
    match name {
        // 只读查询命令（无写盘能力：pwd/echo/ls/cat/head/tail）；路径参数须词法安全，
        // 暂不接受命令选项，避免选项携带第二套外部文件输入协议（如 head --files0-from）。
        "pwd" => rest.is_empty(),
        "echo" => true, // 直接 spawn 无 shell 重定向，echo 仅输出，无害
        "ls" | "cat" | "head" | "tail" => rest
            .iter()
            .all(|argument| !argument.starts_with('-') && dev_arg_path_lexically_safe(argument)),
        "find" => {
            !rest
                .iter()
                .any(|a| a.starts_with('-') && !find_option_is_safe(a))
                && rest
                    .iter()
                    .filter(|a| !a.starts_with('-'))
                    .all(|a| *a == "." || dev_arg_path_lexically_safe(a))
                && match rest
                    .iter()
                    .skip_while(|argument| matches!(argument.as_str(), "-P" | "-L" | "-H"))
                    .next()
                    .map(|value| value.as_str())
                {
                    None | Some(".") => true,
                    Some(root) => dev_arg_path_lexically_safe(root),
                }
        }
        // grep 只读；未知选项一律拒绝，避免 --file/--exclude-from 等外部文件输入。
        "grep" => grep_args_are_safe(rest),
        // git 只读 + 精确参数（与前端 shell 白名单 matchesRule 语义一致；明确排除所有写入型）
        "git" => {
            if rest.first().map(String::as_str) == Some("--no-pager") {
                return dev_command_policy::hardened_git_diff_is_supported(args);
            }
            if rest.first().map(String::as_str) == Some("diff") {
                return dev_command_policy::command_intent_kind(args).is_some();
            }
            rest_eq(&["status", "--porcelain"])
                || rest_eq(&["status", "--short"])
                || rest_eq(&["diff", "--name-only", "HEAD"])
                || rest_eq(&["diff", "--name-only"])
                || (rest.len() == 3
                    && rest[0] == "diff"
                    && rest[1] == "--name-only"
                    && safe_git_revision_arg(&rest[2]))
                // 前端 `git diff <path>`：argsPrefix ['diff']，min/maxExtra=1，禁 dash 额外参数；
                // 且路径须词法安全（禁绝对路径 / .. / drive）
                || (rest.len() >= 4
                    && rest[0] == "diff"
                    && is_git_diff_revision(&rest[1])
                    && rest[2] == "--"
                    && rest[3..].iter().all(|path| {
                        !path.starts_with('-')
                            && !path.contains('*')
                            && !path.contains('?')
                            && dev_arg_path_lexically_safe(path)
                    }))
                || (rest.len() == 2
                    && rest[0] == "diff"
                    && is_git_diff_revision(&rest[1]))
                || (rest.len() == 2
                    && rest[0] == "diff"
                    && !is_git_diff_revision(&rest[1])
                    && dev_arg_path_lexically_safe(&rest[1])
                    && !rest[1].starts_with('-')
                    && !rest[1].chars().all(|c| matches!(c, '.' | '/' | '\\'))
                    && !rest[1].contains('*')
                    && !rest[1].contains('?')
                    && !rest[1].contains("--output=")
                    && !rest[1].contains("--no-index")
                    && !rest[1].contains("--ext-diff"))
                // 前端 `git log --oneline -n <num>`：argsPrefix ['log','--oneline','-n']，恰好 1 个数字参数
                || (rest.len() == 4
                    && rest[0] == "log"
                    && rest[1] == "--oneline"
                    && rest[2] == "-n"
                    && rest[3].chars().all(|c| c.is_ascii_digit()))
                // Worktree allocator 的 branch collision probe：只读、只允许本项目生成的 worker ref。
                || (rest.len() == 3
                    && rest[0] == "show-ref"
                    && rest[1] == "--verify"
                    && rest[2].starts_with("refs/heads/worker/w-")
                    && safe_git_revision_arg(&rest[2]))
                || rest_eq(&["ls-files", "--others", "--exclude-standard"])
                || rest_eq(&["rev-parse", "HEAD"])
        }
        // 测试命令（与前端 DEFAULT_TEST_RULES 一致）
        "node" => {
            rest.len() == 2
                && rest[0] == "--check"
                && dev_arg_path_lexically_safe(&rest[1])
                && !rest[1].starts_with('-')
        }
        "tsc" => {
            rest_eq(&["--noEmit"])
                || rest_eq(&["-b"])
                || (rest.len() >= 4
                    && rest[0] == "--noEmit"
                    && rest[1] == "--target"
                    && rest[2] == "es2020"
                    && rest[3..].len() <= 20
                    && rest[3..]
                        .iter()
                        .all(|arg| !arg.starts_with('-') && dev_arg_path_lexically_safe(arg)))
                || (rest.len() >= 2
                    && rest[0] == "--noEmit"
                    && rest[1..].len() <= 20
                    && rest[1..]
                        .iter()
                        .all(|arg| !arg.starts_with('-') && dev_arg_path_lexically_safe(arg)))
        }
        "vitest" => rest_eq(&["run"]),
        "tsx" => {
            // 仅本地脚本 scripts/ 前缀 + 最多 2 个额外参数；脚本路径须词法安全
            !rest.is_empty()
                && rest[0].starts_with("scripts/")
                && !rest[0].starts_with("scripts/../")
                && dev_arg_path_lexically_safe(&rest[0])
                && rest.len() <= 3
                && rest[1..]
                    .iter()
                    .all(|argument| !argument.starts_with('-') && dev_arg_shell_safe(argument))
        }
        "npm" => {
            rest_eq(&["run", "test"])
                || rest_eq(&["run", "build"])
                || rest_eq(&["run", "i18n:check"])
        }
        _ => false,
    }
}

/// 判定 dev_exec 是否放行（cwd 归属 + 命令 + 参数）。
/// 纯函数，便于 Rust 单元测试覆盖主仓库根权限边界。
#[allow(dead_code)]
fn dev_exec_allowed(kind: &DevCwdKind, args: &[String]) -> bool {
    dev_exec_allowed_at(kind, args, None)
}

fn dev_exec_allowed_at(
    kind: &DevCwdKind,
    args: &[String],
    main_repo: Option<&std::path::Path>,
) -> bool {
    if args.is_empty() {
        return false;
    }
    let name = args[0].as_str();
    if !DEV_ALLOWED_CMDS.contains(&name) {
        return false;
    }
    match kind {
        DevCwdKind::MainRepo => dev_main_repo_git_allowed_at(args, main_repo),
        DevCwdKind::Worktree(_) => dev_worktree_cmd_allowed(args),
    }
}

#[cfg(windows)]
fn windows_cmd_arg(value: &str) -> String {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn resolve_dev_exec_program(name: &str) -> std::path::PathBuf {
    let from_path = resolve_dev_program(name);
    if from_path.is_file() {
        return from_path;
    }
    #[cfg(windows)]
    {
        let mut roots = DEV_STATE
            .lock()
            .unwrap()
            .base_repo
            .clone()
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>();
        if let Ok(exe) = std::env::current_exe() {
            roots.extend(exe.ancestors().map(std::path::Path::to_path_buf));
        }
        for root in roots {
            let bin = root.join("node_modules").join(".bin");
            for extension in [".cmd", ".bat", ".exe"] {
                let candidate = bin.join(format!("{name}{extension}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        if name == "node" {
            for candidate in [
                std::path::PathBuf::from(r"D:\Hermes\node\node.exe"),
                std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
                std::path::PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
            ] {
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    from_path
}

#[cfg(windows)]
fn trusted_windows_program(candidate: &std::path::Path) -> Option<std::path::PathBuf> {
    let metadata = fs::symlink_metadata(candidate).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    (path_compare_key(&canonical.to_string_lossy())
        == path_compare_key(&candidate.to_string_lossy()))
    .then_some(canonical)
}

#[cfg(windows)]
fn trusted_windows_comspec() -> Result<std::path::PathBuf, String> {
    let candidates = [
        std::env::var_os("ComSpec").map(std::path::PathBuf::from),
        std::env::var_os("SystemRoot")
            .map(|root| std::path::PathBuf::from(root).join("System32\\cmd.exe")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|candidate| {
            trusted_windows_program(&candidate).filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
            })
        })
        .ok_or_else(|| "dev_exec: 找不到可信的 Windows ComSpec".to_string())
}

fn command_for_dev_exec(args: &[String]) -> Result<std::process::Command, String> {
    let program = resolve_dev_exec_program(&args[0]);
    #[cfg(windows)]
    let program = trusted_windows_program(&program)
        .ok_or_else(|| format!("dev_exec: 命令未解析为可信绝对程序：{}", program.display()))?;
    #[cfg(windows)]
    {
        let extension = program
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("cmd" | "bat")) {
            let command_line = std::iter::once(windows_cmd_arg(&program.display().to_string()))
                .chain(args[1..].iter().map(|arg| windows_cmd_arg(arg)))
                .collect::<Vec<_>>()
                .join(" ");
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new(trusted_windows_comspec()?);
            command.args(["/D", "/S", "/C"]);
            command.raw_arg(format!("\"{command_line}\""));
            return Ok(command);
        }
    }
    let mut command = std::process::Command::new(program);
    command.args(&args[1..]);
    Ok(command)
}

/// H4 GUI 受控命令执行：
/// - 命令名白名单（DEV_ALLOWED_CMDS）；
/// - cwd 归属分级——主仓库根**仅放行严格只读 git 管理命令**（rev-parse/worktree list 等），
///   完整白名单（npm/tsx/写入型 git）仅在**已登记 worktree** 内可用；
/// - 剥离凭据 env + 超时。
#[tauri::command]
fn dev_exec(args: Vec<String>, cwd: String, generation: u64) -> Result<DevExecResult, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_exec").map_err(|error| {
        eprintln!(
            "[dev_exec] session reject args={} cwd={} error={error}",
            args.join(" "),
            cwd
        );
        error
    })?;
    let operation_generation = generation;
    let (kind, initial_cwd_identity) = dev_cwd_binding(&cwd).map_err(|error| {
        eprintln!(
            "[dev_exec] cwd reject args={} cwd={} error={error}",
            args.join(" "),
            cwd
        );
        error
    })?;
    let canonical_cwd = match &kind {
        DevCwdKind::MainRepo => dev_abs_of(&cwd).map_err(|error| {
            eprintln!(
                "[dev_exec] main cwd resolve reject args={} cwd={} error={error}",
                args.join(" "),
                cwd
            );
            error
        })?,
        DevCwdKind::Worktree(path) => path.clone(),
    };
    if !dev_exec_allowed_at(&kind, &args, Some(&canonical_cwd)) {
        eprintln!(
            "[dev_exec] command reject args={} cwd={}",
            args.join(" "),
            canonical_cwd.display()
        );
        return Err(format!(
            "dev_exec: 命令在当前 cwd 不被允许：{}",
            args.join(" ")
        ));
    }
    let _worktree_add_guard = if matches!(kind, DevCwdKind::MainRepo) {
        main_repo_worktree_add_spec(&args)
            .map(|(raw_path, branch)| worktree_add_target_is_safe(&canonical_cwd, raw_path, branch))
            .transpose()?
    } else {
        None
    };
    let effective_args = if args.first().map(String::as_str) == Some("git")
        && args.get(1).map(String::as_str) == Some("diff")
    {
        dev_command_policy::git_diff_execution_args(&args)
            .ok_or_else(|| "dev_exec: Git diff intent 无法构造安全 invocation".to_string())?
    } else {
        args.clone()
    };
    // P1 兜底：对文件路径参数做 canonicalize（解析符号链接）校验，确认未逃逸出 worktree
    dev_exec_validate_paths(&canonical_cwd.to_string_lossy(), &effective_args).map_err(
        |error| {
            eprintln!(
                "[dev_exec] path reject args={} cwd={} error={error}",
                args.join(" "),
                canonical_cwd.display()
            );
            error
        },
    )?;
    let spawn_args =
        canonicalize_dev_exec_args(&canonical_cwd, &effective_args).map_err(|error| {
            eprintln!(
                "[dev_exec] argument canonicalization reject args={} cwd={} error={error}",
                args.join(" "),
                canonical_cwd.display()
            );
            error
        })?;
    if spawn_args.len() >= 8
        && spawn_args[0] == "git"
        && spawn_args[1] == "--no-pager"
        && spawn_args[2] == "diff"
        && spawn_args[6] == "--"
        && spawn_args[5] != "--name-only"
    {
        for pathspec in &spawn_args[7..] {
            git_diff_pathspec_allowed(&canonical_cwd, std::path::Path::new(pathspec))?;
        }
    }
    if matches!(kind, DevCwdKind::Worktree(_)) {
        let allow_execution_only_scripts = spawn_args
            .first()
            .and_then(|program| std::path::Path::new(program).file_stem())
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("tsx"));
        for argument in spawn_args.iter().skip(1) {
            let candidate = std::path::Path::new(argument);
            if candidate.is_absolute() {
                dev_exec_path_allowed(candidate, allow_execution_only_scripts)?;
                if candidate.is_file() && has_multiple_hardlinks(candidate)? {
                    return Err(format!(
                        "dev_exec: 拒绝执行 hardlink 文件 operand（防 inode 逃逸）：{}",
                        candidate.display()
                    ));
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let resolved_program = resolve_dev_exec_program(&spawn_args[0]);
        let resolved_program_text = resolved_program.to_string_lossy();
        let extension = resolved_program
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("cmd" | "bat"))
            && (!dev_arg_shell_safe(&resolved_program_text)
                || spawn_args
                    .iter()
                    .any(|argument| !dev_arg_shell_safe(argument)))
        {
            return Err("dev_exec: Windows shell 参数包含未允许的控制字符或元字符".into());
        }
    }
    let (spawn_kind, spawn_cwd_identity) = dev_cwd_binding(&cwd)?;
    if spawn_kind != kind || spawn_cwd_identity != initial_cwd_identity {
        return Err("dev_exec: spawn 前 cwd ownership 或 identity 已变化".into());
    }
    let mut cmd = command_for_dev_exec(&spawn_args).map_err(|error| {
        eprintln!(
            "[dev_exec] command resolution reject args={} cwd={} error={error}",
            args.join(" "),
            canonical_cwd.display()
        );
        error
    })?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let cwd_handle = open_unix_file_relative(
            &canonical_cwd,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
            None,
            Some(&_spawn_cwd_identity),
        )?;
        if stable_file_identity_from_file(&cwd_handle)? != _spawn_cwd_identity {
            return Err("spawn cwd directory identity 已变化".into());
        }
        unsafe {
            cmd.pre_exec(move || {
                if libc::fchdir(cwd_handle.as_raw_fd()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    cmd.current_dir(&canonical_cwd);
    cmd.env_clear();
    for (k, v) in dev_sanitized_env() {
        cmd.env(k, v);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(30)).map_err(|error| {
        eprintln!(
            "[dev_exec] {} cwd={} error={}",
            args.join(" "),
            canonical_cwd.display(),
            error
        );
        format!("dev_exec: {error}")
    })?;
    if DEV_STATE.lock().unwrap().generation != operation_generation {
        return Err("dev_exec: session 在命令执行期间发生变化".to_string());
    }
    if result.code == 0 && matches!(kind, DevCwdKind::MainRepo) {
        update_pending_worktree_after_success(&canonical_cwd, &args);
    }
    Ok(result)
}

fn git_top_level(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_dev_env(&mut cmd);
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if result.code != 0 {
        return Err("Git top-level probe 失败".to_string());
    }
    std::path::PathBuf::from(result.stdout.trim())
        .canonicalize()
        .map_err(|_| "Git top-level 输出无效".to_string())
}

/// 初始化 H4 宿主登记态（GUI 打开项目 / DevSession 初始化时调用）。
#[tauri::command]
fn dev_init_session(base_repo: String) -> Result<u64, String> {
    let _operation_guard = lock_dev_operation();
    let p = std::path::Path::new(&base_repo);
    if !p.exists() || !p.is_dir() {
        return Err(format!(
            "dev_init_session: 主仓库不存在或不是目录：{base_repo}"
        ));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("dev_init_session: 路径解析失败：{base_repo}（{e}）"))?;
    let top = git_top_level(&canon)?;
    if path_compare_key(&top.to_string_lossy()) != path_compare_key(&canon.to_string_lossy()) {
        return Err("dev_init_session: baseRepo 必须是 Git repository top-level".to_string());
    }
    let base_identity = stable_directory_identity(&canon)?;
    codex::clear_codex_session_state()?;
    let mut st = DEV_STATE.lock().unwrap();
    st.generation = next_session_generation(st.generation);
    st.base_repo = Some(canon.to_string_lossy().to_string());
    st.base_identity = Some(base_identity);
    st.worktrees.clear();
    st.registrations.clear();
    st.cleanup_bindings.clear();
    st.pending_worktrees.clear();
    st.orphan_worktrees.clear();
    Ok(st.generation)
}

/// 清空 H4 宿主登记态（GUI 切换/关闭项目时先调用，避免旧项目登记态泄漏到新项目）。
#[tauri::command]
fn dev_clear_session(generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_clear_session")?;
    codex::clear_codex_session_state()?;
    let mut st = DEV_STATE.lock().unwrap();
    st.generation = next_session_generation(st.generation);
    st.base_repo = None;
    st.base_identity = None;
    st.worktrees.clear();
    st.registrations.clear();
    st.cleanup_bindings.clear();
    st.pending_worktrees.clear();
    st.orphan_worktrees.clear();
    Ok(())
}

/// 登记一个 worktree（前端 dev.worktree.create 成功后调用；支持相对路径基于主仓库根解析）。
fn git_worktree_list(repo: &std::path::Path) -> Result<String, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"]);
    cmd.env_clear();
    for (key, value) in dev_sanitized_env() {
        cmd.env(key, value);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if result.code != 0 {
        return Err("Git worktree list probe 失败".to_string());
    }
    validate_git_worktree_porcelain(&result.stdout)?;
    Ok(result.stdout)
}

fn git_worktree_is_listed(
    repo: &std::path::Path,
    target: &std::path::Path,
) -> Result<bool, String> {
    Ok(git_worktree_list(repo)?.lines().any(|line| {
        line.strip_prefix("worktree ").is_some_and(|path| {
            path_compare_key(path.trim()) == path_compare_key(&target.to_string_lossy())
        })
    }))
}

fn git_worktree_matches(
    repo: &std::path::Path,
    target: &std::path::Path,
    expected_branch: &str,
) -> Result<bool, String> {
    let mut listed_path = None;
    for line in git_worktree_list(repo)?.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            listed_path = Some(path.trim());
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if listed_path.is_some_and(|path| {
                path_compare_key(path) == path_compare_key(&target.to_string_lossy())
            }) && branch.trim() == expected_branch
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn git_branch_is_listed(repo: &std::path::Path, branch: &str) -> Result<bool, String> {
    let expected = format!("branch refs/heads/{branch}");
    Ok(git_worktree_list(repo)?
        .lines()
        .any(|line| line.trim() == expected))
}

fn git_branch_revision(repo: &std::path::Path, branch: &str) -> Result<String, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "--end-of-options"])
        .arg(format!("refs/heads/{branch}^{{commit}}"));
    cmd.env_clear();
    for (key, value) in dev_sanitized_env() {
        cmd.env(key, value);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if result.code != 0 {
        return Err("Git branch revision probe 失败".into());
    }
    let revision = result.stdout.trim().to_string();
    if !is_full_object_id(&revision) {
        return Err("Git branch revision 输出无效".into());
    }
    Ok(revision)
}

fn git_branch_exists(repo: &std::path::Path, branch: &str) -> Result<bool, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(repo)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"));
    cmd.env_clear();
    for (key, value) in dev_sanitized_env() {
        cmd.env(key, value);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    match result.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err("Git branch existence probe 失败".to_string()),
    }
}

#[tauri::command]
fn dev_register_worktree(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_register_worktree")?;
    let (base, base_identity, registration_generation) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_register_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_register_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
            state.generation,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    if !canon.is_dir() {
        return Err(format!(
            "dev_register_worktree: worktree 不存在或不是目录：{path}"
        ));
    }
    let identity = stable_directory_identity(&canon)?;
    let name = canon
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "dev_register_worktree: worktree 目录名无效".to_string())?;
    let branch = format!("worker/{name}");
    if !main_repo_worktree_target_is_valid(&base_path, &canon.to_string_lossy(), &branch) {
        return Err("dev_register_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_worktree: Git probe 前主仓库 directory identity 已变化".into());
    }
    if !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_register_worktree: 目标不是主仓库登记的匹配 Worker worktree".into());
    }
    if stable_directory_identity(&canon)? != identity {
        return Err(
            "dev_register_worktree: worktree directory identity 在 Git probe 后发生变化".into(),
        );
    }
    let has_pending_lease = pending_worker_target(&base_path, &path);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_worktree: commit 前主仓库 directory identity 已变化".into());
    }
    let canonical_path = canon.to_string_lossy().to_string();
    let mut st = DEV_STATE.lock().unwrap();
    if st.base_repo.as_deref() != Some(base.as_str())
        || st.base_identity.as_ref() != Some(&base_identity)
        || st.generation != registration_generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_register_worktree: 主仓库 session 在校验期间发生变化".into());
    }
    if registered_worktree_identity_conflicts(
        &st.registrations,
        registration_generation,
        &canonical_path,
        &branch,
        &identity,
    ) {
        return Err("dev_register_worktree: 已登记 worktree identity 冲突".into());
    }
    let already_registered = st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        ) && registered.identity == identity
    });
    if !already_registered && !has_pending_lease {
        return Err("dev_register_worktree: 缺少当前 host 创建的 pending worktree lease".into());
    }
    if !st
        .worktrees
        .iter()
        .any(|w| path_compare_key(w) == path_compare_key(&canonical_path))
    {
        st.worktrees.push(canonical_path.clone());
    }
    if !st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        )
    }) {
        st.registrations.push(RegisteredWorktree {
            generation: registration_generation,
            path: canonical_path.clone(),
            branch: branch.clone(),
            identity: identity.clone(),
        });
    }
    st.pending_worktrees
        .retain(|pending| path_compare_key(&pending.path) != path_compare_key(&canonical_path));
    Ok(())
}

#[tauri::command]
fn dev_restore_worktree(path: String, branch: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_restore_worktree")?;
    if !worker_branch_is_valid(&branch) {
        return Err("dev_restore_worktree: branch 无效".to_string());
    }
    let (base, base_identity, registration_generation) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_restore_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_restore_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
            state.generation,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_restore_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let trusted_target_identity = {
        let state = DEV_STATE.lock().unwrap();
        state
            .registrations
            .iter()
            .find(|registered| {
                registered_worktree_identity_matches(
                    registered,
                    registration_generation,
                    &canon.to_string_lossy(),
                    &branch,
                )
            })
            .map(|registered| registered.identity.clone())
            .ok_or_else(|| {
                "dev_restore_worktree: 缺少 trusted target identity，拒绝重绑定当前路径".to_string()
            })?
    };
    if !canon.is_dir() {
        return Err(format!(
            "dev_restore_worktree: worktree 不存在或不是目录：{path}"
        ));
    }
    let identity = stable_directory_identity(&canon)?;
    if identity != trusted_target_identity {
        return Err(
            "dev_restore_worktree: current target identity 不匹配 trusted registration".into(),
        );
    }
    let canonical_path = canon.to_string_lossy().to_string();
    if !main_repo_worktree_target_is_valid(&base_path, &canonical_path, &branch) {
        return Err("dev_restore_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_restore_worktree: Git probe 前主仓库 directory identity 已变化".into());
    }
    if !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_restore_worktree: 目标不是主仓库登记的匹配 Worker worktree".into());
    }
    if stable_directory_identity(&canon)? != identity {
        return Err(
            "dev_restore_worktree: worktree directory identity 在 Git probe 后发生变化".into(),
        );
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_restore_worktree: commit 前主仓库 directory identity 已变化".into());
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != registration_generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_restore_worktree: 主仓库 session 在校验期间发生变化".into());
    }
    if registered_worktree_identity_conflicts(
        &state.registrations,
        registration_generation,
        &canonical_path,
        &branch,
        &identity,
    ) {
        return Err("dev_restore_worktree: 已登记 worktree identity 冲突".into());
    }
    if let Some(existing) = state.registrations.iter().find(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        )
    }) {
        if existing.identity != identity {
            return Err("dev_restore_worktree: 已登记 worktree identity 冲突".into());
        }
    }
    if !state
        .worktrees
        .iter()
        .any(|worktree| path_compare_key(worktree) == path_compare_key(&canonical_path))
    {
        state.worktrees.push(canonical_path.clone());
    }
    if !state.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        )
    }) {
        state.registrations.push(RegisteredWorktree {
            generation: registration_generation,
            path: canonical_path.clone(),
            branch,
            identity,
        });
    }
    state
        .pending_worktrees
        .retain(|pending| path_compare_key(&pending.path) != path_compare_key(&canonical_path));
    Ok(())
}

#[tauri::command]
fn dev_register_orphan_worktree(
    path: String,
    branch: String,
    generation: u64,
) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_register_orphan_worktree")?;
    if !worker_branch_is_valid(&branch) {
        return Err("dev_register_orphan_worktree: branch 无效".into());
    }
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_register_orphan_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_register_orphan_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_orphan_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let target_metadata = match fs::symlink_metadata(&canon) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "dev_register_orphan_worktree: 无法读取 target metadata：{error}"
            ));
        }
    };
    if stable_directory_identity(&base_path)? != base_identity {
        return Err(
            "dev_register_orphan_worktree: Git probe 前主仓库 directory identity 已变化".into(),
        );
    }
    let listed_match = git_worktree_matches(&base_path, &canon, &branch)?;
    if stable_directory_identity(&base_path)? != base_identity {
        return Err(
            "dev_register_orphan_worktree: branch probe 前主仓库 directory identity 已变化".into(),
        );
    }
    let branch_listed_elsewhere = git_branch_is_listed(&base_path, &branch)?;
    let branch_exists = git_branch_exists(&base_path, &branch)?;
    let target_is_scoped = main_repo_worktree_target_is_valid(&base_path, &c, &branch);
    let target_exists = target_metadata.is_some();
    if !orphan_target_is_deleted_candidate(
        listed_match || branch_listed_elsewhere,
        target_exists,
        branch_exists,
        target_is_scoped,
    ) {
        return Err(
            "dev_register_orphan_worktree: 目标必须是受控且已删除的 Worker worktree".into(),
        );
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err(
            "dev_register_orphan_worktree: commit 前主仓库 directory identity 已变化".into(),
        );
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_register_orphan_worktree: session 在校验期间发生变化".into());
    }
    if !state
        .orphan_worktrees
        .iter()
        .any(|item| path_compare_key(&item.path) == path_compare_key(&c))
    {
        state.orphan_worktrees.push(PendingWorktree {
            generation,
            path: c,
            branch,
            identity: None,
            branch_revision: None,
            removed: true,
        });
    }
    Ok(())
}

#[tauri::command]
fn dev_approve_cleanup(
    app: AppHandle,
    path: String,
    branch: String,
    branch_revision: String,
    generation: u64,
) -> Result<String, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_approve_cleanup")?;
    if !is_full_object_id(&branch_revision) || !worker_branch_is_valid(&branch) {
        return Err("dev_approve_cleanup: branch 或 revision 无效".into());
    }
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_approve_cleanup: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_approve_cleanup: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_approve_cleanup: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let target_identity = match fs::symlink_metadata(&canon) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("dev_approve_cleanup: target 必须是目录或已消失的 orphan path".into());
        }
        Ok(_) => Some(stable_directory_identity(&canon)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "dev_approve_cleanup: 无法读取 target metadata：{error}"
            ))
        }
    };
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_approve_cleanup: 路径/分支不属于受控 Worker 根".into());
    }
    {
        let state = DEV_STATE.lock().unwrap();
        let registered_identity = state
            .registrations
            .iter()
            .find(|item| registered_worktree_identity_matches(item, generation, &c, &branch))
            .map(|item| item.identity.clone());
        let orphan = state.orphan_worktrees.iter().any(|item| {
            item.generation == generation
                && item.branch == branch
                && path_compare_key(&item.path) == path_compare_key(&c)
        });
        if registered_identity.is_some() && orphan {
            return Err("dev_approve_cleanup: target 同时存在 registered/orphan lineage".into());
        }
        if let Some(expected_identity) = registered_identity {
            if target_identity.as_ref() != Some(&expected_identity) {
                return Err(
                    "dev_approve_cleanup: 当前 target identity 不匹配原登记 identity".into(),
                );
            }
        } else if orphan {
            if target_identity.is_some() || git_branch_is_listed(&base_path, &branch)? {
                return Err(
                    "dev_approve_cleanup: orphan target 已重新出现或仍被 Git checkout".into(),
                );
            }
        } else {
            return Err("dev_approve_cleanup: worktree 未被当前 host 登记".into());
        }
        if state
            .pending_worktrees
            .iter()
            .any(|pending| path_compare_key(&pending.path) == path_compare_key(&c))
        {
            return Err("dev_approve_cleanup: pending rollback worktree 不能清理".into());
        }
    }
    if target_identity.is_some() && !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_approve_cleanup: 当前 Git worktree path/branch 不匹配".into());
    }
    let message = format!(
        "确认清理 Worker worktree？\\n\\n路径：{}\\n分支：{}\\n当前 revision：{}",
        c, branch, branch_revision
    );
    if !app
        .dialog()
        .message(message)
        .title("确认 Worker Cleanup")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show()
    {
        return Err("dev_approve_cleanup: 用户拒绝或关闭了原生确认框".into());
    }
    let token = new_cleanup_token();
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_approve_cleanup: 确认后主仓库 directory identity 已变化".into());
    }
    let current_target_identity = match (&target_identity, fs::symlink_metadata(&canon)) {
        (None, Err(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
        (Some(_), Ok(metadata)) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("dev_approve_cleanup: 确认后 target 不再是安全目录".into());
        }
        (Some(_), Ok(_)) => Some(stable_directory_identity(&canon)?),
        (None, Ok(_)) => return Err("dev_approve_cleanup: 确认后 orphan target 重新出现".into()),
        (_, Err(error)) => {
            return Err(format!(
                "dev_approve_cleanup: 确认后无法读取 target：{error}"
            ))
        }
    };
    if current_target_identity != target_identity {
        return Err("dev_approve_cleanup: 确认后 target directory identity 已变化".into());
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_approve_cleanup: session 在确认后发生变化".into());
    }
    if target_identity.is_some() && !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_approve_cleanup: 确认后 Git worktree path/branch 已漂移".into());
    }
    state.cleanup_bindings.retain(|binding| !binding.consumed);
    state.cleanup_bindings.push(CleanupBinding {
        token: token.clone(),
        generation,
        path: c,
        branch,
        branch_revision,
        base_identity,
        target_identity,
        consumed: false,
    });
    Ok(token)
}

/// Native cleanup is capability-based: JS-side proposal validation is not sufficient.
/// `dev_approve_cleanup` issues a one-shot token only after revalidation and a native
/// confirmation dialog; `dev_cleanup_worktree` refuses every unbound destructive call.
fn cleanup_target_identity_is_current(
    repo: &std::path::Path,
    target: &std::path::Path,
    branch: &str,
    expected: Option<&StableDirectoryIdentity>,
) -> Result<bool, String> {
    match expected {
        Some(expected) => {
            let metadata = match fs::symlink_metadata(target) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(format!("无法读取 cleanup target metadata：{error}")),
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Ok(false);
            }
            Ok(stable_directory_identity(target)? == *expected)
        }
        None => {
            let absent = match fs::symlink_metadata(target) {
                Ok(_) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => return Err(format!("无法读取 orphan target metadata：{error}")),
            };
            Ok(absent && !git_branch_is_listed(repo, branch)?)
        }
    }
}

#[tauri::command]
fn dev_cleanup_worktree(
    path: String,
    branch: String,
    branch_revision: String,
    approval_token: String,
    generation: u64,
) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_cleanup_worktree")?;
    if !is_full_object_id(&branch_revision) || !worker_branch_is_valid(&branch) {
        return Err("dev_cleanup_worktree: branch 或 revision 无效".into());
    }
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_cleanup_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_cleanup_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_cleanup_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_cleanup_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    let expected_target_identity = {
        let state = DEV_STATE.lock().unwrap();
        let Some(capability) = state.cleanup_bindings.iter().find(|binding| {
            cleanup_binding_matches(
                binding,
                &approval_token,
                generation,
                &c,
                &branch,
                &branch_revision,
            )
        }) else {
            return Err("dev_cleanup_worktree: 缺少匹配的 native cleanup capability".into());
        };
        if capability.base_identity != base_identity {
            drop(state);
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: cleanup capability base identity 已漂移".into());
        }
        let registered_identity = state
            .registrations
            .iter()
            .find(|item| registered_worktree_identity_matches(item, generation, &c, &branch))
            .map(|item| item.identity.clone());
        let orphan = state.orphan_worktrees.iter().any(|item| {
            item.generation == generation
                && item.branch == branch
                && path_compare_key(&item.path) == path_compare_key(&c)
        });
        match (&capability.target_identity, registered_identity, orphan) {
            (Some(expected), Some(current), false) if expected == &current => {}
            (None, None, true) => {}
            _ => {
                drop(state);
                invalidate_cleanup_binding(&approval_token);
                return Err("dev_cleanup_worktree: cleanup lineage/identity 不匹配".into());
            }
        }
        if state
            .pending_worktrees
            .iter()
            .any(|pending| path_compare_key(&pending.path) == path_compare_key(&c))
        {
            drop(state);
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: pending rollback worktree 不能清理".into());
        }
        capability.target_identity.clone()
    };
    if !cleanup_target_identity_is_current(
        &base_path,
        &canon,
        &branch,
        expected_target_identity.as_ref(),
    )? {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: cleanup target identity 已漂移或 orphan 已重新出现".into(),
        );
    }
    if expected_target_identity.is_some() {
        let matches = match git_worktree_matches(&base_path, &canon, &branch) {
            Ok(matches) => matches,
            Err(error) => {
                invalidate_cleanup_binding(&approval_token);
                return Err(error);
            }
        };
        if !matches {
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: 当前 Git worktree path/branch 不匹配".into());
        }
    }
    if stable_directory_identity(&base_path)? != base_identity
        || !cleanup_target_identity_is_current(
            &base_path,
            &canon,
            &branch,
            expected_target_identity.as_ref(),
        )?
    {
        invalidate_cleanup_binding(&approval_token);
        return Err("dev_cleanup_worktree: branch CAS 前 identity 已漂移".into());
    }
    let mut delete = Command::new(resolve_dev_program("git"));
    delete
        .current_dir(&base_path)
        .args(["update-ref", "-d"])
        .arg(format!("refs/heads/{branch}"))
        .arg(&branch_revision);
    apply_dev_env(&mut delete);
    let result = match run_with_timeout(&mut delete, Duration::from_secs(30)) {
        Ok(result) => result,
        Err(error) => {
            invalidate_cleanup_binding(&approval_token);
            return Err(error);
        }
    };
    if result.code != 0 {
        invalidate_cleanup_binding(&approval_token);
        return Err(format!(
            "dev_cleanup_worktree: branch CAS 删除失败：{}",
            result.stderr
        ));
    }
    if stable_directory_identity(&base_path)? != base_identity
        || !cleanup_target_identity_is_current(
            &base_path,
            &canon,
            &branch,
            expected_target_identity.as_ref(),
        )?
    {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: branch CAS 后 identity 漂移，结果必须按 unknown 处理".into(),
        );
    }
    let listed_after_cas = match git_worktree_is_listed(&base_path, &canon) {
        Ok(listed) => listed,
        Err(error) => {
            invalidate_cleanup_binding(&approval_token);
            return Err(format!(
                "dev_cleanup_worktree: branch CAS 后无法确认 worktree 状态：{error}"
            ));
        }
    };
    if expected_target_identity.is_some() && !listed_after_cas {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: branch CAS 后 worktree listing 消失，结果必须按 unknown 处理"
                .into(),
        );
    }
    if expected_target_identity.is_none() && listed_after_cas {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: branch-only orphan 在 CAS 后重新出现在 worktree listing".into(),
        );
    }
    if listed_after_cas {
        if stable_directory_identity(&base_path)? != base_identity
            || !cleanup_target_identity_is_current(
                &base_path,
                &canon,
                &branch,
                expected_target_identity.as_ref(),
            )?
        {
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: worktree remove 前 identity 已漂移".into());
        }
        let mut remove = Command::new(resolve_dev_program("git"));
        remove
            .current_dir(&base_path)
            .args(["worktree", "remove", "--force"]);
        remove.arg(&canon);
        apply_dev_env(&mut remove);
        let result = match run_with_timeout(&mut remove, Duration::from_secs(30)) {
            Ok(result) => result,
            Err(error) => {
                invalidate_cleanup_binding(&approval_token);
                return Err(error);
            }
        };
        if result.code != 0 {
            invalidate_cleanup_binding(&approval_token);
            return Err(format!(
                "dev_cleanup_worktree: branch 已按 CAS 删除，但 worktree remove 失败：{}",
                result.stderr
            ));
        }
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        drop(state);
        invalidate_cleanup_binding(&approval_token);
        return Err("dev_cleanup_worktree: session 在清理后发生变化".into());
    }
    if let Some(binding) = state
        .cleanup_bindings
        .iter_mut()
        .find(|binding| binding.token == approval_token)
    {
        binding.consumed = true;
    }
    state
        .registrations
        .retain(|item| !registered_worktree_identity_matches(item, generation, &c, &branch));
    state
        .worktrees
        .retain(|item| path_compare_key(item) != path_compare_key(&c));
    state
        .orphan_worktrees
        .retain(|item| path_compare_key(&item.path) != path_compare_key(&c));
    Ok(())
}

/// 注销 worktree（前端清理成功后调用）。
#[tauri::command]
fn dev_unregister_worktree(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_unregister_worktree")?;
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_unregister_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_unregister_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_unregister_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let name = canon
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "dev_unregister_worktree: worktree 目录名无效".to_string())?;
    let branch = format!("worker/{name}");
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_unregister_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    {
        let state = DEV_STATE.lock().unwrap();
        if state
            .pending_worktrees
            .iter()
            .any(|pending| path_compare_key(&pending.path) == path_compare_key(&c))
        {
            return Err("dev_unregister_worktree: pending rollback worktree 不能注销".into());
        }
    }
    if git_worktree_is_listed(&base_path, &canon)? {
        return Err("dev_unregister_worktree: Git worktree 仍处于 live 状态".into());
    }
    if git_branch_exists(&base_path, &branch)? {
        return Err("dev_unregister_worktree: Worker branch 仍存在".into());
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_unregister_worktree: commit 前主仓库 directory identity 已变化".into());
    }
    let mut st = DEV_STATE.lock().unwrap();
    if st.base_repo.as_deref() != Some(base.as_str())
        || st.base_identity.as_ref() != Some(&base_identity)
        || st.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_unregister_worktree: session 在 read-back 期间发生变化".into());
    }
    let has_lineage = st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(registered, generation, &c, &branch)
    }) || st.orphan_worktrees.iter().any(|item| {
        item.generation == generation
            && item.branch == branch
            && path_compare_key(&item.path) == path_compare_key(&c)
    });
    if has_lineage {
        return Err(
            "dev_unregister_worktree: lineage 仍存在，必须使用 native cleanup capability".into(),
        );
    }
    if let Some(index) = st
        .worktrees
        .iter()
        .position(|w| path_compare_key(w) == path_compare_key(&c))
    {
        st.worktrees.remove(index);
    }
    st.registrations.retain(|registered| {
        !registered_worktree_identity_matches(registered, generation, &c, &branch)
    });
    Ok(())
}

fn has_multiple_hardlinks(path: &std::path::Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::mem::MaybeUninit;
        use std::os::windows::io::AsRawHandle;
        let file = fs::File::open(path).map_err(|e| format!("无法安全检查目标 inode：{e}"))?;
        let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 {
            return Err("无法安全检查目标 inode".to_string());
        }
        return Ok(unsafe { info.assume_init() }.number_of_links > 1);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Ok(fs::metadata(path)
            .map_err(|e| format!("无法安全检查目标 inode：{e}"))?
            .nlink()
            > 1);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(false)
    }
}

fn dev_path_allowed_with_options(
    abs: &std::path::Path,
    allow_execution_only_scripts: bool,
) -> Result<(), String> {
    let norm_abs = dev_strip_verbatim(abs);
    let state = DEV_STATE.lock().unwrap();
    for registered in &state.registrations {
        let wc = dev_strip_verbatim(std::path::Path::new(&registered.path));
        if path_is_same_or_child(&norm_abs, &wc) {
            let current_identity = stable_directory_identity(&wc).map_err(|error| {
                format!("dev_file: 无法重新绑定已登记 worktree identity：{error}")
            })?;
            if current_identity != registered.identity {
                return Err(format!(
                    "dev_file: 已登记 worktree identity 已变化：{}",
                    registered.path
                ));
            }
            if let Some(error) = protected_path_error(&norm_abs, &wc) {
                if !(allow_execution_only_scripts
                    && protected_path_is_execution_only_script(&norm_abs, &wc))
                {
                    return Err(error);
                }
            }
            return Ok(());
        }
    }
    for w in &state.worktrees {
        let wc = dev_strip_verbatim(std::path::Path::new(w));
        if path_is_same_or_child(&norm_abs, &wc) {
            if let Some(error) = protected_path_error(&norm_abs, &wc) {
                if !(allow_execution_only_scripts
                    && protected_path_is_execution_only_script(&norm_abs, &wc))
                {
                    return Err(error);
                }
            }
            return Ok(());
        }
    }
    Err(format!(
        "dev_file: 路径不属于任何已登记 worktree：{}",
        abs.display()
    ))
}

fn dev_path_allowed(abs: &std::path::Path) -> Result<(), String> {
    dev_path_allowed_with_options(abs, false)
}

fn dev_exec_path_allowed(
    abs: &std::path::Path,
    allow_execution_only_scripts: bool,
) -> Result<(), String> {
    dev_path_allowed_with_options(abs, allow_execution_only_scripts)
}

/// 在已登记 worktree 内创建一级目录。
/// 父目录必须已存在并先 canonicalize；目标 symlink 永不跟随，调用方负责逐级创建。
#[tauri::command]
fn dev_create_dir(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_create_dir")?;
    let _base_identity = assert_base_identity_current("dev_create_dir")?;
    let p = std::path::Path::new(&path);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("dev_create_dir: 路径禁止包含 '..' 逃逸：{path}"));
    }
    let base_dir = {
        let state = DEV_STATE.lock().unwrap();
        state.base_repo.clone().unwrap_or_default()
    };
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::PathBuf::from(&base_dir).join(p)
    };
    let parent = joined
        .parent()
        .ok_or_else(|| format!("dev_create_dir: 无法解析父目录：{path}"))?;
    let canon_parent = parent.canonicalize().map_err(|e| {
        format!(
            "dev_create_dir: 无法解析父目录（{}）：{e}",
            parent.display()
        )
    })?;
    dev_path_allowed(&canon_parent)?;
    let name = joined
        .file_name()
        .ok_or_else(|| "dev_create_dir: 路径缺少目录名".to_string())?;
    let target = canon_parent.join(name);

    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "dev_create_dir: 拒绝操作符号链接目录（防 symlink 逃逸）：{}",
                target.display()
            ));
        }
        if !meta.is_dir() {
            return Err(format!(
                "dev_create_dir: 目标已存在但不是目录：{}",
                target.display()
            ));
        }
        dev_path_allowed(&target)?;
        return Ok(());
    }

    dev_path_allowed(&target)?;
    match fs::create_dir(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&target)
                .map_err(|e| format!("dev_create_dir: 竞态后无法读取目标：{e}"))?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(format!(
                    "dev_create_dir: 竞态后目标不是安全目录：{}",
                    target.display()
                ));
            }
        }
        Err(error) => {
            return Err(format!("dev_create_dir: 创建失败：{path}（{error}）"));
        }
    }
    let real = target
        .canonicalize()
        .map_err(|e| format!("dev_create_dir: 目标解析失败：{e}"))?;
    dev_path_allowed(&real)
}

/// 读文件（仅 worktree 内；H4 节点 code.read / 状态签名等；相对路径基于主仓库根解析）。
#[tauri::command]
fn dev_read_file(path: String, generation: u64) -> Result<String, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_read_file")?;
    let _base_identity = assert_base_identity_current("dev_read_file")?;
    let abs = dev_abs_of(&path)?;
    if !abs.is_file() {
        return Err(format!("dev_read_file: 文件不存在：{path}"));
    }
    dev_path_allowed(&abs)?;
    let expected_identity = stable_file_identity(&abs)?;
    let expected_parent_path = abs
        .parent()
        .ok_or_else(|| "dev_read_file: parent identity unavailable".to_string())?;
    dev_path_allowed(expected_parent_path)?;
    let expected_parent = stable_file_identity(expected_parent_path)?;
    if has_multiple_hardlinks(&abs)? {
        return Err(format!(
            "dev_read_file: 拒绝读取 hardlink 目标（防 inode 逃逸）：{}",
            abs.display()
        ));
    }
    read_dev_file_bound(&abs, &expected_identity, &expected_parent)
}

// 写文件（仅 worktree 内；H4 节点 code.patch 落盘等；相对路径基于主仓库根解析）。
#[cfg(windows)]
#[repr(C)]
struct WinByHandleFileInformation {
    file_attributes: u32,
    creation_low: u32,
    creation_high: u32,
    access_low: u32,
    access_high: u32,
    write_low: u32,
    write_high: u32,
    volume_serial: u32,
    size_high: u32,
    size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandle(
        handle: *mut std::ffi::c_void,
        info: *mut WinByHandleFileInformation,
    ) -> i32;
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StableFileIdentity {
    volume_or_device: u64,
    file_or_inode: u64,
}

#[cfg(unix)]
fn stable_file_identity_from_metadata(
    metadata: &std::fs::Metadata,
) -> Result<StableFileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let identity = StableFileIdentity {
        volume_or_device: metadata.dev(),
        file_or_inode: metadata.ino(),
    };
    if identity.volume_or_device == 0 || identity.file_or_inode == 0 {
        return Err("文件 identity platform identifiers 不可用".into());
    }
    Ok(identity)
}

#[cfg(windows)]
fn stable_file_identity_from_handle(
    handle: *mut std::ffi::c_void,
) -> Result<StableFileIdentity, String> {
    use std::mem::MaybeUninit;
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } == 0 {
        return Err("无法读取绑定文件 identity".into());
    }
    let info = unsafe { info.assume_init() };
    let identity = StableFileIdentity {
        volume_or_device: info.volume_serial as u64,
        file_or_inode: (u64::from(info.file_index_high) << 32) | u64::from(info.file_index_low),
    };
    if identity.volume_or_device == 0 || identity.file_or_inode == 0 {
        return Err("文件 identity platform identifiers 不可用".into());
    }
    Ok(identity)
}

#[allow(dead_code)]
fn stable_file_identity_from_file(file: &fs::File) -> Result<StableFileIdentity, String> {
    #[cfg(unix)]
    {
        return stable_file_identity_from_metadata(
            &file
                .metadata()
                .map_err(|error| format!("无法读取bound fd metadata：{error}"))?,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        return stable_file_identity_from_handle(file.as_raw_handle());
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err("当前平台不支持 bound fd identity".into())
    }
}

#[cfg(unix)]
fn open_unix_file_relative(
    path: &std::path::Path,
    flags: i32,
    mode: libc::mode_t,
    expected_parent: Option<&StableFileIdentity>,
    expected_final: Option<&StableFileIdentity>,
) -> Result<fs::File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;
    const DIRECTORY_FLAGS: i32 =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    let mut directory = {
        let root = CString::new("/").map_err(|_| "无法构造 Unix root".to_string())?;
        let fd = unsafe { libc::open(root.as_ptr(), DIRECTORY_FLAGS, 0) };
        if fd < 0 {
            return Err(format!(
                "无法打开 Unix root：{}",
                std::io::Error::last_os_error()
            ));
        }
        unsafe { fs::File::from_raw_fd(fd) }
    };
    let components: Vec<_> = path.components().collect();
    if !path.is_absolute() || components.is_empty() {
        return Err(format!("文件路径必须是绝对路径：{}", path.display()));
    }
    if components.len() == 1 {
        if flags & libc::O_DIRECTORY == 0 {
            return Err(format!("根路径不能作为文件：{}", path.display()));
        }
        if let Some(expected_final) = expected_final {
            if stable_file_identity_from_file(&directory)? != *expected_final {
                return Err("Unix root cwd identity 已变化".into());
            }
        }
        return Ok(directory);
    }
    for component in &components[1..components.len() - 1] {
        let Component::Normal(name) = component else {
            return Err(format!(
                "文件父路径包含不安全 component：{}",
                path.display()
            ));
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| format!("文件父路径包含 NUL：{}", path.display()))?;
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS, 0) };
        if fd < 0 {
            return Err(format!(
                "无法绑定文件父目录：{}",
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { fs::File::from_raw_fd(fd) };
    }
    if let Some(expected_parent) = expected_parent {
        let actual_parent = stable_file_identity_from_file(&directory)?;
        if actual_parent != *expected_parent {
            return Err(format!("文件父目录 identity 已变化：{}", path.display()));
        }
    }
    let Component::Normal(name) = components.last().unwrap() else {
        return Err(format!("文件名 component 无效：{}", path.display()));
    };
    let name =
        CString::new(name.as_bytes()).map_err(|_| format!("文件名包含 NUL：{}", path.display()))?;
    let final_flags = flags
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if flags & libc::O_DIRECTORY == 0 {
            libc::O_NONBLOCK
        } else {
            0
        };
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), final_flags, mode) };
    if fd < 0 {
        return Err(format!("无法绑定文件：{}", std::io::Error::last_os_error()));
    }
    let file = unsafe { fs::File::from_raw_fd(fd) };
    if let Some(expected_final) = expected_final {
        if stable_file_identity_from_file(&file)? != *expected_final {
            return Err(format!("文件final identity 已变化：{}", path.display()));
        }
    }
    Ok(file)
}

#[cfg(unix)]
fn create_unix_file_relative(
    path: &std::path::Path,
    content: &str,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    use std::io::Write;
    let mut file = open_unix_file_relative(
        path,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o644,
        Some(expected_parent),
        None,
    )?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("创建绑定文件失败：{error}"))
}

fn stable_file_identity(path: &std::path::Path) -> Result<StableFileIdentity, String> {
    if path.is_dir() {
        let directory = stable_directory_identity(path)?;
        return Ok(StableFileIdentity {
            volume_or_device: directory.volume_or_device,
            file_or_inode: directory.file_or_inode,
        });
    }
    #[cfg(unix)]
    {
        return stable_file_identity_from_metadata(
            &fs::metadata(path).map_err(|error| format!("无法读取文件 identity：{error}"))?,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| format!("无法绑定文件 identity：{error}"))?;
        return stable_file_identity_from_handle(file.as_raw_handle());
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = path;
        Err("当前平台不支持稳定文件 identity".into())
    }
}

#[cfg(windows)]
fn read_dev_file_bound(
    path: &std::path::Path,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<String, String> {
    use std::io::Read;
    use std::mem::MaybeUninit;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    let _ = expected_parent;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| format!("无法绑定读取句柄：{e}"))?;
    let actual_identity = stable_file_identity_from_handle(file.as_raw_handle())?;
    if actual_identity != *expected_identity {
        return Err("读取绑定文件 identity 已变化".into());
    }
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("无法读取绑定文件身份".to_string());
    }
    if unsafe { info.assume_init() }.number_of_links > 1 {
        return Err("拒绝读取 hardlink 目标（防 inode 逃逸）".to_string());
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("读取绑定文件失败：{e}"))?;
    Ok(content)
}

#[cfg(unix)]
fn read_dev_file_bound(
    path: &std::path::Path,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<String, String> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let mut file = open_unix_file_relative(
        path,
        libc::O_RDONLY,
        0,
        Some(expected_parent),
        Some(expected_identity),
    )?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取绑定文件身份：{e}"))?;
    let actual_identity = stable_file_identity_from_metadata(&metadata)?;
    if actual_identity != *expected_identity {
        return Err("读取绑定文件 identity 已变化".into());
    }
    if metadata.nlink() > 1 {
        return Err("拒绝读取 hardlink 目标（防 inode 逃逸）".to_string());
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("读取绑定文件失败：{e}"))?;
    Ok(content)
}

#[cfg(all(not(windows), not(unix)))]
fn read_dev_file_bound(
    path: &std::path::Path,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<String, String> {
    let _ = (path, expected_identity, expected_parent);
    Err("当前平台不支持 bound file identity read".into())
}

#[cfg(windows)]
fn write_dev_file_bound(
    path: &std::path::Path,
    content: &str,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    use std::io::Write;
    use std::mem::MaybeUninit;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    let _ = expected_parent;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| format!("无法绑定写入句柄：{e}"))?;
    let actual_identity = stable_file_identity_from_handle(file.as_raw_handle())?;
    if !file
        .metadata()
        .map_err(|error| format!("无法读取写入目标类型：{error}"))?
        .is_file()
    {
        return Err("拒绝写入非 regular file".into());
    }
    if actual_identity != *expected_identity {
        return Err("写入绑定文件 identity 已变化".into());
    }
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("无法读取绑定文件身份".to_string());
    }
    if unsafe { info.assume_init() }.number_of_links > 1 {
        return Err("拒绝写入 hardlink 目标（防 inode 逃逸）".to_string());
    }
    file.set_len(0)
        .map_err(|e| format!("无法截断绑定文件：{e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入绑定文件失败：{e}"))
}

#[cfg(unix)]
fn write_dev_file_bound(
    path: &std::path::Path,
    content: &str,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;
    let mut file = open_unix_file_relative(
        path,
        libc::O_WRONLY,
        0,
        Some(expected_parent),
        Some(expected_identity),
    )?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取绑定文件身份：{e}"))?;
    if !metadata.is_file() {
        return Err("拒绝写入非 regular file".into());
    }
    let actual_identity = stable_file_identity_from_metadata(&metadata)?;
    if actual_identity != *expected_identity {
        return Err("写入绑定文件 identity 已变化".into());
    }
    if metadata.nlink() > 1 {
        return Err("拒绝写入 hardlink 目标（防 inode 逃逸）".to_string());
    }
    file.set_len(0)
        .map_err(|e| format!("无法截断绑定文件：{e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入绑定文件失败：{e}"))
}

#[cfg(all(not(windows), not(unix)))]
fn write_dev_file_bound(
    path: &std::path::Path,
    content: &str,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    let _ = (path, content, expected_identity, expected_parent);
    Err("当前平台不支持 bound file identity write".into())
}

/// P1 审计修复：防符号链接绕过——
/// - 目标已存在 → `fs::canonicalize` 解析到真实路径（跟随 symlink）后**重新校验**仍在 worktree 内；
/// - 目标不存在 → 父目录已 canonicalize（真实目录），文件名不跨目录，用 O_EXCL 创建（不跟随已有符号链接）；
/// - 目标已存在且是 symlink → 直接拒绝（不写入链接目标）。
#[tauri::command]
fn dev_write_file(path: String, content: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_write_file")?;
    let _base_identity = assert_base_identity_current("dev_write_file")?;
    let p = std::path::Path::new(&path);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("dev_write_file: 路径禁止包含 '..' 逃逸：{path}"));
    }
    // 相对路径基于 base_repo 解析；新文件需先规范化父目录再拼接文件名
    let base_dir = {
        let state = DEV_STATE.lock().unwrap();
        state.base_repo.clone().unwrap_or_default()
    };
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::PathBuf::from(&base_dir).join(p)
    };
    let parent = joined.parent().unwrap_or_else(|| std::path::Path::new("."));
    let canon_parent = parent.canonicalize().map_err(|e| {
        format!(
            "dev_write_file: 无法解析父目录（{}）：{e}",
            parent.display()
        )
    })?;
    dev_path_allowed(&canon_parent)?;
    let expected_parent_identity = stable_file_identity(&canon_parent)?;
    let name = joined
        .file_name()
        .ok_or_else(|| "dev_write_file: 路径缺少文件名".to_string())?;
    let abs = canon_parent.join(name);

    // 目标已存在：先解析真实路径（跟随 symlink）并重新校验——防 worktree 内 symlink 指向外部
    if let Ok(meta) = fs::symlink_metadata(&abs) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "dev_write_file: 拒绝写入符号链接目标（防 symlink 逃逸）：{}",
                abs.display()
            ));
        }
        if !meta.is_file() {
            return Err(format!(
                "dev_write_file: 拒绝写入非 regular file：{}",
                abs.display()
            ));
        }
        if has_multiple_hardlinks(&abs)? {
            return Err(format!(
                "dev_write_file: 拒绝写入 hardlink 目标（防 inode 逃逸）：{}",
                abs.display()
            ));
        }
        let real = abs
            .canonicalize()
            .map_err(|e| format!("dev_write_file: 目标路径解析失败：{e}"))?;
        dev_path_allowed(&real)?;
        let expected_identity = stable_file_identity(&real)?;
        write_dev_file_bound(
            &real,
            &content,
            &expected_identity,
            &expected_parent_identity,
        )?;
        return Ok(());
    }

    // 目标不存在：父目录已 canonicalize（真实目录，无 symlink），文件名不跨目录；
    // 用 create_new（O_CREAT|O_EXCL）避免跟随并发创建的符号链接
    dev_path_allowed(&abs)?;
    #[cfg(unix)]
    {
        return create_unix_file_relative(&abs, &content, &expected_parent_identity)
            .map_err(|error| format!("dev_write_file: 创建失败：{path}（{error}）"));
    }
    #[cfg(not(unix))]
    {
        return fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&abs)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(content.as_bytes())
            })
            .map_err(|e| format!("dev_write_file: 创建失败：{path}（{e}）"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 自定义标题栏由 WebView 提供；窗口状态插件不能恢复旧的 native decorations，
        // 否则 decorations:false 会被历史状态里的 decorated:true 覆盖，出现两层标题栏。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            credentials::set_credential,
            credentials::get_credential,
            credentials::delete_credential,
            credentials::list_credentials,
            credentials::save_endpoint,
            credentials::load_endpoint,
            credentials::delete_endpoint,
            credentials::list_endpoints_raw,
            credentials::save_vault,
            credentials::list_vaults,
            credentials::load_vault_key,
            credentials::delete_vault,
            codex::codex_login_status,
            codex::codex_login,
            codex::codex_logout,
            codex::codex_exec,
            codex::codex_worker_prepare,
            codex::codex_worker_exec,
            codex::codex_worker_cancel,
            antigravity::antigravity_worker_exec,
            antigravity::antigravity_worker_cancel,
            event_store::event_lock_acquire,
            event_store::event_lock_release,
            run_git,
            grant_project_access,
            dev_exec,
            dev_init_session,
            dev_clear_session,
            dev_register_worktree,
            dev_restore_worktree,
            dev_register_orphan_worktree,
            dev_approve_cleanup,
            dev_cleanup_worktree,
            dev_unregister_worktree,
            dev_read_file,
            dev_create_dir,
            dev_write_file
        ])
        // 窗口默认可见（tauri.conf.json visible:true）。保留 on_page_load 作为兜底，
        // 万一某些环境初始未显示，页面加载完成后再确保 show 一次。
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                // 运行时再次关闭 native decorations，兼容旧的编译上下文/窗口状态缓存。
                let _ = win.set_decorations(false);
                let _ = win.show();
            }
            Ok(())
        })
        .on_page_load(|win, _payload| {
            // 页面初次加载完成即确保窗口可见（SPA 仅触发一次）
            let _ = win.window().set_decorations(false);
            let _ = win.show();
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 注意：Rust 侧不实现普通 LLM HTTP 调用（原 chat_completion 已移除，路线 A）。
// OpenAI/Anthropic/Ollama 请求仍由前端 provider（plugin-http）发起；Codex provider
// 仅在此处通过官方 CLI 受控调用，复用 Codex 自己的 ChatGPT 登录态，不把 token 返回前端。
// 路线 B 若启用后端执行引擎，将复用此处的密钥/文件能力，而非重新实现 HTTP 客户端。

/* ---------------- 检查点原子写入的底层行为验证（真实文件系统） ---------------- */
// 前端 saveCheckpoints（src/io/projectIO.ts）的原子替换核心是 tauri-plugin-fs 的
// `rename(tmp, target)`。插件命令是 Rust `std::fs::rename` 的薄封装，因此以下测试用
// `std::fs::rename` 在真实文件系统上验证：
//   1) 目标已存在时 rename 是否替换成功（Windows 上对应 MoveFileExW +
//      MOVEFILE_REPLACE_EXISTING）——这是「已有目标文件时 rename 是否替换成功」的直接证明；
//   2) 目标被独占锁定时 rename/remove 失败 → 保留 tmp（回退分支语义）。
#[cfg(test)]
mod fs_atomic_replace_tests {
    use std::fs;
    use std::path::PathBuf;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("slime_fs_atomic_{}_{}", name, std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rename_replaces_existing_target_file() {
        let dir = tmpdir("replace");
        let tmp = dir.join("checkpoints.json.tmp");
        let target = dir.join("checkpoints.json");
        fs::write(&tmp, "new-content").unwrap();
        fs::write(&target, "old-content").unwrap();
        // saveCheckpoints 的原子替换核心：rename 覆盖已存在目标
        fs::rename(&tmp, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new-content");
        assert!(!tmp.exists(), "tmp 应被 rename 消费");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_to_missing_target_succeeds() {
        let dir = tmpdir("missing");
        let tmp = dir.join("a.tmp");
        let target = dir.join("a.json");
        fs::write(&tmp, "x").unwrap();
        fs::rename(&tmp, &target).unwrap();
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_then_rename_fallback_works() {
        let dir = tmpdir("fallback");
        let tmp = dir.join("b.tmp");
        let target = dir.join("b.json");
        fs::write(&tmp, "new").unwrap();
        fs::write(&target, "old").unwrap();
        // saveCheckpoints 的第二次重试路径：先删旧目标再 rename
        fs::remove_file(&target).unwrap();
        fs::rename(&tmp, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_target_rename_fails_and_tmp_preserved() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tmpdir("locked");
        let tmp = dir.join("c.tmp");
        let target = dir.join("c.json");
        fs::write(&tmp, "new").unwrap();
        fs::write(&target, "old").unwrap();
        // 独占共享模式打开目标（share_mode=0：拒绝其它进程读写/删除）
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        // 1) 目标被锁时直接 rename 应失败
        assert!(
            fs::rename(&tmp, &target).is_err(),
            "锁定目标时 rename 应失败"
        );
        // 2) remove 被锁目标也应失败 → saveCheckpoints 走「保留 tmp」分支
        assert!(
            fs::remove_file(&target).is_err(),
            "锁定目标时 remove 应失败"
        );
        // 3) tmp 保留（内容完整，供下次覆盖）
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "new");
        drop(handle);
        let _ = fs::remove_dir_all(&dir);
    }
}

/* ---------------- 诊断：apiKey AES-GCM 加密往返（排除算法 bug / master key 漂移） ---------------- */
#[cfg(test)]
mod vault_crypto_roundtrip_tests {
    use crate::credentials::{base64_decode, base64_encode};

    #[test]
    fn base64_roundtrip() {
        let raw = b"sk-test-1234567890abcdef"; // 24 字节 → 32 字符
        let b64 = base64_encode(raw);
        assert_eq!(base64_decode(&b64).unwrap(), raw, "base64 往返应一致");
        assert_eq!(b64.len(), 32);
        // 另一组含奇数字节的输入
        let raw2 = b"hello world";
        let b64_2 = base64_encode(raw2);
        assert_eq!(base64_decode(&b64_2).unwrap(), raw2);
    }

    #[test]
    fn aes_gcm_roundtrip_same_key() {
        // 用固定 key 走加解密，确认算法配对（不依赖 master key 存储）
        let plain = "sk-test-deepseek-abcdefghijklmnopqrstuvwxyz";
        let key = aes_gcm::Aes256Gcm::new_from_slice(&[7u8; 32]).unwrap();
        use aes_gcm::aead::Aead;
        use aes_gcm::{KeyInit, Nonce};
        let mut nonce_bytes = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = key.encrypt(nonce, plain.as_bytes()).unwrap();
        let mut buf = nonce_bytes.to_vec();
        buf.extend_from_slice(&ct);
        let b64 = base64_encode(&buf);
        // 解密
        let bytes = base64_decode(&b64).unwrap();
        let (nonce_raw, ct_bytes) = bytes.split_at(12);
        let pt = key.decrypt(Nonce::from_slice(nonce_raw), ct_bytes).unwrap();
        assert_eq!(
            String::from_utf8(pt).unwrap(),
            plain,
            "AES-GCM 往返应还原明文"
        );
    }
}

/* ---------------- dev_exec 主仓库根权限边界（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_exec_tests;

/* ---------------- dev_write_file 符号链接逃逸（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_write_symlink_tests;
