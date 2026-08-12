/**
 * H4 开发节点薄封装（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §3/§7）。
 *
 * 把 DevCapabilityService / WorktreeManager / EvidenceCollector / DevEvaluator 暴露为工作流节点，
 * 供 headless 自举工作流（第一轮低风险自举任务）编排。节点只是能力的薄封装：
 * - 路径/命令/cwd 约束全部收敛在 service（fail-closed：cwd 必须属于已登记 worktree）；
 * - 节点 execute 内不重复实现安全检查；
 * - GUI（WebView）下 DevSession 未初始化 → execute 抛错（shim/fail-closed 兜底），节点失败。
 */
import type { NodeDefinition, PortType } from '../../types';
import { evaluateDevAcceptance, type AcceptanceRule } from '../../dev/evaluator';
import type { DevSession } from '../../dev/session';
import type { EvidenceKind } from '../../dev/evidence';

const DEV_CATEGORY = '开发';

/** 端口类型简写 */
const T: PortType = 'text';
const N: PortType = 'number';
const L: PortType = 'list';
const J: PortType = 'json';

/** 从输入取字符串（容错非字符串）。 */
function str(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** 从输入取数字（容错）。 */
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 从输入取字符串数组（支持数组 / JSON 数组字符串 / 逗号分隔）。 */
function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x ?? '')));
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* 逗号分隔回退 */
    }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** 从输入取 JSON（支持对象/数组/JSON 字符串）。 */
function parseJson<T>(v: unknown, fallback: T): T {
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v as T;
  if (typeof v === 'string' && v.trim()) {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function nodeError(msg: string): Error {
  return new Error(`[dev] ${msg}`);
}

/**
 * 生成开发节点定义（绑定到给定 session）。
 * 节点 execute 只做「薄封装」——安全检查全部下沉 service/manager/collector。
 */
export function createDevNodeDefs(session: DevSession): NodeDefinition[] {
  const { manager, service, collector } = session;

  const worktreeCreate: NodeDefinition = {
    typeId: 'dev.worktree.create',
    name: '创建开发工作区',
    category: DEV_CATEGORY,
    role: 'orchestrator',
    whenToUse: '自举任务第一步：从主仓库创建隔离 worktree（Agent 可写区）。',
    description:
      '基于主仓库创建 git worktree（临时分支指向 HEAD），以路径登记进 DevSession 供后续开发节点使用；非 git 仓库返回 ok=false。',
    inputs: [{ id: 'path', label: 'worktree 路径', type: T }],
    outputs: [
      { id: 'ok', label: '创建成功', type: 'any' },
      { id: 'path', label: '路径', type: T },
      { id: 'branch', label: '分支', type: T },
      { id: 'baseRevision', label: '基线提交', type: T },
    ],
    params: [{ key: 'path', label: 'worktree 路径（兜底，输入端口缺省时用）', type: 'text', default: '' }],
    async execute(inputs, params) {
      const path = str(inputs.path ?? params.path);
      if (!path) throw nodeError('worktree.create 需要 path');
      const info = await manager.create(path, path); // 登记 id 即路径（cleanup/status 按 path 引用）
      if (!info) return { ok: false, path, branch: '', baseRevision: '' };
      return { ok: true, path: info.path, branch: info.branch, baseRevision: info.baseRevision };
    },
  };

  const worktreeStatus: NodeDefinition = {
    typeId: 'dev.worktree.status',
    name: '工作区状态',
    category: DEV_CATEGORY,
    role: 'orchestrator',
    whenToUse: '检查 worktree 是否已登记、是否有未提交改动（清理前建议先查）。',
    description: '返回 worktree 是否被登记，以及是否有未提交改动（tracked diff / untracked 文件）。',
    inputs: [{ id: 'worktreePath', label: '工作区路径', type: T }],
    outputs: [
      { id: 'tracked', label: '已登记', type: 'any' },
      { id: 'hasUncommitted', label: '有未提交改动', type: 'any' },
    ],
    params: [{ key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' }],
    async execute(inputs, params) {
      const path = str(inputs.worktreePath ?? params.worktreePath);
      if (!path) throw nodeError('worktree.status 需要 worktreePath');
      return {
        tracked: manager.isTracked(path),
        hasUncommitted: await manager.hasUncommittedChanges(path),
      };
    },
  };

  const worktreeCleanup: NodeDefinition = {
    typeId: 'dev.worktree.cleanup',
    name: '清理开发工作区',
    category: DEV_CATEGORY,
    role: 'orchestrator',
    whenToUse: '自举任务收尾：人工验收通过后（confirm=true）清理 worktree。',
    description:
      '清理 worktree 并删除临时分支。必须显式传入 confirm=true（人工验收后），否则拒绝清理，防止误删未提交改动。',
    inputs: [{ id: 'worktreePath', label: '工作区路径', type: T }],
    outputs: [{ id: 'cleaned', label: '已清理', type: 'any' }],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'confirm', label: '确认清理（须人工验收后置 true）', type: 'boolean', default: false },
    ],
    async execute(inputs, params) {
      const path = str(inputs.worktreePath ?? params.worktreePath);
      if (!path) throw nodeError('worktree.cleanup 需要 worktreePath');
      const cleaned = await manager.cleanup(path, { confirm: params.confirm === true });
      return { cleaned };
    },
  };

  const codeRead: NodeDefinition = {
    typeId: 'dev.code.read',
    name: '读取代码文件',
    category: DEV_CATEGORY,
    role: 'worker',
    whenToUse: '在 worktree 内读取允许路径的文件（路径经 allowed/protected 校验）。',
    description: '读取 worktree 内文件的文本内容与行数；路径必须属于 allowedPaths 且非 protected。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'path', label: '相对路径', type: T },
    ],
    outputs: [
      { id: 'content', label: '内容', type: T },
      { id: 'lineCount', label: '行数', type: N },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'path', label: '相对路径（兜底）', type: 'text', default: '' },
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const path = str(inputs.path ?? params.path);
      if (!cwd || !path) throw nodeError('code.read 需要 worktreePath 与 path');
      const r = await service.codeRead(path, { cwd });
      return { content: r.content, lineCount: r.lineCount };
    },
  };

  const codePatch: NodeDefinition = {
    typeId: 'dev.code.patch',
    name: '应用代码补丁',
    category: DEV_CATEGORY,
    role: 'worker',
    whenToUse: '在 worktree 内以受控 unified diff 修改文件（禁整文件覆盖）。',
    description: '应用 unified diff 到 worktree 内文件；上下文不匹配或路径越权即失败（ok=false/抛错）。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'path', label: '相对路径', type: T },
      { id: 'patch', label: 'unified diff', type: T },
    ],
    outputs: [
      { id: 'ok', label: '应用成功', type: 'any' },
      { id: 'contentHash', label: '内容哈希', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'path', label: '相对路径（兜底）', type: 'text', default: '' },
      { key: 'patch', label: 'unified diff（兜底）', type: 'textarea', default: '' },
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const path = str(inputs.path ?? params.path);
      const patch = str(inputs.patch ?? params.patch);
      if (!cwd || !path || !patch) throw nodeError('code.patch 需要 worktreePath / path / patch');
      const r = await service.codePatch(path, patch, { cwd });
      if (!r.ok) throw nodeError(`补丁应用失败：${r.error ?? '未知错误'}`);
      return { ok: true, contentHash: r.contentHash ?? '' };
    },
  };

  const shellRun: NodeDefinition = {
    typeId: 'dev.shell.run',
    name: '执行只读命令',
    category: DEV_CATEGORY,
    role: 'worker',
    whenToUse: '在 worktree 内执行只读 shell 命令（命令与路径参数受白名单约束）。',
    description: '执行只读命令（如 git status/git diff/cat/ls）；命令白名单 + 路径参数守卫在 service 内强制。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'cmd', label: '命令（数组，如 ["git","status","--porcelain"]）', type: L },
    ],
    outputs: [
      { id: 'exitCode', label: '退出码', type: N },
      { id: 'stdout', label: '标准输出', type: T },
      { id: 'stderr', label: '标准错误', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'cmd', label: '命令数组 JSON（兜底，如 ["tsc","--noEmit"]）', type: 'textarea', default: '' },
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const cmd = strList(inputs.cmd ?? params.cmd);
      if (!cwd || cmd.length === 0) throw nodeError('shell.run 需要 worktreePath 与 cmd');
      const r = await service.shellRun(cmd, { cwd });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
  };

  const testRun: NodeDefinition = {
    typeId: 'dev.test.run',
    name: '运行测试/校验',
    category: DEV_CATEGORY,
    role: 'verifier',
    whenToUse: '在 worktree 内运行 typecheck / vitest 等测试命令（白名单内）。',
    description: '运行测试命令（tsc --noEmit / vitest run 等）；退出码与输出由宿主捕获，作为验收证据。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'cmd', label: '命令（数组，如 ["tsc","--noEmit"]）', type: L },
    ],
    outputs: [
      { id: 'exitCode', label: '退出码', type: N },
      { id: 'stdout', label: '标准输出', type: T },
      { id: 'stderr', label: '标准错误', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'cmd', label: '命令数组 JSON（兜底）', type: 'textarea', default: '' },
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const cmd = strList(inputs.cmd ?? params.cmd);
      if (!cwd || cmd.length === 0) throw nodeError('test.run 需要 worktreePath 与 cmd');
      const r = await service.testRun(cmd, { cwd });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
  };

  const gitStatus: NodeDefinition = {
    typeId: 'dev.git.status',
    name: 'Git 状态',
    category: DEV_CATEGORY,
    role: 'worker',
    whenToUse: '查看 worktree 内 git 状态（只读）。',
    description: '返回 `git status --porcelain` 输出（只读）。',
    inputs: [{ id: 'worktreePath', label: '工作区路径', type: T }],
    outputs: [{ id: 'stdout', label: '状态输出', type: T }],
    params: [{ key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' }],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      if (!cwd) throw nodeError('git.status 需要 worktreePath');
      const r = await service.gitStatus({ cwd });
      return { stdout: r.stdout };
    },
  };

  const gitDiff: NodeDefinition = {
    typeId: 'dev.git.diff',
    name: 'Git Diff',
    category: DEV_CATEGORY,
    role: 'worker',
    whenToUse: '查看 worktree 相对基线的 diff（只读，供人工审查）。',
    description: '返回 `git diff <baseRef>` 输出（只读；baseRef 留空则 diff HEAD）。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'baseRef', label: '基线（可空）', type: T },
    ],
    outputs: [{ id: 'stdout', label: 'diff 输出', type: T }],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'baseRef', label: '基线（兜底，可空）', type: 'text', default: '' },
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      if (!cwd) throw nodeError('git.diff 需要 worktreePath');
      const baseRef = str(inputs.baseRef ?? params.baseRef) || undefined;
      const r = await service.gitDiff(baseRef, { cwd });
      return { stdout: r.stdout };
    },
  };

  const evidenceAdd: NodeDefinition = {
    typeId: 'dev.evidence.add',
    name: '采集证据',
    category: DEV_CATEGORY,
    role: 'verifier',
    whenToUse: '自举任务每阶段完成时，把宿主采集的真实结果（测试退出码/diff/路径检查）写入 EvidenceStore。',
    description:
      '向 EvidenceCollector 追加一条证据（capturedBy 恒为 host）。字段由上游节点提供真实结果——模型/节点不得伪造。',
    inputs: [
      { id: 'orchestrationId', label: '编排 ID', type: T },
      { id: 'stageId', label: '阶段 ID', type: T },
      { id: 'kind', label: '证据类型（test/diff/command/path-policy/artifact）', type: T },
      { id: 'summary', label: '摘要', type: T },
      { id: 'exitCode', label: '退出码（可空）', type: N },
      { id: 'command', label: '命令（可空）', type: T },
    ],
    outputs: [{ id: 'evidenceId', label: '证据 ID', type: T }],
    params: [
      { key: 'orchestrationId', label: '编排 ID（兜底）', type: 'text', default: '' },
      { key: 'stageId', label: '阶段 ID（兜底）', type: 'text', default: '' },
      { key: 'kind', label: '证据类型（兜底）', type: 'text', default: '' },
      { key: 'summary', label: '摘要（兜底）', type: 'text', default: '' },
      { key: 'exitCode', label: '退出码（兜底）', type: 'number', default: '' },
      { key: 'command', label: '命令（兜底）', type: 'text', default: '' },
    ],
    async execute(inputs, params) {
      const kind = str(inputs.kind ?? params.kind) as EvidenceKind;
      if (!['command', 'test', 'diff', 'path-policy', 'artifact'].includes(kind)) {
        throw nodeError(`非法证据类型：${str(inputs.kind ?? params.kind)}`);
      }
      const rec = await collector.addAsync({
        orchestrationId: str(inputs.orchestrationId ?? params.orchestrationId),
        stageId: str(inputs.stageId ?? params.stageId),
        kind,
        status: 'passed',
        summary: str(inputs.summary ?? params.summary),
        command: str(inputs.command ?? params.command) || undefined,
        exitCode: num(inputs.exitCode ?? params.exitCode),
      });
      return { evidenceId: rec.id };
    },
  };

  const acceptNode: NodeDefinition = {
    typeId: 'dev.accept',
    name: '确定性验收',
    category: DEV_CATEGORY,
    role: 'verifier',
    whenToUse: '自举任务收尾：按验收规则 + 证据判定通过/失败（changedProtectedPaths 非空恒失败）。',
    description:
      '运行 evaluateDevAcceptance：所有规则满足且未触碰保护路径 → passed；否则列出 failedChecks。保护路径变更恒失败，需人工 diff 审查。',
    inputs: [
      { id: 'rules', label: '验收规则（JSON 数组）', type: J },
      { id: 'evidence', label: '证据（JSON 数组）', type: J },
      { id: 'changedProtectedPaths', label: '触碰的保护路径（JSON 数组）', type: J },
      { id: 'uncertainties', label: '不确定性（JSON 数组）', type: J },
    ],
    outputs: [
      { id: 'passed', label: '通过', type: 'any' },
      { id: 'failedChecks', label: '失败项', type: L },
      { id: 'requiredChecks', label: '必检项', type: L },
      { id: 'changedProtectedPaths', label: '保护路径变更', type: L },
    ],
    params: [
      { key: 'rules', label: '验收规则 JSON（兜底）', type: 'textarea', default: '' },
      { key: 'changedProtectedPaths', label: '保护路径变更（兜底）', type: 'textarea', default: '' },
      { key: 'uncertainties', label: '不确定性（兜底）', type: 'textarea', default: '' },
    ],
    async execute(inputs, params) {
      // evidence 缺省时用 DevSession collector 的宿主采集证据（保证真实，不靠模型自报）
      const rules = Array.isArray(inputs.rules) && inputs.rules.length > 0
        ? (inputs.rules as AcceptanceRule[])
        : parseJson<AcceptanceRule[]>(params.rules, []);
      const evidence = Array.isArray(inputs.evidence) && inputs.evidence.length > 0
        ? inputs.evidence
        : collector.toJSON();
      const changed = Array.isArray(inputs.changedProtectedPaths)
        ? inputs.changedProtectedPaths.map(String)
        : parseJson<string[]>(params.changedProtectedPaths, []).map(String);
      const uncertainties = Array.isArray(inputs.uncertainties)
        ? inputs.uncertainties.map(String)
        : parseJson<string[]>(params.uncertainties, []).map(String);
      const a = evaluateDevAcceptance(rules as AcceptanceRule[], evidence as never[], changed, uncertainties);
      return {
        passed: a.passed,
        failedChecks: a.failedChecks,
        requiredChecks: a.requiredChecks,
        changedProtectedPaths: a.changedProtectedPaths,
      };
    },
  };

  return [
    worktreeCreate,
    worktreeStatus,
    worktreeCleanup,
    codeRead,
    codePatch,
    shellRun,
    testRun,
    gitStatus,
    gitDiff,
    evidenceAdd,
    acceptNode,
  ];
}
