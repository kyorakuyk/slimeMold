use super::StableDirectoryIdentity;
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
