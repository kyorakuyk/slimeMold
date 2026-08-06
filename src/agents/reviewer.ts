/**
 * reviewer.ts —— 异步审查 Agent（#11）。
 *
 * 在 harness 跑完一个任务后，异步地对轨迹做复盘，产出三类审查结果：
 *   - _MEMORY   ：沉淀到 project 级变量 / memory.md 的记忆提炼
 *   - _SKILL    ：沉淀为 subgraph 草稿的技能提炼
 *   - _COMBINED ：综合复盘
 *
 * 关键安全设计：selfImprove 全局开关**默认关**，避免在无用户确认时意外产生 LLM
 * 费用或自动写入文件。开启后才允许把审查结果落盘（memory.md / subgraph 草稿）。
 * 审查本身是只读的（只调 LLM 分析轨迹，不写盘），落盘由 selfImprove 控制。
 *
 * 复用：prompts.buildReviewPrompt + harness.runAgentLoop（共用 AgentHarness）。
 */

import type { AgentConfig, ChatMessage } from '../types';
import { runAgentLoop } from './harness';
import { buildReviewPrompt, type ReviewContext, type ReviewKind } from './prompts';
import { commitMemory, commitSkillDraft, extractMemoryList, extractSkillJson } from './memoryIo';
import { useWorkflowStore } from '@/store/workflowStore';

/** 全局 selfImprove 开关（默认关，避免意外费用/落盘）。由 UI / 配置入口翻转。 */
let selfImproveEnabled = false;

export function setSelfImprove(on: boolean): void {
  selfImproveEnabled = on;
}
export function isSelfImprove(): boolean {
  return selfImproveEnabled;
}

export interface ReviewOptions {
  /** 审查 Agent（独立于任务 Agent，避免污染） */
  reviewerAgent: AgentConfig;
  kind: ReviewKind;
  context: ReviewContext;
  /** 异步触发（不阻塞调用方）；默认 true */
  async?: boolean;
  /** 审查完成回调（selfImprove 关闭时也可拿到文本供 UI 展示） */
  onResult?: (text: string) => void;
  /** 仅当 selfImprove 开启时调用：把结果落盘（memory.md / subgraph 草稿） */
  onCommit?: (text: string) => void;
  signal?: AbortSignal;
  /**
   * 项目根磁盘路径（Tauri）；浏览器传 null。提供后 selfImprove 才真正落盘，
   * 否则仅触发 onCommit 回调（不写文件）。
   */
  projectRoot?: string | null;
}

/**
 * 触发一次审查。自评模式下 fire-and-forget（async=true）。
 * 始终会调 onResult（文本），但仅当 selfImprove 开启才落盘。
 */
export async function runReview(opts: ReviewOptions): Promise<string> {
  const { reviewerAgent, kind, context, async = true, onResult, onCommit, signal, projectRoot } =
    opts;
  const prompt = buildReviewPrompt(kind, context);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  const task = async (): Promise<string> => {
    try {
      const result = await runAgentLoop({
        agent: reviewerAgent,
        userMessages: messages,
        signal: signal ?? new AbortController().signal,
        events: {
          onLog: (_lv, _m) => {},
        },
      });
      onResult?.(result.text);
      // 仅 selfImprove 开启时落盘，避免意外写入与费用叠加
      if (selfImproveEnabled) await commitReview(kind, result.text, projectRoot, onCommit);
      return result.text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onResult?.(`⚠️ 审查失败：${msg}`);
      return '';
    }
  };

  if (async) {
    // 不 await，fire-and-forget
    void task();
    return '';
  }
  return task();
}

/**
 * 按审查类型把结果落盘（#8 记忆/技能沉淀）。
 * - _MEMORY ：提炼项追加到 <root>/.slimemold/memory.md
 * - _SKILL  ：技能 JSON 落盘为 subgraph 草稿 + 注册进 store.subgraphs
 * - _COMBINED：记忆节与技能节分别落盘
 * 任何落盘/解析失败都不向上抛（仅 console.warn），保证审查不阻塞主流程。
 */
async function commitReview(
  kind: ReviewKind,
  text: string,
  root: string | null | undefined,
  onCommit?: (text: string) => void,
): Promise<void> {
  try {
    if (kind === '_MEMORY') {
      const list = extractMemoryList(text);
      if (list && root != null) await commitMemory(root, list);
      onCommit?.(text);
      return;
    }
    if (kind === '_SKILL') {
      const skill = root != null ? extractSkillJson(text) : null;
      if (skill) {
        const def = await commitSkillDraft(root, skill);
        useWorkflowStore.getState().saveSubgraphDef(def);
      }
      onCommit?.(text);
      return;
    }
    // _COMBINED：拆两节
    const memMatch = text.match(/##\s*记忆\s*\n([\s\S]*?)(?:\n##\s*|$)/i);
    const skillMatch = text.match(/##\s*技能\s*\n([\s\S]*?)(?:\n##\s*|$)/i);
    if (memMatch && root != null) {
      const list = extractMemoryList(memMatch[1]);
      if (list) await commitMemory(root, list);
    }
    if (skillMatch && root != null) {
      const skill = extractSkillJson(skillMatch[1]);
      if (skill) {
        const def = await commitSkillDraft(root, skill);
        useWorkflowStore.getState().saveSubgraphDef(def);
      }
    }
    onCommit?.(text);
  } catch (e) {
    console.warn('[reviewer] commitReview 失败（已跳过落盘）:', e);
  }
}
