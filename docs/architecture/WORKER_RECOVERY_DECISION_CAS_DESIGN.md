---
title: Worker Recovery Decision CAS Design Gate
type: architecture-design
status: design-gate
updated: 2026-09-21
authority: design-proposal
---

# Worker Recovery Decision CAS Design Gate

> 本文是 Worker recovery durable decision CAS 的设计门，不是已实现能力，也不是跨文件原子事务的宣称。
> 在本文的 contract、migration 和 crash matrix 被接受前，不得把 fingerprint 写入 ProjectFile、DomainEvent 或 side-effect journal，也不得把当前 process-local single-flight 当作 durable CAS。

## 1. 目的与边界

本设计只处理 interactive Worker recovery decision 的 durable stale-state admission：

```text
captured recovery facts
  → expected facts fingerprint
  → retry / skip / inspect decision
  → durable decision admission
  → WorkerRun projection + event read-back
  → retry only after durable commit
```

它不处理：

- `WorkerRuntime` 的跨重启持久化；7.318 已明确 runtime 只在当前 mounted interactive retry 中透传；
- WorkerQueue 的 attempt/lease 算法；
- side-effect journal 的 started → unknown reconciliation 事实；
- Cleanup proposal、branch CAS、worktree remove 或 native partial-CAS；
- UI `recoveryActions`/`allowedDecisions`，它们只是 capability hint；
- ProjectFile、event stream、side-effect journal 的既有 schema 迁移，除非后续实现切片明确采用本文 contract。

当前代码的 `workerRecoveryDecisionPrecondition` 仍是内存层的 project/run/TaskGraph drift guard，`workerRecoverySingleFlight` 仍是进程内 lease。二者都不是本文要设计的 durable CAS。

## 2. 设计状态与证据边界

- **状态：** `设计基线`，尚未实现、尚未完成用户可见的 durable read-back，也没有真实跨进程/重启证明。
- **本轮依据：** 当前源码、测试、ProjectFile/event/journal 写入顺序和 exact read-only audit；实现事实以源码和测试为准。
- **禁止升级：** 不能因为有纯函数测试、event-stream sequence CAS 或 process-local save queue，就写成“recovery decision 已幂等”或“跨进程 CAS 已闭合”。
- **重新审议：** 若 ProjectFile/event store 的事实源分工、Task/Attempt identity、宿主锁能力或用户对 retry/skip 的授权语义改变，必须新建或 supersede 本设计，而不是静默改写历史 contract。

## 3. 两层身份：Facts Fingerprint 与 Decision Identity

### 3.1 Facts Fingerprint v1

`FactsFingerprintV1` 表示“这次 decision 计算时看到的、允许 recovery command 使用的事实”，不表示用户理由、模型运行时或未来结果。

建议 DTO：

```ts
{
  schema: "worker-recovery-facts-v1",
  projectId: string,
  run: {
    runId: string,
    orchestrationId: string | null,
    taskGraphId: string,
    taskGraphVersion: number,
    status: RunProjectionStatus,
    tasks: WorkerRecoveryTaskFactV1[]
  },
  taskGraph: {
    id: string,
    graphVersion: number,
    sessionId: string,
    architectureId: string,
    approval: TaskGraphApproval,
    tasks: ProjectTaskFactV1[]
  },
  failedTaskIds: string[],
  recoverableEffects: RecoverableEffectFactV1[]
}
```

`WorkerRecoveryTaskFactV1` 只包含 recovery command 会读取或会改变的字段：task identity、task definition/version、status、attempt/pendingAttempt/currentAttemptId、execution lineage、worktree assignment/provenance、evidence/acceptance/cleanup bindings 和 error/cleanup state。`createdAt`/`updatedAt` 等纯审计 metadata 不进入 v1 identity；它们仍保留在事实和审计记录中。

`ProjectTaskFactV1` 包含 trusted TaskGraph 的 task identity、definition version、stage/module/issue binding、dependsOn、scope、acceptance criteria、workflow binding、status 和 revision fields。TaskGraph 的 `id`、`graphVersion`、`sessionId`、`architectureId`、approval 和完整 task set 必须参与 identity。

`RecoverableEffectFactV1` 只包含当前 run/current task/attempt/assignment 中状态为 `started` 或 `unknown` 且已通过 canonical lineage validation 的 effect：idempotency key、kind、target、run/task/execution/attempt lineage、inputHash、orchestration/stage binding、status/recovery、assignment path/branch/baseRevision，以及决定 recovery 所需的 receipt/evidence/acceptance references。历史 terminal receipt 不作为“待恢复 effect”加入；若它影响当前 plan，必须先通过现有 `buildWorkerRunRecoveryPlan` 形成明确 projection。

以下字段明确**不**属于 v1 facts identity：

- `projectPath`：当前 operation fence 使用它，但它不是 ProjectFile/WorkerRun 的 durable identity 字段；跨平台路径映射需另有 host contract；
- transient `WorkerRuntime`（codex/antigravity）；
- UI `allowedDecisions`/`recoveryActions`；
- 用户自然语言 `reason`、当前 wall-clock `now`、事件 `occurredAt`；它们是审计 metadata；
- 任意模型文本、截图或 UI 状态。

### 3.2 Canonical normalization

v1 canonical serializer 必须在实现前通过 vectors 固定以下规则：

- object keys 按 UTF-8 字典序递归排序；undefined 字段省略，null 与省略不自动等价；
- `tasks`、`failedTaskIds`、`recoverableEffects`、effect keys 和 evidence/acceptance reference 的排序/集合语义必须显式定义；推荐 identity-bearing map 按 stable ID/key 排序，具有 domain order 的列表保留 domain order；
- Windows path 使用 `/`、去除等价尾部分隔符并按既有 host case-fold 规则比较；POSIX path 不做大小写折叠；branch/ref 不通过模糊 trim 放宽；
- numeric versions/attempts 必须是 canonical safe integer；未知 enum、缺 lineage、跨 project/run 的 effect、legacy unbound fact 一律拒绝生成 fingerprint；
- 不复用 Worker execution 的七元 `inputHash` 作为 recovery fingerprint；不把 cache hash、dirty snapshot 或现有轻量 integrity checksum 直接升级为 CAS authority；
- canonical bytes 使用 UTF-8 JSON，并带 serializer version；hash algorithm 暂定 SHA-256，最终由 Node/Tauri/Rust parity vectors 固定；
- 输出格式暂定：`worker-recovery-facts-v1:sha256:<lowercase-hex>`。在 parity vectors、错误/缺失字段和 legacy 行为未冻结前，不得写入 durable facts。

### 3.3 Decision identity

Facts identity 与 decision identity 分开：

```text
DecisionIdentityV1 = {
  factsFingerprint,
  action: retry | skip | inspect,
  requestIdentity,
  semanticPayloadVersion
}
```

- `decisionId` 不能只由随机 UUID 构成；durable event ID、decision lookup key 和 read-back 必须能绑定到一个显式 request identity；
- `reason` 默认是审计 metadata，不改变同一 facts/action 的 semantic identity；若产品将 reason 视为用户决策的一部分，必须新建 contract；
- `inspect` 必须明确为 non-mutating read/ack，或作为完整审计 decision；不能一边产生 `WorkerRunRecoveryDecided`，一边在 durable CAS 中默认为无副作用；
- 同一 request identity + 同一 facts/action 必须 read-back 已有结果，不重复写 decision、Run/Task transition、retry fence 或 side effect；
- 同一 request identity 但 facts/action/payload 改变必须 conflict；同一 facts 下 retry 与 skip 必须 conflict；不同 request identity 的相同 facts/action 是 no-op 还是新审计记录，必须在实现前固定，不能由 eventId 偶然决定。

## 4. Durable owner 与写入顺序

当前没有一个 owner 同时覆盖 ProjectFile、event stream 和 journal。后续实现必须先建立一个窄的 `WorkerRecoveryDecisionPersistence`/等价 owner，不能把 CAS 逻辑散落到 UI、`workerRecoveryCommand`、`saveProject` 和 eventBuffer。

实现前必须冻结一条可恢复的 commit protocol：

1. 在 project/run scope 上取得 durable recovery admission lock 或等价 commit generation；不能只依赖进程内 `workerRecoverySingleFlight`。
2. 重新读取并验证 trusted ProjectFile/WorkerRun、TaskGraph、event stream 和 side-effect journal；从 fresh facts 计算 expected fingerprint。journal started → unknown reconciliation 仍是它自己的 predecessor，不得伪装为 decision commit。
3. 对 expected fingerprint 做 stale check；不匹配时在任何 decision event、ProjectFile mutation 或 decision journal write 前 fail-closed。
4. 查询同一 request/semantic decision 的 durable result：exact idempotent request read-back，不重复 apply；不同 action/facts conflict。
5. 以同一 `commitId`/generation 写入 decision fact 和 WorkerRun projection，并让 event replay/ProjectFile projection能识别 commit 边界。当前 ProjectFile-first → event flush → event projection snapshot 的普通保存顺序不能直接宣称满足这一要求。
6. 每个 durable write 都必须有明确 crash/retry 状态：pending、committed、conflict 或 needs-repair；跨文件无法原子时，必须有可重放的 commit marker/reconciliation，而不是吞掉第二个写失败。
7. read-back ProjectFile、event stream/projection 和 decision record；只有 read-back 一致后才允许 retry，且 WorkerQueue 仍保持 running lease 在外部 executor/side effect 之前持久化。

**明确禁止：** 直接在当前 `workerActionController` 中先生成 fingerprint、调用现有 `saveProject`，然后把结果称为 durable CAS；那只会把新语义叠加到旧的非原子写顺序上。

## 5. Legacy 与 migration

- 现有 WorkerRunQueueState、ProjectFile、DomainEvent、SideEffectJournal 都是 version 1，没有 recovery fingerprint/decision record；旧 decision 不能从当前 state 反推其历史 observed facts。
- 旧 events/journal 继续作为 historical facts；没有 fingerprint 的历史 decision 不自动 backfill 为 canonical CAS marker。
- legacy effect key/inputHash 仍遵守既有显式 migration；legacy/canonical collision、unbound lineage 和 malformed record fail-closed。
- 若未来增加 `RecoveryDecisionRecordV1` 或 event payload 字段，必须定义 schema version、old reader、new writer、migration collision、same-decision replay 和 restart read-back；不能把旧 `WorkerRunRecoveryDecided` 事件静默解释成新的 CAS commit。
- 迁移前的 run 若缺少可信 fingerprint，保持 inspect/recovery boundary，不自动 retry/skip；迁移需要可信 pre-decision source，否则只能标记 historical/unbound。

## 6. 分阶段实施门

### Gate A：纯 contract vectors（下一条允许的代码切片）

只实现纯 DTO normalization/serializer/fingerprint helper和 direct tests：

- 不写 ProjectFile、DomainEvent、eventBuffer、journal、runtime 或 native host；
- 覆盖 key insertion order、array/set policy、undefined/null、path policy、timestamps、historical terminal effects、malformed/legacy/unbound facts；
- Node 与未来 Tauri/Rust parity vectors先固定；helper 输出必须 versioned；
- Gate A 通过不等于 durable CAS 已实现。

### Gate B：durable decision admission

单独实现 persistence owner、durable lock/generation、decision lookup、stale/conflict/idempotence和 read-back；加入 ProjectFile/event/journal crash matrix。不得与 UI capability或runtime selection混合。

### Gate C：controller wiring

只在 Gate B read-back可证明后接回 `workerActionController`：fresh durable facts → decision admission → projection/event commit → retry。旧的 in-memory precondition和single-flight保留为快速 guard，不代替 durable CAS。

### Gate D：真实 restart/cross-process

用 disposable project fixture验证双 controller/进程、项目切换、journal partial reconciliation、ProjectFile/event conflict、same decision replay、different decision conflict、crash recovery和 retry-after-commit；真实 GUI/E2E另列，不以 Vitest代替。

## 7. Keep-out 与验收语言

本设计 gate 不允许以下表述：

- “有 event-stream sequence CAS，所以 Worker recovery decision 已 CAS”；
- “有 process-local single-flight，所以没有 duplicate decision”；
- “有 UI allowedDecisions，所以 retry 已授权”；
- “有 pure fingerprint helper，所以跨文件原子提交已闭合”；
- “有当前 state，所以可以 backfill 历史 decision fingerprint”；
- “runtime callback 透传已证明 restart runtime provenance”。

只有 Gate B 的 durable read-back、Gate C 的 controller wiring 和 Gate D 的真实 restart/cross-process evidence同时对应同一 exact source checkpoint，才可称 recovery decision CAS closed。

## 8. 相关权威

- 架构取舍：`SLIMEMOLD_ARCHITECTURE_DECISIONS.md` ADR-SM-084；
- 当前实现历史：`docs/DEVELOPMENT_LOG.md` 7.206–7.318；
- current Task/Attempt/Worker model：`PROJECT_CONTROL_PLANE_ARCHITECTURE.md`；
- Worker recovery implementation：`src/projectControl/workerActionController.ts`、`workerRecoveryCommand.ts`、`workerRecoveryDecisionPrecondition.ts`、`workerSideEffects.ts`；
- event/project persistence：`src/projectControl/eventBuffer.ts`、`src/domain/eventStore.ts`、`src/store/projectFilePersistence.ts`、`src/store/workflowStore.ts`；
- side-effect authority：`src/domain/sideEffects.ts`。
