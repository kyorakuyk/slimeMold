import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VIEW_MODULES = [
  'OrchestratorPanelDetailView.tsx',
  'OrchestratorPanelListView.tsx',
  'OrchestratorPanelTaskGraphSection.tsx',
  'OrchestratorPanelWorkerRunsView.tsx',
] as const;

describe('OrchestratorPanel view dependency boundary', () => {
  it.each(VIEW_MODULES)('%s does not depend on the view store module', (moduleName) => {
    const source = readFileSync(resolve(process.cwd(), 'src/components', moduleName), 'utf8');
    expect(source).not.toContain('store/viewStore');
  });
});
