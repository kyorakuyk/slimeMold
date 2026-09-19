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
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod antigravity;
mod codex;
mod dev_command_policy;
mod dev_process;
mod event_store;
mod fs_guard;

pub(crate) use dev_process::{spawn_output_reader, OutputReceiver, OutputThread};
use dev_process::{DevExecResult, DEV_OUTPUT_CAP};
#[cfg(test)]
pub(crate) use fs_guard::protected_relative_path;
use fs_guard::{
    canonicalize_dev_exec_args, dev_arg_path_lexically_safe, dev_arg_shell_safe,
    dev_exec_validate_paths, dev_strip_verbatim, is_git_diff_revision, path_compare_key,
    path_is_same_or_child, protected_path_error, protected_path_is_execution_only_script,
};

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

pub(crate) fn dev_base_repo() -> Result<PathBuf, String> {
    assert_base_identity_current("dev_base_repo")
}

fn assert_base_identity_current(operation: &str) -> Result<PathBuf, String> {
    let (base, expected_identity) = {
        let state = DEV_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| format!("{operation}: 尚未初始化主仓库根"))?,
            state
                .base_identity
                .clone()
                .ok_or_else(|| format!("{operation}: 主仓库缺少 stable directory identity"))?,
        )
    };
    let base_path = PathBuf::from(&base);
    let current_identity = stable_directory_identity(&base_path)
        .map_err(|error| format!("{operation}: 无法重新绑定主仓库 identity：{error}"))?;
    if current_identity != expected_identity {
        return Err(format!("{operation}: 主仓库 directory identity 已变化"));
    }
    let state = DEV_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&expected_identity)
    {
        return Err(format!(
            "{operation}: 主仓库 session 在 identity 校验期间发生变化"
        ));
    }
    Ok(base_path)
}

pub(crate) fn assert_session_generation(expected: u64, operation: &str) -> Result<(), String> {
    if expected == 0 {
        return Err(format!("{operation}: 缺少有效 session generation"));
    }
    let (has_base, has_identity, current_generation) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state.base_repo.is_some(),
            state.base_identity.is_some(),
            state.generation,
        )
    };
    if !has_base || !has_identity || current_generation != expected {
        return Err(format!(
            "{operation}: session generation 已失效（expected={expected}, current={current_generation}）"
        ));
    }
    assert_base_identity_current(operation).map(|_| ())
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
    base_identity: Option<StableDirectoryIdentity>,
    worktrees: Vec<String>,
    registrations: Vec<RegisteredWorktree>,
    cleanup_bindings: Vec<CleanupBinding>,
    pending_worktrees: Vec<PendingWorktree>,
    orphan_worktrees: Vec<PendingWorktree>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StableDirectoryIdentity {
    canonical_path: String,
    volume_or_device: u64,
    file_or_inode: u64,
}

fn stable_directory_identity(path: &std::path::Path) -> Result<StableDirectoryIdentity, String> {
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "无法绑定 worktree directory identity（{}）：{error}",
            path.display()
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        format!(
            "无法读取 worktree directory identity（{}）：{error}",
            canonical.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "worktree identity target 不是目录：{}",
            canonical.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let volume_or_device = metadata.dev();
        let file_or_inode = metadata.ino();
        if volume_or_device == 0 || file_or_inode == 0 {
            return Err(format!(
                "worktree identity platform identifiers 不可用：{}",
                canonical.display()
            ));
        }
        return Ok(StableDirectoryIdentity {
            canonical_path: canonical.to_string_lossy().to_string(),
            volume_or_device,
            file_or_inode,
        });
    }
    #[cfg(windows)]
    {
        use std::mem::MaybeUninit;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&canonical)
            .map_err(|error| {
                format!(
                    "无法打开 worktree directory identity（{}）：{error}",
                    canonical.display()
                )
            })?;
        let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(format!(
                "无法读取 worktree directory identity：{}",
                canonical.display()
            ));
        }
        let info = unsafe { info.assume_init() };
        let volume_or_device = info.volume_serial as u64;
        let file_or_inode =
            (u64::from(info.file_index_high) << 32) | u64::from(info.file_index_low);
        if volume_or_device == 0 || file_or_inode == 0 {
            return Err(format!(
                "worktree identity platform identifiers 不可用：{}",
                canonical.display()
            ));
        }
        return Ok(StableDirectoryIdentity {
            canonical_path: canonical.to_string_lossy().to_string(),
            volume_or_device,
            file_or_inode,
        });
    }
    #[cfg(not(any(unix, windows)))]
    Err("当前平台不支持稳定 worktree directory identity".to_string())
}

#[derive(Clone)]
struct RegisteredWorktree {
    generation: u64,
    path: String,
    branch: String,
    identity: StableDirectoryIdentity,
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

fn registered_worktree_identity_conflicts(
    registrations: &[RegisteredWorktree],
    generation: u64,
    path: &str,
    branch: &str,
    identity: &StableDirectoryIdentity,
) -> bool {
    registrations.iter().any(|registered| {
        registered_worktree_identity_matches(registered, generation, path, branch)
            && registered.identity != *identity
    })
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
    base_identity: StableDirectoryIdentity,
    target_identity: Option<StableDirectoryIdentity>,
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
    identity: Option<StableDirectoryIdentity>,
    branch_revision: Option<String>,
    removed: bool,
}

impl DevState {
    const fn new() -> Self {
        DevState {
            generation: 0,
            base_repo: None,
            base_identity: None,
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

/// 命令名白名单（与前端 capabilities 的 DEFAULT_SHELL_RULES / DEFAULT_TEST_RULES 命令名一致）。
const DEV_ALLOWED_CMDS: &[&str] = &[
    "pwd", "echo", "ls", "cat", "find", "head", "tail", "grep", "git", "node", "tsc", "vitest",
    "tsx", "npm",
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
    let resolved = resolve_dev_program_from_path(name, std::env::var_os("PATH").as_deref());
    #[cfg(windows)]
    {
        if let Some(trusted) = trusted_windows_program(&resolved) {
            return trusted;
        }
        return std::path::PathBuf::from(
            r"C:\Windows\System32\__slimemold_untrusted_program__.exe",
        );
    }
    #[cfg(not(windows))]
    {
        resolved
    }
}

fn dev_lexical_abs_of(raw: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(raw);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let state = DEV_STATE.lock().unwrap();
    let base = state
        .base_repo
        .as_ref()
        .ok_or_else(|| format!("路径是相对的，但未初始化主仓库根：{raw}"))?;
    Ok(std::path::Path::new(base).join(path))
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
pub(crate) enum DevCwdKind {
    MainRepo,
    Worktree(std::path::PathBuf),
}

/// 判定 cwd 归属（主仓库根 / 已登记 worktree）。
pub(crate) fn dev_cwd_binding(cwd: &str) -> Result<(DevCwdKind, StableDirectoryIdentity), String> {
    let p = std::path::Path::new(cwd);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("dev_exec: cwd 禁止包含 '..' 路径逃逸：{cwd}"));
    }
    let has_base = DEV_STATE.lock().unwrap().base_repo.is_some();
    if has_base {
        assert_base_identity_current("dev_cwd_kind")?;
    }
    let lexical_cwd = dev_lexical_abs_of(cwd)?;
    let (lexical_is_base, registered_candidate, has_registrations, has_base) = {
        let state = DEV_STATE.lock().unwrap();
        let base_match = state.base_repo.as_ref().is_some_and(|base| {
            path_compare_key(&lexical_cwd.to_string_lossy()) == path_compare_key(base)
        });
        let candidate = state
            .registrations
            .iter()
            .find(|registered| {
                path_is_same_or_child(
                    &dev_strip_verbatim(&lexical_cwd),
                    &dev_strip_verbatim(std::path::Path::new(&registered.path)),
                )
            })
            .cloned();
        (
            base_match,
            candidate,
            !state.registrations.is_empty(),
            state.base_repo.is_some(),
        )
    };
    if let Some(registered) = registered_candidate {
        let registered_path = dev_strip_verbatim(std::path::Path::new(&registered.path));
        let current_identity = stable_directory_identity(&registered_path)
            .map_err(|error| format!("dev_exec: 无法重新绑定已登记 worktree identity：{error}"))?;
        if current_identity != registered.identity {
            return Err(format!(
                "dev_exec: 已登记 worktree identity 已变化：{}",
                registered.path
            ));
        }
        let canon = dev_abs_of(cwd)?;
        let norm_canon = dev_strip_verbatim(&canon);
        if !path_is_same_or_child(&norm_canon, &registered_path) {
            return Err(format!(
                "dev_exec: cwd canonical target 脱离原已登记 worktree：{cwd}"
            ));
        }
        let cwd_identity = stable_directory_identity(&norm_canon)
            .map_err(|error| format!("dev_exec: 无法绑定 cwd identity：{error}"))?;
        return Ok((DevCwdKind::Worktree(norm_canon), cwd_identity));
    }
    if !lexical_is_base && has_registrations {
        return Err(format!(
            "dev_exec: cwd 未按 lexical path 命中已登记 worktree：{cwd}"
        ));
    }
    if has_base && !lexical_is_base {
        return Err(format!(
            "dev_exec: cwd 未按 lexical path 命中当前主仓库根：{cwd}"
        ));
    }
    if lexical_is_base {
        let (base_path, base_identity) = {
            let state = DEV_STATE.lock().unwrap();
            (state.base_repo.clone(), state.base_identity.clone())
        };
        if base_path.is_some() && base_identity.is_none() {
            return Err("dev_exec: 主仓库 registration 缺少 stable directory identity".into());
        }
        if let (Some(base_path), Some(expected_identity)) = (base_path, base_identity) {
            let base = std::path::PathBuf::from(&base_path);
            let current_identity = stable_directory_identity(&base)
                .map_err(|error| format!("dev_exec: 无法重新绑定主仓库 identity：{error}"))?;
            if current_identity != expected_identity {
                return Err("dev_exec: 主仓库 directory identity 已变化".into());
            }
            let canon = dev_abs_of(cwd)?;
            if path_compare_key(&canon.to_string_lossy()) != path_compare_key(&base_path) {
                return Err("dev_exec: 主仓库 canonical target 已变化".into());
            }
            let cwd_identity = stable_directory_identity(&canon)
                .map_err(|error| format!("dev_exec: 无法绑定 cwd identity：{error}"))?;
            return Ok((DevCwdKind::MainRepo, cwd_identity));
        }
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
            let cwd_identity = stable_directory_identity(&norm_canon)
                .map_err(|error| format!("dev_exec: 无法绑定 cwd identity：{error}"))?;
            return Ok((DevCwdKind::MainRepo, cwd_identity));
        }
    }
    for registered in &state.registrations {
        let norm_wc = dev_strip_verbatim(std::path::Path::new(&registered.path));
        if path_is_same_or_child(&norm_canon, &norm_wc) {
            let current_identity = stable_directory_identity(&norm_wc).map_err(|error| {
                format!("dev_exec: 无法重新绑定已登记 worktree identity：{error}")
            })?;
            if current_identity != registered.identity {
                return Err(format!(
                    "dev_exec: 已登记 worktree identity 已变化：{}",
                    registered.path
                ));
            }
            let cwd_identity = stable_directory_identity(&norm_canon)
                .map_err(|error| format!("dev_exec: 无法绑定 cwd identity：{error}"))?;
            return Ok((DevCwdKind::Worktree(norm_canon), cwd_identity));
        }
    }
    for w in &state.worktrees {
        let norm_wc = dev_strip_verbatim(std::path::Path::new(w));
        if path_is_same_or_child(&norm_canon, &norm_wc) {
            let cwd_identity = stable_directory_identity(&norm_canon)
                .map_err(|error| format!("dev_exec: 无法绑定 cwd identity：{error}"))?;
            return Ok((DevCwdKind::Worktree(norm_canon), cwd_identity));
        }
    }
    Err(format!(
        "dev_exec: cwd 不属于已登记 worktree 或主仓库根：{cwd}"
    ))
}

fn dev_cwd_kind(cwd: &str) -> Result<DevCwdKind, String> {
    Ok(dev_cwd_binding(cwd)?.0)
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
        || exact(&["git", "diff", "--name-only", "HEAD"])
        || exact(&["git", "diff", "--name-only"])
        || exact(&["git", "ls-files", "--others", "--exclude-standard"])
        || (args.len() == 5
            && args[1] == "log"
            && args[2] == "--oneline"
            && args[3] == "-n"
            && args[4].chars().all(|c| c.is_ascii_digit()))
        || (args.len() == 4
            && args[1] == "show-ref"
            && args[2] == "--verify"
            && args[3].starts_with("refs/heads/worker/w-")
            && safe_git_revision_arg(&args[3]))
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

fn worker_target_is_safe_for_existing_operation(repo: &std::path::Path, raw_path: &str) -> bool {
    if !worker_target_is_valid(repo, raw_path) {
        return false;
    }
    let target = repo_target_path(repo, raw_path);
    let worker_root = worker_root_path(repo);
    let Ok(real_root) = worker_root.canonicalize() else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(&target) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return false;
    }
    let Ok(real_target) = target.canonicalize() else {
        return false;
    };
    path_compare_key(&real_target.to_string_lossy()) == path_compare_key(&target.to_string_lossy())
        && path_is_same_or_child(&real_target, &real_root)
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
        Some("add") if args.len() == 6 && args[3] == "-q" => {
            main_repo_worktree_target_is_valid(repo, &args[4], &args[5])
        }
        Some("remove") if args.len() == 5 && args[3] == "--force" => {
            worker_target_is_safe_for_existing_operation(repo, &args[4])
        }
        Some("lock") | Some("unlock") if args.len() == 4 => {
            worker_target_is_safe_for_existing_operation(repo, &args[3])
        }
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
    if args.len() == 6 && args[3] == "-q" {
        return Some((&args[4], &args[5]));
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
    let Some(pending) = state.pending_worktrees.iter().find(|pending| {
        pending.generation == state.generation
            && !pending.removed
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
    }) else {
        return false;
    };
    let Some(expected_identity) = &pending.identity else {
        return false;
    };
    stable_directory_identity(&target).is_ok_and(|current| current == *expected_identity)
}

fn pending_worker_branch(repo: &std::path::Path, branch: &str, expected_revision: &str) -> bool {
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
            && pending.branch_revision.as_deref() == Some(expected_revision)
            && path_compare_key(&pending.path) == path_compare_key(&target.to_string_lossy())
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
    let target_identity = stable_directory_identity(std::path::Path::new(&stored_path)).ok();
    let branch_revision = git_branch_revision(repo, branch).ok();
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
            identity: target_identity,
            branch_revision,
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

fn dev_main_repo_git_allowed_at(args: &[String], repo: Option<&std::path::Path>) -> bool {
    if args.first().map(|value| value.as_str()) == Some("git")
        && matches!(args.get(1).map(|value| value.as_str()), Some("worktree"))
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
    if args.first().map(|value| value.as_str()) == Some("git")
        && args.len() == 5
        && args[1] == "rev-parse"
        && args[2] == "--verify"
        && args[3] == "--end-of-options"
    {
        let Some(branch) = worker_branch_from_tip_arg(&args[4]) else {
            return false;
        };
        return repo.is_some_and(|_path| {
            // Branch-tip lookup is read-only and is needed after a process restart,
            // when the live worktree has no current-host pending lease yet.
            worker_branch_is_valid(branch)
        });
    }
    if args.first().map(|value| value.as_str()) == Some("git")
        && args.len() == 5
        && args[1] == "update-ref"
        && args[2] == "-d"
    {
        return repo.is_some_and(|path| {
            let Some(branch) = worker_branch_from_ref_arg(&args[3]) else {
                return false;
            };
            is_full_object_id(&args[4]) && pending_worker_branch(path, branch, &args[4])
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

/// 统一子进程生命周期入口；实际捕获/超时/等待编排位于 `dev_process`。
fn kill_dev_child_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            let _ = libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new(resolve_dev_program("taskkill"))
            .args(["/PID", &pid, "/T", "/F"])
            .status();
    }
    let _ = child.kill();
}

fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<DevExecResult, String> {
    dev_process::run_with_timeout(cmd, timeout, kill_dev_child_tree)
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

fn grep_args_are_safe(args: &[String]) -> bool {
    let mut options = true;
    let mut pattern_index = None;
    for (index, argument) in args.iter().enumerate() {
        if options && argument == "--" {
            options = false;
            continue;
        }
        if options && argument.starts_with('-') {
            if !grep_option_is_safe(argument) {
                return false;
            }
        } else {
            pattern_index = Some(index);
            break;
        }
    }
    let Some(pattern_index) = pattern_index else {
        return false;
    };
    args.iter().skip(pattern_index + 1).all(|argument| {
        !argument.starts_with('-')
            && !argument.contains('*')
            && !argument.contains('?')
            && dev_arg_path_lexically_safe(argument)
    })
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
    arg.len() <= 128 && is_git_diff_revision(arg)
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
        // 只读查询命令（无写盘能力：pwd/echo/ls/cat/head/tail）；路径参数须词法安全，
        // 暂不接受命令选项，避免选项携带第二套外部文件输入协议（如 head --files0-from）。
        "pwd" => rest.is_empty(),
        "echo" => true, // 直接 spawn 无 shell 重定向，echo 仅输出，无害
        "ls" | "cat" | "head" | "tail" => rest
            .iter()
            .all(|argument| !argument.starts_with('-') && dev_arg_path_lexically_safe(argument)),
        "find" => {
            !rest
                .iter()
                .any(|a| a.starts_with('-') && !find_option_is_safe(a))
                && rest
                    .iter()
                    .filter(|a| !a.starts_with('-'))
                    .all(|a| *a == "." || dev_arg_path_lexically_safe(a))
                && match rest
                    .iter()
                    .skip_while(|argument| matches!(argument.as_str(), "-P" | "-L" | "-H"))
                    .next()
                    .map(|value| value.as_str())
                {
                    None | Some(".") => true,
                    Some(root) => dev_arg_path_lexically_safe(root),
                }
        }
        // grep 只读；未知选项一律拒绝，避免 --file/--exclude-from 等外部文件输入。
        "grep" => grep_args_are_safe(rest),
        // git 只读 + 精确参数（与前端 shell 白名单 matchesRule 语义一致；明确排除所有写入型）
        "git" => {
            if rest.first().map(String::as_str) == Some("--no-pager") {
                return dev_command_policy::hardened_git_diff_is_supported(args);
            }
            if rest.first().map(String::as_str) == Some("diff") {
                return dev_command_policy::command_intent_kind(args).is_some();
            }
            rest_eq(&["status", "--porcelain"])
                || rest_eq(&["status", "--short"])
                || rest_eq(&["diff", "--name-only", "HEAD"])
                || rest_eq(&["diff", "--name-only"])
                || (rest.len() == 3
                    && rest[0] == "diff"
                    && rest[1] == "--name-only"
                    && safe_git_revision_arg(&rest[2]))
                // 前端 `git diff <path>`：argsPrefix ['diff']，min/maxExtra=1，禁 dash 额外参数；
                // 且路径须词法安全（禁绝对路径 / .. / drive）
                || (rest.len() >= 4
                    && rest[0] == "diff"
                    && is_git_diff_revision(&rest[1])
                    && rest[2] == "--"
                    && rest[3..].iter().all(|path| {
                        !path.starts_with('-')
                            && !path.contains('*')
                            && !path.contains('?')
                            && dev_arg_path_lexically_safe(path)
                    }))
                || (rest.len() == 2
                    && rest[0] == "diff"
                    && is_git_diff_revision(&rest[1]))
                || (rest.len() == 2
                    && rest[0] == "diff"
                    && !is_git_diff_revision(&rest[1])
                    && dev_arg_path_lexically_safe(&rest[1])
                    && !rest[1].starts_with('-')
                    && !rest[1].chars().all(|c| matches!(c, '.' | '/' | '\\'))
                    && !rest[1].contains('*')
                    && !rest[1].contains('?')
                    && !rest[1].contains("--output=")
                    && !rest[1].contains("--no-index")
                    && !rest[1].contains("--ext-diff"))
                // 前端 `git log --oneline -n <num>`：argsPrefix ['log','--oneline','-n']，恰好 1 个数字参数
                || (rest.len() == 4
                    && rest[0] == "log"
                    && rest[1] == "--oneline"
                    && rest[2] == "-n"
                    && rest[3].chars().all(|c| c.is_ascii_digit()))
                // Worktree allocator 的 branch collision probe：只读、只允许本项目生成的 worker ref。
                || (rest.len() == 3
                    && rest[0] == "show-ref"
                    && rest[1] == "--verify"
                    && rest[2].starts_with("refs/heads/worker/w-")
                    && safe_git_revision_arg(&rest[2]))
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
                    && rest[3..]
                        .iter()
                        .all(|arg| !arg.starts_with('-') && dev_arg_path_lexically_safe(arg)))
                || (rest.len() >= 2
                    && rest[0] == "--noEmit"
                    && rest[1..].len() <= 20
                    && rest[1..]
                        .iter()
                        .all(|arg| !arg.starts_with('-') && dev_arg_path_lexically_safe(arg)))
        }
        "vitest" => rest_eq(&["run"]),
        "tsx" => {
            // 仅本地脚本 scripts/ 前缀 + 最多 2 个额外参数；脚本路径须词法安全
            !rest.is_empty()
                && rest[0].starts_with("scripts/")
                && !rest[0].starts_with("scripts/../")
                && dev_arg_path_lexically_safe(&rest[0])
                && rest.len() <= 3
                && rest[1..]
                    .iter()
                    .all(|argument| !argument.starts_with('-') && dev_arg_shell_safe(argument))
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

fn resolve_dev_exec_program(name: &str) -> std::path::PathBuf {
    let from_path = resolve_dev_program(name);
    if from_path.is_file() {
        return from_path;
    }
    #[cfg(windows)]
    {
        let mut roots = DEV_STATE
            .lock()
            .unwrap()
            .base_repo
            .clone()
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>();
        if let Ok(exe) = std::env::current_exe() {
            roots.extend(exe.ancestors().map(std::path::Path::to_path_buf));
        }
        for root in roots {
            let bin = root.join("node_modules").join(".bin");
            for extension in [".cmd", ".bat", ".exe"] {
                let candidate = bin.join(format!("{name}{extension}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        if name == "node" {
            for candidate in [
                std::path::PathBuf::from(r"D:\Hermes\node\node.exe"),
                std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
                std::path::PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
            ] {
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    from_path
}

#[cfg(windows)]
fn trusted_windows_program(candidate: &std::path::Path) -> Option<std::path::PathBuf> {
    let metadata = fs::symlink_metadata(candidate).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    (path_compare_key(&canonical.to_string_lossy())
        == path_compare_key(&candidate.to_string_lossy()))
    .then_some(canonical)
}

#[cfg(windows)]
fn trusted_windows_comspec() -> Result<std::path::PathBuf, String> {
    let candidates = [
        std::env::var_os("ComSpec").map(std::path::PathBuf::from),
        std::env::var_os("SystemRoot")
            .map(|root| std::path::PathBuf::from(root).join("System32\\cmd.exe")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|candidate| {
            trusted_windows_program(&candidate).filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
            })
        })
        .ok_or_else(|| "dev_exec: 找不到可信的 Windows ComSpec".to_string())
}

fn command_for_dev_exec(args: &[String]) -> Result<std::process::Command, String> {
    let program = resolve_dev_exec_program(&args[0]);
    #[cfg(windows)]
    let program = trusted_windows_program(&program)
        .ok_or_else(|| format!("dev_exec: 命令未解析为可信绝对程序：{}", program.display()))?;
    #[cfg(windows)]
    {
        let extension = program
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("cmd" | "bat")) {
            let command_line = std::iter::once(windows_cmd_arg(&program.display().to_string()))
                .chain(args[1..].iter().map(|arg| windows_cmd_arg(arg)))
                .collect::<Vec<_>>()
                .join(" ");
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new(trusted_windows_comspec()?);
            command.args(["/D", "/S", "/C"]);
            command.raw_arg(format!("\"{command_line}\""));
            return Ok(command);
        }
    }
    let mut command = std::process::Command::new(program);
    command.args(&args[1..]);
    Ok(command)
}

/// H4 GUI 受控命令执行：
/// - 命令名白名单（DEV_ALLOWED_CMDS）；
/// - cwd 归属分级——主仓库根**仅放行严格只读 git 管理命令**（rev-parse/worktree list 等），
///   完整白名单（npm/tsx/写入型 git）仅在**已登记 worktree** 内可用；
/// - 剥离凭据 env + 超时。
#[tauri::command]
fn dev_exec(args: Vec<String>, cwd: String, generation: u64) -> Result<DevExecResult, String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_exec").map_err(|error| {
        eprintln!(
            "[dev_exec] session reject args={} cwd={} error={error}",
            args.join(" "),
            cwd
        );
        error
    })?;
    let operation_generation = generation;
    let (kind, initial_cwd_identity) = dev_cwd_binding(&cwd).map_err(|error| {
        eprintln!(
            "[dev_exec] cwd reject args={} cwd={} error={error}",
            args.join(" "),
            cwd
        );
        error
    })?;
    let canonical_cwd = match &kind {
        DevCwdKind::MainRepo => dev_abs_of(&cwd).map_err(|error| {
            eprintln!(
                "[dev_exec] main cwd resolve reject args={} cwd={} error={error}",
                args.join(" "),
                cwd
            );
            error
        })?,
        DevCwdKind::Worktree(path) => path.clone(),
    };
    if !dev_exec_allowed_at(&kind, &args, Some(&canonical_cwd)) {
        eprintln!(
            "[dev_exec] command reject args={} cwd={}",
            args.join(" "),
            canonical_cwd.display()
        );
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
    let effective_args = if args.first().map(String::as_str) == Some("git")
        && args.get(1).map(String::as_str) == Some("diff")
    {
        dev_command_policy::git_diff_execution_args(&args)
            .ok_or_else(|| "dev_exec: Git diff intent 无法构造安全 invocation".to_string())?
    } else {
        args.clone()
    };
    // P1 兜底：对文件路径参数做 canonicalize（解析符号链接）校验，确认未逃逸出 worktree
    dev_exec_validate_paths(&canonical_cwd.to_string_lossy(), &effective_args).map_err(
        |error| {
            eprintln!(
                "[dev_exec] path reject args={} cwd={} error={error}",
                args.join(" "),
                canonical_cwd.display()
            );
            error
        },
    )?;
    let spawn_args =
        canonicalize_dev_exec_args(&canonical_cwd, &effective_args).map_err(|error| {
            eprintln!(
                "[dev_exec] argument canonicalization reject args={} cwd={} error={error}",
                args.join(" "),
                canonical_cwd.display()
            );
            error
        })?;
    if spawn_args.len() >= 8
        && spawn_args[0] == "git"
        && spawn_args[1] == "--no-pager"
        && spawn_args[2] == "diff"
        && spawn_args[6] == "--"
        && spawn_args[5] != "--name-only"
    {
        for pathspec in &spawn_args[7..] {
            git_diff_pathspec_allowed(&canonical_cwd, std::path::Path::new(pathspec))?;
        }
    }
    if matches!(kind, DevCwdKind::Worktree(_)) {
        let allow_execution_only_scripts = spawn_args
            .first()
            .and_then(|program| std::path::Path::new(program).file_stem())
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("tsx"));
        for argument in spawn_args.iter().skip(1) {
            let candidate = std::path::Path::new(argument);
            if candidate.is_absolute() {
                dev_exec_path_allowed(candidate, allow_execution_only_scripts)?;
                if candidate.is_file() && has_multiple_hardlinks(candidate)? {
                    return Err(format!(
                        "dev_exec: 拒绝执行 hardlink 文件 operand（防 inode 逃逸）：{}",
                        candidate.display()
                    ));
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let resolved_program = resolve_dev_exec_program(&spawn_args[0]);
        let resolved_program_text = resolved_program.to_string_lossy();
        let extension = resolved_program
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("cmd" | "bat"))
            && (!dev_arg_shell_safe(&resolved_program_text)
                || spawn_args
                    .iter()
                    .any(|argument| !dev_arg_shell_safe(argument)))
        {
            return Err("dev_exec: Windows shell 参数包含未允许的控制字符或元字符".into());
        }
    }
    let (spawn_kind, spawn_cwd_identity) = dev_cwd_binding(&cwd)?;
    if spawn_kind != kind || spawn_cwd_identity != initial_cwd_identity {
        return Err("dev_exec: spawn 前 cwd ownership 或 identity 已变化".into());
    }
    let mut cmd = command_for_dev_exec(&spawn_args).map_err(|error| {
        eprintln!(
            "[dev_exec] command resolution reject args={} cwd={} error={error}",
            args.join(" "),
            canonical_cwd.display()
        );
        error
    })?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let cwd_handle = open_unix_file_relative(
            &canonical_cwd,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
            None,
            Some(&_spawn_cwd_identity),
        )?;
        if stable_file_identity_from_file(&cwd_handle)? != _spawn_cwd_identity {
            return Err("spawn cwd directory identity 已变化".into());
        }
        unsafe {
            cmd.pre_exec(move || {
                if libc::fchdir(cwd_handle.as_raw_fd()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    cmd.current_dir(&canonical_cwd);
    cmd.env_clear();
    for (k, v) in dev_sanitized_env() {
        cmd.env(k, v);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(30)).map_err(|error| {
        eprintln!(
            "[dev_exec] {} cwd={} error={}",
            args.join(" "),
            canonical_cwd.display(),
            error
        );
        format!("dev_exec: {error}")
    })?;
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
    let base_identity = stable_directory_identity(&canon)?;
    codex::clear_codex_session_state()?;
    let mut st = DEV_STATE.lock().unwrap();
    st.generation = next_session_generation(st.generation);
    st.base_repo = Some(canon.to_string_lossy().to_string());
    st.base_identity = Some(base_identity);
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
    codex::clear_codex_session_state()?;
    let mut st = DEV_STATE.lock().unwrap();
    st.generation = next_session_generation(st.generation);
    st.base_repo = None;
    st.base_identity = None;
    st.worktrees.clear();
    st.registrations.clear();
    st.cleanup_bindings.clear();
    st.pending_worktrees.clear();
    st.orphan_worktrees.clear();
    Ok(())
}

fn validate_git_worktree_porcelain(output: &str) -> Result<(), String> {
    if output.is_empty() || output.len() >= DEV_OUTPUT_CAP {
        return Err("Git worktree list 输出为空或可能被截断".into());
    }
    let mut block_count = 0usize;
    for block in output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
    {
        let mut has_worktree = false;
        let mut has_head = false;
        for line in block.lines().map(str::trim_end) {
            if let Some(path) = line.strip_prefix("worktree ") {
                if path.trim().is_empty() || has_worktree {
                    return Err("Git worktree list porcelain 结构无效".into());
                }
                has_worktree = true;
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                if !is_full_object_id(head.trim()) || has_head {
                    return Err("Git worktree list HEAD 无效".into());
                }
                has_head = true;
            } else if line.starts_with("branch refs/heads/")
                || line == "detached"
                || line == "bare"
                || line.starts_with("locked")
                || line.starts_with("prunable")
            {
                continue;
            } else {
                return Err("Git worktree list porcelain 含未知字段".into());
            }
        }
        if !has_worktree || !has_head {
            return Err("Git worktree list porcelain 缺少 worktree/HEAD 字段".into());
        }
        block_count += 1;
    }
    if block_count == 0 {
        return Err("Git worktree list porcelain 没有有效 block".into());
    }
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
    validate_git_worktree_porcelain(&result.stdout)?;
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

fn git_branch_is_listed(repo: &std::path::Path, branch: &str) -> Result<bool, String> {
    let expected = format!("branch refs/heads/{branch}");
    Ok(git_worktree_list(repo)?
        .lines()
        .any(|line| line.trim() == expected))
}

fn git_branch_revision(repo: &std::path::Path, branch: &str) -> Result<String, String> {
    let mut cmd = Command::new(resolve_dev_program("git"));
    cmd.arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "--end-of-options"])
        .arg(format!("refs/heads/{branch}^{{commit}}"));
    cmd.env_clear();
    for (key, value) in dev_sanitized_env() {
        cmd.env(key, value);
    }
    let result = run_with_timeout(&mut cmd, Duration::from_secs(5))?;
    if result.code != 0 {
        return Err("Git branch revision probe 失败".into());
    }
    let revision = result.stdout.trim().to_string();
    if !is_full_object_id(&revision) {
        return Err("Git branch revision 输出无效".into());
    }
    Ok(revision)
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
    let (base, base_identity, registration_generation) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_register_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_register_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
            state.generation,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    if !canon.is_dir() {
        return Err(format!(
            "dev_register_worktree: worktree 不存在或不是目录：{path}"
        ));
    }
    let identity = stable_directory_identity(&canon)?;
    let name = canon
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "dev_register_worktree: worktree 目录名无效".to_string())?;
    let branch = format!("worker/{name}");
    if !main_repo_worktree_target_is_valid(&base_path, &canon.to_string_lossy(), &branch) {
        return Err("dev_register_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_worktree: Git probe 前主仓库 directory identity 已变化".into());
    }
    if !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_register_worktree: 目标不是主仓库登记的匹配 Worker worktree".into());
    }
    if stable_directory_identity(&canon)? != identity {
        return Err(
            "dev_register_worktree: worktree directory identity 在 Git probe 后发生变化".into(),
        );
    }
    let has_pending_lease = pending_worker_target(&base_path, &path);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_worktree: commit 前主仓库 directory identity 已变化".into());
    }
    let canonical_path = canon.to_string_lossy().to_string();
    let mut st = DEV_STATE.lock().unwrap();
    if st.base_repo.as_deref() != Some(base.as_str())
        || st.base_identity.as_ref() != Some(&base_identity)
        || st.generation != registration_generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_register_worktree: 主仓库 session 在校验期间发生变化".into());
    }
    if registered_worktree_identity_conflicts(
        &st.registrations,
        registration_generation,
        &canonical_path,
        &branch,
        &identity,
    ) {
        return Err("dev_register_worktree: 已登记 worktree identity 冲突".into());
    }
    let already_registered = st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        ) && registered.identity == identity
    });
    if !already_registered && !has_pending_lease {
        return Err("dev_register_worktree: 缺少当前 host 创建的 pending worktree lease".into());
    }
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
            identity: identity.clone(),
        });
    }
    st.pending_worktrees
        .retain(|pending| path_compare_key(&pending.path) != path_compare_key(&canonical_path));
    Ok(())
}

#[tauri::command]
fn dev_restore_worktree(path: String, branch: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_restore_worktree")?;
    if !worker_branch_is_valid(&branch) {
        return Err("dev_restore_worktree: branch 无效".to_string());
    }
    let (base, base_identity, registration_generation) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_restore_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_restore_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
            state.generation,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_restore_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let trusted_target_identity = {
        let state = DEV_STATE.lock().unwrap();
        state
            .registrations
            .iter()
            .find(|registered| {
                registered_worktree_identity_matches(
                    registered,
                    registration_generation,
                    &canon.to_string_lossy(),
                    &branch,
                )
            })
            .map(|registered| registered.identity.clone())
            .ok_or_else(|| {
                "dev_restore_worktree: 缺少 trusted target identity，拒绝重绑定当前路径".to_string()
            })?
    };
    if !canon.is_dir() {
        return Err(format!(
            "dev_restore_worktree: worktree 不存在或不是目录：{path}"
        ));
    }
    let identity = stable_directory_identity(&canon)?;
    if identity != trusted_target_identity {
        return Err(
            "dev_restore_worktree: current target identity 不匹配 trusted registration".into(),
        );
    }
    let canonical_path = canon.to_string_lossy().to_string();
    if !main_repo_worktree_target_is_valid(&base_path, &canonical_path, &branch) {
        return Err("dev_restore_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_restore_worktree: Git probe 前主仓库 directory identity 已变化".into());
    }
    if !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_restore_worktree: 目标不是主仓库登记的匹配 Worker worktree".into());
    }
    if stable_directory_identity(&canon)? != identity {
        return Err(
            "dev_restore_worktree: worktree directory identity 在 Git probe 后发生变化".into(),
        );
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_restore_worktree: commit 前主仓库 directory identity 已变化".into());
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != registration_generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_restore_worktree: 主仓库 session 在校验期间发生变化".into());
    }
    if registered_worktree_identity_conflicts(
        &state.registrations,
        registration_generation,
        &canonical_path,
        &branch,
        &identity,
    ) {
        return Err("dev_restore_worktree: 已登记 worktree identity 冲突".into());
    }
    if let Some(existing) = state.registrations.iter().find(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        )
    }) {
        if existing.identity != identity {
            return Err("dev_restore_worktree: 已登记 worktree identity 冲突".into());
        }
    }
    if !state
        .worktrees
        .iter()
        .any(|worktree| path_compare_key(worktree) == path_compare_key(&canonical_path))
    {
        state.worktrees.push(canonical_path.clone());
    }
    if !state.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(
            registered,
            registration_generation,
            &canonical_path,
            &branch,
        )
    }) {
        state.registrations.push(RegisteredWorktree {
            generation: registration_generation,
            path: canonical_path.clone(),
            branch,
            identity,
        });
    }
    state
        .pending_worktrees
        .retain(|pending| path_compare_key(&pending.path) != path_compare_key(&canonical_path));
    Ok(())
}

fn orphan_target_is_deleted_candidate(
    listed_match: bool,
    path_exists: bool,
    branch_exists: bool,
    target_is_scoped: bool,
) -> bool {
    !listed_match && !path_exists && branch_exists && target_is_scoped
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
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_register_orphan_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_register_orphan_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_register_orphan_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let target_metadata = match fs::symlink_metadata(&canon) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "dev_register_orphan_worktree: 无法读取 target metadata：{error}"
            ));
        }
    };
    if stable_directory_identity(&base_path)? != base_identity {
        return Err(
            "dev_register_orphan_worktree: Git probe 前主仓库 directory identity 已变化".into(),
        );
    }
    let listed_match = git_worktree_matches(&base_path, &canon, &branch)?;
    if stable_directory_identity(&base_path)? != base_identity {
        return Err(
            "dev_register_orphan_worktree: branch probe 前主仓库 directory identity 已变化".into(),
        );
    }
    let branch_listed_elsewhere = git_branch_is_listed(&base_path, &branch)?;
    let branch_exists = git_branch_exists(&base_path, &branch)?;
    let target_is_scoped = main_repo_worktree_target_is_valid(&base_path, &c, &branch);
    let target_exists = target_metadata.is_some();
    if !orphan_target_is_deleted_candidate(
        listed_match || branch_listed_elsewhere,
        target_exists,
        branch_exists,
        target_is_scoped,
    ) {
        return Err(
            "dev_register_orphan_worktree: 目标必须是受控且已删除的 Worker worktree".into(),
        );
    }
    if stable_directory_identity(&base_path)? != base_identity {
        return Err(
            "dev_register_orphan_worktree: commit 前主仓库 directory identity 已变化".into(),
        );
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
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
            identity: None,
            branch_revision: None,
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
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_approve_cleanup: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_approve_cleanup: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_approve_cleanup: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    let target_identity = match fs::symlink_metadata(&canon) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("dev_approve_cleanup: target 必须是目录或已消失的 orphan path".into());
        }
        Ok(_) => Some(stable_directory_identity(&canon)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "dev_approve_cleanup: 无法读取 target metadata：{error}"
            ))
        }
    };
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_approve_cleanup: 路径/分支不属于受控 Worker 根".into());
    }
    {
        let state = DEV_STATE.lock().unwrap();
        let registered_identity = state
            .registrations
            .iter()
            .find(|item| registered_worktree_identity_matches(item, generation, &c, &branch))
            .map(|item| item.identity.clone());
        let orphan = state.orphan_worktrees.iter().any(|item| {
            item.generation == generation
                && item.branch == branch
                && path_compare_key(&item.path) == path_compare_key(&c)
        });
        if registered_identity.is_some() && orphan {
            return Err("dev_approve_cleanup: target 同时存在 registered/orphan lineage".into());
        }
        if let Some(expected_identity) = registered_identity {
            if target_identity.as_ref() != Some(&expected_identity) {
                return Err(
                    "dev_approve_cleanup: 当前 target identity 不匹配原登记 identity".into(),
                );
            }
        } else if orphan {
            if target_identity.is_some() || git_branch_is_listed(&base_path, &branch)? {
                return Err(
                    "dev_approve_cleanup: orphan target 已重新出现或仍被 Git checkout".into(),
                );
            }
        } else {
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
    if target_identity.is_some() && !git_worktree_matches(&base_path, &canon, &branch)? {
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
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_approve_cleanup: 确认后主仓库 directory identity 已变化".into());
    }
    let current_target_identity = match (&target_identity, fs::symlink_metadata(&canon)) {
        (None, Err(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
        (Some(_), Ok(metadata)) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("dev_approve_cleanup: 确认后 target 不再是安全目录".into());
        }
        (Some(_), Ok(_)) => Some(stable_directory_identity(&canon)?),
        (None, Ok(_)) => return Err("dev_approve_cleanup: 确认后 orphan target 重新出现".into()),
        (_, Err(error)) => {
            return Err(format!(
                "dev_approve_cleanup: 确认后无法读取 target：{error}"
            ))
        }
    };
    if current_target_identity != target_identity {
        return Err("dev_approve_cleanup: 确认后 target directory identity 已变化".into());
    }
    let mut state = DEV_STATE.lock().unwrap();
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_approve_cleanup: session 在确认后发生变化".into());
    }
    if target_identity.is_some() && !git_worktree_matches(&base_path, &canon, &branch)? {
        return Err("dev_approve_cleanup: 确认后 Git worktree path/branch 已漂移".into());
    }
    state.cleanup_bindings.retain(|binding| !binding.consumed);
    state.cleanup_bindings.push(CleanupBinding {
        token: token.clone(),
        generation,
        path: c,
        branch,
        branch_revision,
        base_identity,
        target_identity,
        consumed: false,
    });
    Ok(token)
}

/// Native cleanup is capability-based: JS-side proposal validation is not sufficient.
/// `dev_approve_cleanup` issues a one-shot token only after revalidation and a native
/// confirmation dialog; `dev_cleanup_worktree` refuses every unbound destructive call.
fn cleanup_target_identity_is_current(
    repo: &std::path::Path,
    target: &std::path::Path,
    branch: &str,
    expected: Option<&StableDirectoryIdentity>,
) -> Result<bool, String> {
    match expected {
        Some(expected) => {
            let metadata = match fs::symlink_metadata(target) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(format!("无法读取 cleanup target metadata：{error}")),
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Ok(false);
            }
            Ok(stable_directory_identity(target)? == *expected)
        }
        None => {
            let absent = match fs::symlink_metadata(target) {
                Ok(_) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => return Err(format!("无法读取 orphan target metadata：{error}")),
            };
            Ok(absent && !git_branch_is_listed(repo, branch)?)
        }
    }
}

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
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_cleanup_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_cleanup_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_cleanup_worktree: 主仓库 directory identity 已变化".into());
    }
    let canon = dev_abs_of(&path)?;
    let c = canon.to_string_lossy().to_string();
    if !main_repo_worktree_target_is_valid(&base_path, &c, &branch) {
        return Err("dev_cleanup_worktree: 路径/分支不属于受控 Worker 根".into());
    }
    let expected_target_identity = {
        let state = DEV_STATE.lock().unwrap();
        let Some(capability) = state.cleanup_bindings.iter().find(|binding| {
            cleanup_binding_matches(
                binding,
                &approval_token,
                generation,
                &c,
                &branch,
                &branch_revision,
            )
        }) else {
            return Err("dev_cleanup_worktree: 缺少匹配的 native cleanup capability".into());
        };
        if capability.base_identity != base_identity {
            drop(state);
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: cleanup capability base identity 已漂移".into());
        }
        let registered_identity = state
            .registrations
            .iter()
            .find(|item| registered_worktree_identity_matches(item, generation, &c, &branch))
            .map(|item| item.identity.clone());
        let orphan = state.orphan_worktrees.iter().any(|item| {
            item.generation == generation
                && item.branch == branch
                && path_compare_key(&item.path) == path_compare_key(&c)
        });
        match (&capability.target_identity, registered_identity, orphan) {
            (Some(expected), Some(current), false) if expected == &current => {}
            (None, None, true) => {}
            _ => {
                drop(state);
                invalidate_cleanup_binding(&approval_token);
                return Err("dev_cleanup_worktree: cleanup lineage/identity 不匹配".into());
            }
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
        capability.target_identity.clone()
    };
    if !cleanup_target_identity_is_current(
        &base_path,
        &canon,
        &branch,
        expected_target_identity.as_ref(),
    )? {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: cleanup target identity 已漂移或 orphan 已重新出现".into(),
        );
    }
    if expected_target_identity.is_some() {
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
    if stable_directory_identity(&base_path)? != base_identity
        || !cleanup_target_identity_is_current(
            &base_path,
            &canon,
            &branch,
            expected_target_identity.as_ref(),
        )?
    {
        invalidate_cleanup_binding(&approval_token);
        return Err("dev_cleanup_worktree: branch CAS 前 identity 已漂移".into());
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
    if stable_directory_identity(&base_path)? != base_identity
        || !cleanup_target_identity_is_current(
            &base_path,
            &canon,
            &branch,
            expected_target_identity.as_ref(),
        )?
    {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: branch CAS 后 identity 漂移，结果必须按 unknown 处理".into(),
        );
    }
    let listed_after_cas = match git_worktree_is_listed(&base_path, &canon) {
        Ok(listed) => listed,
        Err(error) => {
            invalidate_cleanup_binding(&approval_token);
            return Err(format!(
                "dev_cleanup_worktree: branch CAS 后无法确认 worktree 状态：{error}"
            ));
        }
    };
    if expected_target_identity.is_some() && !listed_after_cas {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: branch CAS 后 worktree listing 消失，结果必须按 unknown 处理"
                .into(),
        );
    }
    if expected_target_identity.is_none() && listed_after_cas {
        invalidate_cleanup_binding(&approval_token);
        return Err(
            "dev_cleanup_worktree: branch-only orphan 在 CAS 后重新出现在 worktree listing".into(),
        );
    }
    if listed_after_cas {
        if stable_directory_identity(&base_path)? != base_identity
            || !cleanup_target_identity_is_current(
                &base_path,
                &canon,
                &branch,
                expected_target_identity.as_ref(),
            )?
        {
            invalidate_cleanup_binding(&approval_token);
            return Err("dev_cleanup_worktree: worktree remove 前 identity 已漂移".into());
        }
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
    if state.base_repo.as_deref() != Some(base.as_str())
        || state.base_identity.as_ref() != Some(&base_identity)
        || state.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
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
    let (base, base_identity) = {
        let state = DEV_STATE.lock().unwrap();
        (
            state
                .base_repo
                .clone()
                .ok_or_else(|| "dev_unregister_worktree: 尚未初始化主仓库根".to_string())?,
            state.base_identity.clone().ok_or_else(|| {
                "dev_unregister_worktree: 主仓库缺少 stable directory identity".to_string()
            })?,
        )
    };
    let base_path = std::path::PathBuf::from(&base);
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_unregister_worktree: 主仓库 directory identity 已变化".into());
    }
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
    if stable_directory_identity(&base_path)? != base_identity {
        return Err("dev_unregister_worktree: commit 前主仓库 directory identity 已变化".into());
    }
    let mut st = DEV_STATE.lock().unwrap();
    if st.base_repo.as_deref() != Some(base.as_str())
        || st.base_identity.as_ref() != Some(&base_identity)
        || st.generation != generation
        || stable_directory_identity(&base_path)? != base_identity
    {
        return Err("dev_unregister_worktree: session 在 read-back 期间发生变化".into());
    }
    let has_lineage = st.registrations.iter().any(|registered| {
        registered_worktree_identity_matches(registered, generation, &c, &branch)
    }) || st.orphan_worktrees.iter().any(|item| {
        item.generation == generation
            && item.branch == branch
            && path_compare_key(&item.path) == path_compare_key(&c)
    });
    if has_lineage {
        return Err(
            "dev_unregister_worktree: lineage 仍存在，必须使用 native cleanup capability".into(),
        );
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

fn git_diff_pathspec_allowed(cwd: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    let cwd_key = path_compare_key(&dev_strip_verbatim(cwd).to_string_lossy());
    let path_key = path_compare_key(&dev_strip_verbatim(path).to_string_lossy());
    let rel = (if path_key == cwd_key {
        String::new()
    } else {
        path_key
            .strip_prefix(&(cwd_key.clone() + "/"))
            .ok_or_else(|| format!("dev_exec: Git pathspec 不属于 worktree：{}", path.display()))?
            .to_string()
    })
    .to_ascii_lowercase();
    let protected_roots = [
        "package.json",
        "package-lock.json",
        "vitest.config.ts",
        "scripts",
        "tests",
        "src/store/workflowstore.ts",
        "src/engine/executor.ts",
        "src/plugins/sandbox",
        "src-tauri/capabilities",
        "src/orchestrator",
        ".git",
        ".slimemold",
    ];
    if rel.is_empty()
        || protected_roots.iter().any(|root| {
            rel == *root
                || rel.starts_with(&format!("{root}/"))
                || root.starts_with(&(rel.clone() + "/"))
        })
    {
        return Err(format!(
            "dev_exec: Git pathspec 命中 protected root 或其 ancestor：{}",
            path.display()
        ));
    }
    Ok(())
}

fn has_multiple_hardlinks(path: &std::path::Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::mem::MaybeUninit;
        use std::os::windows::io::AsRawHandle;
        let file = fs::File::open(path).map_err(|e| format!("无法安全检查目标 inode：{e}"))?;
        let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 {
            return Err("无法安全检查目标 inode".to_string());
        }
        return Ok(unsafe { info.assume_init() }.number_of_links > 1);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Ok(fs::metadata(path)
            .map_err(|e| format!("无法安全检查目标 inode：{e}"))?
            .nlink()
            > 1);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(false)
    }
}

fn dev_path_allowed_with_options(
    abs: &std::path::Path,
    allow_execution_only_scripts: bool,
) -> Result<(), String> {
    let norm_abs = dev_strip_verbatim(abs);
    let state = DEV_STATE.lock().unwrap();
    for registered in &state.registrations {
        let wc = dev_strip_verbatim(std::path::Path::new(&registered.path));
        if path_is_same_or_child(&norm_abs, &wc) {
            let current_identity = stable_directory_identity(&wc).map_err(|error| {
                format!("dev_file: 无法重新绑定已登记 worktree identity：{error}")
            })?;
            if current_identity != registered.identity {
                return Err(format!(
                    "dev_file: 已登记 worktree identity 已变化：{}",
                    registered.path
                ));
            }
            if let Some(error) = protected_path_error(&norm_abs, &wc) {
                if !(allow_execution_only_scripts
                    && protected_path_is_execution_only_script(&norm_abs, &wc))
                {
                    return Err(error);
                }
            }
            return Ok(());
        }
    }
    for w in &state.worktrees {
        let wc = dev_strip_verbatim(std::path::Path::new(w));
        if path_is_same_or_child(&norm_abs, &wc) {
            if let Some(error) = protected_path_error(&norm_abs, &wc) {
                if !(allow_execution_only_scripts
                    && protected_path_is_execution_only_script(&norm_abs, &wc))
                {
                    return Err(error);
                }
            }
            return Ok(());
        }
    }
    Err(format!(
        "dev_file: 路径不属于任何已登记 worktree：{}",
        abs.display()
    ))
}

fn dev_path_allowed(abs: &std::path::Path) -> Result<(), String> {
    dev_path_allowed_with_options(abs, false)
}

fn dev_exec_path_allowed(
    abs: &std::path::Path,
    allow_execution_only_scripts: bool,
) -> Result<(), String> {
    dev_path_allowed_with_options(abs, allow_execution_only_scripts)
}

/// 在已登记 worktree 内创建一级目录。
/// 父目录必须已存在并先 canonicalize；目标 symlink 永不跟随，调用方负责逐级创建。
#[tauri::command]
fn dev_create_dir(path: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_create_dir")?;
    let _base_identity = assert_base_identity_current("dev_create_dir")?;
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
    let _base_identity = assert_base_identity_current("dev_read_file")?;
    let abs = dev_abs_of(&path)?;
    if !abs.is_file() {
        return Err(format!("dev_read_file: 文件不存在：{path}"));
    }
    dev_path_allowed(&abs)?;
    let expected_identity = stable_file_identity(&abs)?;
    let expected_parent_path = abs
        .parent()
        .ok_or_else(|| "dev_read_file: parent identity unavailable".to_string())?;
    dev_path_allowed(expected_parent_path)?;
    let expected_parent = stable_file_identity(expected_parent_path)?;
    if has_multiple_hardlinks(&abs)? {
        return Err(format!(
            "dev_read_file: 拒绝读取 hardlink 目标（防 inode 逃逸）：{}",
            abs.display()
        ));
    }
    read_dev_file_bound(&abs, &expected_identity, &expected_parent)
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct StableFileIdentity {
    volume_or_device: u64,
    file_or_inode: u64,
}

#[cfg(unix)]
fn stable_file_identity_from_metadata(
    metadata: &std::fs::Metadata,
) -> Result<StableFileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let identity = StableFileIdentity {
        volume_or_device: metadata.dev(),
        file_or_inode: metadata.ino(),
    };
    if identity.volume_or_device == 0 || identity.file_or_inode == 0 {
        return Err("文件 identity platform identifiers 不可用".into());
    }
    Ok(identity)
}

#[cfg(windows)]
fn stable_file_identity_from_handle(
    handle: *mut std::ffi::c_void,
) -> Result<StableFileIdentity, String> {
    use std::mem::MaybeUninit;
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } == 0 {
        return Err("无法读取绑定文件 identity".into());
    }
    let info = unsafe { info.assume_init() };
    let identity = StableFileIdentity {
        volume_or_device: info.volume_serial as u64,
        file_or_inode: (u64::from(info.file_index_high) << 32) | u64::from(info.file_index_low),
    };
    if identity.volume_or_device == 0 || identity.file_or_inode == 0 {
        return Err("文件 identity platform identifiers 不可用".into());
    }
    Ok(identity)
}

#[allow(dead_code)]
fn stable_file_identity_from_file(file: &fs::File) -> Result<StableFileIdentity, String> {
    #[cfg(unix)]
    {
        return stable_file_identity_from_metadata(
            &file
                .metadata()
                .map_err(|error| format!("无法读取bound fd metadata：{error}"))?,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        return stable_file_identity_from_handle(file.as_raw_handle());
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err("当前平台不支持 bound fd identity".into())
    }
}

#[cfg(unix)]
fn open_unix_file_relative(
    path: &std::path::Path,
    flags: i32,
    mode: libc::mode_t,
    expected_parent: Option<&StableFileIdentity>,
    expected_final: Option<&StableFileIdentity>,
) -> Result<fs::File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;
    const DIRECTORY_FLAGS: i32 =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    let mut directory = {
        let root = CString::new("/").map_err(|_| "无法构造 Unix root".to_string())?;
        let fd = unsafe { libc::open(root.as_ptr(), DIRECTORY_FLAGS, 0) };
        if fd < 0 {
            return Err(format!(
                "无法打开 Unix root：{}",
                std::io::Error::last_os_error()
            ));
        }
        unsafe { fs::File::from_raw_fd(fd) }
    };
    let components: Vec<_> = path.components().collect();
    if !path.is_absolute() || components.is_empty() {
        return Err(format!("文件路径必须是绝对路径：{}", path.display()));
    }
    if components.len() == 1 {
        if flags & libc::O_DIRECTORY == 0 {
            return Err(format!("根路径不能作为文件：{}", path.display()));
        }
        if let Some(expected_final) = expected_final {
            if stable_file_identity_from_file(&directory)? != *expected_final {
                return Err("Unix root cwd identity 已变化".into());
            }
        }
        return Ok(directory);
    }
    for component in &components[1..components.len() - 1] {
        let Component::Normal(name) = component else {
            return Err(format!(
                "文件父路径包含不安全 component：{}",
                path.display()
            ));
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| format!("文件父路径包含 NUL：{}", path.display()))?;
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS, 0) };
        if fd < 0 {
            return Err(format!(
                "无法绑定文件父目录：{}",
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { fs::File::from_raw_fd(fd) };
    }
    if let Some(expected_parent) = expected_parent {
        let actual_parent = stable_file_identity_from_file(&directory)?;
        if actual_parent != *expected_parent {
            return Err(format!("文件父目录 identity 已变化：{}", path.display()));
        }
    }
    let Component::Normal(name) = components.last().unwrap() else {
        return Err(format!("文件名 component 无效：{}", path.display()));
    };
    let name =
        CString::new(name.as_bytes()).map_err(|_| format!("文件名包含 NUL：{}", path.display()))?;
    let final_flags = flags
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if flags & libc::O_DIRECTORY == 0 {
            libc::O_NONBLOCK
        } else {
            0
        };
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), final_flags, mode) };
    if fd < 0 {
        return Err(format!("无法绑定文件：{}", std::io::Error::last_os_error()));
    }
    let file = unsafe { fs::File::from_raw_fd(fd) };
    if let Some(expected_final) = expected_final {
        if stable_file_identity_from_file(&file)? != *expected_final {
            return Err(format!("文件final identity 已变化：{}", path.display()));
        }
    }
    Ok(file)
}

#[cfg(unix)]
fn create_unix_file_relative(
    path: &std::path::Path,
    content: &str,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    use std::io::Write;
    let mut file = open_unix_file_relative(
        path,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o644,
        Some(expected_parent),
        None,
    )?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("创建绑定文件失败：{error}"))
}

fn stable_file_identity(path: &std::path::Path) -> Result<StableFileIdentity, String> {
    if path.is_dir() {
        let directory = stable_directory_identity(path)?;
        return Ok(StableFileIdentity {
            volume_or_device: directory.volume_or_device,
            file_or_inode: directory.file_or_inode,
        });
    }
    #[cfg(unix)]
    {
        return stable_file_identity_from_metadata(
            &fs::metadata(path).map_err(|error| format!("无法读取文件 identity：{error}"))?,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| format!("无法绑定文件 identity：{error}"))?;
        return stable_file_identity_from_handle(file.as_raw_handle());
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = path;
        Err("当前平台不支持稳定文件 identity".into())
    }
}

#[cfg(windows)]
fn read_dev_file_bound(
    path: &std::path::Path,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<String, String> {
    use std::io::Read;
    use std::mem::MaybeUninit;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    let _ = expected_parent;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| format!("无法绑定读取句柄：{e}"))?;
    let actual_identity = stable_file_identity_from_handle(file.as_raw_handle())?;
    if actual_identity != *expected_identity {
        return Err("读取绑定文件 identity 已变化".into());
    }
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("无法读取绑定文件身份".to_string());
    }
    if unsafe { info.assume_init() }.number_of_links > 1 {
        return Err("拒绝读取 hardlink 目标（防 inode 逃逸）".to_string());
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("读取绑定文件失败：{e}"))?;
    Ok(content)
}

#[cfg(unix)]
fn read_dev_file_bound(
    path: &std::path::Path,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<String, String> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let mut file = open_unix_file_relative(
        path,
        libc::O_RDONLY,
        0,
        Some(expected_parent),
        Some(expected_identity),
    )?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取绑定文件身份：{e}"))?;
    let actual_identity = stable_file_identity_from_metadata(&metadata)?;
    if actual_identity != *expected_identity {
        return Err("读取绑定文件 identity 已变化".into());
    }
    if metadata.nlink() > 1 {
        return Err("拒绝读取 hardlink 目标（防 inode 逃逸）".to_string());
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("读取绑定文件失败：{e}"))?;
    Ok(content)
}

#[cfg(all(not(windows), not(unix)))]
fn read_dev_file_bound(
    path: &std::path::Path,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<String, String> {
    let _ = (path, expected_identity, expected_parent);
    Err("当前平台不支持 bound file identity read".into())
}

#[cfg(windows)]
fn write_dev_file_bound(
    path: &std::path::Path,
    content: &str,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    use std::io::Write;
    use std::mem::MaybeUninit;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    let _ = expected_parent;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| format!("无法绑定写入句柄：{e}"))?;
    let actual_identity = stable_file_identity_from_handle(file.as_raw_handle())?;
    if !file
        .metadata()
        .map_err(|error| format!("无法读取写入目标类型：{error}"))?
        .is_file()
    {
        return Err("拒绝写入非 regular file".into());
    }
    if actual_identity != *expected_identity {
        return Err("写入绑定文件 identity 已变化".into());
    }
    let mut info = MaybeUninit::<WinByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("无法读取绑定文件身份".to_string());
    }
    if unsafe { info.assume_init() }.number_of_links > 1 {
        return Err("拒绝写入 hardlink 目标（防 inode 逃逸）".to_string());
    }
    file.set_len(0)
        .map_err(|e| format!("无法截断绑定文件：{e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入绑定文件失败：{e}"))
}

#[cfg(unix)]
fn write_dev_file_bound(
    path: &std::path::Path,
    content: &str,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;
    let mut file = open_unix_file_relative(
        path,
        libc::O_WRONLY,
        0,
        Some(expected_parent),
        Some(expected_identity),
    )?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取绑定文件身份：{e}"))?;
    if !metadata.is_file() {
        return Err("拒绝写入非 regular file".into());
    }
    let actual_identity = stable_file_identity_from_metadata(&metadata)?;
    if actual_identity != *expected_identity {
        return Err("写入绑定文件 identity 已变化".into());
    }
    if metadata.nlink() > 1 {
        return Err("拒绝写入 hardlink 目标（防 inode 逃逸）".to_string());
    }
    file.set_len(0)
        .map_err(|e| format!("无法截断绑定文件：{e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入绑定文件失败：{e}"))
}

#[cfg(all(not(windows), not(unix)))]
fn write_dev_file_bound(
    path: &std::path::Path,
    content: &str,
    expected_identity: &StableFileIdentity,
    expected_parent: &StableFileIdentity,
) -> Result<(), String> {
    let _ = (path, content, expected_identity, expected_parent);
    Err("当前平台不支持 bound file identity write".into())
}

/// P1 审计修复：防符号链接绕过——
/// - 目标已存在 → `fs::canonicalize` 解析到真实路径（跟随 symlink）后**重新校验**仍在 worktree 内；
/// - 目标不存在 → 父目录已 canonicalize（真实目录），文件名不跨目录，用 O_EXCL 创建（不跟随已有符号链接）；
/// - 目标已存在且是 symlink → 直接拒绝（不写入链接目标）。
#[tauri::command]
fn dev_write_file(path: String, content: String, generation: u64) -> Result<(), String> {
    let _operation_guard = lock_dev_operation();
    assert_session_generation(generation, "dev_write_file")?;
    let _base_identity = assert_base_identity_current("dev_write_file")?;
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
    dev_path_allowed(&canon_parent)?;
    let expected_parent_identity = stable_file_identity(&canon_parent)?;
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
        if !meta.is_file() {
            return Err(format!(
                "dev_write_file: 拒绝写入非 regular file：{}",
                abs.display()
            ));
        }
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
        let expected_identity = stable_file_identity(&real)?;
        write_dev_file_bound(
            &real,
            &content,
            &expected_identity,
            &expected_parent_identity,
        )?;
        return Ok(());
    }

    // 目标不存在：父目录已 canonicalize（真实目录，无 symlink），文件名不跨目录；
    // 用 create_new（O_CREAT|O_EXCL）避免跟随并发创建的符号链接
    dev_path_allowed(&abs)?;
    #[cfg(unix)]
    {
        return create_unix_file_relative(&abs, &content, &expected_parent_identity)
            .map_err(|error| format!("dev_write_file: 创建失败：{path}（{error}）"));
    }
    #[cfg(not(unix))]
    {
        return fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&abs)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(content.as_bytes())
            })
            .map_err(|e| format!("dev_write_file: 创建失败：{path}（{e}）"));
    }
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
            codex::codex_worker_prepare,
            codex::codex_worker_exec,
            codex::codex_worker_cancel,
            antigravity::antigravity_worker_exec,
            antigravity::antigravity_worker_cancel,
            event_store::event_lock_acquire,
            event_store::event_lock_release,
            run_git,
            grant_project_access,
            dev_exec,
            dev_init_session,
            dev_clear_session,
            dev_register_worktree,
            dev_restore_worktree,
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
mod dev_exec_tests;

/* ---------------- dev_write_file 符号链接逃逸（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_write_symlink_tests;
