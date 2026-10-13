import { Bug, Columns2, Play, Redo2, RefreshCw, RotateCcw, Square, Undo2 } from 'lucide-react';

type TFn = (key: string, vars?: Record<string, unknown>) => string;

export interface TopBarActionButtonsProps {
  t: TFn;
  splitView: boolean;
  onToggleSplit: () => void;
  onResetStatus: () => void;
  debugMode: boolean;
  onToggleDebug: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  running: boolean;
  onStop: () => void;
  onRerunForce: () => void;
  onRun: () => void;
}

/**
 * 顶栏右侧动作按钮：拆分视图 / 复位状态 / 调试 / 撤销重做 / 运行-停止。
 * 从 TopBar 抽出，props 驱动，class 与标题文案与原内联 JSX 一致。
 */
export default function TopBarActionButtons({
  t,
  splitView,
  onToggleSplit,
  onResetStatus,
  debugMode,
  onToggleDebug,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  running,
  onStop,
  onRerunForce,
  onRun,
}: TopBarActionButtonsProps) {
  return (
    <>
      <span className="sm-pro-workflow-divider mx-1 h-4 w-px" style={{ background: 'var(--sm-line)' }} />
      {/* 拆分视图气泡 */}
      <button
        className="sm-btn px-1.5"
        title={t('topbar.splitView')}
        data-active={splitView}
        onClick={onToggleSplit}
        style={splitView ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' } : undefined}
      >
        <Columns2 size={15} />
      </button>

      <button className="sm-btn px-1.5" title={t('topbar.resetStatus')} onClick={onResetStatus}>
        <RotateCcw size={14} />
      </button>

      <button
        className="sm-btn px-1.5"
        title={debugMode ? t('topbar.debugOn') : t('topbar.debugOff')}
        data-active={debugMode}
        onClick={onToggleDebug}
        style={debugMode ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' } : undefined}
      >
        <Bug size={14} />
      </button>

      <button className="sm-btn px-1.5" title={t('topbar.undo')} disabled={!canUndo} onClick={onUndo}>
        <Undo2 size={14} />
      </button>
      <button className="sm-btn px-1.5" title={t('topbar.redo')} disabled={!canRedo} onClick={onRedo}>
        <Redo2 size={14} />
      </button>

      {running ? (
        <>
          <button className="sm-btn px-1.5 text-err hover:border-err hover:text-err" title={t('topbar.stop')} onClick={onStop}>
            <Square size={14} />
          </button>
          <button className="sm-btn px-1.5" title={t('topbar.rerunForce')} onClick={onRerunForce}>
            <RefreshCw size={14} />
          </button>
        </>
      ) : (
        <button className="sm-pro-run-button sm-btn sm-btn-primary px-2" title={t('topbar.run')} onClick={onRun}>
          <Play size={14} />
          <span className="sm-pro-run-label">{t('topbar.run')}</span>
        </button>
      )}
    </>
  );
}
