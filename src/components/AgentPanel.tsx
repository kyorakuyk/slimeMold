import { useState } from 'react';
import { X, Plus, Trash2, RefreshCw, KeyRound, Check } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import {
  createAgent,
  protocolDefaults,
  ollamaModels,
  fetchOllamaModels,
} from '../agents/agentManager';
import { saveCredential, removeCredential, defaultCredentialKey } from '../agents/credentialStore';
import { isTauri } from '../platform/env';
import type { AgentConfig, Protocol, RoleTemplate } from '../types';

interface AgentPanelProps {
  onClose?: () => void;
  embedded?: boolean;
}

/** 智能体管理弹层：多协议配置的增删改 + 角色库（角色模板）管理 */
export default function AgentPanel({ onClose, embedded = false }: AgentPanelProps) {
  const [tab, setTab] = useState<'agents' | 'roles'>('agents');

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center border-b border-line px-3">
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
      {tab === 'agents' ? <AgentsTab /> : <RolesTab />}
    </div>
  );

  if (embedded) return inner;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="flex h-[520px] w-[720px] flex-col overflow-hidden rounded-lg border border-line bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-3">
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
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const editing = agents.find((a) => a.id === editingId);

  const pullLocalModels = async () => {
    if (!editing) return;
    setLoadingModels(true);
    try {
      const list = await fetchOllamaModels(editing.baseUrl || 'http://127.0.0.1:11434');
      setLocalModels(list);
    } finally {
      setLoadingModels(false);
    }
  };

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
            {editing.protocol === 'ollama' ? (
              <div className="rounded border border-line bg-paper-soft px-3 py-2.5">
                <p className="text-[11px] text-ink-faint">
                  本地 Ollama 模型无需 API Key，凭据留空即可。
                </p>
              </div>
            ) : (
              <ApiKeyField
                protocol={editing.protocol}
                credentialKey={editing.credentialKey}
                onSaved={(ck) => patch({ credentialKey: ck, apiKey: undefined })}
                onCleared={() => patch({ credentialKey: undefined })}
              />
            )}
            <div>
              <label className="mb-1 block text-xs text-ink-soft">
                模型{editing.protocol === 'ollama' ? '（本地 Ollama）' : ''}
              </label>
              {editing.protocol === 'ollama' ? (
                <div className="space-y-1.5">
                  <div className="flex gap-1.5">
                    <select
                      className="sm-input cursor-pointer flex-1"
                      value={ollamaModels.some((m) => m.id === editing.model) ? editing.model : ''}
                      onChange={(e) => patch({ model: e.target.value })}
                    >
                      <option value="">— 推荐模型 —</option>
                      {ollamaModels.map((m) => (
                        <option key={m.id} value={m.id} title={m.note}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="sm-btn shrink-0 px-2"
                      title="拉取本机已安装模型"
                      disabled={loadingModels}
                      onClick={pullLocalModels}
                    >
                      <RefreshCw size={13} className={loadingModels ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  {ollamaModels.find((m) => m.id === editing.model)?.note && (
                    <p className="text-[11px] text-ink-faint">
                      {ollamaModels.find((m) => m.id === editing.model)?.note}
                    </p>
                  )}
                  {localModels.length > 0 && (
                    <select
                      className="sm-input cursor-pointer"
                      value={localModels.includes(editing.model) ? editing.model : ''}
                      onChange={(e) => patch({ model: e.target.value })}
                    >
                      <option value="">— 本机已安装 —</option>
                      {localModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                  {localModels.length === 0 && !loadingModels && (
                    <button
                      type="button"
                      className="text-[11px] text-accent hover:underline"
                      onClick={pullLocalModels}
                    >
                      未检测到本机模型？点击拉取已安装的 Ollama 模型
                    </button>
                  )}
                  <input
                    className="sm-input mt-1"
                    value={editing.model}
                    placeholder="或直接输入模型名，如 qwen2.5:3b"
                    onChange={(e) => patch({ model: e.target.value })}
                  />
                </div>
              ) : (
                <input
                  className="sm-input"
                  value={editing.model}
                  onChange={(e) => patch({ model: e.target.value })}
                />
              )}
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

/**
 * API Key 录入组件（Step 0.5）：明文仅在本组件的临时 state 中存在，
 * 点「保存到系统密钥库」后写入 OS 密钥库，并向上回报 credentialKey；
 * 工作流 / agent 配置中只保留 credentialKey，绝不持久化明文。
 */
function ApiKeyField({
  protocol,
  credentialKey,
  onSaved,
  onCleared,
}: {
  protocol: Protocol;
  credentialKey?: string;
  onSaved: (ck: string) => void;
  onCleared: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'' | 'ok' | 'err'>('');

  const ck = credentialKey ?? defaultCredentialKey(protocol);

  const handleSave = async () => {
    if (!draft.trim()) return;
    if (!isTauri) {
      setStatus('err');
      return;
    }
    try {
      await saveCredential(ck, draft.trim());
      onSaved(ck);
      setDraft('');
      setStatus('ok');
    } catch {
      setStatus('err');
    }
  };

  const handleClear = async () => {
    try {
      await removeCredential(ck);
    } catch {
      /* 忽略：即便删除失败也清空本地引用 */
    }
    onCleared();
    setStatus('');
  };

  return (
    <div>
      <label className="mb-1 block text-xs text-ink-soft">API Key（存于系统密钥库）</label>
      <div className="flex gap-1.5">
        <input
          type="password"
          className="sm-input flex-1"
          value={draft}
          placeholder={isTauri ? '输入后点击下方保存' : '仅桌面版支持密钥库'}
          disabled={!isTauri}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
        />
        <button
          type="button"
          className="sm-btn shrink-0 px-2.5"
          disabled={!isTauri || !draft.trim()}
          onClick={handleSave}
        >
          <KeyRound size={13} /> 保存
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <p className="text-[11px] text-ink-faint">
          {credentialKey ? (
            <span className="inline-flex items-center gap-1 text-ok">
              <Check size={11} /> 已保存（凭据键：{ck}）
            </span>
          ) : (
            '尚未保存，运行时将无法取回密钥'
          )}
        </p>
        {credentialKey && (
          <button
            type="button"
            className="text-[11px] text-ink-faint hover:text-err"
            onClick={handleClear}
          >
            清除
          </button>
        )}
      </div>
      {status === 'err' && (
        <p className="mt-1 text-[11px] text-err">保存失败（请使用桌面版，或检查系统密钥库权限）</p>
      )}
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
