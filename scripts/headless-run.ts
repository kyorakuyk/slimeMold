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
  // P0 审计：cleanup 的人工确认只能由宿主生成——CLI flag --dev-approve-cleanup=<path> 是 headless
  // 场景的宿主审批入口（对应 GUI 的 approveCleanup），节点参数无法伪造。
  if (nodes.some((n) => String(n.data?.typeId ?? '').startsWith('dev.'))) {
    const { initDevSession, getDevSession } = await import('../src/dev/session');
    initDevSession({ baseRepoPath: process.cwd() });
    // P0/P1 审计：cleanup 的人工确认只能由宿主生成——CLI flag 是 headless 场景的宿主审批入口
    // （对应 GUI 的 approveCleanup），节点参数无法伪造；可选 --dev-acceptance-id 绑定验收记录
    // （cleanup 确认门校验：对应验收必须 passed 且 worktreePath 一致）。
    const flagIdx = process.argv.indexOf('--dev-approve-cleanup');
    if (flagIdx >= 0 && process.argv[flagIdx + 1]) {
      const s = getDevSession();
      const accIdx = process.argv.indexOf('--dev-acceptance-id');
      const acceptanceId = accIdx >= 0 && process.argv[accIdx + 1] ? process.argv[accIdx + 1] : undefined;
      for (const p of process.argv[flagIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)) {
        s?.approveCleanup(resolve(p), acceptanceId ? { acceptanceId } : undefined);
        console.log(`  ✔ 宿主已批准清理 worktree：${p}${acceptanceId ? `（绑定验收 ${acceptanceId}）` : ''}`);
      }
    }
    console.log('▶ H4 自举模式：已初始化 DevSession（worktree 隔离 + 开发能力 + 证据采集）');
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
  // 显式退出：simulate 节点的 setTimeout / 运行器内部句柄可能让事件循环不空，导致进程挂起不退出
  process.exit(failed.length > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error('运行失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
