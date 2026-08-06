/**
 * #8 记忆 / 技能落盘
 *
 * 统一的「项目级记忆与技能草稿」持久化层，所有平台能力经 @/platform/env 收敛
 * （Tauri 走 plugin-fs 落盘到 <项目根>/.slimemold/，浏览器退化为 localStorage）。
 *
 * 本文件只负责「落盘」，不触碰 workflowStore；子图草稿注册回 store 由调用方（reviewer）完成，
 * 避免记忆层直接依赖运行时状态，便于测试与复用。
 */

import { appendProjectText, writeProjectText } from '@/platform/env';
import type { SubgraphDef } from '@/types';

/** 记忆文件相对路径（位于项目根 .slimemold 目录下） */
export const MEMORY_REL = '.slimemold/memory.md';
/** 技能草稿目录相对路径 */
export const SKILLS_DIR_REL = '.slimemold/skills';

/**
 * 从 _MEMORY / _COMBINED 审查文本中提取 `## 提炼` 段内的条目列表。
 * 无该段时返回 null（表示本轮无可沉淀记忆）。
 */
export function extractMemoryList(text: string): string | null {
  const m = text.match(/##\s*提炼\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  const body = m ? m[1].trim() : text.trim();
  if (!body || body === '（无）' || body === '无') return null;
  return body;
}

/**
 * 从审查文本中解析单个技能 JSON（_SKILL / _COMBINED 技能节）。
 * 容忍被 ```json 代码块包裹或前后多余文字。解析失败返回 null。
 */
export function extractSkillJson(text: string): SkillDraft | null {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 截取首个 { 到末个 }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    if (!obj || typeof obj !== 'object') return null;
    const name = String(obj.name ?? '').trim();
    if (!name) return null;
    return {
      name,
      summary: String(obj.summary ?? '').trim(),
      whenToUse: String(obj.whenToUse ?? '').trim(),
      body: String(obj.body ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 追加一条记忆到项目级 memory.md。
 * @param root   项目根磁盘路径（Tauri）；浏览器传 null
 * @param text   记忆正文（建议为单条提炼，已含标题/正文）
 */
export async function commitMemory(root: string | null | undefined, text: string): Promise<void> {
  const stamp = new Date().toISOString();
  const block = `<!-- memory ${stamp} -->\n\n${text.trim()}\n`;
  await appendProjectText(root, MEMORY_REL, block);
}

/** 技能草稿结构化内容（由 reviewer 的 _SKILL 审查产出 JSON 解析而来） */
export interface SkillDraft {
  name: string;
  summary: string;
  whenToUse: string;
  body: string;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'skill';
}

/**
 * 把技能草稿落盘为 .slimemold/skills/<slug>.json，并返回可注册的 SubgraphDef（草稿态）。
 * 不写 store —— 调用方负责 saveSubgraphDef 注册，使 SubgraphPanel 可见。
 */
export async function commitSkillDraft(
  root: string | null | undefined,
  skill: SkillDraft,
): Promise<SubgraphDef> {
  const slug = `${slugify(skill.name)}-${Date.now().toString(36)}`;
  const nowIso = new Date().toISOString();
  const def: SubgraphDef = {
    id: `skill:${slug}`,
    name: skill.name,
    description: [
      skill.summary,
      skill.whenToUse ? `触发时机：${skill.whenToUse}` : '',
      '',
      skill.body,
    ]
      .filter(Boolean)
      .join('\n'),
    category: '技能草稿',
    nodes: [],
    edges: [],
    inputs: [],
    outputs: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const relPath = `${SKILLS_DIR_REL}/${slug}.json`;
  await writeProjectText(root, relPath, JSON.stringify(def, null, 2));
  return def;
}
