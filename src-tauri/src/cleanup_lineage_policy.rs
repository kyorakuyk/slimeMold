use super::CleanupBinding;
use crate::fs_guard::path_compare_key;

pub(crate) fn cleanup_binding_matches(
    binding: &CleanupBinding,
    token: &str,
    generation: u64,
    path: &str,
    branch: &str,
    branch_revision: &str,
) -> bool {
    !binding.consumed
        && binding.token == token
        && binding.generation == generation
        && binding.branch == branch
        && binding.branch_revision == branch_revision
        && path_compare_key(&binding.path) == path_compare_key(path)
}

pub(crate) fn orphan_target_is_deleted_candidate(
    listed_match: bool,
    path_exists: bool,
    branch_exists: bool,
    target_is_scoped: bool,
) -> bool {
    !listed_match && !path_exists && branch_exists && target_is_scoped
}
