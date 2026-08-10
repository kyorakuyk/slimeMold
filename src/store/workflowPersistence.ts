/**
 * workflowPersistence.ts — workflowStore 持久化落盘纯逻辑（G5 门面化第三步）。
 *
 * 把 checkpoint 落盘段从 workflowStore 抽离：
 * - saveCheckpointToDisk：把「内存态 checkpoint + 历史」独立写 .slimemold/runs/checkpoints.json
 *   （原子 tmp+rename，由 projectIO.saveCheckpoints 实现）。Tauri + 已绑定项目路径时才落盘；
 *   失败仅 warn 不阻断（检查点是运行态快照，非项目内容变更，不标脏）。
 *
 * 设计原则：纯函数（不触碰 store 单例），只依赖输入；store action 负责内存态更新，
 * 本模块只负责「把给定状态落盘」。供 persistCheckpoint / persistCheckpointSnapshot 复用。
 */
import { isTauri } from '../platform/env';
import type { RunCheckpoint } from '../engine/checkpoint';

/**
 * 把检查点状态落盘到项目 runs/checkpoints.json。
 * @param projectPath 项目根目录（.slimemold 所在层）；为空或非 Tauri 时跳过（返回 false）
 * @param checkpoints 最新检查点表（按 wfId）
 * @param history 检查点多版本历史（按 wfId）
 * @returns 是否已尝试落盘（true=已写/已忽略，false=无项目路径跳过）
 */
export async function saveCheckpointToDisk(
  projectPath: string | null,
  checkpoints: Record<string, RunCheckpoint>,
  history: Record<string, RunCheckpoint[]>,
): Promise<boolean> {
  if (!isTauri || !projectPath) return false;
  try {
    const { saveCheckpoints } = await import('../io/projectIO');
    await saveCheckpoints(projectPath, checkpoints, history);
    return true;
  } catch (e) {
    console.warn('[checkpoint] 检查点落盘失败（已保留内存态）:', e);
    return false;
  }
}
