import { useState } from 'react';
import { Package, FileText, Code, Bug, ClipboardList, Box, Download } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

/**
 * 产物/交付物面板：展示项目级黑板 s.artifacts（stage → kind → Artifact）。
 * 每个交付物显示来源阶段、种类、时间戳、版本，并可展开查看 payload / 复制为 JSON。
 */
export function ArtifactsPanel() {
  const artifacts = useWorkflowStore((s) => s.artifacts ?? {});
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);

  const stages = Object.keys(artifacts).sort();
  if (stages.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--sm-ink-faint)' }}>
        {t('artifact.empty')}
      </p>
    );
  }

  const kindIcon = (kind: string) => {
    switch (kind) {
      case 'plan':
      case 'design':
        return <ClipboardList size={13} />;
      case 'project':
        return <Box size={13} />;
      case 'bugreport':
        return <Bug size={13} />;
      default:
        return <FileText size={13} />;
    }
  };

  const kindLabel = (stage: string, kind: string) => {
    const key = `artifact.${stage}.${kind}`;
    const v = t(key);
    return v === key ? `${stage} / ${kind}` : v;
  };

  const copyPayload = (payload: unknown) => {
    try {
      navigator.clipboard.writeText(
        typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      );
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-3">
      {stages.map((stage) => {
        const kinds = Object.keys(artifacts[stage]).sort();
        return (
          <div key={stage}>
            <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--sm-ink-faint)' }}>
              {t(`artifact.stage.${stage}`) === `artifact.stage.${stage}` ? stage : t(`artifact.stage.${stage}`)}
            </div>
            <div className="space-y-1">
              {kinds.map((kind) => {
                const a = artifacts[stage][kind];
                const key = `${stage}/${kind}`;
                const isOpen = expanded === key;
                return (
                  <div
                    key={key}
                    className="rounded border border-line px-2 py-1.5"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-left text-xs"
                      style={{ color: 'var(--sm-ink)' }}
                      onClick={() => setExpanded(isOpen ? null : key)}
                    >
                      {kindIcon(kind)}
                      <span className="min-w-0 flex-1 truncate font-medium">{kindLabel(stage, kind)}</span>
                      <span className="text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        v{a.version}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        {new Date(a.updatedAt).toLocaleTimeString()}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--sm-line)' }}>
                        <pre
                          className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/10 p-2 font-mono text-[11px]"
                          style={{ color: 'var(--sm-ink)' }}
                        >
                          {typeof a.payload === 'string'
                            ? a.payload
                            : JSON.stringify(a.payload, null, 2)}
                        </pre>
                        <div className="mt-1 flex justify-end gap-2">
                          <button
                            type="button"
                            className="flex items-center gap-1 text-[11px] opacity-70 hover:opacity-100"
                            onClick={() => copyPayload(a.payload)}
                          >
                            <Code size={11} /> {t('artifact.copy')}
                          </button>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-[11px] opacity-70 hover:opacity-100"
                            onClick={() => {
                              const blob = new Blob(
                                [
                                  typeof a.payload === 'string'
                                    ? a.payload
                                    : JSON.stringify(a.payload, null, 2),
                                ],
                                { type: 'text/plain;charset=utf-8' },
                              );
                              const url = URL.createObjectURL(blob);
                              const link = document.createElement('a');
                              link.href = url;
                              link.download = `${stage}-${kind}.txt`;
                              link.click();
                              URL.revokeObjectURL(url);
                            }}
                          >
                            <Download size={11} /> {t('artifact.download')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
