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
      let next = deps.initial + sign * delta;
      next = Math.max(160, Math.min(480, next));
      if (deps.side === 'bottom') next = Math.max(120, Math.min(480, next));
      if (deps.side === 'left') deps.setLeftWidth(next);
      else if (deps.side === 'right') deps.setRightWidth(next);
      else deps.setPanelHeight(next);
    };

    const onUp = () => {
      windowRef.removeEventListener('pointermove', onMove);
      windowRef.removeEventListener('pointerup', onUp);
      documentRef.body.style.cursor = '';
      documentRef.body.style.userSelect = '';
    };

    documentRef.body.style.cursor = deps.axis === 'x' ? 'col-resize' : 'row-resize';
    documentRef.body.style.userSelect = 'none';
    windowRef.addEventListener('pointermove', onMove);
    windowRef.addEventListener('pointerup', onUp);
  };
}
