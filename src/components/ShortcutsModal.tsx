import { useEffect } from 'react';
import { useT } from '../i18n/useT';

const ROWS: [string, string][] = [
  ['Ctrl/Cmd + Shift + N', 'shortcuts.newProject'],
  ['Ctrl/Cmd + N', 'shortcuts.newWorkflow'],
  ['Ctrl/Cmd + S', 'shortcuts.saveProject'],
  ['Ctrl/Cmd + =', 'shortcuts.zoomIn'],
  ['Ctrl/Cmd + -', 'shortcuts.zoomOut'],
  ['Shift + 1', 'shortcuts.fit'],
  ['Ctrl/Cmd + G', 'shortcuts.group'],
  ['Ctrl/Cmd + Shift + G', 'shortcuts.subgraph'],
  ['Delete / Backspace', 'shortcuts.delete'],
  ['Esc', 'shortcuts.esc'],
];

/** 快捷键速查。inline=true 时不带遮罩，作为侧边栏内容嵌入 */
export default function ShortcutsModal({
  onClose,
  inline = false,
}: {
  onClose?: () => void;
  inline?: boolean;
}) {
  const t = useT('modals');
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inline, onClose]);

  const table = (
    <table className="w-full text-[13px]">
      <tbody>
        {ROWS.map(([k, key]) => (
          <tr key={k} className="border-t" style={{ borderColor: 'var(--sm-line)' }}>
            <td
              className="py-1.5 pr-3 font-mono text-[12px]"
              style={{ color: 'var(--sm-accent-soft)' }}
            >
              {k}
            </td>
            <td className="py-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
              {t(key)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (inline) {
    return <div className="flex-1 overflow-y-auto px-4 py-3">{table}</div>;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={onClose}
    >
      <div
        className="w-[420px] rounded-lg border p-4 shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            {t('shortcuts.title')}
          </h2>
          <button className="sm-btn px-2 py-0.5" onClick={onClose}>
            {t('shortcuts.close')}
          </button>
        </div>
        {table}
      </div>
    </div>
  );
}
