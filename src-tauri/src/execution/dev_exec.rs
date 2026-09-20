//! Controlled development command execution authority.
//!
//! This module owns command admission, environment sanitization, launcher
//! resolution, Windows command handling, cwd fencing, and spawn orchestration.

use std::collections::HashMap;
use std::fs;
use std::process::{Child, Command};
use std::time::Duration;

use crate::dev_command_policy;
use crate::dev_state::{lock_dev_operation, DEV_STATE};
use crate::execution::process::{self, DevExecResult};
use crate::file_authority::{dev_exec_path_allowed, has_multiple_hardlinks};
#[cfg(unix)]
use crate::file_authority::{open_unix_file_relative, stable_file_identity_from_file};
use crate::fs_guard::{
    canonicalize_dev_exec_args, dev_arg_path_lexically_safe, dev_arg_shell_safe,
    dev_exec_validate_paths, git_diff_pathspec_allowed, is_git_diff_revision, path_compare_key,
};
use crate::session_authority::{
    assert_session_generation, dev_abs_of, dev_cwd_binding, DevCwdKind,
};
use crate::worktree_authority::{
    dev_main_repo_git_allowed_at, main_repo_worktree_add_spec,
    update_pending_worktree_after_success, worktree_add_target_is_safe,
};

pub(crate) fn apply_dev_env(command: &mut Command) {
    command.env_clear();
    for (key, value) in dev_sanitized_env() {
        command.env(key, value);
    }
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
pub(crate) fn resolve_dev_program_from_path(
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
pub(crate) fn resolve_dev_program_from_path(
    name: &str,
    _search_path: Option<&std::ffi::OsStr>,
) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
}

pub(crate) fn resolve_dev_program(name: &str) -> std::path::PathBuf {
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
pub(crate) fn dev_main_repo_git_allowed(args: &[String]) -> bool {
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

pub(crate) fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<DevExecResult, String> {
    process::run_with_timeout(cmd, timeout, kill_dev_child_tree)
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

/// 与前端 assertSafeGitRevision 对齐的 base revision 词法校验。
/// 这里只允许作为 git diff 的 revision 操作数，不允许路径逃逸或 shell 语义。
fn safe_git_revision_arg(arg: &str) -> bool {
    arg.len() <= 128 && is_git_diff_revision(arg)
}

/// worktree 内允许的命令参数白名单（与前端 capabilities DEFAULT_SHELL_RULES / DEFAULT_TEST_RULES
/// 对齐；P1 审计：Rust 侧也做完整参数校验，WebView 直调 dev_exec 无法执行白名单外的高风险操作）。
pub(crate) fn dev_worktree_cmd_allowed(args: &[String]) -> bool {
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
        "find" => dev_command_policy::command_intent_kind(args) == Some("find"),
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
pub(crate) fn dev_exec_allowed(kind: &DevCwdKind, args: &[String]) -> bool {
    dev_exec_allowed_at(kind, args, None)
}

pub(crate) fn dev_exec_allowed_at(
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
pub(crate) fn dev_exec(
    args: Vec<String>,
    cwd: String,
    generation: u64,
) -> Result<DevExecResult, String> {
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
