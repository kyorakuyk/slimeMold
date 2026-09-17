use std::path::Path;

pub(crate) fn path_compare_key(raw: &str) -> String {
    let mut normalized = raw.replace('\\', "/").trim_end_matches('/').to_string();
    if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
        normalized = format!("//{unc}");
    } else if let Some(verbatim) = normalized.strip_prefix("//?/") {
        normalized = verbatim.to_string();
    }
    #[cfg(windows)]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

pub(crate) fn path_is_same_or_child(path: &Path, root: &Path) -> bool {
    let path = path_compare_key(&path.to_string_lossy());
    let root = path_compare_key(&root.to_string_lossy());
    path == root || path.starts_with(&(root + "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
