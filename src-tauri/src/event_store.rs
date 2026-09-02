//! Project event-stream lock owned by the Tauri host.
//!
//! The WebView must not implement a cross-process lock with a JavaScript map.
//! A lock file created with `create_new` is exclusive across processes; a
//! timeout is fail-closed and leaves the lock for an explicit repair action.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(10);
const EVENT_LOCK_RELATIVE_PATH: &str = ".slimemold/events/events.jsonl.lock";

struct HeldLock {
    token: String,
    _file: File,
}

static HELD_LOCKS: OnceLock<Mutex<HashMap<String, HeldLock>>> = OnceLock::new();
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn held_locks() -> &'static Mutex<HashMap<String, HeldLock>> {
    HELD_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_path_for_root(
    raw_root: &str,
    raw_relative_path: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let raw = raw_root.trim();
    if raw.is_empty() {
        return Err("event_lock: 项目根目录不能为空".into());
    }
    if Path::new(raw)
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(format!("event_lock: 项目根目录禁止包含 '..'：{raw}"));
    }

    let root = Path::new(raw)
        .canonicalize()
        .map_err(|e| format!("event_lock: 项目根目录解析失败：{raw}（{e}）"))?;
    if !root.is_dir() {
        return Err(format!("event_lock: 项目根目录不是目录：{raw}"));
    }

    let relative_path = raw_relative_path.unwrap_or(EVENT_LOCK_RELATIVE_PATH).trim();
    let normalized_relative_path = relative_path.replace('\\', "/");
    let relative = Path::new(&normalized_relative_path);
    if normalized_relative_path.is_empty()
        || !normalized_relative_path.starts_with(".slimemold/")
        || !normalized_relative_path.ends_with(".lock")
        || relative.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_)
                    | Component::RootDir
                    | Component::ParentDir
                    | Component::CurDir
            )
        })
    {
        return Err(format!(
            "event_lock: 锁路径必须是项目内 .slimemold/*.lock：{relative_path}"
        ));
    }
    let lock_path = root.join(relative);
    let key = lock_path.to_string_lossy().to_string();
    Ok((lock_path, key))
}

fn new_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("event-lock:{}:{nanos}:{counter}", std::process::id())
}

#[tauri::command]
pub fn event_lock_acquire(root: String, relative_path: Option<String>) -> Result<String, String> {
    let (lock_path, key) = lock_path_for_root(&root, relative_path.as_deref())?;
    if held_locks()
        .lock()
        .map_err(|_| "event_lock: 锁表 poisoned".to_string())?
        .contains_key(&key)
    {
        return Err(format!("event_lock: 当前进程已持有锁：{key}"));
    }

    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("event_lock: 创建锁目录失败：{e}"))?;
    }
    let token = new_token();
    let started = Instant::now();

    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                if let Err(error) = file
                    .write_all(token.as_bytes())
                    .and_then(|_| file.sync_all())
                {
                    drop(file);
                    let _ = fs::remove_file(&lock_path);
                    return Err(format!("event_lock: 写入锁文件失败：{error}"));
                }
                held_locks()
                    .lock()
                    .map_err(|_| "event_lock: 锁表 poisoned".to_string())?
                    .insert(
                        key,
                        HeldLock {
                            token: token.clone(),
                            _file: file,
                        },
                    );
                return Ok(token);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if started.elapsed() >= LOCK_WAIT {
                    return Err(format!(
                        "event_lock: 锁等待超时，可能需要显式修复陈旧锁：{}",
                        lock_path.to_string_lossy()
                    ));
                }
                thread::sleep(LOCK_POLL);
            }
            Err(error) => return Err(format!("event_lock: 创建锁文件失败：{error}")),
        }
    }
}

#[tauri::command]
pub fn event_lock_release(
    root: String,
    token: String,
    relative_path: Option<String>,
) -> Result<(), String> {
    let (lock_path, key) = lock_path_for_root(&root, relative_path.as_deref())?;
    let held = {
        let mut locks = held_locks()
            .lock()
            .map_err(|_| "event_lock: 锁表 poisoned".to_string())?;
        let Some(current) = locks.get(&key) else {
            return Err(format!("event_lock: 当前进程没有持有锁：{key}"));
        };
        if current.token != token {
            return Err(format!("event_lock: 锁 token 不匹配：{key}"));
        }
        locks.remove(&key).expect("lock entry checked above")
    };
    drop(held._file);

    match fs::read_to_string(&lock_path) {
        Ok(current) if current == token => {
            fs::remove_file(&lock_path).map_err(|e| format!("event_lock: 删除锁文件失败：{e}"))
        }
        Ok(_) => Err(format!(
            "event_lock: 锁文件内容已变化，保留现场等待修复：{}",
            lock_path.to_string_lossy()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("event_lock: 读取锁文件失败：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "slimemold_event_lock_{name}_{}",
            TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rejects_parent_path_before_canonicalization() {
        let error = lock_path_for_root("./a/../b", None).unwrap_err();
        assert!(error.contains("禁止包含 '..'"));
    }

    #[test]
    fn acquire_and_release_creates_and_removes_exclusive_lock() {
        let root = temp_root("roundtrip");
        let token = event_lock_acquire(root.to_string_lossy().to_string(), None).unwrap();
        let (path, _) = lock_path_for_root(root.to_string_lossy().as_ref(), None).unwrap();
        assert!(path.exists());
        assert!(event_lock_acquire(root.to_string_lossy().to_string(), None).is_err());
        event_lock_release(root.to_string_lossy().to_string(), token, None).unwrap();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn acquire_and_release_supports_a_project_local_secondary_lock() {
        let root = temp_root("side_effects");
        let relative = ".slimemold/runs/side-effects.json.lock";
        let token =
            event_lock_acquire(root.to_string_lossy().to_string(), Some(relative.into())).unwrap();
        let (path, _) =
            lock_path_for_root(root.to_string_lossy().as_ref(), Some(relative)).unwrap();
        assert!(path.exists());
        event_lock_release(
            root.to_string_lossy().to_string(),
            token,
            Some(relative.into()),
        )
        .unwrap();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
