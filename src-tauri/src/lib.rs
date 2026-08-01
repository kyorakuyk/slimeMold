//! SlimeMold 桌面壳：
//! - plugin-http：LLM 等网络请求经 Rust 侧转发（规避 WebView CORS）
//! - plugin-fs：插件目录扫描、工作流文件读写
//! - plugin-dialog：导入导出文件对话框
//! - 路线 A（Step 0.5）：chat_completion 在 Rust 侧发起 LLM 请求，凭据经系统
//!   密钥库（keyring）存取，密钥明文永不进入前端渲染层 / 工作流文件 / git。
//!   - set_credential / get_credential / delete_credential：基于 keyring crate，
//!     落盘到 OS 密钥库（Windows Credential Manager / macOS Keychain / Linux secret-service）。
//!   - chat_completion 不再接收前端明文 apiKey，改为按 agent.credentialKey 从
//!     密钥库取回；credentialKey 缺省时回退到 agent.apiKey（兼容 headless / 旧链路）。

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// 密钥库 service 名（同机多 app 隔离用）。
const KEYRING_SERVICE: &str = "com.slimemold.credentials";

/// 在系统密钥库存一条凭据（覆盖写）。
#[tauri::command]
fn set_credential(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("密钥库初始化失败: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("保存凭据失败: {e}"))
}

/// 从系统密钥库读取一条凭据；不存在返回 Ok(None) 而非错误。
#[tauri::command]
fn get_credential(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("密钥库初始化失败: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取凭据失败: {e}")),
    }
}

/// 从系统密钥库删除一条凭据；不存在也视为成功。
#[tauri::command]
fn delete_credential(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("密钥库初始化失败: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除凭据失败: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            chat_completion,
            set_credential,
            get_credential,
            delete_credential
        ])
        // 首屏优化：窗口初始隐藏，待前端页面 ready 后再显示，消除 webview 白屏
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                win.hide().ok();
            }
            Ok(())
        })
        .on_page_load(|win, _payload| {
            // 页面初次加载完成即显示窗口（SPA 仅触发一次）
            win.show().ok();
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize, Clone)]
#[allow(non_snake_case)]
struct AgentConfig {
    #[allow(dead_code)]
    id: Option<String>,
    #[allow(dead_code)]
    name: Option<String>,
    protocol: String,
    baseUrl: String,
    /// 密钥库中的凭据键；非空时 Rust 侧据此从系统密钥库取回 apiKey。
    /// 前端永不直接传明文 apiKey（Step 0.5）。
    #[allow(dead_code)]
    credentialKey: Option<String>,
    /// 兼容回退：headless / 本地 Ollama（无需 key）时可直传。生产链路应留空。
    #[allow(dead_code)]
    apiKey: Option<String>,
    model: String,
    temperature: Option<f32>,
}

#[derive(Deserialize)]
struct ChatCompletionArgs {
    agent: AgentConfig,
    messages: Vec<ChatMessage>,
    stream: bool,
}

/// 在 Rust 侧发起 LLM 请求。非流式直接返回完整文本；流式经 Channel 逐片回传 token。
/// 支持 openai 兼容 / ollama（/api/chat 也返回 choices[].delta.content 风格 SSE）。
#[tauri::command]
async fn chat_completion(
    app: AppHandle,
    args: ChatCompletionArgs,
    on_token_channel: tauri::ipc::Channel<String>,
) -> Result<String, String> {
    let agent = args.agent;
    let base = agent.baseUrl.trim_end_matches('/');

    // Step 0.5：优先按 credentialKey 从系统密钥库取 key；仅在无 credentialKey 时
    // 回退到直传 apiKey（headless / 本地 Ollama 无 key 场景）。前端生产链路不传 apiKey。
    let api_key: String = if let Some(ck) = &agent.credentialKey {
        let entry = keyring::Entry::new(KEYRING_SERVICE, ck)
            .map_err(|e| format!("密钥库初始化失败: {e}"))?;
        entry
            .get_password()
            .map_err(|e| format!("凭据 [{ck}] 读取失败，请先在设置中保存密钥: {e}"))?
    } else {
        agent.apiKey.clone().unwrap_or_default()
    };

    // anthropic 用 /v1/messages，其余 OpenAI 兼容用 /chat/completions
    let url = if agent.protocol == "anthropic" {
        format!("{}/v1/messages", base)
    } else {
        format!("{}/chat/completions", base)
    };

    // 拆分 system（anthropic 需单独作为顶层字段）
    let system_text: String = args
        .messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let chat_messages: Vec<serde_json::Value> = args
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();

    let body = if agent.protocol == "anthropic" {
        let mut b = serde_json::json!({
            "model": agent.model,
            "max_tokens": 4096,
            "temperature": agent.temperature.unwrap_or(0.7),
            "stream": args.stream,
            "messages": chat_messages,
        });
        if !system_text.is_empty() {
            b["system"] = serde_json::Value::String(system_text);
        }
        b
    } else {
        serde_json::json!({
            "model": agent.model,
            "messages": chat_messages,
            "temperature": agent.temperature.unwrap_or(0.7),
            "stream": args.stream,
        })
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("客户端构建失败: {e}"))?;

    let mut builder = client
        .post(&url)
        .header("Content-Type", "application/json");

    if agent.protocol == "anthropic" {
        builder = builder
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        builder = builder.header("Authorization", format!("Bearer {}", api_key));
    }
    builder = builder.json(&body);

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM 后端返回 {status}: {}", text.slice(300)));
    }

    if !args.stream {
        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("响应解析失败: {e}"))?;
        let content = if agent.protocol == "anthropic" {
            // anthropic 非流式：content[].text
            data.get("content")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            data.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        return Ok(content);
    }

    // 流式：逐行解析 SSE，按协议提取增量文本
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return Err(format!("流读取失败: {e}")),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim_end();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    let _ = app; // keep app alive
                    return Ok(full);
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    let delta: Option<&str> = if agent.protocol == "anthropic" {
                        // anthropic: content_block_delta → delta.text
                        json.get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|v| v.as_str())
                    } else {
                        // openai 兼容: choices[0].delta.content
                        json.get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .and_then(|d| d.get("content"))
                            .and_then(|v| v.as_str())
                    };
                    if let Some(d) = delta {
                        full.push_str(d);
                        let _ = on_token_channel.send(d.to_string());
                    }
                }
            }
        }
    }
    Ok(full)
}

/// 给 String 一个截断小工具（用于错误报告）
trait SliceStr {
    fn slice(&self, n: usize) -> &str;
}
impl SliceStr for str {
    fn slice(&self, n: usize) -> &str {
        if self.len() <= n {
            self
        } else {
            &self[..n]
        }
    }
}
