use super::codex_cleanup::{ChildHandle, CodexCleanupHandle};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

pub(crate) struct ActiveChild {
    pub(crate) session_generation: u64,
    pub(crate) pending_generation: u64,
    pub(crate) handle: ChildHandle,
    pub(crate) cleanup: CodexCleanupHandle,
}

static ACTIVE_CODEX_CHILDREN: OnceLock<Mutex<HashMap<String, ActiveChild>>> = OnceLock::new();

pub(crate) fn active_codex_children() -> &'static Mutex<HashMap<String, ActiveChild>> {
    ACTIVE_CODEX_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
pub(crate) struct PreparedLease {
    pub(crate) session_generation: u64,
    pub(crate) cwd: PathBuf,
    pub(crate) identity: crate::StableDirectoryIdentity,
    pub(crate) created_at: Instant,
    pub(crate) cancellation_requested: bool,
}

static PREPARED_CODEX_LEASES: OnceLock<Mutex<HashMap<String, PreparedLease>>> = OnceLock::new();

pub(crate) fn prepared_codex_leases() -> &'static Mutex<HashMap<String, PreparedLease>> {
    PREPARED_CODEX_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn clear_prepared_codex_leases() -> Result<(), String> {
    prepared_codex_leases()
        .lock()
        .map_err(|_| "Codex prepared lease registry 已损坏".to_string())?
        .clear();
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct PendingOperation {
    pub(crate) generation: u64,
    pub(crate) session_generation: u64,
    pub(crate) cancellation_requested: bool,
}

static PENDING_CODEX_OPERATIONS: OnceLock<Mutex<HashMap<String, PendingOperation>>> =
    OnceLock::new();
pub(crate) static CODEX_OPERATION_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn pending_codex_operations() -> &'static Mutex<HashMap<String, PendingOperation>> {
    PENDING_CODEX_OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn begin_pending_operation(
    operation_id: &str,
    session_generation: u64,
) -> Result<u64, String> {
    let mut pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏".to_string())?;
    if pending.contains_key(operation_id) {
        return Err("Codex operation id 已在使用".into());
    }
    let generation = CODEX_OPERATION_GENERATION.fetch_add(1, Ordering::Relaxed);
    pending.insert(
        operation_id.to_string(),
        PendingOperation {
            generation,
            session_generation,
            cancellation_requested: false,
        },
    );
    Ok(generation)
}

pub(crate) fn finish_pending_operation(
    operation_id: &str,
    generation: u64,
) -> Result<bool, String> {
    let active = active_codex_children()
        .lock()
        .map_err(|_| "Codex operation registry 已损坏；side effects unknown".to_string())?;
    let mut pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
    let entry = pending
        .get(operation_id)
        .ok_or_else(|| "Codex pending lease已丢失；side effects unknown".to_string())?;
    if entry.generation != generation {
        return Err("Codex pending lease generation不匹配；side effects unknown".into());
    }
    if active
        .get(operation_id)
        .is_some_and(|active| active.pending_generation == generation)
    {
        return Err(
            "Codex active recovery仍保留；pending lease不可finalize；side effects unknown".into(),
        );
    }
    let cancelled = entry.cancellation_requested;
    pending.remove(operation_id);
    Ok(cancelled)
}

pub(crate) fn take_cancelled_operation(operation_id: &str) -> Result<bool, String> {
    let pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
    Ok(pending
        .get(operation_id)
        .is_some_and(|entry| entry.cancellation_requested))
}

pub(crate) fn validate_operation_binding(
    operation_id: Option<&str>,
    session_generation: Option<u64>,
    pending_generation: Option<u64>,
) -> Result<(), String> {
    match (operation_id, session_generation, pending_generation) {
        (None, None, None) => Ok(()),
        (Some(operation_id), Some(generation), Some(_)) => {
            if !valid_operation_id(operation_id) {
                return Err("Codex operation id 非法".into());
            }
            if generation == 0 {
                return Err("Codex Worker session generation 无效".into());
            }
            Ok(())
        }
        (Some(_), None, _) => Err("Codex operation id 缺少session generation".into()),
        (Some(_), Some(_), None) => Err("Codex operation id 缺少pending generation".into()),
        (None, Some(_), _) => Err("Codex session generation 缺少operation id".into()),
        (None, None, Some(_)) => Err("Codex pending generation 缺少operation id".into()),
    }
}

pub(crate) struct CodexSpawnReservation {
    active: MutexGuard<'static, HashMap<String, ActiveChild>>,
    pending: MutexGuard<'static, HashMap<String, PendingOperation>>,
    operation_id: String,
    session_generation: u64,
    pending_generation: u64,
}

impl CodexSpawnReservation {
    pub(crate) fn register_child(
        &mut self,
        handle: ChildHandle,
        cleanup: CodexCleanupHandle,
    ) -> Result<(), String> {
        let entry = self.pending.get(&self.operation_id).ok_or_else(|| {
            "Codex pending lease在child注册前丢失；side effects unknown".to_string()
        })?;
        if entry.session_generation != self.session_generation
            || entry.generation != self.pending_generation
        {
            return Err(
                "Codex pending lease在child注册前发生generation漂移；side effects unknown".into(),
            );
        }
        if entry.cancellation_requested {
            return Err("Codex Worker 在child注册前已取消".into());
        }
        if self.active.contains_key(&self.operation_id) {
            return Err("Codex operation token在child注册前已被占用".into());
        }
        self.active.insert(
            self.operation_id.clone(),
            ActiveChild {
                session_generation: self.session_generation,
                pending_generation: self.pending_generation,
                handle,
                cleanup,
            },
        );
        Ok(())
    }

    pub(crate) fn retain_child_for_recovery(
        &mut self,
        handle: ChildHandle,
        cleanup: CodexCleanupHandle,
    ) {
        self.active.insert(
            self.operation_id.clone(),
            ActiveChild {
                session_generation: self.session_generation,
                pending_generation: self.pending_generation,
                handle,
                cleanup,
            },
        );
    }
}

pub(crate) fn reserve_codex_operation(
    operation_id: &str,
    session_generation: u64,
    pending_generation: u64,
) -> Result<CodexSpawnReservation, String> {
    // Lock-order invariant: every path that holds both registries acquires active first, then pending.
    // Cancellation uses the same order so it cannot consume pending state around spawn registration.
    let active = active_codex_children()
        .lock()
        .map_err(|_| "Codex operation registry 已损坏；side effects unknown".to_string())?;
    let pending = pending_codex_operations()
        .lock()
        .map_err(|_| "Codex pending registry 已损坏；side effects unknown".to_string())?;
    let entry = pending
        .get(operation_id)
        .ok_or_else(|| "Codex pending lease已丢失；side effects unknown".to_string())?;
    if entry.session_generation != session_generation {
        return Err("Codex pending lease session generation不匹配；side effects unknown".into());
    }
    if entry.generation != pending_generation {
        return Err("Codex pending lease generation不匹配；side effects unknown".into());
    }
    if entry.cancellation_requested || active.contains_key(operation_id) {
        return Err("Codex Worker 已取消或operation token已在使用".into());
    }
    Ok(CodexSpawnReservation {
        active,
        pending,
        operation_id: operation_id.to_string(),
        session_generation,
        pending_generation,
    })
}

pub(crate) fn valid_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= 128
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}
