# SlimeMold MVP Security Hardening Phase 2 Plan

> **For Hermes:** Implement task-by-task with strict TDD, a local checkpoint after each verified vertical slice, and an independent reviewer against the final staged snapshot. Do not push.

**Goal:** Freeze the current 23-file hardening snapshot as an unverified baseline, then redesign the session, side-effect, cleanup, and host-boundary protocols so the first MVP can be safely re-reviewed before Delivery/Cleanup and failure-recovery E2E.

**Current baseline:**
- Branch: `research/experimental-refactor`
- HEAD: `7e4de57 chore: checkpoint tauri e2e runner progress`
- Current staged snapshot: 23 related files; no new commit after `7e4de57`
- Latest quality gates: 109 test files / 923 tests, build passed, 991 i18n keys, Rust fmt passed, 40 Rust tests passed, `git diff --check` passed
- Latest independent review: `passed=false`; current snapshot is not `[verified]`
- Existing real GUI success fixture/worktree remains preserved and must not be cleaned without user approval
- Unrelated untracked design assets, `.hermes/`, `IDEA.md`, and credentials remain outside the commit scope

**Architecture:** Treat project/session transitions and external side effects as durable, fenced state machines rather than independent IPC calls. Node and Rust must share one worker-root/branch/command policy, while cleanup and recovery must be re-playable from durable lineage instead of in-memory manager state.

---

## Task 1: Freeze and inventory the unverified baseline

**Objective:** Preserve the current staged snapshot as a named review baseline without claiming approval or committing it.

**Files:**
- Inspect only: current staged diff and `docs/DEVELOPMENT_LOG.md`
- Create: this plan under `.hermes/plans/`

**Steps:**
1. Keep the 23-file staged snapshot unchanged.
2. Record the current reviewer JSON and its `security_concerns` / `logic_errors` as baseline evidence.
3. Do not run Delivery, Cleanup, restart cleanup, or failure-fixture switching.
4. Do not commit the current snapshot as `[verified]`.

**Exit condition:** Baseline scope and residual list are written down; no production files changed.

---

## Task 2: Design a single-flight session transition protocol

**Objective:** Ensure an old GUI/session caller cannot continue create, register, rollback, file I/O, cleanup, or Codex spawn after a project transition.

**Likely files:**
- `src/dev/gui.ts`
- `src/dev/session.ts`
- `src/dev/tauri-run.ts`
- `src-tauri/src/lib.rs`
- `src-tauri/src/codex.rs`
- Related tests under `src/dev/` and `src-tauri/src/lib.rs`

**RED tests first:**
- Concurrent `ensureGuiDevSession` calls are single-flight.
- `teardownGuiDevSession` invalidates old callers before clearing or starting a new session.
- `create → add → register` interrupted between awaits cannot register into a new session.
- Stale file I/O and stale Codex spawn are rejected after session transition.
- Generation overflow or JavaScript precision loss fails closed; prefer an opaque string token or checked non-wrapping generation.

**Implementation requirements:**
- One explicit session transition state machine: `idle → initializing → active → clearing → idle`.
- Caller token must be issued by host init, retained by the DevSession, and required by every host mutation/read command.
- No old caller may begin a new host action once invalidation starts.
- Host command errors must remain observable; no fallback to current generation.

**GREEN verification:** targeted race tests, full TS tests, Rust tests, and a fresh Tauri startup.

---

## Task 3: Introduce an atomic side-effect claim/state machine

**Objective:** Make worktree add/register/cleanup/cancel/retry one durable, replayable operation rather than separate best-effort calls.

**Likely files:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/codex.rs`
- `src/dev/session.ts`
- `src/dev/worktree.ts`
- `src/dev/workerAllocator.ts`
- `src/domain/` side-effect journal models

**RED tests first:**
- Cancel racing with pending claim cannot observe `neither` and then allow spawn.
- A claim is bound to `operationId + execution/attempt + generation + target + branch`.
- A second session cannot consume or delete the first session's claim.
- Add records the base revision/ref OID needed to prove exact provenance.
- Branch recreation under the same name cannot be deleted by an old retry.

**Implementation requirements:**
- Persist the add/registration claim before or atomically with the external side effect.
- Store base revision/ref OID and exact target/branch provenance.
- Use one atomic state machine for `pending`, `started`, `unknown`, `completed`, `failed`, and `needs-user`.
- Retry must create a new attempt/claim; it must never reuse a string-matching branch as proof of identity.
- Reconcile incomplete claims on restart.

---

## Task 4: Make cleanup and unregister approval-safe and retryable

**Objective:** Prevent manager/Rust state divergence when cleanup or unregister fails.

**Likely files:**
- `src/dev/worktree.ts`
- `src/dev/session.ts`
- `src-tauri/src/lib.rs`
- `src/projectControl/` cleanup/receipt code

**RED tests first:**
- Worktree remove success + branch delete failure remains `orphaned` and retryable.
- Branch-only retry success does not call unregister unless Rust has a matching registered record.
- Unregister failure leaves manager status and approval state retryable rather than `cleaned`.
- Restart restores branch-only orphans from durable lineage.
- Direct Tauri unregister cannot bypass user approval/cleanup receipt semantics.

**Implementation requirements:**
- Do not mark manager `cleaned` until unregister/receipt finalization succeeds, or persist a terminal-but-retryable reconciliation state.
- Persist orphan records independently of in-memory `WorktreeManager`.
- Bind cleanup to current execution/attempt and explicit user approval receipt.
- Rust unregister must require current session, registered object, non-pending state, and Git read-back proof.

---

## Task 5: Unify Node/Rust worker and command policy

**Objective:** Eliminate headless-success/GUI-failure divergence and command argument escapes.

**Likely files:**
- `src/dev/worktree.ts`
- `src/dev/capabilities.ts`
- `src/dev/workerAllocator.ts`
- `src/projectControl/workerRunCoordinator.ts`
- `src-tauri/src/lib.rs`

**RED matrix:**
- POSIX, Windows, mixed separators, trailing slash, UNC, verbatim paths.
- Parent `.` and `..`, sibling-root escape, symlink/junction root, target replacement.
- `.LOCK` case variants, basename length 200/201, illegal Git ref components.
- `grep`, `git diff`, `.cmd`, `.bat`, `tsx`, and option-like path arguments.
- Node/headless and Rust must return the same accept/reject result for every case.

**Implementation requirements:**
- Extract one normative Worker target/branch validator or generate a shared test matrix consumed by both implementations.
- Treat option-like path arguments as data; do not skip `-` values when they can carry paths.
- Use explicit ComSpec argument protocols for Windows shims and reject shell metacharacters.
- For add, use Windows handle/no-follow APIs and POSIX `openat/O_NOFOLLOW` or explicitly reject unsupported platforms.

---

## Task 6: Durable recovery and evidence reconciliation

**Objective:** Make restart recovery prove what happened instead of relying on process memory.

**Likely files:**
- `src/dev/session.ts`
- `src/dev/worktree.ts`
- `src/dev/evidence.ts`
- `src/dev/workerAcceptance.ts`
- `src/projectControl/` event/receipt models

**RED tests first:**
- Restart after add-before-register.
- Restart after worktree remove-before-branch-delete.
- Restart after branch delete-before-unregister.
- Evidence/Acceptance persistence failure after external side effect.
- Unknown side effect is not automatically retried.

**Acceptance:**
- Recovery reads durable event/side-effect/receipt state.
- Every recovered item retains project, execution, attempt, worktree, branch, and source evidence.
- Recovery can safely offer retry/skip/cleanup without wildcard matching.

---

## Task 7: Re-run the narrow MVP E2E matrix only after hardening approval

**Do not start this task before Tasks 2–6 pass review.**

1. Preserve existing success fixture/worktree.
2. Re-run success GUI path and read back Worktree, Evidence, Acceptance, files, and branch.
3. Obtain explicit user approval before Delivery.
4. Read back DeliveryReceipt and target project files.
5. Obtain explicit user approval before Cleanup.
6. Close/restart Tauri and read back fixture state.
7. Obtain explicit authorization before switching to failure fixture.
8. Run failure, unknown, retry, recovery, and branch-only orphan paths.

No `headless exit 0`, window presence, or model text may substitute for host read-back.

---

## Verification and commit policy

For every task:

```text
RED regression
→ GREEN implementation
→ targeted tests
→ npm run test
→ npm run build
→ npm run i18n:check
→ cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
→ cargo test --manifest-path src-tauri/Cargo.toml
→ git diff --check
→ sensitive scan
→ independent reviewer on the exact final staged snapshot
```

Commit rules:

- Create local checkpoint commits frequently after each verified vertical slice.
- Checkpoint commits are not approvals and may be explicitly marked `unverified`.
- Only a reviewer with empty `security_concerns` and `logic_errors` allows `[verified]`.
- Never push without explicit user instruction.
- Exclude `.hermes/`, design assets, raw logs, credentials, and unrelated untracked files.

**Current disposition:** Phase 2 已建立本地 unverified checkpoints `0bb69b3 chore: checkpoint phase2 cleanup convergence (unverified)`、`03140a3 chore: align worker target validation (unverified)`、`8c7e208 chore: make worker starts atomic (unverified)`、`f30585a chore: verify durable evidence readback (unverified)`、`88ceba5 chore: retain cancelled worktree lineage (unverified)`、`5241d8e chore: single-flight GUI session init (unverified)`、`7746a3c chore: fence orphan branch retries (unverified)`、`5b03c51 chore: reconcile duplicate evidence loads (unverified)`、`5a2a7c1 chore: bind side effects to worker path and branch (unverified)`、`cd893d1 chore: harden claim aliases and host locks (unverified)`、`70aa5b6 chore: track complete evidence verification (unverified)`、`265dee4 chore: converge registration cleanup and host policy (unverified)`、`dc27794 chore: make branch cleanup compare-and-delete (unverified)`、`4507e09 chore: fence legacy aliases and held locks (unverified)`、`ed505a1 chore: expose orphan confirmation cleanup (unverified)`、`34242cf chore: fence consistency hashes and registered paths (unverified)`、`dec93f0 chore: fence event store path boundaries (unverified)`、`ea47411 chore: fence worker recovery provenance (unverified)`、`<PENDING> chore: verify side-effect journal read-back (unverified)`、`4d60763 chore: route orphan cleanup retries through approval (unverified)`、`c661ca3 chore: close side-effect lock ordering gaps (unverified)`、`<PENDING-GUI> chore: close cleanup cancellation race (unverified)`、`bced6cc chore: align grep external input policy (unverified)`、`5826c2c chore: harden worker provenance and evidence gates (unverified)`、`e4677d9 chore: persist cleanup provenance and restart identity (unverified)`；Node/Rust OS-level no-follow/TOCTOU与Evidence/Acceptance跨进程边界仍未全部闭合。所有 checkpoint未 push、未标记 `[verified]`；用户批准仍是 Delivery/Cleanup/restart/failure fixture 的前置条件。
