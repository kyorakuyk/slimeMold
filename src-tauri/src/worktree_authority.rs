//! Worktree lifecycle authority seams.
//!
//! This module is the sole home for worktree target admission, registration
//! identity predicates, and pending rollback lease bookkeeping.

use std::fs;

use rand::RngCore;

use super::{dev_main_repo_git_allowed, git_branch_revision};
use crate::dev_state::{PendingWorktree, RegisteredWorktree, DEV_STATE};
use crate::fs_guard::{path_compare_key, path_is_same_or_child};
use crate::fs_identity::{stable_directory_identity, StableDirectoryIdentity};
use crate::worktree_policy::{
    is_full_object_id, worker_branch_from_ref_arg, worker_branch_from_tip_arg,
    worker_branch_is_valid, worker_name_is_valid,
};

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
