use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) const DEV_OUTPUT_CAP: usize = 16 * 1024 * 1024;
const OUTPUT_JOIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(serde::Serialize)]
pub(crate) struct DevExecResult {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: i32,
}

pub(crate) fn drain_child_output_checked<R: Read>(mut reader: R) -> Result<Vec<u8>, String> {
    let mut captured = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => size,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("读取子进程输出失败：{error}")),
        };
        if total < DEV_OUTPUT_CAP {
            let keep = read.min(DEV_OUTPUT_CAP - total);
            captured.extend_from_slice(&buffer[..keep]);
        }
        total = total.saturating_add(read);
    }
    Ok(captured)
}

type OutputReceiver = Receiver<Result<Vec<u8>, String>>;
type OutputThread = JoinHandle<()>;

fn spawn_output_reader<R: Read + Send + 'static>(reader: R) -> (OutputThread, OutputReceiver) {
    let (sender, receiver) = mpsc::channel();
    let thread = thread::spawn(move || {
        let _ = sender.send(drain_child_output_checked(reader));
    });
    (thread, receiver)
}

fn receive_output(
    label: &str,
    thread: OutputThread,
    receiver: OutputReceiver,
) -> Result<Vec<u8>, String> {
    let result = receiver
        .recv_timeout(OUTPUT_JOIN_TIMEOUT)
        .map_err(|_| format!("读取子进程 {label} 超时"))?;
    thread
        .join()
        .map_err(|_| format!("读取 {label} 线程失败"))?;
    result
}

pub(crate) fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
    kill_child: fn(&mut Child),
) -> Result<DevExecResult, String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = cmd.spawn().map_err(|e| format!("命令启动失败：{e}"))?;
    let stdout = child.stdout.take().map(spawn_output_reader);
    let stderr = child.stderr.take().map(spawn_output_reader);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                kill_child(&mut child);
                let _ = child.wait();
                return Err(format!("dev_exec 执行超时（{}ms）", timeout.as_millis()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                kill_child(&mut child);
                let _ = child.wait();
                return Err(format!("等待子进程失败：{error}"));
            }
        }
    };
    let out_buf = match stdout
        .map(|(thread, receiver)| receive_output("stdout", thread, receiver))
        .transpose()
    {
        Ok(Some(buffer)) => buffer,
        Ok(None) => Vec::new(),
        Err(error) => {
            kill_child(&mut child);
            let _ = child.wait();
            return Err(format!(
                "dev_exec output capture failed; side effects unknown: {error}"
            ));
        }
    };
    let err_buf = match stderr
        .map(|(thread, receiver)| receive_output("stderr", thread, receiver))
        .transpose()
    {
        Ok(Some(buffer)) => buffer,
        Ok(None) => Vec::new(),
        Err(error) => {
            kill_child(&mut child);
            let _ = child.wait();
            return Err(format!(
                "dev_exec output capture failed; side effects unknown: {error}"
            ));
        }
    };
    Ok(DevExecResult {
        stdout: String::from_utf8_lossy(&out_buf).to_string(),
        stderr: String::from_utf8_lossy(&err_buf).to_string(),
        code: status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_capture_preserves_only_the_output_cap() {
        let input = vec![b'x'; DEV_OUTPUT_CAP + 17];
        let output = drain_child_output_checked(Cursor::new(input)).unwrap();
        assert_eq!(output.len(), DEV_OUTPUT_CAP);
    }

    #[test]
    fn interrupted_reader_is_retried() {
        struct InterruptedThenData(u8);
        impl Read for InterruptedThenData {
            fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
                match self.0 {
                    0 => {
                        self.0 = 1;
                        Err(std::io::Error::from(std::io::ErrorKind::Interrupted))
                    }
                    1 => {
                        self.0 = 2;
                        target[0] = b'o';
                        target[1] = b'k';
                        Ok(2)
                    }
                    _ => Ok(0),
                }
            }
        }
        assert_eq!(
            drain_child_output_checked(InterruptedThenData(0)).unwrap(),
            b"ok"
        );
    }

    #[cfg(windows)]
    #[test]
    fn nonzero_exit_is_returned_without_timeout_error() {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "exit 7"]);
        let result = run_with_timeout(&mut command, Duration::from_secs(2), |child| {
            let _ = child.kill();
        })
        .unwrap();
        assert_eq!(result.code, 7);
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_exit_is_returned_without_timeout_error() {
        let mut command = Command::new("sh");
        command.args(["-c", "exit 7"]);
        let result = run_with_timeout(&mut command, Duration::from_secs(2), |child| {
            let _ = child.kill();
        })
        .unwrap();
        assert_eq!(result.code, 7);
    }
}
