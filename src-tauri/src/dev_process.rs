use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_CAP: usize = 16 * 1024 * 1024;

#[derive(serde::Serialize)]
pub(crate) struct DevExecResult {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: i32,
}

pub(crate) fn drain_child_output<R: Read>(mut reader: R) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => size,
        };
        if total < OUTPUT_CAP {
            let keep = read.min(OUTPUT_CAP - total);
            captured.extend_from_slice(&buffer[..keep]);
        }
        total = total.saturating_add(read);
    }
    captured
}

pub(crate) fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
    kill_child: fn(&mut Child),
) -> Result<DevExecResult, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = cmd.spawn().map_err(|e| format!("命令启动失败：{e}"))?;
    let stdout = child
        .stdout
        .take()
        .map(|stream| thread::spawn(move || drain_child_output(stream)));
    let stderr = child
        .stderr
        .take()
        .map(|stream| thread::spawn(move || drain_child_output(stream)));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                kill_child(&mut child);
                let _ = child.wait();
                let _ = stdout.map(|thread| thread.join());
                let _ = stderr.map(|thread| thread.join());
                return Err("dev_exec 执行超时（30s）".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                kill_child(&mut child);
                let _ = child.wait();
                let _ = stdout.map(|thread| thread.join());
                let _ = stderr.map(|thread| thread.join());
                return Err(format!("等待子进程失败：{error}"));
            }
        }
    };
    let out_buf = stdout
        .map(|thread| {
            thread
                .join()
                .map_err(|_| "读取 stdout 线程失败".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    let err_buf = stderr
        .map(|thread| {
            thread
                .join()
                .map_err(|_| "读取 stderr 线程失败".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    Ok(DevExecResult {
        stdout: String::from_utf8_lossy(&out_buf).to_string(),
        stderr: String::from_utf8_lossy(&err_buf).to_string(),
        code: status.code().unwrap_or(-1),
    })
}
