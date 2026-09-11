/**
 * H4 开发节点薄封装（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §3/§7）。
 *
 * 把 DevCapabilityService / WorktreeManager / EvidenceCollector / DevEvaluator 暴露为工作流节点，
 * 供 headless 自举工作流（第一轮低风险自举任务）编排。节点只是能力的薄封装：
 * - 路径/命令/cwd 约束全部收敛在 service（fail-closed：cwd 必须属于已登记 worktree）；
 * - 节点 execute 内不重复实现安全检查；
 * - GUI（WebView）下 DevSession 未初始化 → execute 抛错（shim/fail-closed 兜底），节点失败。
 */
import type { NodeDefinition, ParamType, PortType } from '../../types';
import { evaluateDevAcceptance, type AcceptanceRule } from '../../dev/evaluator';
import type { DevSession } from '../../dev/session';
import { collectChangedProtectedPaths } from '../../dev/policy';
import { assertTaskExecutionLineage } from '../../domain/execution';
import { applyFilePatchSet } from '../../dev/patch-set';
import { workerBranchForPath } from '../../dev/worktree';

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

/** 规范化路径（POSIX 分隔符、去尾 /；作用域一致性比较用）。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
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

let resultSeq = 0;
/** 生成宿主登记结果 ID。 */
function nextResultId(): string {
  resultSeq += 1;
  return `hr-${Date.now().toString(36)}-${resultSeq.toString(36)}`;
}

/** 三个执行作用域端口的标准定义（登记宿主结果必须绑定任务/阶段/工作区）。 */
const SCOPE_INPUTS: { id: string; label: string; type: PortType }[] = [
  { id: 'orchestrationId', label: '编排 ID', type: T },
  { id: 'stageId', label: '阶段 ID', type: T },
];

const SCOPE_PARAMS: { key: string; label: string; type: ParamType; default: string }[] = [
  { key: 'orchestrationId', label: '编排 ID（兜底）', type: 'text', default: '' },
  { key: 'stageId', label: '阶段 ID（兜底）', type: 'text', default: '' },
];

/**
 * 从输入/参数读取执行作用域（orchestrationId/stageId）。
 * P1（审计）：**必填**——登记宿主结果必须有任务与阶段身份，缺失即抛错，
 * 保证无作用域的结果不存在（不可被任意编排/阶段引用）。
 */
function scopeOf(inputs: Record<string, unknown>, params: Record<string, unknown>): {
  orchestrationId: string;
  stageId: string;
} {
  const orchestrationId = str(inputs.orchestrationId ?? params.orchestrationId);
  const stageId = str(inputs.stageId ?? params.stageId);
  if (!orchestrationId || !stageId) {
    throw nodeError('执行节点需要 orchestrationId 与 stageId（宿主结果必须绑定任务与阶段）');
  }
  return { orchestrationId, stageId };
}

/**
 * 生成开发节点定义（绑定到给定 session）。
 * 节点 execute 只做「薄封装」——安全检查全部下沉 service/manager/collector。
 * P0 审计语义：执行节点把真实结果登记进 session.resultStore 并输出 resultId；
 * evidence.add 只能引用这些宿主登记结果（不允许节点自填 status/summary/exitCode）。
 */
export function createDevNodeDefs(session: DevSession): NodeDefinition[] {
  const { manager, service, collector, resultStore } = session;

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
      const info = await manager.create(path, path, { branch: workerBranchForPath(path) }); // 登记 id 即路径（cleanup/status 按 path 引用）
      // 审计修复：create 失败（git worktree add 返回非零，如残留 worktree 冲突）必须**显式抛错**，
      // 而不是返回 { ok:false } 被当作 success——否则后续节点会连锁报「不属于已登记 worktree」，
      // 掩盖真实根因。fail-closed：未成功登记即节点失败。
      if (!info) {
        throw nodeError(
          `worktree.create 失败：git worktree add 未成功（${path}）。` +
            '可能原因：该路径已被占用（残留 worktree / 非空目录）、主仓库非 git 仓库或 git 不可用。' +
            '清理残留：git worktree prune --expire now 或删除冲突路径后重试。',
        );
      }
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
    whenToUse: '自举任务收尾：宿主已批准清理（approveCleanup 绑定验收+状态签名）时清理 worktree。',
    description:
      '清理 worktree 并删除临时分支。P0/P1 审计：正常清理必须满足——① 审批存在未消费（仅宿主'
      + ' approveCleanup 生成，节点不可伪造）；② 绑定 baseRevision 且与当前基线一致；③ 绑定 '
      + 'stateSignature 且当前状态签名一致（防 worktree 被再次修改）；④ 绑定 acceptanceId 且对应'
      + ' 验收 passed、worktreePath 一致。缺任一绑定或校验失败 → 拒绝（防验收前强制删除未提交改动）。'
      + ' 强制清理走宿主 forceCleanup 高风险 API（须人工 reason），节点不可触达。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'after', label: '触发（忽略值，仅排序依赖）', type: T },
    ],
    outputs: [{ id: 'cleaned', label: '已清理', type: 'any' }],
    params: [{ key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' }],
    async execute(inputs, params) {
      const path = str(inputs.worktreePath ?? params.worktreePath);
      if (!path) throw nodeError('worktree.cleanup 需要 worktreePath');
      // P1（审计）：收口到宿主原子确认 API——验收校验 + 签名重算 + 基线校验 + 清理 + 消费
      // 全部在 confirmAndCleanup 内完成，消除「算签名→删除」之间的 TOCTOU 窗口。
      const cleaned = await session.confirmAndCleanup(path);
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
      ...SCOPE_INPUTS,
    ],
    outputs: [
      { id: 'ok', label: '应用成功', type: 'any' },
      { id: 'contentHash', label: '内容哈希', type: T },
      { id: 'resultId', label: '宿主结果 ID', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'path', label: '相对路径（兜底）', type: 'text', default: '' },
      { key: 'patch', label: 'unified diff（兜底）', type: 'textarea', default: '' },
      ...SCOPE_PARAMS,
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const path = str(inputs.path ?? params.path);
      const patch = str(inputs.patch ?? params.patch);
      if (!cwd || !path || !patch) throw nodeError('code.patch 需要 worktreePath / path / patch');
      // P1（审计）：登记前先校验作用域必填（缺任务/阶段 → 抛错，结果不可无归属）
      const scope = scopeOf(inputs, params);
      const r = await service.codePatch(path, patch, { cwd });
      if (!r.ok) throw nodeError(`补丁应用失败：${r.error ?? '未知错误'}`);
      // P0：登记宿主 diff 结果（status=passed 由补丁成功这一事实决定），供 evidence.add 引用
      const resultId = nextResultId();
      resultStore.set(resultId, {
        resultId,
        kind: 'diff',
        status: 'passed',
        contentHash: r.contentHash,
        summary: `已对 ${path} 应用受控 unified diff（${(patch.match(/^\+/gm) ?? []).length} 行新增）`,
        worktreePath: cwd,
        orchestrationId: scope.orchestrationId,
        stageId: scope.stageId,
      });
      return { ok: true, contentHash: r.contentHash ?? '', resultId };
    },
  };

  const patchSetApply: NodeDefinition = {
    typeId: 'dev.patch.apply',
    name: '应用文件补丁集',
    category: DEV_CATEGORY,
    role: 'worker',
    minCapability: 'sandbox_write',
    whenToUse: '将 worker 或 project.scaffold 生成的结构化补丁候选应用到当前已登记 worktree。',
    description:
      '先核对补丁集所有文件的前置内容，再通过宿主受控 code.patch 逐文件应用并 read-back；任何漂移或写入失败都阻断节点，不返回伪造成功。',
    inputs: [
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'patchSet', label: '结构化文件补丁集', type: J },
      ...SCOPE_INPUTS,
    ],
    outputs: [
      { id: 'appliedPaths', label: '已应用文件', type: L },
      { id: 'contentHashes', label: '内容哈希', type: J },
      { id: 'resultId', label: '宿主结果 ID', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'patchSet', label: '结构化文件补丁集 JSON（兜底）', type: 'textarea', default: '' },
      ...SCOPE_PARAMS,
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      if (!cwd) throw nodeError('patch.apply 需要 worktreePath');
      const scope = scopeOf(inputs, params);
      const rawPatchSet = inputs.patchSet ?? params.patchSet;
      const patchSet = parseJson<unknown>(rawPatchSet, null);
      if (!patchSet) throw nodeError('patch.apply 需要结构化 patchSet');
      const result = await applyFilePatchSet(patchSet, service, { cwd });
      const resultId = nextResultId();
      session.registerResult({
        resultId,
        kind: 'artifact',
        status: 'passed',
        summary: `宿主已应用 ${result.appliedPaths.length} 个结构化文件补丁`,
        worktreePath: cwd,
        orchestrationId: scope.orchestrationId,
        stageId: scope.stageId,
      });
      return { ...result, resultId };
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
      ...SCOPE_INPUTS,
    ],
    outputs: [
      { id: 'exitCode', label: '退出码', type: N },
      { id: 'stdout', label: '标准输出', type: T },
      { id: 'stderr', label: '标准错误', type: T },
      { id: 'resultId', label: '宿主结果 ID', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'cmd', label: '命令数组 JSON（兜底，如 ["tsc","--noEmit"]）', type: 'textarea', default: '' },
      ...SCOPE_PARAMS,
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const cmd = strList(inputs.cmd ?? params.cmd);
      if (!cwd || cmd.length === 0) throw nodeError('shell.run 需要 worktreePath 与 cmd');
      const scope = scopeOf(inputs, params);
      const r = await service.shellRun(cmd, { cwd });
      // P0：登记宿主真实执行结果（status 由 exitCode 决定），供 evidence.add 引用
      const resultId = nextResultId();
      resultStore.set(resultId, {
        resultId,
        kind: 'command',
        status: r.exitCode === 0 ? 'passed' : 'failed',
        exitCode: r.exitCode,
        command: cmd.join(' '),
        summary: `${cmd[0]} ${cmd.slice(1).join(' ')} 退出码 ${r.exitCode}`,
        worktreePath: cwd,
        orchestrationId: scope.orchestrationId,
        stageId: scope.stageId,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, resultId };
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
      ...SCOPE_INPUTS,
    ],
    outputs: [
      { id: 'exitCode', label: '退出码', type: N },
      { id: 'stdout', label: '标准输出', type: T },
      { id: 'stderr', label: '标准错误', type: T },
      { id: 'resultId', label: '宿主结果 ID', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'cmd', label: '命令数组 JSON（兜底）', type: 'textarea', default: '' },
      ...SCOPE_PARAMS,
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const cmd = strList(inputs.cmd ?? params.cmd);
      if (!cwd || cmd.length === 0) throw nodeError('test.run 需要 worktreePath 与 cmd');
      const scope = scopeOf(inputs, params);
      const r = await service.testRun(cmd, { cwd });
      // P0：登记宿主真实测试结果（status 由真实 exitCode 决定），供 evidence.add 引用
      const resultId = nextResultId();
      resultStore.set(resultId, {
        resultId,
        kind: 'test',
        status: r.exitCode === 0 ? 'passed' : 'failed',
        exitCode: r.exitCode,
        command: cmd.join(' '),
        summary: `${cmd[0]} ${cmd.slice(1).join(' ')} 退出码 ${r.exitCode}`,
        worktreePath: cwd,
        orchestrationId: scope.orchestrationId,
        stageId: scope.stageId,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, resultId };
    },
  };

  const gitStatus: NodeDefinition = {
    typeId: 'dev.git.status',
    name: 'Git 状态',
    category: DEV_CATEGORY,
    role: 'worker',
    whenToUse: '查看 worktree 内 git 状态（只读）。',
    description: '返回 `git status --porcelain` 输出（只读）。',
    inputs: [{ id: 'worktreePath', label: '工作区路径', type: T }, ...SCOPE_INPUTS],
    outputs: [
      { id: 'stdout', label: '状态输出', type: T },
      { id: 'resultId', label: '宿主结果 ID', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      ...SCOPE_PARAMS,
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      if (!cwd) throw nodeError('git.status 需要 worktreePath');
      const scope = scopeOf(inputs, params);
      const r = await service.gitStatus({ cwd });
      const resultId = nextResultId();
      // P1（审计）：git 命令可能失败——status 按真实 exitCode 判定，不能无条件 passed
      resultStore.set(resultId, {
        resultId,
        kind: 'command',
        status: r.exitCode === 0 ? 'passed' : 'failed',
        exitCode: r.exitCode,
        command: 'git status --porcelain',
        summary: r.exitCode === 0 ? 'git status 执行完成' : `git status 失败（退出码 ${r.exitCode}）`,
        worktreePath: cwd,
        orchestrationId: scope.orchestrationId,
        stageId: scope.stageId,
      });
      return { stdout: r.stdout, resultId };
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
      { id: 'after', label: '触发（忽略值，仅排序依赖）', type: T },
      ...SCOPE_INPUTS,
    ],
    outputs: [
      { id: 'stdout', label: 'diff 输出', type: T },
      { id: 'resultId', label: '宿主结果 ID', type: T },
    ],
    params: [
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'baseRef', label: '基线（兜底，可空）', type: 'text', default: '' },
      ...SCOPE_PARAMS,
    ],
    async execute(inputs, params) {
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      if (!cwd) throw nodeError('git.diff 需要 worktreePath');
      const scope = scopeOf(inputs, params);
      const baseRef = str(inputs.baseRef ?? params.baseRef) || undefined;
      const r = await service.gitDiff(baseRef, { cwd });
      // P1 修复：git diff 无改动时退出码也是 0，但必须有实际变更才算 passed——
      // 空 diff 登记为 failed，evaluator 的 diff 规则（存在 passed 证据）才不会误通过。
      const hasChange = r.exitCode === 0 && r.stdout.trim().length > 0;
      const resultId = nextResultId();
      resultStore.set(resultId, {
        resultId,
        kind: 'diff',
        status: hasChange ? 'passed' : 'failed',
        exitCode: r.exitCode,
        command: `git diff ${baseRef ?? 'HEAD'}`,
        summary: hasChange ? '存在未提交 diff' : '无 diff 改动（空 diff 不通过验收）',
        worktreePath: cwd,
        orchestrationId: scope.orchestrationId,
        stageId: scope.stageId,
      });
      return { stdout: r.stdout, resultId };
    },
  };

  const evidenceAdd: NodeDefinition = {
    typeId: 'dev.evidence.add',
    name: '采集证据',
    category: DEV_CATEGORY,
    role: 'verifier',
    whenToUse: '自举任务每阶段完成时，把宿主登记的**真实执行结果**（resultId）写入 EvidenceStore。',
    description:
      '向 EvidenceCollector 追加一条证据（capturedBy 恒为 host）。P0 审计：只能引用宿主登记的 '
      + 'resultId（dev.shell/test/git/code.patch 执行后登记），status/summary/exitCode 全部取自宿主'
      + '真实结果——节点/工作流无法伪造「测试通过/diff 完成」证据。',
    inputs: [
      { id: 'orchestrationId', label: '编排 ID', type: T },
      { id: 'stageId', label: '阶段 ID', type: T },
      { id: 'resultId', label: '宿主结果 ID（来自 dev.* 执行节点）', type: T },
      { id: 'worktreePath', label: '工作区路径（作用域校验）', type: T },
      { id: 'runId', label: 'Worker Run ID（可选）', type: T },
      { id: 'taskId', label: 'Worker Task ID（可选）', type: T },
      { id: 'taskExecutionId', label: 'Task Execution ID（可选）', type: T },
      { id: 'attemptId', label: 'Attempt ID（可选）', type: T },
    ],
    outputs: [{ id: 'evidenceId', label: '证据 ID', type: T }],
    params: [
      { key: 'orchestrationId', label: '编排 ID（兜底）', type: 'text', default: '' },
      { key: 'stageId', label: '阶段 ID（兜底）', type: 'text', default: '' },
      { key: 'resultId', label: '宿主结果 ID（兜底）', type: 'text', default: '' },
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'runId', label: 'Worker Run ID（兜底）', type: 'text', default: '' },
      { key: 'taskId', label: 'Worker Task ID（兜底）', type: 'text', default: '' },
      { key: 'taskExecutionId', label: 'Task Execution ID（兜底）', type: 'text', default: '' },
      { key: 'attemptId', label: 'Attempt ID（兜底）', type: 'text', default: '' },
    ],
    async execute(inputs, params) {
      const orchestrationId = str(inputs.orchestrationId ?? params.orchestrationId);
      const stageId = str(inputs.stageId ?? params.stageId);
      const resultId = str(inputs.resultId ?? params.resultId);
      const worktreePath = str(inputs.worktreePath ?? params.worktreePath);
      const runId = str(inputs.runId ?? params.runId);
      const taskId = str(inputs.taskId ?? params.taskId);
      const taskExecutionId = str(inputs.taskExecutionId ?? params.taskExecutionId);
      const attemptId = str(inputs.attemptId ?? params.attemptId);
      const lineageValues = [runId, taskId, taskExecutionId, attemptId];
      const hasLineage = lineageValues.some(Boolean);
      if (hasLineage && lineageValues.some((value) => !value)) {
        throw nodeError('evidence.add 的 Worker lineage 必须四项完整');
      }
      if (hasLineage) assertTaskExecutionLineage({ runId, taskId, taskExecutionId, attemptId });
      if (!orchestrationId || !stageId) throw nodeError('evidence.add 需要 orchestrationId 与 stageId');
      if (!resultId) throw nodeError('evidence.add 需要引用宿主结果 resultId');
      // P0：从宿主登记表取真实结果；不存在（伪造/过期 resultId）→ 拒绝
      const host = resultStore.get(resultId);
      if (!host) throw nodeError(`引用的宿主结果不存在：${resultId}（证据必须来自真实执行）`);
      // P1（审计）：作用域必填 + 非条件式校验——host 三项必填（登记时已强制），
      // 只要不一致即拒绝（无「可选字段跳过」路径）。
      if (normalizePath(host.worktreePath) !== normalizePath(worktreePath || '')) {
        throw nodeError(
          `引用的宿主结果不属于当前 worktree：${host.worktreePath} ≠ ${worktreePath}`,
        );
      }
      if (host.orchestrationId !== orchestrationId) {
        throw nodeError(
          `引用的宿主结果不属于当前编排：${host.orchestrationId} ≠ ${orchestrationId}（禁止跨任务引用证据）`,
        );
      }
      if (host.stageId !== stageId) {
        throw nodeError(`引用的宿主结果不属于当前阶段：${host.stageId} ≠ ${stageId}`);
      }
      const rec = await collector.addAsync({
        orchestrationId,
        stageId,
        worktreePath,
        kind: host.kind,
        status: host.status,
        summary: host.summary,
        command: host.command,
        exitCode: host.exitCode,
        contentHash: host.contentHash,
        ...(hasLineage ? { runId, taskId, taskExecutionId, attemptId } : {}),
      });
      return { evidenceId: rec.id };
    },
  };

  const acceptNode: NodeDefinition = {
    typeId: 'dev.accept',
    name: '确定性验收',
    category: DEV_CATEGORY,
    role: 'verifier',
    whenToUse: '自举任务收尾：按验收规则 + 宿主证据判定通过/失败（changedProtectedPaths 非空恒失败）。',
    description:
      '运行 evaluateDevAcceptance。P0/P1 审计：证据**只读当前任务/阶段/工作区作用域内**的宿主采集证据'
      + '（flushAndByScope，不接受外部覆盖，防跨任务串证据）；changedProtectedPaths 由宿主真实'
      + ' gitChangedFiles() × policy 计算（不接受输入伪造）。保护路径变更恒失败，需人工 diff 审查。',
    inputs: [
      { id: 'orchestrationId', label: '编排 ID', type: T },
      { id: 'stageId', label: '阶段 ID', type: T },
      { id: 'worktreePath', label: '工作区路径', type: T },
      { id: 'runId', label: 'Worker Run ID（可选）', type: T },
      { id: 'taskId', label: 'Worker Task ID（可选）', type: T },
      { id: 'taskExecutionId', label: 'Task Execution ID（可选）', type: T },
      { id: 'attemptId', label: 'Attempt ID（可选）', type: T },
      { id: 'rules', label: '验收规则（JSON 数组）', type: J },
    ],
    outputs: [
      { id: 'passed', label: '通过', type: 'any' },
      { id: 'failedChecks', label: '失败项', type: L },
      { id: 'requiredChecks', label: '必检项', type: L },
      { id: 'changedProtectedPaths', label: '保护路径变更', type: L },
      { id: 'acceptanceId', label: '验收记录 ID', type: T },
    ],
    params: [
      { key: 'orchestrationId', label: '编排 ID（兜底）', type: 'text', default: '' },
      { key: 'stageId', label: '阶段 ID（兜底）', type: 'text', default: '' },
      { key: 'worktreePath', label: '工作区路径（兜底）', type: 'text', default: '' },
      { key: 'runId', label: 'Worker Run ID（兜底）', type: 'text', default: '' },
      { key: 'taskId', label: 'Worker Task ID（兜底）', type: 'text', default: '' },
      { key: 'taskExecutionId', label: 'Task Execution ID（兜底）', type: 'text', default: '' },
      { key: 'attemptId', label: 'Attempt ID（兜底）', type: 'text', default: '' },
      { key: 'rules', label: '验收规则 JSON（兜底）', type: 'textarea', default: '' },
    ],
    async execute(inputs, params) {
      const orchestrationId = str(inputs.orchestrationId ?? params.orchestrationId);
      const stageId = str(inputs.stageId ?? params.stageId);
      const cwd = str(inputs.worktreePath ?? params.worktreePath);
      const runId = str(inputs.runId ?? params.runId);
      const taskId = str(inputs.taskId ?? params.taskId);
      const taskExecutionId = str(inputs.taskExecutionId ?? params.taskExecutionId);
      const attemptId = str(inputs.attemptId ?? params.attemptId);
      if (!cwd) throw nodeError('accept 需要 worktreePath');
      const lineageValues = [runId, taskId, taskExecutionId, attemptId];
      const hasLineage = lineageValues.some(Boolean);
      if (hasLineage && lineageValues.some((value) => !value)) {
        throw nodeError('accept 的 Worker lineage 必须四项完整');
      }
      if (hasLineage) assertTaskExecutionLineage({ runId, taskId, taskExecutionId, attemptId });
      if (!collector.hasPersistence()) {
        throw nodeError('accept 需要宿主 EvidenceStore 持久化，拒绝使用仅内存 Evidence');
      }
      // P1（审计）：验收 ID 始终由宿主生成（不可预测唯一），工作流/节点不可自填——
      // 防止指定已有 ID 覆盖旧验收记录（recordAcceptance 亦禁止覆盖）。
      const acceptanceId = session.nextAcceptanceId();
      const rules = Array.isArray(inputs.rules) && inputs.rules.length > 0
        ? (inputs.rules as AcceptanceRule[])
        : parseJson<AcceptanceRule[]>(params.rules, []);
      // P0/P1：证据按当前任务+阶段+工作区作用域过滤，且验收前强制 flush（落盘失败 throw）
      const evidence = await collector.flushAndByScope({
        orchestrationId,
        stageId,
        worktreePath: cwd,
        ...(hasLineage ? { taskExecutionId, attemptId } : {}),
      });
      if (!hasLineage) {
        const attemptKeys = new Set(evidence.map((record) => record.attemptId).filter(Boolean));
        if (attemptKeys.size > 1) throw nodeError('accept 证据混入多个 Worker attempt，必须提供当前 lineage');
      }
      // P0：changedProtectedPaths 由宿主真实计算（gitChangedFiles × policy），不接受输入
      const changedFiles = await service.gitChangedFiles({ cwd });
      const changed = collectChangedProtectedPaths(session.policy, changedFiles);
      const a = evaluateDevAcceptance(rules as AcceptanceRule[], evidence as never[], changed);
      // P1（审计）：登记确定性验收记录（cleanup 确认门校验 passed + worktreePath 一致）
      const acceptance = session.recordAcceptance({
        acceptanceId,
        orchestrationId,
        stageId,
        worktreePath: cwd,
        passed: a.passed,
        failedChecks: a.failedChecks,
        at: new Date().toISOString(),
        ...(hasLineage ? { runId, taskId, taskExecutionId, attemptId } : {}),
      });
      await session.persistAcceptance(acceptance);
      if (!a.passed) {
        throw nodeError(`Acceptance 未通过：${a.failedChecks.join('、') || '未知检查失败'}（${acceptanceId}）`);
      }
      return {
        passed: a.passed,
        failedChecks: a.failedChecks,
        requiredChecks: a.requiredChecks,
        changedProtectedPaths: a.changedProtectedPaths,
        acceptanceId,
      };
    },
  };

  return [
    worktreeCreate,
    worktreeStatus,
    worktreeCleanup,
    codeRead,
    codePatch,
    patchSetApply,
    shellRun,
    testRun,
    gitStatus,
    gitDiff,
    evidenceAdd,
    acceptNode,
  ];
}
