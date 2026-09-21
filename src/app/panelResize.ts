export type ResizeAxis = 'x' | 'y';
export type ResizeSide = 'left' | 'right' | 'bottom';

export interface PanelResizeDependencies {
  axis: ResizeAxis;
  side: ResizeSide;
  initial: number;
  setLeftWidth: (value: number) => void;
  setRightWidth: (value: number) => void;
  setPanelHeight: (value: number) => void;
  windowRef?: Window;
  documentRef?: Document;
}

export interface ResizePointerEvent {
  preventDefault: () => void;
  clientX: number;
  clientY: number;
  pointerId?: number;
  currentTarget?: EventTarget | null;
}

type PointerCaptureTarget = EventTarget & {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
};

interface ActiveResizeSession {
  cleanup: () => void;
  cursor: string;
  userSelect: string;
}

const activeResizeByWindow = new WeakMap<Window, ActiveResizeSession>();

export function cancelActivePanelResize(windowRef: Window = window): void {
  activeResizeByWindow.get(windowRef)?.cleanup();
}

export function installPanelResize(deps: PanelResizeDependencies): (event: ResizePointerEvent) => void {
  const windowRef = deps.windowRef ?? window;
  const documentRef = deps.documentRef ?? document;

  return (event) => {
    const previousSession = activeResizeByWindow.get(windowRef);
    const previousCursor = previousSession?.cursor ?? documentRef.body.style.cursor;
    const previousUserSelect = previousSession?.userSelect ?? documentRef.body.style.userSelect;
    cancelActivePanelResize(windowRef);
    event.preventDefault();
    const startPos = deps.axis === 'x' ? event.clientX : event.clientY;
    const sign = deps.side === 'bottom' ? -1 : 1;
    const pointerTarget = (event.currentTarget ?? null) as PointerCaptureTarget | null;
    const pointerId = event.pointerId;

    const onMove = (moveEvent: PointerEvent) => {
      const currentPos = deps.axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPos;
      const min = deps.side === 'bottom' ? 120 : 160;
      const next = Math.max(min, Math.min(480, deps.initial + sign * delta));
      if (deps.side === 'left') deps.setLeftWidth(next);
      else if (deps.side === 'right') deps.setRightWidth(next);
      else deps.setPanelHeight(next);
    };

    let session: ActiveResizeSession;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      windowRef.removeEventListener('pointermove', onMove);
      windowRef.removeEventListener('pointerup', cleanup);
      windowRef.removeEventListener('pointercancel', cleanup);
      windowRef.removeEventListener('blur', cleanup);
      windowRef.removeEventListener('pagehide', cleanup);
      documentRef.removeEventListener('visibilitychange', cleanup);
      pointerTarget?.removeEventListener('lostpointercapture', cleanup);
      if (pointerId !== undefined) {
        try {
          pointerTarget?.releasePointerCapture?.(pointerId);
        } catch {
          // Pointer capture may already be released by the browser.
        }
      }
      if (activeResizeByWindow.get(windowRef) === session) {
        activeResizeByWindow.delete(windowRef);
        documentRef.body.style.cursor = previousCursor;
        documentRef.body.style.userSelect = previousUserSelect;
      }
    };
    session = { cleanup, cursor: previousCursor, userSelect: previousUserSelect };
    activeResizeByWindow.set(windowRef, session);

    documentRef.body.style.cursor = deps.axis === 'x' ? 'col-resize' : 'row-resize';
    documentRef.body.style.userSelect = 'none';
    windowRef.addEventListener('pointermove', onMove);
    windowRef.addEventListener('pointerup', cleanup);
    windowRef.addEventListener('pointercancel', cleanup);
    windowRef.addEventListener('blur', cleanup);
    windowRef.addEventListener('pagehide', cleanup);
    documentRef.addEventListener('visibilitychange', cleanup);
    pointerTarget?.addEventListener('lostpointercapture', cleanup);
    if (pointerId !== undefined) {
      try {
        pointerTarget?.setPointerCapture?.(pointerId);
      } catch {
        // Pointer capture is best-effort for non-DOM test/host targets.
      }
    }
  };
}
