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
        st.base_identity = Some(stable_directory_identity(&tmp).unwrap());
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
        st.base_identity = None;
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

#[test]
fn git_diff_pathspec_rejects_recursive_protected_ancestors() {
    let cwd = std::path::Path::new("C:/repo/wt");
    assert!(
        git_diff_pathspec_allowed(cwd, std::path::Path::new("C:/repo/wt/src/components")).is_ok()
    );
    for path in [
        "C:/repo/wt",
        "C:/repo/wt/src",
        "C:/repo/wt/src/store",
        "C:/repo/wt/src/store/workflowStore.ts",
        "C:/repo/wt/src/Store",
        "C:/repo/wt/.git",
        "C:/repo/wt/.GIT",
        "C:/repo/wt/.slimemold",
        "C:/repo/wt/.SLIMEMOLD",
    ] {
        assert!(
            git_diff_pathspec_allowed(cwd, std::path::Path::new(path)).is_err(),
            "must reject recursive protected pathspec: {path}"
        );
    }
}

#[test]
fn host_protected_path_policy_covers_default_sensitive_roots() {
    assert!(protected_relative_path("scripts"));
    assert!(protected_relative_path("scripts/headless-run.ts"));
    assert!(protected_relative_path("tests"));
    assert!(protected_relative_path("tests/unit/example.ts"));
    assert!(protected_relative_path("src/orchestrator"));
    assert!(protected_relative_path("src/orchestrator/run.ts"));
    assert!(protected_relative_path("src/plugins/sandbox"));
    assert!(protected_relative_path("src/plugins/sandbox/loader.ts"));
    assert!(protected_relative_path("src/store/workflowStore.ts"));
    assert!(protected_relative_path(
        "src-tauri/capabilities/default.json"
    ));
    assert!(protected_relative_path(".git"));
    assert!(protected_relative_path(".git/config"));
    assert!(protected_relative_path(".slimemold"));
    assert!(protected_relative_path(".slimemold/events/events.jsonl"));
    assert!(!protected_relative_path(".gitignore"));
    assert!(!protected_relative_path(".slimemoldish/file"));
    assert!(!protected_relative_path("src/components/TopBar.tsx"));
}

#[cfg(windows)]
#[test]
fn direct_file_authority_rejects_windows_metadata_aliases() {
    with_registered_worktree(|wt| {
        for alias in [".git.", ".slimemold ", ".git:stream", ".slimemold.:stream"] {
            let target = wt.join(alias);
            let write_result = dev_write_file(
                target.to_string_lossy().to_string(),
                "blocked".into(),
                current_generation(),
            );
            assert!(
                write_result.is_err(),
                "write must reject Windows metadata alias: {alias}"
            );
            let create_result =
                dev_create_dir(target.to_string_lossy().to_string(), current_generation());
            assert!(
                create_result.is_err(),
                "mkdir must reject Windows metadata alias: {alias}"
            );
        }
    });
}

#[cfg(any(unix, windows))]
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
fn cwd_rejects_partial_base_binding_before_registered_candidate() {
    let _test_guard = lock_dev_state_tests();
    let root = std::env::temp_dir().join(format!("slimemold-partial-base-{}", std::process::id()));
    let base = root.join("repo");
    let worker =
        std::path::PathBuf::from(format!("{}-workers", base.to_string_lossy())).join("worker-a");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&base).unwrap();
    fs::create_dir_all(&worker).unwrap();
    let worker_identity = stable_directory_identity(&worker).unwrap();
    let mut state = DEV_STATE.lock().unwrap();
    *state = DevState::new();
    state.generation = 1;
    state.base_repo = Some(base.to_string_lossy().to_string());
    state.registrations.push(RegisteredWorktree {
        generation: 1,
        path: worker.to_string_lossy().to_string(),
        branch: "worker/worker-a".into(),
        identity: worker_identity,
    });
    drop(state);
    let result = dev_cwd_kind(&worker.to_string_lossy());
    *DEV_STATE.lock().unwrap() = DevState::new();
    let _ = fs::remove_dir_all(&root);
    assert!(
        result.is_err(),
        "partial base binding must fail before worker match"
    );
}

#[test]
fn registered_worktree_identity_conflict_checks_all_duplicate_bindings() {
    let first = RegisteredWorktree {
        generation: 7,
        path: "D:/workers/worker-a".into(),
        branch: "worker/worker-a".into(),
        identity: StableDirectoryIdentity {
            canonical_path: "D:/workers/worker-a".into(),
            volume_or_device: 1,
            file_or_inode: 2,
        },
    };
    let conflicting = RegisteredWorktree {
        identity: StableDirectoryIdentity {
            canonical_path: "D:/workers/replacement".into(),
            volume_or_device: 1,
            file_or_inode: 3,
        },
        ..first.clone()
    };
    let expected = first.identity.clone();
    assert!(registered_worktree_identity_conflicts(
        &[first, conflicting],
        7,
        "D:/workers/worker-a",
        "worker/worker-a",
        &expected,
    ));
}

#[test]
fn registered_worktree_identity_requires_generation_path_and_branch() {
    let registered = RegisteredWorktree {
        generation: 7,
        path: "D:/workers/worker-a".into(),
        branch: "worker/worker-a".into(),
        identity: StableDirectoryIdentity {
            canonical_path: "D:/workers/worker-a".into(),
            volume_or_device: 1,
            file_or_inode: 2,
        },
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
fn stable_directory_identity_detects_same_path_replacement() {
    let root = std::env::temp_dir().join(format!(
        "slimemold-identity-{}-{}",
        std::process::id(),
        next_session_generation(0)
    ));
    let backup = root.with_extension("old");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&root).unwrap();
    let original = stable_directory_identity(&root).unwrap();
    fs::rename(&root, &backup).unwrap();
    fs::create_dir_all(&root).unwrap();
    let replacement = stable_directory_identity(&root).unwrap();
    assert_ne!(original, replacement);
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&backup);
}

#[test]
fn cwd_rejects_registered_worktree_redirect_to_another_registered_worktree() {
    let _test_guard = lock_dev_state_tests();
    let root = std::env::temp_dir().join(format!("slimemold-redirect-{}", std::process::id()));
    let base = root.join("base");
    let worktree_a = root.join("a");
    let worktree_b = root.join("b");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&base).unwrap();
    fs::create_dir_all(worktree_a.join("sub")).unwrap();
    fs::create_dir_all(worktree_b.join("sub")).unwrap();
    let identity_a = stable_directory_identity(&worktree_a).unwrap();
    let identity_b = stable_directory_identity(&worktree_b).unwrap();
    let base_identity = stable_directory_identity(&base).unwrap();
    fs::rename(&worktree_a, root.join("a-original")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&worktree_b, &worktree_a).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_dir;
        if let Err(error) = symlink_dir(&worktree_b, &worktree_a) {
            let unsupported = error.raw_os_error() == Some(1314)
                || matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
                );
            if unsupported {
                let _ = fs::remove_dir_all(&root);
                return;
            }
            panic!("unexpected directory symlink error: {error}");
        }
    }
    {
        let mut state = DEV_STATE.lock().unwrap();
        state.generation = 1;
        state.base_repo = Some(base.to_string_lossy().to_string());
        state.base_identity = Some(base_identity);
        state.worktrees = vec![
            worktree_a.to_string_lossy().to_string(),
            worktree_b.to_string_lossy().to_string(),
        ];
        state.registrations = vec![
            RegisteredWorktree {
                generation: 1,
                path: worktree_a.to_string_lossy().to_string(),
                branch: "worker/a".into(),
                identity: identity_a,
            },
            RegisteredWorktree {
                generation: 1,
                path: worktree_b.to_string_lossy().to_string(),
                branch: "worker/b".into(),
                identity: identity_b,
            },
        ];
    }
    let result = dev_cwd_kind(&worktree_a.join("sub").to_string_lossy());
    {
        let mut state = DEV_STATE.lock().unwrap();
        *state = DevState::new();
    }
    let _ = fs::remove_dir_all(&root);
    assert!(
        result.is_err(),
        "registered A redirected to registered B must be rejected"
    );
}

#[test]
fn cwd_rejects_base_repo_redirect_to_registered_worktree() {
    let _test_guard = lock_dev_state_tests();
    let root = std::env::temp_dir().join(format!("slimemold-base-redirect-{}", std::process::id()));
    let base = root.join("base");
    let other = root.join("other");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&base).unwrap();
    fs::create_dir_all(&other).unwrap();
    let base_identity = stable_directory_identity(&base).unwrap();
    let other_identity = stable_directory_identity(&other).unwrap();
    fs::rename(&base, root.join("base-original")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&other, &base).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_dir;
        if let Err(error) = symlink_dir(&other, &base) {
            let unsupported = error.raw_os_error() == Some(1314)
                || matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
                );
            if unsupported {
                let _ = fs::remove_dir_all(&root);
                return;
            }
            panic!("unexpected directory symlink error: {error}");
        }
    }
    {
        let mut state = DEV_STATE.lock().unwrap();
        state.generation = 1;
        state.base_repo = Some(base.to_string_lossy().to_string());
        state.base_identity = Some(base_identity);
        state.worktrees = vec![other.to_string_lossy().to_string()];
        state.registrations = vec![RegisteredWorktree {
            generation: 1,
            path: other.to_string_lossy().to_string(),
            branch: "worker/other".into(),
            identity: other_identity,
        }];
    }
    let result = dev_cwd_kind(&base.to_string_lossy());
    {
        let mut state = DEV_STATE.lock().unwrap();
        *state = DevState::new();
    }
    let _ = fs::remove_dir_all(&root);
    assert!(
        result.is_err(),
        "base repo redirect to a registered worktree must be rejected"
    );
}

#[test]
fn cwd_rejects_noncanonical_base_alias_after_base_replacement() {
    let _test_guard = lock_dev_state_tests();
    let root = std::env::temp_dir().join(format!("slimemold-base-alias-{}", std::process::id()));
    let base = root.join("base");
    let original = root.join("base-original");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&base).unwrap();
    let original_identity = stable_directory_identity(&base).unwrap();
    fs::rename(&base, &original).unwrap();
    fs::create_dir_all(&base).unwrap();
    {
        let mut state = DEV_STATE.lock().unwrap();
        state.generation = 1;
        state.base_repo = Some(base.to_string_lossy().to_string());
        state.base_identity = Some(original_identity);
        state.worktrees.clear();
        state.registrations.clear();
    }
    let alias = format!("{}//.", base.to_string_lossy());
    let result = dev_cwd_kind(&alias);
    {
        let mut state = DEV_STATE.lock().unwrap();
        *state = DevState::new();
    }
    let _ = fs::remove_dir_all(&root);
    assert!(
        result.is_err(),
        "base alias must not reach canonical fallback"
    );
}

#[test]
fn bound_file_write_rejects_same_path_replacement() {
    let root = std::env::temp_dir().join(format!("slimemold-file-identity-{}", std::process::id()));
    let target = root.join("target.txt");
    let old = root.join("target.old");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(&target, "old").unwrap();
    let expected = stable_file_identity(&target).unwrap();
    let expected_parent = stable_file_identity(root.as_path()).unwrap();
    fs::rename(&target, &old).unwrap();
    fs::write(&target, "replacement").unwrap();
    let result = write_dev_file_bound(&target, "new", &expected, &expected_parent);
    assert!(
        result.is_err(),
        "bound write must reject same-path file replacement"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "replacement");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn cleanup_target_identity_allows_absent_unlisted_orphan_only() {
    let root =
        std::env::temp_dir().join(format!("slimemold-cleanup-target-{}", std::process::id()));
    let repo = root.join("repo");
    let missing =
        std::path::PathBuf::from(format!("{}-workers", repo.to_string_lossy())).join("worker-a");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&repo).unwrap();
    let output = Command::new(resolve_dev_program("git"))
        .args(["init", "-q"])
        .current_dir(&repo)
        .env_clear()
        .envs(dev_sanitized_env())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(cleanup_target_identity_is_current(&repo, &missing, "worker/worker-a", None).unwrap());
    fs::write(&missing, "regular file").unwrap_or_else(|_| {
        fs::create_dir_all(missing.parent().unwrap()).unwrap();
        fs::write(&missing, "regular file").unwrap();
    });
    assert!(!cleanup_target_identity_is_current(
        &repo,
        &missing,
        "worker/worker-a",
        Some(&StableDirectoryIdentity {
            canonical_path: missing.to_string_lossy().to_string(),
            volume_or_device: 1,
            file_or_inode: 2,
        }),
    )
    .unwrap());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn existing_worker_operation_rejects_regular_file_target() {
    let root = std::env::temp_dir().join(format!(
        "slimemold-worker-file-target-{}",
        std::process::id()
    ));
    let repo = root.join("repo");
    let worker_root = std::path::PathBuf::from(format!("{}-workers", repo.to_string_lossy()));
    let target = worker_root.join("worker-a");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&worker_root).unwrap();
    fs::write(&target, "not a directory").unwrap();
    assert!(!worker_target_is_safe_for_existing_operation(
        &repo,
        &target.to_string_lossy()
    ));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn orphan_candidate_rejects_live_listed_and_existing_targets() {
    assert!(!orphan_target_is_deleted_candidate(true, true, true, true));
    assert!(!orphan_target_is_deleted_candidate(false, true, true, true));
    assert!(!orphan_target_is_deleted_candidate(
        false, false, false, true
    ));
    assert!(!orphan_target_is_deleted_candidate(
        false, false, true, false
    ));
    assert!(orphan_target_is_deleted_candidate(false, false, true, true));
}

#[test]
fn cleanup_capability_requires_exact_single_use_identity() {
    let binding = CleanupBinding {
        token: "token-1".into(),
        generation: 3,
        path: "D:/workers/worker-a".into(),
        branch: "worker/worker-a".into(),
        branch_revision: "a".repeat(40),
        base_identity: StableDirectoryIdentity {
            canonical_path: "D:/repo".into(),
            volume_or_device: 1,
            file_or_inode: 2,
        },
        target_identity: Some(StableDirectoryIdentity {
            canonical_path: "D:/workers/worker-a".into(),
            volume_or_device: 1,
            file_or_inode: 3,
        }),
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

#[test]
fn cleanup_probe_error_consumes_capability() {
    let _test_guard = lock_dev_state_tests();
    let token = "probe-token";
    {
        let mut state = DEV_STATE.lock().unwrap();
        state.cleanup_bindings.clear();
        state.cleanup_bindings.push(CleanupBinding {
            token: token.into(),
            generation: 1,
            path: "D:/repo-workers/worker-a".into(),
            branch: "worker/worker-a".into(),
            branch_revision: "a".repeat(40),
            base_identity: StableDirectoryIdentity {
                canonical_path: "D:/repo".into(),
                volume_or_device: 1,
                file_or_inode: 2,
            },
            target_identity: None,
            consumed: false,
        });
    }

    let result: Result<(), String> =
        worktree_authority::cleanup_probe_or_invalidate(token, Err("probe failed".into()));
    assert_eq!(result, Err("probe failed".into()));
    assert!(
        DEV_STATE
            .lock()
            .unwrap()
            .cleanup_bindings
            .iter()
            .find(|binding| binding.token == token)
            .is_some_and(|binding| binding.consumed),
        "fallible cleanup probe must consume the capability"
    );
    DEV_STATE.lock().unwrap().cleanup_bindings.clear();
}

#[test]
fn cleanup_identity_guard_preserves_base_mismatch_short_circuit() {
    let _test_guard = lock_dev_state_tests();
    let token = "short-circuit-token";
    let expected_base = StableDirectoryIdentity {
        canonical_path: "D:/repo".into(),
        volume_or_device: 1,
        file_or_inode: 2,
    };
    {
        let mut state = DEV_STATE.lock().unwrap();
        state.cleanup_bindings.clear();
        state.cleanup_bindings.push(CleanupBinding {
            token: token.into(),
            generation: 1,
            path: "D:/repo-workers/worker-a".into(),
            branch: "worker/worker-a".into(),
            branch_revision: "a".repeat(40),
            base_identity: expected_base.clone(),
            target_identity: None,
            consumed: false,
        });
    }

    let target_called = std::cell::Cell::new(false);
    let result = worktree_authority::cleanup_identity_guard(
        token,
        Ok(StableDirectoryIdentity {
            canonical_path: "D:/other-repo".into(),
            volume_or_device: 1,
            file_or_inode: 9,
        }),
        &expected_base,
        "phase-specific identity drift",
        || {
            target_called.set(true);
            Err("target probe must not run".into())
        },
    );
    assert_eq!(result, Err("phase-specific identity drift".into()));
    assert!(
        !target_called.get(),
        "base mismatch must short-circuit target probe"
    );
    assert!(
        DEV_STATE
            .lock()
            .unwrap()
            .cleanup_bindings
            .iter()
            .find(|binding| binding.token == token)
            .is_some_and(|binding| binding.consumed),
        "base mismatch must consume the capability"
    );
    DEV_STATE.lock().unwrap().cleanup_bindings.clear();
}
