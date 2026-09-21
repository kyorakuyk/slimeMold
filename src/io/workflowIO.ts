import type { FlowEdge, FlowNode, NodeDefinition, WorkflowFile } from '../types';
import type { EdgeKind } from '../types/graph';
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
      kind: e.data?.kind ?? 'data',
      scope: e.data?.scope,
    })),
    // Step 0.5-c：序列化时剥离明文 apiKey，只保留 credentialKey（密钥库键）。
    // 即便某 agent 仍带着 apiKey 字段，导出文件也不应持久化明文密钥。
    agents: s.agents.map(({ apiKey: _drop, ...rest }) => rest),
    roles: s.roles,
    variables: s.variables,
  };
}

/* ---------- 反序列化与校验 ---------- */
export function applyWorkflowFile(text: string, standalonePath?: string): void {
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
  const missingTypeIds: string[] = [];
  // 约定：custom node 的 typeId 通常含 '/'（命名空间，如 myPack/myNode）或带驼峰/下划线组合，
  // 这类最可能是「用户自定义节点未加载」，给出针对性提示而非笼统「未注册」。
  const looksLikeCustom = (t: string) => /[/]/.test(t) || /[A-Z]/.test(t) || /_/.test(t);
  for (const n of raw.nodes) {
    const known = !!registry.defs[n.typeId] ||
      Object.keys(registry.defs).some((k) => k.toLowerCase() === n.typeId.toLowerCase());
    if (!known && !missingDefs.some((d) => d.typeId === n.typeId)) {
      missingTypeIds.push(n.typeId);
      const isCustom = looksLikeCustom(n.typeId);
      const hint = isCustom
        ? '疑似自定义节点（custom node）：请到「插件面板」点「扫描自定义节点」，或将对应节点包放入程序目录/custom_nodes（全局）或当前项目/custom_nodes（仅本项目）后重新打开。'
        : '该类型不属于内置节点，可能来自尚未加载的插件。';
      missingDefs.push({
        typeId: n.typeId,
        name: `缺失: ${n.typeId}`,
        category: '缺失类型',
        description: `节点类型未注册。${hint}`,
        inputs: [],
        outputs: [],
        params: [],
        missing: true,
        async execute() {
          throw new Error(`节点类型 ${n.typeId} 缺失，无法执行。${hint}`);
        },
      });
    }
  }
  if (missingDefs.length > 0) {
    registry.register(missingDefs);
    const customCount = missingTypeIds.filter(looksLikeCustom).length;
    const detail = missingTypeIds.join('、');
    log('error',
      `有 ${missingDefs.length} 种节点类型缺失（其中 ${customCount} 个疑似自定义节点），已用占位节点显示。缺失类型：${detail}。` +
      `修复：在「插件面板」点「扫描自定义节点」并确保节点包已放入程序目录/custom_nodes（全局）或当前项目/custom_nodes（仅本项目）后，重新打开本工作流。`);
  }

  // 将大小写写错但可命中的 typeId 规范化回注册表里的正确写法
  const defByLower = new Map<string, string>();
  for (const k of Object.keys(registry.defs)) defByLower.set(k.toLowerCase(), k);
  for (const n of raw.nodes) {
    const canonical = defByLower.get(n.typeId.toLowerCase());
    if (canonical) n.typeId = canonical;
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
  const edges: FlowEdge[] = raw.edges.map((e) => {
    // 兼容两种磁盘形态：导出拍平为 e.kind；旧的手写示例/历史文件可能是 e.data.kind。
    // 导出路径（serializeWorkflow）拍平为 e.kind，故 e.kind 优先。
    const legacyData = (e as unknown as { data?: { kind?: EdgeKind; scope?: string[] } }).data;
    const kind = e.kind ?? legacyData?.kind ?? 'data';
    const scope = e.scope ?? legacyData?.scope;
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      type: 'kind',
      data: { kind, scope },
    };
  });

  const store = useWorkflowStore.getState();
  store.loadGraph(raw.name || '导入的工作流', nodes, edges, raw.agents ?? [], raw.roles ?? []);
  // 工作流私有变量随文件一起载入
  useWorkflowStore.setState({ variables: raw.variables ?? {} });
  // 导入的工作流标记为游离态：记录其磁盘路径（若有），便于后续原地保存
  if (standalonePath) {
    const s = useWorkflowStore.getState();
    const activeId = s.activeWfId;
    if (activeId) {
      useWorkflowStore.setState({
        workflows: {
          ...s.workflows,
          [activeId]: { ...s.workflows[activeId], belongsToProject: undefined, standalonePath },
        },
      });
    }
  }
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
    applyWorkflowFile(text, path);
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
    applyWorkflowFile(text, file.name);
  };
  input.click();
}

/**
 * 从文件内容打开工作流（供「从窗口外拖拽 .workflow.json 进入」复用）。
 * 不弹对话框：调用方负责拿到文件名与文本。非 .json 文件直接忽略。
 * @returns 是否成功加载（false 表示文件类型不匹配或解析失败）
 */
export async function openWorkflowFromText(
  name: string,
  text: string,
): Promise<boolean> {
  if (!name.toLowerCase().endsWith('.json')) return false;
  try {
    applyWorkflowFile(text, name);
    return true;
  } catch (e) {
    log('error', `拖入的文件不是有效的工作流：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/* ---------- 复制文本（轻量分享） ---------- */
export async function copyWorkflowText(): Promise<void> {
  const wf = serializeWorkflow();
  const text = JSON.stringify(wf, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    log('info', '工作流文本已复制到剪贴板，可直接发给同事');
  } catch {
    log('error', '复制失败：当前环境不支持剪贴板，请改用「导出工作流」保存为文件');
  }
}
