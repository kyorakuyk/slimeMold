import { describe, expect, it } from 'vitest';
import { cancelActivePanelResize, installPanelResize } from './panelResize';

describe('panel resize adapter', () => {
  it('updates the selected panel and cleans pointer listeners/styles', () => {
    const sizes = { left: 248, right: 288, bottom: 208 };
    const handler = installPanelResize({
      axis: 'x',
      side: 'left',
      initial: sizes.left,
      setLeftWidth: (value) => { sizes.left = value; },
      setRightWidth: (value) => { sizes.right = value; },
      setPanelHeight: (value) => { sizes.bottom = value; },
    });
    const event = { preventDefault: () => undefined, clientX: 248, clientY: 0 };

    handler(event);
    expect(document.body.style.cursor).toBe('col-resize');
    const move = new Event('pointermove') as PointerEvent;
    Object.defineProperties(move, { clientX: { value: 348 }, clientY: { value: 0 } });
    window.dispatchEvent(move);
    expect(sizes.left).toBe(348);
    window.dispatchEvent(new Event('pointerup'));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('uses the bottom minimum and restores styles on cancellation/blur', () => {
    const sizes = { bottom: 208 };
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
    const handler = installPanelResize({
      axis: 'y',
      side: 'bottom',
      initial: sizes.bottom,
      setLeftWidth: () => undefined,
      setRightWidth: () => undefined,
      setPanelHeight: (value) => { sizes.bottom = value; },
    });

    handler({ preventDefault: () => undefined, clientX: 0, clientY: 208 });
    const move = new Event('pointermove') as PointerEvent;
    Object.defineProperties(move, { clientX: { value: 0 }, clientY: { value: 408 } });
    window.dispatchEvent(move);
    expect(sizes.bottom).toBe(120);
    expect(document.body.style.cursor).toBe('row-resize');

    window.dispatchEvent(new Event('pointercancel'));
    const cancelledSize = sizes.bottom;
    const cancelledMove = new Event('pointermove') as PointerEvent;
    Object.defineProperties(cancelledMove, { clientX: { value: 0 }, clientY: { value: 0 } });
    window.dispatchEvent(cancelledMove);
    expect(sizes.bottom).toBe(cancelledSize);
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');

    handler({ preventDefault: () => undefined, clientX: 0, clientY: 208 });
    window.dispatchEvent(new Event('blur'));
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('arbitrates overlapping sessions and exposes explicit cancellation', () => {
    const sizes = { first: 200, second: 300 };
    const first = installPanelResize({
      axis: 'x',
      side: 'left',
      initial: sizes.first,
      setLeftWidth: (value) => { sizes.first = value; },
      setRightWidth: () => undefined,
      setPanelHeight: () => undefined,
    });
    first({ preventDefault: () => undefined, clientX: 200, clientY: 0 });

    const second = installPanelResize({
      axis: 'x',
      side: 'right',
      initial: sizes.second,
      setLeftWidth: () => undefined,
      setRightWidth: (value) => { sizes.second = value; },
      setPanelHeight: () => undefined,
    });
    second({ preventDefault: () => undefined, clientX: 300, clientY: 0 });

    const move = new Event('pointermove') as PointerEvent;
    Object.defineProperties(move, { clientX: { value: 340 }, clientY: { value: 0 } });
    window.dispatchEvent(move);
    expect(sizes.first).toBe(200);
    expect(sizes.second).toBe(340);

    cancelActivePanelResize();
    const afterCancel = new Event('pointermove') as PointerEvent;
    Object.defineProperties(afterCancel, { clientX: { value: 380 }, clientY: { value: 0 } });
    window.dispatchEvent(afterCancel);
    expect(sizes.second).toBe(340);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('preserves root styles during a reentrant replacement cleanup', () => {
    document.body.style.cursor = 'initial-cursor';
    document.body.style.userSelect = 'initial-select';
    let replacement: () => void = () => undefined;
    const captureTarget = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setPointerCapture: () => undefined,
      releasePointerCapture: () => replacement(),
    } as unknown as EventTarget;
    const first = installPanelResize({
      axis: 'x',
      side: 'left',
      initial: 200,
      setLeftWidth: () => undefined,
      setRightWidth: () => undefined,
      setPanelHeight: () => undefined,
    });
    const second = installPanelResize({
      axis: 'y',
      side: 'bottom',
      initial: 200,
      setLeftWidth: () => undefined,
      setRightWidth: () => undefined,
      setPanelHeight: () => undefined,
    });
    replacement = () => second({ preventDefault: () => undefined, clientX: 0, clientY: 200 });

    first({
      preventDefault: () => undefined,
      clientX: 200,
      clientY: 0,
      pointerId: 1,
      currentTarget: captureTarget,
    });
    cancelActivePanelResize();
    expect(document.body.style.cursor).toBe('row-resize');
    expect(document.body.style.userSelect).toBe('none');

    cancelActivePanelResize();
    expect(document.body.style.cursor).toBe('initial-cursor');
    expect(document.body.style.userSelect).toBe('initial-select');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('ignores stale pointer events after a replacement session', () => {
    const sizes = { first: 200, second: 300 };
    const first = installPanelResize({
      axis: 'x',
      side: 'left',
      initial: sizes.first,
      setLeftWidth: (value) => { sizes.first = value; },
      setRightWidth: () => undefined,
      setPanelHeight: () => undefined,
    });
    const second = installPanelResize({
      axis: 'x',
      side: 'right',
      initial: sizes.second,
      setLeftWidth: () => undefined,
      setRightWidth: (value) => { sizes.second = value; },
      setPanelHeight: () => undefined,
    });
    first({ preventDefault: () => undefined, clientX: 200, clientY: 0, pointerId: 1 });
    second({ preventDefault: () => undefined, clientX: 300, clientY: 0, pointerId: 2 });

    const dispatchPointer = (type: string, pointerId: number, clientX: number) => {
      const event = new Event(type) as PointerEvent;
      Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: 0 }, pointerId: { value: pointerId } });
      window.dispatchEvent(event);
    };

    dispatchPointer('pointermove', 1, 360);
    expect(sizes.second).toBe(300);
    dispatchPointer('pointerup', 1, 360);
    dispatchPointer('pointermove', 2, 340);
    expect(sizes.second).toBe(340);
    dispatchPointer('pointerup', 2, 340);
    expect(document.body.style.cursor).toBe('');
  });

  it('does not overwrite a nested replacement created during cleanup', () => {
    const sizes = { nested: 200 };
    let nestedStart: () => void = () => undefined;
    const captureTarget = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setPointerCapture: () => undefined,
      releasePointerCapture: () => nestedStart(),
    } as unknown as EventTarget;
    const first = installPanelResize({ axis: 'x', side: 'left', initial: 200, setLeftWidth: () => undefined, setRightWidth: () => undefined, setPanelHeight: () => undefined });
    const outer = installPanelResize({ axis: 'x', side: 'right', initial: 300, setLeftWidth: () => undefined, setRightWidth: () => undefined, setPanelHeight: () => undefined });
    const nested = installPanelResize({ axis: 'y', side: 'bottom', initial: sizes.nested, setLeftWidth: () => undefined, setRightWidth: () => undefined, setPanelHeight: (value) => { sizes.nested = value; } });
    nestedStart = () => nested({ preventDefault: () => undefined, clientX: 0, clientY: 200, pointerId: 3 });

    first({ preventDefault: () => undefined, clientX: 200, clientY: 0, pointerId: 1, currentTarget: captureTarget });
    outer({ preventDefault: () => undefined, clientX: 300, clientY: 0, pointerId: 2 });
    const move = new Event('pointermove') as PointerEvent;
    Object.defineProperties(move, { clientX: { value: 0 }, clientY: { value: 230 }, pointerId: { value: 3 } });
    window.dispatchEvent(move);
    expect(sizes.nested).toBe(170);
    expect(document.body.style.cursor).toBe('row-resize');
    cancelActivePanelResize();
  });

  it('filters lost pointer capture by active pointer id', () => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); },
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
    } as unknown as EventTarget;
    const handler = installPanelResize({ axis: 'x', side: 'left', initial: 200, setLeftWidth: () => undefined, setRightWidth: () => undefined, setPanelHeight: () => undefined });
    handler({ preventDefault: () => undefined, clientX: 200, clientY: 0, pointerId: 2, currentTarget: target });
    const lost = listeners.get('lostpointercapture');
    lost?.({ pointerId: 1 } as unknown as Event);
    expect(document.body.style.cursor).toBe('col-resize');
    lost?.({ pointerId: 2 } as unknown as Event);
    expect(document.body.style.cursor).toBe('');
  });
});
