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
 * 宿主登记的真实执行结果（P0 审计修复）：
 * 由 dev.* 节点在真实执行后登记，dev.evidence.add 只能**引用**这些结果构造证据——
 * 节点/工作流无法自由填写 status/summary/exitCode，杜绝伪造「测试通过/diff 完成」证据。
 */
export interface HostResultRecord {
  resultId: string;
  kind: 'command' | 'test' | 'diff' | 'artifact';
  /** 宿主根据真实执行结果判定（如 exitCode===0 → passed） */
  status: 'passed' | 'failed';
  exitCode?: number;
  command?: string;
  summary: string;
  contentHash?: string;
}

export interface DevSession {
  policy: SelfDevelopmentPolicy;
  manager: WorktreeManager;
  service: DevCapabilityService;
  collector: EvidenceCollector;
  /** 宿主登记的真实执行结果（P0：证据唯一事实来源） */
  resultStore: Map<string, HostResultRecord>;
  /** 宿主已批准清理的 worktree 路径（P0：cleanup 确认只能由宿主 API 生成） */
  approvedCleanups: Set<string>;
  /** 登记一次宿主真实执行结果。 */
  registerResult(rec: HostResultRecord): HostResultRecord;
  /** 宿主审批：批准清理某 worktree（仅 UI/宿主审批层调用，节点/工作流不可触达）。 */
  approveCleanup(path: string): void;
  isCleanupApproved(path: string): boolean;
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
    approvedCleanups: new Set(),
    defs: [],
    registerResult(rec) {
      this.resultStore.set(rec.resultId, rec);
      return rec;
    },
    approveCleanup(path) {
      this.approvedCleanups.add(normalizeAbsolutePath(path));
    },
    isCleanupApproved(path) {
      return this.approvedCleanups.has(normalizeAbsolutePath(path));
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
