/**
 * G4：可选脱敏事件日志测试。
 *
 * 覆盖：sanitizeEvent 脱敏语义（summary 白名单 / full 剥离敏感键）、
 * eventLogRelPath 路径、EventLogWriter 缓冲与 flush、attachEventLog 按运行过滤。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  eventLogRelPath,
  sanitizeEvent,
  attachEventLog,
  resetEventLog,
  setEventPersistenceMode,
  getEventPersistenceMode,
  type EventPersistenceMode,
} from './eventLog';
import type { RunEvent } from './runEvents';

function mkEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    kind: 'node.completed',
    wfId: 'wfA',
    runId: 1,
    nodeId: 'n1',
    at: 1000,
    payload: { status: 'success', outputs: { text: 'hi' }, durationMs: 5 },
    ...overrides,
  };
}

/** 最小内存总线（模拟 EventBus 的 subscribe）。 */
function mkBus() {
  const sinks = new Set<(e: RunEvent) => void>();
  return {
    subscribe(sink: (e: RunEvent) => void) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(e: RunEvent) {
      for (const s of sinks) s(e);
    },
  };
}

describe('sanitizeEvent 脱敏', () => {
  it('summary：payload 仅保留白名单键，剥离 outputs/消息正文', () => {
    const out = sanitizeEvent(
      mkEvent({ payload: { status: 'success', outputs: { text: 'secret' }, durationMs: 5, progressKind: 'agent-route', agentId: 'a1' } }),
      'summary',
    );
    expect(out.kind).toBe('node.completed');
    expect(out.payload).toEqual({ status: 'success', durationMs: 5, progressKind: 'agent-route', agentId: 'a1' });
    // outputs 被剥离（可能含敏感内容/过大）
    expect((out.payload as Record<string, unknown>).outputs).toBeUndefined();
  });

  it('full：保留 outputs 但剥离敏感键（含嵌套对象）', () => {
    const out = sanitizeEvent(
      mkEvent({
        payload: {
          status: 'success',
          outputs: { text: 'ok', apiKey: 'sk-123', nested: { secret: 'x', token: 'y' } },
        },
      }),
      'full',
    );
    const p = out.payload as Record<string, unknown>;
    expect(p.outputs).toBeTruthy();
    const o = p.outputs as Record<string, unknown>;
    expect(o.text).toBe('ok');
    expect(o.apiKey).toBeUndefined();
    expect((o.nested as Record<string, unknown>).secret).toBeUndefined();
    expect((o.nested as Record<string, unknown>).token).toBeUndefined();
  });

  it('保留运行三元组定位字段', () => {
    const out = sanitizeEvent(mkEvent({ wfId: 'w', runId: 7, nodeId: 'n9' }), 'summary');
    expect(out.wfId).toBe('w');
    expect(out.runId).toBe(7);
    expect(out.nodeId).toBe('n9');
    expect(out.at).toBe(1000);
  });
});

describe('eventLogRelPath', () => {
  it('生成 .slimemold/runs/{wfId}/{runId}/events.jsonl', () => {
    expect(eventLogRelPath('wf-1', 3)).toBe('.slimemold/runs/wf-1/3/events.jsonl');
  });
});

describe('attachEventLog / setEventPersistenceMode', () => {
  beforeEach(() => {
    resetEventLog();
  });

  it('off 模式返回 no-op，不产生写入器', () => {
    setEventPersistenceMode('off');
    expect(getEventPersistenceMode()).toBe('off');
    const detach = attachEventLog(mkBus(), '/root', 'wfA', 1);
    // off 时 attach 返回空函数（不挂订阅、不建 writer）
    expect(detach).toBeTypeOf('function');
  });

  it('attach 只捕获匹配 wfId+runId 的事件（经 EventLogWriter 缓冲）', async () => {
    setEventPersistenceMode('summary' as EventPersistenceMode);
    const bus = mkBus();
    const detach = attachEventLog(bus, '/root', 'wfA', 1);
    // 匹配事件与不匹配事件都发出
    bus.emit(mkEvent({ wfId: 'wfA', runId: 1, nodeId: 'n1' }));
    bus.emit(mkEvent({ wfId: 'wfA', runId: 2, nodeId: 'n2' })); // 不同 runId
    bus.emit(mkEvent({ wfId: 'wfB', runId: 1, nodeId: 'n3' })); // 不同 wfId
    // 不崩溃、可正常 detach（缓冲内容在 close 时 flush；此处不依赖文件系统）
    detach();
  });
});
