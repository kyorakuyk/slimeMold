import { describe, expect, it } from 'vitest';
import type { Artifact, Orchestration, PipelineDef } from './orchestration';

describe('orchestration contract owner', () => {
  it('keeps pipeline, artifact, and orchestration records structurally usable', () => {
    const pipeline = {
      id: 'pipeline-1',
      label: 'Delivery',
      stages: [{ id: 'plan', label: 'Plan', role: 'builder' }],
      edges: [],
    } satisfies PipelineDef;
    const artifact = {
      kind: 'plan',
      payload: { goal: 'ship' },
      fromWf: 'wf-plan',
      runId: 'run-1',
      version: 1,
      updatedAt: '2026-09-21T00:00:00.000Z',
    } satisfies Artifact;
    const orchestration = {
      id: 'orch-1',
      goal: 'ship',
      status: 'draft',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      draft: null,
      stageLogs: [],
      runIds: [],
    } satisfies Orchestration;

    expect({ pipeline, artifact, orchestration }).toMatchObject({
      pipeline: { id: 'pipeline-1' },
      artifact: { kind: 'plan' },
      orchestration: { status: 'draft' },
    });
  });
});
