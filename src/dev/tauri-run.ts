/**
 * H4 GUI（Tauri WebView）执行通道：把 DevSession 的底层命令/文件/路径操作
 * 下沉到 Rust 宿主（lib.rs 的 dev_exec / dev_read_file / dev_write_file），
 * 与 headless 的 node-run.ts 平级。
 *
 * 安全边界（与 Rust 侧对齐）：
 * - dev_exec：命令名白名单 + cwd 必须属于「已登记 worktree 或主仓库根」+ 剥离凭据 env + 超时；
 * - dev_read_file / dev_write_file：路径必须属于已登记 worktree（防任意读写宿主磁盘）；
 * - resolveInside / relativePath：纯前端实现（node:path 在 GUI 被 vite shim 掉），
 *   逃逸判定仍由 capabilities 的 assertPathAllowed + worktree 登记兜底。
 */
import type { NodeDevDeps } from './capabilities';
import type { DevGitRunner } from './worktree';
import type { CommandResult } from './node-run';
import type { EvidencePersistence, JsonlFsOps } from './evidence';
import { createHostEvidenceStoreWithFs } from './evidence';
import { pathComparisonKeyWeb, resolveWeb, relativeWeb } from './path-utils';

/** Rust dev_exec 返回结构。 */
interface DevExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** invoke 封装（延迟 import，避免非 Tauri 构建硬依赖）。 */
async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function toCommandResult(r: DevExecResult): CommandResult {
  return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, durationMs: 0 };
}

/** Tauri git runner：git 命令经 dev_exec 在宿主执行（cwd 归属由 Rust 校验）。 */
export function createTauriGitRunner(): DevGitRunner {
  return {
    git: async (args, cwd) => {
      try {
        const r = await call<DevExecResult>('dev_exec', { args: ['git', ...args], cwd });
        return toCommandResult(r);
      } catch (e) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
          durationMs: 0,
        };
      }
    },
  };
}

/** Tauri deps：把 NodeDevDeps 的命令/文件/路径替换为 Rust 通道实现。 */
export function createTauriDeps(): NodeDevDeps {
  return {
    runCommand: async (cmd, args, cwd) => {
      try {
        const r = await call<DevExecResult>('dev_exec', { args: [cmd, ...args], cwd });
        return toCommandResult(r);
      } catch (e) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
          durationMs: 0,
        };
      }
    },
    readFile: async (abs) => call<string>('dev_read_file', { path: abs }),
    writeFile: async (abs, content) => {
      await call<void>('dev_write_file', { path: abs, content });
    },
    mkdir: async (abs) => {
      await call<void>('dev_create_dir', { path: abs });
    },
    resolveInside: async (root, rel) => {
      const abs = resolveWeb(root, rel);
      const rootNorm = resolveWeb(root, '.');
      const absKey = pathComparisonKeyWeb(abs);
      const rootKey = pathComparisonKeyWeb(rootNorm);
      if (absKey !== rootKey && !absKey.startsWith(rootKey + '/')) {
        throw new Error(`路径逃逸拒绝：${rel}（root=${rootNorm}）`);
      }
      return abs;
    },
    relativePath: async (root, abs) => relativeWeb(root, abs),
  };
}

/** Tauri 证据 JSONL 持久化（plugin-fs 落盘；仅 GUI 用，宿主固定路径在 worktree 外）。 */
export function createTauriJsonlFs(): JsonlFsOps {
  return {
    mkdir: async (dir) => {
      const fs = await import('@tauri-apps/plugin-fs');
      await fs.mkdir(dir, { recursive: true });
    },
    append: async (abs, text) => {
      const fs = await import('@tauri-apps/plugin-fs');
      await fs.writeTextFile(abs, text, { append: true });
    },
    read: async (abs) => {
      const fs = await import('@tauri-apps/plugin-fs');
      return fs.readTextFile(abs);
    },
  };
}

/** 便捷工厂：Tauri 下构造宿主固定路径的 EvidenceStore（复用宿主管道断言 + plugin-fs 注入）。 */
export function createTauriEvidenceStore(
  evidenceRoot: string,
  worktreePath: string,
  key: string,
): EvidencePersistence {
  return createHostEvidenceStoreWithFs(evidenceRoot, worktreePath, key, createTauriJsonlFs());
}
