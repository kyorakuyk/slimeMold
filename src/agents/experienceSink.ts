/**
 * experienceSink.ts —— 任务轨迹采集（#9 内核侧）。
 *
 * 收集 AgentHarness 产出的三类事件（思考 / 工具调用 / 最终输出）与结果标记，
 * 形成结构化轨迹（Trajectory）。RunHistory 面板可消费此轨迹，增加 success/failure
 * 标记与轨迹回放能力（UI 接入在 #8/#9 后续步骤）。
 *
 * 设计：无 UI 依赖，纯数据收集。harness 的事件回调直接映射到 Sink 的 on* 方法。
 */

import type { HarnessEvents } from './harness';

export interface TrajectoryStep {
  t: number; // 时间戳
  kind: 'thinking' | 'tool' | 'output' | 'log';
  round?: number;
  /** thinking: 模型/轮次; tool: 工具名+参数+结果; output: 文本段; log: 级别+消息 */
  data: Record<string, unknown>;
}

export interface Trajectory {
  id: string;
  goal?: string;
  steps: TrajectoryStep[];
  /** 结果标记：success / failure / unknown（由调用方在结束时 set） */
  outcome: 'success' | 'failure' | 'unknown';
  startedAt: number;
  endedAt?: number;
}

/** 轨迹采集器：把 harness 事件适配为结构化步骤 */
export class ExperienceSink {
  trajectory: Trajectory;

  constructor(goal?: string) {
    this.trajectory = {
      id: `traj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      goal,
      steps: [],
      outcome: 'unknown',
      startedAt: Date.now(),
    };
  }

  /** 生成可直接喂给 harness 的 events 回调（onThinking/onToolCall/onOutput/onLog） */
  events(): HarnessEvents {
    return {
      onThinking: (info) =>
        this.push({ kind: 'thinking', round: info.round, data: { model: info.model } }),
      onToolCall: (info) =>
        this.push({
          kind: 'tool',
          round: info.round,
          data: { name: info.name, args: info.args, result: info.result, error: info.error },
        }),
      onOutput: (text, done) =>
        this.push({ kind: 'output', data: { text, done } }),
      onLog: (level, msg) => this.push({ kind: 'log', data: { level, msg } }),
    };
  }

  private push(step: Omit<TrajectoryStep, 't'>) {
    this.trajectory.steps.push({ ...step, t: Date.now() });
  }

  setOutcome(outcome: 'success' | 'failure') {
    this.trajectory.outcome = outcome;
    this.trajectory.endedAt = Date.now();
  }

  /** 导出为精简文本（供 reviewer 的 ReviewContext.trace 使用） */
  toTraceText(): string {
    return this.trajectory.steps
      .map((s) => {
        switch (s.kind) {
          case 'thinking':
            return `[思考 R${s.round}] model=${(s.data.model as string) ?? '?'}`;
          case 'tool':
            return `[工具 R${s.round}] ${s.data.name} args=${JSON.stringify(s.data.args)} result=${s.data.error ? 'ERR:' + s.data.error : JSON.stringify(s.data.result)}`;
          case 'output':
            return (s.data.done ? '[输出·终]' : '[输出]') + ` ${s.data.text}`;
          case 'log':
            return `[${s.data.level}] ${s.data.msg}`;
        }
      })
      .join('\n');
  }
}
