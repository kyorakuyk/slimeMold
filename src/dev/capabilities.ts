/**
 * H4 DevCapabilityService（docs/H4_SELF_DEVELOPMENT_FOUNDATION.md §3）。
 *
 * 受 SelfDevelopmentPolicy 控制的宿主能力服务：code.read / code.patch / shell.run /
 * test.run / git.status / git.diff。安全约束集中在确定性边界内：
 * - 路径：相对路径必须落在 allowedPaths 且不命中 protectedPaths（assertPathAllowed），
 *   且经 resolveInside 防 ../ 逃逸；
 * - shell/test：命令白名单校验（默认仅 headless 白名单命令）；
 * - git：只读命令。
 *
 * 本文件提供：
 * 1. applyUnifiedPatch：纯函数（单测友好），解析并应用统一 diff（禁整文件覆盖——必须走 diff）；
 * 2. DevCapabilityService 接口 + createNodeDevService：Node/headless 真实实现（命令/文件可注入
 *    便于单测）；Tauri/浏览器环境由上层按 env 分支（浏览器经 shim 抛错，GUI 下开发节点不执行任意命令）。
 */
import type { SelfDevelopmentPolicy } from './policy';
import { assertPathAllowed } from './policy';
import type { CommandResult } from './node-run';
import { runCommand, readTextFile, writeTextFile, resolveInside, relativePath } from './node-run';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface DevFileRead {
  content: string;
  lineCount: number;
}

export interface DevPatchResult {
  ok: boolean;
  error?: string;
  contentHash?: string;
}

export interface DevContext {
  /** 工作根（worktree 路径）。所有相对路径基于此解析。 */
  cwd: string;
}

export interface DevCapabilityService {
  readonly env: 'node' | 'tauri' | 'browser';
  codeRead(relPath: string, ctx: DevContext): Promise<DevFileRead>;
  codePatch(relPath: string, unifiedDiff: string, ctx: DevContext): Promise<DevPatchResult>;
  shellRun(cmd: string[], ctx: DevContext): Promise<CommandResult>;
  testRun(cmd: string[], ctx: DevContext): Promise<CommandResult>;
  gitStatus(ctx: DevContext): Promise<CommandResult>;
  gitDiff(baseRef: string | undefined, ctx: DevContext): Promise<CommandResult>;
  /** 工作树变更文件（tracked diff + untracked），供 path-policy/diff 证据使用。 */
  gitChangedFiles(ctx: DevContext): Promise<string[]>;
}

/* ------------------------------------------------------------------ */
/* applyUnifiedPatch（纯函数）                                         */
/* ------------------------------------------------------------------ */

export interface ApplyPatchResult {
  ok: boolean;
  result?: string;
  error?: string;
}

/**
 * 应用单文件 unified diff。
 * - 支持 ---/+++ 头、@@ hunk、' '/'-'/'+' 行、尾部 "\ No newline" 与空行；
 * - 逐行校验上下文/删除行与原文精确匹配，不匹配即失败（防错位覆盖）；
 * - 不允许整文件覆盖：调用方必须提供 diff 而非完整内容。
 */
export function applyUnifiedPatch(original: string, patch: string): ApplyPatchResult {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // 跳过 --- / +++ 头与空行，定位第一个 hunk
  while (i < lines.length) {
    if (lines[i].startsWith('@@')) break;
    i++;
  }
  if (i >= lines.length) return { ok: false, error: '补丁中没有 @@ hunk' };

  const src = original.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let srcIdx = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
        return { ok: false, error: `非法 hunk 头：${line}` };
      }
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line === '') continue; // 尾随空行
    const prefix = line[0];
    const rest = line.slice(1);
    if (prefix === '-') {
      if (src[srcIdx] !== rest) {
        return { ok: false, error: `删除行不匹配：${rest}` };
      }
      srcIdx++;
    } else if (prefix === '+') {
      out.push(rest);
    } else if (prefix === ' ') {
      if (src[srcIdx] !== rest) {
        return { ok: false, error: `上下文不匹配：${rest}` };
      }
      out.push(rest);
      srcIdx++;
    } else {
      return { ok: false, error: `非法补丁行：${line}` };
    }
  }
  while (srcIdx < src.length) {
    out.push(src[srcIdx]);
    srcIdx++;
  }
  return { ok: true, result: out.join('\n') };
}

/* ------------------------------------------------------------------ */
/* Node 实现                                                           */
/* ------------------------------------------------------------------ */

/** 命令白名单规则：命令名 + 允许的参数前缀（argsPrefix 缺失=任意参数但命令名受限）。 */
interface CommandRule {
  cmd: string;
  argsPrefix?: string[];
}

/** 命令数组是否匹配规则：命令名一致且参数以 argsPrefix 为前缀（参数数量 ≥ 前缀长度）。 */
function matchesRule(rule: CommandRule, cmd: string[]): boolean {
  if (cmd[0] !== rule.cmd) return false;
  if (!rule.argsPrefix) return true;
  const args = cmd.slice(1);
  if (args.length < rule.argsPrefix.length) return false;
  return rule.argsPrefix.every((p, i) => args[i] === p);
}

function matchesAnyRule(rules: CommandRule[], cmd: string[]): boolean {
  return rules.some((r) => matchesRule(r, cmd));
}

/**
 * shell 白名单（只读命令）：基础查询 + 只读 git。
 * 明确排除：git push/commit/config/remote、node -e、npx（下载执行外部包）、npm install/任意 npm run。
 */
const DEFAULT_SHELL_RULES: CommandRule[] = [
  { cmd: 'pwd' }, { cmd: 'echo' }, { cmd: 'ls' }, { cmd: 'cat' },
  { cmd: 'find' }, { cmd: 'head' }, { cmd: 'tail' }, { cmd: 'grep' },
  { cmd: 'git', argsPrefix: ['status'] },
  { cmd: 'git', argsPrefix: ['diff'] },
  { cmd: 'git', argsPrefix: ['log'] },
  { cmd: 'git', argsPrefix: ['ls-files'] },
  { cmd: 'git', argsPrefix: ['rev-parse'] },
];

/** 测试白名单：typecheck / vitest / 本地脚本（scripts/ 目录） / 仓库自带的特定 npm script。 */
const DEFAULT_TEST_RULES: CommandRule[] = [
  { cmd: 'tsc', argsPrefix: ['--noEmit'] },
  { cmd: 'tsc', argsPrefix: ['-b'] },
  { cmd: 'vitest', argsPrefix: ['run'] },
  { cmd: 'tsx', argsPrefix: ['scripts/'] },
  { cmd: 'npm', argsPrefix: ['run', 'test'] },
  { cmd: 'npm', argsPrefix: ['run', 'build'] },
  { cmd: 'npm', argsPrefix: ['run', 'i18n:check'] },
];

export interface NodeDevDeps {
  runCommand?: (cmd: string, args: string[], cwd: string) => Promise<CommandResult>;
  readFile?: (abs: string) => Promise<string>;
  writeFile?: (abs: string, content: string) => Promise<void>;
  resolveInside?: (root: string, relPath: string) => Promise<string>;
  relativePath?: (root: string, abs: string) => Promise<string>;
  shellAllow?: (cmd: string[]) => boolean;
  testAllow?: (cmd: string[]) => boolean;
}

/** 快速内容哈希（非密码用途，仅证据指纹）。 */
function hashContent(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(36)}`;
}

/**
 * 创建 Node/headless 真实 DevCapabilityService。
 * 命令/文件操作默认走 node-run；可通过 deps 注入（单测用 fake 避免真实执行）。
 * env 恒为 'node'（headless/CI）；GUI 环境应由上层使用 createDevServiceByEnv 分支。
 */
export function createNodeDevService(
  policy: SelfDevelopmentPolicy,
  deps: NodeDevDeps = {},
): DevCapabilityService {
  const run = deps.runCommand ?? runCommand;
  const read = deps.readFile ?? readTextFile;
  const write = deps.writeFile ?? writeTextFile;
  const resolveP = deps.resolveInside ?? resolveInside;
  const relP = deps.relativePath ?? relativePath;
  const shellAllow = deps.shellAllow ?? ((cmd: string[]) => matchesAnyRule(DEFAULT_SHELL_RULES, cmd));
  const testAllow = deps.testAllow ?? ((cmd: string[]) => matchesAnyRule(DEFAULT_TEST_RULES, cmd));

  /**
   * P0 修复（审计）：路径必须先规范化再判定白名单/保护路径。
   * `src/components/../orchestrator/run.ts` 若先对原始串判定会过 components 白名单，
   * 随后才解析到受保护的 orchestrator——必须 resolve → 转相对 → 再 assertPathAllowed。
   */
  const guardedAbs = async (relPath: string, ctx: DevContext): Promise<string> => {
    const abs = await resolveP(ctx.cwd, relPath);
    const rel = await relP(ctx.cwd, abs);
    assertPathAllowed(policy, rel);
    return abs;
  };

  return {
    env: 'node',

    async codeRead(relPath, ctx) {
      const abs = await guardedAbs(relPath, ctx);
      const content = await read(abs);
      return { content, lineCount: content.split('\n').length };
    },

    async codePatch(relPath, unifiedDiff, ctx) {
      const abs = await guardedAbs(relPath, ctx);
      const original = await read(abs);
      const applied = applyUnifiedPatch(original, unifiedDiff);
      if (!applied.ok) return { ok: false, error: applied.error };
      await write(abs, applied.result!);
      return { ok: true, contentHash: hashContent(applied.result!) };
    },

    async shellRun(cmd, ctx) {
      if (cmd.length === 0 || !shellAllow(cmd)) {
        return { exitCode: -1, stdout: '', stderr: `命令不在白名单内：${cmd.join(' ') || '(空)'}`, durationMs: 0 };
      }
      const [c0, ...rest] = cmd;
      return run(c0, rest, ctx.cwd);
    },

    async testRun(cmd, ctx) {
      if (cmd.length === 0 || !testAllow(cmd)) {
        return { exitCode: -1, stdout: '', stderr: `测试命令不在白名单内：${cmd.join(' ') || '(空)'}`, durationMs: 0 };
      }
      const [c0, ...rest] = cmd;
      return run(c0, rest, ctx.cwd);
    },

    async gitStatus(ctx) {
      return run('git', ['status', '--porcelain'], ctx.cwd);
    },

    async gitDiff(baseRef, ctx) {
      const args = baseRef ? ['diff', baseRef] : ['diff', 'HEAD'];
      return run('git', args, ctx.cwd);
    },

    async gitChangedFiles(ctx) {
      const [tracked, untracked] = await Promise.all([
        run('git', ['diff', '--name-only', 'HEAD'], ctx.cwd),
        run('git', ['ls-files', '--others', '--exclude-standard'], ctx.cwd),
      ]);
      const set = new Set<string>();
      for (const raw of [tracked.stdout, untracked.stdout]) {
        for (const f of raw.split('\n')) {
          const t = f.trim();
          if (t) set.add(t);
        }
      }
      return [...set];
    },
  };
}
