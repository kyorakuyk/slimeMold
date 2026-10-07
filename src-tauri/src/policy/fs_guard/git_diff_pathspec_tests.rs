use super::{
    canonicalize_dev_exec_args, dev_exec_validate_paths, git_diff_pathspec_allowed,
    path_is_same_or_child,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "slimemold-git-pathspec-{label}-{}-{suffix}",
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

fn hardened_git_diff_args(pathspec: &str) -> Vec<String> {
    [
        "git",
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        pathspec,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[cfg(unix)]
fn create_dir_symlink(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).unwrap();
    true
}

#[cfg(windows)]
fn create_dir_symlink(target: &Path, link: &Path) -> bool {
    use std::os::windows::fs::symlink_dir;
    if let Err(error) = symlink_dir(target, link) {
        let unsupported = matches!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
        ) || error.raw_os_error() == Some(1314);
        if unsupported {
            return false;
        }
        panic!("unexpected symlink creation error: {error}");
    }
    true
}

#[test]
fn hardened_git_diff_accepts_a_missing_absolute_pathspec_inside_worktree() {
    let base = TestDir::new("absolute-missing");
    let worktree = base.path().join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    let pathspec = worktree
        .join("src/components")
        .to_string_lossy()
        .into_owned();
    let args = hardened_git_diff_args(&pathspec);

    let validation = dev_exec_validate_paths(worktree.to_str().unwrap(), &args);
    let canonicalization = canonicalize_dev_exec_args(&worktree, &args);

    assert!(
        validation.is_ok(),
        "missing absolute pathspec inside worktree rejected: {validation:?}"
    );
    assert!(
        canonicalization.is_ok(),
        "missing absolute pathspec could not be canonicalized: {canonicalization:?}"
    );
    let canonical = canonicalization.unwrap();
    assert!(Path::new(&canonical[7]).is_absolute());
    assert!(path_is_same_or_child(
        Path::new(&canonical[7]),
        &worktree.canonicalize().unwrap()
    ));
    assert!(git_diff_pathspec_allowed(&worktree, Path::new(&canonical[7])).is_ok());
}

#[test]
fn hardened_git_diff_rejects_missing_absolute_pathspecs_outside_or_with_parent_segments() {
    let base = TestDir::new("absolute-escape");
    let worktree = base.path().join("wt");
    let outside = base.path().join("outside");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let pathspecs = [
        outside
            .join("src/components")
            .to_string_lossy()
            .into_owned(),
        worktree
            .join("../outside/src/components")
            .to_string_lossy()
            .into_owned(),
    ];

    for pathspec in pathspecs {
        let args = hardened_git_diff_args(&pathspec);
        let validation = dev_exec_validate_paths(worktree.to_str().unwrap(), &args);
        let canonicalization = canonicalize_dev_exec_args(&worktree, &args);
        assert!(
            validation.is_err(),
            "absolute pathspec must not escape worktree: {pathspec}"
        );
        assert!(
            canonicalization.is_err(),
            "absolute pathspec must not escape worktree: {pathspec}"
        );
    }
}

#[test]
fn hardened_git_diff_rejects_absolute_pathspecs_through_escaping_symlinks() {
    let base = TestDir::new("absolute-symlink-escape");
    let worktree = base.path().join("wt");
    let outside = base.path().join("outside");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    if !create_dir_symlink(&outside, &worktree.join("src")) {
        return;
    }

    let pathspec = worktree
        .join("src/components")
        .to_string_lossy()
        .into_owned();
    let args = hardened_git_diff_args(&pathspec);
    assert!(dev_exec_validate_paths(worktree.to_str().unwrap(), &args).is_err());
    assert!(canonicalize_dev_exec_args(&worktree, &args).is_err());
}

#[test]
fn hardened_git_diff_rejects_absolute_pathspecs_through_dangling_symlinks() {
    let base = TestDir::new("absolute-dangling-symlink");
    let worktree = base.path().join("wt");
    let target_parent = base.path().join("outside");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&target_parent).unwrap();
    if !create_dir_symlink(&target_parent.join("missing"), &worktree.join("src")) {
        return;
    }

    let pathspec = worktree
        .join("src/components")
        .to_string_lossy()
        .into_owned();
    let args = hardened_git_diff_args(&pathspec);
    assert!(dev_exec_validate_paths(worktree.to_str().unwrap(), &args).is_err());
    assert!(canonicalize_dev_exec_args(&worktree, &args).is_err());
}
