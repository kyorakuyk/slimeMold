//! SlimeMold 桌面壳（路线 A）：
//! - plugin-http：前端 LLM 等网络请求经 WebView 发起（规避 CORS，并带回 token usage）
//! - plugin-fs：插件目录扫描、工作流文件读写
//! - plugin-dialog：导入导出文件对话框
//! - plugin-window-state：自动持久化/恢复主窗口的位置、大小、最大化、全屏、可见性等状态
//!   （关闭时写入 AppData，启动时按窗口 label 还原，故 tauri.conf.json 中已移除 center 以避免覆盖）
//! - keyring：接入点 apiKey 的 AES-GCM 主密钥存储；接入点整条落盘于 AppData/endpoints.json
//!   （apiKey 字段加密，磁盘无明文）
//! - set_credential / get_credential / delete_credential / list_credentials：基于 keyring crate，
//!   落盘到 OS 密钥库（Windows Credential Manager / macOS Keychain / Linux secret-service）。
//!
//! 注意：Rust 侧不再实现 LLM HTTP 客户端（原 chat_completion 已移除），所有 LLM 调用
//! 由前端 provider 发起。

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

/// 存一条 API 接入点整条（含 apiKey，落盘时加密为密文）。
#[tauri::command]
fn save_endpoint(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let k = key.trim().to_string();
    if k.is_empty() {
        return Err("接入点键非法".into());
    }
    // 解析 value，提取明文 apiKey 并加密，写回 value 的 apiKey 字段（密文）
    let mut v: serde_json::Value = serde_json::from_str(&value)
        .map_err(|e| format!("接入点数据解析失败: {e}"))?;
    if let Some(plain) = v.get("apiKey").and_then(|x| x.as_str()) {
        if !plain.is_empty() {
            let enc = encrypt_api_key(plain)?;
            v["apiKey"] = serde_json::Value::String(enc);
        }
    }
    let stored = serde_json::to_string(&v).map_err(|e| format!("序列化失败: {e}"))?;
    let mut list = read_ep_store(&app);
    if let Some(pos) = list.iter().position(|(name, _)| name == &k) {
        list[pos].1 = stored.clone();
    } else {
        list.push((k.clone(), stored.clone()));
    }
    write_ep_store(&app, &list)?;
    eprintln!("[ep] save_endpoint ok: key={k} total={}", list.len());
    Ok(())
}

/// 读一条 API 接入点整条（apiKey 字段已解密为明文）；不存在返回 Ok(None)。
#[tauri::command]
fn load_endpoint(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let list = read_ep_store(&app);
    let found = list.into_iter().find(|(name, _)| name == &key).map(|(_, v)| v);
    Ok(found.map(|v| decrypt_api_key_in_json(&v)))
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

/// 把接入点 JSON 中密文 apiKey 解密回明文（供前端/智能体使用）。
fn decrypt_api_key_in_json(json: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(mut v) => {
            if let Some(enc) = v.get("apiKey").and_then(|x| x.as_str()) {
                if let Some(plain) = decrypt_api_key(enc) {
                    v["apiKey"] = serde_json::Value::String(plain);
                }
            }
            serde_json::to_string(&v).unwrap_or_else(|_| json.to_string())
        }
        Err(_) => json.to_string(),
    }
}

/// 枚举全部 API 接入点整条（apiKey 已解密为明文返回）。
#[tauri::command]
fn list_endpoints_raw(app: AppHandle) -> Result<Vec<String>, String> {
    let list = read_ep_store(&app);
    eprintln!("[ep] list_endpoints_raw count={}", list.len());
    Ok(list.into_iter().map(|(_, v)| decrypt_api_key_in_json(&v)).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
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

// 注意：Rust 侧不再实现 LLM HTTP 调用（原 chat_completion 已移除，路线 A）。
// 所有 LLM 请求由前端 provider（plugin-http）发起，带回 token usage 统计，
// 且天然规避 CORS。密钥仅存于系统密钥库（keyring），前端按 name 引用、不直接持有明文。
// 路线 B 若启用后端执行引擎，将复用此处的密钥/文件能力，而非重新实现 HTTP 客户端。

/* ---------------- 接入点 apiKey 加密（AES-GCM，主密钥存于密钥库） ---------------- */
// endpoints.json 落盘时 apiKey 以密文存储，避免明文泄露；运行时按 name 解密取回。
const MASTER_KEY_ENTRY: &str = "___sm_master_key___";

fn get_master_key() -> Result<[u8; 32], String> {
    // 优先从密钥库取既有主密钥
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, MASTER_KEY_ENTRY) {
        if let Ok(b64) = entry.get_password() {
            if let Ok(bytes) = base64_decode(&b64) {
                if bytes.len() == 32 {
                    let mut k = [0u8; 32];
                    k.copy_from_slice(&bytes);
                    return Ok(k);
                }
            }
        }
    }
    // 否则生成并持久化
    let mut k = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut k);
    let b64 = base64_encode(&k);
    let _ = keyring::Entry::new(KEYRING_SERVICE, MASTER_KEY_ENTRY)
        .and_then(|e| e.set_password(&b64));
    Ok(k)
}

/// 加密明文 apiKey → "nonce(12B).ciphertext" 的 base64 串。
fn encrypt_api_key(plain: &str) -> Result<String, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let key = get_master_key()?;
    let cipher = Aes256Gcm::new(&key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("加密 apiKey 失败: {e}"))?;
    let mut buf = nonce_bytes.to_vec();
    buf.extend_from_slice(&ct);
    Ok(base64_encode(&buf))
}

/// 解密经 encrypt_api_key 得到的密文 → 明文；失败返回 None。
fn decrypt_api_key(b64: &str) -> Option<String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let bytes = base64_decode(b64).ok()?;
    if bytes.len() < 12 {
        return None;
    }
    let key = get_master_key().ok()?;
    let cipher = Aes256Gcm::new(&key.into());
    let (nonce_raw, ct) = bytes.split_at(12);
    let nonce = Nonce::from_slice(nonce_raw);
    let pt = cipher.decrypt(nonce, ct).ok()?;
    String::from_utf8(pt).ok()
}

// 简易 base64（避免引入额外 crate）
fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in input.chars() {
        if c == '=' {
            break;
        }
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
        }
    }
    Ok(buf)
}
