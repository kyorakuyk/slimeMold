import type {
  FlowEdge,
  FlowNode,
  NodeDefinition,
  WorkflowFile,
} from '../types';
import { isTauri } from '../platform/env';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';

function log(level: 'info' | 'error', message: string): void {
  useWorkflowStore.getState().addLog(level, message);
}

/* ---------- 序列化 ---------- */
export function serializeWorkflow(): WorkflowFile {
  const s = useWorkflowStore.getState();
  return {
    version: 1,
    name: s.workflowName,
    savedAt: new Date().toISOString(),
    nodes: s.nodes.map((n) => ({
      id: n.id,
      typeId: n.data.typeId,
      label: n.data.label,
      position: n.position,
      params: n.data.params,
    })),
    edges: s.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      targetHandle: e.targetHandle ?? null,
    })),
    agents: s.agents,
  };
}

/* ---------- 反序列化与校验 ---------- */
export function applyWorkflowFile(text: string): void {
  const raw = JSON.parse(text) as WorkflowFile;
  if (raw.version !== 1) {
    throw new Error(`不支持的工作流版本: ${String(raw.version)}`);
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error('工作流文件缺少 nodes/edges');
  }

  // 缺失节点类型 -> 注册占位定义，保证图可打开
  const registry = useRegistryStore.getState();
  const missingDefs: NodeDefinition[] = [];
  for (const n of raw.nodes) {
    if (!registry.defs[n.typeId] && !missingDefs.some((d) => d.typeId === n.typeId)) {
      missingDefs.push({
        typeId: n.typeId,
        name: `缺失: ${n.typeId}`,
        category: '缺失类型',
        description: '该节点类型未注册，可能来自未加载的插件',
        inputs: [],
        outputs: [],
        params: [],
        missing: true,
        async execute() {
          throw new Error(`节点类型 ${n.typeId} 缺失`);
        },
      });
    }
  }
  if (missingDefs.length > 0) {
    registry.register(missingDefs);
    log('error', `有 ${missingDefs.length} 种节点类型缺失，已用占位节点显示`);
  }

  const nodes: FlowNode[] = raw.nodes.map((n) => ({
    id: n.id,
    type: 'base',
    position: n.position,
    data: {
      typeId: n.typeId,
      label: n.label,
      params: n.params ?? {},
      status: 'idle',
    },
  }));
  const edges: FlowEdge[] = raw.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
  }));

  useWorkflowStore
    .getState()
    .loadGraph(raw.name || '导入的工作流', nodes, edges, raw.agents ?? []);
  log('info', `工作流已导入：${raw.name}（${nodes.length} 节点 / ${edges.length} 连线）`);
}

/* ---------- 导出 ---------- */
export async function exportWorkflow(): Promise<void> {
  const wf = serializeWorkflow();
  const text = JSON.stringify(wf, null, 2);
  const fileName = `${wf.name || 'workflow'}.workflow.json`;

  if (isTauri) {
    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');
    const path = await dialog.save({
      defaultPath: fileName,
      filters: [{ name: '工作流文件', extensions: ['json'] }],
    });
    if (!path) return;
    await fs.writeTextFile(path, text);
    log('info', `工作流已导出：${path}`);
    return;
  }

  // 浏览器模式：Blob 下载
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  log('info', `工作流已导出：${fileName}`);
}

/* ---------- 导入 ---------- */
export async function importWorkflow(): Promise<void> {
  if (isTauri) {
    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');
    const path = await dialog.open({
      multiple: false,
      filters: [{ name: '工作流文件', extensions: ['json'] }],
    });
    if (typeof path !== 'string') return;
    const text = await fs.readTextFile(path);
    applyWorkflowFile(text);
    return;
  }

  // 浏览器模式：文件选择器
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    applyWorkflowFile(text);
  };
  input.click();
}
