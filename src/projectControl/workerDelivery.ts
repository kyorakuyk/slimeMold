import { dirname } from 'node:path';
import { hashContent } from '../dev/capabilities';
import type { FilePatchSet } from '../domain/model/artifact';
import { assertSafeProjectRelativePath, decodeFilePatchSet } from '../domain/model/artifact';
import type { FilePatchSetApplyResult } from '../dev/patch-set';
import type { AcceptanceRecord } from '../dev/session';
import { assertTaskExecutionLineage } from '../domain/execution';
import {
  completeSideEffect,
  createSideEffect,
  markSideEffectUnknown,
  startSideEffect,
  type SideEffectRecord,
} from '../domain/contracts';
import { SideEffectJournalRepository } from '../domain/sideEffects';
import { normalizeAbsolutePath, pathComparisonKey } from '../dev/path-utils';

export const ARTIFACT_DELIVERY_SCHEMA_VERSION = 1 as const;

export interface ArtifactCandidateFile {
  path: string;
  sourceHash: string;
  /** First MVP only permits a destination file that must not exist. */
  destinationBeforeHash: null;
}

export interface ArtifactCandidate {
  schemaVersion: typeof ARTIFACT_DELIVERY_SCHEMA_VERSION;
  candidateId: string;
  acceptanceId: string;
  orchestrationId: string;
  stageId: string;
  runId: string;
  taskId: string;
  taskExecutionId: string;
  attemptId: string;
  sourceWorktreePath: string;
  files: ArtifactCandidateFile[];
  createdAt: string;
}

export interface ArtifactDeliveryApproval {
  approvalId: string;
  candidateId: string;
  destinationRoot: string;
  approvedBy: 'user';
  approvedAt: string;
}

export interface ArtifactDeliveryReceiptFile {
  path: string;
  contentHash: string;
}

export interface ArtifactDeliveryReceipt {
  schemaVersion: typeof ARTIFACT_DELIVERY_SCHEMA_VERSION;
  receiptId: string;
  candidateId: string;
  approvalId: string;
  acceptanceId: string;
  orchestrationId: string;
  stageId: string;
  runId: string;
  taskId: string;
  taskExecutionId: string;
  attemptId: string;
  sourceWorktreePath: string;
  destinationRoot: string;
  files: ArtifactDeliveryReceiptFile[];
  outputHash: string;
  outcome: 'succeeded';
  observedAt: string;
}

export interface DeliveryFileOps {
  readText(path: string): Promise<string>;
  writeNew(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

export interface ArtifactDeliveryInput {
  candidate: ArtifactCandidate;
  approval: ArtifactDeliveryApproval;
  /** Host lookup of the durable Acceptance referenced by the candidate. */
  acceptance: CandidateAcceptance;
  repository: SideEffectJournalRepository;
  fileOps: DeliveryFileOps;
  now: string;
  signal?: AbortSignal;
}

export interface ArtifactDeliveryResult {
  receipt: ArtifactDeliveryReceipt;
  sideEffect: SideEffectRecord;
}

export type CandidateAcceptance = Pick<
  AcceptanceRecord,
  | 'acceptanceId'
  | 'orchestrationId'
  | 'stageId'
  | 'worktreePath'
  | 'passed'
  | 'failedChecks'
  | 'at'
  | 'runId'
  | 'taskId'
  | 'taskExecutionId'
  | 'attemptId'
>;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAbsoluteRoot(value: string, field: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value)) {
    throw new Error(`${field} 必须是绝对路径`);
  }
}

function assertWithinRoot(root: string, candidate: string, field: string): void {
  const rootKey = pathComparisonKey(root);
  const candidateKey = pathComparisonKey(candidate);
  if (candidateKey !== rootKey && !candidateKey.startsWith(`${rootKey}/`)) {
    throw new Error(`${field} 不在声明根目录内：${candidate}`);
  }
}

function safePath(root: string, relative: string): string {
  assertSafeProjectRelativePath(relative);
  const rootAbs = normalizeAbsolutePath(root);
  const candidate = normalizeAbsolutePath(`${rootAbs}/${relative}`);
  assertWithinRoot(rootAbs, candidate, '交付路径');
  return candidate;
}

function deliveryOutputHash(files: readonly ArtifactDeliveryReceiptFile[]): string {
  return hashContent(files.map((file) => `${file.path}\u0000${file.contentHash}`).join('\n'));
}

export function isArtifactDeliveryReceiptShape(
  record: SideEffectRecord,
  expected: {
    candidateId: string;
    acceptanceId: string;
    destinationRoot?: string;
  },
): boolean {
  if (
    record.kind !== 'artifact-delivery'
    || record.idempotencyKey !== `artifact-delivery:${expected.candidateId}`
    || record.status !== 'receipt'
    || record.recovery !== 'skip'
    || !record.target.trim()
    || !record.inputHash.trim()
    || (expected.destinationRoot !== undefined
      && pathComparisonKey(record.target) !== pathComparisonKey(expected.destinationRoot))
  ) return false;
  const receipt = record.receipt;
  if (
    !receipt
    || receipt.receiptId !== `${record.idempotencyKey}:receipt`
    || receipt.outcome !== 'succeeded'
    || receipt.acceptanceId !== expected.acceptanceId
    || receipt.artifactCandidateId !== expected.candidateId
    || typeof receipt.approvalId !== 'string'
    || !receipt.approvalId.trim()
    || typeof receipt.outputHash !== 'string'
    || !receipt.outputHash.trim()
    || !Array.isArray(receipt.files)
    || receipt.files.length === 0
  ) return false;
  const seen = new Set<string>();
  const files: ArtifactDeliveryReceiptFile[] = [];
  try {
    for (const file of receipt.files) {
      if (
        !file
        || typeof file.path !== 'string'
        || typeof file.contentHash !== 'string'
        || !file.contentHash.trim()
      ) return false;
      assertSafeProjectRelativePath(file.path);
      const key = file.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      files.push({ path: file.path, contentHash: file.contentHash });
    }
  } catch {
    return false;
  }
  return receipt.outputHash === deliveryOutputHash(files);
}

function deliveryEffectKey(candidateId: string): string {
  return `artifact-delivery:${candidateId}`;
}

function deliveryInputHash(candidate: ArtifactCandidate, approval: ArtifactDeliveryApproval): string {
  return hashContent(JSON.stringify({
    candidateId: candidate.candidateId,
    approvalId: approval.approvalId,
    destinationRoot: pathComparisonKey(approval.destinationRoot),
    files: candidate.files,
  }));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Artifact delivery 已取消');
  error.name = 'AbortError';
  throw error;
}

function assertCandidateAcceptance(acceptance: CandidateAcceptance, sourceWorktreePath: string): void {
  if (!acceptance.passed || acceptance.failedChecks.length > 0) {
    throw new Error('ArtifactCandidate 只能来自 passed 且无 failedChecks 的 Acceptance');
  }
  if (pathComparisonKey(acceptance.worktreePath) !== pathComparisonKey(sourceWorktreePath)) {
    throw new Error('ArtifactCandidate 的 Acceptance worktree 不匹配');
  }
  if (!acceptance.runId || !acceptance.taskId || !acceptance.taskExecutionId || !acceptance.attemptId) {
    throw new Error('ArtifactCandidate 缺少完整 execution lineage');
  }
}

function assertArtifactCandidate(value: unknown): asserts value is ArtifactCandidate {
  if (!isRecord(value) || value.schemaVersion !== ARTIFACT_DELIVERY_SCHEMA_VERSION) {
    throw new Error('ArtifactCandidate schema 无效');
  }
  const fields = [
    'candidateId',
    'acceptanceId',
    'orchestrationId',
    'stageId',
    'runId',
    'taskId',
    'taskExecutionId',
    'attemptId',
    'sourceWorktreePath',
    'createdAt',
  ] as const;
  for (const field of fields) requiredText(value[field], `ArtifactCandidate.${field}`);
  const sourceWorktreePath = requiredText(value.sourceWorktreePath, 'ArtifactCandidate.sourceWorktreePath');
  assertAbsoluteRoot(sourceWorktreePath, 'sourceWorktreePath');
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('ArtifactCandidate.files 不能为空');
  }
  const seen = new Set<string>();
  for (const [index, rawFile] of value.files.entries()) {
    if (!isRecord(rawFile)) throw new Error(`ArtifactCandidate.files[${index}] 无效`);
    const path = requiredText(rawFile.path, `ArtifactCandidate.files[${index}].path`);
    assertSafeProjectRelativePath(path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`ArtifactCandidate 存在重复路径：${path}`);
    seen.add(key);
    requiredText(rawFile.sourceHash, `ArtifactCandidate.files[${index}].sourceHash`);
    if (rawFile.destinationBeforeHash !== null) {
      throw new Error(`ArtifactCandidate.files[${index}].destinationBeforeHash 无效`);
    }
  }
  try {
    assertTaskExecutionLineage({
      runId: value.runId as string,
      taskId: value.taskId as string,
      taskExecutionId: value.taskExecutionId as string,
      attemptId: value.attemptId as string,
    });
  } catch {
    throw new Error('ArtifactCandidate execution lineage 无效');
  }
}

function assertArtifactDeliveryApproval(
  value: unknown,
  candidate: ArtifactCandidate,
): asserts value is ArtifactDeliveryApproval {
  if (!isRecord(value)) throw new Error('Artifact delivery approval 无效');
  requiredText(value.approvalId, 'ArtifactDeliveryApproval.approvalId');
  const destinationRoot = requiredText(value.destinationRoot, 'ArtifactDeliveryApproval.destinationRoot');
  requiredText(value.approvedAt, 'ArtifactDeliveryApproval.approvedAt');
  assertAbsoluteRoot(destinationRoot, 'destinationRoot');
  if (value.approvedBy !== 'user') throw new Error('Artifact delivery 必须由 user approval 触发');
  if (value.candidateId !== candidate.candidateId) {
    throw new Error('Artifact delivery approval 与 candidate 不匹配');
  }
}

function assertAcceptanceMatchesCandidate(
  acceptance: CandidateAcceptance,
  candidate: ArtifactCandidate,
): void {
  assertCandidateAcceptance(acceptance, candidate.sourceWorktreePath);
  if (
    acceptance.acceptanceId !== candidate.acceptanceId
    || acceptance.orchestrationId !== candidate.orchestrationId
    || acceptance.stageId !== candidate.stageId
    || acceptance.runId !== candidate.runId
    || acceptance.taskId !== candidate.taskId
    || acceptance.taskExecutionId !== candidate.taskExecutionId
    || acceptance.attemptId !== candidate.attemptId
  ) {
    throw new Error('ArtifactCandidate 与宿主 Acceptance lineage 不一致');
  }
}

export function buildArtifactCandidate(input: {
  candidateId: string;
  acceptance: CandidateAcceptance;
  sourceWorktreePath: string;
  patchSet: unknown;
  applyResult: FilePatchSetApplyResult;
  createdAt: string;
}): ArtifactCandidate {
  const candidateId = requiredText(input.candidateId, 'candidateId');
  const sourceWorktreePath = requiredText(input.sourceWorktreePath, 'sourceWorktreePath');
  const createdAt = requiredText(input.createdAt, 'createdAt');
  assertAbsoluteRoot(sourceWorktreePath, 'sourceWorktreePath');
  const acceptance = input.acceptance;
  assertCandidateAcceptance(acceptance, sourceWorktreePath);
  const patchSet: FilePatchSet = decodeFilePatchSet(input.patchSet);
  const applyResult = input.applyResult;
  const expectedPaths = patchSet.patches.map((patch) => patch.path);
  if (
    applyResult.appliedPaths.length !== expectedPaths.length
    || expectedPaths.some((path, index) => applyResult.appliedPaths[index] !== path)
  ) {
    throw new Error('ArtifactCandidate 只能引用完整且有序的已应用 PatchSet');
  }
  const files = patchSet.patches.map((patch) => {
    if (patch.before !== null) throw new Error(`第一版交付拒绝覆盖已有源文件：${patch.path}`);
    const sourceHash = requiredText(applyResult.contentHashes[patch.path], `contentHashes.${patch.path}`);
    return { path: patch.path, sourceHash, destinationBeforeHash: null };
  });
  return {
    schemaVersion: ARTIFACT_DELIVERY_SCHEMA_VERSION,
    candidateId,
    acceptanceId: requiredText(acceptance.acceptanceId, 'acceptanceId'),
    orchestrationId: requiredText(acceptance.orchestrationId, 'orchestrationId'),
    stageId: requiredText(acceptance.stageId, 'stageId'),
    runId: requiredText(acceptance.runId, 'runId'),
    taskId: requiredText(acceptance.taskId, 'taskId'),
    taskExecutionId: requiredText(acceptance.taskExecutionId, 'taskExecutionId'),
    attemptId: requiredText(acceptance.attemptId, 'attemptId'),
    sourceWorktreePath,
    files,
    createdAt,
  };
}

export function createArtifactDeliveryApproval(
  candidate: ArtifactCandidate,
  input: {
    approvalId: string;
    destinationRoot: string;
    approvedBy: 'user';
    approvedAt: string;
  },
): ArtifactDeliveryApproval {
  assertArtifactCandidate(candidate);
  const approvalId = requiredText(input.approvalId, 'approvalId');
  const destinationRoot = requiredText(input.destinationRoot, 'destinationRoot');
  const approvedAt = requiredText(input.approvedAt, 'approvedAt');
  assertAbsoluteRoot(destinationRoot, 'destinationRoot');
  if (input.approvedBy !== 'user') throw new Error('Artifact delivery 必须由 user approval 触发');
  return {
    approvalId,
    candidateId: candidate.candidateId,
    destinationRoot,
    approvedBy: 'user',
    approvedAt,
  };
}

export function createNodeArtifactDeliveryFileOps(): DeliveryFileOps {
  return {
    readText: async (path) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    },
    writeNew: async (path, content) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    },
    exists: async (path) => {
      const { access } = await import('node:fs/promises');
      try {
        await access(path);
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    },
    realpath: async (path) => {
      const { realpath } = await import('node:fs/promises');
      return realpath(path);
    },
  };
}

async function copyAndVerify(
  candidate: ArtifactCandidate,
  approval: ArtifactDeliveryApproval,
  fileOps: DeliveryFileOps,
  signal: AbortSignal | undefined,
): Promise<ArtifactDeliveryReceiptFile[]> {
  const sourceRoot = await fileOps.realpath(candidate.sourceWorktreePath);
  const destinationRoot = await fileOps.realpath(approval.destinationRoot);
  assertWithinRoot(candidate.sourceWorktreePath, sourceRoot, 'sourceWorktreePath');
  assertWithinRoot(approval.destinationRoot, destinationRoot, 'destinationRoot');
  const files: ArtifactDeliveryReceiptFile[] = [];
  for (const candidateFile of candidate.files) {
    throwIfAborted(signal);
    const sourcePath = safePath(sourceRoot, candidateFile.path);
    const sourceReal = await fileOps.realpath(sourcePath);
    assertWithinRoot(sourceRoot, sourceReal, '源文件');
    const content = await fileOps.readText(sourceReal);
    const sourceHash = hashContent(content);
    if (sourceHash !== candidateFile.sourceHash) {
      throw new Error(`源文件 hash 不匹配：${candidateFile.path}`);
    }

    const destinationPath = safePath(destinationRoot, candidateFile.path);
    if (candidateFile.destinationBeforeHash !== null) {
      throw new Error(`交付目标 preimage 类型暂不支持：${candidateFile.path}`);
    }
    if (await fileOps.exists(destinationPath)) {
      throw new Error(`交付目标文件已存在，拒绝覆盖：${candidateFile.path}`);
    }
    const destinationParent = dirname(destinationPath);
    if (!(await fileOps.exists(destinationParent))) {
      throw new Error(`交付目标父目录不存在，拒绝隐式创建：${destinationParent}`);
    }
    const parentReal = await fileOps.realpath(destinationParent);
    assertWithinRoot(destinationRoot, parentReal, '交付目标父目录');
    throwIfAborted(signal);
    await fileOps.writeNew(destinationPath, content);
    const destinationReal = await fileOps.realpath(destinationPath);
    assertWithinRoot(destinationRoot, destinationReal, '交付目标文件');
    const readBack = await fileOps.readText(destinationReal);
    const contentHash = hashContent(readBack);
    if (readBack !== content || contentHash !== sourceHash) {
      throw new Error(`交付文件 read-back 校验失败：${candidateFile.path}`);
    }
    files.push({ path: candidateFile.path, contentHash });
  }
  return files;
}

function receiptFromRecord(
  record: SideEffectRecord,
  candidate: ArtifactCandidate,
  approval: ArtifactDeliveryApproval,
): ArtifactDeliveryReceipt {
  const stored = record.receipt;
  if (!isArtifactDeliveryReceiptShape(record, {
    candidateId: candidate.candidateId,
    acceptanceId: candidate.acceptanceId,
    destinationRoot: approval.destinationRoot,
  })) {
    throw new Error('DeliveryReceipt 结构或 lineage 无效');
  }
  assertDeliveryRecordIdentity(record, candidate, approval);
  if (
    !stored
    || stored.outcome !== 'succeeded'
    || stored.receiptId !== `${deliveryEffectKey(candidate.candidateId)}:receipt`
    || stored.artifactCandidateId !== candidate.candidateId
    || stored.approvalId !== approval.approvalId
    || stored.acceptanceId !== candidate.acceptanceId
    || !stored.outputHash
    || !stored.files
    || stored.files.length !== candidate.files.length
    || stored.files.some((file, index) => {
      const expected = candidate.files[index];
      return !expected || file.path !== expected.path || file.contentHash !== expected.sourceHash;
    })
    || stored.outputHash !== deliveryOutputHash(stored.files)
  ) {
    throw new Error('已有 DeliveryReceipt 与当前 candidate/approval 不一致');
  }
  return {
    schemaVersion: ARTIFACT_DELIVERY_SCHEMA_VERSION,
    receiptId: stored.receiptId,
    candidateId: candidate.candidateId,
    approvalId: approval.approvalId,
    acceptanceId: candidate.acceptanceId,
    orchestrationId: candidate.orchestrationId,
    stageId: candidate.stageId,
    runId: candidate.runId,
    taskId: candidate.taskId,
    taskExecutionId: candidate.taskExecutionId,
    attemptId: candidate.attemptId,
    sourceWorktreePath: candidate.sourceWorktreePath,
    destinationRoot: approval.destinationRoot,
    files: stored.files,
    outputHash: stored.outputHash,
    outcome: 'succeeded',
    observedAt: stored.observedAt,
  };
}

function assertDeliveryRecordIdentity(
  record: SideEffectRecord,
  candidate: ArtifactCandidate,
  approval: ArtifactDeliveryApproval,
): void {
  if (
    record.idempotencyKey !== deliveryEffectKey(candidate.candidateId)
    || record.kind !== 'artifact-delivery'
    || pathComparisonKey(record.target) !== pathComparisonKey(approval.destinationRoot)
    || record.inputHash !== deliveryInputHash(candidate, approval)
    || record.runId !== candidate.runId
    || record.taskId !== candidate.taskId
    || record.taskExecutionId !== candidate.taskExecutionId
    || record.attemptId !== candidate.attemptId
  ) {
    throw new Error('已有 Artifact delivery record 与当前 candidate/approval lineage 不一致');
  }
}

export async function deliverArtifactCandidate(input: ArtifactDeliveryInput): Promise<ArtifactDeliveryResult> {
  assertArtifactCandidate(input.candidate);
  const candidate = input.candidate;
  assertArtifactDeliveryApproval(input.approval, candidate);
  const approval = input.approval;
  assertAcceptanceMatchesCandidate(input.acceptance, candidate);
  const now = requiredText(input.now, 'now');
  const key = deliveryEffectKey(candidate.candidateId);
  const inputHash = deliveryInputHash(candidate, approval);
  throwIfAborted(input.signal);
  const parsed = await input.repository.read();
  if (parsed.status === 'needs-repair') throw new Error(`副作用账本需要修复：${parsed.reason ?? '未知'}`);
  const existing = parsed.journal.entries.find((entry) => entry.idempotencyKey === key);
  if (existing) assertDeliveryRecordIdentity(existing, candidate, approval);
  if (existing?.status === 'receipt') {
    return { receipt: receiptFromRecord(existing, candidate, approval), sideEffect: existing };
  }
  if (existing?.status === 'started' || existing?.status === 'unknown') {
    throw new Error(`Artifact delivery 需要人工核对：${key}`);
  }

  const planned = createSideEffect({
    idempotencyKey: key,
    kind: 'artifact-delivery',
    target: approval.destinationRoot,
    inputHash,
    runId: candidate.runId,
    taskId: candidate.taskId,
    taskExecutionId: candidate.taskExecutionId,
    attemptId: candidate.attemptId,
  });
  const claim = await input.repository.claim(startSideEffect(planned));
  if (!claim.claimed) {
    if (claim.record.status === 'receipt') {
      return { receipt: receiptFromRecord(claim.record, candidate, approval), sideEffect: claim.record };
    }
    throw new Error(`Artifact delivery 已被其它执行者占用或需要人工核对：${key}`);
  }

  try {
    const files = await copyAndVerify(candidate, approval, input.fileOps, input.signal);
    const outputHash = deliveryOutputHash(files);
    const receipt = completeSideEffect(claim.record, {
      receiptId: `${key}:receipt`,
      observedAt: now,
      outputHash,
      outcome: 'succeeded',
      acceptanceId: candidate.acceptanceId,
      artifactCandidateId: candidate.candidateId,
      approvalId: approval.approvalId,
      files,
    });
    const journal = await input.repository.record(receipt);
    const stored = journal.entries.find((entry) => entry.idempotencyKey === key);
    if (!stored || stored.status !== 'receipt') throw new Error('DeliveryReceipt 写入后无法读回');
    return { receipt: receiptFromRecord(stored, candidate, approval), sideEffect: stored };
  } catch (cause) {
    try {
      await input.repository.record(markSideEffectUnknown(
        claim.record,
        cause instanceof Error ? cause.message : String(cause),
      ));
    } catch {
      // Preserve the original error; an unreadable side-effect journal remains fail-closed.
    }
    throw cause;
  }
}
