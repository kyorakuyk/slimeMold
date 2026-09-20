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

#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::{AppHandle, Manager};

mod antigravity;
mod authority;
mod codex;
mod execution;
mod fs_identity;
mod policy;
mod storage;

pub(crate) use authority::{
    file as file_authority, session as session_authority, state as dev_state,
    worktree as worktree_authority,
};
#[cfg(test)]
pub(crate) use cleanup_lineage_policy::{
    cleanup_binding_matches, orphan_target_is_deleted_candidate,
};
pub(crate) use dev_process::{spawn_output_reader, OutputReceiver, OutputThread};
use dev_state::{lock_dev_operation, next_session_generation, DEV_STATE};
#[cfg(test)]
use dev_state::{lock_dev_state_tests, DevState};
#[cfg(test)]
pub(crate) use dev_state::{CleanupBinding, PendingWorktree, RegisteredWorktree};
#[cfg(test)]
pub(crate) use execution::dev_exec::{
    dev_exec, dev_exec_allowed, dev_exec_allowed_at, dev_main_repo_git_allowed, dev_sanitized_env,
    dev_worktree_cmd_allowed, is_credential_env_name, is_safe_env_name, resolve_dev_program,
    resolve_dev_program_from_path,
};
pub(crate) use execution::process as dev_process;
#[cfg(test)]
pub(crate) use file_authority::{
    dev_create_dir, dev_write_file, stable_file_identity, write_dev_file_bound,
};
use fs_guard::path_compare_key;
#[cfg(test)]
pub(crate) use fs_guard::{
    dev_exec_validate_paths, dev_strip_verbatim, git_diff_pathspec_allowed, protected_relative_path,
};
pub(crate) use fs_identity::{stable_directory_identity, StableDirectoryIdentity};
pub(crate) use policy::{
    cleanup_lineage as cleanup_lineage_policy, command as dev_command_policy, fs_guard,
    git_worktree as git_worktree_policy, worktree as worktree_policy,
};
pub(crate) use storage::{credentials, endpoint_store, event_store};

pub(crate) use session_authority::{
    assert_base_identity_current, assert_registered_worktree, assert_session_generation,
    dev_abs_of, dev_base_repo, dev_cwd_binding,
};
#[cfg(test)]
pub(crate) use session_authority::{dev_cwd_kind, DevCwdKind};
#[cfg(test)]
pub(crate) use worktree_authority::{
    cleanup_target_identity_is_current, dev_main_repo_git_allowed_at, dev_register_worktree,
    dev_unregister_worktree, main_repo_worktree_args_are_valid, record_pending_worktree_add,
    registered_worktree_identity_conflicts, registered_worktree_identity_matches, worker_root_path,
    worker_target_is_safe_for_existing_operation, worktree_add_target_is_safe,
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

fn legacy_git_invocation_args(args: &[String]) -> Option<Vec<String>> {
    if !run_git_readonly_args(args) {
        return None;
    }
    let mut hardened = vec!["--no-pager".to_string()];
    if args.first().map(String::as_str) == Some("diff") {
        hardened.extend([
            "diff".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
        ]);
        hardened.extend(args.iter().skip(1).cloned());
    } else {
        hardened.extend(args.iter().cloned());
    }
    Some(hardened)
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

    let invocation_args = legacy_git_invocation_args(&args).ok_or_else(|| {
        "run_git: legacy 命令只允许只读 Git probe；worktree 生命周期必须走 H4 WorktreeManager/dev_exec".to_string()
    })?;
    let mut probe = Command::new(execution::dev_exec::resolve_dev_program("git"));
    probe
        .arg("-C")
        .arg(&canon)
        .args(["rev-parse", "--show-toplevel"]);
    execution::dev_exec::apply_dev_env(&mut probe);
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

    let mut cmd = Command::new(execution::dev_exec::resolve_dev_program("git"));
    cmd.current_dir(&canon)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    execution::dev_exec::apply_dev_env(&mut cmd);
    for argument in invocation_args {
        cmd.arg(argument);
    }
    let output =
        execution::dev_exec::run_with_timeout(&mut cmd, std::time::Duration::from_secs(30))?;
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

fn git_top_level(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut cmd = Command::new(execution::dev_exec::resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    execution::dev_exec::apply_dev_env(&mut cmd);
    let result = execution::dev_exec::run_with_timeout(&mut cmd, Duration::from_secs(5))?;
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
            endpoint_store::save_endpoint,
            endpoint_store::load_endpoint,
            endpoint_store::delete_endpoint,
            endpoint_store::list_endpoints_raw,
            endpoint_store::save_vault,
            endpoint_store::list_vaults,
            endpoint_store::load_vault_key,
            endpoint_store::delete_vault,
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
            execution::dev_exec::dev_exec,
            dev_init_session,
            dev_clear_session,
            worktree_authority::dev_register_worktree,
            worktree_authority::dev_restore_worktree,
            worktree_authority::dev_register_orphan_worktree,
            worktree_authority::dev_approve_cleanup,
            worktree_authority::dev_cleanup_worktree,
            worktree_authority::dev_unregister_worktree,
            file_authority::dev_read_file,
            file_authority::dev_create_dir,
            file_authority::dev_write_file
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

/* ---------------- dev_exec 主仓库根权限边界（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_exec_tests;

/* ---------------- dev_write_file 符号链接逃逸（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_write_symlink_tests;
