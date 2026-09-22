/** workflowState compatibility barrel direct test. */
import { describe, expect, it } from 'vitest';
import { buildNewProjectState as barrelBuildNewProjectState } from './workflowState';
import { buildNewProjectState as lifecycleBuildNewProjectState } from './workflowLifecycleState';
import { upsertById as barrelUpsertById } from './workflowState';
import { upsertById as catalogUpsertById } from './projectCatalogState';

describe('workflowState compatibility barrel', () => {
  it('re-exports fact-owned state builders and catalog helpers', () => {
    expect(barrelBuildNewProjectState).toBe(lifecycleBuildNewProjectState);
    expect(barrelUpsertById).toBe(catalogUpsertById);
  });
});
