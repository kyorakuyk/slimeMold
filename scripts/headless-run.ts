/**
 * Headless CLI：在终端直接运行工作流，无需打开 GUI 窗口。
 *
 * 用法：
 *   npm run headless -- path/to/workflow.json
 *   npm run headless -- workflow.json --channel backend --vars '{"env":"prod"}'
 *
 * 说明：
 *  - workflow.json 需含 nodes / edges / agents（agents 缺失时退化为无 LLM 节点运行）。
 *  - LLM 节点在 headless 下走 ctx.llm 通道（默认 backend），需有效 API Key 与 Tauri 环境；
 *    纯本地节点（模板/表达式/流程控制/数据）无需任何外部依赖即可运行。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runWorkflowHeadless, type HeadlessNodeResult } from '../src/engine/headless';

interface WorkflowFile {
  nodes: any[];
  edges: any[];
  agents?: any[];
  roles?: any[];
  variables?: Record<string, unknown>;
}

function parseArgs(argv: string[]): { file: string; channel: 'backend' | 'frontend'; vars: Record<string, unknown> } {
  let file = '';
  let channel: 'backend' | 'frontend' = 'backend';
  let vars: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') channel = argv[++i] as any;
    else if (a === '--vars') vars = JSON.parse(argv[++i]);
    else if (!file) file = a;
  }
  if (!file) {
    console.error('用法: npm run headless -- <workflow.json> [--channel backend|frontend] [--vars \'{}\']');
    process.exit(1);
  }
  return { file, channel, vars };
}

/** 兼容新旧两种节点格式：旧版顶层 typeId/label/params，新版 data 包裹 */
function normalizeNode(n: any): any {
  if (n.data && n.data.typeId) return n;
  return {
    id: n.id,
    type: 'base',
    position: n.position ?? { x: 0, y: 0 },
    data: {
      typeId: n.typeId ?? n.type,
      label: n.label ?? n.typeId ?? n.type,
      params: n.params ?? {},
      status: 'idle',
    },
  };
}

async function main() {
  const { file, channel, vars } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(resolve(file), 'utf8');
  const wf: WorkflowFile = JSON.parse(raw);
  const nodes = (wf.nodes as any[]).map(normalizeNode);
  // H4 自举：工作流含 dev.* 节点时初始化 DevSession（worktree registry + 证据 + 开发能力）。
  // P0/P1 审计：cleanup 的宿主审批在**运行后**执行（见下方 hostCleanupApproval），
  // 因为 acceptanceId 由 accept 节点运行时由宿主生成——运行前无法绑定。
  if (nodes.some((n) => String(n.data?.typeId ?? '').startsWith('dev.'))) {
    const { createHostAcceptanceStoreWithFs, initDevSession } = await import('../src/dev/session');
    const { createHostEvidenceStore, createNodeJsonlFs } = await import('../src/dev/evidence');
    const { resolve } = await import('node:path');
    // H4 审计（P1）：宿主固定路径 EvidenceStore（.slimemold/evidence/host.jsonl，位于 worktree 外）——
    // forceCleanup 要求宿主持久化（无 persistence 拒绝强制清理），headless 宿主据此注入真实落盘；
    // 找不到 dev.worktree.create 声明的工作区路径时不注入（forceCleanup 不可用，但工作流正常跑）。
    const evidenceRoot = resolve(process.cwd(), '.slimemold', 'evidence');
    const declaredWt = nodes
      .map((n) =>
        String(n.data?.typeId ?? '') === 'dev.worktree.create' ? n.data?.params?.path : undefined,
      )
      .find((p): p is string => typeof p === 'string' && p.length > 0);
    const persistence = declaredWt
      ? createHostEvidenceStore(evidenceRoot, resolve(process.cwd(), declaredWt), 'host')
      : undefined;
    const acceptancePersistence = declaredWt
      ? createHostAcceptanceStoreWithFs(
        resolve(process.cwd(), '.slimemold', 'acceptance'),
        resolve(process.cwd(), declaredWt),
        'records',
        createNodeJsonlFs(),
      )
      : undefined;
    initDevSession({ baseRepoPath: process.cwd(), persistence, acceptancePersistence });
    console.log('▶ H4 自举模式：已初始化 DevSession（worktree 隔离 + 开发能力 + 证据采集，EvidenceStore=' + evidenceRoot + '）');
  }
  const edges = (wf.edges as any[]).map((e) => ({
    id: e.id ?? `e-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    // 保留边类型（data/task/control），否则 control 回流边会被误判成环
    data: { kind: e.data?.kind ?? e.kind ?? 'data' },
  }));

  console.log(`▶ 运行工作流 ${file}（${nodes.length} 节点 / ${edges.length} 边，通道=${channel}）`);

  const finalById = new Map<string, HeadlessNodeResult>();
  await runWorkflowHeadless(
    { nodes, edges },
    {
      agents: (wf.agents ?? []) as any,
      channel,
      vars: { ...(wf.variables ?? {}), ...vars },
      onNode: (r) => {
        finalById.set(r.id, r);
        const tag =
          r.status === 'success' ? '✓' :
          r.status === 'cached' ? '⚡' :
          r.status === 'skipped' ? '⊘' :
          r.status === 'error' ? '✗' : '·';
        console.log(`  ${tag} ${r.id} (${r.typeId}) ${r.status}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`);
        if (r.error) console.log(`     错误: ${r.error}`);
      },
    },
  );

  const final = [...finalById.values()];
  const failed = final.filter((r) => r.status === 'error');
  console.log(`\n完成：${final.length} 节点，成功 ${final.filter((r) => r.status === 'success').length}，缓存 ${final.filter((r) => r.status === 'cached').length}，跳过 ${final.filter((r) => r.status === 'skipped').length}，失败 ${failed.length}`);
  // P0/P1 审计：H4 宿主收尾——运行后批准清理（绑定通过验收 + 状态签名 + 基线），
  // 未找到通过验收的 worktree 拒绝清理（保留供审查）。节点/工作流无法伪造审批。
  await hostCleanupApproval(process.argv.slice(2));
  // 显式退出：simulate 节点的 setTimeout / 运行器内部句柄可能让事件循环不空，导致进程挂起不退出
  process.exit(failed.length > 0 ? 2 : 0);
}

/** 提取 CLI flag 值：支持 `--flag=value` 与 `--flag value` 两种形式（P2 审计）。 */
function flagValue(argv: string[], flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return undefined;
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * H4 宿主收尾清理（P1 审计）：
 * 对每个 --dev-approve-cleanup=<path>（支持等号/空格、逗号分隔）：
 * - 找到该 worktree 的**最新通过验收记录**（worktreePath 规范化匹配）→ 无则拒绝清理并保留；
 * - approveCleanup 绑定 acceptanceId + orchestrationId/stageId + stateSignature + baseRevision；
 * - manager.cleanup(confirm:true) 真实清理（清理后审批自动消费）。
 * 这等价于 GUI 里「验收通过 → 宿主确认清理」的 headless 宿主侧入口。
 */
async function hostCleanupApproval(argv: string[]): Promise<void> {
  const raw = flagValue(argv, '--dev-approve-cleanup');
  if (!raw) return;
  const { getDevSession } = await import('../src/dev/session');
  const s = getDevSession();
  if (!s) return;
  const paths = raw.split(',').map((x) => x.trim()).filter(Boolean);
  for (const p of paths) {
    const info = s.manager.get(p);
    if (!info) {
      console.log(`  ⊘ 跳过清理 ${p}：未登记 worktree`);
      continue;
    }
    const passed = [...s.acceptanceStore.values()]
      .filter((a) => a.passed && normPath(a.worktreePath) === normPath(p))
      .sort((a, b) => b.at.localeCompare(a.at));
    const acc = passed[0];
    if (!acc) {
      console.log(`  ⚠ 拒绝清理 ${p}：未找到通过验收记录（保留 worktree 供审查）`);
      continue;
    }
    const sig = await s.computeWorktreeSignature(p);
    s.approveCleanup(p, {
      acceptanceId: acc.acceptanceId,
      orchestrationId: acc.orchestrationId,
      stageId: acc.stageId,
      stateSignature: sig,
      baseRevision: info.baseRevision,
    });
    // P1（审计）：收口到宿主原子确认 API——confirmAndCleanup 内部重新校验
    // 验收三元组 + 重算状态签名 + 基线 + 清理 + 消费（消除 TOCTOU 窗口）。
    const cleaned = await s.confirmAndCleanup(p);
    if (cleaned) {
      console.log(`  ✔ 宿主批准并清理 worktree：${p}（绑定验收 ${acc.acceptanceId}）`);
    } else {
      console.log(`  ⊘ 清理失败：${p}`);
    }
  }
}

main().catch((e) => {
  console.error('运行失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
