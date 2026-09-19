use std::path::{Path, PathBuf};

pub(crate) fn dev_strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        let value = s.as_ref();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(verbatim) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(verbatim);
        }
    }
    PathBuf::from(s.as_ref())
}

pub(crate) fn path_compare_key(raw: &str) -> String {
    let mut normalized = raw.replace('\\', "/").trim_end_matches('/').to_string();
    #[cfg(windows)]
    {
        normalized = normalized.to_ascii_lowercase();
    }
    if let Some(unc) = normalized
        .strip_prefix("//?/UNC/")
        .or_else(|| normalized.strip_prefix("//?/unc/"))
    {
        normalized = format!("//{unc}");
    } else if let Some(verbatim) = normalized.strip_prefix("//?/") {
        normalized = verbatim.to_string();
    }
    normalized
}

pub(crate) fn protected_relative_path(rel: &str) -> bool {
    let rel = rel
        .replace('\\', "/")
        .trim_matches('/')
        .to_ascii_lowercase();
    rel == "package.json"
        || rel == "package-lock.json"
        || rel == "vitest.config.ts"
        || rel == "scripts"
        || rel.starts_with("scripts/")
        || rel == "tests"
        || rel.starts_with("tests/")
        || rel == "src/store/workflowstore.ts"
        || rel == "src/engine/executor.ts"
        || rel == "src/plugins/sandbox"
        || rel.starts_with("src/plugins/sandbox/")
        || rel == "src-tauri/capabilities"
        || rel.starts_with("src-tauri/capabilities/")
        || rel == "src/orchestrator"
        || rel.starts_with("src/orchestrator/")
}

pub(crate) fn protected_path_error(abs: &Path, root: &Path) -> Option<String> {
    let abs_key = path_compare_key(&abs.to_string_lossy());
    let root_key = path_compare_key(&root.to_string_lossy());
    let rel = if abs_key == root_key {
        String::new()
    } else {
        abs_key.strip_prefix(&(root_key + "/"))?.to_string()
    };
    protected_relative_path(&rel)
        .then(|| format!("dev_file: 路径受 host protected policy 保护：{rel}"))
}

pub(crate) fn protected_path_is_execution_only_script(abs: &Path, root: &Path) -> bool {
    let abs_key = path_compare_key(&abs.to_string_lossy());
    let root_key = path_compare_key(&root.to_string_lossy());
    abs_key
        .strip_prefix(&(root_key + "/"))
        .is_some_and(|rel| rel.starts_with("scripts/"))
}

pub(crate) fn git_diff_pathspec_allowed(cwd: &Path, path: &Path) -> Result<(), String> {
    let cwd_key = path_compare_key(&dev_strip_verbatim(cwd).to_string_lossy());
    let path_key = path_compare_key(&dev_strip_verbatim(path).to_string_lossy());
    let rel = (if path_key == cwd_key {
        String::new()
    } else {
        path_key
            .strip_prefix(&(cwd_key.clone() + "/"))
            .ok_or_else(|| format!("dev_exec: Git pathspec 不属于 worktree：{}", path.display()))?
            .to_string()
    })
    .to_ascii_lowercase();
    let protected_roots = [
        "package.json",
        "package-lock.json",
        "vitest.config.ts",
        "scripts",
        "tests",
        "src/store/workflowstore.ts",
        "src/engine/executor.ts",
        "src/plugins/sandbox",
        "src-tauri/capabilities",
        "src/orchestrator",
        ".git",
        ".slimemold",
    ];
    if rel.is_empty()
        || protected_roots.iter().any(|root| {
            rel == *root
                || rel.starts_with(&format!("{root}/"))
                || root.starts_with(&(rel.clone() + "/"))
        })
    {
        return Err(format!(
            "dev_exec: Git pathspec 命中 protected root 或其 ancestor：{}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn path_is_same_or_child(path: &Path, root: &Path) -> bool {
    let path = path_compare_key(&path.to_string_lossy());
    let root = path_compare_key(&root.to_string_lossy());
    path == root || path.starts_with(&(root + "/"))
}

fn canonicalize_if_present(path: &Path) -> Result<Option<PathBuf>, String> {
    match path.canonicalize() {
        Ok(canonical) => Ok(Some(canonical)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "dev_exec: 无法 canonicalize 参数路径 {}：{error}",
            path.display()
        )),
    }
}

fn canonicalize_required(path: &Path, raw: &str) -> Result<PathBuf, String> {
    canonicalize_if_present(path)?.ok_or_else(|| format!("dev_exec: 参数路径不存在：{raw}"))
}

pub(crate) fn dev_arg_shell_safe(arg: &str) -> bool {
    !arg.is_empty()
        && arg.chars().all(|character| !character.is_control())
        && !arg.chars().any(|character| {
            matches!(
                character,
                '&' | '|' | '<' | '>' | '^' | '%' | '!' | '"' | '\'' | '`' | ';' | '(' | ')'
            )
        })
}

pub(crate) fn grep_pattern_index(args: &[String]) -> Option<usize> {
    let mut options = true;
    for (index, argument) in args.iter().enumerate().skip(1) {
        if options && argument == "--" {
            options = false;
            continue;
        }
        if options && argument.starts_with('-') {
            continue;
        }
        return Some(index);
    }
    None
}

fn grep_file_operand_indices(args: &[String]) -> Vec<usize> {
    let Some(pattern) = grep_pattern_index(args) else {
        return Vec::new();
    };
    (pattern + 1..args.len())
        .filter(|index| !args[*index].starts_with('-'))
        .collect()
}

pub(crate) fn is_git_diff_revision(arg: &str) -> bool {
    if arg == "HEAD" {
        return true;
    }
    if (arg.len() == 40 || arg.len() == 64) && arg.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    if arg.starts_with("refs/heads/") || arg.starts_with("refs/tags/") {
        let suffix = arg
            .split_once("/")
            .map(|(_, value)| value)
            .unwrap_or_default();
        return !suffix.is_empty()
            && !arg.ends_with('/')
            && !arg.contains("..")
            && !arg.contains("//")
            && arg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
    }
    if ["feature/", "bugfix/", "hotfix/", "release/", "worker/"]
        .iter()
        .any(|prefix| arg.starts_with(prefix))
    {
        let suffix = arg.split('/').last().unwrap_or_default();
        return !suffix.is_empty()
            && !suffix.contains('.')
            && !arg.contains("..")
            && !arg.contains("//")
            && arg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
    }
    if !arg.is_empty()
        && arg
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && !arg.contains('/')
        && !arg.contains('\\')
        && !arg.contains('.')
        && !arg.ends_with('-')
        && !arg.ends_with('_')
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        return true;
    }
    false
}

fn tsc_path_start(args: &[String]) -> usize {
    if args.get(1).map(|value| value.as_str()) != Some("--noEmit") {
        return args.len();
    }
    if args.get(2).map(|value| value.as_str()) == Some("--target")
        && args.get(3).map(|value| value.as_str()) == Some("es2020")
    {
        4
    } else {
        2
    }
}

fn find_starting_point_indices(args: &[String]) -> Vec<usize> {
    let mut start = 1;
    while args
        .get(start)
        .is_some_and(|argument| matches!(argument.as_str(), "-P" | "-L" | "-H"))
    {
        start += 1;
    }
    args.iter()
        .enumerate()
        .skip(start)
        .take_while(|(_, argument)| !argument.starts_with('-'))
        .map(|(index, _)| index)
        .collect()
}

/// worktree 内命令的文件路径参数**词法级**校验（纯函数，无 IO，可单测）。
/// 拦截：绝对路径（POSIX `/`、Windows `C:\`、UNC `\\`）、`..` 逃逸、`~`、shell 元字符重定向。
/// `*`/`?` 保留为直接 spawn 的 find/grep 模式操作数；Rust 不经过 shell，不会发生 shell 展开。
/// 注意：词法校验不解析符号链接，symlink 逃逸由 dev_exec_validate_paths 的 canonicalize 层兜底。
pub(crate) fn dev_arg_path_lexically_safe(arg: &str) -> bool {
    if arg.is_empty() || arg == "." || arg == ".." {
        return false;
    }
    let path = Path::new(arg);
    if path.is_absolute() {
        return false;
    }
    let bytes = arg.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    #[cfg(windows)]
    if arg.contains(':') {
        return false;
    }
    if arg.starts_with('/') || arg.starts_with('\\') {
        return false;
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return false;
    }
    if arg == "~" || arg.starts_with("~/") || arg.starts_with("~\\") {
        return false;
    }
    const META: &[char] = &[
        '>', '<', '|', '&', ';', '`', '$', 39 as char, '"', '(', ')', ' ',
    ];
    !arg.chars().any(|character| META.contains(&character))
}

/// dev_exec 实际 spawn 前，对**文件路径参数**做 canonicalize 校验（解析符号链接），
/// 确认其规范化后路径仍落在 cwd（worktree 根）之内。防止通过 symlink 读取 worktree 外文件。
/// 仅对带路径参数的受控文件读取或脚本命令（cat/head/tail/ls/grep/find/git diff/tsx）生效。
/// 规则：文件 operand 必须存在并成功 canonicalize；NotFound 与其他 I/O 错误都直接拒绝；
/// 若路径存在且 canonicalize 后逃出 cwd，也拒绝。
pub(crate) fn dev_exec_validate_paths(cwd: &str, args: &[String]) -> Result<(), String> {
    let name = args.first().map(|value| value.as_str());
    let check = |arg: &str| -> Result<(), String> {
        let worktree_root = dev_strip_verbatim(Path::new(cwd));
        let joined = worktree_root.join(arg);
        let canonical = canonicalize_required(&joined, arg)?;
        let normalized = dev_strip_verbatim(&canonical);
        if !path_is_same_or_child(&normalized, &worktree_root) {
            return Err(format!("dev_exec: 参数路径逃逸出 worktree：{arg}"));
        }
        Ok(())
    };
    match name {
        Some("cat") | Some("head") | Some("tail") | Some("ls") => {
            for argument in args.iter().skip(1) {
                if !argument.starts_with('-') {
                    check(argument)?;
                }
            }
        }
        Some("find") => {
            for index in find_starting_point_indices(args) {
                check(&args[index])?;
            }
        }
        Some("git")
            if args.get(1).map(|value| value.as_str()) == Some("--no-pager")
                && args.get(2).map(|value| value.as_str()) == Some("diff") =>
        {
            if args.get(5).map(|value| value.as_str()) != Some("--name-only") {
                for index in 7..args.len() {
                    check(&args[index])?;
                }
            }
        }
        Some("git")
            if args.get(1).map(|value| value.as_str()) == Some("diff")
                && args.get(2).is_some_and(|value| is_git_diff_revision(value))
                && args.get(3).map(|value| value.as_str()) == Some("--") =>
        {
            for index in 4..args.len() {
                check(&args[index])?;
            }
        }
        Some("git") => {
            if args.get(1).map(|value| value.as_str()) == Some("diff")
                && !args.get(2).is_some_and(|value| is_git_diff_revision(value))
            {
                if let Some(path) = args.get(2) {
                    if !path.starts_with('-') {
                        check(path)?;
                    }
                }
            }
        }
        Some("grep") => {
            for index in grep_file_operand_indices(args) {
                check(&args[index])?;
            }
        }
        Some("node") => {
            if args.get(1).map(|value| value.as_str()) == Some("--check") {
                if let Some(path) = args.get(2) {
                    check(path)?;
                }
            }
        }
        Some("tsc") => {
            for path in args.iter().skip(tsc_path_start(args)) {
                check(path)?;
            }
        }
        Some("tsx") => {
            if let Some(script) = args.get(1) {
                check(script)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Canonicalizes command-specific existing path operands under `cwd`.
/// Every filesystem operand must exist and is replaced with its canonical path; symlink escapes
/// and missing paths fail closed. Non-filesystem operands such as grep patterns and git revisions
/// remain untouched.
pub(crate) fn canonicalize_dev_exec_args(
    cwd: &Path,
    args: &[String],
) -> Result<Vec<String>, String> {
    let mut result = args.to_vec();
    let mut replace_if_existing = |index: usize| -> Result<(), String> {
        let Some(raw) = result.get(index).cloned() else {
            return Ok(());
        };
        if raw.starts_with('-') || raw == "." {
            return Ok(());
        }
        let joined = cwd.join(&raw);
        let canonical = canonicalize_required(&joined, &raw)?;
        if !path_is_same_or_child(&canonical, cwd) {
            return Err(format!("dev_exec: 参数路径逃逸出 worktree：{raw}"));
        }
        result[index] = dev_strip_verbatim(&canonical).to_string_lossy().to_string();
        Ok(())
    };
    match args.first().map(|value| value.as_str()) {
        Some("cat") | Some("head") | Some("tail") | Some("ls") => {
            for index in 1..args.len() {
                replace_if_existing(index)?;
            }
        }
        Some("find") => {
            for index in find_starting_point_indices(args) {
                replace_if_existing(index)?;
            }
        }
        Some("node") if args.get(1).map(|value| value.as_str()) == Some("--check") => {
            replace_if_existing(2)?;
        }
        Some("tsc") => {
            for index in tsc_path_start(args)..args.len() {
                replace_if_existing(index)?;
            }
        }
        Some("tsx") => replace_if_existing(1)?,
        Some("git")
            if args.get(1).map(|value| value.as_str()) == Some("--no-pager")
                && args.get(2).map(|value| value.as_str()) == Some("diff") =>
        {
            if args.get(5).map(|value| value.as_str()) != Some("--name-only") {
                for index in 7..args.len() {
                    replace_if_existing(index)?;
                }
            }
        }
        Some("git")
            if args.get(1).map(|value| value.as_str()) == Some("diff")
                && args.get(2).is_some_and(|value| is_git_diff_revision(value))
                && args.get(3).map(|value| value.as_str()) == Some("--") =>
        {
            for index in 4..args.len() {
                replace_if_existing(index)?;
            }
        }
        Some("git")
            if args.get(1).map(|value| value.as_str()) == Some("diff")
                && !args.get(2).is_some_and(|value| is_git_diff_revision(value)) =>
        {
            replace_if_existing(2)?;
        }
        Some("grep") => {
            for index in grep_file_operand_indices(args) {
                replace_if_existing(index)?;
            }
        }
        _ => {}
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
