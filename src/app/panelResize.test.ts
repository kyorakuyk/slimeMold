import { describe, expect, it } from 'vitest';
import { installPanelResize } from './panelResize';

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
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');

    handler({ preventDefault: () => undefined, clientX: 0, clientY: 208 });
    window.dispatchEvent(new Event('blur'));
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
});