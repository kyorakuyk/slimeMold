import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { graphGrowthProjection } from '../src/projectControl/graphGrowthProjection';
import { layoutGraphGrowth } from '../src/projectControl/graphGrowthLayout';
import { parseGraphGrowthEventText } from '../src/projectControl/graphGrowthEventSource';
import { eventStream, graph, GRAPH_ID, task } from '../src/projectControl/graphGrowthProjectionTestUtils';

const TASK_COUNT = 800;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 5;
const BASE_TIME = Date.UTC(2026, 0, 1);

function buildSyntheticEventLog(): string {
  const tasks = Array.from({ length: TASK_COUNT }, (_, index) => {
    const taskId = `perf-task-${String(index).padStart(4, '0')}`;
    const moduleId = `perf-module-${String(Math.floor(index / 20)).padStart(2, '0')}`;
    const dependsOn = index === 0 ? [] : [`perf-task-${String(index - 1).padStart(4, '0')}`];
    return task(taskId, moduleId, dependsOn);
  });
  const stream = eventStream();
  stream.addGraph(graph(GRAPH_ID, tasks));

  for (let index = 0; index < TASK_COUNT; index += 1) {
    const taskId = tasks[index]!.id;
    const oldRun = `perf-run-old-${index}`;
    const currentRun = `perf-run-current-${index}`;
    stream.addQueued(taskId, undefined, oldRun);
    stream.addStarted(taskId, 1, oldRun);
    stream.addFailed(taskId, 1, oldRun);
    stream.addQueued(taskId, undefined, currentRun);
    stream.addStarted(taskId, 1, currentRun);
    stream.addSucceeded(taskId, 1, currentRun);
  }

  return stream.events
    .map((event, index) => JSON.stringify({
      ...event,
      occurredAt: new Date(BASE_TIME + (index + 1) * 1_000).toISOString(),
    }))
    .join('\n');
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const jsonl = `${buildSyntheticEventLog()}\n`;
const parsed = parseGraphGrowthEventText(jsonl);
if (parsed.status !== 'ok' || parsed.events.length < 4_500 || parsed.corruptLineCount !== 0) {
  throw new Error(`synthetic event fixture invalid: status=${parsed.status}, events=${parsed.events.length}, corrupt=${parsed.corruptLineCount}`);
}

const outputDirectory = join(process.cwd(), '.hermes', 'reports', 'assets', 'r9', 'a1-perf-smoke');
mkdirSync(outputDirectory, { recursive: true });
const eventPath = join(outputDirectory, 'synthetic-events.jsonl');
writeFileSync(eventPath, jsonl, 'utf8');
const sha256 = createHash('sha256').update(jsonl).digest('hex');

const projectionTimes: number[] = [];
const layoutTimes: number[] = [];
const latestSequence = parsed.events.at(-1)!.sequence;
// This untimed pass plus the loop warmups are all warmup runs.
let projection = graphGrowthProjection(parsed.events, latestSequence);
let positions = layoutGraphGrowth(projection.nodes);
for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run += 1) {
  let started = performance.now();
  projection = graphGrowthProjection(parsed.events, latestSequence);
  const projectionMs = performance.now() - started;

  started = performance.now();
  positions = layoutGraphGrowth(projection.nodes);
  const layoutMs = performance.now() - started;

  if (run >= WARMUP_RUNS) {
    projectionTimes.push(projectionMs);
    layoutTimes.push(layoutMs);
  }
}

const taskNodeCount = projection.nodes.filter((node) => node.kind === 'task').length;
if (taskNodeCount !== TASK_COUNT || positions.size !== projection.nodes.length) {
  throw new Error(`benchmark projection mismatch: tasks=${taskNodeCount}, positions=${positions.size}, nodes=${projection.nodes.length}`);
}

console.log(JSON.stringify({
  fixture: {
    eventCount: parsed.events.length,
    taskCount: taskNodeCount,
    moduleCount: projection.nodes.filter((node) => node.kind === 'module').length,
    nodeCount: projection.nodes.length,
    edgeCount: projection.edges.length,
    eventBytes: Buffer.byteLength(jsonl),
    eventFile: eventPath,
    eventSha256: sha256,
  },
  benchmark: {
    warmupRuns: WARMUP_RUNS + 1,
    measuredRuns: MEASURED_RUNS,
    projectionMs: { samples: projectionTimes, median: median(projectionTimes), max: Math.max(...projectionTimes) },
    layoutMs: { samples: layoutTimes, median: median(layoutTimes), max: Math.max(...layoutTimes) },
    exceedsOneSecond: {
      projection: Math.max(...projectionTimes) > 1_000,
      layout: Math.max(...layoutTimes) > 1_000,
    },
  },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
}, null, 2));
