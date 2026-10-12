import { useEffect, useState } from 'react';
import { Check, KeyRound, RefreshCw } from 'lucide-react';
import { saveCredential, removeCredential } from '../../agents/credentialStore';
import { loginCodex, codexLoginStatus, logoutCodex } from '../../agents/providers/codex';
import { isTauri } from '../../platform/env';
import type { AgentConfig, AntigravityMode } from '../../types/agent';
import { useT } from '../../i18n/useT';

export function AntigravityCliField({
  mode,
  profile,
  cliPath,
  onChange,
}: {
  mode?: AntigravityMode;
  profile?: string;
  cliPath?: string;
  onChange: (patch: Partial<AgentConfig>) => void;
}) {
  const t = useT('agents');
  return (
    <div className="rounded border border-line bg-paper-soft px-3 py-2.5">
      <p className="text-[12px] font-medium text-ink">{t('agent.antigravity.title')}</p>
      <p className="mt-1 text-[11px] text-ink-faint">{t('agent.antigravity.desc')}</p>
      <label className="mt-2 block text-[11px] text-ink-soft">
        {t('agent.antigravity.mode')}
        <select
          className="sm-input mt-1"
          value={mode ?? 'agent'}
          onChange={(event) => onChange({ runtimeMode: event.target.value as AntigravityMode })}
        >
          <option value="ask">ask</option>
          <option value="edit">edit</option>
          <option value="agent">agent</option>
          <option value="custom">custom</option>
        </select>
      </label>
      <label className="mt-2 block text-[11px] text-ink-soft">
        {t('agent.antigravity.profile')}
        <input
          className="sm-input mt-1"
          value={profile ?? ''}
          placeholder={t('agent.antigravity.profilePlaceholder')}
          onChange={(event) => onChange({ runtimeProfile: event.target.value.trim() || undefined })}
        />
      </label>
      <label className="mt-2 block text-[11px] text-ink-soft">
        {t('agent.antigravity.cliPath')}
        <input
          className="sm-input mt-1"
          value={cliPath ?? ''}
          placeholder={t('agent.antigravity.cliPathPlaceholder')}
          onChange={(event) => onChange({ runtimeCliPath: event.target.value.trim() || undefined })}
        />
      </label>
      <p className="mt-2 text-[11px] text-ink-faint">{t('agent.antigravity.modelHint')}</p>
    </div>
  );
}

/**
 * API Key 录入组件（Step 0.5）：明文仅在本组件的临时 state 中存在，
 * 点「保存到系统密钥库」后写入 OS 密钥库，并向上回报 credentialKey；
 * 工作流 / agent 配置中只保留 credentialKey，绝不持久化明文。
 */
export function ApiKeyField({
  credentialKey,
  agentId,
  onSaved,
  onCleared,
}: {
  credentialKey?: string;
  /** 当前编辑的 Agent id，用于生成该 Agent 专属的凭据键，避免同协议 Agent 共用/覆盖密钥 */
  agentId: string;
  onSaved: (ck: string, value: string) => void;
  onCleared: () => void;
}) {
  const t = useT('agents');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'' | 'ok' | 'err'>('');

  // 优先使用 Agent 已绑定的 credentialKey；否则用 Agent 专属键（而非共享的协议默认键），
  // 保证不同 Agent 各自独立存 key，互不覆盖。
  const ck = credentialKey ?? `agent:${agentId}:cred`;

  const handleSave = async () => {
    if (!draft.trim()) return;
    if (!isTauri) {
      setStatus('err');
      return;
    }
    try {
      await saveCredential(ck, draft.trim());
      onSaved(ck, draft.trim());
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
      <label className="mb-1 block text-xs text-ink-soft">{t('agent.apikey.label')}</label>
      <div className="flex gap-1.5">
        <input
          type="password"
          className="sm-input flex-1"
          value={draft}
          placeholder={isTauri ? t('agent.apikey.placeholder') : t('agent.apikey.placeholderWeb')}
          disabled={!isTauri}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
        />
        <button
          type="button"
          className="sm-btn shrink-0 px-3"
          disabled={!draft.trim()}
          title={isTauri ? t('agent.apikey.saveTitle') : t('agent.apikey.saveTitleWeb')}
          onClick={handleSave}
        >
          <KeyRound size={13} /> {t('agent.apikey.save')}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <p className="text-[11px] text-ink-faint">
          {credentialKey ? (
            <span className="inline-flex items-center gap-1 text-ok">
              <Check size={11} /> {t('agent.apikey.saved', { key: ck })}
            </span>
          ) : (
            t('agent.apikey.unsaved')
          )}
        </p>
        {credentialKey && (
          <button
            type="button"
            className="text-[11px] text-ink-faint hover:text-err"
            onClick={handleClear}
          >
            {t('agent.apikey.clear')}
          </button>
        )}
      </div>
      {status === 'err' && (
        <p className="mt-1 text-[11px] text-err">{t('agent.apikey.failed')}</p>
      )}
    </div>
  );
}

/**
 * Codex 订阅连接组件：只调用官方 CLI 的 login/status/logout 命令，
 * 不读取或复制 Codex 的 OAuth 文件和 access token。
 */
export function CodexAuthField() {
  const t = useT('agents');
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof codexLoginStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    setBusy(true);
    setMessage('');
    try {
      setAuth(await codexLoginStatus());
    } catch (error) {
      setAuth(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleLogin = async () => {
    setBusy(true);
    setMessage('');
    try {
      await loginCodex();
      setMessage(t('agent.codex.loginStarted'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setMessage('');
    try {
      await logoutCodex();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-line bg-paper-soft px-3 py-2.5">
      <p className="text-[12px] font-medium text-ink">{t('agent.codex.title')}</p>
      <p className="mt-1 text-[11px] text-ink-faint">{t('agent.codex.desc')}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={`text-[11px] ${auth?.loggedIn ? 'text-ok' : 'text-ink-faint'}`}>
          {auth?.loggedIn
            ? auth.authMode === 'chatgpt'
              ? t('agent.codex.loggedIn')
              : t('agent.codex.otherAuth')
            : t('agent.codex.notLoggedIn')}
        </span>
        <div className="flex items-center gap-1.5">
          {auth?.loggedIn ? (
            <button type="button" className="sm-btn px-2 py-1 text-[11px]" onClick={handleLogout} disabled={busy}>
              {t('agent.codex.logout')}
            </button>
          ) : (
            <button type="button" className="sm-btn px-2 py-1 text-[11px]" onClick={handleLogin} disabled={busy || !isTauri}>
              {t('agent.codex.login')}
            </button>
          )}
          <button type="button" className="sm-btn px-2 py-1" onClick={() => void refresh()} disabled={busy} title={t('agent.codex.refresh')}>
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      {auth?.detail && <p className="mt-1 text-[10px] text-ink-faint">{auth.detail}</p>}
      {message && <p className="mt-1 text-[11px] text-ink-faint">{message}</p>}
    </div>
  );
}
