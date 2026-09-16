import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const sessionDir = process.env.SLIMEMOLD_ANTIGRAVITY_SESSION_DIR;
if (!sessionDir || path.isAbsolute(sessionDir) === false) {
  throw new Error('SLIMEMOLD_ANTIGRAVITY_SESSION_DIR must be an absolute path');
}
fs.mkdirSync(sessionDir, { recursive: true });

const contextPath = path.join(sessionDir, 'context.json');
const progressPath = path.join(sessionDir, 'progress.jsonl');
const feedbackPath = path.join(sessionDir, 'feedback.json');
const resultPath = path.join(sessionDir, 'result.json');

function now() {
  return new Date().toISOString();
}

function writeAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function appendEvent(event) {
  fs.appendFileSync(progressPath, `${JSON.stringify({ ...event, at: now() })}\n`, 'utf8');
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function toolResult(text, structuredContent = {}) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

const tools = [
  {
    name: 'slimemold_get_task_context',
    description: 'Read the bounded SlimeMold ContextPack for the current Worker Attempt. This is read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'slimemold_report_progress',
    description: 'Report a structured progress capsule. It does not mark the Task successful.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        status: { type: 'string', enum: ['started', 'progress', 'blocked', 'ready-for-acceptance'] },
      },
      required: ['message', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'slimemold_request_feedback',
    description: 'Record an ambiguity or blocker for the SlimeMold Recovery/Feedback path.',
    inputSchema: {
      type: 'object',
      properties: {
        ambiguity: { type: 'string' },
        affectedScope: { type: 'array', items: { type: 'string' } },
        options: { type: 'array', items: { type: 'string' } },
        recommendation: { type: 'string' },
      },
      required: ['ambiguity', 'affectedScope', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'slimemold_submit_attempt_result',
    description: 'Report that the interactive Antigravity Attempt is ready for Host Acceptance. This never marks TaskSucceeded by itself.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'blocked'] },
        summary: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
      },
      required: ['outcome', 'summary', 'changedFiles'],
      additionalProperties: false,
    },
  },
];

async function handle(request) {
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    result(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'slimemold-antigravity-worker', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    result(request.id, { tools });
    return;
  }
  if (request.method !== 'tools/call') {
    error(request.id, -32601, `Unsupported MCP method: ${request.method}`);
    return;
  }

  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  try {
    if (name === 'slimemold_get_task_context') {
      const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      result(request.id, toolResult(JSON.stringify(context, null, 2), context));
      return;
    }
    if (name === 'slimemold_report_progress') {
      appendEvent({ type: 'progress', status: args.status, message: args.message });
      result(request.id, toolResult('Progress recorded; Task status remains controlled by Host Acceptance.', { recorded: true }));
      return;
    }
    if (name === 'slimemold_request_feedback') {
      const feedback = { type: 'feedback', ...args, at: now() };
      writeAtomic(feedbackPath, feedback);
      appendEvent(feedback);
      result(request.id, toolResult('Feedback recorded; SlimeMold will keep the Attempt fail-closed.', { recorded: true }));
      return;
    }
    if (name === 'slimemold_submit_attempt_result') {
      const submission = { type: 'attempt-result', ...args, at: now() };
      writeAtomic(resultPath, submission);
      appendEvent(submission);
      result(request.id, toolResult('Attempt result recorded; Host Acceptance must still run.', { recorded: true }));
      return;
    }
    error(request.id, -32602, `Unknown tool: ${name}`);
  } catch (cause) {
    error(request.id, -32000, cause instanceof Error ? cause.message : String(cause));
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  void handle(request);
});
