//! SlimeMold 桌面壳：
//! - plugin-http：LLM 等网络请求经 Rust 侧转发（规避 WebView CORS）
//! - plugin-fs：插件目录扫描、工作流文件读写
//! - plugin-dialog：导入导出文件对话框
//! - 路线 A：chat_completion 命令——在 Rust 侧发起 LLM 请求，流式 token 经
//!   tauri::ipc::Channel 回传前端，密钥不出前端渲染层。

use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![chat_completion])
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
struct AgentConfig {
    #[allow(dead_code)]
    id: Option<String>,
    #[allow(dead_code)]
    name: Option<String>,
    protocol: String,
    baseUrl: String,
    apiKey: String,
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
    let url = format!("{}/chat/completions", base);

    let messages: Vec<serde_json::Value> = args
        .messages
        .iter()
        .map(|m| {
            serde_json::json!({ "role": m.role, "content": m.content })
        })
        .collect();

    let body = serde_json::json!({
        "model": agent.model,
        "messages": messages,
        "temperature": agent.temperature.unwrap_or(0.7),
        "stream": args.stream,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("客户端构建失败: {e}"))?;

    let mut builder = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", agent.apiKey))
        .json(&body);

    // anthropic 协议需要 anthropic-version 头；其余按 OpenAI 兼容处理
    if agent.protocol == "anthropic" {
        builder = builder.header("anthropic-version", "2023-06-01");
    }

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
        let content = data
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(content);
    }

    // 流式：逐行解析 SSE，提取 delta.content
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
                    if let Some(delta) = json
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|v| v.as_str())
                    {
                        full.push_str(delta);
                        let _ = on_token_channel.send(delta.to_string());
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
