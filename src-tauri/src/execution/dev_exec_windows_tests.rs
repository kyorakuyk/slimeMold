use crate::{resolve_dev_program, resolve_dev_program_from_path};
use std::process::Command;

#[test]
fn binds_git_to_the_canonical_executable_selected_through_path() {
    let path = std::env::var_os("PATH").expect("Windows PATH is available");
    let candidate = resolve_dev_program_from_path("git", Some(&path));
    assert!(
        candidate.is_file(),
        "Git must be available on PATH for host tests"
    );

    let expected = candidate
        .canonicalize()
        .expect("canonicalize the PATH-selected Git executable");
    let resolved = resolve_dev_program("git");
    assert!(
        resolved.is_file(),
        "a parent junction in PATH must bind execution to an existing canonical target"
    );
    assert_eq!(
        resolved
            .canonicalize()
            .expect("resolve the bound Git executable"),
        expected,
        "execution must use the canonical PATH-selected Git executable"
    );

    let output = Command::new(&resolved)
        .arg("--version")
        .output()
        .expect("spawn the canonical Git executable");
    assert!(output.status.success(), "Git --version must succeed");
}
