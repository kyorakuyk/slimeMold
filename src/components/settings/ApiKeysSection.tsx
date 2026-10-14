import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { fetchModelsByProtocol } from '../../agents/agentManager';
import {
  listVaults,
  loadVaultKey,
  removeVault,
  saveVault,
  inferVendor,
  labelFromBaseUrl,
  listEndpoints,
  loadEndpointKey,
  removeEndpoint,
} from '../../agents/credentialStore';
import { isTauri } from '../../platform/env';
import type { ApiVault, Protocol } from '../../types/agent';
import { useT } from '../../i18n/useT';

/* ---------------- APIKEYS：集中管理系统密钥库中的 API 接入点（网址 + 密钥） ---------------- */
const PROTOCOLS: Protocol[] = ['openai', 'anthropic', 'ollama'];

const VENDOR_COLOR: Record<string, string> = {
  deepseek: '#4D6BFE',
  openai: '#10A37F',
  anthropic: '#D97757',
  claude: '#D97757',
  siliconflow: '#6B4FBB',
  openrouter: '#8B5CF6',
  transit: '#94A3B8',
};

type ApiKeysFeedbackKey =
  | 'webOnly'
  | 'migrationSuccess'
  | 'missingKey'
  | 'noModels'
  | 'urlRequired'
  | 'keyRequired'
  | 'savedVerified'
  | 'saveVerifyFail'
  | 'saveFail'
  | 'deleted'
  | 'deleteFail';

type ApiKeysFeedback = {
  type: 'ok' | 'err';
  key: ApiKeysFeedbackKey;
  count?: number;
  name?: string;
  errorText?: string;
  errorKey?: 'missingKey' | 'noModels';
};

type ApiKeysCheck = {
  ok: boolean;
  count: number;
  errorText?: string;
  errorKey?: 'missingKey' | 'noModels';
};

export default function ApiKeysSection() {
  const t = useT('settings');
  const [vaults, setVaults] = useState<ApiVault[]>([]);
  const [reveal, setReveal] = useState<Record<string, string>>({});
  // 新增表单：不靠用户填 name/id，vendor 自动推断
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<ApiKeysFeedback | null>(null);
  // 每项检测状态：id -> { ok, count, error }
  const [checks, setChecks] = useState<Record<string, ApiKeysCheck>>({});
  const [checking, setChecking] = useState<string | null>(null);

  const refresh = async () => setVaults(await listVaults());

  // 一次性迁移：旧 Endpoint（saveEndpoint 写入）自动转为 Vault 后清空旧条目。
  const migrateLegacy = async () => {
    if (!isTauri) return;
    try {
      const legacy = await listEndpoints();
      if (legacy.length === 0) return;
      let migrated = 0;
      for (const ep of legacy) {
        const key = ep.protocol === 'ollama' ? '' : (await loadEndpointKey(ep.name)) ?? '';
        try {
          await saveVault({ label: ep.name, baseUrl: ep.baseUrl, protocol: ep.protocol, id: ep.credentialKey || ep.name }, key);
          await removeEndpoint(ep.name);
          migrated += 1;
        } catch {
          /* 单条迁移失败不影响其余 */
        }
      }
      if (migrated > 0) {
        setMsg({ type: 'ok', key: 'migrationSuccess', count: migrated });
        await refresh();
      }
    } catch {
      /* 迁移失败不阻断 */
    }
  };

  useEffect(() => {
    if (isTauri) {
      void migrateLegacy().then(refresh);
    } else setMsg({ type: 'err', key: 'webOnly' });
  }, []);

  /** 自动 vendor 预览（随 baseUrl 输入实时变化）。 */
  const vendorPreview = baseUrl.trim() ? inferVendor(baseUrl, protocol) : null;

  /** 校验一个 Vault：网址可达 + 密钥有效 + 能拉到模型。 */
  const verify = async (
    v: Pick<ApiVault, 'protocol' | 'baseUrl'>,
    key: string | null,
  ): Promise<ApiKeysCheck> => {
    if (v.protocol === 'ollama') {
      return { ok: !!v.baseUrl, count: 0 };
    }
    if (!key) return { ok: false, count: 0, errorKey: 'missingKey' };
    try {
      const models = await fetchModelsByProtocol(v.protocol, v.baseUrl, key);
      if (models.length === 0) return { ok: false, count: 0, errorKey: 'noModels' };
      return { ok: true, count: models.length };
    } catch (e) {
      return { ok: false, count: 0, errorText: (e as Error).message };
    }
  };

  const handleAdd = async () => {
    const bu = baseUrl.trim().replace(/\/+$/, '');
    if (!bu) return setMsg({ type: 'err', key: 'urlRequired' });
    if (protocol !== 'ollama' && !apiKey.trim()) return setMsg({ type: 'err', key: 'keyRequired' });
    try {
      // id 自动生成、vendor 自动推断，label 缺省取 baseUrl 域名
      const saved = await saveVault({ label, baseUrl: bu, protocol }, apiKey.trim());
      setChecking(saved.id);
      const res = await verify(saved, protocol === 'ollama' ? null : apiKey.trim());
      setChecking(null);
      setChecks((c) => ({ ...c, [saved.id]: res }));
      if (res.ok) {
        setLabel('');
        setBaseUrl('');
        setApiKey('');
        setMsg({ type: 'ok', key: 'savedVerified', name: saved.label, count: res.count });
        await refresh();
      } else {
        setMsg({ type: 'err', key: 'saveVerifyFail', errorText: res.errorText, errorKey: res.errorKey });
      }
    } catch (e) {
      setChecking(null);
      setMsg({ type: 'err', key: 'saveFail', errorText: (e as Error).message });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await removeVault(id);
      setReveal((r) => {
        const x = { ...r };
        delete x[id];
        return x;
      });
      setChecks((c) => {
        const x = { ...c };
        delete x[id];
        return x;
      });
      setMsg({ type: 'ok', key: 'deleted', name: id });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', key: 'deleteFail', errorText: (e as Error).message });
    }
  };

  const toggleReveal = async (id: string) => {
    if (reveal[id] !== undefined) {
      setReveal((r) => {
        const x = { ...r };
        delete x[id];
        return x;
      });
      return;
    }
    const v = await loadVaultKey(id);
    if (v) setReveal((r) => ({ ...r, [id]: v.apiKey }));
  };

  const recheck = async (v: ApiVault) => {
    setChecking(v.id);
    const key = v.protocol === 'ollama' ? null : (await loadVaultKey(v.id))?.apiKey ?? null;
    const res = await verify(v, key);
    setChecking(null);
    setChecks((c) => ({ ...c, [v.id]: res }));
  };

  const feedbackText = (feedback: ApiKeysFeedback): string => {
    switch (feedback.key) {
      case 'webOnly': return t('settings.apikeys.webOnly');
      case 'migrationSuccess': return t('settings.apikeys.migrationSuccess', { count: feedback.count });
      case 'missingKey': return t('settings.apikeys.missingKey');
      case 'noModels': return t('settings.apikeys.noModels');
      case 'urlRequired': return t('settings.apikeys.urlRequired');
      case 'keyRequired': return t('settings.apikeys.keyRequired');
      case 'savedVerified':
        return t('settings.apikeys.savedVerified', { name: feedback.name, count: feedback.count });
      case 'saveVerifyFail': {
        const error = feedback.errorKey === 'missingKey'
          ? t('settings.apikeys.missingKey')
          : feedback.errorKey === 'noModels'
            ? t('settings.apikeys.noModels')
            : feedback.errorText ?? t('settings.apikeys.unknownError');
        return t('settings.apikeys.saveVerifyFail', { error });
      }
      case 'saveFail':
        return t('settings.apikeys.saveFail', { error: feedback.errorText ?? t('settings.apikeys.unknownError') });
      case 'deleted': return t('settings.apikeys.deleted', { name: feedback.name });
      case 'deleteFail':
        return t('settings.apikeys.deleteFail', { error: feedback.errorText ?? t('settings.apikeys.unknownError') });
    }
  };

  return (
    <div className="h-full space-y-4 overflow-y-auto">
      <div className="rounded border border-line p-3">
        <h3 className="mb-1 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.apikeys.title')}</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.apikeys.desc')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input
            className="sm-input"
            placeholder={t('settings.apikeys.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <select className="sm-input" value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            className="sm-input col-span-2"
            placeholder={t('settings.apikeys.urlPlaceholder')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            className="sm-input col-span-2"
            placeholder={protocol === 'ollama' ? t('settings.apikeys.keyPlaceholderOllama') : t('settings.apikeys.keyPlaceholder')}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          {vendorPreview && (
            <span className="col-span-2 flex items-center gap-1 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('settings.apikeys.autoGroup')}
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
                style={{ background: VENDOR_COLOR[vendorPreview] ?? '#94A3B8' }}
              >
                {vendorPreview}
              </span>
              {!label.trim() && (
                <span className="opacity-70">
                  {t('settings.apikeys.nameFromDomain', { domain: labelFromBaseUrl(baseUrl) })}
                </span>
              )}
            </span>
          )}
        </div>
        <button type="button" className="sm-btn mt-2 flex items-center gap-1 px-3 py-1.5" onClick={handleAdd}>
          <Plus size={13} /> {t('settings.apikeys.save')}
        </button>
      </div>

      {msg && (
        <p className="text-[12px]" style={{ color: msg.type === 'ok' ? 'var(--sm-ok)' : 'var(--sm-err)' }}>
          {feedbackText(msg)}
        </p>
      )}

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          {t('settings.apikeys.configured', { count: vaults.length })}
        </h3>
        {vaults.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('settings.apikeys.empty')}
          </p>
        ) : (
          <div className="space-y-1.5">
            {vaults.map((v) => {
              const chk = checks[v.id];
              return (
                <div key={v.id} className="rounded border border-line px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{v.label}</span>
                      <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: VENDOR_COLOR[v.vendor] ?? '#94A3B8' }}>
                        {v.vendor}
                      </span>
                      <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        {v.protocol}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {chk && (chk.ok ? <CheckCircle2 size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-rose-500" />)}
                      <button type="button" className="text-ink-faint hover:text-accent" title={t('settings.apikeys.recheck')} onClick={() => recheck(v)} disabled={checking === v.id}>
                        <RefreshCw size={13} className={checking === v.id ? 'animate-spin' : ''} />
                      </button>
                      <button type="button" className="text-ink-faint hover:text-accent" title={t('settings.apikeys.reveal')} onClick={() => toggleReveal(v.id)}>
                        {reveal[v.id] !== undefined ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button type="button" className="text-ink-faint hover:text-err" title={t('settings.apikeys.delete')} onClick={() => handleDelete(v.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{v.baseUrl}</p>
                  {chk?.errorKey === 'missingKey' && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sm-err)' }}>{t('settings.apikeys.missingKey')}</p>}
                  {chk?.errorKey === 'noModels' && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sm-err)' }}>{t('settings.apikeys.noModels')}</p>}
                  {chk?.errorText && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sm-err)' }}>{chk.errorText}</p>}
                  {reveal[v.id] !== undefined && (
                    <code className="mt-1 block break-all rounded bg-black/10 px-2 py-1 text-[11px]" style={{ color: 'var(--sm-ink)' }}>
                      {reveal[v.id]}
                    </code>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
