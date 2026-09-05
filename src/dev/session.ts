/**
 * H4 DevSession：宿主编排会话（src/nodes/dev 节点的运行时环境）。
 *
 * - manager：WorktreeManager（创建/登记/清理 worktree；同时作为 service 的 WorktreeRegistry）；
 * - service：DevCapabilityService（code.read/code.patch/shell.run/test.run/git.*，fail-closed cwd）；
 * - collector：EvidenceCollector（可注入宿主持久化）；
 * - resultStore：宿主登记的真实执行结果（证据唯一事实来源；作用域必填）；
 * - acceptanceStore：确定性验收记录（cleanup 确认门校验 passed）；
 * - approvedCleanups：宿主清理审批（一次性 + 绑定基线/状态/验收）。
 *
 * 单例：headless/CI 启动时 initDevSession()；GUI（WebView）不初始化——dev 节点调用即抛错
 * （node:child_process shim + fail-closed registry 双重兜底）。
 */
import type { NodeDefinition } from '../types';
import { defaultDevPolicy, type SelfDevelopmentPolicy } from './policy';
import { createNodeDevService, type DevCapabilityService, type WorktreeRegistry } from './capabilities';
import { WorktreeManager, createNodeGitRunner, type DevGitRunner } from './worktree';
import {
  assertEvidenceOutsideWorktree,
  EvidenceCollector,
  evidencePathFor,
  isMissingFileError,
  type EvidencePersistence,
  type JsonlFsOps,
} from './evidence';
import { createDevNodeDefs } from '../nodes/dev/index';
import { normalizeAbsolutePath, pathComparisonKey } from './path-utils';
import { readTextFile, resolveInside } from './node-run';
import { createTauriGitRunner, createTauriDeps } from './tauri-run';
import { assertTaskExecutionLineage } from '../domain/execution';

/**
 * 宿主登记的真实执行结果（P0/P1 审计修复）：
 * 由 dev.* 节点在真实执行后登记，dev.evidence.add 只能**引用**这些结果构造证据——
 * 节点/工作流无法自由填写 status/summary/exitCode。P1（审计）：三项作用域**必填**，
 * 缺失即拒绝登记——无作用域结果不可被任意编排/阶段引用。
 */
export interface HostResultRecord {
  resultId: string;
  kind: 'command' | 'test' | 'diff' | 'artifact';
  /** 宿主根据真实执行结果判定（如 exitCode===0 → passed；diff 还要求有实际变更） */
  status: 'passed' | 'failed';
  exitCode?: number;
  command?: string;
  summary: string;
  contentHash?: string;
  /** 结果所属 worktree（evidence.add 作用域校验；必填） */
  worktreePath: string;
  /** 结果所属任务（必填——防跨编排引用） */
  orchestrationId: string;
  /** 结果所属阶段（必填——防跨阶段引用） */
  stageId: string;
  /** 当前 Worker execution lineage；旧宿主结果可没有这些字段。 */
  taskExecutionId?: string;
  attemptId?: string;
}

/** 确定性验收记录（cleanup 确认门校验）。 */
export interface AcceptanceRecord {
  acceptanceId: string;
  orchestrationId: string;
  stageId: string;
  worktreePath: string;
  passed: boolean;
  failedChecks: string[];
  at: string;
  /** 当前 Worker execution lineage；旧 acceptance 可没有这些字段。 */
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
}

export interface AcceptancePersistence {
  append(record: AcceptanceRecord): Promise<void>;
  load(): Promise<AcceptanceRecord[]>;
}

export function createHostAcceptanceStoreWithFs(
  acceptanceRoot: string,
  worktreePath: string,
  key: string,
  fsOps: JsonlFsOps,
): AcceptancePersistence {
  assertEvidenceOutsideWorktree(acceptanceRoot, worktreePath);
  return createJsonlAcceptanceStore(evidencePathFor(acceptanceRoot, key), fsOps);
}

function createJsonlAcceptanceStore(filePath: string, fsOps: JsonlFsOps): AcceptancePersistence {
  const dirname = filePath.includes('/') || filePath.includes('\\')
    ? filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')))
    : '.';
  let appendChain = Promise.resolve();
  return {
    async append(record) {
      const operation = appendChain.then(async () => {
        decodeAcceptanceRecord(record);
        await fsOps.mkdir(dirname);
        await fsOps.append(filePath, `${JSON.stringify(record)}\n`);
      });
      appendChain = operation.catch(() => {});
      await operation;
    },
    async load() {
      let text = '';
      try {
        text = await fsOps.read(filePath);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      const records: AcceptanceRecord[] = [];
      for (const line of text.split('\n').filter((item) => item.trim())) {
        const value = decodeAcceptanceRecord(JSON.parse(line));
        const existing = records.find((record) => record.acceptanceId === value.acceptanceId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
          throw new Error(`Acceptance ID 内容冲突：${value.acceptanceId}`);
        }
        if (!existing) records.push(value);
      }
      return records;
    },
  };
}

export function decodeAcceptanceRecord(value: unknown): AcceptanceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Acceptance JSONL 记录必须是对象');
  const record = value as Partial<AcceptanceRecord>;
  if (
    typeof record.acceptanceId !== 'string'
    || !record.acceptanceId.trim()
    || typeof record.orchestrationId !== 'string'
    || typeof record.stageId !== 'string'
    || typeof record.worktreePath !== 'string'
    || typeof record.passed !== 'boolean'
    || !Array.isArray(record.failedChecks)
    || !record.failedChecks.every((item) => typeof item === 'string')
    || typeof record.at !== 'string'
    || !record.orchestrationId.trim()
    || !record.stageId.trim()
    || !record.worktreePath.trim()
    || !record.at.trim()
  ) throw new Error('Acceptance JSONL 基础字段无效');
  const hasLineage = record.runId !== undefined
    || record.taskId !== undefined
    || record.taskExecutionId !== undefined
    || record.attemptId !== undefined;
  if (!hasLineage) return { ...record } as AcceptanceRecord;
  if (
    typeof record.runId !== 'string'
    || typeof record.taskId !== 'string'
    || typeof record.taskExecutionId !== 'string'
    || typeof record.attemptId !== 'string'
  ) throw new Error('Acceptance lineage 不完整');
  try {
    assertTaskExecutionLineage({
      runId: record.runId,
      taskId: record.taskId,
      taskExecutionId: record.taskExecutionId,
      attemptId: record.attemptId,
    });
    return { ...record } as AcceptanceRecord;
  } catch {
    throw new Error('Acceptance lineage 无效');
  }
}

function isAcceptanceRecord(value: unknown): value is AcceptanceRecord {
  try {
    decodeAcceptanceRecord(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 宿主清理审批（P1：一次性 + 绑定版本/状态/验收）。
 * cleanup 确认门校验（全部满足才允许清理）：
 * - 审批存在且未 consumed；
 * - 若绑定 baseRevision：当前 worktree 基线一致；
 * - 若绑定 stateSignature：当前 worktree 状态签名一致（防 worktree 被再次修改后清理）；
 * - 若绑定 acceptanceId：对应验收记录存在且 passed、worktreePath 一致。
 */
export interface CleanupApproval {
  worktreePath: string;
  baseRevision?: string;
  stateSignature?: string;
  acceptanceId?: string;
  /** 绑定的验收所属任务/阶段（cleanup 校验 acceptance 三元组） */
  orchestrationId?: string;
  stageId?: string;
  approvedAt: string;
  consumed: boolean;
}

export interface DevSession {
  policy: SelfDevelopmentPolicy;
  /** Rust Tauri host session fencing token；Node/headless 无此字段。 */
  hostGeneration?: number;
  manager: WorktreeManager;
  service: DevCapabilityService;
  collector: EvidenceCollector;
  /** 宿主登记的真实执行结果（P0：证据唯一事实来源；作用域必填） */
  resultStore: Map<string, HostResultRecord>;
  /** 确定性验收记录（cleanup 确认门校验） */
  acceptanceStore: Map<string, AcceptanceRecord>;
  /** 宿主已批准清理的 worktree（P1：一次性、绑定 baseRevision/stateSignature/acceptanceId） */
  approvedCleanups: Map<string, CleanupApproval>;
  /** 宿主级 per-worktree 清理互斥锁（P1：同一 worktree 的确认清理串行执行）。 */
  confirmCleanupInFlight: Set<string>;
  /** 登记一次宿主真实执行结果（三项作用域必填，缺失即拒绝）。 */
  registerResult(rec: HostResultRecord): HostResultRecord;
  /** 宿主生成不可预测且唯一的验收记录 ID（P1：不接受工作流/节点自填）。 */
  nextAcceptanceId(): string;
  /** 记录确定性验收结果（P1：禁止覆盖已有 ID——重复执行产生新记录）。 */
  recordAcceptance(rec: AcceptanceRecord): AcceptanceRecord;
  /** 把已登记的 acceptance 写入宿主持久化；失败不得把它当作可清理依据。 */
  persistAcceptance(rec: AcceptanceRecord): Promise<void>;
  /** 从宿主持久化加载 acceptance（项目启动/恢复前调用）。 */
  loadAcceptances(): Promise<void>;
  getAcceptance(acceptanceId: string): AcceptanceRecord | undefined;
  /** 计算 worktree 当前状态签名（changedFiles + diff 哈希；供审批/清理校验）。 */
  computeWorktreeSignature(path: string): Promise<string>;
  /** 宿主审批：批准清理某 worktree（仅 UI/宿主审批层调用，节点/工作流不可触达）。 */
  approveCleanup(
    path: string,
    opts?: {
      baseRevision?: string;
      stateSignature?: string;
      acceptanceId?: string;
      orchestrationId?: string;
      stageId?: string;
    },
  ): void;
  isCleanupApproved(path: string): boolean;
  /** 读取清理审批记录（cleanup 确认门校验绑定字段用）。 */
  getCleanupApproval(path: string): CleanupApproval | undefined;
  /** 清理成功后消费审批（一次性）。 */
  consumeCleanup(path: string): void;
  /**
   * 原子式确认清理（P1 审计：消除签名计算与删除之间的 TOCTOU 窗口）。
   * 单 API 内收口：取审批 → 重新校验验收三元组 + 重新计算状态签名 + 校验基线 →
   * 全部通过后立即 cleanup → 成功后消费审批。
   * 节点与 headless 收尾统一走这里，不在外部「先算签名再 cleanup」。
   */
  confirmAndCleanup(path: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * 强制清理（P1：高风险专用 API，仅 UI/宿主审批层人工触发）。
   * 绕过「绑定验收/状态签名」的正常确认门，但必须显式给出 reason（记录审计）；
   * 且要求 session 已注入宿主持久化（无 persistence 直接拒绝——审计必须落盘可追溯）。
   * 节点/工作流不可触达。返回是否清理成功。
   */
  forceCleanup(path: string, reason: string): Promise<boolean>;
  defs: NodeDefinition[];
}

export interface DevSessionOptions {
  policy?: SelfDevelopmentPolicy;
  /** 主仓库路径（worktree 基于此创建；默认 process.cwd()） */
  baseRepoPath?: string;
  gitRunner?: DevGitRunner;
  /** 宿主证据持久化（位于 worktree 外，由宿主构造） */
  persistence?: EvidencePersistence;
  /** 宿主 acceptance 持久化（位于 worktree 外，由宿主构造）。 */
  acceptancePersistence?: AcceptancePersistence;
  /**
   * 执行环境（Phase 1）：
   * - 'node'（默认）：headless/CI，命令/文件走 node-run；
   * - 'tauri'：GUI，命令/文件走 Rust 通道（dev_exec/dev_read_file/dev_write_file），
   *   worktree 创建/清理自动同步 Rust 登记态。
   */
  env?: 'node' | 'tauri';
  /** Tauri host generation returned by dev_init_session; required in GUI mode. */
  hostGeneration?: number;
  /** Tauri 宿主固定证据根（如 `<项目根>/.slimemold/evidence`）。worktree 创建时自动绑定宿主 EvidenceStore。 */
  evidenceRoot?: string;
}

let _session: DevSession | null = null;

/** 轻量内容哈希（非密码用途，仅状态指纹）。 */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h${h.toString(36)}`;
}

function requireHostGeneration(generation: number | undefined): number {
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Tauri DevSession requires a host session generation');
  }
  return generation;
}

export function initDevSession(opts: DevSessionOptions = {}): DevSession {
  const requestedBaseRepoPath = opts.baseRepoPath ?? process.cwd();
  const env: 'node' | 'tauri' = opts.env ?? 'node';
  const hostGeneration = env === 'tauri' ? requireHostGeneration(opts.hostGeneration) : undefined;
  if (_session) {
    if (pathComparisonKey(_session.manager.getBaseRepoPath()) !== pathComparisonKey(requestedBaseRepoPath)) {
      throw new Error('DevSession 已绑定另一个项目，必须先 teardown 后切换');
    }
    if (_session.hostGeneration !== hostGeneration) {
      throw new Error('DevSession host session generation 不匹配，必须先 teardown 后重建');
    }
    return _session;
  }
  const policy = opts.policy ?? defaultDevPolicy;
  const baseRepoPath = requestedBaseRepoPath;
  const acceptancePersistence = opts.acceptancePersistence;

  // Tauri（GUI）下的命令/文件/路径通道：全部走 Rust 宿主（dev_exec / dev_read_file / dev_write_file）。
  // tauri-run 顶层无 @tauri-apps 运行时依赖（invoke 均延迟 import），静态 import 对浏览器构建安全。
  const tauriDeps = env === 'tauri' ? createTauriDeps(hostGeneration!) : undefined;
  const manager = new WorktreeManager(
    opts.gitRunner ?? (env === 'tauri' ? createTauriGitRunner(hostGeneration!) : createNodeGitRunner()),
    baseRepoPath,
  );
  // manager 实现 WorktreeRegistry（isTracked），service 的 cwd fail-closed 依赖它
  const registry: WorktreeRegistry = { isTracked: (cwd) => manager.isTracked(cwd) };
  const service = env === 'tauri'
    ? createNodeDevService(policy, tauriDeps!, registry, 'tauri')
    : createNodeDevService(policy, {}, registry);
  const collector = new EvidenceCollector(opts.persistence);
  // 未跟踪文件内容读取/路径解析：Tauri 下走 Rust 通道（node-run 在 GUI 被 shim 掉）。
  const readFileP = tauriDeps?.readFile ?? readTextFile;
  const resolveP = tauriDeps?.resolveInside ?? resolveInside;
  // Tauri 宿主固定证据根（worktree 创建后动态绑定；断言由 evidence.assertEvidenceOutsideWorktree 保证）
  const evidenceRoot = env === 'tauri' ? opts.evidenceRoot : undefined;

  // Tauri 下：worktree 创建/清理同步 Rust 登记态（dev_register_worktree / dev_unregister_worktree），
  // 使 dev_exec/dev_read_file/dev_write_file 的 cwd/路径归属校验能识别该 worktree。
  const syncRust = async (fn: 'register' | 'unregister', path: string): Promise<void> => {
    if (env !== 'tauri') return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(fn === 'register' ? 'dev_register_worktree' : 'dev_unregister_worktree', {
      path,
      generation: hostGeneration,
    });
  };
  // Host registration is a separate side effect from Git cleanup. Keep its
  // success state so a failed initial registration never turns a later Git
  // rollback into an invalid unregister call.
  const registeredWorktrees = new Set<string>();
  const rawCreate = manager.create.bind(manager);
  const rawRestore = manager.restore.bind(manager);
  const rawCleanup = manager.cleanup.bind(manager);
  manager.create = async (id, path, opts) => {
    const info = await rawCreate(id, path, opts);
    if (info) {
      // GUI 动态 worktree：宿主固定证据根 + 断言证据在 worktree 外 → 惰性绑定宿主 EvidenceStore
      if (env === 'tauri' && evidenceRoot) {
        const { createTauriEvidenceStore } = await import('./tauri-run');
        try {
          collector.attachPersistence(createTauriEvidenceStore(evidenceRoot, info.path, 'host'));
        } catch {
          // 证据根与 worktree 相交 → 拒绝持久化（forceCleanup 等依赖持久化的操作将不可用，fail-closed）
        }
      }
      try {
        await syncRust('register', info.path);
        registeredWorktrees.add(info.id);
      } catch (error) {
        // Tauri host keeps a pending add lease until registration succeeds, so
        // this cleanup can pass the host gate. Preserve the manager record when
        // rollback itself fails; forgetting it would lose orphan lineage.
        const rolledBack = await rawCleanup(id, { confirm: true, signal: opts?.signal }).catch(() => false);
        if (rolledBack) manager.forget(id);
        throw error;
      }
    }
    return info;
  };
  manager.restore = async (info, opts) => {
    const restored = await rawRestore(info, opts);
    if (!restored) return false;
    if (info.status === 'orphaned') return true;
    try {
      await syncRust('register', info.path);
      registeredWorktrees.add(info.id);
      return true;
    } catch {
      // Keep the live Git worktree record so registration can be retried after
      // a transient host/session failure; forgetting it would lose recovery lineage.
      return false;
    }
  };
  manager.cleanup = async (id, opts) => {
    const info = manager.get(id);
    if (info?.status === 'registration-pending') {
      if (!opts?.confirm || opts?.signal?.aborted) return false;
      try {
        await syncRust('unregister', info.path);
        registeredWorktrees.delete(id);
        manager.markCleaned(id);
        return true;
      } catch {
        return false;
      }
    }
    const cleaned = await rawCleanup(id, opts);
    if (!cleaned || !info) return cleaned;
    if (!registeredWorktrees.has(id)) {
      // Git cleanup completed, but Rust registration never did. There is no
      // host registration to unregister; drop the resolved manager lineage.
      manager.forget(id);
      return true;
    }
    try {
      await syncRust('unregister', info.path);
      registeredWorktrees.delete(id);
    } catch {
      manager.markRegistrationPending(id);
      return false;
    }
    return cleaned;
  };
  const session: DevSession = {
    policy,
    hostGeneration,
    manager,
    service,
    collector,
    resultStore: new Map(),
    acceptanceStore: new Map(),
    approvedCleanups: new Map(),
    confirmCleanupInFlight: new Set(),
    defs: [],
    registerResult(rec) {
      // P1（审计）：作用域必填——无任务/阶段/工作区归属的结果拒绝登记
      if (!rec.resultId || !rec.worktreePath || !rec.orchestrationId || !rec.stageId) {
        throw new Error(
          '宿主结果登记失败：resultId/worktreePath/orchestrationId/stageId 均必填（缺失作用域的结果不可被引用）',
        );
      }
      this.resultStore.set(rec.resultId, rec);
      return rec;
    },
    nextAcceptanceId() {
      // P1（审计）：crypto.randomUUID 作为安全审计凭证（Math.random 仅普通唯一性）
      const rand =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().slice(0, 8)
          : Math.random().toString(36).slice(2, 10);
      return `acc-${Date.now().toString(36)}-${rand}`;
    },
    recordAcceptance(rec) {
      // P1（审计）：禁止覆盖已有 ID——同一 ID 的验收记录不可被后续运行替换
      if (this.acceptanceStore.has(rec.acceptanceId)) {
        throw new Error(`验收记录 ID 已存在，禁止覆盖：${rec.acceptanceId}`);
      }
      if (!isAcceptanceRecord(rec)) {
        throw new Error('验收记录格式或 lineage 无效');
      }
      this.acceptanceStore.set(rec.acceptanceId, rec);
      return rec;
    },
    async persistAcceptance(rec) {
      const current = this.acceptanceStore.get(rec.acceptanceId);
      if (!current || JSON.stringify(current) !== JSON.stringify(rec)) {
        throw new Error(`验收记录未在当前 session 登记：${rec.acceptanceId}`);
      }
      if (!acceptancePersistence) {
        this.acceptanceStore.delete(rec.acceptanceId);
        throw new Error('AcceptancePersistence 未配置，拒绝把验收当作 durable 事实');
      }
      try {
        await acceptancePersistence.append({ ...rec });
        const persisted = (await acceptancePersistence.load()).find((item) => item.acceptanceId === rec.acceptanceId);
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(rec)) {
          this.acceptanceStore.delete(rec.acceptanceId);
          throw new Error(`Acceptance 持久化 read-back 不一致：${rec.acceptanceId}`);
        }
      } catch (error) {
        this.acceptanceStore.delete(rec.acceptanceId);
        throw error;
      }
    },
    async loadAcceptances() {
      if (!acceptancePersistence) return;
      const loaded = await acceptancePersistence.load();
      const next = new Map(this.acceptanceStore);
      for (const record of loaded) {
        if (!isAcceptanceRecord(record)) throw new Error('Acceptance 记录无效');
        const existing = next.get(record.acceptanceId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error(`Acceptance ID 内容冲突：${record.acceptanceId}`);
        }
        next.set(record.acceptanceId, { ...record });
      }
      this.acceptanceStore.clear();
      for (const [id, record] of next) this.acceptanceStore.set(id, record);
    },
    getAcceptance(acceptanceId) {
      return this.acceptanceStore.get(acceptanceId);
    },
    async computeWorktreeSignature(path) {
      // worktree 当前状态指纹：changedFiles（排序）+ diff 文本 + **untracked 文件内容哈希**
      //（P1 审计：untracked 内容不在 git diff 中，只有文件名会被漏掉——审批后改同一
      // untracked 文件内容须使签名变化，否则 cleanup 会误通过）。
      const files = await service.gitChangedFiles({ cwd: path });
      const diff = await service.gitDiff(undefined, { cwd: path });
      if (diff.exitCode !== 0) throw new Error(`无法计算 worktree diff 签名：${diff.stderr || diff.exitCode}`);
      // untracked = gitChangedFiles 的 untracked 部分（再查一次 ls-files --others）
      const untracked = await service.gitUntrackedFiles({ cwd: path });
      const untrackedHashes: string[] = [];
      for (const f of untracked) {
        try {
          const abs = await resolveP(path, f);
          const content = await readFileP(abs);
          untrackedHashes.push(`${f}:${hash(content)}`);
        } catch {
          // 读取失败（文件被删等）→ 视为已变化（签名带 marker，拒绝清理）
          untrackedHashes.push(`${f}:<unreadable>`);
        }
      }
      return hash(
        `${files.sort().join('\n')}\n---\n${diff.stdout}\n---untracked---\n${untrackedHashes.sort().join('\n')}`,
      );
    },
    approveCleanup(path, opts) {
      const normalizedPath = normalizeAbsolutePath(path);
      const key = pathComparisonKey(path);
      this.approvedCleanups.set(key, {
        worktreePath: normalizedPath,
        baseRevision: opts?.baseRevision,
        stateSignature: opts?.stateSignature,
        acceptanceId: opts?.acceptanceId,
        orchestrationId: opts?.orchestrationId,
        stageId: opts?.stageId,
        approvedAt: new Date().toISOString(),
        consumed: false,
      });
    },
    isCleanupApproved(path) {
      const a = this.approvedCleanups.get(pathComparisonKey(path));
      return !!a && !a.consumed;
    },
    getCleanupApproval(path) {
      return this.approvedCleanups.get(pathComparisonKey(path));
    },
    consumeCleanup(path) {
      const key = pathComparisonKey(path);
      const a = this.approvedCleanups.get(key);
      if (a) this.approvedCleanups.set(key, { ...a, consumed: true });
    },
    async forceCleanup(path, reason) {
      // P1（审计）：无宿主持久化 → 直接拒绝。forceCleanup 的审计必须落盘（addAsync 只在
      // 未注入 persistence 时静默写内存）——内存审计进程退出即丢，等同无审计强制删除。
      if (!this.collector.hasPersistence()) {
        throw new Error('forceCleanup 需要宿主持久化（EvidenceStore）——无持久化不可执行强制清理');
      }
      // P1（审计）：reason 必须提供并**持久化审计**（写宿主证据，capturedBy=host）。
      if (!reason || !reason.trim()) {
        throw new Error('forceCleanup 必须提供 reason（审计要求）');
      }
      const normalizedPath = normalizeAbsolutePath(path);
      const key = pathComparisonKey(path);
      // 与正常确认门共用互斥锁，防并发清理同一 worktree
      if (this.confirmCleanupInFlight.has(key)) return false;
      this.confirmCleanupInFlight.add(key);
      try {
        // P1（审计）：审计落盘失败 → 直接拒绝 forceCleanup，不得继续删除 worktree
        //（高风险操作必须有可靠审计记录；addAsync 落盘失败会 throw）。
        await this.collector.addAsync({
          orchestrationId: 'host',
          stageId: 'force-cleanup',
          worktreePath: normalizedPath,
          kind: 'path-policy',
          status: 'failed',
          summary: `forceCleanup: ${reason}`,
        });
        const info = manager.getByPath(path);
        if (!info) throw new Error('forceCleanup 的 worktree 未登记');
        const cleaned = await manager.cleanup(info.id, { confirm: true });
        return cleaned;
      } finally {
        this.confirmCleanupInFlight.delete(key);
      }
    },
    async confirmAndCleanup(path, signal) {
      // P1（审计）：宿主级互斥锁——同一 worktree 的确认清理串行，防并发窗口；
      // 锁内完成「取审批 → 校验验收三元组 → 重新计算状态签名 → 校验基线 → cleanup」，
      // 并在 cleanup 前**二次**重算签名（computeWorktreeSignature 与删除紧邻，窗口最小化）。
      const key = pathComparisonKey(path);
      if (signal?.aborted || this.confirmCleanupInFlight.has(key)) return false;
      this.confirmCleanupInFlight.add(key);
      try {
        const approval = this.approvedCleanups.get(key);
        const info = this.manager.getByPath(path);
        if (!approval || approval.consumed) return false;
        if (!approval.acceptanceId || !approval.stateSignature || !approval.baseRevision) return false;
        const acc = this.getAcceptance(approval.acceptanceId);
        const accOk =
          !!acc &&
          acc.passed &&
          acc.orchestrationId === approval.orchestrationId &&
          acc.stageId === approval.stageId &&
          pathComparisonKey(acc.worktreePath) === key;
        const revOk = info?.baseRevision === approval.baseRevision;
        if (info?.status === 'registration-pending' || info?.status === 'orphaned') {
          if (!accOk || !revOk) return false;
          const cleaned = await this.manager.cleanup(info.id, { confirm: true, signal });
          if (cleaned) {
            this.consumeCleanup(path);
            return true;
          }
          return cleaned;
        }
        // 第一次签名校验
        const sig = await this.computeWorktreeSignature(path);
        if (signal?.aborted) return false;
        const sigOk = sig === approval.stateSignature;
        if (!accOk || !revOk || !sigOk) return false;
        // cleanup 前二次签名校验（与删除紧邻——window 内签名变化即拒绝）
        const sig2 = await this.computeWorktreeSignature(path);
        if (signal?.aborted) return false;
        if (sig2 !== approval.stateSignature) return false;
        const cleaned = await this.manager.cleanup(info.id, { confirm: true, signal });
        if (cleaned) {
          this.consumeCleanup(path);
          return true;
        }
        return cleaned;
      } finally {
        this.confirmCleanupInFlight.delete(key);
      }
    },
  };
  session.defs = createDevNodeDefs(session);
  _session = session;
  return session;
}

export function getDevSession(): DevSession | null {
  return _session;
}

export function hasDevSession(): boolean {
  return _session !== null;
}

/** 测试用：重置单例（注入 fake session 前调用）。 */
export function resetDevSession(): void {
  _session = null;
}
