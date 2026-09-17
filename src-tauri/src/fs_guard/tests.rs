use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct TestDir(std::path::PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "slimemold-fs-guard-{label}-{}-{suffix}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn path_compare_key_normalizes_trailing_separators() {
    assert_eq!(path_compare_key("worker-root///"), "worker-root");
}

#[test]
fn path_compare_key_normalizes_verbatim_unc_paths() {
    assert_eq!(path_compare_key("//?/UNC/server/share/"), "//server/share");
}

#[test]
fn path_is_same_or_child_respects_component_boundary() {
    assert!(path_is_same_or_child(
        Path::new("C:/repo/src"),
        Path::new("C:/repo")
    ));
    assert!(!path_is_same_or_child(
        Path::new("C:/repo-other"),
        Path::new("C:/repo")
    ));
}

#[test]
fn lexical_path_guard_rejects_escape_and_shell_syntax() {
    for value in [
        "../outside",
        "/outside",
        "\\outside",
        "C:/outside",
        "\\\\server\\share",
        "a|b",
        "a b",
    ] {
        assert!(!dev_arg_path_lexically_safe(value), "must reject {value}");
    }
    assert!(dev_arg_path_lexically_safe("src/components/*.tsx"));
}

#[test]
fn canonicalize_dev_exec_args_normalizes_existing_in_worktree_path() {
    let base = TestDir::new("canonicalize");
    let worktree = base.path().join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join("ok.txt"), "ok").unwrap();

    let args = vec!["cat".to_string(), "ok.txt".to_string()];
    let canonical = canonicalize_dev_exec_args(&worktree, &args).unwrap();
    assert!(Path::new(&canonical[1]).is_absolute());
    assert!(canonical[1].ends_with("ok.txt"));
}

#[test]
fn canonicalize_dev_exec_args_rejects_existing_symlink_escape() {
    let base = TestDir::new("canonicalize-symlink");
    let worktree = base.path().join("wt");
    let outside = base.path().join("outside");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "secret").unwrap();
    let link = worktree.join("evil_link");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_dir;
        if let Err(error) = symlink_dir(&outside, &link) {
            let unsupported = matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
            ) || error.raw_os_error() == Some(1314);
            if unsupported {
                return;
            }
            panic!("unexpected symlink creation error: {error}");
        }
    }

    let escaped = worktree.join("evil_link/secret.txt");
    assert!(
        escaped.exists(),
        "created symlink must resolve to the outside fixture"
    );
    let args = vec!["cat".to_string(), "evil_link/secret.txt".to_string()];
    assert!(canonicalize_dev_exec_args(&worktree, &args).is_err());
}

#[test]
fn canonicalize_preserves_non_file_operands_and_parses_file_operands() {
    let base = TestDir::new("canonicalize-grammar");
    let worktree = base.path().join("wt");
    std::fs::create_dir_all(worktree.join("src")).unwrap();
    std::fs::create_dir_all(worktree.join("tests")).unwrap();
    std::fs::write(worktree.join("HEAD"), "not a revision file").unwrap();
    std::fs::write(worktree.join("file.txt"), "needle").unwrap();

    let git_args = vec!["git".to_string(), "diff".to_string(), "HEAD".to_string()];
    let git_result = canonicalize_dev_exec_args(&worktree, &git_args).unwrap();
    assert_eq!(git_result, git_args);

    let grep_args = vec![
        "grep".to_string(),
        "-n".to_string(),
        "needle".to_string(),
        "file.txt".to_string(),
    ];
    let grep_result = canonicalize_dev_exec_args(&worktree, &grep_args).unwrap();
    assert_eq!(grep_result[2], "needle");
    assert!(Path::new(&grep_result[3]).is_absolute());

    let find_args = vec![
        "find".to_string(),
        "src".to_string(),
        "tests".to_string(),
        "-name".to_string(),
        "*.tsx".to_string(),
    ];
    let find_result = canonicalize_dev_exec_args(&worktree, &find_args).unwrap();
    assert!(Path::new(&find_result[1]).is_absolute());
    assert!(Path::new(&find_result[2]).is_absolute());
    assert_eq!(find_result[4], "*.tsx");

    let node_args = vec![
        "node".to_string(),
        "--check".to_string(),
        "file.txt".to_string(),
    ];
    let node_result = canonicalize_dev_exec_args(&worktree, &node_args).unwrap();
    assert!(Path::new(&node_result[2]).is_absolute());

    let tsc_args = vec![
        "tsc".to_string(),
        "--noEmit".to_string(),
        "--target".to_string(),
        "es2020".to_string(),
        "file.txt".to_string(),
    ];
    let tsc_result = canonicalize_dev_exec_args(&worktree, &tsc_args).unwrap();
    assert!(Path::new(&tsc_result[4]).is_absolute());
}

#[test]
fn canonicalize_rejects_missing_file_operands() {
    let base = TestDir::new("canonicalize-missing");
    let worktree = base.path().join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    let args = vec!["cat".to_string(), "missing.txt".to_string()];
    assert!(dev_exec_validate_paths(worktree.to_str().unwrap(), &args).is_err());
    assert!(canonicalize_dev_exec_args(&worktree, &args).is_err());
}

#[test]
fn command_path_parsers_handle_option_terminators_and_find_policy() {
    let grep_args = vec![
        "grep".to_string(),
        "--".to_string(),
        "--".to_string(),
        "/outside/passwd".to_string(),
    ];
    assert_eq!(grep_pattern_index(&grep_args), Some(2));

    let find_args = vec![
        "find".to_string(),
        "-P".to_string(),
        "link/secret.txt".to_string(),
        "-ls".to_string(),
    ];
    assert_eq!(find_starting_point_indices(&find_args), vec![2]);
}

#[test]
fn shell_argument_guard_rejects_cmd_metacharacters() {
    for value in ["&whoami", "^whoami", "%PATH%", "!PATH!", "x\r\ny"] {
        assert!(!dev_arg_shell_safe(value), "must reject {value}");
    }
    assert!(dev_arg_shell_safe("argument with spaces"));
}
