import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const panelHarness = vi.hoisted(() => ({
  runOrchestration: vi.fn(),
}));

vi.mock('../orchestrator/run', async (importActual) => {
  const actual = await importActual<typeof import('../orchestrator/run')>();
  return { ...actual, runOrchestration: panelHarness.runOrchestration };
});

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import {
  bindStageWorkflow,
  confirmDraft,
  createDraftOrchestration,
} from '../orchestrator/confirm';
import { useWorkflowStore } from '../store/workflowStore';
import type { AgentConfig } from '../types/agent';
import OrchestratorPanel from './OrchestratorPanel';

const testAgent = {
  id: 'agent-orchestrator-test',
  name: 'Orchestrator test agent',
  protocol: 'ollama',
  model: 'llama3',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
} as unknown as AgentConfig;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function resetWorkflowStore() {
  localStorage.removeItem('slime-mold-workflow');
  localStorage.removeItem('sm.lastSession');
  act(() => useWorkflowStore.getState().closeProject());
  const current = useWorkflowStore.getState();
  useWorkflowStore.setState({
    ...current,
    projectName: 'Orchestrator panel test project',
    projectId: 'orchestrator-panel-test-project',
    projectCreatedAt: null,
    projectPath: null,
    projectDirty: false,
    lastSavedSnapshot: null,
    workflows: {},
    activeWfId: '',
    workflowName: '',
    nodes: [],
    edges: [],
    agents: [testAgent],
    globalAgents: [],
    defaultAgentId: testAgent.id,
    agentRouteTable: {},
    orchestrations: [],
    workerRuns: [],
    workerRunRecoveries: [],
    workerRunEvidence: [],
    workerRunSideEffects: [],
    workerCleanupProposals: [],
    logs: [],
    projectControl: current.projectControl,
  } as never, true);
  useWorkflowStore.setState({ projectDirty: false });
}

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function seedReadyOrchestration(goal: string) {
  const orchestration = createDraftOrchestration(
    { goal, source: 'ui' },
    { agents: [testAgent], defaultAgentId: testAgent.id },
  );
  const workflows: Record<string, unknown> = {};
  for (const stage of orchestration.draft?.stages ?? []) {
    const wfId = `wf-${stage.id}`;
    bindStageWorkflow(orchestration.id, stage.id, { kind: 'existing', wfId });
    workflows[wfId] = {
      name: wfId,
      nodes: [{
        id: `node-${stage.id}`,
        type: 'base',
        position: { x: 0, y: 0 },
        data: { typeId: 'input.text', label: stage.label, params: {}, status: 'idle' },
      }],
      edges: [],
    };
  }
  useWorkflowStore.setState({ workflows } as never);
  confirmDraft(orchestration.id, 'approved');
  return orchestration;
}

describe('OrchestratorPanel characterization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetWorkflowStore();
    panelHarness.runOrchestration.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetWorkflowStore();
  });

  it('creates an awaiting-confirm orchestration from the goal form and stores it', async () => {
    await act(async () => {
      root.render(<OrchestratorPanel embedded />);
    });

    const goalInput = container.querySelector(
      'textarea[placeholder="orchestrator.goalPlaceholder"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(goalInput, 'Add a local command and its tests');
    });
    const generateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('orchestrator.generate'),
    );
    expect(generateButton?.disabled).toBe(false);

    await act(async () => {
      generateButton?.click();
    });

    const [orchestration] = useWorkflowStore.getState().orchestrations;
    expect(useWorkflowStore.getState().orchestrations).toHaveLength(1);
    expect(orchestration).toMatchObject({
      goal: 'Add a local command and its tests',
      status: 'awaiting-confirm',
      readonly: undefined,
    });
    expect(orchestration.draft?.stages).toHaveLength(3);
    expect(container.textContent).toContain('orchestrator.status.awaiting-confirm');
  });

  it('clears the run busy state and shows the rejection after a browser-safe executor failure', async () => {
    const goal = 'Exercise the mocked orchestration path';
    const orchestration = seedReadyOrchestration(goal);
    const gate = (() => {
      let reject!: (reason: unknown) => void;
      const promise = new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
      return { promise, reject };
    })();
    panelHarness.runOrchestration.mockReturnValue(gate.promise);

    await act(async () => {
      root.render(<OrchestratorPanel embedded />);
    });
    const listItem = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(goal),
    );
    expect(listItem).toBeDefined();
    await act(async () => {
      (listItem as HTMLButtonElement).click();
    });

    const runButton = container.querySelector(
      'button[title="orchestrator.hint.ready"]',
    ) as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);
    await act(async () => {
      runButton.click();
      await Promise.resolve();
    });
    expect(runButton.disabled).toBe(true);
    expect(panelHarness.runOrchestration).toHaveBeenCalledWith(orchestration.id);

    await act(async () => {
      gate.reject(new Error('synthetic executor rejection'));
      await gate.promise.catch(() => undefined);
    });

    const settledRunButton = container.querySelector(
      'button[title="orchestrator.hint.ready"]',
    ) as HTMLButtonElement;
    expect(settledRunButton.disabled).toBe(false);
    expect(container.textContent).toContain('synthetic executor rejection');
  });

  it('preserves the modal frame by default and omits it in embedded mode', async () => {
    await act(async () => {
      root.render(<OrchestratorPanel />);
    });
    expect(container.querySelector('.fixed.inset-0')).not.toBeNull();

    await act(async () => {
      root.render(<OrchestratorPanel embedded />);
    });
    expect(container.querySelector('.fixed.inset-0')).toBeNull();
    expect(container.textContent).toContain('orchestrator.goalLabel');
  });
});
