import { Boxes, Trash2, Ungroup, Download, FolderOpen } from 'lucide-react';
import { useRef } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import { useViewStore } from '../store/viewStore';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { isTauri, downloadBlob } from '../platform/env';
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener';
import type { ParamDef } from '../types';
import { useT } from '../i18n/useT';
import { AgentSelect } from './AgentSelect';
import { mergeAgentPool } from '../agents/globalAgents';

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
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const roles = useWorkflowStore((s) => s.roles);
  const assets = useWorkflowStore((s) => s.workflows[s.activeWfId]?.assets);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();

  if (def.type === 'asset') {
    const imageAssets = (assets ?? []).filter((a) => a.kind === 'image');
    // 本地文件选择模式：值以 "path:"（桌面端系统路径）或 "file:"（浏览器 data URL）前缀
    const isFile = typeof value === 'string' && (value.startsWith('path:') || value.startsWith('file:'));
    const fileLabel = isFile
          ? value.startsWith('file:')
            ? t('asset.localLabel')
            : value.slice(5)
      : '';

    // 打开文件资源管理器：桌面端用系统对话框，浏览器用隐藏 file input
    const openPicker = async () => {
      if (isTauri) {
        try {
          const tauri = (window as any).__TAURI__;
          const picked: string | string[] | null = await tauri.dialog.open({
            multiple: false,
            filters: [{ name: t('param.asset.pickFilter'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
            title: t('param.asset.pickTitle'),
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
          <option value="">{t('param.asset.placeholder')}</option>
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
          title={t('param.asset.pickBtn')}
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
  if (def.type === 'agent' || def.type === 'agents') {
    return (
      <AgentSelect
        agents={mergeAgentPool(agents, globalAgents)}
        value={String(value ?? '')}
        multiple={def.type === 'agents'}
        placeholder={def.placeholder ?? (def.type === 'agents' ? t('param.agent.agentsPlaceholder') : t('param.agent.placeholder'))}
        onChange={(v) => onChange(v)}
      />
    );
  }
  if (def.type === 'role') {
    return (
      <select
        className="sm-input cursor-pointer"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('param.role.placeholder')}</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.icon ? `${r.icon} ` : ''}
            {r.name}
            {r.builtin ? t('param.role.builtin') : ''}
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
  const inspectAssetId = useViewStore((s) => s.inspectAssetId);
  const t = useT();
  const setInspectAsset = useViewStore((s) => s.setInspectAsset);
  const removeAsset = useWorkflowStore((s) => s.removeAsset);
  const isTauri = typeof (window as any).__TAURI__ !== 'undefined';
  // 焦点节点可能在激活工作流，也可能在拆分视图所显示的其他工作流中
  const focusIsActive = !focusWfId || focusWfId === activeWfId;
  const node = useWorkflowStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId),
  );
  // 方案 P：workflows[focusWfId].nodes 已是运行态 FlowNode，直接复用
  const splitNode = !focusIsActive && selectedId
    ? (workflows[focusWfId]?.nodes?.find((n) => n.id === selectedId) ?? null)
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

  // 资产详情视图：点击资产文件时在右侧栏展示（复用 Inspector 容器）
  const asset = inspectAssetId
    ? useWorkflowStore.getState().workflows[activeWfId]?.assets?.find((a) => a.id === inspectAssetId)
    : undefined;
  if (asset) {
    const openInExplorer = async () => {
      if (!asset.path || !isTauri) return;
      const winPath = asset.path.replace(/\//g, '\\');
      const dir = winPath.includes('\\') ? winPath.slice(0, winPath.lastIndexOf('\\')) : winPath;
      try {
        await revealItemInDir(winPath);
      } catch (err1) {
        console.error('revealItemInDir 失败', err1);
        try {
          await openPath(dir);
        } catch (err2) {
          console.error('openPath 失败', err2);
          window.alert(`${t('asset.cannotOpen')}\n${winPath}`);
        }
      }
    };
    const fmtBytes = (c: string) => {
      const b = new TextEncoder().encode(c).length;
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / 1024 / 1024).toFixed(2)} MB`;
    };
    return (
      <aside className="flex h-full shrink-0 flex-col border-l" style={{ width, background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-ink" title={asset.name}>{asset.name}</h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">{t('asset.title')}{asset.kind}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-ink" title="下载 / 导出" onClick={() => downloadBlob(asset.name, asset.content, asset.kind === 'image' ? 'image/png' : 'text/plain')}>
              <Download size={14} />
            </button>
            {asset.path && isTauri && (
              <button className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-ink" title={t('asset.openInExplorer')} onClick={openInExplorer}>
                <FolderOpen size={14} />
              </button>
            )}
            <button className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err" title={t('asset.delete')} onClick={() => { removeAsset(asset.id); setInspectAsset(null); }}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
          <div className="grid grid-cols-2 gap-2 text-[11px] text-ink-soft">
            <div className="rounded bg-paper-deep px-2.5 py-1.5">{t('asset.type')}{asset.kind}</div>
            <div className="rounded bg-paper-deep px-2.5 py-1.5">{t('asset.size')}{fmtBytes(asset.content)}</div>
            <div className="rounded bg-paper-deep px-2.5 py-1.5">{t('asset.source')}{asset.inWorkspace ? t('asset.source.workspace') : t('asset.source.workflow')}</div>
            <div className="rounded bg-paper-deep px-2.5 py-1.5">{t('asset.created')}{new Date(asset.createdAt).toLocaleString()}</div>
          </div>
          {asset.path && (
            <div>
              <label className="mb-1 block text-xs text-ink-soft">{t('asset.diskPath')}</label>
              <p className="break-all rounded border border-line bg-white px-2.5 py-2 text-[11px] leading-relaxed text-ink-faint">{asset.path}</p>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-ink-soft">内容预览</label>
            {asset.kind === 'image' ? (
              <img src={asset.content.startsWith('data:') ? asset.content : `data:image/png;base64,${asset.content}`} alt={asset.name} className="max-w-full rounded border border-line" />
            ) : (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-white px-2.5 py-2 text-[11px] leading-relaxed text-ink-soft">{asset.content}</pre>
            )}
          </div>
          <button className="sm-btn w-full justify-center text-[12px]" onClick={() => setInspectAsset(null)} title={t('asset.backToNode')}>
            {t('asset.backToNode')}
          </button>
        </div>
      </aside>
    );
  }

  if (!resolvedNode || !selectedId) {
    return (
      <aside className="flex h-full shrink-0 flex-col border-l" style={{ width, background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}>
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="text-[13px] leading-relaxed text-ink-faint" style={{ whiteSpace: 'pre-line' }}>
            {t('empty.hint')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full shrink-0 flex-col border-l" style={{ width, background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}>
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">{def?.name ?? t('node.defaultName')}</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">{resolvedNode.data.typeId}</p>
        </div>
        <button
          className="sm-btn border-transparent px-1.5 text-ink-faint hover:text-err"
          title={t('node.delete')}
          onClick={() => removeNode(selectedId, focusWfId)}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <div>
          <label className="mb-1 block text-xs text-ink-soft">{t('node.nameLabel')}</label>
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
                {t('sg.stepsCount', { count: selectedSubgraph.nodes.length })}
              </p>
              {selectedSubgraph.inputs.length > 0 && (
                <div>
                  <p className="mb-0.5 text-[11px] text-ink-soft">{t('sg.input')}</p>
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
                  <p className="mb-0.5 text-[11px] text-ink-soft">{t('sg.output')}</p>
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
                title={t('sg.unpackTitle')}
              >
                <Ungroup size={12} /> {t('sg.unpackBtn')}
              </button>
            </div>
          ) : (
            <p className="rounded border border-err/30 bg-white px-2.5 py-2 text-[11px] leading-relaxed text-err">
              {t('sg.lost')}
            </p>
          ))}

        {def?.description && resolvedNode.data.typeId !== SUBGRAPH_REF_TYPE && (
          <p className="rounded bg-paper-deep px-2.5 py-2 text-[11px] leading-relaxed text-ink-faint">
            {def.description}
          </p>
        )}

        {resolvedNode.data.error && (
          <div>
            <label className="mb-1 block text-xs text-err">{t('err.label')}</label>
            <p className="break-all rounded border border-err/30 bg-white px-2.5 py-2 text-[12px] leading-relaxed text-err">
              {resolvedNode.data.error}
            </p>
          </div>
        )}

        {resolvedNode.data.outputs && (
          <div>
            <label className="mb-1 block text-xs text-ink-soft">{t('output.label')}</label>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-[var(--sm-bg)] px-2.5 py-2 text-[12px] leading-relaxed text-ink-soft">
              {JSON.stringify(resolvedNode.data.outputs, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
}
