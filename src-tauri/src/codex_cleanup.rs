use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ChildStdin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) static CODEX_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
pub(crate) const CODEX_OUTPUT_CAP: usize = 16 * 1024 * 1024;
pub(crate) const CODEX_CLEANUP_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) type ChildHandle = Arc<Mutex<Option<std::process::Child>>>;
pub(crate) type CodexOutputReader = (crate::OutputThread, crate::OutputReceiver);
pub(crate) type CodexCleanupHandle = Arc<Mutex<CodexCleanupContext>>;

pub(crate) struct CodexCleanupContext {
    pub(crate) output_path: PathBuf,
    pub(crate) stdout: Option<CodexOutputReader>,
    pub(crate) stderr: Option<CodexOutputReader>,
    pub(crate) stdout_done: bool,
    pub(crate) stderr_done: bool,
    pub(crate) stdout_error: Option<String>,
    pub(crate) stderr_error: Option<String>,
    pub(crate) stdout_joining: bool,
    pub(crate) stderr_joining: bool,
}

pub(crate) fn create_codex_output() -> Result<PathBuf, String> {
    let temp_root = env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = CODEX_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let directory = temp_root.join(format!(
        "slimemold-codex-{stamp}-{}-{sequence}",
        std::process::id()
    ));
    fs::create_dir(&directory).map_err(|error| format!("创建Codex output私有目录失败：{error}"))?;
    let output_path = directory.join("last-message.txt");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Err(error) = options.open(&output_path) {
        let _ = fs::remove_dir(&directory);
        return Err(format!("创建Codex output exclusive file失败：{error}"));
    }
    Ok(output_path)
}

pub(crate) fn read_codex_output(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "读取Codex output-last-message metadata失败：{error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Codex output-last-message 不是regular file".into());
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    };
    #[cfg(not(any(unix, windows)))]
    let file = fs::File::open(path);
    let file = file.map_err(|error| format!("读取Codex output-last-message失败：{error}"))?;
    let mut bytes = Vec::new();
    file.take((CODEX_OUTPUT_CAP + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取Codex output-last-message失败：{error}"))?;
    if bytes.len() > CODEX_OUTPUT_CAP {
        return Err("Codex output-last-message 超过16MiB上限".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| format!("Codex output-last-message不是UTF-8：{error}"))
}

pub(crate) fn remove_codex_output(path: &Path) -> Result<(), String> {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("删除Codex output-last-message失败：{error}"));
        }
    }
    if let Some(directory) = path.parent() {
        match fs::remove_dir(directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除Codex output私有目录失败：{error}")),
        }
    } else {
        Ok(())
    }
}

fn join_child_output_recoverable(
    output: Option<CodexOutputReader>,
) -> Result<Vec<u8>, (String, Option<CodexOutputReader>)> {
    let Some((thread, receiver)) = output else {
        return Err(("Codex output reader 未启动".to_string(), None));
    };
    match receiver.recv_timeout(Duration::from_secs(1)) {
        Ok(result) => match thread.join() {
            Ok(()) => result.map_err(|error| (error, None)),
            Err(_) => Err(("Codex output reader thread panic".to_string(), None)),
        },
        Err(mpsc::RecvTimeoutError::Timeout) => Err((
            "读取Codex子进程 output 超时；reader retained".to_string(),
            Some((thread, receiver)),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let detail = match thread.join() {
                Ok(()) => {
                    "Codex output reader channel disconnected；reader terminal failure".to_string()
                }
                Err(_) => {
                    "Codex output reader channel disconnected and thread panicked".to_string()
                }
            };
            Err((detail, None))
        }
    }
}

pub(crate) fn join_cleanup_reader(
    cleanup: &CodexCleanupHandle,
    stdout: bool,
) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + CODEX_CLEANUP_WAIT_TIMEOUT;
    loop {
        let reader = {
            let mut state = cleanup
                .lock()
                .map_err(|_| "Codex cleanup state 已损坏".to_string())?;
            let terminal_error = if stdout {
                state.stdout_error.clone()
            } else {
                state.stderr_error.clone()
            };
            let (done, joining, slot) = if stdout {
                (state.stdout_done, state.stdout_joining, &mut state.stdout)
            } else {
                (state.stderr_done, state.stderr_joining, &mut state.stderr)
            };
            if done {
                return terminal_error.map_or_else(|| Ok(Vec::new()), Err);
            }
            if joining {
                None
            } else {
                let reader = slot.take();
                if stdout {
                    state.stdout_joining = true;
                } else {
                    state.stderr_joining = true;
                }
                Some(reader)
            }
        };
        let Some(reader) = reader else {
            if Instant::now() >= deadline {
                return Err("Codex output reader cleanup remained concurrently busy".into());
            }
            std::thread::sleep(Duration::from_millis(20));
            continue;
        };
        let result = join_child_output_recoverable(reader);
        let mut state = cleanup
            .lock()
            .map_err(|_| "Codex cleanup state 已损坏".to_string())?;
        if stdout {
            state.stdout_joining = false;
        } else {
            state.stderr_joining = false;
        }
        match result {
            Ok(buffer) => {
                if stdout {
                    state.stdout_done = true;
                } else {
                    state.stderr_done = true;
                }
                return Ok(buffer);
            }
            Err((error, retained)) => {
                if stdout {
                    state.stdout = retained;
                    state.stdout_done = state.stdout.is_none();
                    if state.stdout_done {
                        state.stdout_error = Some(error.clone());
                    }
                } else {
                    state.stderr = retained;
                    state.stderr_done = state.stderr.is_none();
                    if state.stderr_done {
                        state.stderr_error = Some(error.clone());
                    }
                }
                return Err(error);
            }
        }
    }
}

pub(crate) fn cleanup_output_readers(cleanup: &CodexCleanupHandle) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = join_cleanup_reader(cleanup, true) {
        errors.push(error);
    }
    if let Err(error) = join_cleanup_reader(cleanup, false) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(crate) fn output_readers_terminal(cleanup: &CodexCleanupHandle) -> Result<bool, String> {
    let state = cleanup
        .lock()
        .map_err(|_| "Codex cleanup state 已损坏".to_string())?;
    Ok(state.stdout_done && state.stderr_done && state.stdout.is_none() && state.stderr.is_none())
}

pub(crate) fn cleanup_output_artifact(cleanup: &CodexCleanupHandle) -> Result<(), String> {
    let output_path = cleanup
        .lock()
        .map_err(|_| "Codex cleanup state 已损坏".to_string())?
        .output_path
        .clone();
    remove_codex_output(&output_path)
}

pub(crate) fn spawn_stdin_writer(
    mut stdin: ChildStdin,
    prompt: String,
) -> Receiver<Result<(), String>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = stdin
            .write_all(prompt.as_bytes())
            .map_err(|error| format!("向 Codex CLI 写入请求失败：{error}"));
        drop(stdin);
        let _ = sender.send(result);
    });
    receiver
}

pub(crate) fn await_stdin_write(
    receiver: Option<&Receiver<Result<(), String>>>,
) -> Result<(), String> {
    let Some(receiver) = receiver else {
        return Ok(());
    };
    match receiver.recv_timeout(Duration::from_secs(1)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Codex stdin writer 未在清理窗口内结束；side effects unknown".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Codex stdin writer 已断开；side effects unknown".into())
        }
    }
}
