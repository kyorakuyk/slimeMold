import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { isTauri } from '../platform/env';
import { useT } from '../i18n/useT';
import slimeMoldIcon from '../assets/slimemold-dense-ic-state.svg';

/**
 * 桌面端自定义窗口标题栏。
 *
 * 浏览器预览保留浏览器自己的窗口装饰；只有 Tauri 桌面端关闭原生 decorations
 * 后才渲染这一层，避免在网页预览中重复出现一条假的标题栏。
 */
export default function WindowTitleBar() {
  const t = useT('ui');
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (!disposed) setMaximized(next);
      } catch (error) {
        console.warn('[window-titlebar] 读取窗口状态失败：', error);
      }
    };

    void syncMaximized();
    void appWindow
      .onResized(() => {
        void syncMaximized();
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        console.warn('[window-titlebar] 监听窗口尺寸失败：', error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri) return null;

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button')) return;
    void getCurrentWindow().startDragging().catch((error) => {
      console.warn('[window-titlebar] 拖动窗口失败：', error);
    });
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button')) return;
    void getCurrentWindow().toggleMaximize().catch((error) => {
      console.warn('[window-titlebar] 切换最大化失败：', error);
    });
  };

  const handleToggleMaximize = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch (error) {
      console.warn('[window-titlebar] 切换最大化失败：', error);
    }
  };

  return (
    <header
      className="sm-window-titlebar"
      aria-label={t('window.title')}
    >
      <div
        className="sm-window-titlebar__drag"
        data-tauri-drag-region
        onPointerDown={handleDragStart}
        onDoubleClick={handleDoubleClick}
      >
        <img
          className="sm-window-titlebar__mark"
          src={slimeMoldIcon}
          alt=""
          aria-hidden="true"
        />
        <span className="sm-window-titlebar__name">SlimeMold</span>
        <span className="sm-window-titlebar__separator" aria-hidden="true">·</span>
        <span className="sm-window-titlebar__context">{t('window.context')}</span>
      </div>

      <div className="sm-window-titlebar__controls" aria-label={t('window.controls')}>
        <button
          type="button"
          className="sm-window-titlebar__control"
          title={t('window.minimize')}
          aria-label={t('window.minimize')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            void getCurrentWindow().minimize().catch((error) => {
              console.warn('[window-titlebar] 最小化窗口失败：', error);
            });
          }}
        >
          <Minus size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sm-window-titlebar__control"
          title={maximized ? t('window.restore') : t('window.maximize')}
          aria-label={maximized ? t('window.restore') : t('window.maximize')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            void handleToggleMaximize();
          }}
        >
          {maximized ? (
            <Minimize2 size={14} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="sm-window-titlebar__control sm-window-titlebar__control--close"
          title={t('window.close')}
          aria-label={t('window.close')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            void getCurrentWindow().close().catch((error) => {
              console.warn('[window-titlebar] 关闭窗口失败：', error);
            });
          }}
        >
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
