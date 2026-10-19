import { expect, it } from 'vitest';
import type { WorkflowRegistryActions } from './workflowRegistryActions';
import type { WorkflowState } from './workflowStoreTypes';

type IsEqual<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;

const resultIsExposed: IsEqual<
  ReturnType<WorkflowState['newWorkflowInProject']>,
  ReturnType<WorkflowRegistryActions['newWorkflowInProject']>
> = true;

it('exposes the explicit workflow creation result through WorkflowState', () => {
  expect(resultIsExposed).toBe(true);
});
