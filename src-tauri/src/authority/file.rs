//! Registered-worktree file and directory authority.
//!
//! This module owns the stateful path gate, stable file identity, bound
//! read/write/create operations, and the corresponding Tauri commands.

use std::fs;

use crate::dev_state::{lock_dev_operation, DEV_STATE};
use crate::fs_guard::{
    dev_strip_verbatim, path_is_same_or_child, protected_path_error,
    protected_path_is_execution_only_script,
};
use crate::fs_identity::stable_directory_identity;
use crate::{assert_base_identity_current, assert_session_generation, dev_abs_of};

pub(crate) fn has_multiple_hardlinks(path: &std::path::Path) -> Result<bool, String> {
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

pub(crate) fn dev_exec_path_allowed(
    abs: &std::path::Path,
    allow_execution_only_scripts: bool,
) -> Result<(), String> {
    dev_path_allowed_with_options(abs, allow_execution_only_scripts)
}

/// 在已登记 worktree 内创建一级目录。
/// 父目录必须已存在并先 canonicalize；目标 symlink 永不跟随，调用方负责逐级创建。
#[tauri::command]
pub(crate) fn dev_create_dir(path: String, generation: u64) -> Result<(), String> {
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
pub(crate) fn dev_read_file(path: String, generation: u64) -> Result<String, String> {
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
pub(crate) struct WinByHandleFileInformation {
    pub(crate) file_attributes: u32,
    pub(crate) creation_low: u32,
    pub(crate) creation_high: u32,
    pub(crate) access_low: u32,
    pub(crate) access_high: u32,
    pub(crate) write_low: u32,
    pub(crate) write_high: u32,
    pub(crate) volume_serial: u32,
    pub(crate) size_high: u32,
    pub(crate) size_low: u32,
    pub(crate) number_of_links: u32,
    pub(crate) file_index_high: u32,
    pub(crate) file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    pub(crate) fn GetFileInformationByHandle(
        handle: *mut std::ffi::c_void,
        info: *mut WinByHandleFileInformation,
    ) -> i32;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StableFileIdentity {
    pub(crate) volume_or_device: u64,
    pub(crate) file_or_inode: u64,
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
pub(crate) fn stable_file_identity_from_file(
    file: &fs::File,
) -> Result<StableFileIdentity, String> {
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
pub(crate) fn open_unix_file_relative(
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

pub(crate) fn stable_file_identity(path: &std::path::Path) -> Result<StableFileIdentity, String> {
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
pub(crate) fn write_dev_file_bound(
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
pub(crate) fn write_dev_file_bound(
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
pub(crate) fn write_dev_file_bound(
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
pub(crate) fn dev_write_file(path: String, content: String, generation: u64) -> Result<(), String> {
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
