import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { createAgent, protocolDefaults } from '../agents/agentManager';
import type { AgentConfig, Protocol, RoleTemplate } from '../types';

interface AgentPanelProps {
  onClose: () => void;
}

/** 智能体管理弹层：多协议配置的增删改 + 角色库（角色模板）管理 */
export default function AgentPanel({ onClose }: AgentPanelProps) {
  const [tab, setTab] = useState<'agents' | 'roles'>('agents');

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="flex h-[520px] w-[720px] flex-col overflow-hidden rounded-lg border border-line bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部 Tab */}
        <div className="flex items-center justify-between border-b border-line px-3">
          <div className="flex">
            <button
              className={`px-3 py-3 text-[13px] font-medium transition-colors ${
                tab === 'agents'
                  ? 'border-b-2 border-accent text-ink'
                  : 'text-ink-faint hover:text-ink'
              }`}
              onClick={() => setTab('agents')}
            >
              智能体
            </button>
            <button
              className={`px-3 py-3 text-[13px] font-medium transition-colors ${
                tab === 'roles'
                  ? 'border-b-2 border-accent text-ink'
                  : 'text-ink-faint hover:text-ink'
              }`}
              onClick={() => setTab('roles')}
            >
              角色库
            </button>
          </div>
          <button
            className="cursor-pointer text-ink-faint hover:text-ink"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {tab === 'agents' ? <AgentsTab /> : <RolesTab />}
      </div>
    </div>
  );
}

function AgentsTab() {
  const agents = useWorkflowStore((s) => s.agents);
  const upsertAgent = useWorkflowStore((s) => s.upsertAgent);
  const removeAgent = useWorkflowStore((s) => s.removeAgent);
  const [editingId, setEditingId] = useState<string | null>(agents[0]?.id ?? null);
  const editing = agents.find((a) => a.id === editingId);

  const patch = (p: Partial<AgentConfig>) => {
    if (!editing) return;
    upsertAgent({ ...editing, ...p });
  };

  const changeProtocol = (protocol: Protocol) => {
    if (!editing) return;
    const d = protocolDefaults[protocol];
    upsertAgent({ ...editing, protocol, baseUrl: d.baseUrl, model: d.model });
  };

  const addAgent = (protocol: Protocol) => {
    const agent = createAgent(protocol);
    upsertAgent(agent);
    setEditingId(agent.id);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* 左列：智能体列表 */}
      <div className="flex w-56 shrink-0 flex-col border-r border-line bg-paper-soft">
        <div className="border-b border-line px-3 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">智能体</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">多协议 LLM 配置</p>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {agents.map((a) => (
            <li
              key={a.id}
              onClick={() => setEditingId(a.id)}
              className={`mb-1 cursor-pointer rounded border px-2.5 py-2 transition-colors ${
                a.id === editingId
                  ? 'border-accent-soft bg-white'
                  : 'border-transparent hover:bg-white'
              }`}
            >
              <p className="truncate text-[13px] text-ink">{a.name}</p>
              <p className="text-[11px] text-ink-faint">
                {protocolDefaults[a.protocol].label} · {a.model}
              </p>
            </li>
          ))}
        </ul>
        <div className="flex gap-1 border-t border-line p-2">
          {(Object.keys(protocolDefaults) as Protocol[]).map((p) => (
            <button
              key={p}
              className="sm-btn flex-1 justify-center px-1 text-[11px]"
              onClick={() => addAgent(p)}
              title={`新建${protocolDefaults[p].label}智能体`}
            >
              <Plus size={12} /> {protocolDefaults[p].label.slice(0, 3)}
            </button>
          ))}
        </div>
      </div>

      {/* 右列：编辑表单 */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-ink">
            {editing ? '编辑配置' : '未选择'}
          </h3>
        </div>
        {editing ? (
          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
            <div>
              <label className="mb-1 block text-xs text-ink-soft">名称</label>
              <input
                className="sm-input"
                value={editing.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">协议</label>
              <select
                className="sm-input cursor-pointer"
                value={editing.protocol}
                onChange={(e) => changeProtocol(e.target.value as Protocol)}
              >
                {(Object.keys(protocolDefaults) as Protocol[]).map((p) => (
                  <option key={p} value={p}>
                    {protocolDefaults[p].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">Base URL</label>
              <input
                className="sm-input"
                value={editing.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">API Key</label>
              <input
                type="password"
                className="sm-input"
                value={editing.apiKey}
                placeholder={editing.protocol === 'ollama' ? '本地模型无需填写' : 'sk-…'}
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">模型</label>
              <input
                className="sm-input"
                value={editing.model}
                onChange={(e) => patch({ model: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">
                温度（{editing.temperature ?? 0.7}）
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                className="w-full cursor-pointer accent-accent"
                value={editing.temperature ?? 0.7}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </div>
            <button
              className="sm-btn text-err hover:border-err hover:text-err"
              onClick={() => {
                removeAgent(editing.id);
                setEditingId(null);
              }}
            >
              <Trash2 size={13} /> 删除此智能体
            </button>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-ink-faint">从左侧选择或新建智能体</p>
          </div>
        )}
      </div>
    </div>
  );
}

function RolesTab() {
  const roles = useWorkflowStore((s) => s.roles);
  const upsertRole = useWorkflowStore((s) => s.upsertRole);
  const removeRole = useWorkflowStore((s) => s.removeRole);
  const [editingId, setEditingId] = useState<string | null>(
    roles.find((r) => !r.builtin)?.id ?? roles[0]?.id ?? null,
  );
  const editing = roles.find((r) => r.id === editingId);

  const addRole = () => {
    const id = `role.${Date.now().toString(36)}`;
    upsertRole({
      id,
      name: '新角色',
      system: '',
      contextScope: 'shared',
    });
    setEditingId(id);
  };

  const patch = (p: Partial<RoleTemplate>) => {
    if (!editing) return;
    upsertRole({ ...editing, ...p });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* 左列：角色列表 */}
      <div className="flex w-56 shrink-0 flex-col border-r border-line bg-paper-soft">
        <div className="border-b border-line px-3 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">角色库</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            为智能体设定"职业"与上下文策略
          </p>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {roles.map((r) => (
            <li
              key={r.id}
              onClick={() => setEditingId(r.id)}
              className={`mb-1 cursor-pointer rounded border px-2.5 py-2 transition-colors ${
                r.id === editingId
                  ? 'border-accent-soft bg-white'
                  : 'border-transparent hover:bg-white'
              }`}
            >
              <p className="truncate text-[13px] text-ink">
                {r.icon ? `${r.icon} ` : ''}
                {r.name}
                {r.builtin ? (
                  <span className="ml-1 text-[10px] text-ink-faint">内置</span>
                ) : null}
              </p>
              <p className="text-[11px] text-ink-faint">
                {r.contextScope === 'isolated' ? '隔离上下文' : '共享上下文'}
                {r.model ? ` · ${r.model}` : ''}
              </p>
            </li>
          ))}
        </ul>
        <div className="border-t border-line p-2">
          <button className="sm-btn w-full justify-center" onClick={addRole}>
            <Plus size={12} /> 新建角色
          </button>
        </div>
      </div>

      {/* 右列：角色编辑 */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-ink">
            {editing ? (editing.builtin ? '查看内置角色' : '编辑角色') : '未选择'}
          </h3>
        </div>
        {editing ? (
          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
            <div>
              <label className="mb-1 block text-xs text-ink-soft">名称</label>
              <input
                className="sm-input"
                value={editing.name}
                disabled={editing.builtin}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-ink-soft">图标（emoji）</label>
                <input
                  className="sm-input"
                  value={editing.icon ?? ''}
                  disabled={editing.builtin}
                  placeholder="🧭"
                  onChange={(e) => patch({ icon: e.target.value })}
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-ink-soft">默认模型</label>
                <input
                  className="sm-input"
                  value={editing.model ?? ''}
                  disabled={editing.builtin}
                  placeholder="留空则用节点智能体模型"
                  onChange={(e) => patch({ model: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">描述</label>
              <input
                className="sm-input"
                value={editing.description ?? ''}
                disabled={editing.builtin}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">上下文隔离</label>
              <select
                className="sm-input cursor-pointer"
                value={editing.contextScope ?? 'shared'}
                disabled={editing.builtin}
                onChange={(e) =>
                  patch({ contextScope: e.target.value as 'shared' | 'isolated' })
                }
              >
                <option value="shared">共享（与其它节点共用全局上下文）</option>
                <option value="isolated">隔离（独立上下文，不污染共享）</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">系统提示词（角色设定）</label>
              <textarea
                className="sm-input min-h-[120px]"
                value={editing.system}
                disabled={editing.builtin}
                placeholder="设定该角色的本职、职责与输出规范…"
                onChange={(e) => patch({ system: e.target.value })}
              />
            </div>
            {!editing.builtin && (
              <button
                className="sm-btn text-err hover:border-err hover:text-err"
                onClick={() => {
                  removeRole(editing.id);
                  setEditingId(roles.find((r) => !r.builtin && r.id !== editing.id)?.id ?? null);
                }}
              >
                <Trash2 size={13} /> 删除此角色
              </button>
            )}
            {editing.builtin && (
              <p className="text-[11px] text-ink-faint">
                内置角色不可编辑/删除。如需自定义，请在左侧「新建角色」并参考其设定。
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-ink-faint">从左侧选择或新建角色</p>
          </div>
        )}
      </div>
    </div>
  );
}
