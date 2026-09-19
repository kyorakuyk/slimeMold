//! Worktree lifecycle authority seams.
//!
//! This module is the sole home for worktree target admission, registration
//! identity predicates, and pending rollback lease bookkeeping.

use std::fs;
use std::process::Command;
use std::time::Duration;

use rand::RngCore;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::cleanup_lineage_policy::{cleanup_binding_matches, orphan_target_is_deleted_candidate};
use crate::dev_state::{
    lock_dev_operation, CleanupBinding, PendingWorktree, RegisteredWorktree, DEV_STATE,
};
use crate::fs_guard::{path_compare_key, path_is_same_or_child};
use crate::fs_identity::{stable_directory_identity, StableDirectoryIdentity};
use crate::git_worktree_policy::validate_git_worktree_porcelain;
use crate::worktree_policy::{
    is_full_object_id, worker_branch_from_ref_arg, worker_branch_from_tip_arg,
    worker_branch_is_valid, worker_name_is_valid,
};
use crate::{
    apply_dev_env, dev_main_repo_git_allowed, dev_sanitized_env, resolve_dev_program,
    run_with_timeout,
};
use crate::{assert_session_generation, dev_abs_of};

pub(crate) fn registered_worktree_identity_matches(
    registered: &RegisteredWorktree,
    generation: u64,
    path: &str,
    branch: &str,
) -> bool {
    registered.generation == generation
        && registered.branch == branch
        && path_compare_key(&registered.path) == path_compare_key(path)
}

pub(crate) fn registered_worktree_identity_conflicts(
    registrations: &[RegisteredWorktree],
    generation: u64,
    path: &str,
    branch: &str,
    identity: &StableDirectoryIdentity,
) -> bool {
    registrations.iter().any(|registered| {
        registered_worktree_identity_matches(registered, generation, path, branch)
            && registered.identity != *identity
    })
}

pub(crate) fn new_cleanup_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn invalidate_cleanup_binding(token: &str) {
    let mut state = DEV_STATE.lock().unwrap();
    if let Some(binding) = state
        .cleanup_bindings
        .iter_mut()
        .find(|binding| binding.token == token)
    {
        binding.consumed = true;
    }
}

pub(crate) fn cleanup_probe_or_invalidate<T>(
    token: &str,
    result: Result<T, String>,
) -> Result<T, String> {
    result.map_err(|error| {
        invalidate_cleanup_binding(token);
        error
    })
}

pub(crate) fn cleanup_identity_guard<F>(
    token: &str,
    base_result: Result<StableDirectoryIdentity, String>,
    expected_base: &StableDirectoryIdentity,
    phase_error: &str,
    target_probe: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<bool, String>,
{
    let current_base = cleanup_probe_or_invalidate(token, base_result)?;
    if current_base != *expected_base {
        invalidate_cleanup_binding(token);
        return Err(phase_error.to_string());
    }
    let target_is_current = cleanup_probe_or_invalidate(token, target_probe())?;
    if !target_is_current {
        invalidate_cleanup_binding(token);
        return Err(phase_error.to_string());
    }
    Ok(())
}

pub(crate) fn worker_target_is_valid(repo: &std::path::Path, raw_path: &str) -> bool {
    if raw_path.is_empty() {
        return false;
    }
    let raw = std::path::Path::new(raw_path);
    if raw
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return false;
    }
    let target = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        repo.join(raw)
    };
    let Some(parent) = target.parent() else {
        return false;
    };
    let Some(name) = target.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let worker_root = std::path::PathBuf::from(format!("{}-workers", repo.to_string_lossy()));
    path_compare_key(&parent.to_string_lossy()) == path_compare_key(&worker_root.to_string_lossy())
        && worker_name_is_valid(name)
}

pub(crate) fn worker_target_is_safe_for_existing_operation(
    repo: &std::path::Path,
    raw_path: &str,
) -> bool {
    if !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let target = repo_target_path(repo, raw_path);
    let worker_root = worker_root_path(repo);
    let Ok(real_root) = worker_root.canonicalize() else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(&target) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return false;
    }
    let Ok(real_target) = target.canonicalize() else {
        return false;
    };
    path_compare_key(&real_target.to_string_lossy()) == path_compare_key(&target.to_string_lossy())
        && path_is_same_or_child(&real_target, &real_root)
}

pub(crate) fn main_repo_worktree_target_is_valid(
    repo: &std::path::Path,
    raw_path: &str,
    branch: &str,
) -> bool {
    if !worker_branch_is_valid(branch) || !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let name = std::path::Path::new(raw_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    branch.strip_prefix("worker/") == Some(name)
}

pub(crate) fn main_repo_worktree_args_are_valid(repo: &std::path::Path, args: &[String]) -> bool {
    if args.first().map(|value| value.as_str()) != Some("git")
        || args.get(1).map(|value| value.as_str()) != Some("worktree")
    {
        return false;
    }
    match args.get(2).map(|value| value.as_str()) {
        Some("add")
            if args.len() == 8 && args[3] == "-q" && args[5] == "-b" && args[7] == "HEAD" =>
        {
            main_repo_worktree_target_is_valid(repo, &args[4], &args[6])
        }
        Some("add") if args.len() == 7 && args[4] == "-b" && args[6] == "HEAD" => {
            main_repo_worktree_target_is_valid(repo, &args[3], &args[5])
        }
        Some("add") if args.len() == 6 && args[3] == "-q" => {
            main_repo_worktree_target_is_valid(repo, &args[4], &args[5])
        }
        Some("remove") if args.len() == 5 && args[3] == "--force" => {
            worker_target_is_safe_for_existing_operation(repo, &args[4])
        }
        Some("lock") | Some("unlock") if args.len() == 4 => {
            worker_target_is_safe_for_existing_operation(repo, &args[3])
        }
        _ => false,
    }
}

pub(crate) fn main_repo_worktree_add_spec(args: &[String]) -> Option<(&str, &str)> {
    if args.first().map(|value| value.as_str()) != Some("git")
        || args.get(1).map(|value| value.as_str()) != Some("worktree")
        || args.get(2).map(|value| value.as_str()) != Some("add")
    {
        return None;
    }
    if args.len() == 8 && args[3] == "-q" && args[5] == "-b" && args[7] == "HEAD" {
        return Some((&args[4], &args[6]));
    }
    if args.len() == 7 && args[4] == "-b" && args[6] == "HEAD" {
        return Some((&args[3], &args[5]));
    }
    if args.len() == 6 && args[3] == "-q" {
        return Some((&args[4], &args[5]));
    }
    None
}

pub(crate) fn repo_target_path(repo: &std::path::Path, raw_path: &str) -> std::path::PathBuf {
    let raw = std::path::Path::new(raw_path);
    if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        repo.join(raw)
    }
}

pub(crate) fn worker_root_path(repo: &std::path::Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}-workers", repo.to_string_lossy()))
}

pub(crate) struct WorktreeAddRootGuard {
    #[cfg(windows)]
    _root: fs::File,
}

pub(crate) fn hold_worktree_add_root(
    root: &std::path::Path,
) -> Result<WorktreeAddRootGuard, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        const FILE_SHARE_WRITE: u32 = 0x00000002;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(root)
            .map_err(|error| {
                format!(
                    "dev_exec: 无法锁定 Worker root：{}（{error}）",
                    root.display()
                )
            })?;
        return Ok(WorktreeAddRootGuard { _root: file });
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Ok(WorktreeAddRootGuard {})
    }
}

/// Check the real worker root immediately before `git worktree add`.
/// A lexical parent check alone can follow a pre-existing symlink/junction out of the project.
pub(crate) fn worktree_add_target_is_safe(
    repo: &std::path::Path,
    raw_path: &str,
    branch: &str,
) -> Result<WorktreeAddRootGuard, String> {
    if !main_repo_worktree_target_is_valid(repo, raw_path, branch) {
        return Err("dev_exec: worktree add 的路径/分支不合法".to_string());
    }
    let worker_root = worker_root_path(repo);
    let worker_root_key = path_compare_key(&worker_root.to_string_lossy());
    let worker_parent = worker_root
        .parent()
        .ok_or_else(|| "dev_exec: Worker root 缺少父目录".to_string())?;
    let real_worker_parent = worker_parent.canonicalize().map_err(|error| {
        format!(
            "dev_exec: Worker root 父目录无法 canonicalize：{}（{error}）",
            worker_parent.display()
        )
    })?;
    if path_compare_key(&real_worker_parent.to_string_lossy())
        != path_compare_key(&worker_parent.to_string_lossy())
    {
        return Err("dev_exec: Worker root 父目录 realpath 不匹配".to_string());
    }

    match fs::symlink_metadata(&worker_root) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(format!(
                    "dev_exec: Worker root 不是目录，拒绝 worktree add：{}",
                    worker_root.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&worker_root).map_err(|create_error| {
                format!(
                    "dev_exec: 无法创建 Worker root：{}（{create_error}）",
                    worker_root.display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "dev_exec: 无法安全检查 Worker root：{}（{error}）",
                worker_root.display()
            ));
        }
    }

    let real_root = worker_root.canonicalize().map_err(|error| {
        format!(
            "dev_exec: Worker root 无法 canonicalize，拒绝 worktree add：{}（{error}）",
            worker_root.display()
        )
    })?;
    if !real_root.is_dir() {
        return Err(format!(
            "dev_exec: Worker root 不是目录，拒绝 worktree add：{}",
            worker_root.display()
        ));
    }
    if path_compare_key(&real_root.to_string_lossy()) != worker_root_key {
        return Err(format!(
            "dev_exec: Worker root 是 symlink/junction，拒绝 worktree add：{}",
            worker_root.display()
        ));
    }

    let target = repo_target_path(repo, raw_path);
    let parent = target
        .parent()
        .ok_or_else(|| "dev_exec: worktree target 缺少父目录".to_string())?;
    let real_parent = parent.canonicalize().map_err(|error| {
        format!(
            "dev_exec: worktree target 父目录无法 canonicalize：{}（{error}）",
            parent.display()
        )
    })?;
    if path_compare_key(&real_parent.to_string_lossy())
        != path_compare_key(&real_root.to_string_lossy())
    {
        return Err("dev_exec: worktree target 父目录 realpath 不匹配 Worker root".to_string());
    }
    match fs::symlink_metadata(&target) {
        Ok(_) => Err(format!(
            "dev_exec: worktree target 已存在，拒绝覆盖或跟随链接：{}",
            target.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(hold_worktree_add_root(&worker_root)?)
        }
        Err(error) => Err(format!(
            "dev_exec: 无法安全检查 worktree target：{}（{error}）",
            target.display()
        )),
    }
}

/// A successful add owns a short-lived rollback lease until registration completes.
/// It is intentionally narrower than the normal registered-worktree gate.
pub(crate) fn pending_worker_target(repo: &std::path::Path, raw_path: &str) -> bool {
    if !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let target = repo_target_path(repo, raw_path);
    let state = DEV_STATE.lock().unwrap();
    let Some(pending) = state.pending_worktrees.iter().find(|pending| {
        pending.generation == state.generation
            && !pending.removed
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
    }) else {
        return false;
    };
    let Some(expected_identity) = &pending.identity else {
        return false;
    };
    stable_directory_identity(&target).is_ok_and(|current| current == *expected_identity)
}

pub(crate) fn pending_worker_branch(
    repo: &std::path::Path,
    branch: &str,
    expected_revision: &str,
) -> bool {
    let Some(name) = branch.strip_prefix("worker/") else {
        return false;
    };
    if !worker_name_is_valid(name) {
        return false;
    }
    let target = std::path::PathBuf::from(format!("{}-workers/{name}", repo.to_string_lossy()));
    let state = DEV_STATE.lock().unwrap();
    state.pending_worktrees.iter().any(|pending| {
        pending.generation == state.generation
            && pending.removed
            && pending.branch == branch
            && pending.branch_revision.as_deref() == Some(expected_revision)
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
    })
}

pub(crate) fn record_pending_worktree_add(repo: &std::path::Path, raw_path: &str, branch: &str) {
    if !main_repo_worktree_target_is_valid(repo, raw_path, branch) {
        return;
    }
    let target = repo_target_path(repo, raw_path);
    let stored_path = target
        .canonicalize()
        .unwrap_or(target)
        .to_string_lossy()
        .to_string();
    let target_identity = stable_directory_identity(std::path::Path::new(&stored_path)).ok();
    let branch_revision = git_branch_revision(repo, branch).ok();
    let mut state = DEV_STATE.lock().unwrap();
    if state
        .base_repo
        .as_deref()
        .is_none_or(|base| path_compare_key(base) != path_compare_key(&repo.to_string_lossy()))
    {
        return;
    }
    if !state.pending_worktrees.iter().any(|pending| {
        path_compare_key(&pending.path) == path_compare_key(&stored_path)
            && pending.branch == branch
    }) {
        let generation = state.generation;
        state.pending_worktrees.push(PendingWorktree {
            generation,
            path: stored_path,
            branch: branch.to_string(),
            identity: target_identity,
            branch_revision,
            removed: false,
        });
    }
}

pub(crate) fn update_pending_worktree_after_success(repo: &std::path::Path, args: &[String]) {
    if let Some((raw_path, branch)) = main_repo_worktree_add_spec(args) {
        record_pending_worktree_add(repo, raw_path, branch);
        return;
    }
    if args.len() == 5
        && args[0] == "git"
        && args[1] == "worktree"
        && args[2] == "remove"
        && args[3] == "--force"
    {
        let target = repo_target_path(repo, &args[4]);
        let mut state = DEV_STATE.lock().unwrap();
        if let Some(pending) = state.pending_worktrees.iter_mut().find(|pending| {
            path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
        }) {
            pending.removed = true;
        }
        return;
    }
    if args.len() == 5 && args[0] == "git" && args[1] == "update-ref" && args[2] == "-d" {
        if let Some(branch) = worker_branch_from_ref_arg(&args[3]) {
            let mut state = DEV_STATE.lock().unwrap();
            state
                .pending_worktrees
                .retain(|pending| pending.branch != branch);
        }
    }
}

pub(crate) fn registered_worker_target(repo: &std::path::Path, raw_path: &str) -> bool {
    if !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let target = if std::path::Path::new(raw_path).is_absolute() {
        std::path::PathBuf::from(raw_path)
    } else {
        repo.join(raw_path)
    };
    let state = DEV_STATE.lock().unwrap();
    state
        .worktrees
        .iter()
        .any(|path| path_compare_key(path) == path_compare_key(&target.to_string_lossy()))
}

pub(crate) fn dev_main_repo_git_allowed_at(
    args: &[String],
    repo: Option<&std::path::Path>,
) -> bool {
    if args.first().map(|value| value.as_str()) == Some("git")
        && matches!(args.get(1).map(|value| value.as_str()), Some("worktree"))
        && matches!(
            args.get(2).map(|value| value.as_str()),
            Some("add") | Some("remove") | Some("lock") | Some("unlock")
        )
    {
        return repo.is_some_and(|path| {
            if !main_repo_worktree_args_are_valid(path, args) {
                return false;
            }
            match args[2].as_str() {
                "add" => true,
                "remove" => args
                    .last()
                    .is_some_and(|target| pending_worker_target(path, target)),
                "lock" | "unlock" => args
                    .last()
                    .is_some_and(|target| registered_worker_target(path, target)),
                _ => false,
            }
        });
    }
    if args.first().map(|value| value.as_str()) == Some("git")
        && args.len() == 5
        && args[1] == "rev-parse"
        && args[2] == "--verify"
        && args[3] == "--end-of-options"
    {
        let Some(branch) = worker_branch_from_tip_arg(&args[4]) else {
            return false;
        };
        return repo.is_some_and(|_path| {
            // Branch-tip lookup is read-only and is needed after a process restart,
            // when the live worktree has no current-host pending lease yet.
            worker_branch_is_valid(branch)
        });
    }
    if args.first().map(|value| value.as_str()) == Some("git")
        && args.len() == 5
        && args[1] == "update-ref"
        && args[2] == "-d"
    {
        return repo.is_some_and(|path| {
            let Some(branch) = worker_branch_from_ref_arg(&args[3]) else {
                return false;
            };
            is_full_object_id(&args[4]) && pending_worker_branch(path, branch, &args[4])
        });
    }
    dev_main_repo_git_allowed(args)
}
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

/// 登记一个 worktree（前端 dev.worktree.create 成功后调用；支持相对路径基于主仓库根解析）。
#[tauri::command]
pub(crate) fn dev_register_worktree(path: String, generation: u64) -> Result<(), String> {
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
pub(crate) fn dev_restore_worktree(
    path: String,
    branch: String,
    generation: u64,
) -> Result<(), String> {
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

fn orphan_records_for_path<'a>(
    records: &'a [PendingWorktree],
    path: &str,
) -> Vec<&'a PendingWorktree> {
    records
        .iter()
        .filter(|item| path_compare_key(&item.path) == path_compare_key(path))
        .collect()
}

fn exact_orphan_record_matches(
    record: &PendingWorktree,
    generation: u64,
    branch: &str,
    branch_revision: &str,
) -> bool {
    record.generation == generation
        && record.branch == branch
        && record.branch_revision.as_deref() == Some(branch_revision)
        && record.removed
}

#[tauri::command]
pub(crate) fn dev_register_orphan_worktree(
    path: String,
    branch: String,
    branch_revision: String,
    generation: u64,
) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_register_orphan_worktree")?;
    if !is_full_object_id(&branch_revision) || !worker_branch_is_valid(&branch) {
        return Err("dev_register_orphan_worktree: branch 或 revision 无效".into());
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
    let current_branch_revision = if branch_exists {
        Some(git_branch_revision(&base_path, &branch)?)
    } else {
        None
    };
    let target_is_scoped = main_repo_worktree_target_is_valid(&base_path, &c, &branch);
    let target_exists = target_metadata.is_some();
    if current_branch_revision.as_deref() != Some(branch_revision.as_str()) {
        return Err(
            "dev_register_orphan_worktree: branch revision 已变化或无法证明 lineage".into(),
        );
    }
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
    let existing = orphan_records_for_path(&state.orphan_worktrees, &c);
    if !existing.is_empty() {
        if existing.len() != 1
            || !exact_orphan_record_matches(existing[0], generation, &branch, &branch_revision)
        {
            return Err("dev_register_orphan_worktree: duplicate orphan lineage conflict".into());
        }
        return Ok(());
    }
    state.orphan_worktrees.push(PendingWorktree {
        generation,
        path: c,
        branch,
        identity: None,
        branch_revision: current_branch_revision,
        removed: true,
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn dev_approve_cleanup(
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
        let orphan_records = orphan_records_for_path(&state.orphan_worktrees, &c);
        let orphan = !orphan_records.is_empty();
        let orphan_lineage_matches = orphan_records.len() == 1
            && exact_orphan_record_matches(
                orphan_records[0],
                generation,
                &branch,
                &branch_revision,
            );
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
            if !orphan_lineage_matches {
                return Err(
                    "dev_approve_cleanup: orphan branch lineage 缺失、重复或与 native lineage 不匹配"
                        .into(),
                );
            }
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
pub(crate) fn cleanup_target_identity_is_current(
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
pub(crate) fn dev_cleanup_worktree(
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
        let orphan_records = orphan_records_for_path(&state.orphan_worktrees, &c);
        let orphan = !orphan_records.is_empty();
        let orphan_lineage_matches = orphan_records.len() == 1
            && exact_orphan_record_matches(
                orphan_records[0],
                generation,
                &branch,
                &branch_revision,
            );
        match (&capability.target_identity, registered_identity, orphan) {
            (Some(expected), Some(current), false) if expected == &current => {}
            (None, None, true) if orphan_lineage_matches => {}
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
    let target_identity_is_current = cleanup_probe_or_invalidate(
        &approval_token,
        cleanup_target_identity_is_current(
            &base_path,
            &canon,
            &branch,
            expected_target_identity.as_ref(),
        ),
    )?;
    if !target_identity_is_current {
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
    cleanup_identity_guard(
        &approval_token,
        stable_directory_identity(&base_path),
        &base_identity,
        "dev_cleanup_worktree: branch CAS 前 identity 已漂移",
        || {
            cleanup_target_identity_is_current(
                &base_path,
                &canon,
                &branch,
                expected_target_identity.as_ref(),
            )
        },
    )?;
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
    cleanup_identity_guard(
        &approval_token,
        stable_directory_identity(&base_path),
        &base_identity,
        "dev_cleanup_worktree: branch CAS 后 identity 漂移，结果必须按 unknown 处理",
        || {
            cleanup_target_identity_is_current(
                &base_path,
                &canon,
                &branch,
                expected_target_identity.as_ref(),
            )
        },
    )?;
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
        cleanup_identity_guard(
            &approval_token,
            stable_directory_identity(&base_path),
            &base_identity,
            "dev_cleanup_worktree: worktree remove 前 identity 已漂移",
            || {
                cleanup_target_identity_is_current(
                    &base_path,
                    &canon,
                    &branch,
                    expected_target_identity.as_ref(),
                )
            },
        )?;
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
    let base_identity_after_cleanup =
        cleanup_probe_or_invalidate(&approval_token, stable_directory_identity(&base_path))?;
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || base_identity_after_cleanup != base_identity
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
pub(crate) fn dev_unregister_worktree(path: String, generation: u64) -> Result<(), String> {
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
