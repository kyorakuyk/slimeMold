use crate::StableDirectoryIdentity;
use std::sync::{Mutex, MutexGuard};

/// H4 dev_exec 登记态：主仓库根 + 已登记 worktree。
pub(crate) static DEV_STATE: Mutex<DevState> = Mutex::new(DevState::new());
/// Serialize session changes and host operations so a project switch cannot race a checked command.
pub(crate) static DEV_OPERATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_dev_operation() -> MutexGuard<'static, ()> {
    DEV_OPERATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn next_session_generation(current: u64) -> u64 {
    current.wrapping_add(1).max(1)
}

pub(crate) fn base_repo_is_initialized() -> bool {
    DEV_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .base_repo
        .is_some()
}

pub(crate) fn snapshot_base_repo() -> Option<String> {
    DEV_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .base_repo
        .clone()
}

#[cfg(test)]
static DEV_STATE_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_dev_state_tests() -> MutexGuard<'static, ()> {
    DEV_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) struct DevState {
    pub(crate) generation: u64,
    pub(crate) base_repo: Option<String>,
    pub(crate) base_identity: Option<StableDirectoryIdentity>,
    pub(crate) worktrees: Vec<String>,
    pub(crate) registrations: Vec<RegisteredWorktree>,
    pub(crate) cleanup_bindings: Vec<CleanupBinding>,
    pub(crate) pending_worktrees: Vec<PendingWorktree>,
    pub(crate) orphan_worktrees: Vec<PendingWorktree>,
}

impl DevState {
    pub(crate) const fn new() -> Self {
        DevState {
            generation: 0,
            base_repo: None,
            base_identity: None,
            worktrees: Vec::new(),
            registrations: Vec::new(),
            cleanup_bindings: Vec::new(),
            pending_worktrees: Vec::new(),
            orphan_worktrees: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct RegisteredWorktree {
    pub(crate) generation: u64,
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) identity: StableDirectoryIdentity,
}

#[derive(Clone)]
pub(crate) struct CleanupBinding {
    pub(crate) token: String,
    pub(crate) generation: u64,
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) branch_revision: String,
    pub(crate) base_identity: StableDirectoryIdentity,
    pub(crate) target_identity: Option<StableDirectoryIdentity>,
    pub(crate) consumed: bool,
}

pub(crate) struct PendingWorktree {
    pub(crate) generation: u64,
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) identity: Option<StableDirectoryIdentity>,
    pub(crate) branch_revision: Option<String>,
    pub(crate) removed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionStamp {
    generation: u64,
    base_repo: String,
    base_identity: StableDirectoryIdentity,
}

impl SessionStamp {
    pub(crate) fn base_repo(&self) -> &str {
        &self.base_repo
    }

    pub(crate) fn base_identity(&self) -> &StableDirectoryIdentity {
        &self.base_identity
    }
}

pub(crate) fn snapshot_session_stamp(operation: &str) -> Result<SessionStamp, String> {
    let state = DEV_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let base_repo = state
        .base_repo
        .clone()
        .ok_or_else(|| format!("{operation}: 尚未初始化主仓库根"))?;
    let base_identity = state
        .base_identity
        .clone()
        .ok_or_else(|| format!("{operation}: 主仓库缺少 stable directory identity"))?;
    if state.generation == 0 {
        return Err(format!("{operation}: 缺少有效 session generation"));
    }
    Ok(SessionStamp {
        generation: state.generation,
        base_repo,
        base_identity,
    })
}

pub(crate) fn snapshot_session_stamp_for(
    expected_generation: u64,
    operation: &str,
) -> Result<SessionStamp, String> {
    if expected_generation == 0 {
        return Err(format!("{operation}: 缺少有效 session generation"));
    }
    let state = DEV_STATE.lock().unwrap();
    let has_base = state.base_repo.is_some();
    let has_identity = state.base_identity.is_some();
    let current_generation = state.generation;
    if !has_base || !has_identity || current_generation != expected_generation {
        return Err(format!(
            "{operation}: session generation 已失效（expected={expected_generation}, current={current_generation}）"
        ));
    }
    Ok(SessionStamp {
        generation: current_generation,
        base_repo: state.base_repo.clone().expect("checked above"),
        base_identity: state.base_identity.clone().expect("checked above"),
    })
}

pub(crate) fn assert_session_stamp_current(
    stamp: &SessionStamp,
    operation: &str,
) -> Result<(), String> {
    let state = DEV_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.generation != stamp.generation
        || state.base_repo.as_deref() != Some(stamp.base_repo.as_str())
        || state.base_identity.as_ref() != Some(&stamp.base_identity)
    {
        return Err(format!(
            "{operation}: 主仓库 session 在 identity 校验期间发生变化"
        ));
    }
    Ok(())
}
