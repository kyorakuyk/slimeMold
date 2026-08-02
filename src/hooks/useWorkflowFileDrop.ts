import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '../platform/env';
import { openWorkflowFromText } from '../io/workflowIO';

/**
 * 允许从窗口外拖拽 .workflow.json 文件进入应用直接打开工作流。
 * 浏览器端监听 DOM 拖放；Tauri 桌面端监听 `tauri://drag-drop` 事件（Rust 默认开启 fileDrop）。
 * 返回：
 *  - dragActive：是否正有文件悬停在窗口上（用于显示遮罩）
 *  - onDragEnter/onDragLeave/onDragOver/onDrop：挂到最外层容器
 */
export function useWorkflowFileDrop() {
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);

  const handleFiles = useCallback(async (files: File[] | FileList) => {
    const list = Array.from(files);
    let opened = 0;
    for (const f of list) {
      if (!f.name.toLowerCase().endsWith('.json')) continue;
      const text = await f.text();
      const ok = await openWorkflowFromText(f.name, text);
      if (ok) opened++;
    }
    if (opened > 0) {
      const st = (await import('../store/workflowStore')).useWorkflowStore.getState();
      st.addLog('info', `已从拖入的文件打开 ${opened} 个工作流`);
    }
  }, []);

  // Tauri 桌面端：监听原生文件拖放事件
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const handler = await getCurrentWebview().onDragDropEvent(async (event) => {
          // payload.type === 'over' 表示悬停（用于遮罩）；'drop' 表示释放
          if (event.payload.type === 'over') {
            setDragActive(true);
          } else if (event.payload.type === 'drop') {
            setDragActive(false);
            const paths = event.payload.paths ?? [];
            const fs = await import('@tauri-apps/plugin-fs');
            let opened = 0;
            for (const p of paths) {
              if (!p.toLowerCase().endsWith('.json')) continue;
              try {
                const text = await fs.readTextFile(p);
                const ok = await openWorkflowFromText(p.split(/[\\/]/).pop() ?? p, text);
                if (ok) opened++;
              } catch {
                /* 跳过无法读取的文件 */
              }
            }
            if (opened > 0) {
              const st = (await import('../store/workflowStore')).useWorkflowStore.getState();
              st.addLog('info', `已从拖入的文件打开 ${opened} 个工作流`);
            }
          } else if (event.payload.type === 'leave') {
            setDragActive(false);
          }
        });
        if (!cancelled) unlisten = handler;
      } catch {
        /* Tauri API 不可用时忽略 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    depth.current += 1;
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setDragActive(false);
        if (e.dataTransfer.files.length > 0) {
          void handleFiles(e.dataTransfer.files);
        }
      }
      // 非文件（如 React Flow 内部拖放）不拦截，交由内部 onDrop 处理
    },
    [handleFiles],
  );

  return { dragActive, onDragEnter, onDragLeave, onDragOver, onDrop };
}
