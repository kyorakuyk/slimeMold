pub(crate) fn worker_name_is_valid(name: &str) -> bool {
    name.len() <= 200
        && !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.to_ascii_lowercase().ends_with(".lock")
}

pub(crate) fn worker_branch_is_valid(branch: &str) -> bool {
    let Some(suffix) = branch.strip_prefix("worker/") else {
        return false;
    };
    worker_name_is_valid(suffix)
}

pub(crate) fn is_full_object_id(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.chars().all(|c| c.is_ascii_hexdigit())
}

pub(crate) fn worker_branch_from_tip_arg(arg: &str) -> Option<&str> {
    let branch_ref = arg.strip_suffix("^{commit}")?.strip_prefix("refs/heads/")?;
    worker_branch_is_valid(branch_ref).then_some(branch_ref)
}

pub(crate) fn worker_branch_from_ref_arg(arg: &str) -> Option<&str> {
    let branch = arg.strip_prefix("refs/heads/")?;
    worker_branch_is_valid(branch).then_some(branch)
}
