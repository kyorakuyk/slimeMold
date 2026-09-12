import {
  validateAgentScope,
  type ProjectAgentRole,
  type ProjectDataClass,
  type ProjectTool,
} from './hierarchy';
import type { ContextPack } from './protocol';

export type ContextAccess =
  | { kind: 'file'; value: string }
  | { kind: 'data-class'; value: ProjectDataClass }
  | { kind: 'tool'; value: ProjectTool }
  | { kind: 'agent-role'; value: ProjectAgentRole };

export interface ContextAccessResult {
  allowed: boolean;
  reason: string;
}

export function checkContextAccess(
  pack: ContextPack,
  access: ContextAccess,
): ContextAccessResult {
  const scope = validateAgentScope(pack.scope, 'contextPack.scope');
  switch (access.kind) {
    case 'file':
      return scope.allowedFiles.includes(access.value)
        ? { allowed: true, reason: 'file-in-scope' }
        : { allowed: false, reason: 'file-out-of-scope' };
    case 'data-class':
      return scope.allowedDataClasses.includes(access.value)
        ? { allowed: true, reason: 'data-class-in-scope' }
        : { allowed: false, reason: 'data-class-out-of-scope' };
    case 'tool':
      return scope.allowedTools.includes(access.value)
        ? { allowed: true, reason: 'tool-allowed' }
        : { allowed: false, reason: 'tool-not-allowed' };
    case 'agent-role':
      return scope.allowedAgentRoles.includes(access.value)
        ? { allowed: true, reason: 'agent-role-allowed' }
        : { allowed: false, reason: 'agent-role-not-allowed' };
  }
}

export function assertContextAccess(pack: ContextPack, access: ContextAccess): void {
  const result = checkContextAccess(pack, access);
  if (!result.allowed) {
    throw new Error(`ContextPack 拒绝 ${access.kind} 访问：${result.reason}`);
  }
}
