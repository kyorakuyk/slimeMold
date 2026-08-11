/**
 * draft.test.ts — H3 Orchestrator H3a 纯函数地基单测。
 *
 * 覆盖：
 * - generateDraft：纯函数，不写 store（调用前后 store.orchestrations 不变）；
 *   按模板产出 plan → construction → acceptance 三阶段 + 2 边；
 *   AgentRouter 决策绑定 agentId。
 * - confirmDraft：approval ≠ 'approved' 抛错；正常确认后状态 running；
 *   非法状态（非 awaiting-confirm）拒绝。
 * - discardDraft：删除编排记录，不触碰其它状态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDraft } from './draft';
import {
  canTransition,
  cancelOrchestration,
  confirmDraft,
  createOrchestration,
  discardDraft,
  getOrchestration,
  updateOrchestration,
} from './confirm';
import { useWorkflowStore } from '../store/workflowStore';
import type { AgentConfig } from '../types';

const agent: AgentConfig = {
  id: 'agent-1',
  name: 'Agent One',
  protocol: 'ollama',
  model: 'llama3',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
} as unknown as AgentConfig;

function deps() {
  return {
    agents: [agent],
    defaultAgentId: 'agent-1',
  };
}

function seedStore() {
  useWorkflowStore.setState({ orchestrations: [] } as never);
}

beforeEach(() => {
  seedStore();
  vi.restoreAllMocks();
});

describe('generateDraft 草案生成（纯函数零副作用）', () => {
  it('按模板产出三阶段 + 2 边，每阶段绑定 agent', () => {
    const draft = generateDraft(
      { goal: '给 CLI 工具加子命令并补测试', source: 'ui', constraints: { agentId: 'agent-1' } },
      deps(),
    );
    expect(draft.stages).toHaveLength(3);
    expect(draft.stages.map((s) => s.id)).toEqual(['plan', 'construction', 'acceptance']);
    expect(draft.stages.every((s) => s.agentId === 'agent-1')).toBe(true);
    expect(draft.edges).toHaveLength(2);
    expect(draft.edges[0]).toMatchObject({ from: 'plan', to: 'construction' });
    expect(draft.edges[1]).toMatchObject({ from: 'construction', to: 'acceptance' });
  });

  it('generateDraft 不写 store（orchestrations 保持为空）', () => {
    generateDraft(
      { goal: 'x', source: 'menu', constraints: { maxStages: 2 } },
      deps(),
    );
    expect(useWorkflowStore.getState().orchestrations).toHaveLength(0);
  });

  it('maxStages 限制阶段数', () => {
    const draft = generateDraft(
      { goal: 'x', source: 'ui', constraints: { maxStages: 1 } },
      deps(),
    );
    expect(draft.stages).toHaveLength(1);
    expect(draft.stages[0].id).toBe('plan');
  });

  it('校验：goal 为空抛错', () => {
    expect(() => generateDraft({ goal: '   ', source: 'ui' }, deps())).toThrow(/目标不能为空/);
  });

  it('校验：goal 超 2000 字符抛错', () => {
    expect(() => generateDraft({ goal: 'x'.repeat(2001), source: 'ui' }, deps())).toThrow(/目标过长/);
  });

  it('校验：maxStages 超上限抛错', () => {
    expect(() =>
      generateDraft({ goal: 'x', source: 'ui', constraints: { maxStages: 8 } }, deps()),
    ).toThrow(/maxStages.*上限/);
    expect(() =>
      generateDraft({ goal: 'x', source: 'ui', constraints: { maxStages: 0 } }, deps()),
    ).toThrow(/maxStages.*正整数/);
  });

  it('校验：budgetTokens 负数抛错', () => {
    expect(() =>
      generateDraft({ goal: 'x', source: 'ui', constraints: { budgetTokens: -1 } }, deps()),
    ).toThrow(/budgetTokens/);
  });
});

describe('confirm 确认门', () => {
  it('createOrchestration → 状态 awaiting-confirm，记录已落 store', () => {
    const draft = generateDraft({ goal: 'g', source: 'ui' }, deps());
    const orch = createOrchestration('g', draft);
    expect(orch.status).toBe('awaiting-confirm');
    expect(useWorkflowStore.getState().orchestrations).toHaveLength(1);
    expect(getOrchestration(orch.id)?.draft?.stages).toHaveLength(3);
  });

  it('confirmDraft：approval 非 approved 抛错', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    expect(() => confirmDraft(orch.id, 'approved' as never)).not.toThrow();
    // 非法 approval 需经类型断言验证（运行时）
    expect(() => confirmDraft(orch.id, 'maybe' as never)).toThrow(/必须显式批准/);
  });

  it('confirmDraft：确认后状态为 ready（确认≠执行，不进入 running）', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    const next = confirmDraft(orch.id, 'approved');
    expect(next.status).toBe('ready');
    expect(getOrchestration(orch.id)?.status).toBe('ready');
  });

  it('confirmDraft：非 awaiting-confirm 状态拒绝（幂等保护）', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    confirmDraft(orch.id, 'approved');
    // 二次确认（已在 ready）应抛错
    expect(() => confirmDraft(orch.id, 'approved')).toThrow(/不允许确认/);
  });

  it('discardDraft：删除编排记录，不触碰其它', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    const other = createOrchestration('g2', generateDraft({ goal: 'g2', source: 'ui' }, deps()));
    expect(discardDraft(orch.id)).toBe(true);
    expect(getOrchestration(orch.id)).toBeUndefined();
    expect(getOrchestration(other.id)).toBeTruthy();
    expect(useWorkflowStore.getState().orchestrations).toHaveLength(1);
  });

  it('discardDraft：awaiting-confirm / ready 可废弃', () => {
    const a = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    expect(discardDraft(a.id)).toBe(true);
    const b = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    confirmDraft(b.id, 'approved');
    expect(discardDraft(b.id)).toBe(true);
    expect(useWorkflowStore.getState().orchestrations).toHaveLength(0);
  });

  it('discardDraft：running 状态拒绝（须先 cancelOrchestration）', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    confirmDraft(orch.id, 'approved');
    updateOrchestration(orch.id, { status: 'running' });
    expect(() => discardDraft(orch.id)).toThrow(/running\/paused 须先 cancelOrchestration/);
    // 记录仍在（未被误删）
    expect(getOrchestration(orch.id)?.status).toBe('running');
  });

  it('discardDraft：done/failed 拒绝（归档历史，非废弃草案）', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    confirmDraft(orch.id, 'approved');
    updateOrchestration(orch.id, { status: 'running' });
    updateOrchestration(orch.id, { status: 'done' });
    expect(() => discardDraft(orch.id)).toThrow(/应归档历史/);
    expect(getOrchestration(orch.id)?.status).toBe('done');
  });

  it('cancelOrchestration：ready → cancelled；running → cancelled（停止后落 cancelled）', () => {
    const a = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    cancelOrchestration(a.id); // awaiting-confirm → cancelled
    expect(getOrchestration(a.id)?.status).toBe('cancelled');

    const b = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    confirmDraft(b.id, 'approved');
    updateOrchestration(b.id, { status: 'running' });
    const next = cancelOrchestration(b.id);
    expect(next.status).toBe('cancelled');
    expect(getOrchestration(b.id)?.status).toBe('cancelled');
  });

  it('cancelOrchestration：done 终态拒绝取消', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    confirmDraft(orch.id, 'approved');
    updateOrchestration(orch.id, { status: 'running' });
    updateOrchestration(orch.id, { status: 'done' });
    expect(() => cancelOrchestration(orch.id)).toThrow(/不能取消/);
  });
});

describe('状态迁移表（ALLOWED_TRANSITIONS 强制）', () => {
  it('canTransition：合法迁移', () => {
    expect(canTransition('awaiting-confirm', 'ready')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('running', 'done')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('failed', 'running')).toBe(true); // 失败可重试
    expect(canTransition('paused', 'running')).toBe(true); // 暂停可恢复
  });

  it('canTransition：非法迁移被拒绝', () => {
    expect(canTransition('awaiting-confirm', 'running')).toBe(false); // 确认≠执行
    expect(canTransition('ready', 'done')).toBe(false);               // 未执行不能直接完成
    expect(canTransition('running', 'ready')).toBe(false);            // 不可回退
    expect(canTransition('done', 'running')).toBe(false);             // 终态不可再跑
  });

  it('updateOrchestration：非法状态跳转抛错', () => {
    const orch = createOrchestration('g', generateDraft({ goal: 'g', source: 'ui' }, deps()));
    // awaiting-confirm → running 被迁移表拒绝
    expect(() =>
      updateOrchestration(orch.id, { status: 'running' }),
    ).toThrow(/非法迁移/);
    // 合法：awaiting-confirm → ready
    expect(updateOrchestration(orch.id, { status: 'ready' })?.status).toBe('ready');
    // ready → running 合法（H3b runOrchestration 进入）
    expect(updateOrchestration(orch.id, { status: 'running' })?.status).toBe('running');
  });
});
