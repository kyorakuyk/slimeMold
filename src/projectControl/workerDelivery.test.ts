import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAttemptId, createTaskExecutionId } from '../domain/execution';
import { NodeFileEventStoreAdapter } from '../domain/eventStore';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import type { FilePatchSetApplyResult } from '../dev/patch-set';
import { createTypeScriptMvpScaffold, type FilePatchSet } from '../domain/model/artifact';
import { hashContent } from '../dev/capabilities';
import { withTestArtifactRoot } from '../dev/test-artifacts';
import {
  buildArtifactCandidate,
  createArtifactDeliveryApproval,
  createNodeArtifactDeliveryFileOps,
  deliverArtifactCandidate,
  type ArtifactCandidate,
  type ArtifactDeliveryApproval,
} from './workerDelivery';

const lineage = {
  runId: 'run-delivery-1',
  taskId: 'task-delivery-1',
  taskExecutionId: createTaskExecutionId('run-delivery-1', 'task-delivery-1'),
  attemptId: createAttemptId(createTaskExecutionId('run-delivery-1', 'task-delivery-1'), 1),
};

function acceptanceFor(sourceWorktreePath: string) {
  return {
    acceptanceId: 'acceptance-delivery-1',
    orchestrationId: 'orchestration-delivery-1',
    stageId: 'stage-delivery-1',
    worktreePath: sourceWorktreePath,
    passed: true,
    failedChecks: [],
    at: '2026-09-04T20:00:00.000Z',
    ...lineage,
  };
}

async function createCandidate(sourceWorktreePath: string): Promise<ArtifactCandidate> {
  const content = 'export const delivered = true;\n';
  const patchSet: FilePatchSet = {
    schemaVersion: 1,
    source: 'scaffold',
    summary: 'delivery test',
    patches: [{ path: 'src/delivered.ts', before: null, after: content }],
  };
  const applied: FilePatchSetApplyResult = {
    appliedPaths: ['src/delivered.ts'],
    contentHashes: { 'src/delivered.ts': hashContent(content) },
  };
  return buildArtifactCandidate({
    candidateId: 'candidate-delivery-1',
    sourceWorktreePath,
    acceptance: acceptanceFor(sourceWorktreePath),
    patchSet,
    applyResult: applied,
    createdAt: '2026-09-04T20:01:00.000Z',
  });
}

function approval(candidate: ArtifactCandidate, destinationRoot: string): ArtifactDeliveryApproval {
  return createArtifactDeliveryApproval(candidate, {
    approvalId: 'approval-delivery-1',
    destinationRoot,
    approvedBy: 'user',
    approvedAt: '2026-09-04T20:02:00.000Z',
  });
}

describe('artifact delivery', () => {
  it('copies accepted worktree files into the approved destination and persists a full receipt', async () => {
    await withTestArtifactRoot('artifact-delivery-success', async (root) => {
      const source = join(root, 'worker');
      const destination = join(root, 'project');
      await mkdir(join(source, 'src'), { recursive: true });
      await mkdir(join(destination, 'src'), { recursive: true });
      const sourcePath = join(source, 'src/delivered.ts');
      await writeFile(sourcePath, 'export const delivered = true;\n', 'utf8');
      const candidate = await createCandidate(source);
      const approved = approval(candidate, destination);
      const repository = new SideEffectJournalRepository(new NodeFileEventStoreAdapter(root), root);
      const fileOps = createNodeArtifactDeliveryFileOps();

      const first = await deliverArtifactCandidate({
        candidate,
        approval: approved,
        acceptance: acceptanceFor(candidate.sourceWorktreePath),
        repository,
        fileOps,
        now: '2026-09-04T20:03:00.000Z',
      });
      const second = await deliverArtifactCandidate({
        candidate,
        approval: approved,
        acceptance: acceptanceFor(candidate.sourceWorktreePath),
        repository,
        fileOps,
        now: '2026-09-04T20:04:00.000Z',
      });
      const forgedExecution = createTaskExecutionId('run-other', 'task-other');
      const forgedCandidate = {
        ...candidate,
        runId: 'run-other',
        taskId: 'task-other',
        taskExecutionId: forgedExecution,
        attemptId: createAttemptId(forgedExecution, 1),
      };
      const forgedApproval = approval(forgedCandidate, destination);
      const failedAcceptance = { ...acceptanceFor(candidate.sourceWorktreePath), passed: false, failedChecks: ['compile'] };

      await expect(readFile(join(destination, 'src/delivered.ts'), 'utf8')).resolves.toBe(
        'export const delivered = true;\n',
      );
      expect(first.receipt).toEqual(second.receipt);
      await expect(deliverArtifactCandidate({
        candidate: forgedCandidate,
        approval: forgedApproval,
        acceptance: acceptanceFor(candidate.sourceWorktreePath),
        repository,
        fileOps,
        now: '2026-09-04T20:05:00.000Z',
      })).rejects.toThrow(/lineage|不一致/);
      await expect(deliverArtifactCandidate({
        candidate,
        approval: approved,
        acceptance: failedAcceptance,
        repository,
        fileOps,
        now: '2026-09-04T20:05:00.000Z',
      } as unknown as Parameters<typeof deliverArtifactCandidate>[0])).rejects.toThrow(/Acceptance|验收/);
      expect(first.receipt).toMatchObject({
        candidateId: candidate.candidateId,
        approvalId: approved.approvalId,
        destinationRoot: destination,
        outcome: 'succeeded',
        files: [{ path: 'src/delivered.ts', contentHash: hashContent('export const delivered = true;\n') }],
      });
      await expect(repository.read()).resolves.toMatchObject({
        status: 'ok',
        journal: {
          entries: [{
            kind: 'artifact-delivery',
            status: 'receipt',
            receipt: { artifactCandidateId: candidate.candidateId, approvalId: approved.approvalId },
          }],
        },
      });
    });
  });

  it('rejects a candidate that is not based on a passed acceptance', async () => {
    await withTestArtifactRoot('artifact-delivery-validation', async (root) => {
      const candidate = await createCandidate(join(root, 'worker'));
      const scaffold = createTypeScriptMvpScaffold('unused');
      expect(() => buildArtifactCandidate({
        candidateId: 'candidate-failed',
        sourceWorktreePath: candidate.sourceWorktreePath,
        acceptance: {
          acceptanceId: candidate.acceptanceId,
          orchestrationId: candidate.orchestrationId,
          stageId: candidate.stageId,
          worktreePath: candidate.sourceWorktreePath,
          passed: false,
          failedChecks: ['compile'],
          at: candidate.createdAt,
          ...lineage,
        },
        patchSet: scaffold.patchSet,
        applyResult: {
          appliedPaths: scaffold.patchSet.patches.map((patch) => patch.path),
          contentHashes: Object.fromEntries(
            scaffold.patchSet.patches.map((patch) => [patch.path, hashContent(patch.after)]),
          ),
        },
        createdAt: candidate.createdAt,
      })).toThrow(/Acceptance|验收/);
    });
  });

  it('records unknown and refuses overwrite when an approved destination file already exists', async () => {
    await withTestArtifactRoot('artifact-delivery-conflict', async (root) => {
      const source = join(root, 'worker');
      const destination = join(root, 'project');
      await mkdir(join(source, 'src'), { recursive: true });
      await mkdir(join(destination, 'src'), { recursive: true });
      await writeFile(join(source, 'src/delivered.ts'), 'export const delivered = true;\n', 'utf8');
      await writeFile(join(destination, 'src/delivered.ts'), 'user content\n', 'utf8');
      const candidate = await createCandidate(source);
      const approved = approval(candidate, destination);
      const repository = new SideEffectJournalRepository(new NodeFileEventStoreAdapter(root), root);
      const fileOps = createNodeArtifactDeliveryFileOps();
      const input = {
        candidate,
        approval: approved,
        acceptance: acceptanceFor(candidate.sourceWorktreePath),
        repository,
        fileOps,
        now: '2026-09-04T20:05:00.000Z',
      };

      await expect(deliverArtifactCandidate(input)).rejects.toThrow(/已存在|覆盖|unknown|未知/);
      await expect(deliverArtifactCandidate(input)).rejects.toThrow(/人工|unknown|核对/);
      await expect(readFile(join(destination, 'src/delivered.ts'), 'utf8')).resolves.toBe('user content\n');
      await expect(repository.read()).resolves.toMatchObject({
        journal: { entries: [{ kind: 'artifact-delivery', status: 'unknown', recovery: 'needs-user' }] },
      });
    });
  });

  it('rejects an unsafe candidate path before claiming a delivery side effect', async () => {
    await withTestArtifactRoot('artifact-delivery-candidate-validation', async (root) => {
      const source = join(root, 'worker');
      const destination = join(root, 'project');
      await mkdir(join(destination, 'src'), { recursive: true });
      const candidate = await createCandidate(source);
      const malformedCandidate = {
        ...candidate,
        files: [{ ...candidate.files[0], path: '../escape.ts' }],
      } as ArtifactCandidate;
      const repository = new SideEffectJournalRepository(new NodeFileEventStoreAdapter(root), root);
      const fileOps = createNodeArtifactDeliveryFileOps();

      await expect(deliverArtifactCandidate({
        candidate: malformedCandidate,
        approval: approval(candidate, destination),
        acceptance: acceptanceFor(candidate.sourceWorktreePath),
        repository,
        fileOps,
        now: '2026-09-04T20:06:00.000Z',
      })).rejects.toThrow(/路径|candidate|补丁/);
      await expect(repository.read()).resolves.toMatchObject({ status: 'empty' });
    });
  });
});
