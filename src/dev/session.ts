/**
 * H4 DevSession：宿主编排会话（src/nodes/dev 节点的运行时环境）。
 *
 * - manager：WorktreeManager（创建/登记/清理 worktree；同时作为 service 的 WorktreeRegistry）；
 * - service：DevCapabilityService（code.read/code.patch/shell.run/test.run/git.*，fail-closed cwd）；
 * - collector：EvidenceCollector（可注入宿主持久化）；
 * - defs：由 createDevNodeDefs(session) 生成的开发节点定义（headless 运行时注册到 defs 查找表）。
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

/**
 * 宿主登记的真实执行结果（P0/P1 审计修复）：
 * 由 dev.* 节点在真实执行后登记，dev.evidence.add 只能**引用**这些结果构造证据——
 * 节点/工作流无法自由填写 status/summary/exitCode。P1：结果绑定 worktreePath，
 * evidence.add 校验引用结果属于同一 worktree（防跨编排/跨任务引用）。
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
  /** P1：结果所属 worktree（evidence.add 作用域校验） */
  worktreePath?: string;
}

/**
 * 宿主清理审批（P1：一次性 + 绑定版本）。
 * 批准后节点可清理该 worktree；清理成功立即消费（consumed=true），不可重复清理。
 */
export interface CleanupApproval {
  worktreePath: string;
  baseRevision?: string;
  acceptanceId?: string;
  approvedAt: string;
  consumed: boolean;
}

export interface DevSession {
  policy: SelfDevelopmentPolicy;
  manager: WorktreeManager;
  service: DevCapabilityService;
  collector: EvidenceCollector;
  /** 宿主登记的真实执行结果（P0：证据唯一事实来源） */
  resultStore: Map<string, HostResultRecord>;
  /** 宿主已批准清理的 worktree（P1：一次性、绑定 baseRevision/acceptanceId） */
  approvedCleanups: Map<string, CleanupApproval>;
  /** 登记一次宿主真实执行结果。 */
  registerResult(rec: HostResultRecord): HostResultRecord;
  /** 宿主审批：批准清理某 worktree（仅 UI/宿主审批层调用，节点/工作流不可触达）。 */
  approveCleanup(path: string, opts?: { baseRevision?: string; acceptanceId?: string }): void;
  isCleanupApproved(path: string): boolean;
  /** 清理成功后消费审批（一次性）。 */
  consumeCleanup(path: string): void;
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
    approvedCleanups: new Map(),
    defs: [],
    registerResult(rec) {
      this.resultStore.set(rec.resultId, rec);
      return rec;
    },
    approveCleanup(path, opts) {
      const key = normalizeAbsolutePath(path);
      this.approvedCleanups.set(key, {
        worktreePath: key,
        baseRevision: opts?.baseRevision,
        acceptanceId: opts?.acceptanceId,
        approvedAt: new Date().toISOString(),
        consumed: false,
      });
    },
    isCleanupApproved(path) {
      const a = this.approvedCleanups.get(normalizeAbsolutePath(path));
      return !!a && !a.consumed;
    },
    consumeCleanup(path) {
      const key = normalizeAbsolutePath(path);
      const a = this.approvedCleanups.get(key);
      if (a) this.approvedCleanups.set(key, { ...a, consumed: true });
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
