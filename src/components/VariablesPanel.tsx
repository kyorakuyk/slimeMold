import { X } from 'lucide-react';
import { useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';

export default function VariablesPanel({ onClose }: { onClose: () => void }) {
  const variables = useWorkflowStore((s) => s.variables);
  const setVariable = useWorkflowStore((s) => s.setVariable);
  const removeVariable = useWorkflowStore((s) => s.removeVariable);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const addVar = () => {
    const k = newKey.trim();
    if (!k) return;
    setVariable(k, newVal);
    setNewKey('');
    setNewVal('');
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative flex h-full w-[360px] flex-col border-l border-line bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">全局变量</h2>
          <button className="sm-btn border-transparent px-1.5" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-xs leading-relaxed text-ink-faint">
            变量可在节点模板中用 <code className="rounded bg-paper-soft px-1">{'{{name}}'}</code> 引用，
            也可在「表达式」节点里直接使用。随工作流一起保存。
          </p>

          <div className="space-y-2 rounded border border-line p-2">
            <input
              className="sm-input"
              placeholder="变量名"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <input
              className="sm-input"
              placeholder="值"
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
              添加变量
            </button>
          </div>

          <div className="mt-3 space-y-2">
            {Object.keys(variables).length === 0 && (
              <p className="text-xs text-ink-faint">暂无变量</p>
            )}
            {Object.entries(variables).map(([k, v]) => (
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
                  onChange={(e) => setVariable(k, e.target.value)}
                />
                <button
                  className="sm-btn border-transparent px-1.5 text-err hover:border-err"
                  onClick={() => removeVariable(k)}
                  title="删除"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
