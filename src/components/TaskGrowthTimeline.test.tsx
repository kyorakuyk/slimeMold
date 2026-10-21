import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../domain/contracts';
import type { GraphGrowthMarker, GraphGrowthProjection } from '../projectControl/graphGrowthProjection';

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import TaskGrowthTimeline from './TaskGrowthTimeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function event(sequence: number): DomainEvent {
  return {
    eventId: `evt-${sequence}`,
    streamId: 'stream-1',
    sequence,
    aggregateType: 'Project',
    aggregateId: 'project-1',
    aggregateVersion: sequence,
    eventType: `Event${sequence}`,
    schemaVersion: 1,
    payload: {},
    actor: 'runtime',
    occurredAt: `2026-10-20T00:00:0${sequence}.000Z`,
  };
}

function marker(
  sequence: number,
  kind: GraphGrowthMarker['kind'],
): GraphGrowthMarker {
  return {
    id: `marker-${sequence}`,
    eventId: `evt-${sequence}`,
    eventType: `Event${sequence}`,
    sequence,
    occurredAt: `2026-10-20T00:00:0${sequence}.000Z`,
    actor: kind === 'user-intervention' ? 'user' : 'runtime',
    kind,
  };
}

function projection(uptoSeq: number, lastSequence: number): GraphGrowthProjection {
  return {
    uptoSeq,
    lastSequence,
    nodes: [],
    edges: [],
    flow: [],
    scars: [],
    rings: [],
    capsules: [],
    markers: [marker(1, 'decision'), marker(2, 'failure'), marker(3, 'user-intervention')],
    legacyGraphIds: [],
  };
}

describe('TaskGrowthTimeline', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderTimeline(overrides: Partial<{
    events: readonly DomainEvent[];
    projection: GraphGrowthProjection;
    onSeek: (sequence: number) => void;
    onReturnToLive: () => void;
  }> = {}) {
    const props = {
      events: [event(1), event(2), event(3), event(4)],
      projection: projection(2, 4),
      onSeek: vi.fn(),
      onReturnToLive: vi.fn(),
      ...overrides,
    };
    act(() => root.render(<TaskGrowthTimeline {...props} />));
    return props;
  }

  it('shows event density and decision, failure, and user-intervention markers by sequence', () => {
    renderTimeline();

    const bars = Array.from(container.querySelectorAll('[data-testid="timeline-event-bar"]'));
    expect(bars).toHaveLength(4);
    expect(bars.map((bar) => bar.getAttribute('data-event-count'))).toEqual(['1', '1', '1', '1']);
    expect(Array.from(container.querySelectorAll('[data-testid="timeline-marker"]'))
      .map((item) => item.getAttribute('data-kind')))
      .toEqual(['decision', 'failure', 'user-intervention']);
    expect(Array.from(container.querySelectorAll('[data-testid="timeline-marker"]'))
      .map((item) => item.getAttribute('data-sequence')))
      .toEqual(['1', '2', '3']);
  });

  it('bounds dense streams to a readable bar count without dropping events', () => {
    const events = Array.from({ length: 120 }, (_, index) => event(index + 1));
    renderTimeline({ events, projection: projection(120, 120) });

    const bars = Array.from(container.querySelectorAll('[data-testid="timeline-event-bar"]'));
    expect(bars).toHaveLength(80);
    expect(bars.reduce((total, bar) => total + Number(bar.getAttribute('data-event-count')), 0)).toBe(120);
    expect(bars[0].getAttribute('data-sequence-start')).toBe('1');
    expect(bars.at(-1)?.getAttribute('data-sequence-end')).toBe('120');
  });

  it('seeks immediately by sequence', () => {
    const onSeek = vi.fn();
    renderTimeline({ onSeek });

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.value).toBe('2');
    expect(slider.max).toBe('4');

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(slider, '3');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onSeek).toHaveBeenCalledWith(3);
  });

  it('leaves replay status controls to the workspace owner', () => {
    renderTimeline({ projection: projection(2, 4) });

    expect(container.querySelector('[data-testid="timeline-return-live"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-replay-state"]')).toBeNull();
  });

  it('shows an empty state when the event stream has no sequence', () => {
    renderTimeline({ events: [], projection: projection(0, 0) });

    expect(container.textContent).toContain('timeline.empty');
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });
});
