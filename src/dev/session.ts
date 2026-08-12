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
import { EvidenceCollector, type EvidencePersistence } from './evidence';
import { createDevNodeDefs } from '../nodes/dev/index';
import { normalizeAbsolutePath } from './path-utils';
import { readTextFile, resolveInside } from './node-run';

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
  manager: WorktreeManager;
  service: DevCapabilityService;
  collector: EvidenceCollector;
  /** 宿主登记的真实执行结果（P0：证据唯一事实来源；作用域必填） */
  resultStore: Map<string, HostResultRecord>;
  /** 确定性验收记录（cleanup 确认门校验） */
  acceptanceStore: Map<string, AcceptanceRecord>;
  /** 宿主已批准清理的 worktree（P1：一次性、绑定 baseRevision/stateSignature/acceptanceId） */
  approvedCleanups: Map<string, CleanupApproval>;
  /** 登记一次宿主真实执行结果（三项作用域必填，缺失即拒绝）。 */
  registerResult(rec: HostResultRecord): HostResultRecord;
  /** 宿主生成不可预测且唯一的验收记录 ID（P1：不接受工作流/节点自填）。 */
  nextAcceptanceId(): string;
  /** 记录确定性验收结果（P1：禁止覆盖已有 ID——重复执行产生新记录）。 */
  recordAcceptance(rec: AcceptanceRecord): AcceptanceRecord;
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
   * 强制清理（P1：高风险专用 API，仅 UI/宿主审批层人工触发）。
   * 绕过「绑定验收/状态签名」的正常确认门，但必须显式给出 reason（记录审计）；
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
}

let _session: DevSession | null = null;

/** 轻量内容哈希（非密码用途，仅状态指纹）。 */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h${h.toString(36)}`;
}

export function initDevSession(opts: DevSessionOptions = {}): DevSession {
  if (_session) return _session;
  const policy = opts.policy ?? defaultDevPolicy;
  const baseRepoPath = opts.baseRepoPath ?? process.cwd();
  const manager = new WorktreeManager(opts.gitRunner ?? createNodeGitRunner(), baseRepoPath);
  // manager 实现 WorktreeRegistry（isTracked），service 的 cwd fail-closed 依赖它
  const registry: WorktreeRegistry = { isTracked: (cwd) => manager.isTracked(cwd) };
  const service = createNodeDevService(policy, {}, registry);
  const collector = new EvidenceCollector(opts.persistence);
  const session: DevSession = {
    policy,
    manager,
    service,
    collector,
    resultStore: new Map(),
    acceptanceStore: new Map(),
    approvedCleanups: new Map(),
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
      // 不可预测且唯一：时间戳 + 随机
      const rand = Math.random().toString(36).slice(2, 10);
      return `acc-${Date.now().toString(36)}-${rand}`;
    },
    recordAcceptance(rec) {
      // P1（审计）：禁止覆盖已有 ID——同一 ID 的验收记录不可被后续运行替换
      if (this.acceptanceStore.has(rec.acceptanceId)) {
        throw new Error(`验收记录 ID 已存在，禁止覆盖：${rec.acceptanceId}`);
      }
      this.acceptanceStore.set(rec.acceptanceId, rec);
      return rec;
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
      // untracked = gitChangedFiles 的 untracked 部分（再查一次 ls-files --others）
      const untracked = await service.gitUntrackedFiles({ cwd: path });
      const untrackedHashes: string[] = [];
      for (const f of untracked) {
        try {
          const abs = await resolveInside(path, f);
          const content = await readTextFile(abs);
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
      const key = normalizeAbsolutePath(path);
      this.approvedCleanups.set(key, {
        worktreePath: key,
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
      const a = this.approvedCleanups.get(normalizeAbsolutePath(path));
      return !!a && !a.consumed;
    },
    getCleanupApproval(path) {
      return this.approvedCleanups.get(normalizeAbsolutePath(path));
    },
    consumeCleanup(path) {
      const key = normalizeAbsolutePath(path);
      const a = this.approvedCleanups.get(key);
      if (a) this.approvedCleanups.set(key, { ...a, consumed: true });
    },
    async forceCleanup(path, reason) {
      // 高风险：仅人工触发。reason 由调用方记入审计（CLI/GUI 确认框）。
      if (!reason || !reason.trim()) {
        throw new Error('forceCleanup 必须提供 reason（审计要求）');
      }
      const cleaned = await manager.cleanup(path, { confirm: true });
      return cleaned;
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
