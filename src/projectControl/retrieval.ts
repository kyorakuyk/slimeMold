import type { AgentScope } from './hierarchy';
import { validateAgentScope } from './hierarchy';
import {
  queryEvidenceIndex,
  type EvidenceIndex,
  type EvidenceIndexEntry,
  type EvidenceIndexQuery,
  type EvidenceQueryResult,
  type EvidenceQueryStatus,
} from './evidenceIndex';

export interface ScopedEvidenceQuery extends Omit<EvidenceIndexQuery, 'projectId'> {
  scope: AgentScope;
  projectId?: string;
  maxTokens: number;
}

export interface RetrievalBudget {
  maxTokens: number;
  estimatedTokens: number;
  returned: number;
  truncated: boolean;
}

export type RetrievalSelection = 'exact-reference' | 'metadata-filter' | 'keyword-candidate';

export interface ScopedEvidenceQueryResult extends EvidenceQueryResult {
  selection: RetrievalSelection;
  authoritative: boolean;
  budget: RetrievalBudget;
}

function requiredPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是大于 0 的安全整数`);
  return value;
}

function selectionOf(query: ScopedEvidenceQuery): RetrievalSelection {
  if (query.exactIds !== undefined && query.exactIds.length > 0) return 'exact-reference';
  if (query.keywords !== undefined && query.keywords.length > 0) return 'keyword-candidate';
  return 'metadata-filter';
}

function entryTokenEstimate(entry: EvidenceIndexEntry): number {
  return Math.max(1, Math.ceil(JSON.stringify(entry).length / 4));
}

function limitByTokenBudget(
  entries: readonly EvidenceIndexEntry[],
  maxTokens: number,
): { entries: EvidenceIndexEntry[]; estimatedTokens: number; truncated: boolean } {
  const selected: EvidenceIndexEntry[] = [];
  let estimatedTokens = 0;
  for (const entry of entries) {
    const cost = entryTokenEstimate(entry);
    if (estimatedTokens + cost > maxTokens) break;
    selected.push(entry);
    estimatedTokens += cost;
  }
  return {
    entries: selected,
    estimatedTokens,
    truncated: selected.length < entries.length,
  };
}

function deniedResult(
  index: EvidenceIndex,
  selection: RetrievalSelection,
  maxTokens: number,
): ScopedEvidenceQueryResult {
  return {
    status: 'out-of-scope',
    entries: [],
    matchedCount: 0,
    sourceVersion: index.sourceVersion,
    selection,
    authoritative: false,
    budget: {
      maxTokens,
      estimatedTokens: 0,
      returned: 0,
      truncated: false,
    },
  };
}

export function queryEvidenceWithinScope(
  index: EvidenceIndex,
  query: ScopedEvidenceQuery,
): ScopedEvidenceQueryResult {
  const scope = validateAgentScope(query.scope, 'retrieval.scope');
  const selection = selectionOf(query);
  const maxTokens = Math.min(
    requiredPositiveInteger(query.maxTokens, 'maxTokens'),
    scope.maxTokens,
  );
  if (
    !scope.allowedDataClasses.includes('evidence')
    || !scope.allowedTools.includes('read-evidence')
  ) {
    return deniedResult(index, selection, maxTokens);
  }

  const result = queryEvidenceIndex(index, {
    ...query,
    projectId: query.projectId,
  });
  const bounded = limitByTokenBudget(result.entries, maxTokens);
  const status: EvidenceQueryStatus = bounded.truncated ? 'truncated' : result.status;
  return {
    ...result,
    status,
    entries: bounded.entries,
    selection,
    authoritative: selection !== 'keyword-candidate',
    budget: {
      maxTokens,
      estimatedTokens: bounded.estimatedTokens,
      returned: bounded.entries.length,
      truncated: bounded.truncated,
    },
  };
}
