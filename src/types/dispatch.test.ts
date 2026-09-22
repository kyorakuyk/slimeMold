import { describe, expect, it } from 'vitest';
import './dispatch';
import type { AgentRouteTable, ModuleItem, TaskItem } from './dispatch';

describe('dispatch contract owner', () => {
  it('keeps task/module payloads and route tables composable', () => {
    const task: TaskItem = { label: 'Build', scope: ['src'], index: 0 };
    const module: ModuleItem = {
      name: 'UI',
      responsibility: 'Render the view',
      category: 'ui',
      dependsOn: [],
      index: 0,
    };
    const routes: AgentRouteTable = {
      ui: { agentId: 'agent-ui', fallback: ['agent-default'] },
    };

    expect(task.scope).toEqual(['src']);
    expect(module.category).toBe('ui');
    expect(routes.ui.agentId).toBe('agent-ui');
  });
});
