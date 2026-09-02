import { replayDomainEvents } from '../domain/contracts';
import {
  EventStoreError,
  type EventStreamRepository,
  type ParsedEventStream,
} from '../domain/eventStore';
import { migrateLegacyProjectControl } from '../domain/migration';
import type { ProjectControlSnapshot } from './types';

export interface EnsureProjectControlEventBaselineInput {
  repository: EventStreamRepository;
  projectId: string;
  snapshot: ProjectControlSnapshot;
  now: string;
  migrationId?: string;
}

export interface EnsureProjectControlEventBaselineResult {
  migrated: boolean;
  stream: ParsedEventStream;
}

function assertHealthyStream(stream: ParsedEventStream): void {
  if (stream.status !== 'needs-repair') return;
  throw new EventStoreError(
    'needs-repair',
    `事件流需要修复：第 ${stream.corruption?.line ?? '?'} 行 ${stream.corruption?.reason ?? ''}`,
  );
}

/**
 * Establish the event-source baseline for an existing project without
 * pretending that a legacy ProjectFile had an append-only history.
 */
export async function ensureProjectControlEventBaseline(
  input: EnsureProjectControlEventBaselineInput,
): Promise<EnsureProjectControlEventBaselineResult> {
  const initial = await input.repository.readStream();
  assertHealthyStream(initial);
  if (initial.status !== 'empty') return { migrated: false, stream: initial };

  await migrateLegacyProjectControl(input.repository, {
    projectId: input.projectId,
    snapshot: input.snapshot,
    now: input.now,
    migrationId: input.migrationId,
  });
  const migrated = await input.repository.readStream();
  assertHealthyStream(migrated);
  await input.repository.writeProjectionSnapshot(replayDomainEvents(migrated.events));
  return { migrated: true, stream: migrated };
}
