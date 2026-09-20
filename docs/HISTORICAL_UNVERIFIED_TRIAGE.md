# Historical Unverified Triage

> Status: evidence dossier, not a security approval.
>
> Scope: historical entries `7.196–7.240` in `docs/DEVELOPMENT_LOG.md`, reconciled against exact current HEAD `4c5f0ccefad9981eb82734af1958d16e3c2f5e9c`, current source, checkpoint tags, and the independent read-only triage results.
>
> The classifications below describe the state of the historical debt. A verified tag is evidence for its exact bounded snapshot only; it is not approval of the current tree, the full native host, or the complete Worker lifecycle.

## Classification rules

- **superseded** — the historical snapshot was replaced by a later bounded repair or verified structural successor. The old snapshot is not reused as current-head evidence.
- **evidence-missing** — the intended change may exist, but the exact snapshot lacks the required independent verdict or required acceptance evidence.
- **concrete-risk** — current code or the historical exact snapshot still exposes a security/logic failure or an unresolved authority boundary.
- **environment-blocked** — no current logic failure is established for the bounded slice, but Unix/macOS, GUI/native, restart, or other required environment evidence is absent.

## Current status index

| Area / entries | Current classification | Evidence boundary | Remaining concern |
|---|---|---|---|
| Credentials/storage `7.196–7.197` | superseded | Exact older storage review passed; later namespace and endpoint/vault splits changed the snapshot. | Cross-platform keyring/AppData evidence is still absent. |
| Session/cwd `7.198` | evidence-missing | Later namespace movement is not a semantic review of the original extraction. | No exact independent closure for the original session seam. |
| Worktree admission/lifecycle/file `7.199–7.201` | evidence-missing | Later authority regrouping changed the reviewed snapshot. | No exact closure for the original extraction; Unix/macOS adversarial matrix is absent. |
| Native namespace `7.202–7.203` | superseded | `3d14acd` had a bounded passed review and verified tag. | Later native changes and non-Windows/GUI scope remain outside it. |
| Orphan lineage `7.204–7.206` | superseded successor, concrete historical risk | `ff1261d` passed the all-record duplicate-lineage review. | The older `4a85825`/`97dedb4` snapshots were not safe; this does not close restore/CAS/TOCTOU residuals. |
| Cleanup identity `7.207–7.209` | environment-blocked successor | `b855766` passed the identity short-circuit review. | Unix/macOS, GUI/E2E, durable cleanup recovery and post-remove proof are missing. |
| Storage endpoint/vault `7.210–7.211` | environment-blocked | Exact Windows snapshot passed. | Unix/macOS native and GUI/E2E evidence is missing. |
| Execution/dev_exec `7.212–7.213` | environment-blocked | Exact Windows snapshot passed. | Unix/macOS native, GUI/E2E and legacy worktree residuals remain open. |
| Worker terminal provenance `7.214` | concrete-risk | Current queue still accepts caller-supplied success provenance in generic paths; host receipt is not mandatory at every admission. | Legacy executor admission and enqueue ProjectControl binding remain open. |
| Worker invariant closure `7.215–7.219` | evidence-missing | Current source contains many guards and later frontend wiring, but no exact verified Worker-terminal tag covers the chain. | Cross-attempt, runtime/persistence fencing and current-head production wiring require a new bounded review. |
| Restore/audit/reconciliation `7.220` | concrete-risk | Current source still permits caller-supplied save guard and has reconciliation/save ordering concerns. | Stale ProjectFile overwrite and runtime generation fencing remain open. |
| Frontend lifecycle/recovery slices `7.221–7.232` | superseded by bounded verified tags | `96e81c7`, `fd74927`, `4edcf83`, `5f894dc`, and `5b8efe4` each have exact passed reviews. | Tags are bounded; workflowStore/WorkflowEditor debt and Worker authority residuals remain. |
| Executor sandbox `7.234–7.235` | superseded by verified tag | `5d03e17` exact review passed. | Executor-wide and native GUI evidence remain outside scope. |
| Executor LLM adapter `7.236` | evidence-missing as standalone extraction | The later `c6e3636` review passed the capability repair, not a separately recorded original-extraction closure. | Keep the standalone structural claim bounded; capability bypass itself is repaired. |
| Executor capability repair `7.237–7.238` | superseded by verified tag | `c6e3636` exact review passed. | No approval for Worker/native/runtime residuals. |
| Executor context adapter `7.239–7.240` | superseded by verified tag | `f398274` exact review passed. | workflowStore/WorkflowEditor and full GUI/native scope remain open. |

## Concrete native risks still open

These are not merely missing reviewer labels; current source and the historical record identify specific residuals:

1. **Fresh-session worktree restore identity** — native session initialization clears process-local registrations, while restore requires a trusted registration; persisted path/branch facts cannot safely rebind a replacement worktree.
2. **Partial-CAS cleanup recovery** — branch CAS/delete can succeed before worktree removal fails, while the caller retains the old branch revision; retry/recovery can lose the lineage needed for a safe read-back.
3. **Post-remove strict read-back** — successful `git worktree remove` is not followed by strict target absence and Git worktree-list absence checks before state is cleared.
4. **Pending probe unknown** — malformed or failed worktree probes become an in-memory `unknownEffects` status without a durable native recovery record that survives restart.
5. **Windows pathname TOCTOU** — cwd/file canonicalization and later process spawn still use pathname-based checks/use; no handle-bound/no-follow proof closes the race.
6. **Protected metadata roots** — direct native `find`/read and file-authority paths do not consistently enforce `.git` and `.slimemold` exact/descendant/ancestor protection.
7. **Generic find parity** — Node/Rust parsers exist, but the native runtime branch uses a separate permissive lexical gate; malformed predicate arity can diverge across hosts.
8. **Launcher authority/parity** — Rust, Node, and Antigravity have separate ComSpec/PATHEXT and shim resolution behavior, with environment-controlled inputs and no single current-head trusted contract.
9. **Legacy `run_git`** — the read-only IPC path remains a separate Git diff surface rather than using the shared hardened Git invocation and policy.

These risks remain `concrete-risk` until independently repaired and reviewed. A Windows-only passed structural tag does not change that classification.

## Worker and persistence residuals still open

- A generic queue caller can still supply non-empty Evidence/Acceptance IDs without a mandatory durable host receipt binding at every terminalization path.
- The repaired Worker success/recovery/projection/event append validators have no final exact-head verified verdict covering the complete production assembly.
- Legacy executor admission and Worker enqueue admission are not yet proven to require durable Worker/ProjectControl authorization, current session generation, approved TaskGraph link, and version.
- Cross-attempt Evidence/Acceptance binding and runtime project/generation fencing remain residuals.
- `workflowStore` save/audit paths still require a separate review of caller-supplied save guards and stale multi-run write-back behavior; the Save/Save As dirty baseline bug is repaired and independently reviewed, but that is a narrower concern.

## Real Tauri E2E evidence and boundary

Disposable fixtures were created outside the repository and retained for inspection:

- `D:/Temp/slimemold-tauri-e2e-20260920T005525Z`
- `D:/Temp/slimemold-tauri-e2e-20260920T005525Z-failure-clean`

Observed with a real Tauri window and native directory chooser:

- Success: project opened, the offline simulated Worker workflow ran, GUI showed completed nodes, ProjectFile save wrote a successful run, close/re-open restored the run history panel, and ProjectFile read-back contained the run history and node outputs.
- Failure: a clean fixture with simulation disabled produced a visible error run; event stream and checkpoint read-back contained the error lineage before ProjectFile save; after save, ProjectFile read-back contained the error run.
- Repair: the first E2E pass exposed a dirty marker that remained after a successful write. The stable snapshot fix was applied to both Save and Save As, regression-tested, independently reviewed, and rechecked in a real Tauri window; after the asynchronous save settled, the `*` marker disappeared.
- Lifecycle: Tauri/Vite child processes were explicitly stopped and port `1420` was read back as free. Fixtures were not automatically cleaned.

This is **not** complete WorkerQueue E2E evidence. The offline workflow fixture did not exercise a real durable WorkerQueue task with host Evidence, Acceptance, side-effect receipt, CleanupReceipt, or a real Git worktree mutation. Therefore the following remain `evidence-missing`/`concrete-risk`, not verified by this run:

- WorkerQueue restart/recovery from a stopped `TaskStarted` event;
- Evidence/Acceptance/Receipt lineage across a real attempt;
- native worktree creation, CAS cleanup, branch read-back, and post-remove absence;
- real provider/Codex execution and host acceptance;
- Unix/macOS native matrix.

## What is superseded versus what must be reopened

### Do not reopen without a new failure

The following bounded structural slices have passed exact reviews and should not be expanded merely because adjacent debt exists:

- ProjectControl lifecycle ownership and App lifecycle warning behavior;
- Worker recovery facts, recovery I/O, recovery action, and cleanup action controllers;
- executor sandbox adapter;
- executor capability fencing repair;
- executor context adapter;
- Save and Save As stable dirty snapshots.

### Reopen only as a new bounded slice

1. Worker terminal admission and durable receipt requirement.
2. Worker enqueue ProjectControl/session/TaskGraph admission.
3. Cross-attempt Evidence/Acceptance and runtime/persistence fencing.
4. Worktree partial-CAS durable recovery and strict post-remove read-back.
5. Generic protected metadata paths and find grammar parity.
6. Windows launcher authority and legacy `run_git` policy.
7. Unix/macOS native compilation and behavioral matrix.
8. A real WorkerQueue Tauri fixture capable of producing durable Evidence/Acceptance/Receipt/Cleanup facts.

## Evidence rule

This dossier is a current classification of historical records, not a blanket approval. Any future code or evidence change invalidates an exact reviewer verdict outside its snapshot. A claim may be upgraded only by a new RED/GREEN regression, full quality gate, exact-head independent review, and—where applicable—real Tauri/native read-back.
