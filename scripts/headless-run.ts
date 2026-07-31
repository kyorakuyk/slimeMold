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

async function main() {
  const { file, channel, vars } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(resolve(file), 'utf8');
  const wf: WorkflowFile = JSON.parse(raw);

  console.log(`▶ 运行工作流 ${file}（${wf.nodes.length} 节点 / ${wf.edges.length} 边，通道=${channel}）`);

  const finalById = new Map<string, HeadlessNodeResult>();
  await runWorkflowHeadless({
    nodes: wf.nodes,
    edges: wf.edges,
    agents: wf.agents ?? [],
    roles: wf.roles ?? [],
    variables: { ...(wf.variables ?? {}), ...vars },
    channel,
    onNode: (r) => {
      finalById.set(r.nodeId, r);
      const tag =
        r.status === 'success' ? '✓' :
        r.status === 'cached' ? '⚡' :
        r.status === 'skipped' ? '⊘' :
        r.status === 'error' ? '✗' : '·';
      console.log(`  ${tag} ${r.nodeId} (${r.typeId}) ${r.status}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`);
      if (r.error) console.log(`     错误: ${r.error}`);
    },
  });

  const final = [...finalById.values()];
  const failed = final.filter((r) => r.status === 'error');
  console.log(`\n完成：${final.length} 节点，成功 ${final.filter((r) => r.status === 'success').length}，缓存 ${final.filter((r) => r.status === 'cached').length}，跳过 ${final.filter((r) => r.status === 'skipped').length}，失败 ${failed.length}`);
  if (failed.length > 0) process.exit(2);
}

main().catch((e) => {
  console.error('运行失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
