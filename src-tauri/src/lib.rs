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

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// H4 dev_exec 登记态：主仓库根 + 已登记 worktree（GUI 下由前端在 DevSession 初始化/创建时同步）。
static DEV_STATE: Mutex<DevState> = Mutex::new(DevState::new());

struct DevState {
    base_repo: Option<String>,
    worktrees: Vec<String>,
}

impl DevState {
    const fn new() -> Self {
        DevState { base_repo: None, worktrees: Vec::new() }
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
    if let Some(ref s) = raw {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            if let Some(k) = v.get("apiKey").and_then(|x| x.as_str()) {
                eprintln!("[vault] load_vault_key decrypted apiKey len={} prefix={}", k.len(), &k.chars().take(6).collect::<String>());
            }
        }
    }
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
    static LAST_GRANT: std::sync::Mutex<Option<(String, Instant)>> =
        std::sync::Mutex::new(None);
    {
        let mut last = LAST_GRANT.lock().unwrap();
        if let Some((prev, at)) = &*last {
            if *prev == canon_str && at.elapsed() < Duration::from_secs(1) {
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
    "pwd", "echo", "ls", "cat", "find", "head", "tail", "grep", "git", "tsc", "vitest", "tsx", "npm",
];

/// 解析为绝对路径：相对路径基于 base_repo（GUI 下 worktree path 常相对 projectPath）。
fn dev_abs_of(raw: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(raw);
    if p.is_absolute() {
        return p
            .canonicalize()
            .map_err(|e| format!("无法解析路径（{raw}）：{e}"));
    }
    let state = DEV_STATE.lock().unwrap();
    let base = state.base_repo.as_ref().ok_or_else(|| {
        format!("路径是相对的，但未初始化主仓库根：{raw}")
    })?;
    std::path::Path::new(base)
        .join(raw)
        .canonicalize()
        .map_err(|e| format!("无法解析相对路径（{raw}，基于 {base}）：{e}"))
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
    if p
        .components()
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
        let bc = std::path::Path::new(base)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(base));
        if norm_canon == dev_strip_verbatim(&bc) {
            return Ok(DevCwdKind::MainRepo);
        }
    }
    for w in &state.worktrees {
        let wc = std::path::Path::new(w)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(w));
        let norm_wc = dev_strip_verbatim(&wc);
        if norm_canon == norm_wc || norm_canon.starts_with(&norm_wc) {
            return Ok(DevCwdKind::Worktree(norm_wc));
        }
    }
    Err(format!(
        "dev_exec: cwd 不属于已登记 worktree 或主仓库根：{cwd}"
    ))
}

/// 主仓库根允许的 git 子命令（严格只读 / worktree 生命周期管理）。
/// 主仓库根是宿主受保护目录——禁止 npm/tsx/写入型 git（apply/commit/push/reset 等），
/// 防止 WebView 直接调 dev_exec 在主仓库执行修改文件的命令。
fn dev_main_repo_git_allowed(args: &[String]) -> bool {
    if args.first().map(|s| s.as_str()) != Some("git") {
        return false;
    }
    match args.get(1).map(|s| s.as_str()) {
        // 只读查询 / worktree 生命周期管理（WorktreeManager 创建/清理所需）
        Some("rev-parse") => true,
        Some("worktree") => matches!(
            args.get(2).map(|s| s.as_str()),
            Some("list") | Some("add") | Some("remove") | Some("prune") | Some("lock") | Some("unlock")
        ),
        Some("branch") => matches!(
            args.get(2).map(|s| s.as_str()),
            Some("-D") | Some("-d") | Some("--list") | Some("-a")
        ),
        Some("status") | Some("diff") | Some("log") | Some("show") | Some("ls-files") | Some("rev-list") => true,
        _ => false,
    }
}

/// 剥离常见凭据环境变量 + 注入 git 非交互配置（与前端 sanitizeEnv 对齐）。
fn dev_sanitized_env() -> HashMap<String, String> {
    const DENY: &[&str] = &[
        "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
        "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_KEY_1", "AZURE_OPENAI_API_KEY_2",
        "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "REPLICATE_API_TOKEN",
    ];
    let mut env: HashMap<String, String> = std::env::vars().collect();
    for k in DENY {
        env.remove(*k);
    }
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    env
}

/// 带超时的子进程执行，返回 stdout/stderr/exitCode（非零退出码不视为错误）。
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<DevExecResult, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = cmd.spawn().map_err(|e| format!("命令启动失败：{e}"))?;
    let start = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|e| format!("等待子进程失败：{e}"))?
        {
            Some(_) => break,
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("dev_exec 执行超时（30s）".into());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    use std::io::Read;
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    if let Some(mut o) = child.stdout.take() {
        o.read_to_end(&mut out_buf).ok();
    }
    if let Some(mut e) = child.stderr.take() {
        e.read_to_end(&mut err_buf).ok();
    }
    let status = child.wait().unwrap_or_default();
    Ok(DevExecResult {
        stdout: String::from_utf8_lossy(&out_buf).to_string(),
        stderr: String::from_utf8_lossy(&err_buf).to_string(),
        code: status.code().unwrap_or(-1),
    })
}

/// worktree 内命令的文件路径参数**词法级**校验（纯函数，无 IO，可单测）。
/// 拦截：绝对路径（POSIX `/`、Windows `C:\`、UNC `\\`）、`..` 逃逸、`~`、shell 元字符重定向。
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
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    // 家目录展开符号
    if arg == "~" || arg.starts_with("~/") || arg.starts_with("~\\") {
        return false;
    }
    // shell 元字符（重定向 / 管道 / 命令拼接）——Command spawn 不经 shell，但保守拒绝
    const META: &[char] = &['>', '<', '|', '&', ';', '`', '$', '*', '?', '\'', '"', '(', ')', ' '];
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
            if !norm.starts_with(&wt_root) {
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
        // find 禁 -delete/-exec/-execdir/>（防删除/执行）；且搜索根必须合法（默认 . 或安全相对路径）
        "find" => {
            !rest.iter().any(|a| a == "-delete" || a == "-exec" || a == "-execdir" || a.contains('>'))
                && match rest.first().map(|s| s.as_str()) {
                    None | Some(".") => true,
                    Some(root) => dev_arg_path_lexically_safe(root),
                }
        }
        // grep 只读；文件路径参数须词法安全
        "grep" => rest
            .iter()
            .filter(|a| !a.starts_with('-'))
            .all(|a| dev_arg_path_lexically_safe(a)),
        // git 只读 + 精确参数（与前端 shell 白名单 matchesRule 语义一致；明确排除所有写入型）
        "git" => {
            rest_eq(&["status", "--porcelain"])
                || rest_eq(&["status", "--short"])
                || rest_eq(&["diff", "HEAD"])
                || rest_eq(&["diff", "--name-only", "HEAD"])
                || rest_eq(&["diff", "--stat", "HEAD"])
                || rest_eq(&["diff", "--name-only"])
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
        "tsc" => rest_eq(&["--noEmit"]) || rest_eq(&["-b"]),
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
        "npm" => rest_eq(&["run", "test"]) || rest_eq(&["run", "build"]) || rest_eq(&["run", "i18n:check"]),
        _ => false,
    }
}

/// 判定 dev_exec 是否放行（cwd 归属 + 命令 + 参数）。
/// 纯函数，便于 Rust 单元测试覆盖主仓库根权限边界。
fn dev_exec_allowed(kind: &DevCwdKind, args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }
    let name = args[0].as_str();
    if !DEV_ALLOWED_CMDS.contains(&name) {
        return false;
    }
    match kind {
        DevCwdKind::MainRepo => dev_main_repo_git_allowed(args),
        DevCwdKind::Worktree(_) => dev_worktree_cmd_allowed(args),
    }
}

/// H4 GUI 受控命令执行：
/// - 命令名白名单（DEV_ALLOWED_CMDS）；
/// - cwd 归属分级——主仓库根**仅放行严格只读 git 管理命令**（rev-parse/worktree list 等），
///   完整白名单（npm/tsx/写入型 git）仅在**已登记 worktree** 内可用；
/// - 剥离凭据 env + 超时。
#[tauri::command]
fn dev_exec(args: Vec<String>, cwd: String) -> Result<DevExecResult, String> {
    let kind = dev_cwd_kind(&cwd)?;
    if !dev_exec_allowed(&kind, &args) {
        return Err(format!("dev_exec: 命令在当前 cwd 不被允许：{}", args.join(" ")));
    }
    // P1 兜底：对文件路径参数做 canonicalize（解析符号链接）校验，确认未逃逸出 worktree
    dev_exec_validate_paths(&cwd, &args)?;
    let name = args[0].clone();
    let mut cmd = Command::new(name);
    cmd.current_dir(&cwd);
    for a in &args[1..] {
        cmd.arg(a);
    }
    cmd.env_clear();
    for (k, v) in dev_sanitized_env() {
        cmd.env(k, v);
    }
    run_with_timeout(&mut cmd, Duration::from_secs(30))
}

/// 初始化 H4 宿主登记态（GUI 打开项目 / DevSession 初始化时调用）。
#[tauri::command]
fn dev_init_session(base_repo: String) -> Result<(), String> {
    let p = std::path::Path::new(&base_repo);
    if !p.exists() || !p.is_dir() {
        return Err(format!("dev_init_session: 主仓库不存在或不是目录：{base_repo}"));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("dev_init_session: 路径解析失败：{base_repo}（{e}）"))?;
    let mut st = DEV_STATE.lock().unwrap();
    st.base_repo = Some(canon.to_string_lossy().to_string());
    st.worktrees.clear();
    Ok(())
}

/// 清空 H4 宿主登记态（GUI 切换/关闭项目时先调用，避免旧项目登记态泄漏到新项目）。
#[tauri::command]
fn dev_clear_session() -> Result<(), String> {
    let mut st = DEV_STATE.lock().unwrap();
    st.base_repo = None;
    st.worktrees.clear();
    Ok(())
}

/// 登记一个 worktree（前端 dev.worktree.create 成功后调用；支持相对路径基于主仓库根解析）。
#[tauri::command]
fn dev_register_worktree(path: String) -> Result<(), String> {
    let canon = dev_abs_of(&path)?;
    if !canon.is_dir() {
        return Err(format!("dev_register_worktree: worktree 不存在或不是目录：{path}"));
    }
    let c = canon.to_string_lossy().to_string();
    let mut st = DEV_STATE.lock().unwrap();
    if !st.worktrees.iter().any(|w| w == &c) {
        st.worktrees.push(c);
    }
    Ok(())
}

/// 注销 worktree（前端清理成功后调用）。
#[tauri::command]
fn dev_unregister_worktree(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let canon = p
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&path));
    let c = canon.to_string_lossy().to_string();
    let mut st = DEV_STATE.lock().unwrap();
    st.worktrees.retain(|w| w != &c);
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
        if norm_abs.starts_with(&wc) {
            return Ok(());
        }
    }
    Err(format!(
        "dev_file: 路径不属于任何已登记 worktree：{}",
        abs.display()
    ))
}

/// 读文件（仅 worktree 内；H4 节点 code.read / 状态签名等；相对路径基于主仓库根解析）。
#[tauri::command]
fn dev_read_file(path: String) -> Result<String, String> {
    let abs = dev_abs_of(&path)?;
    if !abs.is_file() {
        return Err(format!("dev_read_file: 文件不存在：{path}"));
    }
    dev_path_allowed(&abs)?;
    fs::read_to_string(&abs).map_err(|e| format!("dev_read_file: 读取失败：{path}（{e}）"))
}

/// 写文件（仅 worktree 内；H4 节点 code.patch 落盘等；相对路径基于主仓库根解析）。
/// P1 审计修复：防符号链接绕过——
/// - 目标已存在 → `fs::canonicalize` 解析到真实路径（跟随 symlink）后**重新校验**仍在 worktree 内；
/// - 目标不存在 → 父目录已 canonicalize（真实目录），文件名不跨目录，用 O_EXCL 创建（不跟随已有符号链接）；
/// - 目标已存在且是 symlink → 直接拒绝（不写入链接目标）。
#[tauri::command]
fn dev_write_file(path: String, content: String) -> Result<(), String> {
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
        format!("dev_write_file: 无法解析父目录（{}）：{e}", parent.display())
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
        let real = abs
            .canonicalize()
            .map_err(|e| format!("dev_write_file: 目标路径解析失败：{e}"))?;
        dev_path_allowed(&real)?;
        fs::write(&real, content).map_err(|e| format!("dev_write_file: 写入失败：{path}（{e}）"))?;
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
            save_vault,
            list_vaults,
            load_vault_key,
            delete_vault,
            run_git,
            grant_project_access,
            dev_exec,
            dev_init_session,
            dev_clear_session,
            dev_register_worktree,
            dev_unregister_worktree,
            dev_read_file,
            dev_write_file
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
        assert_eq!(String::from_utf8(pt).unwrap(), plain, "AES-GCM 往返应还原明文");
    }
}

/* ---------------- dev_exec 主仓库根权限边界（P1 审计修复） ---------------- */
#[cfg(test)]
mod dev_exec_tests {
    use super::*;

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn main_repo_allows_only_readonly_git() {
        let main = DevCwdKind::MainRepo;
        // 只读 git / worktree 生命周期管理 → 放行
        assert!(dev_exec_allowed(&main, &sv(&["git", "rev-parse", "HEAD"])));
        assert!(dev_exec_allowed(&main, &sv(&["git", "worktree", "list"])));
        assert!(dev_exec_allowed(&main, &sv(&["git", "worktree", "add", "-q", "wt", "-b", "b", "HEAD"])));
        assert!(dev_exec_allowed(&main, &sv(&["git", "status", "--porcelain"])));
        assert!(dev_exec_allowed(&main, &sv(&["git", "diff", "--name-only"])));
        // 非白名单命令名 → 拒绝
        assert!(!dev_exec_allowed(&main, &sv(&["npm", "run", "build"])));
        assert!(!dev_exec_allowed(&main, &sv(&["tsx", "scripts/x.ts"])));
        assert!(!dev_exec_allowed(&main, &sv(&["tsc", "--noEmit"])));
        assert!(!dev_exec_allowed(&main, &sv(&["cat", "/etc/passwd"])));
        // 写入型 git → 拒绝
        assert!(!dev_exec_allowed(&main, &sv(&["git", "apply", "patch.diff"])));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "commit", "-m", "x"])));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "push", "origin", "main"])));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "reset", "--hard", "HEAD"])));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "checkout", "main"])));
        assert!(!dev_exec_allowed(&main, &sv(&["git", "add", "."])));
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
        assert!(dev_exec_allowed(&wt, &sv(&["git", "status", "--porcelain"])));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "diff", "HEAD"])));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "diff", "src/a.ts"])));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "rev-parse", "HEAD"])));
        assert!(dev_exec_allowed(&wt, &sv(&["git", "ls-files", "--others", "--exclude-standard"])));
    }

    #[test]
    fn worktree_rejects_high_risk_and_unbounded() {
        let wt = DevCwdKind::Worktree(std::path::PathBuf::from("/repo/wt"));
        // 写入型 / 高风险 git → 拒绝
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "push", "origin", "main"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "commit", "-m", "x"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "reset", "--hard", "HEAD"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "checkout", "main"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "clean", "-fd"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "merge", "main"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "apply", "patch.diff"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "add", "."])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "config", "user.email", "x@y.z"])));
        // 无界 / 白名单外命令 / 危险参数 → 拒绝
        assert!(!dev_exec_allowed(&wt, &sv(&["npm", "run", "evil"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["npm", "install", "lodash"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["tsx", "src/outside.ts"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["tsx", "scripts/x.ts", "--config"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["find", ".", "-delete"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["find", ".", "-exec", "rm", "{}", ";"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["rm", "-rf", "/"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["sudo", "x"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["node", "-e", "x"])));
        // 精确匹配语义：白名单参数不得被追加额外参数绕过
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "status", "--porcelain", "--extra"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "HEAD", "--output=x"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "-x"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "rev-parse", "HEAD", "extra"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "ls-files", "--others", "--exclude-standard", "-z"])));
    }

    #[test]
    fn worktree_rejects_path_escape_lexically() {
        let wt = DevCwdKind::Worktree(std::path::PathBuf::from("/repo/wt"));
        // POSIX 绝对路径 → 拒绝（Unix 下 cat/head/ls 不得读取 worktree 外绝对路径）
        #[cfg(unix)]
        {
            assert!(!dev_exec_allowed(&wt, &sv(&["cat", "/etc/passwd"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["head", "/var/log/syslog"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["tail", "/home/user/.ssh/id_rsa"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["ls", "/"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["grep", "SECRET", "/etc/secret"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "/etc/passwd"])));
            assert!(!dev_exec_allowed(&wt, &sv(&["find", "/etc", "-name", "passwd"])));
        }
        // Windows drive 绝对路径 / UNC → 拒绝（跨平台均如此：C:\、D:\、\\server\）
        assert!(!dev_exec_allowed(&wt, &sv(&["cat", "C:\\Windows\\system32\\drivers\\etc\\hosts"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["ls", "D:\\secret"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["cat", "\\\\server\\share\\secret.txt"])));
        // .. 父目录逃逸（含折返路径 scripts/foo/../..）→ 拒绝（跨平台）
        assert!(!dev_exec_allowed(&wt, &sv(&["cat", "../../outside.txt"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["head", "src/../../secret"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["ls", ".."])));
        assert!(!dev_exec_allowed(&wt, &sv(&["grep", "x", "a/../b/../../etc/x"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["tsx", "scripts/foo/../../../etc/x.ts"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "../../.git/config"])));
        assert!(!dev_exec_allowed(&wt, &sv(&["find", "..", "-name", "*.ts"])));
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
        assert!(dev_exec_validate_paths(wt_root.to_str().unwrap(), &sv(&["cat", "ok.txt"])).is_ok());
        // symlink 逃逸：cat evil_link/secret.txt → canonicalize 后逃出 wt_root → 拒绝
        #[cfg(unix)]
        if std::fs::symlink_metadata(&link).is_ok() {
            // 若符号链接真正生效（内部文件可经链接读到），canonicalize 后逃出 wt_root 必须拒绝；
            // 无特权创建 symlink 时链接无效，文件不存在则放行
            let inside = wt_root.join("evil_link/secret.txt");
            if inside.exists() {
                assert!(
                    dev_exec_validate_paths(wt_root.to_str().unwrap(), &sv(&["cat", "evil_link/secret.txt"])).is_err(),
                    "symlink 逃逸应被 canonicalize 层拦截"
                );
            }
        }
        // 清理临时目录
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回归：worktree 前缀碰撞不得误判。
    /// `Path::starts_with` 是组件级判断，`C:\repo\wt2` 不视为 `C:\repo\wt` 的子路径。
    /// 登记 worktree `wt` 后，cwd=`wt2` 必须被拒绝，而 `wt` 的真实子目录必须被允许。
    #[test]
    fn dev_cwd_kind_no_wt_prefix_collision() {
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
        assert!(dev_cwd_kind(&wt2_str).is_err(), "wt2 不得误判为 wt 的子路径");

        // 清理：从全局状态移除登记并删除临时目录
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.worktrees.retain(|w| w != &wt_str);
        }
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
        let tmp = std::env::temp_dir().join(format!("sm_h4_wt_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let tmp_str = tmp.to_string_lossy().to_string();
        // 登记为 worktree
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.base_repo = Some(tmp_str.clone());
            st.worktrees.clear();
            st.worktrees.push(tmp_str);
        }
        f(tmp);
        let _ = fs::remove_dir_all(std::env::temp_dir().join(format!("sm_h4_wt_{}", std::process::id())));
        {
            let mut st = DEV_STATE.lock().unwrap();
            st.base_repo = None;
            st.worktrees.clear();
        }
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
            let res = dev_write_file(link.to_string_lossy().to_string(), "overwrite".into());
            assert!(res.is_err(), "写入 symlink 应被拒绝（防逃逸）");
            let content = fs::read_to_string(&outside).unwrap();
            assert_eq!(content, "secret", "外部文件不得被篡改");
        });
    }

    #[test]
    fn normal_write_within_worktree_ok() {
        with_registered_worktree(|wt| {
            let target = wt.join("new_file.txt");
            let res = dev_write_file(target.to_string_lossy().to_string(), "hello".into());
            if let Err(e) = &res {
                eprintln!("[diag] dev_write_file err = {e}");
            }
            assert!(res.is_ok(), "worktree 内普通新文件应可写");
            assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        });
    }
}
