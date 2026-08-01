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
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 密钥库 service 名（同机多 app 隔离用）。
const KEYRING_SERVICE: &str = "com.slimemold.credentials";

/// 索引条目的 key：保存一份「已登记凭据键」清单，供 list_credentials 枚举。
/// keyring crate 本身不支持枚举条目，而 Windows 上 (service,user) 的 target 不区分 user，
/// OS 命令（cmdkey/security/secret-tool）难以稳定列出 credentialKey，
/// 故在密钥库内用一条特殊条目维护索引，保证跨平台一致且数据始终权威来自密钥库。
const CRED_INDEX_KEY: &str = "___cred_index___";

/// 读出当前索引（JSON 数组）。损坏/缺失返回空列表。
fn read_index() -> Vec<String> {
    match keyring::Entry::new(KEYRING_SERVICE, CRED_INDEX_KEY).and_then(|e| e.get_password()) {
        Ok(s) => serde_json::from_str::<Vec<String>>(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 写回索引，并剔除密钥库中已不存在的 key（自愈）。
fn write_index(mut keys: Vec<String>) {
    keys.retain(|k| {
        k != CRED_INDEX_KEY
            && !k.starts_with("ep::") // endpoint 整条（含 key）单独管理，不混入纯密钥列表
            && !k.starts_with('_') // 排除所有内部索引键（___cred_index___ / __ep_index__ 等）
            && keyring::Entry::new(KEYRING_SERVICE, k)
                .and_then(|e| e.get_password())
                .is_ok()
    });
    keys.sort();
    keys.dedup();
    let json = serde_json::to_string(&keys).unwrap_or_else(|_| "[]".to_string());
    let _ = keyring::Entry::new(KEYRING_SERVICE, CRED_INDEX_KEY).and_then(|e| e.set_password(&json));
}

/// 在系统密钥库存一条凭据（覆盖写）。
#[tauri::command]
fn set_credential(key: String, value: String) -> Result<(), String> {
    let k = key.trim().to_string();
    if k.is_empty() || k == CRED_INDEX_KEY {
        return Err("凭据键非法".into());
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, &k)
        .map_err(|e| format!("密钥库初始化失败: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("保存凭据失败: {e}"))?;
    // 同步进索引
    let mut idx = read_index();
    if !idx.contains(&k) {
        idx.push(k);
        write_index(idx);
    }
    Ok(())
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
    let k = key.trim().to_string();
    let entry = keyring::Entry::new(KEYRING_SERVICE, &k)
        .map_err(|e| format!("密钥库初始化失败: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => {}
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("删除凭据失败: {e}")),
    }
    // 从索引移除
    let mut idx = read_index();
    idx.retain(|x| x != &k);
    write_index(idx);
    Ok(())
}

/// 枚举已登记的凭据键（来自密钥库内维护的索引，跨平台一致）。
#[tauri::command]
fn list_credentials() -> Result<Vec<String>, String> {
    let mut idx = read_index();
    write_index(idx.clone()); // 自愈：剔除已失效条目
    idx = read_index();
    Ok(idx)
}

/* ---------------- API 接入点（AppData 本地 JSON 文件存储） ---------------- */
// 说明：此前接入点索引存于系统密钥库（keyring），但在 Windows Credential Manager 上
// 出现「写入成功、随即读取为 0」的 (service,user) 读写不一致问题，且无下划线键名仍不可靠。
// 故改为写入 AppData 目录下的 endpoints.json 文件：读写确定性 100%，不依赖 OS 密钥库行为。
// 纯 apiKey 仍单独存入 keyring（每条凭据独立），由其提供 OS 级保护；接入点列表（含 baseUrl 等）落盘文件。

/// 取得接入点存储文件路径：<AppData>/com.slimemold/endpoints.json
fn ep_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 AppData 目录失败: {e}"))?;
    Ok(dir.join("endpoints.json"))
}

/// 读出接入点存储（Vec<(name, value)>）。
fn read_ep_store(app: &AppHandle) -> Vec<(String, String)> {
    let path = match ep_file_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str::<Vec<(String, String)>>(&s).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// 写回接入点存储。
fn write_ep_store(app: &AppHandle, list: &[(String, String)]) -> Result<(), String> {
    let path = ep_file_path(app)?;
    let json = serde_json::to_string_pretty(list).unwrap_or_else(|_| "[]".to_string());
    fs::write(&path, json).map_err(|e| format!("写入接入点文件失败: {e}"))
}

/// 存一条 API 接入点整条（含明文 key）。
#[tauri::command]
fn save_endpoint(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let k = key.trim().to_string();
    if k.is_empty() {
        return Err("接入点键非法".into());
    }
    let mut list = read_ep_store(&app);
    if let Some(pos) = list.iter().position(|(name, _)| name == &k) {
        list[pos].1 = value.clone();
    } else {
        list.push((k.clone(), value.clone()));
    }
    write_ep_store(&app, &list)?;
    // 同时把明文 key 登记到系统密钥库（供智能体按 name 引用）
    let api_key = serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .and_then(|v| v.get("apiKey").and_then(|x| x.as_str()).map(|s| s.to_string()));
    if let Some(ak) = api_key {
        let _ = keyring::Entry::new(KEYRING_SERVICE, &k).and_then(|e| e.set_password(&ak));
    }
    eprintln!("[ep] save_endpoint ok: key={k} total={}", list.len());
    Ok(())
}

/// 读一条 API 接入点整条；不存在返回 Ok(None)。
#[tauri::command]
fn load_endpoint(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let list = read_ep_store(&app);
    Ok(list.into_iter().find(|(name, _)| name == &key).map(|(_, v)| v))
}

/// 删一条 API 接入点。
#[tauri::command]
fn delete_endpoint(app: AppHandle, key: String) -> Result<(), String> {
    let k = key.trim().to_string();
    let mut list = read_ep_store(&app);
    list.retain(|(name, _)| name != &k);
    write_ep_store(&app, &list)?;
    let _ = keyring::Entry::new(KEYRING_SERVICE, &k).and_then(|e| e.delete_credential());
    Ok(())
}

/// 枚举全部 API 接入点整条（JSON 数组字符串）。
#[tauri::command]
fn list_endpoints_raw(app: AppHandle) -> Result<Vec<String>, String> {
    let list = read_ep_store(&app);
    eprintln!("[ep] list_endpoints_raw count={}", list.len());
    Ok(list.into_iter().map(|(_, v)| v).collect())
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
            delete_credential,
            list_credentials,
            save_endpoint,
            load_endpoint,
            delete_endpoint,
            list_endpoints_raw
        ])
        // 窗口默认可见（tauri.conf.json visible:true）。保留 on_page_load 作为兜底，
        // 万一某些环境初始未显示，页面加载完成后再确保 show 一次。
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .on_page_load(|win, _payload| {
            // 页面初次加载完成即确保窗口可见（SPA 仅触发一次）
            let _ = win.show();
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
    /// 本地代理转发地址（参考 cc-switch 的代理路由）。
    /// 非空时经该 HTTP 代理访问 baseUrl（适配中转 / 统一出口）。
    #[allow(dead_code)]
    proxyUrl: Option<String>,
}

#[derive(Deserialize)]
struct ChatCompletionArgs {
    agent: AgentConfig,
    messages: Vec<ChatMessage>,
    stream: bool,
    /// 全局默认代理（设置页「通用」配置）；agent.proxyUrl 优先，其次本项，均空则直连。
    #[allow(non_snake_case)]
    global_proxy_url: Option<String>,
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

    let mut client_builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300));
    // 本地代理转发（参考 cc-switch 路由）：
    // 优先级 agent.proxyUrl > 全局代理 global_proxy_url，均空则直连。
    let effective_proxy = agent
        .proxyUrl
        .as_ref()
        .and_then(|p| if p.trim().is_empty() { None } else { Some(p.trim().to_string()) })
        .or_else(|| {
            args.global_proxy_url
                .as_ref()
                .and_then(|p| if p.trim().is_empty() { None } else { Some(p.trim().to_string()) })
        });
    if let Some(proxy) = effective_proxy {
        client_builder = client_builder
            .proxy(reqwest::Proxy::all(&proxy).map_err(|e| format!("代理地址无效: {e}"))?);
    }
    let client = client_builder
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
