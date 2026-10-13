# Historical Unverified Triage

> Status: evidence dossier, not a security approval.
>
> Scope: historical entries `7.196–7.256` in `docs/DEVELOPMENT_LOG.md`, reconciled against exact current HEAD `0f13dd12eecfac53ffa4b76ac6d6027b792e5f3b`, current source, checkpoint tags, and the independent read-only triage results.
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
| Cleanup identity `7.207–7.209` | environment-blocked successor | `b855766` passed the identity short-circuit review. | Unix/macOS and full native GUI/E2E evidence remain absent; durable partial-CAS/pending-probe risks remain. |
| Storage endpoint/vault `7.210–7.211` | environment-blocked | Exact Windows snapshot passed. | Unix/macOS native and GUI/E2E evidence is missing. |
| Execution/dev_exec `7.212–7.213` | environment-blocked | Exact Windows snapshot passed. | Unix/macOS native, GUI/E2E and launcher/TOCTOU residuals remain open. |
| Worker terminal provenance `7.214` | concrete-risk | Current queue still accepts caller-supplied success provenance in generic paths; host receipt is not mandatory at every admission. | Legacy executor admission and enqueue ProjectControl binding remain open. |
| Worker invariant closure `7.215–7.219` | evidence-missing | Current source contains many guards and later frontend wiring, but no exact verified Worker-terminal tag covers the chain. | Cross-attempt, runtime/persistence fencing and current-head production wiring require a new bounded review. |
| Restore/audit/reconciliation `7.220` | concrete-risk | Current source still permits caller-supplied save guard and has reconciliation/save ordering concerns. | Stale ProjectFile overwrite and runtime generation fencing remain open. |
| Frontend lifecycle/recovery slices `7.221–7.232` | superseded by bounded verified tags | `96e81c7`, `fd74927`, `4edcf83`, `5f894dc`, and `5b8efe4` each have exact passed reviews. | Tags are bounded; workflowStore/WorkflowEditor debt and Worker authority residuals remain. |
| Executor sandbox `7.234–7.235` | superseded by verified tag | `5d03e17` exact review passed. | Executor-wide and native GUI evidence remain outside scope. |
| Executor LLM adapter `7.236` | evidence-missing as standalone extraction | The later `c6e3636` review passed the capability repair, not a separately recorded original-extraction closure. | Keep the standalone structural claim bounded; capability bypass itself is repaired. |
| Executor capability repair `7.237–7.238` | superseded by verified tag | `c6e3636` exact review passed. | No approval for Worker/native/runtime residuals. |
| Executor context adapter `7.239–7.240` | superseded by verified tag | `f398274` exact review passed. | workflowStore/WorkflowEditor and full GUI/native scope remain open. |
| Tauri E2E/dirty baseline `7.241–7.244` | partial evidence / superseded repair | Real GUI success/failure/save/reopen evidence exists; Save/Save As repair passed exact review at `f06a457`. | Offline fixture did not exercise durable WorkerQueue Evidence/Acceptance/Receipt/Cleanup/Git mutation. |
| Historical triage `7.245` | evidence artifact | `HISTORICAL_UNVERIFIED_TRIAGE.md` records current classifications. | It is not a security approval or current full-tree reviewer verdict. |
| Protected metadata aliases `7.246–7.248` | bounded verified, cross-platform blocked | `7c30dec` exact review passed real `.git`/`.slimemold` alias mutation probes. | Linux/macOS matrix is unavailable; broader native path/TOCTOU risks remain. |
| Native find parity `7.249–7.250` | bounded verified, cross-platform blocked | `7eb98ac` exact review passed runtime/parser parity vectors. | Unix/macOS and broader spawn/path identity evidence remain absent. |
| Legacy `run_git` `7.251–7.252` | bounded verified, cross-platform blocked | `44ae249` exact review passed hardened diff argv wiring. | Hostile-config integration and Unix/macOS evidence remain follow-up scope. |
| Cleanup post-remove `7.253–7.255` | bounded verified, partial-CAS still open | `d994a49` exact review passed real listing-present/absent/prune fixture. | Durable partial-CAS and pending-probe recovery remain concrete risks. |

## Concrete native risks still open

These are not merely missing reviewer labels; current source and the historical record identify specific residuals:

1. **Fresh-session worktree restore identity** — native session initialization clears process-local registrations, while restore requires a trusted registration; persisted path/branch facts cannot safely rebind a replacement worktree.
2. **Partial-CAS cleanup recovery** — branch CAS/delete can succeed before worktree removal fails, while the caller retains the old branch revision; retry/recovery can lose the lineage needed for a safe read-back.
3. **Pending probe unknown** — malformed or failed worktree probes become an in-memory `unknownEffects` status without a durable native recovery record that survives restart.
4. **Windows pathname TOCTOU** — cwd/file canonicalization and later process spawn still use pathname-based checks/use; no handle-bound/no-follow proof closes the race.
5. **Launcher authority/parity** — Rust, Node, and Antigravity have separate ComSpec/PATHEXT and shim resolution behavior, with environment-controlled inputs and no single current-head trusted contract.
6. **Unix/macOS native matrix** — the bounded Windows slices now have exact reviews, but the required Unix/macOS sysroot, cfg, no-follow, identity and spawn evidence is unavailable.

Bounded closures already verified after the original dossier include protected metadata aliases (`7.248`), runtime find parity (`7.250`), legacy `run_git` invocation (`7.252`) and cleanup post-remove read-back (`7.255`). They do not close the residuals above.

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
4. Worktree partial-CAS durable recovery and pending-probe recovery.
5. Windows launcher authority and Unix/macOS native matrix.
6. A real WorkerQueue Tauri fixture capable of producing durable Evidence/Acceptance/Receipt/Cleanup facts.

## Partial-CAS design gate

Current read-only evidence confirms a concrete native gap: `dev_cleanup_worktree` can delete the branch ref, then fail during worktree removal or immediate post-CAS probing. The existing JS `unknown/needs-user` owner records uncertainty, but no durable native phase records `branch-cas-succeeded/worktree-remove-pending`; restart/orphan restore still expects the deleted branch revision and cannot converge.

The next repair must not be chosen implicitly:

- **Recommended boundary:** keep the current branch-CAS order, persist a host-owned phase containing project/session generation, path, target identity, branch, approved revision and phase, then expose a separate explicit inspect/finalize recovery path that never repeats branch CAS and revalidates identity/listing before removing or reconciling the remaining worktree.
- **Rejected without architectural review:** simply reorder worktree removal before branch CAS. That changes the mutation race and branch-lineage contract and needs a separate authority/security review.
- **Current status:** `concrete-risk`, the Terraform-level local-tool baseline is confirmed but implementation is intentionally deferred until the frontend monolith split is complete. The selected baseline is project-local durable state, four phases, explicit inspect/finalize, no repeated CAS, and restart rebind/read-back. GUI/Worker full E2E does not close this native gap.

Any future code or evidence change invalidates an exact reviewer verdict outside its snapshot. A claim may be upgraded only by a new RED/GREEN regression, full quality gate, exact-head independent review, and—where applicable—real Tauri/native read-back.

## Living graph batch1（2026-10-11/12）

### Scope and current boundary

- Read-only inventory covered 40 `batch1-*` tags and 10 first-batch/night-run `checkpoint/*-20261012` tags (50 refs, 34 unique targets), including the later docs-only triage checkpoint below. No historical tag was moved or deleted.
- The full code target is `31dc5794a76ef72601c2b00a76ea161b23759c05`; the independent full-range reviewer passed with `security_concerns=[]` and `logic_errors=[]`. This is not a verified successor: the required browser + real Tauri bilingual GUI read-back did not complete. `checkpoint/living-graph-batch1-unverified-20261012` is the only final batch-status tag; no `checkpoint/living-graph-batch1-verified-20261012` exists. Therefore **no historical tag is replaced by a verified tag** in this entry.

### superseded — later bounded code/document snapshot exists, but remains unverified

| Historical tags | Later unverified successor / reason | Verified successor |
|---|---|---|
| `batch1-slice0`, `batch1-slice1`, `batch1-slice1-review-recorded` | Later branch work updated the living-graph plan and ProjectControl command paths; the current full-range review covers the resulting descendant, not the old tag snapshot. | None |
| `batch1-slice2`, `batch1-slice2-golden-unverified`, `batch1-slice2-review-fix-unverified`, `batch1-slice2-review-recorded-unverified`, `batch1-slice2-sidecar-boundary-repair-start-unverified`, `batch1-slice2-sidecar-boundary-repair-unverified`, `batch1-fix1-unverified`, `batch1-fix1-list-repair-unverified`, `batch1-fix1-reviewed-unverified` | The shared prompt/sidecar contract was successively repaired, the multi-dependency formatting was corrected, and Fix 4 later moved attempt-varying ContextPack identity out of the shared contract. Later refs include `batch1-fix4-unverified` and current `checkpoint/living-graph-batch1-unverified-20261012`; all remain unverified. | None |
| `batch1-slice3-review-recorded-unverified`, `batch1-slice3-shadow-triage-unverified`, `batch1-slice3-start-unverified`, `batch1-slice3a-pure-rules-unverified`, `batch1-slice5-l0-eligibility-unverified`, `batch1-slice5-preflight-unverified`, `batch1-slice5-review-recorded-unverified`, `batch1-slice5-start-unverified`, `batch1-fix2-start-unverified`, `batch1-fix2-unverified`, `batch1-fix2-reviewed-unverified`, `batch1-fix3-start-unverified` | B0 triage and B1 preflight snapshots were changed by the later Fix 2/Fix 3 parser, scope, and rules-version repairs. Their implementation successors are unverified; Fix 3 remains in the current full-range reviewed target. | None |
| `batch1-slice4-review-recorded-unverified`, `batch1-slice4-start-unverified`, `batch1-slice4a-placeholder-check-unverified` | The start/review records were followed by later locale placeholder and namespace-isolation changes; the final current locale tree is in the full-range target. | None |
| `batch1-slice6-cost-model-unverified`, `batch1-slice6-eac-overflow-repair-start-unverified`, `batch1-slice6-start-unverified` | The initial cost-model snapshot was followed by the bounded EAC overflow repair `batch1-slice6-eac-overflow-fix-unverified`. | None |
| `batch1-review-fixes-start-unverified`, `batch1-closeout-start-unverified`, `checkpoint/fix4-start-20261012`, `checkpoint/fix4-unverified-20261012`, `checkpoint/night-run-verify-and-split-start-20261012`, `checkpoint/slice0-baseline-start-20261012`, `checkpoint/slice0-baseline-unverified-20261012`, `checkpoint/test-env-start-20261012` | These are retained start/baseline anchors, not approval artifacts; subsequent bounded slices produced later unverified snapshots. Start refs remain unchanged for auditability. | None |

### evidence-missing / environment-blocked — current implementation still lacks full acceptance evidence

| Tags | Missing evidence / remaining boundary | Verified successor |
|---|---|---|
| `batch1-slice4-i18n-unverified`, `batch1-slice4a-namespace-isolation-unverified`, `batch1-slice6-eac-overflow-fix-unverified`, `batch1-slice6-review-recorded-unverified` | These slice results remain represented in the current branch, but the complete batch has no verified GUI acceptance. The final reviewer’s cost-model-underflow and production L0 risk-input notes are non-blocking suggestions, not logic findings; they were not silently promoted to blockers. | None |
| `batch1-fix3-unverified`, `batch1-fix3-reviewed-unverified`, `batch1-fix4-unverified`, `batch1-fix4-reviewed-unverified`, `checkpoint/test-env-unverified-20261012` | Per-slice review/evidence exists for these exact snapshots, but it does not substitute for the required final bilingual GUI read-back on the full current target. | None |
| `checkpoint/batch1-final-verification-start-20261012`, `checkpoint/living-graph-batch1-unverified-20261012`, `checkpoint/batch1-triage-unverified-20261012` | The start tag is not an approval. The final unverified code tag points to `31dc579`; the docs-only triage tag points to `27fbc96` and records classification, not code acceptance. GUI acceptance remains evidence-missing, so there is deliberately no verified counterpart. | None |

Environment limits recorded for this classification: direct Linux Node 22 package acquisition ended in npm-registry `ETIMEDOUT` (Windows Node 22 and Linux Node 24 tests passed); browser screenshot capture after welcome-overlay dismissal was stale or timed out; the real Tauri app auto-restored an existing disposable Worker fixture with prior failure records, so the bilingual panel sequence stopped before any manual project mutation. The isolated browser DOM language read-back is partial evidence, not a substitute for the real-Tauri GUI gate.

### concrete-risk

- The final independent review reported no source-supported security or logic blocker in the full batch target. No first-batch tag is classified `concrete-risk` from that review.
- The Tauri fixture displayed pre-existing Worker cleanup/native-identity and worktree-restore warnings. They were observed without file-level read-back, are not attributed to this batch, and were not modified or cleaned. They remain an out-of-scope observation for the later phase2 audit, not evidence that this batch caused or repaired them.
- A browser-only ProjectSession navigation attempt automatically mounted `runMasterTurn` and showed `Failed to fetch`. There is no successful response evidence, and the read-only browser resource-origin list cannot prove that no outbound attempt occurred. No retry or Worker run followed; this is recorded in the night-run report as an execution-boundary deviation, not silently treated as a product verification failure or as a batch code finding.

## Phase2 拆分与收口回填（2026-10-12/13）

本节核对 2026-10-12/13 的 phase2 拆分、merged-run 与 closeout-run-r4 回填。历史 tag 一律不删除、不移动、不重命名；本节只修正账目。

### 新增的 verified 回填

| tag | target | 质量门 | 评审 | GUI |
|---|---|---|---|---|
| `checkpoint/test-hygiene-verified-20261013` | `cd4be6d4fc0f83f9fc4c278dada76fe7048179e5`（parent `0ac830fc2313a177d40018df5101d48abb9235b5`） | Windows Node 26.7.0 与 Node 22.23.2 各 3 次全量 232 files / 1,530 tests 通过；build、app tsc、i18n 1,112 keys、`git diff --check` 通过 | exact reviewer 只读 Git 对象（不 checkout/编辑/移动 refs），返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；一条非阻塞 suggestion 关于测试单独提交 | 非界面改动，按边界第 8 条不要求 |

与既有的 `checkpoint/test-hygiene-unverified-20261013` 成对指向同一 commit，保留两个 tag。WSL Node 24 全量运行在 scratch 安装后 420 秒超时、没有测试汇总；上一份任务书把该环境写为可选项，因此不构成本次回填的缺口，也不写成通过。

### 不补 verified，记为被取代或证据缺失

| 历史目标 | 处理 | 依据 |
|---|---|---|
| `0a66c2ff7eb3464e782a838aff43b7abddeb3608`（test-env：为 Worker 传 file-backed Web Storage 参数） | 不补 verified；记为被 `cd4be6d` 取代 | 同一批测试卫生问题（jsdom 存储隔离与超时）已在 `cd4be6d` 收敛并取得 exact 评审；`0a66c2f` 自身没有独立 reviewer verdict |
| `1be58a18f92dddea02502131129abe72ed0da710`（fix4：ContextPack identity 移入 runtime prompt） | 不补 verified；保持 evidence-missing | 该快照当时全量测试有 10 项失败，不满足「同一快照质量门全过」；后续提交覆盖了同一区域，但没有同快照的质量门与评审证据 |

### 更正：`checkpoint/readability-project-session-verified-20261013`

该 tag 保留作为审计事实，不删除也不移动。按本轮边界第 8 条，界面改动必须有**同一快照**的 GUI 回读才能打 verified；该 tag 只有质量门与 exact 评审、没有同快照 GUI 回读，因此不满足 verified 条件。最终以 closeout run r4 切片 5 的分支整体验证为准：若切片 5 通过，则在当次回填中把该条标为被整体 verified tag 取代；若切片 5 不通过，则该条与切片 5 同等保持未验证。

## R5 ledger correction: R4 verified-tag overclaims (2026-10-14)

R5 plan `.hermes/plans/2026-10-13_233500-r5-long-run.md` re-evaluates two R4 tags. Both tag refs remain untouched for auditability; this section corrects their evidence classification and defines which R4 snapshot may serve as a verified ancestor in R5.

| Tag retained | Target | Correction | Evidence / scope |
| --- | --- | --- | --- |
| `checkpoint/readability-execute-node-body-verified-20261013-r4` | `e66d89d13469cd189ff719544694bf375e02f14d` | **evidence-missing; not a valid verified ancestor** | The review `a583834..e66d89d` covered the Slice8 test/fix delta, not the full code ancestry: its target tree also contained the unreviewed Slice9 refactor and four unreviewed R4 add-ons. Optional isolated replay: archive exact `e66d89d` to `D:/Hermes/cache/scratch/r5-e66-lifecycle-probe-20261013`, overlay regression test blob `25b76f812d98ed62a45fa12334df22730ac86435` from `5ae675f`, and run the focused test. Both regressions failed as expected: immediate running state was `undefined`; `EventLogWriter.close` had 0 calls after injected session-init failure. |
| `checkpoint/readability-run-workflow-verified-20261013-r4` | `3700d0c0321baf40ed6936c93c0a0c9a02550414` | **evidence-missing; not a valid verified ancestor** | The original Slice9 range `d84cff1..cbc6f4a` had `passed=false` with two lifecycle findings. The repair review `8a31eb5..3700d0c` passed for its delta, but did not review every intervening code change since the last valid verified ancestor. The target tree still includes four R4 add-ons without complete exact-review coverage. |
| `checkpoint/readability-check-params-verified-20261013-r4` | `81d22c69bbda64584ecddb76a9486a323eeb77d7` | **valid for its exact bounded snapshot** | Same-snapshot gates and clean exact review are recorded in the R4 report/development log. |
| `checkpoint/readability-workflow-editor-verified-20261013-r4` | `39f54f45c7ac57ccee92728dff2b9a25738eb52e` | **valid for its exact bounded snapshot; nearest valid R4 verified ancestor** | Same-snapshot gates, Browser evidence and clean exact review are recorded in the R4 report/development log. |

No tag was deleted, moved, or renamed. The Slice8/Slice9 lifecycle repairs remain useful code changes, but their historical `verified` labels do not satisfy the R5 coverage rule. R5's most recent valid verified ancestor is `39f54f45c7ac57ccee92728dff2b9a25738eb52e`; Slice5/12 still require full-range review of every code change after that ancestor plus their own same-snapshot GUI/gate requirements before any R5 verified tag.
