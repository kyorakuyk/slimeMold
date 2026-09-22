import type { DelegationRequest } from './protocol';

export interface DelegationGraph {
  projectId: string;
  requests: readonly DelegationRequest[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function cloneRequest(request: DelegationRequest): DelegationRequest {
  return {
    ...request,
    effectiveScope: {
      ...request.effectiveScope,
      allowedFiles: [...request.effectiveScope.allowedFiles],
      allowedDataClasses: [...request.effectiveScope.allowedDataClasses],
      allowedTools: [...request.effectiveScope.allowedTools],
      allowedAgentRoles: [...request.effectiveScope.allowedAgentRoles],
    },
    allowedEvidenceRefs: request.allowedEvidenceRefs.map((reference) => ({ ...reference })),
    budget: { ...request.budget },
    expectedOutputs: [...request.expectedOutputs],
  };
}

export function emptyDelegationGraph(projectId: string): DelegationGraph {
  return { projectId: requiredText(projectId, 'projectId'), requests: [] };
}

function wouldCreateCycle(
  requests: readonly DelegationRequest[],
  candidate: DelegationRequest,
): boolean {
  const childrenByParent = new Map<string, string[]>();
  for (const request of [...requests, candidate]) {
    const children = childrenByParent.get(request.parentTaskId) ?? [];
    children.push(request.childTaskId);
    childrenByParent.set(request.parentTaskId, children);
  }

  const visited = new Set<string>();
  const pending = [candidate.childTaskId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === candidate.parentTaskId) return true;
    visited.add(current);
    pending.push(...(childrenByParent.get(current) ?? []));
  }
  return false;
}

export function registerDelegation(
  graph: DelegationGraph,
  request: DelegationRequest,
): DelegationGraph {
  if (request.projectId !== graph.projectId) {
    throw new Error('DelegationRequest 不属于当前 project');
  }
  const existingById = graph.requests.find((item) => item.delegationId === request.delegationId);
  if (existingById) {
    if (JSON.stringify(existingById) === JSON.stringify(request)) return graph;
    throw new Error(`delegationId 已存在但内容不同：${request.delegationId}`);
  }
  const existingByKey = graph.requests.find((item) => item.idempotencyKey === request.idempotencyKey);
  if (existingByKey) {
    throw new Error(`idempotencyKey 已存在：${request.idempotencyKey}`);
  }
  const siblingCount = graph.requests.filter((item) => item.parentTaskId === request.parentTaskId).length;
  if (siblingCount >= request.maxFanout) {
    throw new Error(`parent task 超出 delegation fan-out：${request.parentTaskId}`);
  }
  if (wouldCreateCycle(graph.requests, request)) {
    throw new Error(`delegation graph 存在 cycle：${request.parentTaskId} → ${request.childTaskId}`);
  }

  return {
    projectId: graph.projectId,
    requests: [...graph.requests.map(cloneRequest), cloneRequest(request)],
  };
}
