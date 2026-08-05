import { useState, useRef, useEffect } from 'react';
import { useT } from '../i18n/useT';

interface NamePromptProps {
  title: string;
  initial: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/** 轻量内联命名弹窗，替代 window.prompt（Tauri webview 不支持 prompt）。 */
export function NamePrompt({ title, initial, onConfirm, onCancel }: NamePromptProps) {
  const t = useT('modals');
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl">
        <div className="mb-2 text-sm font-medium text-neutral-200">{title}</div>
        <input
          ref={inputRef}
          className="w-full rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-sky-500"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(value.trim() || initial.trim());
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-600"
            onClick={onCancel}
          >
            {t('namePrompt.cancel')}
          </button>
          <button
            className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500"
            onClick={() => onConfirm(value.trim() || initial.trim())}
          >
            {t('namePrompt.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
