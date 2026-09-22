import { isTauri } from '../platform/env';
import type { AgentConfig } from '../types/agent';

/**
 * 全局通用智能体（应用级，跨项目共享）。
 *
 * 与「项目级智能体」（.slimemold/agents.json，随项目 git 走）区分：
 * - 全局智能体落 AppData/com.slimemold/global-agents.json，跨项目复用；
 * - 用于解决「每次新建项目都要重新配置智能体/路由表」的痛点：
 *   用户可把常用的智能体（如本地 Ollama、公司中转）提升为全局，所有项目自动可用；
 * - 项目打开时「项目级 ∪ 全局」构成可用候选池，项目级同名(id)覆盖全局。
 *
 * 与 Vault（endpoints.json，纯 key 存储）不同，这里是「智能体语义配置」
 * （含 protocol/baseUrl/model/credentialKey 等），但同样只存 credentialKey，
 * 绝不落明文 apiKey。
 */

/** 全局智能体文件名（AppData/com.slimemold 下） */
export const GLOBAL_AGENTS_FILE = 'global-agents.json';

async function invokeRaw<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 读取全局智能体列表；非 Tauri / 文件不存在 / 解析失败返回空数组（静默降级，不阻塞启动）。 */
export async function loadGlobalAgents(): Promise<AgentConfig[]> {
  if (!isTauri) return [];
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dir = await appDataDir();
    const fs = await import('@tauri-apps/plugin-fs');
    const full = `${dir}/com.slimemold/${GLOBAL_AGENTS_FILE}`;
    if (!(await fs.exists(full))) return [];
    const raw = await fs.readTextFile(full);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((a): a is AgentConfig => !!a && typeof a === 'object' && typeof a.id === 'string');
  } catch {
    return [];
  }
}

/** 保存全局智能体列表（覆盖写）。返回是否成功；非 Tauri 环境返回 false。 */
export async function saveGlobalAgents(agents: AgentConfig[]): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dir = await appDataDir();
    const fs = await import('@tauri-apps/plugin-fs');
    const folder = `${dir}/com.slimemold`;
    await fs.mkdir(folder, { recursive: true });
    const full = `${folder}/${GLOBAL_AGENTS_FILE}`;
    await fs.writeTextFile(full, JSON.stringify(agents, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 合并「项目级 ∪ 全局」智能体为可用候选池：项目级优先，同名(id)覆盖全局。
 * 顺序：项目级在前，全局在后（去重后按项目级顺序优先）。
 */
export function mergeAgentPool(projectAgents: AgentConfig[], globalAgents: AgentConfig[]): AgentConfig[] {
  const seen = new Set<string>();
  const merged: AgentConfig[] = [];
  for (const a of [...projectAgents, ...globalAgents]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    merged.push(a);
  }
  return merged;
}

/** 仅供测试/工具：读取 AppData 文件原样（透传，不解析）。 */
export async function _rawReadForTest(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dir = await appDataDir();
    const fs = await import('@tauri-apps/plugin-fs');
    const full = `${dir}/com.slimemold/${GLOBAL_AGENTS_FILE}`;
    if (!(await fs.exists(full))) return null;
    return await fs.readTextFile(full);
  } catch {
    return null;
  }
}

/** 供 invoke 测试/备份使用：暴露底层写命令。 */
export { invokeRaw };
