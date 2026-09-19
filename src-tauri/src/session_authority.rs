//! Session, generation, base-identity, and cwd authority.
//!
//! The state carrier remains in `dev_state`; this module owns the validation
//! and binding seam consumed by host commands and worker adapters.

use std::path::PathBuf;

use crate::dev_state::{
    assert_session_stamp_current, base_repo_is_initialized, snapshot_base_repo,
    snapshot_session_stamp, snapshot_session_stamp_for, SessionStamp, DEV_STATE,
};
use crate::fs_guard::{dev_strip_verbatim, path_compare_key, path_is_same_or_child};
use crate::fs_identity::{stable_directory_identity, StableDirectoryIdentity};

pub(crate) fn dev_base_repo() -> Result<PathBuf, String> {
    assert_base_identity_current("dev_base_repo")
}

fn validate_session_base(stamp: &SessionStamp, operation: &str) -> Result<PathBuf, String> {
    let base_path = PathBuf::from(stamp.base_repo());
    let current_identity = stable_directory_identity(&base_path)
        .map_err(|error| format!("{operation}: 无法重新绑定主仓库 identity：{error}"))?;
    if current_identity != *stamp.base_identity() {
        return Err(format!("{operation}: 主仓库 directory identity 已变化"));
    }
    assert_session_stamp_current(stamp, operation)?;
    Ok(base_path)
}

pub(crate) fn assert_base_identity_current(operation: &str) -> Result<PathBuf, String> {
    let stamp = snapshot_session_stamp(operation)?;
    validate_session_base(&stamp, operation)
}

pub(crate) fn assert_session_generation(expected: u64, operation: &str) -> Result<(), String> {
    let stamp = snapshot_session_stamp_for(expected, operation)?;
    validate_session_base(&stamp, operation).map(|_| ())
}

pub(crate) fn dev_lexical_abs_of(raw: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(raw);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let base =
        snapshot_base_repo().ok_or_else(|| format!("路径是相对的，但未初始化主仓库根：{raw}"))?;
    Ok(std::path::Path::new(&base).join(path))
}

/// 解析为绝对路径：相对路径基于 base_repo（GUI 下 worktree path 常相对 projectPath）。
pub(crate) fn dev_abs_of(raw: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(raw);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let base = snapshot_base_repo()
            .ok_or_else(|| format!("路径是相对的，但未初始化主仓库根：{raw}"))?;
        std::path::Path::new(&base).join(p)
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
    let has_base = base_repo_is_initialized();
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

pub(crate) fn dev_cwd_kind(cwd: &str) -> Result<DevCwdKind, String> {
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
