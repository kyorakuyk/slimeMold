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
//! 注意：Rust 侧不实现 LLM HTTP 客户端（原 chat_completion 已移除）。普通 API provider
//! 由前端发起；Codex provider 是受控例外，只通过官方 Codex CLI 的 Tauri 命令调用。

use rand::RngCore;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod codex;
mod event_store;

/// H4 dev_exec 登记态：主仓库根 + 已登记 worktree（GUI 下由前端在 DevSession 初始化/创建时同步）。
static DEV_STATE: Mutex<DevState> = Mutex::new(DevState::new());
/// Serialize session changes and host operations so a project switch cannot race a checked command.
static DEV_OPERATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_dev_operation() -> std::sync::MutexGuard<'static, ()> {
    DEV_OPERATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn next_session_generation(current: u64) -> u64 {
    current.wrapping_add(1).max(1)
}

pub(crate) fn assert_session_generation(expected: u64, operation: &str) -> Result<(), String> {
    if expected == 0 {
        return Err(format!("{operation}: 缺少有效 session generation"));
    }
    let state = DEV_STATE.lock().unwrap();
    if state.base_repo.is_none() || state.generation != expected {
        return Err(format!(
            "{operation}: session generation 已失效（expected={expected}, current={}）",
            state.generation
        ));
    }
    Ok(())
}

#[cfg(test)]
static DEV_STATE_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
fn lock_dev_state_tests() -> std::sync::MutexGuard<'static, ()> {
    DEV_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct DevState {
    generation: u64,
    base_repo: Option<String>,
    worktrees: Vec<String>,
    registrations: Vec<RegisteredWorktree>,
    cleanup_bindings: Vec<CleanupBinding>,
    pending_worktrees: Vec<PendingWorktree>,
    orphan_worktrees: Vec<PendingWorktree>,
}

#[derive(Clone)]
struct RegisteredWorktree {
    generation: u64,
    path: String,
    branch: String,
}

fn registered_worktree_identity_matches(
    registered: &RegisteredWorktree,
    generation: u64,
    path: &str,
    branch: &str,
) -> bool {
    registered.generation == generation
        && registered.branch == branch
        && path_compare_key(&registered.path) == path_compare_key(path)
}

fn new_cleanup_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn invalidate_cleanup_binding(token: &str) {
    let mut state = DEV_STATE.lock().unwrap();
    if let Some(binding) = state
        .cleanup_bindings
        .iter_mut()
        .find(|binding| binding.token == token)
    {
        binding.consumed = true;
    }
}

#[derive(Clone)]
struct CleanupBinding {
    token: String,
    generation: u64,
    path: String,
    branch: String,
    branch_revision: String,
    consumed: bool,
}

fn cleanup_binding_matches(
    binding: &CleanupBinding,
    token: &str,
    generation: u64,
    path: &str,
    branch: &str,
    branch_revision: &str,
) -> bool {
    !binding.consumed
        && binding.token == token
        && binding.generation == generation
        && binding.branch == branch
        && binding.branch_revision == branch_revision
        && path_compare_key(&binding.path) == path_compare_key(path)
}

struct PendingWorktree {
    generation: u64,
    path: String,
    branch: String,
    removed: bool,
}

impl DevState {
    const fn new() -> Self {
        DevState {
            generation: 0,
            base_repo: None,
            worktrees: Vec::new(),
            registrations: Vec::new(),
            cleanup_bindings: Vec::new(),
            pending_worktrees: Vec::new(),
            orphan_worktrees: Vec::new(),
        }
    }
}

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
            let enc = encrypt_api_key(&app, plain)?;
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
    Ok(found.map(|v| decrypt_api_key_in_json(&app, &v)))
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
fn decrypt_api_key_in_json(app: &AppHandle, json: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(mut v) => {
            if let Some(enc) = v.get("apiKey").and_then(|x| x.as_str()) {
                if let Some(plain) = decrypt_api_key(app, enc) {
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

/* ---------------- Vault（自动分组密钥库，2026-08-09） ----------------
 * 用户在 UI 只填 key + label + baseUrl，id 由前端自动生成（UUID）、vendor 由前端按
 * baseUrl 域名自动推断；Rust 侧负责加密存储与按需取回，不把明文 key 批量返回 WebView。
 * 复用 endpoints.json 同一文件（结构性升级，旧 Endpoint 由前端一次性迁移）。
 */

/// 存一条 Vault（key = vaultId，value 含 apiKey 密文 + label/vendor/baseUrl/models 元数据）。
/// 复用 encrypt_api_key 加密明文 apiKey。返回 ()。
#[tauri::command]
fn save_vault(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let k = key.trim().to_string();
    if k.is_empty() {
        return Err("vault 键非法".into());
    }
    let mut v: serde_json::Value =
        serde_json::from_str(&value).map_err(|e| format!("vault 数据解析失败: {e}"))?;
    if let Some(plain) = v.get("apiKey").and_then(|x| x.as_str()) {
        if !plain.is_empty() {
            let enc = encrypt_api_key(&app, plain)?;
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
    eprintln!("[vault] save_vault ok: id={k} total={}", list.len());
    Ok(())
}

/// 枚举全部 Vault 元数据（剥离 apiKey，仅返回 id/label/vendor/baseUrl/protocol/models）。
#[tauri::command]
fn list_vaults(app: AppHandle) -> Result<Vec<String>, String> {
    let list = read_ep_store(&app);
    eprintln!("[vault] list_vaults count={}", list.len());
    Ok(list
        .into_iter()
        .map(|(_, v)| strip_endpoint_api_key(&v))
        .collect())
}

/// 按 vaultId 读取单个 Vault 的明文 apiKey（含元数据）。不存在返回 Ok(None)。
#[tauri::command]
fn load_vault_key(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let list = read_ep_store(&app);
    let found = list
        .into_iter()
        .find(|(name, _)| name == &key)
        .map(|(_, v)| v);
    eprintln!(
        "[vault] load_vault_key id={} hit={}",
        &key,
        if found.is_some() { "true" } else { "false" }
    );
    let raw = found.map(|v| decrypt_api_key_in_json(&app, &v));
    Ok(raw)
}

/// 删除一个 Vault。
#[tauri::command]
fn delete_vault(app: AppHandle, key: String) -> Result<(), String> {
    let k = key.trim().to_string();
    let mut list = read_ep_store(&app);
    list.retain(|(name, _)| name != &k);
    write_ep_store(&app, &list)?;
    let _ = keyring::Entry::new(KEYRING_SERVICE, &k).and_then(|e| e.delete_credential());
    Ok(())
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
/// - 只接受 Git top-level 上的有限只读 probe；不暴露 worktree add/remove、branch delete、
///   prune、config、merge、checkout、push 等 mutation 能力。
///
/// 调用示例：`invoke('run_git', { args: ['rev-parse', '--is-inside-work-tree'], cwd })`
fn safe_git_revision(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && !value.contains("..")
        && !value.contains("//")
        && !value
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '>' | '<'))
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.'))
}

fn run_git_readonly_args(args: &[String]) -> bool {
    match args {
        [sub, flag] if sub == "rev-parse" && flag == "--is-inside-work-tree" => true,
        [sub, rev] if sub == "rev-parse" && rev == "HEAD" => true,
        [sub, flag] if sub == "status" && (flag == "--porcelain" || flag == "--short") => true,
        [sub, rev] if sub == "diff" && safe_git_revision(rev) => true,
        [sub, flag, rev] if sub == "diff" && flag == "--name-only" && safe_git_revision(rev) => {
            true
        }
        [sub, flag, rev] if sub == "diff" && flag == "--stat" && safe_git_revision(rev) => true,
        [sub, flag, n] if sub == "log" && flag == "-n" && n.parse::<u32>().is_ok() => true,
        [sub, pretty, flag, n]
            if sub == "log"
                && pretty == "--oneline"
                && flag == "-n"
                && n.parse::<u32>().is_ok() =>
        {
            true
        }
        [sub, a, b] if sub == "ls-files" && a == "--others" && b == "--exclude-standard" => true,
        [sub, flag] if sub == "branch" && flag == "--list" => true,
        [sub, action] if sub == "worktree" && action == "list" => true,
        [sub, action, porcelain]
            if sub == "worktree" && action == "list" && porcelain == "--porcelain" =>
        {
            true
        }
        _ => false,
    }
}

fn apply_dev_env(command: &mut Command) {
    command.env_clear();
    for (key, value) in dev_sanitized_env() {
        command.env(key, value);
    }
}

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

    if !run_git_readonly_args(&args) {
        return Err("run_git: legacy 命令只允许只读 Git probe；worktree 生命周期必须走 H4 WorktreeManager/dev_exec".to_string());
    }
    let mut probe = Command::new(resolve_dev_program("git"));
    probe
        .arg("-C")
        .arg(&canon)
        .args(["rev-parse", "--show-toplevel"]);
    apply_dev_env(&mut probe);
    let probe_output = probe
        .output()
        .map_err(|e| format!("run_git: Git top-level probe 失败：{e}"))?;
    if !probe_output.status.success() {
        return Err("run_git: cwd 不是可验证的 Git top-level".to_string());
    }
    let top = std::path::PathBuf::from(String::from_utf8_lossy(&probe_output.stdout).trim())
        .canonicalize()
        .map_err(|_| "run_git: Git top-level 输出无效".to_string())?;
    if path_compare_key(&top.to_string_lossy()) != path_compare_key(&canon.to_string_lossy()) {
        return Err("run_git: cwd 必须是 Git repository top-level".to_string());
    }

    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.current_dir(&canon)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_dev_env(&mut cmd);
    for a in &args {
        cmd.arg(a);
    }
    let output = run_with_timeout(&mut cmd, std::time::Duration::from_secs(30))?;
    Ok(GitResult {
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.code,
    })
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
        return Err(format!(
            "grant_project_access: 路径不存在或不是目录：{path}"
        ));
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "grant_project_access: 路径禁止包含 '..' 逃逸：{path}"
        ));
    }
    // canonicalize 归一化真实路径（解析符号链接/`.`/大小写差异），
    // 既保证 scope 注入的是磁盘真实路径，也避免同一目录的不同写法重复授权。
    let canon = p
        .canonicalize()
        .map_err(|e| format!("grant_project_access: 路径解析失败：{path}（{e}）"))?;
    let canon_str = canon.to_string_lossy().to_string();

    // 幂等去重：同路径 1 秒内重复授权直接返回，避免高频调用反复重建 capability
    //（曾致 Rust 主线程死循环、CPU 打满、WebView 输入事件冻结——每条 capability 都会
    //  参与每次 fs 操作的权限校验，列表越滚越长越慢）。
    use std::time::{Duration, Instant};
    static LAST_GRANT: std::sync::Mutex<Option<(String, Instant)>> = std::sync::Mutex::new(None);
    {
        let mut last = LAST_GRANT.lock().unwrap();
        if let Some((prev, at)) = &*last {
            if path_compare_key(prev) == path_compare_key(&canon_str)
                && at.elapsed() < Duration::from_secs(1)
            {
                return Ok(()); // 同路径近期已授权，跳过
            }
        }
        *last = Some((canon_str.clone(), Instant::now()));
    }

    // 使用 Tauri 官方 FsExt::fs_scope().allow_directory()：幂等（重复加同路径自动去重）、
    // 无需重建 capability，也不受 add_capability 累积影响。recursive=true 允许子目录。
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope
        .allow_directory(&canon, true)
        .map_err(|e| format!("grant_project_access: 注入 fs scope 失败：{path}（{e}）"))?;
    eprintln!("[cap] grant_project_access ok: {path}");
    Ok(())
}

/* ---------------- H4 GUI 宿主受控命令通道（Phase 1） ----------------
 * GUI（WebView）无法直接执行系统命令/文件操作（node:child_process 经 vite shim 抛错）。
 * 这里把 DevSession 的执行层下沉到 Rust 宿主：
 * - dev_exec：命令名白名单 + cwd 必须属于「已登记 worktree 或主仓库根」+ 剥离凭据 env + 超时；
 * - dev_read_file / dev_write_file：文件路径必须属于已登记 worktree（防任意读写宿主磁盘）；
 * - dev_init_session / dev_register_worktree / dev_unregister_worktree：维护宿主登记态。
 * 前端仍保留完整的参数级白名单（capabilities DEFAULT_SHELL_RULES/DEFAULT_TEST_RULES），
 * Rust 侧命令名 + cwd 白名单作为纵深防御（WebView 被 XSS 也不能在 worktree 外执行命令）。
 */

#[derive(serde::Serialize)]
struct DevExecResult {
    stdout: String,
    stderr: String,
    code: i32,
}

/// 命令名白名单（与前端 capabilities 的 DEFAULT_SHELL_RULES / DEFAULT_TEST_RULES 命令名一致）。
const DEV_ALLOWED_CMDS: &[&str] = &[
    "pwd", "echo", "ls", "cat", "find", "head", "tail", "grep", "git", "node", "tsc", "vitest", "tsx",
    "npm",
];

/// Windows 下 PATH 中的 npm/tsx/tsc/vitest 通常是 `.cmd` shim，
/// `std::process::Command::new("npm")` 不会像 shell 一样自动补全扩展名。
/// 命令名已经先经过 DEV_ALLOWED_CMDS 白名单，因此这里只负责确定真实可执行文件。
#[cfg(windows)]
fn resolve_dev_program_from_path(
    name: &str,
    search_path: Option<&std::ffi::OsStr>,
) -> std::path::PathBuf {
    let raw = std::path::PathBuf::from(name);
    if raw.components().count() > 1 || raw.extension().is_some() {
        return raw;
    }

    if let Some(search_path) = search_path {
        for dir in std::env::split_paths(search_path) {
            for extension in [".com", ".exe", ".bat", ".cmd"] {
                let candidate = dir.join(format!("{name}{extension}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
            let direct = dir.join(name);
            if direct.is_file() {
                return direct;
            }
        }
    }
    raw
}

#[cfg(not(windows))]
fn resolve_dev_program_from_path(
    name: &str,
    _search_path: Option<&std::ffi::OsStr>,
) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
}

fn resolve_dev_program(name: &str) -> std::path::PathBuf {
    resolve_dev_program_from_path(name, std::env::var_os("PATH").as_deref())
}

/// 解析为绝对路径：相对路径基于 base_repo（GUI 下 worktree path 常相对 projectPath）。
fn dev_abs_of(raw: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(raw);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let state = DEV_STATE.lock().unwrap();
        let base = state
            .base_repo
            .as_ref()
            .ok_or_else(|| format!("路径是相对的，但未初始化主仓库根：{raw}"))?;
        std::path::Path::new(base).join(p)
    };
    match joined.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = joined
                .parent()
                .ok_or_else(|| format!("无法解析路径父目录：{raw}"))?
                .canonicalize()
                .map_err(|e| format!("无法解析路径父目录（{raw}）：{e}"))?;
            let name = joined
                .file_name()
                .ok_or_else(|| format!("路径缺少文件名：{raw}"))?;
            Ok(parent.join(name))
        }
        Err(error) => Err(format!("无法解析路径（{raw}）：{error}")),
    }
}

/// cwd 归属：主仓库根 或 已登记 worktree（或其子目录）。
/// 支持相对路径（基于主仓库根解析）。
#[derive(PartialEq, Clone)]
enum DevCwdKind {
    MainRepo,
    Worktree(std::path::PathBuf),
}

/// 判定 cwd 归属（主仓库根 / 已登记 worktree）。
fn dev_cwd_kind(cwd: &str) -> Result<DevCwdKind, String> {
    let p = std::path::Path::new(cwd);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("dev_exec: cwd 禁止包含 '..' 路径逃逸：{cwd}"));
    }
    let canon = dev_abs_of(cwd)?; // 相对路径基于 base_repo 解析；绝对路径 canonicalize
    if !canon.is_dir() {
        return Err(format!("dev_exec: cwd 不存在或不是目录：{cwd}"));
    }
    let state = DEV_STATE.lock().unwrap();
    let norm_canon = dev_strip_verbatim(&canon);
    if let Some(base) = &state.base_repo {
        // `base_repo` is a registration-time canonical identity. Do not
        // canonicalize it again: a replaced junction/reparse point must not
        // redefine the identity of the active session.
        let bc = std::path::PathBuf::from(base);
        if path_compare_key(&norm_canon.to_string_lossy())
            == path_compare_key(&bc.to_string_lossy())
        {
            return Ok(DevCwdKind::MainRepo);
        }
    }
    for w in &state.worktrees {
        // `worktrees` stores the canonical path captured at registration.
        // Re-canonicalizing here would follow a replacement junction and
        // could make an outside directory appear to be the old worktree.
        let norm_wc = dev_strip_verbatim(std::path::Path::new(w));
        if path_is_same_or_child(&norm_canon, &norm_wc) {
            return Ok(DevCwdKind::Worktree(norm_wc));
        }
    }
    Err(format!(
        "dev_exec: cwd 不属于已登记 worktree 或主仓库根：{cwd}"
    ))
}

/// Codex Worker 专用 cwd 守卫：只允许已登记 worktree，不允许主仓库根或任意子路径。
pub(crate) fn assert_registered_worktree(cwd: &str) -> Result<PathBuf, String> {
    match dev_cwd_kind(cwd)? {
        DevCwdKind::Worktree(path) => Ok(path),
        DevCwdKind::MainRepo => {
            Err("Codex Worker 拒绝在主仓库根执行，必须使用已登记 worktree".into())
        }
    }
}

fn path_compare_key(raw: &str) -> String {
    let mut normalized = raw.replace('\\', "/").trim_end_matches('/').to_string();
    if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
        normalized = format!("//{unc}");
    } else if let Some(verbatim) = normalized.strip_prefix("//?/") {
        normalized = verbatim.to_string();
    }
    #[cfg(windows)]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

fn path_is_same_or_child(path: &std::path::Path, root: &std::path::Path) -> bool {
    let path = path_compare_key(&path.to_string_lossy());
    let root = path_compare_key(&root.to_string_lossy());
    path == root || path.starts_with(&(root + "/"))
}

/// 主仓库根允许的 git 子命令（严格只读 / worktree 生命周期管理）。
/// 主仓库根是宿主受保护目录——禁止 npm/tsx/写入型 git（apply/commit/push/reset 等），
/// 防止 WebView 直接调 dev_exec 在主仓库执行修改文件的命令。
fn dev_main_repo_git_allowed(args: &[String]) -> bool {
    if args.first().map(|s| s.as_str()) != Some("git") {
        return false;
    }
    let exact = |want: &[&str]| args.iter().map(|s| s.as_str()).eq(want.iter().copied());
    exact(&["git", "rev-parse", "HEAD"])
        || exact(&["git", "rev-parse", "--show-toplevel"])
        || exact(&["git", "worktree", "list"])
        || exact(&["git", "worktree", "list", "--porcelain"])
        || exact(&["git", "branch", "--list"])
        || exact(&["git", "branch", "-a"])
        || exact(&["git", "status", "--porcelain"])
        || exact(&["git", "status", "--short"])
        || exact(&["git", "diff", "HEAD"])
        || exact(&["git", "diff", "--name-only", "HEAD"])
        || exact(&["git", "diff", "--stat", "HEAD"])
        || exact(&["git", "diff", "--name-only"])
        || exact(&["git", "ls-files", "--others", "--exclude-standard"])
        || (args.len() == 5
            && args[1] == "log"
            && args[2] == "--oneline"
            && args[3] == "-n"
            && args[4].chars().all(|c| c.is_ascii_digit()))
}

fn worker_name_is_valid(name: &str) -> bool {
    name.len() <= 200
        && !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.to_ascii_lowercase().ends_with(".lock")
}

fn worker_branch_is_valid(branch: &str) -> bool {
    let Some(suffix) = branch.strip_prefix("worker/") else {
        return false;
    };
    worker_name_is_valid(suffix)
}

fn is_full_object_id(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn worker_branch_from_tip_arg(arg: &str) -> Option<&str> {
    let branch_ref = arg.strip_suffix("^{commit}")?.strip_prefix("refs/heads/")?;
    worker_branch_is_valid(branch_ref).then_some(branch_ref)
}

fn worker_branch_from_ref_arg(arg: &str) -> Option<&str> {
    let branch = arg.strip_prefix("refs/heads/")?;
    worker_branch_is_valid(branch).then_some(branch)
}

fn worker_target_is_valid(repo: &std::path::Path, raw_path: &str) -> bool {
    if raw_path.is_empty() {
        return false;
    }
    let raw = std::path::Path::new(raw_path);
    if raw
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return false;
    }
    let target = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        repo.join(raw)
    };
    let Some(parent) = target.parent() else {
        return false;
    };
    let Some(name) = target.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let worker_root = std::path::PathBuf::from(format!("{}-workers", repo.to_string_lossy()));
    path_compare_key(&parent.to_string_lossy()) == path_compare_key(&worker_root.to_string_lossy())
        && worker_name_is_valid(name)
}

fn main_repo_worktree_target_is_valid(
    repo: &std::path::Path,
    raw_path: &str,
    branch: &str,
) -> bool {
    if !worker_branch_is_valid(branch) || !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let name = std::path::Path::new(raw_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    branch.strip_prefix("worker/") == Some(name)
}

fn main_repo_worktree_args_are_valid(repo: &std::path::Path, args: &[String]) -> bool {
    if args.first().map(|value| value.as_str()) != Some("git")
        || args.get(1).map(|value| value.as_str()) != Some("worktree")
    {
        return false;
    }
    match args.get(2).map(|value| value.as_str()) {
        Some("add")
            if args.len() == 8 && args[3] == "-q" && args[5] == "-b" && args[7] == "HEAD" =>
        {
            main_repo_worktree_target_is_valid(repo, &args[4], &args[6])
        }
        Some("add") if args.len() == 7 && args[4] == "-b" && args[6] == "HEAD" => {
            main_repo_worktree_target_is_valid(repo, &args[3], &args[5])
        }
        Some("remove") if args.len() == 5 && args[3] == "--force" => {
            worker_target_is_valid(repo, &args[4])
        }
        Some("lock") | Some("unlock") if args.len() == 4 => worker_target_is_valid(repo, &args[3]),
        _ => false,
    }
}

fn main_repo_worktree_add_spec(args: &[String]) -> Option<(&str, &str)> {
    if args.first().map(|value| value.as_str()) != Some("git")
        || args.get(1).map(|value| value.as_str()) != Some("worktree")
        || args.get(2).map(|value| value.as_str()) != Some("add")
    {
        return None;
    }
    if args.len() == 8 && args[3] == "-q" && args[5] == "-b" && args[7] == "HEAD" {
        return Some((&args[4], &args[6]));
    }
    if args.len() == 7 && args[4] == "-b" && args[6] == "HEAD" {
        return Some((&args[3], &args[5]));
    }
    None
}

fn repo_target_path(repo: &std::path::Path, raw_path: &str) -> std::path::PathBuf {
    let raw = std::path::Path::new(raw_path);
    if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        repo.join(raw)
    }
}

fn worker_root_path(repo: &std::path::Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}-workers", repo.to_string_lossy()))
}

struct WorktreeAddRootGuard {
    #[cfg(windows)]
    _root: fs::File,
}

fn hold_worktree_add_root(root: &std::path::Path) -> Result<WorktreeAddRootGuard, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        const FILE_SHARE_WRITE: u32 = 0x00000002;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(root)
            .map_err(|error| {
                format!(
                    "dev_exec: 无法锁定 Worker root：{}（{error}）",
                    root.display()
                )
            })?;
        return Ok(WorktreeAddRootGuard { _root: file });
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Ok(WorktreeAddRootGuard {})
    }
}

/// Check the real worker root immediately before `git worktree add`.
/// A lexical parent check alone can follow a pre-existing symlink/junction out of the project.
fn worktree_add_target_is_safe(
    repo: &std::path::Path,
    raw_path: &str,
    branch: &str,
) -> Result<WorktreeAddRootGuard, String> {
    if !main_repo_worktree_target_is_valid(repo, raw_path, branch) {
        return Err("dev_exec: worktree add 的路径/分支不合法".to_string());
    }
    let worker_root = worker_root_path(repo);
    let worker_root_key = path_compare_key(&worker_root.to_string_lossy());
    let worker_parent = worker_root
        .parent()
        .ok_or_else(|| "dev_exec: Worker root 缺少父目录".to_string())?;
    let real_worker_parent = worker_parent.canonicalize().map_err(|error| {
        format!(
            "dev_exec: Worker root 父目录无法 canonicalize：{}（{error}）",
            worker_parent.display()
        )
    })?;
    if path_compare_key(&real_worker_parent.to_string_lossy())
        != path_compare_key(&worker_parent.to_string_lossy())
    {
        return Err("dev_exec: Worker root 父目录 realpath 不匹配".to_string());
    }

    match fs::symlink_metadata(&worker_root) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(format!(
                    "dev_exec: Worker root 不是目录，拒绝 worktree add：{}",
                    worker_root.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&worker_root).map_err(|create_error| {
                format!(
                    "dev_exec: 无法创建 Worker root：{}（{create_error}）",
                    worker_root.display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "dev_exec: 无法安全检查 Worker root：{}（{error}）",
                worker_root.display()
            ));
        }
    }

    let real_root = worker_root.canonicalize().map_err(|error| {
        format!(
            "dev_exec: Worker root 无法 canonicalize，拒绝 worktree add：{}（{error}）",
            worker_root.display()
        )
    })?;
    if !real_root.is_dir() {
        return Err(format!(
            "dev_exec: Worker root 不是目录，拒绝 worktree add：{}",
            worker_root.display()
        ));
    }
    if path_compare_key(&real_root.to_string_lossy()) != worker_root_key {
        return Err(format!(
            "dev_exec: Worker root 是 symlink/junction，拒绝 worktree add：{}",
            worker_root.display()
        ));
    }

    let target = repo_target_path(repo, raw_path);
    let parent = target
        .parent()
        .ok_or_else(|| "dev_exec: worktree target 缺少父目录".to_string())?;
    let real_parent = parent.canonicalize().map_err(|error| {
        format!(
            "dev_exec: worktree target 父目录无法 canonicalize：{}（{error}）",
            parent.display()
        )
    })?;
    if path_compare_key(&real_parent.to_string_lossy())
        != path_compare_key(&real_root.to_string_lossy())
    {
        return Err("dev_exec: worktree target 父目录 realpath 不匹配 Worker root".to_string());
    }
    match fs::symlink_metadata(&target) {
        Ok(_) => Err(format!(
            "dev_exec: worktree target 已存在，拒绝覆盖或跟随链接：{}",
            target.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(hold_worktree_add_root(&worker_root)?)
        }
        Err(error) => Err(format!(
            "dev_exec: 无法安全检查 worktree target：{}（{error}）",
            target.display()
        )),
    }
}

/// A successful add owns a short-lived rollback lease until registration completes.
/// It is intentionally narrower than the normal registered-worktree gate.
fn pending_worker_target(repo: &std::path::Path, raw_path: &str) -> bool {
    if !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let target = repo_target_path(repo, raw_path);
    let state = DEV_STATE.lock().unwrap();
    state.pending_worktrees.iter().any(|pending| {
        pending.generation == state.generation
            && !pending.removed
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
    })
}

fn pending_worker_branch(repo: &std::path::Path, branch: &str) -> bool {
    let Some(name) = branch.strip_prefix("worker/") else {
        return false;
    };
    if !worker_name_is_valid(name) {
        return false;
    }
    let target = std::path::PathBuf::from(format!("{}-workers/{name}", repo.to_string_lossy()));
    let state = DEV_STATE.lock().unwrap();
    state.pending_worktrees.iter().any(|pending| {
        pending.generation == state.generation
            && pending.removed
            && pending.branch == branch
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
    })
}

fn pending_worker_branch_any(repo: &std::path::Path, branch: &str) -> bool {
    let Some(name) = branch.strip_prefix("worker/") else {
        return false;
    };
    if !worker_name_is_valid(name) {
        return false;
    }
    let target = std::path::PathBuf::from(format!("{}-workers/{name}", repo.to_string_lossy()));
    let state = DEV_STATE.lock().unwrap();
    state.pending_worktrees.iter().any(|pending| {
        pending.generation == state.generation
            && pending.branch == branch
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
    })
}

fn orphan_worker_branch(repo: &std::path::Path, branch: &str) -> bool {
    let Some(name) = branch.strip_prefix("worker/") else {
        return false;
    };
    if !worker_name_is_valid(name) {
        return false;
    }
    let target = std::path::PathBuf::from(format!("{}-workers/{name}", repo.to_string_lossy()));
    let state = DEV_STATE.lock().unwrap();
    state.orphan_worktrees.iter().any(|orphan| {
        orphan.generation == state.generation
            && orphan.branch == branch
            && path_compare_key(&orphan.path) == path_compare_key(&target.to_string_lossy())
    })
}

fn record_pending_worktree_add(repo: &std::path::Path, raw_path: &str, branch: &str) {
    if !main_repo_worktree_target_is_valid(repo, raw_path, branch) {
        return;
    }
    let target = repo_target_path(repo, raw_path);
    let stored_path = target
        .canonicalize()
        .unwrap_or(target)
        .to_string_lossy()
        .to_string();
    let mut state = DEV_STATE.lock().unwrap();
    if state
        .base_repo
        .as_deref()
        .is_none_or(|base| path_compare_key(base) != path_compare_key(&repo.to_string_lossy()))
    {
        return;
    }
    if !state.pending_worktrees.iter().any(|pending| {
        path_compare_key(&pending.path) == path_compare_key(&stored_path)
            && pending.branch == branch
    }) {
        let generation = state.generation;
        state.pending_worktrees.push(PendingWorktree {
            generation,
            path: stored_path,
            branch: branch.to_string(),
            removed: false,
        });
    }
}

fn update_pending_worktree_after_success(repo: &std::path::Path, args: &[String]) {
    if let Some((raw_path, branch)) = main_repo_worktree_add_spec(args) {
        record_pending_worktree_add(repo, raw_path, branch);
        return;
    }
    if args.len() == 5
        && args[0] == "git"
        && args[1] == "worktree"
        && args[2] == "remove"
        && args[3] == "--force"
    {
        let target = repo_target_path(repo, &args[4]);
        let mut state = DEV_STATE.lock().unwrap();
        if let Some(pending) = state.pending_worktrees.iter_mut().find(|pending| {
            path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
        }) {
            pending.removed = true;
        }
        return;
    }
    if args.len() == 5 && args[0] == "git" && args[1] == "update-ref" && args[2] == "-d" {
        if let Some(branch) = worker_branch_from_ref_arg(&args[3]) {
            let mut state = DEV_STATE.lock().unwrap();
            state
                .pending_worktrees
                .retain(|pending| pending.branch != branch);
        }
    }
}

fn registered_worker_target(repo: &std::path::Path, raw_path: &str) -> bool {
    if !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let target = if std::path::Path::new(raw_path).is_absolute() {
        std::path::PathBuf::from(raw_path)
    } else {
        repo.join(raw_path)
    };
    let state = DEV_STATE.lock().unwrap();
    state
        .worktrees
        .iter()
        .any(|path| path_compare_key(path) == path_compare_key(&target.to_string_lossy()))
}

fn registered_worker_branch(repo: &std::path::Path, branch: &str) -> bool {
    let Some(name) = branch.strip_prefix("worker/") else {
        return false;
    };
    registered_worker_target(repo, &format!("{}-workers/{name}", repo.to_string_lossy()))
}

fn dev_main_repo_git_allowed_at(args: &[String], repo: Option<&std::path::Path>) -> bool {
    if matches!(args.get(1).map(|value| value.as_str()), Some("worktree"))
        && matches!(
            args.get(2).map(|value| value.as_str()),
            Some("add") | Some("remove") | Some("lock") | Some("unlock")
        )
    {
        return repo.is_some_and(|path| {
            if !main_repo_worktree_args_are_valid(path, args) {
                return false;
            }
            match args[2].as_str() {
                "add" => true,
                "remove" => args
                    .last()
                    .is_some_and(|target| pending_worker_target(path, target)),
                "lock" | "unlock" => args
                    .last()
                    .is_some_and(|target| registered_worker_target(path, target)),
                _ => false,
            }
        });
    }
    if args.len() == 5
        && args[1] == "rev-parse"
        && args[2] == "--verify"
        && args[3] == "--end-of-options"
    {
        return repo.is_some_and(|path| {
            let Some(branch) = worker_branch_from_tip_arg(&args[4]) else {
                return false;
            };
            registered_worker_branch(path, branch)
                || pending_worker_branch_any(path, branch)
                || orphan_worker_branch(path, branch)
        });
    }
    if args.len() == 5 && args[1] == "update-ref" && args[2] == "-d" {
        return repo.is_some_and(|path| {
            let Some(branch) = worker_branch_from_ref_arg(&args[3]) else {
                return false;
            };
            is_full_object_id(&args[4]) && pending_worker_branch(path, branch)
        });
    }
    dev_main_repo_git_allowed(args)
}

/// 与 Node 侧 sanitizeEnv 对齐：凭据变量采用稳定 suffix 词元而非有限名单。
pub(crate) fn is_safe_env_name(name: &str) -> bool {
    const SAFE: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_MESSAGES",
        "TERM",
        "COLORTERM",
        "CI",
        "FORCE_COLOR",
        "NODE_ENV",
    ];
    let upper = name.to_ascii_uppercase();
    SAFE.iter().any(|safe| upper == *safe)
}

pub(crate) fn is_credential_env_name(name: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "API_KEY",
        "APIKEY",
        "TOKEN",
        "PAT",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PASS",
        "PASSPHRASE",
        "PRIVATE_KEY",
        "ACCESS_KEY",
        "ACCESS_KEY_ID",
        "CLIENT_SECRET",
        "APPLICATION_CREDENTIAL",
        "APPLICATION_CREDENTIALS",
        "CREDENTIAL",
        "CREDENTIALS",
        "AUTH",
        "AUTHORIZATION",
        "SIGNING_KEY",
        "ENCRYPTION_KEY",
        "MASTER_KEY",
        "CERT",
        "CERTIFICATE",
        "KEY",
        "COOKIE",
        "BEARER",
        "CONNECTION_STRING",
        "DATABASE_URL",
        "DB_URL",
        "DSN",
        "USERCONFIG",
        "DOCKER_CONFIG",
        "SESSION",
    ];
    let upper = name.to_ascii_uppercase();
    SUFFIXES
        .iter()
        .any(|suffix| upper == *suffix || upper.ends_with(&format!("_{suffix}")))
}

/// 剥离凭据环境变量 + 注入 git 非交互配置（与前端 sanitizeEnv 对齐）。
pub(crate) fn dev_sanitized_env() -> HashMap<String, String> {
    dev_sanitized_env_with_home(true)
}

pub(crate) fn dev_login_sanitized_env() -> HashMap<String, String> {
    dev_sanitized_env_with_home(false)
}

fn dev_sanitized_env_with_home(isolate_home: bool) -> HashMap<String, String> {
    const DENY: &[&str] = &[
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITLAB_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_API_KEY_1",
        "AZURE_OPENAI_API_KEY_2",
        "HF_TOKEN",
        "HUGGING_FACE_HUB_TOKEN",
        "REPLICATE_API_TOKEN",
    ];
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.retain(|key, _| {
        is_safe_env_name(key) && !is_credential_env_name(key) && !DENY.contains(&key.as_str())
    });
    if isolate_home {
        let home = std::env::temp_dir().join("slimemold-worker-home");
        let home = home.to_string_lossy().to_string();
        env.insert("HOME".into(), home.clone());
        env.insert("USERPROFILE".into(), home.clone());
        env.insert("APPDATA".into(), format!("{home}/appdata"));
        env.insert("LOCALAPPDATA".into(), format!("{home}/localappdata"));
        env.insert("NPM_CONFIG_USERCONFIG".into(), format!("{home}/npmrc"));
        env.insert(
            "NPM_CONFIG_GLOBALCONFIG".into(),
            format!("{home}/global-npmrc"),
        );
        env.insert("NPM_CONFIG_CACHE".into(), format!("{home}/npm-cache"));
    }
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    env
}

/// 带超时的子进程执行，返回 stdout/stderr/exitCode（非零退出码不视为错误）。
fn drain_child_output<R: std::io::Read>(mut reader: R) -> Vec<u8> {
    const CAP: usize = 16 * 1024 * 1024;
    let mut captured = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => size,
        };
        if total < CAP {
            let keep = read.min(CAP - total);
            captured.extend_from_slice(&buffer[..keep]);
        }
        total = total.saturating_add(read);
    }
    captured
}

fn kill_dev_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .status();
    }
    let _ = child.kill();
}

fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<DevExecResult, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = cmd.spawn().map_err(|e| format!("命令启动失败：{e}"))?;
    let stdout = child
        .stdout
        .take()
        .map(|stream| std::thread::spawn(move || drain_child_output(stream)));
    let stderr = child
        .stderr
        .take()
        .map(|stream| std::thread::spawn(move || drain_child_output(stream)));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                kill_dev_child_tree(&mut child);
                let _ = child.wait();
                let _ = stdout.map(|thread| thread.join());
                let _ = stderr.map(|thread| thread.join());
                return Err("dev_exec 执行超时（30s）".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                kill_dev_child_tree(&mut child);
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

/// worktree 内命令的文件路径参数**词法级**校验（纯函数，无 IO，可单测）。
/// 拦截：绝对路径（POSIX `/`、Windows `C:\`、UNC `\\`）、`..` 逃逸、`~`、shell 元字符重定向。
/// `*`/`?` 保留为直接 spawn 的 find/grep 模式操作数；Rust 不经过 shell，不会发生 shell 展开。
/// 注意：词法校验不解析符号链接，symlink 逃逸由 dev_exec_validate_paths 的 canonicalize 层兜底。
fn dev_arg_path_lexically_safe(arg: &str) -> bool {
    if arg.is_empty() || arg == "." || arg == ".." {
        return false;
    }
    let p = std::path::Path::new(arg);
    // 绝对路径：POSIX 根 / Windows drive / UNC
    if p.is_absolute() {
        return false;
    }
    // Windows drive 前缀（如 `C:` / `C:\`）在 is_absolute 上未必为 true，需显式排除
    let bytes = arg.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    if arg.starts_with("\\\\") || arg.starts_with("//") {
        return false;
    }
    // `..` 任意位置的父目录逃逸
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    // 家目录展开符号
    if arg == "~" || arg.starts_with("~/") || arg.starts_with("~\\") {
        return false;
    }
    // shell 元字符（重定向 / 管道 / 命令拼接）——Command spawn 不经 shell，但保守拒绝
    const META: &[char] = &['>', '<', '|', '&', ';', '`', '$', '\'', '"', '(', ')', ' '];
    if arg.chars().any(|c| META.contains(&c)) {
        return false;
    }
    true
}

/// dev_exec 实际 spawn 前，对**文件路径参数**做 canonicalize 校验（解析符号链接），
/// 确认其规范化后路径仍落在 cwd（worktree 根）之内。防止通过 symlink 读取 worktree 外文件。
/// 仅对带路径参数的只读文件命令（cat/head/tail/ls/grep/find/git diff/tsx）生效。
/// 规则：不存在的路径（canonicalize 失败）按"词法已通过"放行——只读命令读不存在文件无害；
/// 但若路径存在且 canonicalize 后逃出 cwd，则拒绝。
fn dev_exec_validate_paths(cwd: &str, args: &[String]) -> Result<(), String> {
    let name = args.first().map(|s| s.as_str());
    // 每个待校验参数：与 cwd 拼接后 canonicalize，确认落在 cwd 内
    let check = |arg: &str| -> Result<(), String> {
        let wt_root = dev_strip_verbatim(std::path::Path::new(cwd));
        let joined = wt_root.join(arg);
        if let Ok(canon) = joined.canonicalize() {
            let norm = dev_strip_verbatim(&canon);
            if !path_is_same_or_child(&norm, &wt_root) {
                return Err(format!("dev_exec: 参数路径逃逸出 worktree：{arg}"));
            }
        }
        Ok(())
    };
    match name {
        Some("cat") | Some("head") | Some("tail") => {
            // 单个文件参数（如 cat src/a.ts）；多个参数合并读也是允许的，逐个校验
            for a in args.iter().skip(1) {
                if !a.starts_with('-') {
                    check(a)?;
                }
            }
        }
        Some("ls") | Some("grep") => {
            // 相对路径参数逐个校验（跳过 - 开头选项）
            for a in args.iter().skip(1) {
                if !a.starts_with('-') {
                    check(a)?;
                }
            }
        }
        Some("find") => {
            // find <根> [-options] —— 根若是相对路径（非 - 开头且非 .）则校验
            if let Some(root) = args.get(1) {
                if !root.starts_with('-') && root != "." {
                    check(root)?;
                }
            }
        }
        Some("git") => {
            // git diff <path>：最后一个非选项参数为路径
            if args.get(1).map(|s| s.as_str()) == Some("diff") {
                if let Some(path) = args.get(2) {
                    if !path.starts_with('-') {
                        check(path)?;
                    }
                }
            }
        }
        Some("tsx") => {
            // tsx scripts/xxx.ts：第一个参数为脚本路径
            if let Some(script) = args.get(1) {
                check(script)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn canonicalize_dev_exec_args(
    cwd: &std::path::Path,
    args: &[String],
) -> Result<Vec<String>, String> {
    let mut result = args.to_vec();
    let mut replace_if_existing = |index: usize| -> Result<(), String> {
        let Some(raw) = result.get(index).cloned() else {
            return Ok(());
        };
        if raw.starts_with('-') || raw == "." {
            return Ok(());
        }
        let joined = cwd.join(&raw);
        if let Ok(canon) = joined.canonicalize() {
            if !path_is_same_or_child(&canon, cwd) {
                return Err(format!("dev_exec: 参数路径逃逸出 worktree：{raw}"));
            }
            result[index] = dev_strip_verbatim(&canon).to_string_lossy().to_string();
        }
        Ok(())
    };
    match args.first().map(|value| value.as_str()) {
        Some("cat") | Some("head") | Some("tail") | Some("ls") => {
            for index in 1..args.len() {
                replace_if_existing(index)?;
            }
        }
        Some("find") | Some("tsx") => replace_if_existing(1)?,
        Some("git") if args.get(1).map(|value| value.as_str()) == Some("diff") => {
            replace_if_existing(2)?;
        }
        Some("grep") => {
            // DEFAULT_GREP_RULES 不接受 -e；第一个非 option 是 pattern，后续才是文件 operand。
            for index in 2..args.len() {
                replace_if_existing(index)?;
            }
        }
        _ => {}
    }
    Ok(result)
}

fn grep_option_is_safe(arg: &str) -> bool {
    matches!(
        arg,
        "--" | "-n"
            | "-i"
            | "-E"
            | "-F"
            | "-v"
            | "-w"
            | "-x"
            | "-l"
            | "-h"
            | "-s"
            | "--line-number"
            | "--ignore-case"
            | "--fixed-strings"
            | "--invert-match"
    )
}

fn find_option_is_safe(arg: &str) -> bool {
    matches!(
        arg,
        "-P" | "-name"
            | "-iname"
            | "-path"
            | "-ipath"
            | "-type"
            | "-maxdepth"
            | "-mindepth"
            | "-mount"
            | "-xdev"
            | "-prune"
            | "-print"
            | "-print0"
            | "-ls"
            | "-printf"
            | "-regex"
            | "-iregex"
            | "-not"
            | "!"
            | "-o"
            | "-or"
            | "-a"
            | "-and"
            | "-quit"
    )
}

/// 与前端 assertSafeGitRevision 对齐的 base revision 词法校验。
/// 这里只允许作为 git diff 的 revision 操作数，不允许路径逃逸或 shell 语义。
fn safe_git_revision_arg(arg: &str) -> bool {
    let mut chars = arg.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    arg.chars().count() <= 128
        && first.is_ascii_alphanumeric()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        && !arg.contains("..")
        && !arg.contains("//")
        && !arg.ends_with('/')
}

/// worktree 内允许的命令参数白名单（与前端 capabilities DEFAULT_SHELL_RULES / DEFAULT_TEST_RULES
/// 对齐；P1 审计：Rust 侧也做完整参数校验，WebView 直调 dev_exec 无法执行白名单外的高风险操作）。
fn dev_worktree_cmd_allowed(args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }
    let name = args[0].as_str();
    let rest = &args[1..];
    let rest_eq = |want: &[&str]| rest.iter().map(|s| s.as_str()).eq(want.iter().copied());
    match name {
        // 只读查询命令（无写盘能力：pwd/echo/ls/cat/head/tail）；文件路径参数须词法安全
        "pwd" => rest.is_empty(),
        "echo" => true, // 直接 spawn 无 shell 重定向，echo 仅输出，无害
        "ls" | "cat" | "head" | "tail" => {
            // 每个非选项参数都须为 worktree 内合法相对路径
            rest.iter()
                .filter(|a| !a.starts_with('-'))
                .all(|a| dev_arg_path_lexically_safe(a))
        }
        "find" => {
            !rest
                .iter()
                .any(|a| a.starts_with('-') && !find_option_is_safe(a))
                && rest
                    .iter()
                    .filter(|a| !a.starts_with('-'))
                    .all(|a| *a == "." || dev_arg_path_lexically_safe(a))
                && match rest.first().map(|s| s.as_str()) {
                    None | Some(".") => true,
                    Some(root) => dev_arg_path_lexically_safe(root),
                }
        }
        // grep 只读；未知选项一律拒绝，避免 --file/--exclude-from 等外部文件输入。
        "grep" => rest.iter().all(|a| {
            if a.starts_with('-') {
                grep_option_is_safe(a)
            } else {
                dev_arg_path_lexically_safe(a)
            }
        }),
        // git 只读 + 精确参数（与前端 shell 白名单 matchesRule 语义一致；明确排除所有写入型）
        "git" => {
            rest_eq(&["status", "--porcelain"])
                || rest_eq(&["status", "--short"])
                || rest_eq(&["diff", "HEAD"])
                || rest_eq(&["diff", "--name-only", "HEAD"])
                || rest_eq(&["diff", "--stat", "HEAD"])
                || rest_eq(&["diff", "--name-only"])
                || (rest.len() == 3
                    && rest[0] == "diff"
                    && rest[1] == "--name-only"
                    && safe_git_revision_arg(&rest[2]))
                // 前端 `git diff <path>`：argsPrefix ['diff']，min/maxExtra=1，禁 dash 额外参数；
                // 且路径须词法安全（禁绝对路径 / .. / drive）
                || (rest.len() == 2
                    && rest[0] == "diff"
                    && dev_arg_path_lexically_safe(&rest[1])
                    && !rest[1].starts_with('-')
                    && !rest[1].contains("--output=")
                    && !rest[1].contains("--no-index")
                    && !rest[1].contains("--ext-diff"))
                // 前端 `git log --oneline -n <num>`：argsPrefix ['log','--oneline','-n']，恰好 1 个数字参数
                || (rest.len() == 4
                    && rest[0] == "log"
                    && rest[1] == "--oneline"
                    && rest[2] == "-n"
                    && rest[3].chars().all(|c| c.is_ascii_digit()))
                || rest_eq(&["ls-files", "--others", "--exclude-standard"])
                || rest_eq(&["rev-parse", "HEAD"])
        }
        // 测试命令（与前端 DEFAULT_TEST_RULES 一致）
        "node" => {
            rest.len() == 2
                && rest[0] == "--check"
                && dev_arg_path_lexically_safe(&rest[1])
                && !rest[1].starts_with('-')
        }
        "tsc" => {
            rest_eq(&["--noEmit"])
                || rest_eq(&["-b"])
                || (rest.len() >= 4
                    && rest[0] == "--noEmit"
                    && rest[1] == "--target"
                    && rest[2] == "es2020"
                    && rest[3..].len() <= 20
                    && rest[3..].iter().all(|arg| {
                        !arg.starts_with('-') && dev_arg_path_lexically_safe(arg)
                    }))
                || (rest.len() >= 2
                    && rest[0] == "--noEmit"
                    && rest[1..].len() <= 20
                    && rest[1..].iter().all(|arg| {
                        !arg.starts_with('-') && dev_arg_path_lexically_safe(arg)
                    }))
        }
        "vitest" => rest_eq(&["run"]),
        "tsx" => {
            // 仅本地脚本 scripts/ 前缀 + 最多 2 个额外参数；脚本路径须词法安全
            !rest.is_empty()
                && rest[0].starts_with("scripts/")
                && !rest[0].starts_with("scripts/../")
                && dev_arg_path_lexically_safe(&rest[0])
                && rest.len() <= 3
                && !rest[1..].iter().any(|a| a.starts_with('-'))
        }
        "npm" => {
            rest_eq(&["run", "test"])
                || rest_eq(&["run", "build"])
                || rest_eq(&["run", "i18n:check"])
        }
        _ => false,
    }
}

/// 判定 dev_exec 是否放行（cwd 归属 + 命令 + 参数）。
/// 纯函数，便于 Rust 单元测试覆盖主仓库根权限边界。
#[allow(dead_code)]
fn dev_exec_allowed(kind: &DevCwdKind, args: &[String]) -> bool {
    dev_exec_allowed_at(kind, args, None)
}

fn dev_exec_allowed_at(
    kind: &DevCwdKind,
    args: &[String],
    main_repo: Option<&std::path::Path>,
) -> bool {
    if args.is_empty() {
        return false;
    }
    let name = args[0].as_str();
    if !DEV_ALLOWED_CMDS.contains(&name) {
        return false;
    }
    match kind {
        DevCwdKind::MainRepo => dev_main_repo_git_allowed_at(args, main_repo),
        DevCwdKind::Worktree(_) => dev_worktree_cmd_allowed(args),
    }
}

#[cfg(windows)]
fn windows_cmd_arg(value: &str) -> String {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn command_for_dev_exec(args: &[String]) -> std::process::Command {
    let program = resolve_dev_program(&args[0]);
    #[cfg(windows)]
    {
        let extension = program.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("cmd" | "bat")) {
            let command_line = std::iter::once(format!("\"{}\"", program.display()))
                .chain(args[1..].iter().map(|arg| windows_cmd_arg(arg)))
                .collect::<Vec<_>>()
                .join(" ");
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/D", "/C"]).arg(command_line);
            return command;
        }
    }
    let mut command = std::process::Command::new(program);
    command.args(&args[1..]);
    command
}

/// H4 GUI 受控命令执行：
/// - 命令名白名单（DEV_ALLOWED_CMDS）；
/// - cwd 归属分级——主仓库根**仅放行严格只读 git 管理命令**（rev-parse/worktree list 等），
///   完整白名单（npm/tsx/写入型 git）仅在**已登记 worktree** 内可用；
/// - 剥离凭据 env + 超时。
#[tauri::command]
fn dev_exec(args: Vec<String>, cwd: String, generation: u64) -> Result<DevExecResult, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_exec")?;
    let operation_generation = generation;
    let kind = dev_cwd_kind(&cwd)?;
    let canonical_cwd = match &kind {
        DevCwdKind::MainRepo => dev_abs_of(&cwd)?,
        DevCwdKind::Worktree(path) => path.clone(),
    };
    if !dev_exec_allowed_at(&kind, &args, Some(&canonical_cwd)) {
        return Err(format!(
            "dev_exec: 命令在当前 cwd 不被允许：{}",
            args.join(" ")
        ));
    }
    let _worktree_add_guard = if matches!(kind, DevCwdKind::MainRepo) {
        main_repo_worktree_add_spec(&args)
            .map(|(raw_path, branch)| worktree_add_target_is_safe(&canonical_cwd, raw_path, branch))
            .transpose()?
    } else {
        None
    };
    // P1 兜底：对文件路径参数做 canonicalize（解析符号链接）校验，确认未逃逸出 worktree
    dev_exec_validate_paths(&canonical_cwd.to_string_lossy(), &args)?;
    let spawn_args = canonicalize_dev_exec_args(&canonical_cwd, &args)?;
    let mut cmd = command_for_dev_exec(&spawn_args);
    cmd.current_dir(&canonical_cwd);
    cmd.env_clear();
    for (k, v) in dev_sanitized_env() {
        cmd.env(k, v);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(30))?;
    if DEV_STATE.lock().unwrap().generation != operation_generation {
        return Err("dev_exec: session 在命令执行期间发生变化".to_string());
    }
    if result.code == 0 && matches!(kind, DevCwdKind::MainRepo) {
        update_pending_worktree_after_success(&canonical_cwd, &args);
    }
    Ok(result)
}

fn git_top_level(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_dev_env(&mut cmd);
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if result.code != 0 {
        return Err("Git top-level probe 失败".to_string());
    }
    std::path::PathBuf::from(result.stdout.trim())
        .canonicalize()
        .map_err(|_| "Git top-level 输出无效".to_string())
}

/// 初始化 H4 宿主登记态（GUI 打开项目 / DevSession 初始化时调用）。
#[tauri::command]
fn dev_init_session(base_repo: String) -> Result<u64, String> {
    let _operation_guard = lock_dev_operation();
    let p = std::path::Path::new(&base_repo);
    if !p.exists() || !p.is_dir() {
        return Err(format!(
            "dev_init_session: 主仓库不存在或不是目录：{base_repo}"
        ));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("dev_init_session: 路径解析失败：{base_repo}（{e}）"))?;
    let top = git_top_level(&canon)?;
    if path_compare_key(&top.to_string_lossy()) != path_compare_key(&canon.to_string_lossy()) {
        return Err("dev_init_session: baseRepo 必须是 Git repository top-level".to_string());
    }
    let mut st = DEV_STATE.lock().unwrap();
    st.generation = next_session_generation(st.generation);
    st.base_repo = Some(canon.to_string_lossy().to_string());
    st.worktrees.clear();
    st.registrations.clear();
    st.cleanup_bindings.clear();
    st.pending_worktrees.clear();
    st.orphan_worktrees.clear();
    Ok(st.generation)
}

/// 清空 H4 宿主登记态（GUI 切换/关闭项目时先调用，避免旧项目登记态泄漏到新项目）。
#[tauri::command]
fn dev_clear_session(generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_clear_session")?;
    let mut st = DEV_STATE.lock().unwrap();
    st.generation = next_session_generation(st.generation);
    st.base_repo = None;
    st.worktrees.clear();
    st.registrations.clear();
    st.cleanup_bindings.clear();
    st.pending_worktrees.clear();
    st.orphan_worktrees.clear();
    Ok(())
}

/// 登记一个 worktree（前端 dev.worktree.create 成功后调用；支持相对路径基于主仓库根解析）。
fn git_worktree_list(repo: &std::path::Path) -> Result<String, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"]);
    cmd.env_clear();
    for (key, value) in dev_sanitized_env() {
        cmd.env(key, value);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if result.code != 0 {
        return Err("Git worktree list probe 失败".to_string());
    }
    Ok(result.stdout)
}

fn git_worktree_is_listed(
    repo: &std::path::Path,
    target: &std::path::Path,
) -> Result<bool, String> {
    Ok(git_worktree_list(repo)?.lines().any(|line| {
        line.strip_prefix("worktree ").is_some_and(|path| {
            path_compare_key(path.trim()) == path_compare_key(&target.to_string_lossy())
        })
    }))
}

fn git_worktree_matches(
    repo: &std::path::Path,
    target: &std::path::Path,
    expected_branch: &str,
) -> Result<bool, String> {
    let mut listed_path = None;
    for line in git_worktree_list(repo)?.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            listed_path = Some(path.trim());
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if listed_path.is_some_and(|path| {
                path_compare_key(path) == path_compare_key(&target.to_string_lossy())
            }) && branch.trim() == expected_branch
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn git_branch_exists(repo: &std::path::Path, branch: &str) -> Result<bool, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(repo)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"));
    cmd.env_clear();
    for (key, value) in dev_sanitized_env() {
        cmd.env(key, value);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    match result.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err("Git branch existence probe 失败".to_string()),
    }
}

#[tauri::command]
fn dev_register_worktree(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_register_worktree")?;
    let (base, registration_generation) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_register_worktree: 尚未初始化主仓库根".to_string())?,
            state.generation,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    let canon = dev_abs_of(&path)?;
    if !canon.is_dir() {
        return Err(format!(
            "dev_register_worktree: worktree 不存在或不是目录：{path}"
        ));
    }
    let name = canon
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "dev_register_worktree: worktree 目录名无效".to_string())?;
    let branch = format!("worker/{name}");
    if !main_repo_worktree_target_is_valid(&base_path, &canon.to_string_lossy(), &branch) {
        return Err("dev_register_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    if !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_register_worktree: 目标不是主仓库登记的匹配 Worker worktree".into());
    }
    let has_pending_lease = pending_worker_target(&base_path, &path);
    let mut st = DEV_STATE.lock().unwrap();
    if st.base_repo.as_deref() != Some(base.as_str()) || st.generation != registration_generation {
        return Err("dev_register_worktree: 主仓库 session 在校验期间发生变化".into());
    }
    let already_registered = st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canon.to_string_lossy(),
            &branch,
        )
    });
    if !already_registered && !has_pending_lease {
        return Err("dev_register_worktree: 缺少当前 host 创建的 pending worktree lease".into());
    }
    let canonical_path = canon.to_string_lossy().to_string();
    if !st
        .worktrees
        .iter()
        .any(|w| path_compare_key(w) == path_compare_key(&canonical_path))
    {
        st.worktrees.push(canonical_path.clone());
    }
    if !st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        )
    }) {
        st.registrations.push(RegisteredWorktree {
            generation: registration_generation,
            path: canonical_path.clone(),
            branch: branch.clone(),
        });
    }
    st.pending_worktrees
        .retain(|pending| path_compare_key(&pending.path) != path_compare_key(&canonical_path));
    Ok(())
}

#[tauri::command]
fn dev_register_orphan_worktree(
    path: String,
    branch: String,
    generation: u64,
) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_register_orphan_worktree")?;
    if !worker_branch_is_valid(&branch) {
        return Err("dev_register_orphan_worktree: branch 无效".into());
    }
    let base = {
        let state = DEV_STATE.lock().unwrap();
        state
            .base_repo
            .clone()
            .ok_or_else(|| "dev_register_orphan_worktree: 尚未初始化主仓库根".to_string())?
    };
    let base_path = std::path::PathBuf::from(&base);
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let listed_match = canon.is_dir() && git_worktree_matches(&base_path, &canon, &branch)?;
    let branch_exists = git_branch_exists(&base_path, &branch)?;
    if (!listed_match && !branch_exists)
        || (canon.is_dir() && !listed_match)
        || !main_repo_worktree_target_is_valid(&base_path, &c, &branch)
    {
        return Err(
            "dev_register_orphan_worktree: 目标必须是受控且已删除的 Worker worktree".into(),
        );
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str()) || state.generation != generation {
        return Err("dev_register_orphan_worktree: session 在校验期间发生变化".into());
    }
    if !state
        .orphan_worktrees
        .iter()
        .any(|item| path_compare_key(&item.path) == path_compare_key(&c))
    {
        state.orphan_worktrees.push(PendingWorktree {
            generation,
            path: c,
            branch,
            removed: true,
        });
    }
    Ok(())
}

#[tauri::command]
fn dev_approve_cleanup(
    app: AppHandle,
    path: String,
    branch: String,
    branch_revision: String,
    generation: u64,
) -> Result<String, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_approve_cleanup")?;
    if !is_full_object_id(&branch_revision) || !worker_branch_is_valid(&branch) {
        return Err("dev_approve_cleanup: branch 或 revision 无效".into());
    }
    let base = {
        let state = DEV_STATE.lock().unwrap();
        state
            .base_repo
            .clone()
            .ok_or_else(|| "dev_approve_cleanup: 尚未初始化主仓库根".to_string())?
    };
    let base_path = std::path::PathBuf::from(&base);
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_approve_cleanup: 路径/分支不属于受控 Worker 根".into());
    }
    {
        let state = DEV_STATE.lock().unwrap();
        let registered = state
            .registrations
            .iter()
            .any(|item| registered_worktree_identity_matches(item, generation, &c, &branch));
        let orphan = state.orphan_worktrees.iter().any(|item| {
            item.generation == generation
                && item.branch == branch
                && path_compare_key(&item.path) == path_compare_key(&c)
        });
        if !registered && !orphan {
            return Err("dev_approve_cleanup: worktree 未被当前 host 登记".into());
        }
        if state
            .pending_worktrees
            .iter()
            .any(|pending| path_compare_key(&pending.path) == path_compare_key(&c))
        {
            return Err("dev_approve_cleanup: pending rollback worktree 不能清理".into());
        }
    }
    if canon.is_dir() && !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_approve_cleanup: 当前 Git worktree path/branch 不匹配".into());
    }
    let message = format!(
        "确认清理 Worker worktree？\\n\\n路径：{}\\n分支：{}\\n当前 revision：{}",
        c, branch, branch_revision
    );
    if !app
        .dialog()
        .message(message)
        .title("确认 Worker Cleanup")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show()
    {
        return Err("dev_approve_cleanup: 用户拒绝或关闭了原生确认框".into());
    }
    let token = new_cleanup_token();
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str()) || state.generation != generation {
        return Err("dev_approve_cleanup: session 在确认后发生变化".into());
    }
    if canon.is_dir() && !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_approve_cleanup: 确认后 Git worktree path/branch 已漂移".into());
    }
    state.cleanup_bindings.retain(|binding| !binding.consumed);
    state.cleanup_bindings.push(CleanupBinding {
        token: token.clone(),
        generation,
        path: c,
        branch,
        branch_revision,
        consumed: false,
    });
    Ok(token)
}

/// Native cleanup is capability-based: JS-side proposal validation is not sufficient.
/// `dev_approve_cleanup` issues a one-shot token only after revalidation and a native
/// confirmation dialog; `dev_cleanup_worktree` refuses every unbound destructive call.
#[tauri::command]
fn dev_cleanup_worktree(
    path: String,
    branch: String,
    branch_revision: String,
    approval_token: String,
    generation: u64,
) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_cleanup_worktree")?;
    if !is_full_object_id(&branch_revision) || !worker_branch_is_valid(&branch) {
        return Err("dev_cleanup_worktree: branch 或 revision 无效".into());
    }
    let base = {
        let state = DEV_STATE.lock().unwrap();
        state
            .base_repo
            .clone()
            .ok_or_else(|| "dev_cleanup_worktree: 尚未初始化主仓库根".to_string())?
    };
    let base_path = std::path::PathBuf::from(&base);
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_cleanup_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    {
        let state = DEV_STATE.lock().unwrap();
        let capability = state.cleanup_bindings.iter().any(|binding| {
            cleanup_binding_matches(
                binding,
                &approval_token,
                generation,
                &c,
                &branch,
                &branch_revision,
            )
        });
        if !capability {
            return Err("dev_cleanup_worktree: 缺少匹配的 native cleanup capability".into());
        }
        let registered = state
            .registrations
            .iter()
            .any(|item| registered_worktree_identity_matches(item, generation, &c, &branch));
        let orphan = state.orphan_worktrees.iter().any(|item| {
            item.generation == generation
                && item.branch == branch
                && path_compare_key(&item.path) == path_compare_key(&c)
        });
        if !registered && !orphan {
            drop(state);
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: worktree 未被当前 host 登记".into());
        }
        if state
            .pending_worktrees
            .iter()
            .any(|pending| path_compare_key(&pending.path) == path_compare_key(&c))
        {
            drop(state);
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: pending rollback worktree 不能清理".into());
        }
    }
    if canon.is_dir() {
        let matches = match git_worktree_matches(&base_path, &canon, &branch) {
            Ok(matches) => matches,
            Err(error) => {
                invalidate_cleanup_binding(&approval_token);
                return Err(error);
            }
        };
        if !matches {
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: 当前 Git worktree path/branch 不匹配".into());
        }
    }
    let mut delete = Command::new(resolve_dev_program("git"));
    delete
        .current_dir(&base_path)
        .args(["update-ref", "-d"])
        .arg(format!("refs/heads/{branch}"))
        .arg(&branch_revision);
    apply_dev_env(&mut delete);
    let result = match run_with_timeout(&mut delete, Duration::from_secs(30)) {
        Ok(result) => result,
        Err(error) => {
            invalidate_cleanup_binding(&approval_token);
            return Err(error);
        }
    };
    if result.code != 0 {
        invalidate_cleanup_binding(&approval_token);
        return Err(format!(
            "dev_cleanup_worktree: branch CAS 删除失败：{}",
            result.stderr
        ));
    }
    if git_worktree_is_listed(&base_path, &canon)? {
        let mut remove = Command::new(resolve_dev_program("git"));
        remove
            .current_dir(&base_path)
            .args(["worktree", "remove", "--force"]);
        remove.arg(&canon);
        apply_dev_env(&mut remove);
        let result = match run_with_timeout(&mut remove, Duration::from_secs(30)) {
            Ok(result) => result,
            Err(error) => {
                invalidate_cleanup_binding(&approval_token);
                return Err(error);
            }
        };
        if result.code != 0 {
            invalidate_cleanup_binding(&approval_token);
            return Err(format!(
                "dev_cleanup_worktree: branch 已按 CAS 删除，但 worktree remove 失败：{}",
                result.stderr
            ));
        }
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str()) || state.generation != generation {
        drop(state);
        invalidate_cleanup_binding(&approval_token);
        return Err("dev_cleanup_worktree: session 在清理后发生变化".into());
    }
    if let Some(binding) = state
        .cleanup_bindings
        .iter_mut()
        .find(|binding| binding.token == approval_token)
    {
        binding.consumed = true;
    }
    state
        .registrations
        .retain(|item| !registered_worktree_identity_matches(item, generation, &c, &branch));
    state
        .worktrees
        .retain(|item| path_compare_key(item) != path_compare_key(&c));
    state
        .orphan_worktrees
        .retain(|item| path_compare_key(&item.path) != path_compare_key(&c));
    Ok(())
}

/// 注销 worktree（前端清理成功后调用）。
#[tauri::command]
fn dev_unregister_worktree(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_unregister_worktree")?;
    let base = {
        let state = DEV_STATE.lock().unwrap();
        state
            .base_repo
            .clone()
            .ok_or_else(|| "dev_unregister_worktree: 尚未初始化主仓库根".to_string())?
    };
    let base_path = std::path::PathBuf::from(&base);
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let name = canon
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "dev_unregister_worktree: worktree 目录名无效".to_string())?;
    let branch = format!("worker/{name}");
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_unregister_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    {
        let state = DEV_STATE.lock().unwrap();
        if state
            .pending_worktrees
            .iter()
            .any(|pending| path_compare_key(&pending.path) == path_compare_key(&c))
        {
            return Err("dev_unregister_worktree: pending rollback worktree 不能注销".into());
        }
    }
    if git_worktree_is_listed(&base_path, &canon)? {
        return Err("dev_unregister_worktree: Git worktree 仍处于 live 状态".into());
    }
    if git_branch_exists(&base_path, &branch)? {
        return Err("dev_unregister_worktree: Worker branch 仍存在".into());
    }
    let mut st = DEV_STATE.lock().unwrap();
    if st.base_repo.as_deref() != Some(base.as_str()) || st.generation != generation {
        return Err("dev_unregister_worktree: session 在 read-back 期间发生变化".into());
    }
    if let Some(index) = st
        .worktrees
        .iter()
        .position(|w| path_compare_key(w) == path_compare_key(&c))
    {
        st.worktrees.remove(index);
    }
    st.registrations.retain(|registered| {
        !registered_worktree_identity_matches(registered, generation, &c, &branch)
    });
    Ok(())
}

/// Windows `\\?\` 扩展前缀（canonicalize 在长路径/UNC 下的产物）——比较前统一剥离。
fn dev_strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    std::path::PathBuf::from(s)
}

/// 路径必须属于某个已登记 worktree（dev_read_file / dev_write_file 的前置校验）。
/// 两侧先剥离 Windows `\\?\` 前缀再组件级比较（`Path::starts_with`），
/// 不受扩展前缀 / 大小写差异影响（P1 审计修复）。
fn dev_path_allowed(abs: &std::path::Path) -> Result<(), String> {
    let norm_abs = dev_strip_verbatim(abs);
    let state = DEV_STATE.lock().unwrap();
    for w in &state.worktrees {
        let wc = dev_strip_verbatim(std::path::Path::new(w));
        if path_is_same_or_child(&norm_abs, &wc) {
            return Ok(());
        }
    }
    Err(format!(
        "dev_file: 路径不属于任何已登记 worktree：{}",
        abs.display()
    ))
}

/// 在已登记 worktree 内创建一级目录。
/// 父目录必须已存在并先 canonicalize；目标 symlink 永不跟随，调用方负责逐级创建。
#[tauri::command]
fn dev_create_dir(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_create_dir")?;
    let p = std::path::Path::new(&path);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("dev_create_dir: 路径禁止包含 '..' 逃逸：{path}"));
    }
    let base_dir = {
        let state = DEV_STATE.lock().unwrap();
        state.base_repo.clone().unwrap_or_default()
    };
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::PathBuf::from(&base_dir).join(p)
    };
    let parent = joined
        .parent()
        .ok_or_else(|| format!("dev_create_dir: 无法解析父目录：{path}"))?;
    let canon_parent = parent.canonicalize().map_err(|e| {
        format!(
            "dev_create_dir: 无法解析父目录（{}）：{e}",
            parent.display()
        )
    })?;
    dev_path_allowed(&canon_parent)?;
    let name = joined
        .file_name()
        .ok_or_else(|| "dev_create_dir: 路径缺少目录名".to_string())?;
    let target = canon_parent.join(name);

    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "dev_create_dir: 拒绝操作符号链接目录（防 symlink 逃逸）：{}",
                target.display()
            ));
        }
        if !meta.is_dir() {
            return Err(format!(
                "dev_create_dir: 目标已存在但不是目录：{}",
                target.display()
            ));
        }
        dev_path_allowed(&target)?;
        return Ok(());
    }

    dev_path_allowed(&target)?;
    match fs::create_dir(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&target)
                .map_err(|e| format!("dev_create_dir: 竞态后无法读取目标：{e}"))?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(format!(
                    "dev_create_dir: 竞态后目标不是安全目录：{}",
                    target.display()
                ));
            }
        }
        Err(error) => {
            return Err(format!("dev_create_dir: 创建失败：{path}（{error}）"));
        }
    }
    let real = target
        .canonicalize()
        .map_err(|e| format!("dev_create_dir: 目标解析失败：{e}"))?;
    dev_path_allowed(&real)
}

/// 读文件（仅 worktree 内；H4 节点 code.read / 状态签名等；相对路径基于主仓库根解析）。
#[tauri::command]
fn dev_read_file(path: String, generation: u64) -> Result<String, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_read_file")?;
    let abs = dev_abs_of(&path)?;
    if !abs.is_file() {
        return Err(format!("dev_read_file: 文件不存在：{path}"));
    }
    dev_path_allowed(&abs)?;
    fs::read_to_string(&abs).map_err(|e| format!("dev_read_file: 读取失败：{path}（{e}）"))
}

// 写文件（仅 worktree 内；H4 节点 code.patch 落盘等；相对路径基于主仓库根解析）。
#[cfg(windows)]
#[repr(C)]
struct WinByHandleFileInformation {
    file_attributes: u32,
    creation_low: u32,
    creation_high: u32,
    access_low: u32,
    access_high: u32,
    write_low: u32,
    write_high: u32,
    volume_serial: u32,
    size_high: u32,
    size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandle(
        handle: *mut std::ffi::c_void,
        info: *mut WinByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
fn has_multiple_hardlinks(path: &std::path::Path) -> Result<bool, String> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    let file = fs::File::open(path).map_err(|e| format!("无法安全检查目标 inode：{e}"))?;
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
    if ok == 0 {
        return Err("无法安全检查目标 inode".to_string());
    }
    Ok(unsafe { info.assume_init() }.number_of_links > 1)
}

/// P1 审计修复：防符号链接绕过——
/// - 目标已存在 → `fs::canonicalize` 解析到真实路径（跟随 symlink）后**重新校验**仍在 worktree 内；
/// - 目标不存在 → 父目录已 canonicalize（真实目录），文件名不跨目录，用 O_EXCL 创建（不跟随已有符号链接）；
/// - 目标已存在且是 symlink → 直接拒绝（不写入链接目标）。
#[tauri::command]
fn dev_write_file(path: String, content: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_write_file")?;
    let p = std::path::Path::new(&path);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("dev_write_file: 路径禁止包含 '..' 逃逸：{path}"));
    }
    // 相对路径基于 base_repo 解析；新文件需先规范化父目录再拼接文件名
    let base_dir = {
        let state = DEV_STATE.lock().unwrap();
        state.base_repo.clone().unwrap_or_default()
    };
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::PathBuf::from(&base_dir).join(p)
    };
    let parent = joined.parent().unwrap_or_else(|| std::path::Path::new("."));
    let canon_parent = parent.canonicalize().map_err(|e| {
        format!(
            "dev_write_file: 无法解析父目录（{}）：{e}",
            parent.display()
        )
    })?;
    let name = joined
        .file_name()
        .ok_or_else(|| "dev_write_file: 路径缺少文件名".to_string())?;
    let abs = canon_parent.join(name);

    // 目标已存在：先解析真实路径（跟随 symlink）并重新校验——防 worktree 内 symlink 指向外部
    if let Ok(meta) = fs::symlink_metadata(&abs) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "dev_write_file: 拒绝写入符号链接目标（防 symlink 逃逸）：{}",
                abs.display()
            ));
        }
        #[cfg(windows)]
        if has_multiple_hardlinks(&abs)? {
            return Err(format!(
                "dev_write_file: 拒绝写入 hardlink 目标（防 inode 逃逸）：{}",
                abs.display()
            ));
        }
        let real = abs
            .canonicalize()
            .map_err(|e| format!("dev_write_file: 目标路径解析失败：{e}"))?;
        dev_path_allowed(&real)?;
        fs::write(&real, content)
            .map_err(|e| format!("dev_write_file: 写入失败：{path}（{e}）"))?;
        return Ok(());
    }

    // 目标不存在：父目录已 canonicalize（真实目录，无 symlink），文件名不跨目录；
    // 用 create_new（O_CREAT|O_EXCL）避免跟随并发创建的符号链接
    dev_path_allowed(&abs)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(content.as_bytes())
        })
        .map_err(|e| format!("dev_write_file: 创建失败：{path}（{e}）"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 自定义标题栏由 WebView 提供；窗口状态插件不能恢复旧的 native decorations，
        // 否则 decorations:false 会被历史状态里的 decorated:true 覆盖，出现两层标题栏。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_credential,
            get_credential,
            delete_credential,
            list_credentials,
            save_endpoint,
            load_endpoint,
            delete_endpoint,
            list_endpoints_raw,
            save_vault,
            list_vaults,
            load_vault_key,
            delete_vault,
            codex::codex_login_status,
            codex::codex_login,
            codex::codex_logout,
            codex::codex_exec,
            codex::codex_worker_exec,
            codex::codex_worker_cancel,
            event_store::event_lock_acquire,
            event_store::event_lock_release,
            run_git,
            grant_project_access,
            dev_exec,
            dev_init_session,
            dev_clear_session,
            dev_register_worktree,
            dev_register_orphan_worktree,
            dev_approve_cleanup,
            dev_cleanup_worktree,
            dev_unregister_worktree,
            dev_read_file,
            dev_create_dir,
            dev_write_file
        ])
        // 窗口默认可见（tauri.conf.json visible:true）。保留 on_page_load 作为兜底，
        // 万一某些环境初始未显示，页面加载完成后再确保 show 一次。
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                // 运行时再次关闭 native decorations，兼容旧的编译上下文/窗口状态缓存。
                let _ = win.set_decorations(false);
                let _ = win.show();
            }
            Ok(())
        })
        .on_page_load(|win, _payload| {
            // 页面初次加载完成即确保窗口可见（SPA 仅触发一次）
            let _ = win.window().set_decorations(false);
            let _ = win.show();
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 注意：Rust 侧不实现普通 LLM HTTP 调用（原 chat_completion 已移除，路线 A）。
// OpenAI/Anthropic/Ollama 请求仍由前端 provider（plugin-http）发起；Codex provider
// 仅在此处通过官方 CLI 受控调用，复用 Codex 自己的 ChatGPT 登录态，不把 token 返回前端。
// 路线 B 若启用后端执行引擎，将复用此处的密钥/文件能力，而非重新实现 HTTP 客户端。

/* ---------------- 接入点 apiKey 加密（AES-GCM，主密钥存于密钥库） ---------------- */
// endpoints.json 落盘时 apiKey 以密文存储，避免明文泄露；运行时按 name 解密取回。
const MASTER_KEY_ENTRY: &str = "___sm_master_key___";

/// 主密钥持久化到 AppData/com.slimemold/master.key 文件。
/// 2026-08-09 修复：原存于 keyring，但 Windows keyring 存在 (service,user) 读写不一致问题，
/// 导致首次生成后读回不同 key → 加解密错乱（apiKey 解密失败返回密文）。
/// 改为落文件可稳定读回；文件位于 AppData 且非随工作流导出，可接受。
fn master_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 AppData 目录失败: {e}"))?;
    Ok(dir.join("master.key"))
}

fn get_master_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = master_key_path(app)?;
    // 优先从文件读既有主密钥
    if let Ok(b64) = fs::read_to_string(&path) {
        let b64 = b64.trim();
        if let Ok(bytes) = base64_decode(b64) {
            if bytes.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&bytes);
                return Ok(k);
            }
        }
    }
    // 兼容：从 keyring 读旧主密钥（若存在）
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
    // 否则生成并写入文件
    let mut k = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut k);
    let b64 = base64_encode(&k);
    fs::write(&path, &b64).map_err(|e| format!("写入主密钥文件失败: {e}"))?;
    Ok(k)
}

/// 加密明文 apiKey → "nonce(12B).ciphertext" 的 base64 串。
fn encrypt_api_key(app: &AppHandle, plain: &str) -> Result<String, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let key = get_master_key(app)?;
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
fn decrypt_api_key(app: &AppHandle, b64: &str) -> Option<String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let bytes = base64_decode(b64).ok()?;
    if bytes.len() < 12 {
        return None;
    }
    let key = get_master_key(app).ok()?;
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
        let dir =
            std::env::temp_dir().join(format!("slime_fs_atomic_{}_{}", name, std::process::id()));
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
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        // 1) 目标被锁时直接 rename 应失败
        assert!(
            fs::rename(&tmp, &target).is_err(),
            "锁定目标时 rename 应失败"
        );
        // 2) remove 被锁目标也应失败 → saveCheckpoints 走「保留 tmp」分支
        assert!(
            fs::remove_file(&target).is_err(),
            "锁定目标时 remove 应失败"
        );
        // 3) tmp 保留（内容完整，供下次覆盖）
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "new");
        drop(handle);
        let _ = fs::remove_dir_all(&dir);
    }
}

/* ---------------- 诊断：apiKey AES-GCM 加密往返（排除算法 bug / master key 漂移） ---------------- */
#[cfg(test)]
mod vault_crypto_roundtrip_tests {
    use crate::{base64_decode, base64_encode};

    #[test]
    fn base64_roundtrip() {
        let raw = b"sk-test-1234567890abcdef"; // 24 字节 → 32 字符
        let b64 = base64_encode(raw);
        assert_eq!(base64_decode(&b64).unwrap(), raw, "base64 往返应一致");
        assert_eq!(b64.len(), 32);
        // 另一组含奇数字节的输入
        let raw2 = b"hello world";
        let b64_2 = base64_encode(raw2);
        assert_eq!(base64_decode(&b64_2).unwrap(), raw2);
    }

    #[test]
    fn aes_gcm_roundtrip_same_key() {
        // 用固定 key 走加解密，确认算法配对（不依赖 master key 存储）
        let plain = "sk-test-deepseek-abcdefghijklmnopqrstuvwxyz";
        let key = aes_gcm::Aes256Gcm::new_from_slice(&[7u8; 32]).unwrap();
        use aes_gcm::aead::Aead;
        use aes_gcm::{KeyInit, Nonce};
        let mut nonce_bytes = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = key.encrypt(nonce, plain.as_bytes()).unwrap();
        let mut buf = nonce_bytes.to_vec();
        buf.extend_from_slice(&ct);
        let b64 = base64_encode(&buf);
        // 解密
        let bytes = base64_decode(&b64).unwrap();
        let (nonce_raw, ct_bytes) = bytes.split_at(12);
        let pt = key.decrypt(Nonce::from_slice(nonce_raw), ct_bytes).unwrap();
        assert_eq!(
            String::from_utf8(pt).unwrap(),
            plain,
            "AES-GCM 往返应还原明文"
        );
    }
}

/* ---------------- dev_exec 主仓库根权限边界（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_exec_tests {
    use super::*;

    struct TempDirs(Vec<PathBuf>);

    impl Drop for TempDirs {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = fs::remove_dir_all(path);
            }
        }
    }

    fn make_dir_symlink(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            match std::os::windows::fs::symlink_dir(target, link) {
                Ok(()) => Ok(()),
                Err(error) if error.raw_os_error() == Some(1314) => {
                    let target = target.to_string_lossy();
                    let link = link.to_string_lossy();
                    if target.chars().any(|c| {
                        matches!(
                            c,
                            '"' | '&' | '|' | '<' | '>' | '^' | '%' | '!' | '(' | ')' | '\r' | '\n'
                        )
                    }) || link.chars().any(|c| {
                        matches!(
                            c,
                            '"' | '&' | '|' | '<' | '>' | '^' | '%' | '!' | '(' | ')' | '\r' | '\n'
                        )
                    }) {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "test junction path contains cmd metacharacters",
                        ));
                    }
                    let output = Command::new(
                        std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
                    )
                    .args(["/D", "/C", "mklink", "/J", link.as_ref(), target.as_ref()])
                    .output()?;
                    if output.status.success() {
                        Ok(())
                    } else {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!(
                                "mklink /J failed: {} {}",
                                String::from_utf8_lossy(&output.stdout),
                                String::from_utf8_lossy(&output.stderr)
                            ),
                        ))
                    }
                }
                Err(error) => Err(error),
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = target;
            let _ = link;
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "directory symlink is not supported on this platform",
            ))
        }
    }

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn main_repo_allows_only_readonly_git() {
        let main = DevCwdKind::MainRepo;
        // 只读 git / worktree 生命周期管理 → 放行
        assert!(dev_exec_allowed(&main, &sv(&["git", "rev-parse", "HEAD"])));
        assert!(dev_exec_allowed(&main, &sv(&["git", "worktree", "list"])));
        assert!(!dev_exec_allowed(
            &main,
            &sv(&[
                "git",
                "worktree",
                "remove",
                "--force",
                "C:/repo-workers/task-1"
            ])
        ));
        assert!(!dev_exec_allowed(
            &main,
            &sv(&[
                "git",
                "update-ref",
                "-d",
                "refs/heads/worker/task-1",
                &"a".repeat(40)
            ])
        ));
        assert!(!dev_exec_allowed(
            &main,
            &sv(&["git", "worktree", "add", "-q", "wt", "-b", "b", "HEAD"])
        ));
        assert!(dev_exec_allowed(
            &main,
            &sv(&["git", "status", "--porcelain"])
        ));
        assert!(dev_exec_allowed(
            &main,
            &sv(&["git", "diff", "--name-only"])
        ));
        assert!(
            !dev_main_repo_git_allowed(&sv(&["git", "diff", "--output=outside.patch"])),
            "main repo diff output must be rejected"
        );
        // 非白名单命令名 → 拒绝
        assert!(!dev_exec_allowed(&main, &sv(&["npm", "run", "build"])));
        assert!(!dev_exec_allowed(&main, &sv(&["tsx", "scripts/x.ts"])));
        assert!(!dev_exec_allowed(&main, &sv(&["tsc", "--noEmit"])));
        assert!(!dev_exec_allowed(&main, &sv(&["cat", "/etc/passwd"])));
        // 写入型 git → 拒绝
        assert!(!dev_exec_allowed(
            &main,
            &sv(&["git", "apply", "patch.diff"])
        ));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "commit", "-m", "x"])));
        assert!(!dev_exec_allowed(
            &main,
            &sv(&["git", "push", "origin", "main"])
        ));
        assert!(!dev_exec_allowed(
            &main,
            &sv(&["git", "reset", "--hard", "HEAD"])
        ));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "checkout", "main"])));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "add", "."])));
    }

    #[test]
    fn sanitized_env_removes_credential_families() {
        for name in [
            "NPM_TOKEN",
            "NODE_AUTH_TOKEN",
            "AZURE_CLIENT_SECRET",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "NPM_CONFIG__AUTH",
            "GITHUB_PAT",
            "DATABASE_URL",
            "SERVICE_DSN",
            "NPM_CONFIG_USERCONFIG",
            "SESSION_COOKIE",
            "BEARER",
            "OPENAI_API_KEY",
        ] {
            assert!(
                is_credential_env_name(name),
                "expected credential name: {name}"
            );
        }
        assert!(!is_credential_env_name("PATH"));
        assert!(!is_credential_env_name("SM_NON_SECRET_MODE"));
        assert!(is_safe_env_name("PATH"));
        assert!(is_safe_env_name("SystemRoot"));
        assert!(!is_safe_env_name("SM_NON_SECRET_MODE"));
        assert!(!is_safe_env_name("NPM_CONFIG_USERCONFIG"));
    }

    #[test]
    fn worktree_read_commands_reject_external_file_and_command_options() {
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "grep",
            "--file=/outside/patterns",
            "needle",
            "."
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "grep", "needle", "-R", "."
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "grep",
            "needle",
            "--directories=recurse",
            "."
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "grep", "needle", "-d", "recurse", "."
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "find",
            ".",
            "-fprint",
            "/outside/list"
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "find", ".", "-okdir", "touch", "{}", ";"
        ])));
    }

    #[test]
    fn worktree_git_changed_files_accepts_safe_base_revision() {
        assert!(dev_worktree_cmd_allowed(&sv(&[
            "git",
            "diff",
            "--name-only",
            "3be065ee082a5c4c10c1c3f0c11226154485b1f5",
        ])));
        assert!(dev_worktree_cmd_allowed(&sv(&[
            "git",
            "diff",
            "--name-only",
            "feature/base-revision",
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "git",
            "diff",
            "--name-only",
            "../outside",
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "git",
            "diff",
            "--name-only",
            &"a".repeat(129),
        ])));
    }

    #[test]
    fn worktree_code_checks_allow_scoped_relative_files_only() {
        assert!(dev_worktree_cmd_allowed(&sv(&[
            "node", "--check", "src/main.js"
        ])));
        assert!(dev_worktree_cmd_allowed(&sv(&[
            "tsc", "--noEmit", "src/game/engine.ts", "src/game/rules.ts"
        ])));
        assert!(dev_worktree_cmd_allowed(&sv(&[
            "tsc", "--noEmit", "--target", "es2020", "src/game/engine.ts"
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "node", "--check", "C:/outside/main.js"
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "tsc", "--noEmit", "../outside.ts"
        ])));
        assert!(!dev_worktree_cmd_allowed(&sv(&[
            "node", "--check", "--eval=process.exit(1)"
        ])));
    }

    #[test]
    fn worktree_read_commands_allow_non_shell_glob_operands() {
        assert!(dev_worktree_cmd_allowed(&sv(&[
            "find",
            "src/components",
            "-name",
            "*.tsx"
        ])));
        assert!(dev_worktree_cmd_allowed(&sv(&["grep", "needle", "*.tsx"])));
    }

    #[test]
    fn legacy_run_git_is_read_only_and_revision_scoped() {
        assert!(run_git_readonly_args(&sv(&[
            "rev-parse",
            "--is-inside-work-tree"
        ])));
        assert!(run_git_readonly_args(&sv(&["diff", "HEAD"])));
        assert!(run_git_readonly_args(&sv(&["log", "--oneline", "-n", "5"])));
        assert!(!run_git_readonly_args(&sv(&[
            "diff",
            "--output=outside.patch"
        ])));
        assert!(!run_git_readonly_args(&sv(&["worktree", "prune"])));
        assert!(!run_git_readonly_args(&sv(&[
            "worktree", "remove", "--force", "x"
        ])));
        assert!(!run_git_readonly_args(&sv(&["branch", "-D", "worker/x"])));
    }

    #[test]
    fn main_repo_worktree_lifecycle_is_scoped_to_worker_root() {
        let repo = std::path::Path::new("C:/Repo/SlimeMold");
        assert!(main_repo_worktree_args_are_valid(
            repo,
            &sv(&[
                "git",
                "worktree",
                "add",
                "-q",
                "C:/Repo/SlimeMold-workers/attempt-1",
                "-b",
                "worker/attempt-1",
                "HEAD"
            ])
        ));
        assert!(dev_exec_allowed_at(
            &DevCwdKind::MainRepo,
            &sv(&[
                "git",
                "worktree",
                "add",
                "-q",
                "C:/Repo/SlimeMold-workers/attempt-1",
                "-b",
                "worker/attempt-1",
                "HEAD"
            ]),
            Some(repo)
        ));
        assert!(!main_repo_worktree_args_are_valid(
            repo,
            &sv(&[
                "git",
                "worktree",
                "add",
                "-q",
                "C:/Users/Public/attempt-1",
                "-b",
                "worker/attempt-1",
                "HEAD"
            ])
        ));
        assert!(!main_repo_worktree_args_are_valid(
            repo,
            &sv(&[
                "git",
                "worktree",
                "add",
                "-q",
                "C:/Repo/SlimeMold-workers/attempt-1",
                "-b",
                "worker/other",
                "HEAD"
            ])
        ));
    }

    #[test]
    fn main_repo_rejects_git_invalid_worker_name_components() {
        let repo = std::path::Path::new("C:/Repo/SlimeMold");
        for name in ["foo..bar", ".hidden", "foo.", "foo.lock"] {
            assert!(!main_repo_worktree_args_are_valid(
                repo,
                &sv(&[
                    "git",
                    "worktree",
                    "add",
                    "-q",
                    &format!("C:/Repo/SlimeMold-workers/{name}"),
                    "-b",
                    &format!("worker/{name}"),
                    "HEAD"
                ])
            ));
        }
    }

    #[test]
    fn successful_worktree_add_creates_a_scoped_pending_rollback_lease() {
        let _test_guard = lock_dev_state_tests();
        let test_root = std::env::temp_dir().join("slimemold-test-runs");
        let base = test_root.join(format!(
            "sm-pending-worktree-{}_{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let workers = std::path::PathBuf::from(format!("{}-workers", base.to_string_lossy()));
        let target = workers.join("attempt-1");
        let base_str = base.to_string_lossy().to_string();
        let target_str = target.to_string_lossy().to_string();
        let branch = "worker/attempt-1".to_string();
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&workers);
        fs::create_dir_all(&test_root).unwrap();
        let _cleanup = TempDirs(vec![base.clone(), workers.clone()]);
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&workers).unwrap();
        fs::write(base.join("README.md"), "fixture").unwrap();
        let git = |args: &[&str], cwd: &std::path::Path| {
            let output = Command::new(resolve_dev_program("git"))
                .args(args)
                .current_dir(cwd)
                .env_clear()
                .envs(dev_sanitized_env())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git fixture command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"], &base);
        git(&["config", "user.email", "test@example.invalid"], &base);
        git(&["config", "user.name", "SlimeMold Test"], &base);
        git(&["add", "README.md"], &base);
        git(&["commit", "-qm", "fixture"], &base);

        let generation = dev_init_session(base_str.clone()).unwrap();
        let result = dev_exec(
            sv(&[
                "git",
                "worktree",
                "add",
                "-q",
                &target_str,
                "-b",
                &branch,
                "HEAD",
            ]),
            base_str.clone(),
            generation,
        )
        .unwrap();
        assert_eq!(result.code, 0, "worktree add should succeed");
        let branch_ref = format!("refs/heads/{branch}");
        let revision_arg = format!("{branch_ref}^{{commit}}");
        let revision_args = sv(&[
            "git",
            "rev-parse",
            "--verify",
            "--end-of-options",
            &revision_arg,
        ]);
        let revision_result =
            dev_exec(revision_args.clone(), base_str.clone(), generation).unwrap();
        assert_eq!(
            revision_result.code, 0,
            "worker branch tip read should succeed"
        );
        let branch_revision = revision_result.stdout.trim().to_string();
        assert!(branch_revision.len() == 40 || branch_revision.len() == 64);
        let remove_allowed = dev_main_repo_git_allowed_at(
            &sv(&["git", "worktree", "remove", "--force", &target_str]),
            Some(&base),
        );
        let cas_args = sv(&["git", "update-ref", "-d", &branch_ref, &branch_revision]);
        let branch_allowed_before_remove = dev_main_repo_git_allowed_at(&cas_args, Some(&base));
        let remove_result = dev_exec(
            sv(&["git", "worktree", "remove", "--force", &target_str]),
            base_str.clone(),
            generation,
        )
        .unwrap();
        let branch_allowed_after_remove = dev_main_repo_git_allowed_at(&cas_args, Some(&base));
        let branch_result = dev_exec(cas_args.clone(), base_str.clone(), generation).unwrap();
        let branch_allowed_after_delete = dev_main_repo_git_allowed_at(&cas_args, Some(&base));
        let other_target = workers.join("attempt-2").to_string_lossy().to_string();
        let other_branch = "worker/attempt-2";
        let other_remove_allowed = dev_main_repo_git_allowed_at(
            &sv(&["git", "worktree", "remove", "--force", &other_target]),
            Some(&base),
        );
        let other_branch_ref = format!("refs/heads/{other_branch}");
        let other_cas_args = sv(&[
            "git",
            "update-ref",
            "-d",
            &other_branch_ref,
            &branch_revision,
        ]);
        let other_branch_allowed = dev_main_repo_git_allowed_at(&other_cas_args, Some(&base));

        dev_clear_session(generation).unwrap();
        let _ = fs::remove_dir_all(&workers);
        let _ = fs::remove_dir_all(&base);

        assert!(
            remove_allowed,
            "only the just-created pending worktree may roll back"
        );
        assert_eq!(
            remove_result.code, 0,
            "pending worktree remove should succeed"
        );
        assert!(
            !branch_allowed_before_remove,
            "pending branch delete must wait for worktree remove"
        );
        assert!(
            branch_allowed_after_remove,
            "pending branch is allowed after worktree remove"
        );
        assert_eq!(
            branch_result.code, 0,
            "pending branch delete should succeed"
        );
        assert!(
            !branch_allowed_after_delete,
            "pending branch lease must be consumed after delete"
        );
        assert!(
            !other_remove_allowed,
            "an unrelated worker target must remain blocked"
        );
        assert!(
            !other_branch_allowed,
            "an unrelated worker branch must remain blocked"
        );
        assert!(!worker_name_is_valid(&"a".repeat(201)));
    }

    #[test]
    fn worktree_add_rejects_a_symlinked_worker_root_before_spawning_git() {
        let _test_guard = lock_dev_state_tests();
        let test_root = std::env::temp_dir().join("slimemold-test-runs");
        let base = test_root.join(format!(
            "sm-realpath-worker-{}_{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let workers = std::path::PathBuf::from(format!("{}-workers", base.to_string_lossy()));
        let outside = test_root.join(format!(
            "sm-realpath-outside-{}_{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let target = workers.join("attempt-1");
        let base_str = base.to_string_lossy().to_string();
        let target_str = target.to_string_lossy().to_string();
        let branch = "worker/attempt-1".to_string();
        let _cleanup = TempDirs(vec![base.clone(), workers.clone(), outside.clone()]);
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&workers);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&test_root).unwrap();
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&outside).unwrap();
        make_dir_symlink(&outside, &workers).unwrap();
        fs::write(base.join("README.md"), "fixture").unwrap();
        let git = |args: &[&str], cwd: &std::path::Path| {
            let output = Command::new(resolve_dev_program("git"))
                .args(args)
                .current_dir(cwd)
                .env_clear()
                .envs(dev_sanitized_env())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git fixture command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"], &base);
        git(&["config", "user.email", "test@example.invalid"], &base);
        git(&["config", "user.name", "SlimeMold Test"], &base);
        git(&["add", "README.md"], &base);
        git(&["commit", "-qm", "fixture"], &base);

        let generation = dev_init_session(base_str.clone()).unwrap();
        let result = dev_exec(
            sv(&[
                "git",
                "worktree",
                "add",
                "-q",
                &target_str,
                "-b",
                &branch,
                "HEAD",
            ]),
            base_str.clone(),
            generation,
        );
        let _ = Command::new(resolve_dev_program("git"))
            .args(["worktree", "remove", "--force", &target_str])
            .current_dir(&base)
            .env_clear()
            .envs(dev_sanitized_env())
            .output();
        let _ = Command::new(resolve_dev_program("git"))
            .args(["branch", "-D", &branch])
            .current_dir(&base)
            .env_clear()
            .envs(dev_sanitized_env())
            .output();
        dev_clear_session(generation).unwrap();

        assert!(
            result.is_err(),
            "symlinked worker root must be rejected before git worktree add"
        );
    }

    #[test]
    fn registered_worktree_replacement_is_not_recanonicalized_to_outside() {
        let _test_guard = lock_dev_state_tests();
        let root = std::path::PathBuf::from(r"D:\Temp\slimemold-test-runs").join(format!(
            "sm-registered-replace-{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let base = root.join("repo");
        let worker = root.join("repo-workers");
        let outside = root.join("outside");
        let _cleanup = TempDirs(vec![root.clone()]);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&worker).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("marker.txt"), "outside").unwrap();
        let registered = worker.canonicalize().unwrap().to_string_lossy().to_string();
        fs::remove_dir_all(&worker).unwrap();
        make_dir_symlink(&outside, &worker).unwrap();
        {
            let mut state = DEV_STATE.lock().unwrap();
            state.generation = next_session_generation(state.generation);
            state.base_repo = Some(base.to_string_lossy().to_string());
            state.worktrees = vec![registered];
        }

        let result = dev_cwd_kind(worker.join("marker.txt").to_string_lossy().as_ref());

        {
            let mut state = DEV_STATE.lock().unwrap();
            state.generation = next_session_generation(state.generation);
            state.base_repo = None;
            state.worktrees.clear();
        }
        assert!(
            result.is_err(),
            "replaced registered worktree must fail closed"
        );
    }

    #[test]
    fn unregister_is_idempotent_after_safe_cleanup_and_preserves_pending_state() {
        let _test_guard = lock_dev_state_tests();
        let test_root = std::env::temp_dir().join("slimemold-test-runs");
        let base = test_root.join(format!(
            "sm-unregister-{}_{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let workers = worker_root_path(&base);
        let registered = workers.join("registered");
        let pending = workers.join("pending");
        let other = workers.join("other");
        let base_str = base.to_string_lossy().to_string();
        let registered_str = registered.to_string_lossy().to_string();
        let pending_str = pending.to_string_lossy().to_string();
        let _cleanup = TempDirs(vec![base.clone(), workers.clone()]);
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&workers);
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("README.md"), "fixture").unwrap();
        let git = |args: &[&str], cwd: &std::path::Path| {
            let output = Command::new(resolve_dev_program("git"))
                .args(args)
                .current_dir(cwd)
                .env_clear()
                .envs(dev_sanitized_env())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git fixture command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"], &base);
        git(&["config", "user.email", "test@example.invalid"], &base);
        git(&["config", "user.name", "SlimeMold Test"], &base);
        git(&["add", "README.md"], &base);
        git(&["commit", "-qm", "fixture"], &base);
        git(
            &[
                "worktree",
                "add",
                "-q",
                &registered_str,
                "-b",
                "worker/registered",
                "HEAD",
            ],
            &base,
        );
        fs::create_dir_all(&pending).unwrap();

        let generation = dev_init_session(base_str.clone()).unwrap();
        {
            let mut state = DEV_STATE.lock().unwrap();
            state.worktrees = vec![registered_str.clone()];
            state.pending_worktrees = vec![PendingWorktree {
                generation,
                path: pending_str.clone(),
                branch: "worker/pending".to_string(),
                removed: false,
            }];
        }

        let pending_result = dev_unregister_worktree(pending_str.clone(), generation);
        let other_result = dev_unregister_worktree(other.to_string_lossy().to_string(), generation);
        let live_result = dev_unregister_worktree(registered_str.clone(), generation);
        let pending_still_present = {
            let state = DEV_STATE.lock().unwrap();
            state
                .pending_worktrees
                .iter()
                .any(|item| item.path == pending_str)
        };

        git(&["worktree", "remove", "--force", &registered_str], &base);
        git(&["branch", "-D", "worker/registered"], &base);
        let cleaned_result = dev_unregister_worktree(registered_str.clone(), generation);
        let registered_again = dev_unregister_worktree(registered_str, generation);
        dev_clear_session(generation).unwrap();

        assert!(
            pending_result.is_err(),
            "pending worktree cannot be unregistered"
        );
        assert!(
            other_result.is_ok(),
            "safe absent worktree unregister is idempotent"
        );
        assert!(
            live_result.is_err(),
            "live Git worktree cannot be unregistered"
        );
        assert!(
            cleaned_result.is_ok(),
            "cleaned worktree can be unregistered once"
        );
        assert!(
            registered_again.is_ok(),
            "unregister must be idempotent after cleanup"
        );
        assert!(
            pending_still_present,
            "failed unregister must not erase pending rollback state"
        );
    }

    #[test]
    fn session_reset_waits_for_an_inflight_host_operation_lease() {
        let _test_guard = lock_dev_state_tests();
        let generation = {
            let mut state = DEV_STATE.lock().unwrap();
            state.base_repo = Some("C:/operation-lease-test".to_string());
            state.generation = next_session_generation(state.generation);
            state.generation
        };
        let operation_guard = lock_dev_operation();
        let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let completed_in_thread = completed.clone();
        let handle = std::thread::spawn(move || {
            dev_clear_session(generation).unwrap();
            completed_in_thread.store(true, std::sync::atomic::Ordering::Release);
        });

        std::thread::sleep(Duration::from_millis(25));
        assert!(
            !completed.load(std::sync::atomic::Ordering::Acquire),
            "session reset must wait for an in-flight host operation"
        );
        drop(operation_guard);
        handle.join().unwrap();
        assert!(completed.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn worktree_add_allows_a_missing_worker_root_with_a_safe_parent() {
        let test_root = std::env::temp_dir().join("slimemold-test-runs");
        let base = test_root.join(format!(
            "sm-missing-worker-root-{}_{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let workers = worker_root_path(&base);
        let target = workers.join("attempt-1");
        let _cleanup = TempDirs(vec![base.clone(), workers.clone()]);
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&workers);
        fs::create_dir_all(&test_root).unwrap();
        fs::create_dir_all(&base).unwrap();

        let result =
            worktree_add_target_is_safe(&base, &target.to_string_lossy(), "worker/attempt-1");

        assert!(
            result.is_ok(),
            "a safe missing worker root may be created by git"
        );
    }

    #[test]
    fn stale_session_generation_is_rejected_without_mutating_current_session() {
        let _test_guard = lock_dev_state_tests();
        let generation = {
            let mut state = DEV_STATE.lock().unwrap();
            state.base_repo = Some("C:/stale-generation-test".to_string());
            state.worktrees.clear();
            state.pending_worktrees.clear();
            state.generation = next_session_generation(state.generation);
            state.generation
        };
        let stale = next_session_generation(generation);
        let exec_result = dev_exec(sv(&["pwd"]), "C:/stale-generation-test".to_string(), stale);
        let clear_result = dev_clear_session(stale);
        let still_current = {
            let state = DEV_STATE.lock().unwrap();
            state.base_repo.as_deref() == Some("C:/stale-generation-test")
                && state.generation == generation
        };
        let clear_current = dev_clear_session(generation);

        assert!(exec_result.is_err(), "stale dev_exec must be rejected");
        assert!(
            clear_result.is_err(),
            "stale session clear must be rejected"
        );
        assert!(
            still_current,
            "stale commands must not mutate current session"
        );
        assert!(
            clear_current.is_ok(),
            "current generation can clear its session"
        );
    }

    #[test]
    fn worktree_allows_full_whitelist() {
        let wt = DevCwdKind::Worktree(std::path::PathBuf::from("/repo/wt"));
        // 前端 DEFAULT_TEST_RULES 对齐：npm 仅固定 script；tsx 仅 scripts/ 前缀
        assert!(dev_exec_allowed(&wt, &sv(&["npm", "run", "build"])));
        assert!(dev_exec_allowed(&wt, &sv(&["npm", "run", "test"])));
        assert!(dev_exec_allowed(&wt, &sv(&["npm", "run", "i18n:check"])));
        assert!(dev_exec_allowed(&wt, &sv(&["tsx", "scripts/x.ts"])));
        assert!(dev_exec_allowed(&wt, &sv(&["tsc", "--noEmit"])));
        assert!(dev_exec_allowed(&wt, &sv(&["tsc", "-b"])));
        assert!(dev_exec_allowed(&wt, &sv(&["vitest", "run"])));
        // 前端 DEFAULT_SHELL_RULES 对齐：只读查询
        assert!(dev_exec_allowed(&wt, &sv(&["pwd"])));
        assert!(dev_exec_allowed(&wt, &sv(&["cat", "src/a.ts"])));
        assert!(dev_exec_allowed(&wt, &sv(&["ls", "src"])));
        assert!(dev_exec_allowed(&wt, &sv(&["grep", "foo", "src/a.ts"])));
        // 只读 git 精确参数
        assert!(dev_exec_allowed(
            &wt,
            &sv(&["git", "status", "--porcelain"])
        ));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "diff", "HEAD"])));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "diff", "src/a.ts"])));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "rev-parse", "HEAD"])));
        assert!(dev_exec_allowed(
            &wt,
            &sv(&["git", "ls-files", "--others", "--exclude-standard"])
        ));
    }

    #[test]
    fn worktree_rejects_high_risk_and_unbounded() {
        let wt = DevCwdKind::Worktree(std::path::PathBuf::from("/repo/wt"));
        // 写入型 / 高风险 git → 拒绝
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "push", "origin", "main"])
        ));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "commit", "-m", "x"])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "reset", "--hard", "HEAD"])
        ));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "checkout", "main"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "clean", "-fd"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "merge", "main"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "apply", "patch.diff"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "add", "."])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "config", "user.email", "x@y.z"])
        ));
        // 无界 / 白名单外命令 / 危险参数 → 拒绝
        assert!(!dev_exec_allowed(&wt, &sv(&["npm", "run", "evil"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["npm", "install", "lodash"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["tsx", "src/outside.ts"])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["tsx", "scripts/x.ts", "--config"])
        ));
        assert!(!dev_exec_allowed(&wt, &sv(&["find", ".", "-delete"])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["find", ".", "-exec", "rm", "{}", ";"])
        ));
        assert!(!dev_exec_allowed(&wt, &sv(&["rm", "-rf", "/"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["sudo", "x"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["node", "-e", "x"])));
        // 精确匹配语义：白名单参数不得被追加额外参数绕过
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "status", "--porcelain", "--extra"])
        ));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "diff", "HEAD", "--output=x"])
        ));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "-x"])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "rev-parse", "HEAD", "extra"])
        ));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "ls-files", "--others", "--exclude-standard", "-z"])
        ));
    }

    #[test]
    fn worktree_rejects_path_escape_lexically() {
        let wt = DevCwdKind::Worktree(std::path::PathBuf::from("/repo/wt"));
        // POSIX 绝对路径 → 拒绝（Unix 下 cat/head/ls 不得读取 worktree 外绝对路径）
        #[cfg(unix)]
        {
            assert!(!dev_exec_allowed(&wt, &sv(&["cat", "/etc/passwd"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["head", "/var/log/syslog"])));
            assert!(!dev_exec_allowed(
                &wt,
                &sv(&["tail", "/home/user/.ssh/id_rsa"])
            ));
            assert!(!dev_exec_allowed(&wt, &sv(&["ls", "/"])));
            assert!(!dev_exec_allowed(
                &wt,
                &sv(&["grep", "SECRET", "/etc/secret"])
            ));
            assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "/etc/passwd"])));
            assert!(!dev_exec_allowed(
                &wt,
                &sv(&["find", "/etc", "-name", "passwd"])
            ));
        }
        // Windows drive 绝对路径 / UNC → 拒绝（跨平台均如此：C:\、D:\、\\server\）
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["cat", "C:\\Windows\\system32\\drivers\\etc\\hosts"])
        ));
        assert!(!dev_exec_allowed(&wt, &sv(&["ls", "D:\\secret"])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["cat", "\\\\server\\share\\secret.txt"])
        ));
        // .. 父目录逃逸（含折返路径 scripts/foo/../..）→ 拒绝（跨平台）
        assert!(!dev_exec_allowed(&wt, &sv(&["cat", "../../outside.txt"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["head", "src/../../secret"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["ls", ".."])));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["grep", "x", "a/../b/../../etc/x"])
        ));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["tsx", "scripts/foo/../../../etc/x.ts"])
        ));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["git", "diff", "../../.git/config"])
        ));
        assert!(!dev_exec_allowed(
            &wt,
            &sv(&["find", "..", "-name", "*.ts"])
        ));
        // 家目录 / shell 元字符 → 拒绝（跨平台）
        assert!(!dev_exec_allowed(&wt, &sv(&["cat", "~/secret"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["cat", "a>file"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["ls", "src | xargs"])));
    }

    /// canonicalize 层：造真实目录 + symlink，验证路径解析后逃逸 worktree 被拦截。
    #[test]
    fn dev_exec_validate_paths_rejects_symlink_escape() {
        let base = std::env::temp_dir().join(format!("sm_dev_exec_test_{}", std::process::id()));
        let wt_root = base.join("wt");
        let outside = base.join("outside");
        std::fs::create_dir_all(&wt_root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        // worktree 内创建指向外部目录的符号链接
        let link = wt_root.join("evil_link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_dir;
            if symlink_dir(&outside, &link).is_err() {
                std::fs::write(&link, "dummy").unwrap(); // 无特权时降级：链接失效即视为安全
            }
        }
        // 良性路径：worktree 内文件 → 放行
        std::fs::write(wt_root.join("ok.txt"), "ok").unwrap();
        assert!(
            dev_exec_validate_paths(wt_root.to_str().unwrap(), &sv(&["cat", "ok.txt"])).is_ok()
        );
        // symlink 逃逸：cat evil_link/secret.txt → canonicalize 后逃出 wt_root → 拒绝
        #[cfg(unix)]
        if std::fs::symlink_metadata(&link).is_ok() {
            // 若符号链接真正生效（内部文件可经链接读到），canonicalize 后逃出 wt_root 必须拒绝；
            // 无特权创建 symlink 时链接无效，文件不存在则放行
            let inside = wt_root.join("evil_link/secret.txt");
            if inside.exists() {
                assert!(
                    dev_exec_validate_paths(
                        wt_root.to_str().unwrap(),
                        &sv(&["cat", "evil_link/secret.txt"])
                    )
                    .is_err(),
                    "symlink 逃逸应被 canonicalize 层拦截"
                );
            }
        }
        // 清理临时目录
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归：dev_exec_validate_paths 对命令参数路径的归属判断用组件级 Path::starts_with，
    /// cwd=wt 时指向兄弟目录 wt2 的参数必须被拒绝，指向 wt 内部文件必须放行。
    #[test]
    fn dev_exec_validate_paths_no_wt_prefix_collision() {
        let base = std::env::temp_dir().join(format!("sm_wt_args_{}", std::process::id()));
        let wt = base.join("wt");
        let wt2 = base.join("wt2");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&wt2).unwrap();
        std::fs::write(wt.join("ok.txt"), "ok").unwrap();
        std::fs::write(wt2.join("secret.txt"), "secret").unwrap();
        let wt_str = wt.to_str().unwrap().to_string();

        // cwd=wt 内文件 → 放行
        assert!(dev_exec_validate_paths(&wt_str, &sv(&["cat", "ok.txt"])).is_ok());
        // 指向兄弟目录 wt2 的文件（../wt2/secret.txt）→ 组件级判断拒绝
        assert!(dev_exec_validate_paths(&wt_str, &sv(&["cat", "../wt2/secret.txt"])).is_err());
        // 直接以 wt2 为参数路径（若它相对 wt 根不存在则放行，但 wt2/secret 经 ../ 逃逸必须拒绝）
        assert!(dev_exec_validate_paths(&wt_str, &sv(&["head", "../wt2/secret.txt"])).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归：worktree 前缀碰撞不得误判。
    /// `Path::starts_with` 是组件级判断，`C:\repo\wt2` 不视为 `C:\repo\wt` 的子路径。
    /// 登记 worktree `wt` 后，cwd=`wt2` 必须被拒绝，而 `wt` 的真实子目录必须被允许。
    #[test]
    fn dev_cwd_kind_no_wt_prefix_collision() {
        let _test_guard = lock_dev_state_tests();
        let base = std::env::temp_dir().join(format!("sm_wt_prefix_{}", std::process::id()));
        let wt = base.join("wt");
        let wt2 = base.join("wt2");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&wt2).unwrap();
        std::fs::create_dir_all(wt.join("src")).unwrap();

        // 向全局 DEV_STATE 登记 wt（不含 wt2）
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.worktrees.push(wt.to_str().unwrap().to_string());
        }
        let wt_str = wt.to_str().unwrap().to_string();
        let wt2_str = wt2.to_str().unwrap().to_string();

        // wt 自身 → Worktree（命中）
        assert!(matches!(dev_cwd_kind(&wt_str), Ok(DevCwdKind::Worktree(_))));
        // wt 的真实子目录 → 仍属该 worktree（符合设计）
        assert!(dev_cwd_kind(&wt.join("src").to_str().unwrap().to_string()).is_ok());
        // wt2 → 不得误判为 wt 的子路径（前缀碰撞防护）
        assert!(
            dev_cwd_kind(&wt2_str).is_err(),
            "wt2 不得误判为 wt 的子路径"
        );

        // 清理：从全局状态移除登记并删除临时目录
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.worktrees.retain(|w| w != &wt_str);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn codex_worker_cwd_requires_a_registered_worktree() {
        let _test_guard = lock_dev_state_tests();
        let base = std::env::temp_dir().join(format!("sm_codex_worker_cwd_{}", std::process::id()));
        let workers = std::path::PathBuf::from(format!("{}-workers", base.to_string_lossy()));
        let wt = workers.join("wt");
        let child = wt.join("src");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&workers);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&workers).unwrap();
        std::fs::write(base.join("README.md"), "fixture").unwrap();
        let git = |args: &[&str], cwd: &std::path::Path| {
            let output = Command::new(resolve_dev_program("git"))
                .args(args)
                .current_dir(cwd)
                .env_clear()
                .envs(dev_sanitized_env())
                .output()
                .unwrap();
            assert!(output.status.success(), "git fixture command failed");
        };
        git(&["init", "-q"], &base);
        git(&["config", "user.email", "test@example.invalid"], &base);
        git(&["config", "user.name", "SlimeMold Test"], &base);
        git(&["add", "README.md"], &base);
        git(&["commit", "-qm", "fixture"], &base);
        let wt_str = wt.to_string_lossy().to_string();
        git(
            &["worktree", "add", "-q", &wt_str, "-b", "worker/wt", "HEAD"],
            &base,
        );
        std::fs::create_dir_all(&child).unwrap();
        let base_str = base.to_string_lossy().to_string();

        let generation = dev_init_session(base_str.clone()).unwrap();
        assert!(dev_register_worktree(wt_str.clone(), generation).is_err());
        record_pending_worktree_add(&base, &wt_str, "worker/wt");
        assert!(dev_register_worktree(wt_str.clone(), generation).is_ok());
        assert!(!dev_main_repo_git_allowed_at(
            &sv(&["git", "worktree", "remove", "--force", &wt_str]),
            Some(&base),
        ));
        assert!(!dev_main_repo_git_allowed_at(
            &sv(&["git", "branch", "-D", "worker/wt"]),
            Some(&base),
        ));
        dev_register_worktree(wt_str.clone(), generation).unwrap();
        let expected = dev_strip_verbatim(&wt.canonicalize().unwrap());
        assert_eq!(assert_registered_worktree(&wt_str).unwrap(), expected);
        assert_eq!(
            assert_registered_worktree(child.to_str().unwrap()).unwrap(),
            expected
        );
        assert!(assert_registered_worktree(&base_str).is_err());
        dev_clear_session(generation).unwrap();
        git(&["worktree", "remove", "--force", &wt_str], &base);
        let _ = std::fs::remove_dir_all(&workers);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolves_windows_command_shim_before_spawning() {
        let base = std::env::temp_dir().join(format!("sm_dev_program_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // Windows 的 Node 安装可能同时包含无扩展名 npm 脚本和可启动的 npm.cmd。
        std::fs::write(base.join("npm"), "#!/usr/bin/env node\n").unwrap();
        std::fs::write(base.join("npm.cmd"), "@echo off\r\n").unwrap();

        let resolved = resolve_dev_program_from_path("npm", Some(base.as_os_str()));

        #[cfg(windows)]
        assert_eq!(resolved, base.join("npm.cmd"));
        #[cfg(not(windows))]
        assert_eq!(resolved, std::path::PathBuf::from("npm"));

        let _ = std::fs::remove_dir_all(&base);
    }
}

/* ---------------- dev_write_file 符号链接逃逸（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_write_symlink_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 在临时目录构造「worktree」，写入/读取经由公开函数走宿主登记态。
    fn with_registered_worktree(f: impl FnOnce(PathBuf)) {
        let _test_guard = lock_dev_state_tests();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = std::env::temp_dir().join(format!("sm_h4_wt_{}_{}", std::process::id(), suffix));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let tmp_str = tmp.to_string_lossy().to_string();
        // 登记为 worktree
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.generation = next_session_generation(st.generation);
            st.base_repo = Some(tmp_str.clone());
            st.worktrees.clear();
            st.worktrees.push(tmp_str);
        }
        let cleanup = tmp.clone();
        f(tmp);
        let _ = fs::remove_dir_all(&cleanup);
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.generation = next_session_generation(st.generation);
            st.base_repo = None;
            st.worktrees.clear();
        }
    }

    fn current_generation() -> u64 {
        DEV_STATE.lock().unwrap().generation
    }

    #[test]
    fn symlink_escape_write_rejected() {
        with_registered_worktree(|wt| {
            // worktree 外创建目标文件（模拟宿主重要文件）
            let outside = wt.parent().unwrap().join("sm_h4_outside.txt");
            fs::write(&outside, "secret").unwrap();
            // worktree 内创建指向外部的 symlink
            let link = wt.join("link.txt");
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&outside, &link).unwrap();
            }
            #[cfg(windows)]
            {
                // Windows 创建 symlink 需管理员/开发者模式：无权限则跳过（代码路径已由 unix/CI 覆盖）
                if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
                    eprintln!("[skip] Windows 无 symlink 权限，跳过 symlink 逃逸测试");
                    return;
                }
            }
            // 通过 dev_write_file 写 symlink → 必须拒绝
            let res = dev_write_file(
                link.to_string_lossy().to_string(),
                "overwrite".into(),
                current_generation(),
            );
            assert!(res.is_err(), "写入 symlink 应被拒绝（防逃逸）");
            let content = fs::read_to_string(&outside).unwrap();
            assert_eq!(content, "secret", "外部文件不得被篡改");
        });
    }

    #[test]
    fn normal_write_within_worktree_ok() {
        with_registered_worktree(|wt| {
            let target = wt.join("new_file.txt");
            let res = dev_write_file(
                target.to_string_lossy().to_string(),
                "hello".into(),
                current_generation(),
            );
            assert!(res.is_ok(), "worktree 内普通新文件应可写");
            assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        });
    }

    #[test]
    fn create_dir_within_worktree_ok() {
        with_registered_worktree(|wt| {
            let target = wt.join("src");
            let res = dev_create_dir(target.to_string_lossy().to_string(), current_generation());
            assert!(res.is_ok(), "worktree 内新目录应可创建");
            assert!(target.is_dir());
        });
    }

    #[test]
    fn create_dir_rejects_parent_escape() {
        with_registered_worktree(|wt| {
            let res = dev_create_dir(
                wt.join("..").join("outside").to_string_lossy().to_string(),
                current_generation(),
            );
            assert!(res.is_err(), "目录创建不得包含 .. 逃逸");
        });
    }

    #[test]
    fn create_dir_rejects_symlink_escape() {
        with_registered_worktree(|wt| {
            let outside = wt.parent().unwrap().join("sm_h4_outside_dir");
            fs::create_dir_all(&outside).unwrap();
            let link = wt.join("linked");
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&outside, &link).unwrap();
            }
            #[cfg(windows)]
            {
                if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
                    eprintln!("[skip] Windows 无 symlink 权限，跳过目录 symlink 逃逸测试");
                    return;
                }
            }
            let res = dev_create_dir(
                link.join("child").to_string_lossy().to_string(),
                current_generation(),
            );
            assert!(res.is_err(), "目录创建不得跟随指向 worktree 外部的 symlink");
            assert!(!outside.join("child").exists());
            let _ = fs::remove_dir_all(&outside);
        });
    }

    #[cfg(windows)]
    #[test]
    fn hardlink_escape_write_rejected() {
        with_registered_worktree(|wt| {
            let outside = wt.parent().unwrap().join("sm_h4_hardlink_outside.txt");
            let link = wt.join("hardlink.txt");
            fs::write(&outside, "secret").unwrap();
            if fs::hard_link(&outside, &link).is_err() {
                return;
            }
            let result = dev_write_file(
                link.to_string_lossy().to_string(),
                "overwrite".into(),
                current_generation(),
            );
            assert!(result.is_err(), "写入 hardlink 应被拒绝（防 inode 逃逸）");
            assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
            let _ = fs::remove_file(&outside);
        });
    }

    #[test]
    fn registered_worktree_identity_requires_generation_path_and_branch() {
        let registered = RegisteredWorktree {
            generation: 7,
            path: "D:/workers/worker-a".into(),
            branch: "worker/worker-a".into(),
        };
        assert!(registered_worktree_identity_matches(
            &registered,
            7,
            "d:/workers/worker-a",
            "worker/worker-a",
        ));
        assert!(!registered_worktree_identity_matches(
            &registered,
            7,
            "D:/workers/worker-a",
            "worker/worker-b",
        ));
        assert!(!registered_worktree_identity_matches(
            &registered,
            8,
            "D:/workers/worker-a",
            "worker/worker-a",
        ));
    }

    #[test]
    fn cleanup_capability_requires_exact_single_use_identity() {
        let binding = CleanupBinding {
            token: "token-1".into(),
            generation: 3,
            path: "D:/workers/worker-a".into(),
            branch: "worker/worker-a".into(),
            branch_revision: "a".repeat(40),
            consumed: false,
        };
        assert!(cleanup_binding_matches(
            &binding,
            "token-1",
            3,
            "d:/workers/worker-a",
            "worker/worker-a",
            &"a".repeat(40),
        ));
        assert!(!cleanup_binding_matches(
            &binding,
            "token-2",
            3,
            "D:/workers/worker-a",
            "worker/worker-a",
            &"a".repeat(40),
        ));
        assert!(!cleanup_binding_matches(
            &binding,
            "token-1",
            3,
            "D:/workers/worker-a",
            "worker/worker-a",
            &"b".repeat(40),
        ));
        let mut consumed = binding;
        consumed.consumed = true;
        assert!(!cleanup_binding_matches(
            &consumed,
            "token-1",
            3,
            "D:/workers/worker-a",
            "worker/worker-a",
            &"a".repeat(40),
        ));
    }
}
