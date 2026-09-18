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
import type { GitDiffIntent } from './commandPolicy';
import { buildSafeGitDiffArgs, parseWorkerCommand } from './commandPolicy';
import type { SelfDevelopmentPolicy } from './policy';
import { assertPathAllowed, isPathAllowed, isPathProtected } from './policy';
import type { CommandResult } from './node-run';
import { runCommand, readTextFile, writeTextFile, resolveInside, relativePath, assertNoMultipleHardlinks } from './node-run';

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
  /** One-call approved policy override for task-scoped host validation only. */
  pathPolicy?: SelfDevelopmentPolicy;
}

export interface DevCapabilityService {
  readonly env: 'node' | 'tauri' | 'browser';
  codeRead(relPath: string, ctx: DevContext): Promise<DevFileRead>;
  /** 在已登记 worktree 内创建相对目录；由结构化补丁应用器使用，非工作流自由写入。 */
  codeMkdir?(relPath: string, ctx: DevContext): Promise<void>;
  codePatch(relPath: string, unifiedDiff: string, ctx: DevContext): Promise<DevPatchResult>;
  shellRun(cmd: string[], ctx: DevContext): Promise<CommandResult>;
  testRun(cmd: string[], ctx: DevContext): Promise<CommandResult>;
  gitStatus(ctx: DevContext): Promise<CommandResult>;
  gitDiff(baseRef: string | undefined, ctx: DevContext): Promise<CommandResult>;
  /** 工作树变更文件（tracked diff + untracked），供 path-policy/diff 证据使用。 */
  gitChangedFiles(ctx: DevContext, baseRef?: string): Promise<string[]>;
  /** 未跟踪文件清单（untracked，供状态签名纳入内容）。 */
  gitUntrackedFiles(ctx: DevContext): Promise<string[]>;
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

/**
 * 命令白名单规则（审计收紧）：
 * - args：精确匹配（参数完全一致才允许——防 `npm run test -- --extra` 之类穿透）；
 * - argsPrefix：前缀匹配 + allowExtraArgs 限制额外参数个数；
 * - disallowDashExtra：额外参数不得以 `-` 开头（防 `--output=`/`--config` 等危险选项）；
 * - denyContain：任一参数包含这些子串 → 拒绝（防 `git diff --output=` 落盘越权、`--no-index` 等）；
 * - denyAbsPath：参数不得是绝对路径或含 `..` 段（防 `cat /etc/passwd`、`cat ../secret`）；
 * - pathArgs：所有参数按「路径」处理——逐个 resolveInside + assertPathAllowed
 *   （P1 审计：防 `cat src/orchestrator/run.ts` 经相对路径读取受保护代码）。
 */
interface CommandRule {
  cmd: string;
  args?: string[];
  argsPrefix?: string[];
  /** 前缀参数使用 startsWith 匹配（例如 tsx 的 scripts/ 脚本路径）。 */
  argsPrefixStartsWith?: string[];
  /** 前缀后允许的额外参数个数下限/上限 */
  minExtraArgs?: number;
  allowExtraArgs?: number;
  disallowDashExtra?: boolean;
  denyContain?: string[];
  denyArgs?: string[];
  denyArgPrefixes?: string[];
  denyArgPatterns?: RegExp[];
  denyAbsPath?: boolean;
  /** 参数全部按路径校验（allowedPaths 内 + 非 protected + worktree 内） */
  pathArgs?: boolean;
  /** 从第 N 个参数（0-based，不含命令名）起按路径校验；grep 用 1 跳过 pattern 参数 */
  pathArgsFrom?: number;
}

/** 命令数组是否匹配规则（精确 / 前缀 + 受限额外参数 / 纯命令名）。 */
function matchesRule(rule: CommandRule, cmd: string[]): boolean {
  if (cmd[0] !== rule.cmd) return false;
  const args = cmd.slice(1);
  if (rule.args) {
    // 精确匹配：参数完全一致才允许
    if (args.length !== rule.args.length) return false;
    if (!rule.args.every((a, i) => args[i] === a)) return false;
  } else if (rule.argsPrefix || rule.argsPrefixStartsWith) {
    // 前缀匹配 + 额外参数个数上下限 + 禁 '-' 开头额外参数
    const exactPrefix = rule.argsPrefix ?? [];
    const startsWithPrefix = rule.argsPrefixStartsWith ?? [];
    const prefixLength = exactPrefix.length || startsWithPrefix.length;
    if (args.length < prefixLength) return false;
    if (exactPrefix.length && !exactPrefix.every((a, i) => args[i] === a)) return false;
    if (startsWithPrefix.length && !startsWithPrefix.every((a, i) => args[i].startsWith(a))) return false;
    const extra = args.slice(prefixLength);
    const minExtra = rule.minExtraArgs ?? 0;
    const maxExtra = rule.allowExtraArgs ?? 0;
    if (extra.length < minExtra || extra.length > maxExtra) return false;
    if (rule.disallowDashExtra && extra.some((a) => a.startsWith('-'))) return false;
  }
  // 既无 args 也无 argsPrefix → 纯命令名规则（如 {cmd:'cat', denyAbsPath:true}），命令名匹配即可
  if (rule.denyContain?.some((d) => args.some((a) => a.includes(d)))) return false;
  if (rule.denyArgs?.some((d) => args.includes(d))) return false;
  if (rule.denyArgPrefixes?.some((prefix) => args.some((a) => a.startsWith(prefix)))) return false;
  if (rule.denyArgPatterns?.some((pattern) => args.some((a) => pattern.test(a)))) return false;
  if (rule.denyAbsPath && args.some((a) => a.startsWith('/') || a.split(/[/\\]/).includes('..'))) {
    return false;
  }
  return true;
}

function findMatchingRule(rules: CommandRule[], cmd: string[]): CommandRule | null {
  return rules.find((r) => matchesRule(r, cmd)) ?? null;
}

function matchesAnyRule(rules: CommandRule[], cmd: string[]): boolean {
  return findMatchingRule(rules, cmd) !== null;
}



/**
 * shell 白名单（只读）：基础查询命令（pathArgs：参数按路径校验，禁读 protected 外代码）+ 只读 git（精确参数）。
 * 明确排除：git push/commit/config/remote、node -e、npx、npm install/任意 npm run、
 * git diff/log 的 --output= 与 --no-index 等。
 * grep 不设 pathArgs（首个参数是正则 pattern 而非路径，避免误伤）。
 */
function isSafeGitRevisionValue(value: string): boolean {
  if (value === 'HEAD' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return true;
  if (/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(value)) {
    return !value.includes('..') && !value.includes('//') && !value.endsWith('/');
  }
  if (/^(?:feature|bugfix|hotfix|release|worker)\/[A-Za-z0-9._/-]+$/.test(value)) {
    const leaf = value.split('/').at(-1) ?? '';
    return !value.includes('..') && !value.includes('//') && Boolean(leaf) && !leaf.includes('.');
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(value) || /^[A-Za-z0-9]$/.test(value);
}

const DEFAULT_SHELL_RULES: CommandRule[] = [
  { cmd: 'pwd' },
  { cmd: 'echo' },
  { cmd: 'ls', denyAbsPath: true, denyArgPatterns: [/^-/], pathArgs: true },
  { cmd: 'cat', denyAbsPath: true, denyArgPatterns: [/^-/], pathArgs: true },
  {
    cmd: 'find',
    denyAbsPath: true,
    pathArgs: true,
    denyArgs: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-L', '-H', '-follow', '-files0-from', '--files0-from'],
    denyArgPrefixes: ['-fprint', '-fls', '-files0-from=', '--files0-from='],
  },
  { cmd: 'head', denyAbsPath: true, denyArgPatterns: [/^-/], pathArgs: true },
  { cmd: 'tail', denyAbsPath: true, denyArgPatterns: [/^-/], pathArgs: true },
  // grep：跳过首参 pattern（pathArgsFrom=1），后续文件路径参数走守卫
  {
    cmd: 'grep',
    denyAbsPath: true,
    pathArgsFrom: 1,
    denyArgs: [
      '-r', '-R', '--recursive', '-d', '--dereference-recursive',
      '--file', '--exclude-from', '--directories',
    ],
    denyArgPrefixes: ['--directories=', '--file=', '--exclude-from=', '-f'],
    denyArgPatterns: [/^-[^-]*[rR]/, /^-[^-]*f/],
  },
  { cmd: 'git', args: ['status', '--porcelain'] },
  { cmd: 'git', args: ['status', '--short'] },
  { cmd: 'git', args: ['diff', '--name-only', 'HEAD'] },
  { cmd: 'git', args: ['diff', '--name-only'] },
  {
    cmd: 'git',
    argsPrefix: ['diff', '--name-only'],
    minExtraArgs: 1,
    allowExtraArgs: 1,
    disallowDashExtra: true,
  },
  {
    cmd: 'git',
    argsPrefix: ['diff'],
    minExtraArgs: 1,
    allowExtraArgs: 1,
    disallowDashExtra: true,
    denyContain: ['--output=', '--no-index', '--ext-diff'],
  },
  {
    cmd: 'git',
    argsPrefix: ['log', '--oneline', '-n'],
    minExtraArgs: 1,
    allowExtraArgs: 1,
    disallowDashExtra: true,
    denyContain: ['--output=', '--no-walk'],
  },
  { cmd: 'git', args: ['ls-files', '--others', '--exclude-standard'] },
  { cmd: 'git', args: ['rev-parse', 'HEAD'] },
];

/** 测试白名单：typecheck / vitest / 本地脚本（scripts/）/ 仓库自带特定 npm script（精确，禁额外参数）。 */
const DEFAULT_TEST_RULES: CommandRule[] = [
  { cmd: 'tsc', args: ['--noEmit'] },
  { cmd: 'tsc', argsPrefix: ['--noEmit', '--target', 'es2020'], minExtraArgs: 1, allowExtraArgs: 20, disallowDashExtra: true, pathArgs: true, pathArgsFrom: 3 },
  { cmd: 'tsc', argsPrefix: ['--noEmit'], minExtraArgs: 1, allowExtraArgs: 20, disallowDashExtra: true, pathArgs: true, pathArgsFrom: 0 },
  { cmd: 'node', argsPrefix: ['--check'], minExtraArgs: 1, allowExtraArgs: 1, disallowDashExtra: true, pathArgs: true, pathArgsFrom: 1 },
  { cmd: 'tsc', args: ['-b'] },
  { cmd: 'vitest', args: ['run'] },
  { cmd: 'tsx', argsPrefixStartsWith: ['scripts/'], allowExtraArgs: 2, disallowDashExtra: true, denyContain: ['..'], pathArgs: true, pathArgsFrom: 0 },
  { cmd: 'npm', args: ['run', 'test'] },
  { cmd: 'npm', args: ['run', 'build'] },
  { cmd: 'npm', args: ['run', 'i18n:check'] },
];

export interface NodeDevDeps {
  runCommand?: (cmd: string, args: string[], cwd: string) => Promise<CommandResult>;
  readFile?: (abs: string) => Promise<string>;
  writeFile?: (abs: string, content: string) => Promise<void>;
  mkdir?: (abs: string) => Promise<void>;
  resolveInside?: (root: string, relPath: string) => Promise<string>;
  relativePath?: (root: string, abs: string) => Promise<string>;
  testAllow?: (cmd: string[]) => boolean;
}

/** 已登记 worktree 的只读注册表（P0 审计：能力层据此校验 cwd 属于已登记 worktree）。 */
export interface WorktreeRegistry {
  isTracked(cwd: string): boolean;
  isTrackedOrChild?(cwd: string): boolean;
  verifyCwd?(cwd: string): Promise<boolean>;
}

/** 快速内容哈希（非密码用途，仅证据指纹）。 */
export function hashContent(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(36)}`;
}

/**
 * 创建 Node/headless 真实 DevCapabilityService。
 * 命令/文件操作默认走 node-run；可通过 deps 注入（单测用 fake 避免真实执行）。
 * env 默认 'node'（headless/CI）；GUI（Tauri）由 createTauriDevService 传入 env='tauri'。
 */
function isMissingFileError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return true;
  if (typeof error !== 'string' && !(error instanceof Error)) return false;
  const message = (typeof error === 'string' ? error : error.message).trim();
  return /^(?:dev_read_file:\s*)?(?:ENOENT|file not found|no such file(?: or directory)?|文件不存在|路径不存在)$/i.test(message)
    || /(?:^|\s)os error 3$/i.test(message);
}

export function createNodeDevService(
  policy: SelfDevelopmentPolicy,
  deps: NodeDevDeps = {},
  registry?: WorktreeRegistry,
  env: 'node' | 'tauri' = 'node',
): DevCapabilityService {
  const run = deps.runCommand ?? runCommand;
  const read = deps.readFile ?? readTextFile;
  const write = deps.writeFile ?? writeTextFile;
  const makeDirectory = deps.mkdir ?? (async (abs: string) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(abs, { recursive: true });
  });
  const resolveP = deps.resolveInside ?? resolveInside;
  const relP = deps.relativePath ?? relativePath;
  const testAllow = deps.testAllow ?? ((cmd: string[]) => matchesAnyRule(DEFAULT_TEST_RULES, cmd));

  /**
   * P0 审计修复：cwd 必须属于已登记 worktree（fail-closed）。
   * - 未提供 registry → 拒绝执行（不允许「无登记也可运行」的降级）；
   * - 提供了 registry 但 cwd 未登记 → 拒绝（防把 cwd 指向主仓库/任意目录绕过隔离）。
   */
  const assertCwd = async (cwd: string): Promise<void> => {
    if (!registry) throw new Error('未配置 worktree registry：拒绝执行开发能力');
    if (registry.verifyCwd && !(await registry.verifyCwd(cwd))) {
      throw new Error(`工作目录 realpath 不属于已登记的 worktree：${cwd}`);
    }
    if (!registry.isTracked(cwd) && !registry.isTrackedOrChild?.(cwd)) {
      throw new Error(`工作目录不属于已登记的 worktree：${cwd}`);
    }
  };

  /**
   * P0 修复（审计）：路径必须先规范化再判定白名单/保护路径。
   * `src/components/../orchestrator/run.ts` 若先对原始串判定会过 components 白名单，
   * 随后才解析到受保护的 orchestrator——必须 resolve → 转相对 → 再 assertPathAllowed。
   */
  const guardedAbs = async (relPath: string, ctx: DevContext): Promise<string> => {
    await assertCwd(ctx.cwd);
    const abs = await resolveP(ctx.cwd, relPath);
    const rel = await relP(ctx.cwd, abs);
    assertPathAllowed(policy, rel);
    return abs;
  };

  const guardedDirectoryAbs = async (relPath: string, ctx: DevContext): Promise<string> => {
    await assertCwd(ctx.cwd);
    const abs = await resolveP(ctx.cwd, relPath);
    const rel = await relP(ctx.cwd, abs);
    const normalized = rel.replace(/\\/g, '/');
    const hasAllowedDescendant = policy.allowedPaths.some((allowed) => {
      const normalizedAllowed = allowed.replace(/\\/g, '/');
      return normalizedAllowed.startsWith(`${normalized}/`);
    });
    if (isPathProtected(policy, normalized) || (!isPathAllowed(policy, normalized) && !hasAllowedDescendant)) {
      throw new Error(`目录不在允许范围内（allowedPaths）：${rel}`);
    }
    return abs;
  };

  const isSafeGitDiffRevision = (value: string): boolean => isSafeGitRevisionValue(value);

  const assertCommandOperandGrammar = (cmd: string[]): void => {
    const [name, ...args] = cmd;
    if (name === 'ls' || name === 'cat' || name === 'head' || name === 'tail') {
      if (args.some((argument) => argument.startsWith('-'))) {
        throw new Error(`${name} 不接受命令选项`);
      }
    }
    if (name === 'grep') {
      let options = true;
      let patternIndex = -1;
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (options && argument === '--') {
          options = false;
          continue;
        }
        if (options && argument.startsWith('-')) continue;
        patternIndex = index;
        break;
      }
      if (patternIndex < 0) throw new Error('grep 缺少 pattern');
      for (const argument of args.slice(patternIndex + 1)) {
        if (argument.startsWith('-') || argument.includes('*') || argument.includes('?')) {
          throw new Error('grep 文件 operand 不接受选项或通配符');
        }
      }
    }
    if (name === 'git' && args[0] === 'diff' && args.length === 2) {
      const operand = args[1];
      if (
        !isSafeGitDiffRevision(operand)
        && (/^(?:\.\/?)+$/.test(operand)
          || operand.startsWith('/')
          || operand.startsWith('\\')
          || operand.split(/[\\/]/).includes('..')
          || operand.includes('*')
          || operand.includes('?'))
      ) {
        throw new Error('git diff operand 逃逸拒绝');
      }
    }
    if (
      name === 'git'
      && args[0] === 'diff'
      && args[1] === '--name-only'
      && args.length === 3
      && !isSafeGitDiffRevision(args[2])
    ) {
      throw new Error('git diff --name-only revision 非法');
    }
  };

  const safeDiffRoots = (activePolicy: SelfDevelopmentPolicy = policy): string[] => activePolicy.allowedPaths.filter((root) => {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
    return !activePolicy.protectedPaths.some((pattern) => {
      const base = pattern.replace(/\\/g, '/').replace(/\/\*\*$/, '').replace(/\/$/, '');
      return base === normalizedRoot
        || base.startsWith(`${normalizedRoot}/`)
        || normalizedRoot.startsWith(`${base}/`);
    });
  });

  /**
   * 命令白名单只约束「命令形式」，`cat src/orchestrator/run.ts` 这类相对路径参数仍可绕过
   * codeRead/codePatch 的路径策略读取受保护代码。对 pathArgs/pathArgsFrom 命令，从
   * fromIndex（默认 0）起的每个参数：
   * - 跳过选项（- 开头）与通配/模式参数（* ?）；
   * - resolveInside 防 ../ 逃逸（逃逸即抛错）；
   * - 转规范化相对路径后 assertPathAllowed（allowedPaths 内 + 非 protected）；
   * - '.'（worktree 根）放行。
   */
  const guardPathArgs = async (
    args: string[],
    ctx: DevContext,
    fromIndex = 0,
    protectedPrefix?: string,
    allowWildcards = false,
  ): Promise<string[]> => {
    const activePolicy = ctx.pathPolicy ?? policy;
    const guarded = [...args];
    for (let index = fromIndex; index < args.length; index += 1) {
      const a = args[index];
      if (!a || a.startsWith('-')) continue;
      if (process.platform === 'win32' && a.includes(':')) {
        throw new Error(`拒绝 Windows ADS/stream 路径：${a}`);
      }
      if (a.includes('*') || a.includes('?')) {
        if (allowWildcards) continue;
        throw new Error(`文件 operand 不接受通配符：${a}`);
      }
      const abs = await resolveP(ctx.cwd, a);
      const rel = (await relP(ctx.cwd, abs)).replace(/\\/g, '/');
      if (allowWildcards && (rel === '.' || rel === '')) {
        guarded[index] = abs;
        continue;
      }
      if (protectedPrefix) {
        if (!isPathAllowed(activePolicy, rel)
          || !(rel === protectedPrefix || rel.startsWith(`${protectedPrefix}/`))) {
          throw new Error(`脚本路径不在受控前缀内：${rel}`);
        }
      } else {
        assertPathAllowed(activePolicy, rel);
      }
      await assertNoMultipleHardlinks(abs);
      guarded[index] = abs;
    }
    return guarded;
  };

  const runSafeGitDiff = async (cmd: string[], ctx: DevContext): Promise<CommandResult> => {
    const parsed = parseWorkerCommand(cmd);
    if (!parsed.ok || (parsed.intent.kind !== 'git-names-only' && parsed.intent.kind !== 'git-diff-scoped')) {
      return { exitCode: -1, stdout: '', stderr: 'Git diff grammar rejected', durationMs: 0 };
    }
    const intent: GitDiffIntent = parsed.intent;
    try {
      const guardedPathspecs = intent.kind === 'git-diff-scoped'
        ? await guardPathArgs(intent.pathspecs, ctx, 0, undefined, false)
        : [];
      const safeArgs = buildSafeGitDiffArgs(intent, guardedPathspecs);
      return run(safeArgs[0], safeArgs.slice(1), ctx.cwd);
    } catch (error) {
      return {
        exitCode: -1,
        stdout: '',
        stderr: `Git diff path/policy rejected: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
      };
    }
  };

  return {
    env,

    async codeRead(relPath, ctx) {
      const abs = await guardedAbs(relPath, ctx);
      const content = await read(abs);
      return { content, lineCount: content.split('\n').length };
    },

    async codeMkdir(relPath, ctx) {
      const abs = await guardedDirectoryAbs(relPath, ctx);
      await makeDirectory(abs);
    },

    async codePatch(relPath, unifiedDiff, ctx) {
      const abs = await guardedAbs(relPath, ctx);
      // 新增文件：目标不存在时按空内容处理（unified diff 全 + 行创建新文件）
      let original = '';
      try {
        original = await read(abs);
      } catch (error) {
        if (!isMissingFileError(error)) {
          return { ok: false, error: `读取待修改文件失败：${error instanceof Error ? error.message : String(error)}` };
        }
      }
      const applied = applyUnifiedPatch(original, unifiedDiff);
      if (!applied.ok) return { ok: false, error: applied.error };
      await write(abs, applied.result!);
      return { ok: true, contentHash: hashContent(applied.result!) };
    },

    async shellRun(cmd, ctx) {
      await assertCwd(ctx.cwd);
      if (cmd[0] === 'git' && cmd[1] === 'diff') return runSafeGitDiff(cmd, ctx);
      const rule = findMatchingRule(DEFAULT_SHELL_RULES, cmd);
      if (cmd.length === 0 || !rule) {
        return { exitCode: -1, stdout: '', stderr: `命令不在白名单内：${cmd.join(' ') || '(空)'}`, durationMs: 0 };
      }
      try {
        assertCommandOperandGrammar(cmd);
      } catch (e) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: `命令参数不安全：${e instanceof Error ? e.message : String(e)}`,
          durationMs: 0,
        };
      }
      let fromIndex = rule.pathArgsFrom ?? (rule.pathArgs ? 0 : -1);
      if (rule.cmd === 'grep') {
        const grepArgs = cmd.slice(1);
        let options = true;
        const patternIndex = grepArgs.findIndex((argument) => {
          if (options && argument === '--') {
            options = false;
            return false;
          }
          if (options && argument.startsWith('-')) return false;
          return true;
        });
        fromIndex = patternIndex >= 0 ? patternIndex + 1 : grepArgs.length;
      }
      if (
        rule.cmd === 'git'
        && cmd.length === 3
        && cmd[1] === 'diff'
        && !isSafeGitDiffRevision(cmd[2])
      ) {
        fromIndex = 1;
      }
      let guardedArgs = cmd.slice(1);
      if (fromIndex >= 0) {
        try {
          guardedArgs = await guardPathArgs(
            guardedArgs,
            ctx,
            fromIndex,
            undefined,
            rule.cmd === 'find',
          );
        } catch (e) {
          return {
            exitCode: -1,
            stdout: '',
            stderr: `路径参数越权：${e instanceof Error ? e.message : String(e)}`,
            durationMs: 0,
          };
        }
      }
      const [c0, ...rest] = [cmd[0], ...guardedArgs];
      return run(c0, rest, ctx.cwd);
    },

    async testRun(cmd, ctx) {
      await assertCwd(ctx.cwd);
      if (cmd.length === 0 || !testAllow(cmd)) {
        return { exitCode: -1, stdout: '', stderr: `测试命令不在白名单内：${cmd.join(' ') || '(空)'}`, durationMs: 0 };
      }
      const testRule = findMatchingRule(DEFAULT_TEST_RULES, cmd);
      if (testRule?.pathArgs) {
        try {
          const guardedArgs = await guardPathArgs(
            cmd.slice(1),
            ctx,
            testRule.pathArgsFrom ?? 0,
            testRule.cmd === 'tsx' ? 'scripts' : undefined,
            false,
          );
          cmd = [cmd[0], ...guardedArgs];
        } catch (e) {
          return {
            exitCode: -1,
            stdout: '',
            stderr: `测试命令路径越权：${e instanceof Error ? e.message : String(e)}`,
            durationMs: 0,
          };
        }
      }
      const [c0, ...rest] = cmd;
      return run(c0, rest, ctx.cwd);
    },

    async gitStatus(ctx) {
      await assertCwd(ctx.cwd);
      const result = await run('git', ['status', '--porcelain'], ctx.cwd);
      return result;
    },

    async gitDiff(baseRef, ctx) {
      await assertCwd(ctx.cwd);
      const revision = baseRef ?? 'HEAD';
      const roots = safeDiffRoots(ctx.pathPolicy ?? policy);
      if (roots.length === 0) throw new Error('git diff 没有非保护路径范围');
      const rawCommand = ['git', 'diff', revision, '--', ...roots];
      const parsed = parseWorkerCommand(rawCommand);
      if (!parsed.ok || parsed.intent.kind !== 'git-diff-scoped') {
        throw new Error(`Git baseRef 非法：${revision}`);
      }
      return runSafeGitDiff(rawCommand, ctx);
    },

    async gitChangedFiles(ctx, baseRef) {
      await assertCwd(ctx.cwd);
      const revision = baseRef ?? 'HEAD';
      const rawTrackedCommand = ['git', 'diff', '--name-only', revision, '--'];
      const parsed = parseWorkerCommand(rawTrackedCommand);
      if (!parsed.ok || parsed.intent.kind !== 'git-names-only') {
        throw new Error(`Git baseRef 非法：${revision}`);
      }
      const [tracked, untracked] = await Promise.all([
        runSafeGitDiff(rawTrackedCommand, ctx),
        run('git', ['ls-files', '--others', '--exclude-standard'], ctx.cwd),
      ]);
      if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
        throw new Error(`git changed-files 失败：${tracked.stderr || untracked.stderr || 'unknown'}`);
      }
      const set = new Set<string>();
      for (const raw of [tracked.stdout, untracked.stdout]) {
        for (const f of raw.split('\n')) {
          const t = f.trim();
          if (t) set.add(t);
        }
      }
      return [...set];
    },

    async gitUntrackedFiles(ctx) {
      await assertCwd(ctx.cwd);
      const r = await run('git', ['ls-files', '--others', '--exclude-standard'], ctx.cwd);
      if (r.exitCode !== 0) throw new Error(`git untracked-files 失败：${r.stderr || r.exitCode}`);
      return r.stdout
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    },
  };
}

/**
 * Tauri GUI 版 DevCapabilityService：复用 createNodeDevService 的全部白名单/路径守卫，
 * 仅把底层命令/文件/路径操作替换为 Tauri 通道（dev_exec / dev_read_file / dev_write_file
 * 由 Rust 宿主执行，cwd 归属 + 命令名 + 路径归属均经 Rust 校验）。
 */
export function createTauriDevService(
  policy: SelfDevelopmentPolicy,
  deps: NodeDevDeps,
  registry?: WorktreeRegistry,
): DevCapabilityService {
  return createNodeDevService(policy, deps, registry, 'tauri');
}
