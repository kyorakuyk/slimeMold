# Tauri Worker GUI restart re-check — 2026-10-07

**Result: restart/read-back observed; cleanup blocked; formal status remains `unverified / not accepted`.** This re-ran the real Tauri GUI against the preserved 2026-09-22 disposable fixture. No Worker task execution or cleanup was initiated in this re-check; the ProjectFile was read back after the GUI restart.

## Source and runtime

- Branch: `phase2/worker-recovery-cleanup-cas`.
- GUI launched from `6b614bda074f8f0756b412619e0b8ac71e7d9749`, a docs-only descendant of reviewed code commit `59bd5cb4ddf8207b8a191603ab88dfa0b0f23427`. `checkpoint/rust-windows-git-junction-verified-20261007` still targets the reviewed code commit.
- Started with `npm run tauri dev`. Observed Vite `v5.4.21` ready on `http://localhost:1420/`, Rust dev-profile build completion, `Running target\debug\slime-mold.exe`, and host log `grant_project_access ok` for the disposable fixture. Captured the actual native window `SlimeMold · Agent 工作流`.
- After the read-back, stopped the owned dev session. The wrapper, Tauri, Vite, and WebView PIDs were absent on read-back; port 1420 had no listener.
- Git displayed `M src-tauri/Cargo.toml`, but its worktree, index, and HEAD blob IDs were identical (`121bc638b507c3a84468f6ac589cf16b173f7dc4`). It was left untouched and was not staged.

## Fresh GUI and durable read-back

The GUI showed the completed `task-create-worker-marker` with four Evidence records and Acceptance `acc-muczsxg1-9bafef2d`. The recovery/cleanup area displayed: **“清理提案尚未生成，宿主状态需要复查”**.

Read-back from `D:/Temp/sm-tauri-acceptance-20260922-v2/.slimemold`:

- Project `project-tauri-worker-verify`; its persisted `updatedAt` is `2026-10-06T22:09:10.112Z`.
- Run `run-eec6094e-1e64-48f9-8505-ad0a9c2ffc5a` and task `task-create-worker-marker` are `succeeded`; attempt is 5, ID `task-execution:run-eec6094e-1e64-48f9-8505-ad0a9c2ffc5a:task-create-worker-marker:attempt-5`.
- Active assignment is worktree `worker-w-f0bef61bfede25d72feb5ab9`, branch `worker/w-f0bef61bfede25d72feb5ab9`, base `a02f6c0b8c84d09703c42f483594aa42be339570`; persisted `worktreeStatus=created`, `cleanupStatus=null`.
- Durable records: 47 events, 20 Host Evidence, 5 Acceptance records (1 passed, 4 failed), and 5 side effects, all `worker-execution`. There is no `TaskCleaned` event, cleanup side effect, or cleanup/receipt file in the fixture metadata tree.
- Git lists the fixture main worktree plus all five historical Worker worktrees below. Every Worker worktree still exists at base `a02f6c0b8c84d09703c42f483594aa42be339570`, has untracked `docs/`, and retains `docs/WORKER_E2E_OK.txt` (35 bytes; SHA-256 `bd38cada67cd0c8a1f09bba83ac0cc67a3f9367b6f7bc644d9abfdca92d48897`). The marker was read back as `SlimeMold Tauri Worker E2E passed.`

| Preserved worktree | Branch | Read-back |
|---|---|---|
| `w-f4befc67fade1f8b33eb6105` | `worker/w-f4befc67fade1f8b33eb6105` | present; `?? docs/` |
| `w-f5befdfafbde211e30eb5c4c` | `worker/w-f5befdfafbde211e30eb5c4c` | present; `?? docs/` |
| `w-f6beff8dfcde22b131eb5ddf` | `worker/w-f6beff8dfcde22b131eb5ddf` | present; `?? docs/` |
| `w-efbef488fdde24442eeb5926` | `worker/w-efbef488fdde24442eeb5926` | present; `?? docs/` |
| `w-f0bef61bfede25d72feb5ab9` | `worker/w-f0bef61bfede25d72feb5ab9` | present; `?? docs/` |

## Cleanup gate and evidence

No valid cleanup proposal was produced, and no user approval exists. Therefore no cleanup API was invoked, no worktree was removed, and the five historical Worker worktrees remain preserved. The restart state was visible and durably readable, but the requested restart-plus-cleanup acceptance is **blocked**, not passed.

The current checkout’s `7.375` section was also checked: 10 physical lines and zero lines with a leading `|`; the reported malformed formatting is not present in this checkout. No historical entry was edited.

Evidence bundle: `D:/Temp/sm-tauri-worker-restart-recheck-20261007/`.

- `restart-readback.json` — structured source, GUI, durable-store, worktree, and cleanup read-back.
- `restart-gui.png` — actual Tauri GUI capture, 505,839 bytes; SHA-256 `fe049753ca21c4fc5ab3ba3b9b1086d22bbc2a3cfaad3950e8373bba726ca267`.
- `restart-gui-accessibility.json` — captured accessibility tree, 18,806 bytes; SHA-256 `f44bdfa99238888603cc9cd9e40dbc1b89d8174d36fda28c995fc926256e453b`.

The full test/build gates and exact-HEAD code review remain those recorded in 7.380–7.381 for code commit `59bd5cb4ddf8207b8a191603ab88dfa0b0f23427`; this GUI re-check did not rerun the Node or Rust test suites. No push, merge, or worktree cleanup was performed.
