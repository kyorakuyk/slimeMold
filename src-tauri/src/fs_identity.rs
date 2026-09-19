use std::fs;

#[cfg(windows)]
use super::{GetFileInformationByHandle, WinByHandleFileInformation};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StableDirectoryIdentity {
    pub(crate) canonical_path: String,
    pub(crate) volume_or_device: u64,
    pub(crate) file_or_inode: u64,
}

pub(crate) fn stable_directory_identity(
    path: &std::path::Path,
) -> Result<StableDirectoryIdentity, String> {
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
