import { describe, expect, it } from 'vitest';
import './projectFile';
import type { ProjectFile } from './projectFile';

describe('project file contract owner', () => {
  it('keeps the project envelope linked to workflow persistence contracts', () => {
    const project: ProjectFile = {
      version: 1,
      kind: 'project',
      id: 'project-1',
      name: 'Project',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workflows: {},
      activeId: 'workflow-1',
    };

    expect(project.kind).toBe('project');
    expect(project.workflows).toEqual({});
    expect(project.activeId).toBe('workflow-1');
  });
});
