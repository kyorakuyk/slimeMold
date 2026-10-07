use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn git_top_level_failure_reports_nonsecret_launch_context() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "slimemold-git-probe-diagnostics-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("temporary non-repository directory should be created");
    let _cleanup = TempDir(path.clone());

    let error = git_top_level(&path).expect_err("a non-repository must fail the Git probe");

    assert!(error.contains("exit code"), "missing exit code: {error}");
    assert!(
        error.contains("exe="),
        "missing executable context: {error}"
    );
    assert!(
        error.contains("cwd="),
        "missing working-directory context: {error}"
    );
    assert!(
        error.contains("path_entries="),
        "missing PATH summary: {error}"
    );
    assert!(
        !error.contains("GITHUB_TOKEN") && !error.contains("OPENAI_API_KEY"),
        "diagnostics must not expose credential variable names: {error}"
    );
}
