use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct PolicyVector {
    command: Vec<String>,
    accepted: bool,
    #[serde(rename = "intentKind")]
    intent_kind: Option<String>,
    #[allow(dead_code)]
    name: String,
}

fn is_safe_git_ref(value: &str) -> bool {
    if value.is_empty()
        || !value.is_ascii()
        || value == "@"
        || value.contains("..")
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        || value.chars().any(|c| {
            c.is_ascii_control()
                || c.is_ascii_whitespace()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
    {
        return false;
    }
    value.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.starts_with('.')
            && !part.ends_with('.')
            && !part.to_ascii_lowercase().ends_with(".lock")
    })
}

fn safe_revision(value: &str) -> bool {
    if value == "HEAD"
        || (matches!(value.len(), 40 | 64) && value.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return true;
    }
    if value.starts_with("refs/heads/") || value.starts_with("refs/tags/") {
        return value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
            && is_safe_git_ref(value);
    }
    if ["feature/", "bugfix/", "hotfix/", "release/", "worker/"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        let leaf = value.rsplit('/').next().unwrap_or_default();
        return is_safe_git_ref(value) && !leaf.is_empty() && !leaf.contains('.');
    }
    !value.is_empty()
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('.')
        && !value.ends_with('-')
        && !value.ends_with('_')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn is_windows_device_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "AUX"
            | "CLOCK$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "CON"
            | "CONIN$"
            | "CONOUT$"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "NUL"
            | "PRN"
    )
}

fn safe_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    let comparable = normalized.to_ascii_lowercase();
    let components: Vec<&str> = normalized.split('/').collect();
    if normalized.is_empty()
        || !normalized.is_ascii()
        || normalized.chars().any(|c| c.is_ascii_control())
        || normalized.starts_with('-')
        || normalized.starts_with('/')
        || normalized.starts_with('\\')
        || normalized.contains(":")
        || normalized.contains("..")
        || components.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.ends_with('.')
                || part.ends_with(' ')
                || is_windows_device_name(part)
        })
        || normalized.contains('*')
        || normalized.contains('?')
        || normalized.contains('[')
        || normalized.contains(']')
        || normalized.chars().all(|c| matches!(c, '.' | '/'))
    {
        return false;
    }
    [
        "package.json",
        "package-lock.json",
        "vitest.config.ts",
        "scripts",
        "tests",
        "src/orchestrator",
        "src/plugins/sandbox",
        "src-tauri/capabilities",
    ]
    .iter()
    .all(|root| {
        comparable != *root
            && !comparable.starts_with(&format!("{root}/"))
            && !root.starts_with(&format!("{comparable}/"))
    })
}

fn is_safe_find_value(predicate: &str, value: &str) -> bool {
    if value.is_empty() || value.starts_with('-') || value.chars().any(|c| c.is_ascii_control()) {
        return false;
    }
    match predicate {
        "-maxdepth" | "-mindepth" => value.chars().all(|c| c.is_ascii_digit()),
        "-type" => matches!(value, "b" | "c" | "d" | "f" | "l" | "p" | "s"),
        _ => true,
    }
}

fn parse_find_primary(predicates: &[String], start: usize) -> Option<usize> {
    let mut index = start;
    let mut unary_depth = 0;
    while matches!(
        predicates.get(index).map(String::as_str),
        Some("-not" | "!")
    ) {
        unary_depth += 1;
        if unary_depth > 128 {
            return None;
        }
        index += 1;
    }
    let predicate = predicates.get(index)?.as_str();
    if matches!(
        predicate,
        "-mount" | "-xdev" | "-prune" | "-print" | "-print0" | "-ls" | "-quit"
    ) {
        return Some(index + 1);
    }
    if matches!(
        predicate,
        "-name"
            | "-iname"
            | "-path"
            | "-ipath"
            | "-type"
            | "-maxdepth"
            | "-mindepth"
            | "-printf"
            | "-regex"
            | "-iregex"
    ) && predicates
        .get(index + 1)
        .is_some_and(|value| is_safe_find_value(predicate, value))
    {
        return Some(index + 2);
    }
    None
}

fn are_find_predicates_safe(predicates: &[String]) -> bool {
    let mut index = match parse_find_primary(predicates, 0) {
        Some(index) => index,
        None => return false,
    };
    while index < predicates.len() {
        if matches!(predicates[index].as_str(), "-o" | "-or" | "-a" | "-and") {
            index = match parse_find_primary(predicates, index + 1) {
                Some(index) => index,
                None => return false,
            };
            continue;
        }
        index = match parse_find_primary(predicates, index) {
            Some(index) => index,
            None => return false,
        };
    }
    true
}

fn is_safe_read_operand(command: &str, path: &str) -> bool {
    safe_path(path) && !(command == "tail" && path.starts_with('+'))
}

fn is_safe_script_path(script: &str) -> bool {
    script
        .strip_prefix("scripts/")
        .map(|relative| safe_path(&format!("src/{relative}")))
        .unwrap_or(false)
}

fn is_safe_typecheck(command: &[String]) -> bool {
    (command.len() == 2 && command[0] == "tsc" && matches!(command[1].as_str(), "--noEmit" | "-b"))
        || (command.len() == 3
            && command[0] == "node"
            && command[1] == "--check"
            && is_safe_script_path(&command[2]))
}

pub(crate) fn command_is_supported(command: &[String]) -> bool {
    if is_safe_typecheck(command) {
        return true;
    }
    if matches!(
        command.first().map(String::as_str),
        Some("ls" | "cat" | "head" | "tail")
    ) {
        return command.len() > 1
            && command[1..]
                .iter()
                .all(|path| is_safe_read_operand(command[0].as_str(), path));
    }
    if command.len() == 5
        && command[0] == "git"
        && command[1] == "diff"
        && command[2] == "--name-only"
        && command[4] == "--"
    {
        return safe_revision(&command[3]);
    }
    if command.len() >= 5 && command[0] == "git" && command[1] == "diff" {
        return command[3] == "--"
            && safe_revision(&command[2])
            && command[4..].iter().all(|path| safe_path(path));
    }
    if command.first().map(String::as_str) == Some("grep") {
        let mut index = 1;
        let mut pattern: Option<&str> = None;
        while index < command.len() {
            let argument = &command[index];
            if argument == "--" {
                pattern = command.get(index + 1).map(String::as_str);
                index += 2;
                break;
            }
            if matches!(argument.as_str(), "-e" | "--regexp") {
                let Some(value) = command.get(index + 1) else {
                    return false;
                };
                if value.is_empty()
                    || value.starts_with('-')
                    || value.chars().any(|c| c.is_ascii_control())
                {
                    return false;
                }
                pattern = Some(value);
                index += 2;
                break;
            }
            if argument.starts_with('-') {
                if !matches!(
                    argument.as_str(),
                    "-n" | "--line-number"
                        | "-i"
                        | "--ignore-case"
                        | "-F"
                        | "--fixed-strings"
                        | "-v"
                        | "--invert-match"
                ) {
                    return false;
                }
                index += 1;
            } else {
                pattern = Some(argument);
                index += 1;
                break;
            }
        }
        return pattern.is_some_and(|value| {
            !value.is_empty() && !value.chars().any(|c| c.is_ascii_control())
        }) && index < command.len()
            && command[index..].iter().all(|path| safe_path(path));
    }
    if command.first().map(String::as_str) == Some("find") {
        let forbidden = [
            "-L",
            "-H",
            "-follow",
            "-files0-from",
            "--files0-from",
            "-delete",
            "-exec",
            "-execdir",
            "-ok",
            "-okdir",
            "-fls",
            "-fprint",
            "-fprint0",
        ];
        if command.iter().any(|argument| {
            forbidden
                .iter()
                .any(|option| argument == option || argument.starts_with(&format!("{option}=")))
        }) {
            return false;
        }
        let mut index = 1;
        if command.get(index).map(String::as_str) == Some("-P") {
            index += 1;
        }
        let root_start = index;
        while index < command.len() && !command[index].starts_with('-') && command[index] != "!" {
            index += 1;
        }
        if index == root_start
            || !command[root_start..index]
                .iter()
                .all(|root| safe_path(root))
        {
            return false;
        }
        return are_find_predicates_safe(&command[index..]);
    }
    if command.first().map(String::as_str) == Some("tsx") {
        let Some(script) = command.get(1) else {
            return false;
        };
        return is_safe_script_path(script)
            && command[2..].iter().all(|arg| arg == "--reporter=dot");
    }
    false
}

pub(crate) fn command_intent_kind(command: &[String]) -> Option<&'static str> {
    if !command_is_supported(command) {
        return None;
    }
    if is_safe_typecheck(command)
        || matches!(
            command.first().map(String::as_str),
            Some("ls" | "cat" | "head" | "tail")
        )
    {
        return if is_safe_typecheck(command) {
            Some("typecheck")
        } else {
            Some("read-files")
        };
    }
    if command.len() == 5
        && command[0] == "git"
        && command[2] == "--name-only"
        && command[4] == "--"
    {
        return Some("git-names-only");
    }
    if command.first().map(String::as_str) == Some("git") {
        return Some("git-diff-scoped");
    }
    if command.first().map(String::as_str) == Some("grep") {
        return Some("grep-files");
    }
    if command.first().map(String::as_str) == Some("find") {
        return Some("find");
    }
    if command.first().map(String::as_str) == Some("tsx") {
        return Some("tsx-script");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_acceptance_matches_shared_policy_vectors() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/dev/command-policy-vectors.json"
        ));
        let vectors: Vec<PolicyVector> =
            serde_json::from_str(raw).expect("valid command policy vectors");
        for vector in vectors {
            assert_eq!(
                command_is_supported(&vector.command),
                vector.accepted,
                "{}",
                vector.name
            );
            assert_eq!(
                command_intent_kind(&vector.command),
                vector.intent_kind.as_deref(),
                "intent: {}",
                vector.name
            );
        }
    }

    #[test]
    fn rejects_excessive_find_unary_depth_without_recursion() {
        let mut command = vec!["find".to_string(), "src/components".to_string()];
        command.extend(std::iter::repeat_n("!".to_string(), 129));
        command.extend(["-name".to_string(), "*.tsx".to_string()]);
        assert!(!command_is_supported(&command));
    }
}
