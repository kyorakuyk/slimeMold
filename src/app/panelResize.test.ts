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
});
