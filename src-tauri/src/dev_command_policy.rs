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

fn safe_revision(value: &str) -> bool {
    if value == "HEAD"
        || (matches!(value.len(), 40 | 64) && value.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return true;
    }
    if value.starts_with("refs/heads/") || value.starts_with("refs/tags/") {
        return !value.contains("..")
            && !value.contains("//")
            && !value.ends_with('/')
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
    }
    if ["feature/", "bugfix/", "hotfix/", "release/", "worker/"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        let leaf = value.rsplit('/').next().unwrap_or_default();
        return !value.contains("..")
            && !value.contains("//")
            && !leaf.is_empty()
            && !leaf.contains('.')
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
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

fn safe_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    let comparable = normalized.to_ascii_lowercase();
    let components: Vec<&str> = normalized.split('/').collect();
    if normalized.is_empty()
        || !normalized.is_ascii()
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
    .all(|root| comparable != *root && !comparable.starts_with(&format!("{root}/")))
}

pub(crate) fn command_is_supported(command: &[String]) -> bool {
    if command.len() == 4
        && command[0] == "git"
        && command[1] == "diff"
        && command[2] == "--name-only"
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
                if value.is_empty() || value.starts_with('-') {
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
        return pattern.is_some_and(|value| !value.is_empty())
            && index < command.len()
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
        let safe_predicates = [
            "-name",
            "-iname",
            "-path",
            "-ipath",
            "-type",
            "-maxdepth",
            "-mindepth",
            "-mount",
            "-xdev",
            "-prune",
            "-print",
            "-print0",
            "-ls",
            "-printf",
            "-regex",
            "-iregex",
            "-not",
            "!",
            "-o",
            "-or",
            "-a",
            "-and",
            "-quit",
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
        while index < command.len() && !command[index].starts_with('-') {
            index += 1;
        }
        if index == root_start
            || !command[root_start..index]
                .iter()
                .all(|root| safe_path(root))
        {
            return false;
        }
        return command[index..].iter().all(|argument| {
            !argument.starts_with('-') || safe_predicates.contains(&argument.as_str())
        });
    }
    if command.first().map(String::as_str) == Some("tsx") {
        let Some(script) = command.get(1) else {
            return false;
        };
        let script_path = script
            .strip_prefix("scripts/")
            .map(|relative| format!("src/{relative}"));
        let Some(script_path) = script_path else {
            return false;
        };
        return safe_path(&script_path)
            && command[2..].iter().all(|arg| {
                !arg.contains("..")
                    && !arg.starts_with('/')
                    && !arg.starts_with('\\')
                    && !arg.contains(':')
                    && (!arg.starts_with('-') || arg == "--reporter=dot")
                    && !arg
                        .chars()
                        .any(|c| matches!(c, '&' | ';' | '|' | '`' | '<' | '>'))
            });
    }
    false
}

pub(crate) fn command_intent_kind(command: &[String]) -> Option<&'static str> {
    if !command_is_supported(command) {
        return None;
    }
    if command.len() == 4 && command[0] == "git" && command[2] == "--name-only" {
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
}
