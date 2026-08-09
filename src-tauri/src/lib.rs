//! SlimeMold 桌面壳（路线 A）：
//! - plugin-http：前端 LLM 等网络请求经 WebView 发起（规避 CORS，并带回 token usage）
//! - plugin-fs：插件目录扫描、工作流文件读写
//! - plugin-dialog：导入导出文件对话框
//! - plugin-opener：打开资产所在文件夹/系统默认程序
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
use std::process::Command;
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
    let _ =
        keyring::Entry::new(KEYRING_SERVICE, CRED_INDEX_KEY).and_then(|e| e.set_password(&json));
}

/// 在系统密钥库存一条凭据（覆盖写）。
#[tauri::command]
fn set_credential(key: String, value: String) -> Result<(), String> {
    let k = key.trim().to_string();
    if k.is_empty() || k == CRED_INDEX_KEY {
        return Err("凭据键非法".into());
    }
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &k).map_err(|e| format!("密钥库初始化失败: {e}"))?;
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
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("密钥库初始化失败: {e}"))?;
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
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &k).map_err(|e| format!("密钥库初始化失败: {e}"))?;
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
    let mut v: serde_json::Value =
        serde_json::from_str(&value).map_err(|e| format!("接入点数据解析失败: {e}"))?;
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
    let found = list
        .into_iter()
        .find(|(name, _)| name == &key)
        .map(|(_, v)| v);
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

/// 枚举全部 API 接入点元数据（**不返回明文 apiKey**）。
/// 安全边界（2026-08-09 P1）：前端只需要 name/protocol/baseUrl 等元数据来展示与选择，
/// 明文 Key 一律按需经 `load_endpoint` 单条取回，避免把全部密钥批量暴露给 WebView 内存。
#[tauri::command]
fn list_endpoints_raw(app: AppHandle) -> Result<Vec<String>, String> {
    let list = read_ep_store(&app);
    eprintln!("[ep] list_endpoints_raw count={}", list.len());
    Ok(list
        .into_iter()
        .map(|(_, v)| strip_endpoint_api_key(&v))
        .collect())
}

/// 解析接入点 JSON，删除 apiKey 字段后返回（不清零字段、不持有明文）。
fn strip_endpoint_api_key(json: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(mut v) => {
            if let serde_json::Value::Object(ref mut map) = v {
                map.remove("apiKey");
            }
            serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string())
        }
        Err(_) => "{}".to_string(),
    }
}

/// 步骤 11 阶段 C：Git Worktree 真隔离。在 Rust 侧直接调用系统 `git`（不受 Tauri 沙箱限制），
/// 返回 stdout / stderr / 退出码，供前端的 git worktree 沙箱模式使用。
///
/// 安全边界（2026-08-07 P0-S4，后续收紧）：
/// - `cwd` 必填，且必须是已存在的目录；拒绝带 `..` 的路径。
/// - 只接受前端沙箱实现实际需要的四种精确命令形状：
///   `rev-parse --is-inside-work-tree`、`worktree add`、`worktree remove`、临时分支删除。
/// - worktree 必须是 `<cwd>/.slime-wt/<branch>` 的直接子目录，临时分支必须以
///   `slime-sandbox-` 开头；不暴露 clone/config/merge/checkout/push 等通用 Git 能力。
///
/// 调用示例：`invoke('run_git', { args: ['worktree', 'add', '-q', dir, '-b', branch, 'HEAD'], cwd })`
#[tauri::command]
fn run_git(args: Vec<String>, cwd: Option<String>) -> Result<GitResult, String> {
    // 1) cwd 必填且为已存在目录，禁止越界
    let cwd = cwd.ok_or_else(|| "run_git: cwd 必填（不允许在进程当前目录裸调 git）".to_string())?;
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.exists() {
        return Err(format!("run_git: cwd 不存在：{cwd}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("run_git: cwd 不是目录：{cwd}"));
    }
    // 规范化后检查是否有父目录逃逸。
    let canon = cwd_path
        .canonicalize()
        .map_err(|e| format!("run_git: 无法解析 cwd（{cwd}）：{e}"))?;
    if cwd_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("run_git: cwd 禁止包含 '..' 路径逃逸：{cwd}"));
    }

    // 2) 精确命令形状白名单。这里不提供通用 Git 代理，只提供 worktree 沙箱协议。
    let sandbox_root = canon.join(".slime-wt");
    match args.as_slice() {
        [sub, flag] if sub == "rev-parse" && flag == "--is-inside-work-tree" => {}
        [sub, action, quiet, path, branch_flag, branch, head]
            if sub == "worktree"
                && action == "add"
                && quiet == "-q"
                && branch_flag == "-b"
                && head == "HEAD" =>
        {
            validate_sandbox_branch(branch)?;
            fs::create_dir_all(&sandbox_root)
                .map_err(|e| format!("run_git: 创建沙箱目录失败：{e}"))?;
            validate_worktree_path(&sandbox_root, path, branch, false)?;
        }
        [sub, action, force, path]
            if sub == "worktree" && action == "remove" && force == "--force" =>
        {
            let branch = std::path::Path::new(path)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(|| "run_git: worktree 路径缺少有效目录名".to_string())?;
            validate_sandbox_branch(branch)?;
            validate_worktree_path(&sandbox_root, path, branch, true)?;
        }
        [sub, delete, branch] if sub == "branch" && delete == "-D" => {
            validate_sandbox_branch(branch)?;
        }
        _ => {
            return Err(
                "run_git: 仅允许仓库探测与 SlimeMold .slime-wt 沙箱的创建/清理".to_string(),
            );
        }
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(&cwd);
    for a in &args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("git 执行失败（是否未安装 git 或 PATH 未包含？）：{e}"))?;
    Ok(GitResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

fn validate_sandbox_branch(branch: &str) -> Result<(), String> {
    if !branch.starts_with("slime-sandbox-")
        || branch.len() <= "slime-sandbox-".len()
        || branch.contains("..")
        || branch.contains('/')
        || branch.contains('\\')
    {
        return Err(format!("run_git: 非法沙箱分支名：{branch}"));
    }
    Ok(())
}

fn validate_worktree_path(
    sandbox_root: &std::path::Path,
    raw_path: &str,
    branch: &str,
    must_exist: bool,
) -> Result<(), String> {
    let path = std::path::Path::new(raw_path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "run_git: worktree 必须是无 '..' 的绝对路径：{raw_path}"
        ));
    }

    let root = sandbox_root
        .canonicalize()
        .map_err(|e| format!("run_git: 无法解析沙箱根目录：{e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("run_git: worktree 路径缺少父目录：{raw_path}"))?
        .canonicalize()
        .map_err(|e| format!("run_git: 无法解析 worktree 父目录：{e}"))?;
    if parent != root || path.file_name().and_then(|v| v.to_str()) != Some(branch) {
        return Err(format!(
            "run_git: worktree 只能位于 <cwd>/.slime-wt/<slime-sandbox-*>：{raw_path}"
        ));
    }
    if must_exist && !path.is_dir() {
        return Err(format!("run_git: 待移除的 worktree 不存在：{raw_path}"));
    }
    if !must_exist && path.exists() {
        return Err(format!("run_git: 待创建的 worktree 已存在：{raw_path}"));
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct GitResult {
    stdout: String,
    stderr: String,
    code: i32,
}

/// 步骤 11 阶段 D：工作区信任（Tauri 版「你打开=你授权」）。
///
/// 前端在 `openProject(path)` 时调用本命令，把 `<项目根>/**` 动态注入 `main` 窗口的
/// `fs:scope`。这样无论项目放在哪个目录（D:/2048、E:/xxx），打开即授权，
/// 不再需要在 `capabilities/default.json` 里为每台机器的绝对路径写死白名单。
///
/// 安全边界：
/// - `path` 必填且已存在、为目录；拒绝含 `..` 的路径逃逸。
/// - 注入的 scope 仅 `<path>/**` 一条，不开放父级或其它任意位置。
/// - 依赖 `tauri` 的 `dynamic-acl` feature 提供的 `CapabilityBuilder` +
///   `Manager::capability().insert()`。
#[tauri::command]
fn grant_project_access(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() || !p.is_dir() {
        return Err(format!("grant_project_access: 路径不存在或不是目录：{path}"));
    }
    if p
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "grant_project_access: 路径禁止包含 '..' 逃逸：{path}"
        ));
    }
    // fs:scope 的 allow 是「字符串数组」（EntryRaw::Value 形式），不是 `{path}` 对象数组——
    // 官方 scope.toml 示例：`{ "identifier": "fs:scope", "allow": ["$APPDATA/**"] }`。
    // 曾误用 `[{ "path": "..." }]`（对象形式）导致运行时 `error deserializing scope:
    // data did not match any variant of untagged enum EntryRaw`。
    let allowed: Vec<String> = vec![format!("{}/**", path.trim_end_matches('/'))];
    // 具体操作权限（fs:allow-exists/read-dir/...）本身「无条件允许该命令」，真正限制路径
    // 的是 fs:scope；因此只需把项目根注入 fs:scope 的 scoped 版本（配合 default.json 里
    // 已授予的操作权限，运行时按注入的 scope 校验，非默认目录项目不再 forbidden）。
    let capability = tauri::ipc::CapabilityBuilder::new("slime-project-fs")
        .window("main")
        .permission_scoped("fs:scope", allowed, Vec::<String>::new());
    app.add_capability(capability)
        .map_err(|e| format!("grant_project_access: 注入 capability 失败：{e}"))?;
    eprintln!("[cap] grant_project_access ok: {path}");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            set_credential,
            get_credential,
            delete_credential,
            list_credentials,
            save_endpoint,
            load_endpoint,
            delete_endpoint,
            list_endpoints_raw,
            run_git,
            grant_project_access
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
    let _ =
        keyring::Entry::new(KEYRING_SERVICE, MASTER_KEY_ENTRY).and_then(|e| e.set_password(&b64));
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
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

/* ---------------- 检查点原子写入的底层行为验证（真实文件系统） ---------------- */
// 前端 saveCheckpoints（src/io/projectIO.ts）的原子替换核心是 tauri-plugin-fs 的
// `rename(tmp, target)`。插件命令是 Rust `std::fs::rename` 的薄封装，因此以下测试用
// `std::fs::rename` 在真实文件系统上验证：
//   1) 目标已存在时 rename 是否替换成功（Windows 上对应 MoveFileExW +
//      MOVEFILE_REPLACE_EXISTING）——这是「已有目标文件时 rename 是否替换成功」的直接证明；
//   2) 目标被独占锁定时 rename/remove 失败 → 保留 tmp（回退分支语义）。
#[cfg(test)]
mod fs_atomic_replace_tests {
    use std::fs;
    use std::path::PathBuf;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slime_fs_atomic_{}_{}",
            name,
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rename_replaces_existing_target_file() {
        let dir = tmpdir("replace");
        let tmp = dir.join("checkpoints.json.tmp");
        let target = dir.join("checkpoints.json");
        fs::write(&tmp, "new-content").unwrap();
        fs::write(&target, "old-content").unwrap();
        // saveCheckpoints 的原子替换核心：rename 覆盖已存在目标
        fs::rename(&tmp, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new-content");
        assert!(!tmp.exists(), "tmp 应被 rename 消费");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_to_missing_target_succeeds() {
        let dir = tmpdir("missing");
        let tmp = dir.join("a.tmp");
        let target = dir.join("a.json");
        fs::write(&tmp, "x").unwrap();
        fs::rename(&tmp, &target).unwrap();
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_then_rename_fallback_works() {
        let dir = tmpdir("fallback");
        let tmp = dir.join("b.tmp");
        let target = dir.join("b.json");
        fs::write(&tmp, "new").unwrap();
        fs::write(&target, "old").unwrap();
        // saveCheckpoints 的第二次重试路径：先删旧目标再 rename
        fs::remove_file(&target).unwrap();
        fs::rename(&tmp, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_target_rename_fails_and_tmp_preserved() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tmpdir("locked");
        let tmp = dir.join("c.tmp");
        let target = dir.join("c.json");
        fs::write(&tmp, "new").unwrap();
        fs::write(&target, "old").unwrap();
        // 独占共享模式打开目标（share_mode=0：拒绝其它进程读写/删除）
        let handle = OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        // 1) 目标被锁时直接 rename 应失败
        assert!(fs::rename(&tmp, &target).is_err(), "锁定目标时 rename 应失败");
        // 2) remove 被锁目标也应失败 → saveCheckpoints 走「保留 tmp」分支
        assert!(fs::remove_file(&target).is_err(), "锁定目标时 remove 应失败");
        // 3) tmp 保留（内容完整，供下次覆盖）
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "new");
        drop(handle);
        let _ = fs::remove_dir_all(&dir);
    }
}
