import { FolderOpen, FolderPlus, LayoutTemplate, Sparkles, X } from 'lucide-react';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

type CanvasWelcomeSurfaceProps = {
  onNewProject?: () => void;
  welcomeDismissed: boolean;
  onDismiss: () => void;
  onShowWelcome: () => void;
  workflowCount: number;
};

export default function CanvasWelcomeSurface({
  onNewProject,
  welcomeDismissed,
  onDismiss,
  onShowWelcome,
  workflowCount,
}: CanvasWelcomeSurfaceProps) {
  const t = useT();
  const tBeginner = useT('beginner');
  const setExamplesOpen = useWorkflowStore((s) => s.setExamplesOpen);
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const newWorkflow = useWorkflowStore((s) => s.newWorkflow);
  const newWorkflowInProject = useWorkflowStore((s) => s.newWorkflowInProject);

  const startTemplate = (id: string) => {
    const tpl = STARTER_TEMPLATES.find((template) => template.id === id);
    if (!tpl) return;
    const { nodes, edges } = tpl.build();
    if (workflowCount === 0) newWorkflowInProject();
    loadGraph(t('canvas.exampleWorkflowName', { name: tpl.name }), nodes, edges, [], []);
  };

  if (welcomeDismissed) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Sparkles size={22} style={{ color: 'var(--sm-ink-faint)' }} />
          <p className="text-[13px]" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('canvas.empty.noWorkflow')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => (onNewProject ? onNewProject() : newWorkflow())}
              className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white transition"
              style={{ background: 'var(--sm-accent)' }}
            >
              {t('menu.newProject')}
            </button>
            <button
              onClick={onShowWelcome}
              className="rounded-lg border px-3 py-1.5 text-[12.5px] transition hover:bg-[var(--sm-bg-soft)]"
              style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
            >
              {t('canvas.welcome.guide')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div
        className="relative grid w-[720px] max-w-full grid-cols-1 gap-6 rounded-2xl border p-7 shadow-2xl md:grid-cols-[260px_1fr]"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
      >
        <button
          className="absolute right-3 top-3 rounded-md p-1.5 transition-colors"
          style={{ color: 'var(--sm-ink-faint)' }}
          title={t('canvas.close')}
          onClick={onDismiss}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sm-bg-soft)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <X size={16} />
        </button>
        {/* 左：主操作区 */}
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <Sparkles size={18} style={{ color: 'var(--sm-accent)' }} />
            <h2 className="text-[18px] font-bold" style={{ color: 'var(--sm-ink)' }}>
              slimeMold
            </h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('canvas.welcome.headline')}
          </p>

          <div className="mt-4 flex flex-col gap-1.5">
            <button
              onClick={() => (onNewProject ? onNewProject() : newWorkflow())}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
              style={{ color: 'var(--sm-ink)' }}
            >
              <FolderPlus size={16} style={{ color: 'var(--sm-accent)' }} />
              {t('menu.newProject')}
              <span
                className="ml-auto text-[11px] opacity-0 transition-opacity group-hover:opacity-60"
                style={{ color: 'var(--sm-ink-faint)' }}
              >
                Ctrl/Cmd+N
              </span>
            </button>
            <button
              onClick={() => setExamplesOpen(true)}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
              style={{ color: 'var(--sm-ink)' }}
            >
              <LayoutTemplate size={16} style={{ color: 'var(--sm-accent)' }} />
              {t('canvas.welcome.browseExamples')}
            </button>
            <button
              onClick={() => setExamplesOpen(true)}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--sm-bg-soft)]"
              style={{ color: 'var(--sm-ink)' }}
            >
              <FolderOpen size={16} style={{ color: 'var(--sm-accent)' }} />
              {t('canvas.welcome.openWorkflow')}
            </button>
          </div>

          <p className="mt-auto pt-4 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('canvas.welcome.nodeHint')}
          </p>
        </div>

        {/* 右：示例模板 */}
        <div className="flex flex-col">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('canvas.welcome.templates')}
          </p>
          <div className="grid grid-cols-1 items-start gap-1.5 sm:grid-cols-2">
            {STARTER_TEMPLATES.slice(0, 6).map((template) => (
              <button
                key={template.id}
                onClick={() => startTemplate(template.id)}
                className="group flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition hover:-translate-y-0.5"
                style={{ background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--sm-accent-soft)';
                  e.currentTarget.style.background = 'color-mix(in srgb, var(--sm-accent) 6%, var(--sm-bg-soft))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--sm-line)';
                  e.currentTarget.style.background = 'var(--sm-bg-soft)';
                }}
              >
                <span className="text-[18px] leading-none">{template.emoji}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium" style={{ color: 'var(--sm-ink)' }}>
                    {tBeginner(template.displayNameKey)}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug" style={{ color: 'var(--sm-ink-faint)' }}>
                    {tBeginner(template.displayDescKey)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <button
            onClick={() => setExamplesOpen(true)}
            className="mt-3 self-start text-[12px] font-medium underline-offset-2 hover:underline"
            style={{ color: 'var(--sm-accent)' }}
          >
            {t('canvas.welcome.allExamples')}
          </button>
        </div>
      </div>
    </div>
  );
}
