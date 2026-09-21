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
}

export function installPanelResize(deps: PanelResizeDependencies): (event: ResizePointerEvent) => void {
  const windowRef = deps.windowRef ?? window;
  const documentRef = deps.documentRef ?? document;

  return (event) => {
    event.preventDefault();
    const startPos = deps.axis === 'x' ? event.clientX : event.clientY;
    const sign = deps.side === 'bottom' ? -1 : 1;

    const onMove = (moveEvent: PointerEvent) => {
      const currentPos = deps.axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPos;
      const min = deps.side === 'bottom' ? 120 : 160;
      const next = Math.max(min, Math.min(480, deps.initial + sign * delta));
      if (deps.side === 'left') deps.setLeftWidth(next);
      else if (deps.side === 'right') deps.setRightWidth(next);
      else deps.setPanelHeight(next);
    };

    const previousCursor = documentRef.body.style.cursor;
    const previousUserSelect = documentRef.body.style.userSelect;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      windowRef.removeEventListener('pointermove', onMove);
      windowRef.removeEventListener('pointerup', cleanup);
      windowRef.removeEventListener('pointercancel', cleanup);
      windowRef.removeEventListener('blur', cleanup);
      documentRef.body.style.cursor = previousCursor;
      documentRef.body.style.userSelect = previousUserSelect;
    };

    documentRef.body.style.cursor = deps.axis === 'x' ? 'col-resize' : 'row-resize';
    documentRef.body.style.userSelect = 'none';
    windowRef.addEventListener('pointermove', onMove);
    windowRef.addEventListener('pointerup', cleanup);
    windowRef.addEventListener('pointercancel', cleanup);
    windowRef.addEventListener('blur', cleanup);
  };
}
