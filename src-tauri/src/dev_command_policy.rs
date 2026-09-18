use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct PolicyVector {
    command: Vec<String>,
    accepted: bool,
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
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.starts_with('\\')
        || normalized.contains(':')
        || normalized.split('/').any(|part| part == "..")
        || normalized.contains('*')
        || normalized.contains('?')
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
    .all(|root| normalized != *root && !normalized.starts_with(&format!("{root}/")))
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
        let mut pattern = false;
        while index < command.len() {
            let argument = &command[index];
            if argument == "--" {
                pattern = command.get(index + 1).is_some();
                index += 2;
                break;
            }
            if matches!(argument.as_str(), "-e" | "--regexp") {
                if command
                    .get(index + 1)
                    .is_none_or(|value| value.starts_with('-'))
                {
                    return false;
                }
                pattern = true;
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
                pattern = true;
                index += 1;
                break;
            }
        }
        return pattern
            && index < command.len()
            && command[index..].iter().all(|path| safe_path(path));
    }
    if command.first().map(String::as_str) == Some("find") {
        if command.iter().any(|argument| {
            ["-L", "-H", "-follow", "-files0-from", "--files0-from"]
                .iter()
                .any(|option| argument == option || argument.starts_with(&format!("{option}=")))
        }) {
            return false;
        }
        let mut index = 1;
        if command.get(index).map(String::as_str) == Some("-P") {
            index += 1;
        }
        return index < command.len()
            && !command[index].starts_with('-')
            && safe_path(&command[index]);
    }
    if command.first().map(String::as_str) == Some("tsx") {
        let Some(script) = command.get(1) else {
            return false;
        };
        return script.starts_with("scripts/")
            && !script.contains("..")
            && command[2..].iter().all(|arg| {
                !arg.contains("..")
                    && !arg
                        .chars()
                        .any(|c| matches!(c, '&' | ';' | '|' | '`' | '<' | '>'))
            });
    }
    false
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
        }
    }
}
