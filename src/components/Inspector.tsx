import { Boxes, Trash2, Ungroup } from 'lucide-react';
import { useRef, useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { isTauri } from '../platform/env';
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
  const assets = useWorkflowStore((s) => s.workflows[s.activeWfId]?.assets);
  const fileRef = useRef<HTMLInputElement>(null);

  if (def.type === 'asset') {
    const imageAssets = (assets ?? []).filter((a) => a.kind === 'image');
    // 本地文件选择模式：值以 "path:"（桌面端系统路径）或 "file:"（浏览器 data URL）前缀
    const isFile = typeof value === 'string' && (value.startsWith('path:') || value.startsWith('file:'));
    const fileLabel = isFile
      ? value.startsWith('file:')
        ? '已选本地图片'
        : value.slice(5)
      : '';

    // 打开文件资源管理器：桌面端用系统对话框，浏览器用隐藏 file input
    const openPicker = async () => {
      if (isTauri) {
        try {
          const tauri = (window as any).__TAURI__;
          const picked: string | string[] | null = await tauri.dialog.open({
            multiple: false,
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
            title: '选择图片',
          });
          const p = Array.isArray(picked) ? picked[0] : picked;
          if (p) onChange('path:' + p);
        } catch {
          /* 用户取消 */
        }
      } else {
        fileRef.current?.click();
      }
    };

    const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => onChange('file:' + String(reader.result));
      reader.readAsDataURL(f);
      e.target.value = '';
    };

    return (
      <div className="flex items-center gap-1.5">
        <select
          className="sm-input min-w-0 flex-1 cursor-pointer"
          value={isFile ? '' : String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— 选择图片资产 —</option>
          {imageAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {isFile && <option value="__file__">{fileLabel}</option>}
        </select>
        <button
          type="button"
          className={`sm-btn shrink-0 px-2 ${isFile ? 'text-accent' : 'text-ink-faint'}`}
          title="从本机选择图片文件"
          onClick={openPicker}
        >
          📂
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFileChange}
        />
      </div>
    );
  }

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
  // 子图引用节点：取出它引用的子图定义，用于展示构成与端口
  const selectedSubgraph = useWorkflowStore((s) =>
    resolvedNode?.data.typeId === SUBGRAPH_REF_TYPE
      ? s.subgraphs[String(resolvedNode.data.params?.subgraphId ?? '')]
      : undefined,
  );
  const unpackSubgraph = useWorkflowStore((s) => s.unpackSubgraphNode);

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

        {/* 子图节点：展示所引用子图的构成与对外端口，并提供展开入口 */}
        {resolvedNode.data.typeId === SUBGRAPH_REF_TYPE &&
          (selectedSubgraph ? (
            <div className="space-y-2 rounded border border-line bg-paper-deep px-2.5 py-2">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                <Boxes size={12} /> {selectedSubgraph.name}
              </p>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                内含 {selectedSubgraph.nodes.length} 个步骤，运行时会自动展开执行。
              </p>
              {selectedSubgraph.inputs.length > 0 && (
                <div>
                  <p className="mb-0.5 text-[11px] text-ink-soft">输入</p>
                  <ul className="space-y-0.5">
                    {selectedSubgraph.inputs.map((p) => (
                      <li key={p.id} className="truncate text-[11px] text-ink-faint">
                        · {p.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selectedSubgraph.outputs.length > 0 && (
                <div>
                  <p className="mb-0.5 text-[11px] text-ink-soft">输出</p>
                  <ul className="space-y-0.5">
                    {selectedSubgraph.outputs.map((p) => (
                      <li key={p.id} className="truncate text-[11px] text-ink-faint">
                        · {p.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                className="sm-btn w-full justify-center text-[12px]"
                onClick={() => unpackSubgraph(selectedId)}
                title="把子图内部的节点还原到画布上"
              >
                <Ungroup size={12} /> 展开为普通节点
              </button>
            </div>
          ) : (
            <p className="rounded border border-err/30 bg-white px-2.5 py-2 text-[11px] leading-relaxed text-err">
              这个子图的定义已丢失，请删除该节点或重新打包一个子图。
            </p>
          ))}

        {def?.description && resolvedNode.data.typeId !== SUBGRAPH_REF_TYPE && (
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
