use crate::dev_process::DEV_OUTPUT_CAP;
use crate::worktree_policy::is_full_object_id;

pub(crate) fn validate_git_worktree_porcelain(output: &str) -> Result<(), String> {
    if output.is_empty() || output.len() >= DEV_OUTPUT_CAP {
        return Err("Git worktree list 输出为空或可能被截断".into());
    }
    let mut block_count = 0usize;
    for block in output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
    {
        let mut has_worktree = false;
        let mut has_head = false;
        for line in block.lines().map(str::trim_end) {
            if let Some(path) = line.strip_prefix("worktree ") {
                if path.trim().is_empty() || has_worktree {
                    return Err("Git worktree list porcelain 结构无效".into());
                }
                has_worktree = true;
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                if !is_full_object_id(head.trim()) || has_head {
                    return Err("Git worktree list HEAD 无效".into());
                }
                has_head = true;
            } else if line.starts_with("branch refs/heads/")
                || line == "detached"
                || line == "bare"
                || line.starts_with("locked")
                || line.starts_with("prunable")
            {
                continue;
            } else {
                return Err("Git worktree list porcelain 含未知字段".into());
            }
        }
        if !has_worktree || !has_head {
            return Err("Git worktree list porcelain 缺少 worktree/HEAD 字段".into());
        }
        block_count += 1;
    }
    if block_count == 0 {
        return Err("Git worktree list porcelain 没有有效 block".into());
    }
    Ok(())
}
