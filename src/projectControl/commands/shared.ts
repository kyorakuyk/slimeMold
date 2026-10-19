import { appendDomainEvent, type DomainEvent } from '../../domain/contracts';
import type { ProjectControlSnapshot } from '../types';

export interface ProjectControlCommandResult {
  snapshot: ProjectControlSnapshot;
  events: DomainEvent[];
}

export function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

export function appendFact(
  events: DomainEvent[],
  event: Omit<DomainEvent, 'sequence' | 'aggregateVersion'>,
): void {
  const previous = [...events]
    .reverse()
    .find((item) => item.aggregateType === event.aggregateType && item.aggregateId === event.aggregateId);
  const next: DomainEvent = {
    ...event,
    sequence: events.length + 1,
    aggregateVersion: (previous?.aggregateVersion ?? 0) + 1,
  };
  events.splice(0, events.length, ...appendDomainEvent(events, next));
}
