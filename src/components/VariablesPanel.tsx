import { X } from 'lucide-react';
import { useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

export default function VariablesPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const t = useT('panels');
  const projectVariables = useWorkflowStore((s) => s.projectVariables);
  const workflowVariables = useWorkflowStore((s) => s.variables);
  const setProjectVariable = useWorkflowStore((s) => s.setProjectVariable);
  const removeProjectVariable = useWorkflowStore((s) => s.removeProjectVariable);
  const setVariable = useWorkflowStore((s) => s.setVariable);
  const removeVariable = useWorkflowStore((s) => s.removeVariable);

  const [scope, setScope] = useState<'project' | 'workflow'>('project');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const addVar = () => {
    const k = newKey.trim();
    if (!k) return;
    if (scope === 'project') setProjectVariable(k, newVal);
    else setVariable(k, newVal);
    setNewKey('');
    setNewVal('');
  };

  const curVars = scope === 'project' ? projectVariables : workflowVariables;
  // 编辑工作流级时，标注哪些被项目级同名覆盖；编辑项目级时，标注哪些被工作流级覆盖
  const overrideMap =
    scope === 'project'
      ? (Object.keys(workflowVariables) as string[])
      : (Object.keys(projectVariables) as string[]);

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-3 text-xs leading-relaxed text-ink-faint">
          {t('variables.intro')}
        </p>

        {/* 作用域切换 */}
        <div className="mb-3 flex overflow-hidden rounded border border-line text-[11px]">
          <button
            onClick={() => setScope('project')}
            className={`flex-1 px-2 py-1 ${scope === 'project' ? 'bg-accent text-white' : 'text-ink-soft hover:bg-panel-2'}`}
          >
            {t('variables.scopeProject')}
          </button>
          <button
            onClick={() => setScope('workflow')}
            className={`flex-1 px-2 py-1 ${scope === 'workflow' ? 'bg-accent text-white' : 'text-ink-soft hover:bg-panel-2'}`}
          >
            {t('variables.scopeWorkflow')}
          </button>
        </div>

        <div className="space-y-2 rounded border border-line p-2">
          <input
            className="sm-input"
            placeholder={t('variables.namePlaceholder')}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            className="sm-input"
            placeholder={t('variables.valuePlaceholder')}
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addVar();
            }}
          />
          <button
            className="sm-btn sm-btn-primary w-full"
            onClick={addVar}
            disabled={!newKey.trim()}
          >
            {t('variables.addBtn', { scope: scope === 'project' ? t('variables.scopeProject') : t('variables.scopeWorkflow') })}
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {Object.keys(curVars).length === 0 && (
            <p className="text-xs text-ink-faint">{t('variables.empty')}</p>
          )}
          {Object.entries(curVars).map(([k, v]) => (
            <div
              key={k}
              className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
            >
              <span className="w-24 shrink-0 truncate text-xs font-medium text-ink" title={k}>
                {k}
              </span>
              <input
                className="sm-input flex-1"
                value={String(v ?? '')}
                onChange={(e) =>
                  scope === 'project'
                    ? setProjectVariable(k, e.target.value)
                    : setVariable(k, e.target.value)
                }
              />
              {overrideMap.includes(k) && (
                <span
                  className="shrink-0 rounded bg-amber-50 px-1 text-[10px] text-amber-600"
                  title={scope === 'project' ? t('variables.overrideTitleProject') : t('variables.overrideTitleWorkflow')}
                >
                  {scope === 'project' ? t('variables.overridden') : t('variables.overrides')}
                </span>
              )}
              <button
                className="sm-btn border-transparent px-1.5 text-err hover:border-err"
                onClick={() =>
                  scope === 'project' ? removeProjectVariable(k) : removeVariable(k)
                }
                title={t('common.delete')}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative flex h-full w-[360px] flex-col border-l border-line bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t('variables.title')}</h2>
          <button className="sm-btn border-transparent px-1.5" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
