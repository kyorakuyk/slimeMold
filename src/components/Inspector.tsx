import { Trash2 } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import type { ParamDef, FlowNode } from '../types';

function ParamField({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const agents = useWorkflowStore((s) => s.agents);
  const roles = useWorkflowStore((s) => s.roles);

  if (def.type === 'textarea') {
    return (
      <textarea
        className="sm-input"
        value={String(value ?? '')}
        placeholder={def.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (def.type === 'number') {
    return (
      <input
        type="number"
        className="sm-input"
        value={value === undefined ? '' : Number(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  }
  if (def.type === 'select') {
    return (
      <select
        className="sm-input cursor-pointer"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {(def.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === 'agent') {
    return (
      <select
        className="sm-input cursor-pointer"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— 选择智能体 —</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}（{a.model}）
          </option>
        ))}
      </select>
    );
  }
  if (def.type === 'role') {
    return (
      <select
        className="sm-input cursor-pointer"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— 不使用角色 —</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.icon ? `${r.icon} ` : ''}
            {r.name}
            {r.builtin ? '（内置）' : ''}
            {r.model ? ` · ${r.model}` : ''}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="sm-input"
      value={String(value ?? '')}
      placeholder={def.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 右侧属性检查面板 */
export default function Inspector({ width = 288 }: { width?: number }) {
  const selectedId = useWorkflowStore((s) => s.selectedNodeId);
  const focusWfId = useWorkflowStore((s) => s.focusWfId);
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const workflows = useWorkflowStore((s) => s.workflows);
  // 焦点节点可能在激活工作流，也可能在拆分视图所显示的其他工作流中
  const focusIsActive = !focusWfId || focusWfId === activeWfId;
  const node = useWorkflowStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId),
  );
  const splitNodeDef = !focusIsActive && selectedId
    ? workflows[focusWfId]?.nodes?.find((n) => n.id === selectedId)
    : undefined;
  const splitNode = splitNodeDef
    ? ({
        id: splitNodeDef.id,
        type: 'base',
        position: splitNodeDef.position,
        data: { typeId: splitNodeDef.typeId, label: splitNodeDef.label, params: splitNodeDef.params ?? {} },
      } as FlowNode)
    : null;
  const resolvedNode = node ?? splitNode;
  const updateNodeParams = useWorkflowStore((s) => s.updateNodeParams);
  const setNodeLabel = useWorkflowStore((s) => s.setNodeLabel);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const def = useRegistryStore((s) =>
    resolvedNode ? s.defs[resolvedNode.data.typeId] : undefined,
  );

  if (!resolvedNode || !selectedId) {
    return (
      <aside className="flex h-full shrink-0 flex-col border-l" style={{ width, background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}>
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="text-[13px] leading-relaxed text-ink-faint">
            选中一个节点后
            <br />
            在此编辑参数与查看结果
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full shrink-0 flex-col border-l" style={{ width, background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}>
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">{def?.name ?? '节点'}</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">{resolvedNode.data.typeId}</p>
        </div>
        <button
          className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
          title="删除节点"
          onClick={() => removeNode(selectedId, focusWfId)}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <div>
          <label className="mb-1 block text-xs text-ink-soft">节点名称</label>
          <input
            className="sm-input"
            value={resolvedNode.data.label}
            onChange={(e) => setNodeLabel(selectedId, e.target.value, focusWfId)}
          />
        </div>

        {(def?.params ?? []).map((p) => (
          <div key={p.key}>
            <label className="mb-1 block text-xs text-ink-soft">{p.label}</label>
            <ParamField
              def={p}
              value={resolvedNode.data.params[p.key]}
              onChange={(v) => updateNodeParams(selectedId, { [p.key]: v }, focusWfId)}
            />
          </div>
        ))}

        {def?.description && (
          <p className="rounded bg-paper-deep px-2.5 py-2 text-[11px] leading-relaxed text-ink-faint">
            {def.description}
          </p>
        )}

        {resolvedNode.data.error && (
          <div>
            <label className="mb-1 block text-xs text-err">错误信息</label>
            <p className="break-all rounded border border-err/30 bg-white px-2.5 py-2 text-[12px] leading-relaxed text-err">
              {resolvedNode.data.error}
            </p>
          </div>
        )}

        {resolvedNode.data.outputs && (
          <div>
            <label className="mb-1 block text-xs text-ink-soft">最近输出</label>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-white px-2.5 py-2 text-[12px] leading-relaxed text-ink-soft">
              {JSON.stringify(resolvedNode.data.outputs, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
}
