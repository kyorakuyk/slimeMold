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
                let output =
                    Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()))
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
    assert!(dev_main_repo_git_allowed(&sv(&[
        "git",
        "show-ref",
        "--verify",
        "refs/heads/worker/w-0123abcd"
    ])));
    assert!(!dev_main_repo_git_allowed(&sv(&[
        "git",
        "show-ref",
        "--verify",
        "refs/heads/main"
    ])));
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
    for name in [
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_PAGER",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
    ] {
        assert!(
            !is_safe_env_name(name),
            "unexpected Git env allowlist entry: {name}"
        );
    }
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
        "head",
        "--files0-from=/outside/list"
    ])));
    assert!(!dev_worktree_cmd_allowed(&sv(&[
        "cat",
        "--files0-from=/outside/list"
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
        "--",
    ])));
    assert!(dev_worktree_cmd_allowed(&sv(&[
        "git",
        "diff",
        "--name-only",
        "feature/base-revision",
        "--",
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
        "node",
        "--check",
        "src/main.js"
    ])));
    assert!(dev_worktree_cmd_allowed(&sv(&[
        "tsc",
        "--noEmit",
        "src/game/engine.ts",
        "src/game/rules.ts"
    ])));
    assert!(dev_worktree_cmd_allowed(&sv(&[
        "tsc",
        "--noEmit",
        "--target",
        "es2020",
        "src/game/engine.ts"
    ])));
    assert!(!dev_worktree_cmd_allowed(&sv(&[
        "node",
        "--check",
        "C:/outside/main.js"
    ])));
    assert!(!dev_worktree_cmd_allowed(&sv(&[
        "tsc",
        "--noEmit",
        "../outside.ts"
    ])));
    assert!(!dev_worktree_cmd_allowed(&sv(&[
        "node",
        "--check",
        "--eval=process.exit(1)"
    ])));
    assert!(!dev_worktree_cmd_allowed(&sv(&[
        "tsx",
        "scripts/check.ts",
        "&whoami"
    ])));
}

#[test]
fn worktree_read_commands_allow_find_glob_but_reject_grep_literal_glob() {
    assert!(dev_worktree_cmd_allowed(&sv(&[
        "find",
        "src/components",
        "-name",
        "*.tsx"
    ])));
    assert!(!dev_worktree_cmd_allowed(&sv(&["grep", "needle", "*.tsx"])));
    assert!(dev_worktree_cmd_allowed(&sv(&[
        "grep",
        "--",
        "--",
        "src/file.tsx"
    ])));
    assert!(dev_worktree_cmd_allowed(&sv(&[
        "find",
        "-P",
        "src/components",
        "-name",
        "*.tsx"
    ])));
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
    let revision_result = dev_exec(revision_args.clone(), base_str.clone(), generation).unwrap();
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
fn orphan_registration_preserves_native_branch_revision() {
    let _test_guard = lock_dev_state_tests();
    let test_root = std::env::temp_dir().join("slimemold-test-runs");
    let root = test_root.join(format!(
        "sm-orphan-lineage-{}_{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    let base = root.join("repo");
    let workers = std::path::PathBuf::from(format!("{}-workers", base.to_string_lossy()));
    let target = workers.join("attempt-1");
    let base_str = base.to_string_lossy().to_string();
    let target_str = target.to_string_lossy().to_string();
    let branch = "worker/attempt-1".to_string();
    let _cleanup = TempDirs(vec![root.clone()]);
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
    git(
        &["worktree", "add", "-q", &target_str, "-b", &branch, "HEAD"],
        &base,
    );
    let revision_ref = format!("refs/heads/{branch}^{{commit}}");
    let revision_output = Command::new(resolve_dev_program("git"))
        .args(["rev-parse", "--verify", "--end-of-options", &revision_ref])
        .current_dir(&base)
        .env_clear()
        .envs(dev_sanitized_env())
        .output()
        .unwrap();
    assert!(revision_output.status.success());
    let branch_revision = String::from_utf8_lossy(&revision_output.stdout)
        .trim()
        .to_string();
    git(&["worktree", "remove", "--force", &target_str], &base);
    assert!(
        !target.exists(),
        "fixture target must be absent for orphan registration"
    );

    let generation = dev_init_session(base_str.clone()).unwrap();
    let result = worktree_authority::dev_register_orphan_worktree(
        target_str.clone(),
        branch.clone(),
        branch_revision.clone(),
        generation,
    );
    assert!(
        result.is_ok(),
        "orphan registration should succeed: {result:?}"
    );
    let stored_revision = DEV_STATE
        .lock()
        .unwrap()
        .orphan_worktrees
        .iter()
        .find(|item| item.branch == branch)
        .and_then(|item| item.branch_revision.clone());
    DEV_STATE
        .lock()
        .unwrap()
        .orphan_worktrees
        .iter_mut()
        .find(|item| item.branch == branch)
        .expect("registered orphan fixture")
        .branch_revision = None;
    let legacy_duplicate_result = worktree_authority::dev_register_orphan_worktree(
        target_str.clone(),
        branch.clone(),
        branch_revision.clone(),
        generation,
    );
    {
        let mut state = DEV_STATE.lock().unwrap();
        state
            .orphan_worktrees
            .iter_mut()
            .find(|item| item.branch == branch)
            .expect("registered orphan fixture")
            .branch_revision = Some(branch_revision.clone());
        state.orphan_worktrees.push(PendingWorktree {
            generation,
            path: target_str.clone(),
            branch: branch.clone(),
            identity: None,
            branch_revision: Some("b".repeat(40)),
            removed: true,
        });
    }
    let conflicting_duplicate_result = worktree_authority::dev_register_orphan_worktree(
        target_str,
        branch.clone(),
        branch_revision.clone(),
        generation,
    );
    dev_clear_session(generation).unwrap();

    assert_eq!(
        stored_revision.as_deref(),
        Some(branch_revision.as_str()),
        "native orphan lineage must retain the creation-time branch tip"
    );
    assert!(
        legacy_duplicate_result.is_err(),
        "duplicate orphan registration must reject missing native lineage"
    );
    assert!(
        conflicting_duplicate_result.is_err(),
        "duplicate orphan registration must reject later conflicting lineage"
    );
}

#[test]
fn orphan_registration_rejects_branch_revision_drift() {
    let _test_guard = lock_dev_state_tests();
    let test_root = std::env::temp_dir().join("slimemold-test-runs");
    let root = test_root.join(format!(
        "sm-orphan-drift-{}_{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    let base = root.join("repo");
    let workers = std::path::PathBuf::from(format!("{}-workers", base.to_string_lossy()));
    let target = workers.join("attempt-1");
    let base_str = base.to_string_lossy().to_string();
    let target_str = target.to_string_lossy().to_string();
    let branch = "worker/attempt-1".to_string();
    let _cleanup = TempDirs(vec![root.clone()]);
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
    git(
        &["worktree", "add", "-q", &target_str, "-b", &branch, "HEAD"],
        &base,
    );
    let revision_ref = format!("refs/heads/{branch}^{{commit}}");
    let revision_output = Command::new(resolve_dev_program("git"))
        .args(["rev-parse", "--verify", "--end-of-options", &revision_ref])
        .current_dir(&base)
        .env_clear()
        .envs(dev_sanitized_env())
        .output()
        .unwrap();
    assert!(revision_output.status.success());
    let original_revision = String::from_utf8_lossy(&revision_output.stdout)
        .trim()
        .to_string();
    git(&["worktree", "remove", "--force", &target_str], &base);
    git(&["commit", "--allow-empty", "-qm", "advance"], &base);
    git(&["branch", "-f", &branch, "HEAD"], &base);

    let generation = dev_init_session(base_str.clone()).unwrap();
    let result = worktree_authority::dev_register_orphan_worktree(
        target_str,
        branch.clone(),
        original_revision,
        generation,
    );
    let orphan_count = DEV_STATE
        .lock()
        .unwrap()
        .orphan_worktrees
        .iter()
        .filter(|item| item.branch == branch)
        .count();
    dev_clear_session(generation).unwrap();

    assert!(
        result.is_err(),
        "stale orphan branch revision must not bind a recreated branch"
    );
    assert_eq!(orphan_count, 0, "rejected orphan must not enter DEV_STATE");
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
            identity: None,
            branch_revision: None,
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
    let base =
        std::env::temp_dir().join(format!("slimemold-operation-lease-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let base_str = base.to_string_lossy().to_string();
    let generation = {
        let mut state = DEV_STATE.lock().unwrap();
        state.base_repo = Some(base_str);
        state.base_identity = Some(stable_directory_identity(&base).unwrap());
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
    let _ = fs::remove_dir_all(&base);
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

    let result = worktree_add_target_is_safe(&base, &target.to_string_lossy(), "worker/attempt-1");

    assert!(
        result.is_ok(),
        "a safe missing worker root may be created by git"
    );
}

#[test]
fn stale_session_generation_is_rejected_without_mutating_current_session() {
    let _test_guard = lock_dev_state_tests();
    let base =
        std::env::temp_dir().join(format!("slimemold-stale-generation-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let base_str = base.to_string_lossy().to_string();
    let generation = {
        let mut state = DEV_STATE.lock().unwrap();
        state.base_repo = Some(base_str.clone());
        state.base_identity = Some(stable_directory_identity(&base).unwrap());
        state.worktrees.clear();
        state.pending_worktrees.clear();
        state.generation = next_session_generation(state.generation);
        state.generation
    };
    let stale = next_session_generation(generation);
    let exec_result = dev_exec(sv(&["pwd"]), base_str.clone(), stale);
    let clear_result = dev_clear_session(stale);
    let still_current = {
        let state = DEV_STATE.lock().unwrap();
        state.base_repo.as_deref() == Some(base_str.as_str()) && state.generation == generation
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
    let _ = fs::remove_dir_all(&base);
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
    assert!(dev_exec_allowed(
        &wt,
        &sv(&["git", "status", "--porcelain"])
    ));
    assert!(dev_exec_allowed(
        &wt,
        &sv(&["git", "diff", "HEAD", "--", "src/a.ts"])
    ));
    assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "HEAD"])));
    assert!(dev_exec_allowed(
        &wt,
        &sv(&[
            "git",
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
            "C:/repo/wt/src/a.ts",
        ])
    ));
    assert!(dev_exec_allowed(
        &wt,
        &sv(&[
            "git",
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "HEAD",
            "--",
        ])
    ));
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
    assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "./"])));
    assert!(!dev_exec_allowed(&wt, &sv(&["git", "diff", "src/*.ts"])));
    assert!(!dev_exec_allowed(
        &wt,
        &sv(&["git", "diff", "feature/../src/orchestrator"])
    ));
    assert!(dev_exec_allowed(
        &wt,
        &sv(&[
            "git",
            "diff",
            "0123456789abcdef0123456789abcdef01234567",
            "--",
            "src/components",
        ])
    ));
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
    assert!(dev_exec_validate_paths(wt_root.to_str().unwrap(), &sv(&["cat", "ok.txt"])).is_ok());
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
        *st = DevState::new();
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
fn main_repo_allows_scoped_worker_branch_revision_probe_without_pending_lease() {
    let args = sv(&[
        "git",
        "rev-parse",
        "--verify",
        "--end-of-options",
        "refs/heads/worker/restored-worker^{commit}",
    ]);
    assert!(dev_main_repo_git_allowed_at(
        &args,
        Some(std::path::Path::new("D:/fixture")),
    ));
    assert!(!dev_main_repo_git_allowed_at(
        &sv(&[
            "node",
            "rev-parse",
            "--verify",
            "--end-of-options",
            "refs/heads/worker/restored-worker^{commit}",
        ]),
        Some(std::path::Path::new("D:/fixture")),
    ));
    assert!(!dev_main_repo_git_allowed_at(
        &sv(&[
            "tsx",
            "rev-parse",
            "--verify",
            "--end-of-options",
            "refs/heads/worker/restored-worker^{commit}",
        ]),
        Some(std::path::Path::new("D:/fixture")),
    ));
    assert!(!dev_main_repo_git_allowed_at(
        &sv(&[
            "git",
            "rev-parse",
            "--verify",
            "--end-of-options",
            "refs/heads/main^{commit}",
        ]),
        Some(std::path::Path::new("D:/fixture")),
    ));
    assert!(!dev_main_repo_git_allowed_at(
        &sv(&[
            "git",
            "rev-parse",
            "--verify",
            "--end-of-options",
            "refs/heads/worker/../escape^{commit}",
        ]),
        Some(std::path::Path::new("D:/fixture")),
    ));
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
    let actual_identity = stable_directory_identity(&wt).unwrap();
    {
        let mut state = DEV_STATE.lock().unwrap();
        let registered = state
            .registrations
            .iter_mut()
            .find(|item| item.path == wt.canonicalize().unwrap().to_string_lossy())
            .unwrap();
        registered.identity.file_or_inode = registered.identity.file_or_inode.saturating_add(1);
    }
    assert!(
        dev_register_worktree(wt_str.clone(), generation).is_err(),
        "same-path registration with a replacement identity must fail"
    );
    {
        let mut state = DEV_STATE.lock().unwrap();
        let registered = state
            .registrations
            .iter_mut()
            .find(|item| item.path == wt.canonicalize().unwrap().to_string_lossy())
            .unwrap();
        registered.identity = actual_identity;
    }
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
    let expected_child = dev_strip_verbatim(&child.canonicalize().unwrap());
    assert_eq!(
        assert_registered_worktree(child.to_str().unwrap()).unwrap(),
        expected_child
    );
    assert!(assert_registered_worktree(&base_str).is_err());
    dev_clear_session(generation).unwrap();
    git(&["worktree", "remove", "--force", &wt_str], &base);
    let _ = std::fs::remove_dir_all(&workers);
    let _ = std::fs::remove_dir_all(&base);
}

#[cfg(windows)]
#[test]
fn dev_strip_verbatim_preserves_unc_root() {
    let stripped = dev_strip_verbatim(std::path::Path::new(r"\\?\UNC\server\share\wt"));
    assert_eq!(stripped, std::path::PathBuf::from(r"\\server\share\wt"));
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
