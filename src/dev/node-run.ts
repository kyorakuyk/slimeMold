/**
 * H4 Node 执行层：仅 headless/CI（Node/tsx/vitest）环境可用的真实命令与文件操作。
 *
 * - 静态 import node:child_process（vite 构建经 shim 指向 src/dev/shims/node-child-process.ts，
 *   浏览器运行时调用会抛错）；
 * - fs 操作用动态 import('node:fs/promises')：vite 对 node: 前缀 externalize（浏览器构建成功，
 *   但运行时调用会 reject，由调用方捕获并返回明确错误）。
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { pathComparisonKey } from './path-utils';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Host-side spawn/capture/cleanup failed after the command may have started. */
  unknownEffects?: boolean;
}

/** 常见凭据/密钥环境变量名（执行子命令时剥离，防止开发节点读取宿主凭据）。 */
const CREDENTIAL_KEYS = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY_1', 'AZURE_OPENAI_API_KEY_2',
  'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'REPLICATE_API_TOKEN',
]);
const CREDENTIAL_NAME_PATTERN = /(?:^|_)(?:API[_-]?KEY|APIKEY|TOKEN|PAT|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|PRIVATE[_-]?KEY|ACCESS[_-]?KEY(?:_ID)?|CLIENT[_-]?SECRET|APPLICATION[_-]?CREDENTIALS?|CREDENTIALS?|AUTH(?:ORIZATION)?|SIGNING[_-]?KEY|ENCRYPTION[_-]?KEY|MASTER[_-]?KEY|CERT(?:IFICATE)?|KEY|COOKIE|BEARER|CONNECTION[_-]?STRING|DATABASE[_-]?URL|DB[_-]?URL|DSN|USERCONFIG|DOCKER_CONFIG|SESSION)$/i;
const SAFE_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'LC_MESSAGES', 'TERM', 'COLORTERM', 'CI', 'FORCE_COLOR', 'NODE_ENV',
]);

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toUpperCase()) || CREDENTIAL_NAME_PATTERN.test(key);
}

/**
 * 生成最小执行环境：只保留命令解析/临时目录/locale 等必要变量，再剥离 credential family。
 * 开发节点执行命令不继承任意宿主配置（包括 npm config/连接字符串/代码注入变量）。
 */
export function sanitizeEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!SAFE_ENV_KEYS.has(k.toUpperCase()) || isCredentialKey(k)) continue;
    out[k] = v;
  }
  const tempRoot = (out.TEMP ?? out.TMP ?? 'slimemold-worker-temp').replace(/[\\/]+$/, '');
  const isolatedHome = `${tempRoot}/slimemold-worker-home`;
  out.HOME = isolatedHome;
  out.USERPROFILE = isolatedHome;
  out.APPDATA = `${isolatedHome}/appdata`;
  out.LOCALAPPDATA = `${isolatedHome}/localappdata`;
  out.NPM_CONFIG_USERCONFIG = `${isolatedHome}/npmrc`;
  out.NPM_CONFIG_GLOBALCONFIG = `${isolatedHome}/global-npmrc`;
  out.NPM_CONFIG_CACHE = `${isolatedHome}/npm-cache`;
  out.GIT_TERMINAL_PROMPT = '0'; // git 不弹凭据交互
  out.GIT_CONFIG_NOSYSTEM = '1'; // 不读系统级 git 配置
  return out;
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function trustedWindowsPath(candidate: string): string | null {
  if (!isAbsoluteWindowsPath(candidate) || !existsSync(candidate)) return null;
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return null;
    const real = realpathSync(candidate);
    if (pathComparisonKey(real) !== pathComparisonKey(candidate)) return null;
    return real;
  } catch {
    return null;
  }
}

function trustedComSpec(): string {
  if (!process.env.SystemRoot) throw new Error('未找到可信的 Windows SystemRoot');
  const expected = trustedWindowsPath(`${process.env.SystemRoot}\\System32\\cmd.exe`);
  if (!expected || !/\\cmd\.exe$/i.test(expected)) {
    throw new Error('未找到可信的 Windows ComSpec');
  }
  const configured = process.env.ComSpec;
  if (configured) {
    const trustedConfigured = trustedWindowsPath(configured);
    if (trustedConfigured && pathComparisonKey(trustedConfigured) !== pathComparisonKey(expected)) {
      throw new Error('ComSpec 不匹配 SystemRoot\\System32\\cmd.exe');
    }
  }
  return expected;
}

function resolveCommandShim(cmd: string): string {
  if (process.platform !== 'win32' || /[\\/]/.test(cmd) || /\.(?:cmd|bat|exe|com)$/i.test(cmd)) return cmd;
  const pathValue = process.env.PATH ?? '';
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of pathValue.split(';').filter(Boolean)) {
    const base = dir.replace(/[\\/]+$/, '');
    for (const extension of extensions) {
      const candidate = `${base}\\${cmd}${extension}`;
      const trusted = trustedWindowsPath(candidate);
      if (trusted) return trusted;
    }
  }
  return cmd;
}

function isWindowsShim(path: string): boolean {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(path);
}

function assertSafeWindowsShimArgs(args: readonly string[]): void {
  const forbidden = new Set(['%', '!', '&', '|', '<', '>', '^', '"']);
  for (const value of args) {
    if ([...value].some((char) => char.charCodeAt(0) === 10 || char.charCodeAt(0) === 13 || forbidden.has(char))) {
      throw new Error('Windows shim 参数包含禁止的 shell 元字符');
    }
  }
}

function quoteWindowsShimArg(value: string): string {
  return `"${value}"`;
}

/** 执行命令并捕获退出码/stdout/stderr（timeout 用 ms；非零退出码不抛错，返回结构）。 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const start = Date.now();
    const executable = resolveCommandShim(cmd);
    const trustedExecutable = process.platform === 'win32'
      ? trustedWindowsPath(executable)
      : executable;
    if (!trustedExecutable) {
      resolveResult({
        exitCode: -1,
        stdout: '',
        stderr: `拒绝执行未绑定的 Windows 程序：${executable}`,
        durationMs: Date.now() - start,
      });
      return;
    }
    const shim = isWindowsShim(trustedExecutable);
    if (shim) assertSafeWindowsShimArgs([trustedExecutable, ...args]);
    const command = shim ? trustedComSpec() : trustedExecutable;
    const commandArgs = shim
      ? ['/d', '/s', '/c', `"${[trustedExecutable, ...args].map(quoteWindowsShimArg).join(' ')}"`]
      : args;
    execFile(
      command,
      commandArgs,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: sanitizeEnv(),
        windowsVerbatimArguments: shim,
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        if (!err) {
          resolveResult({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', durationMs });
          return;
        }
        // execFile 错误可能带 code（数字退出码 / ENOENT 等字符串）
        const rawCode = (err as { code?: unknown }).code;
        const code = typeof rawCode === 'number' ? rawCode : 1;
        const spawnFailed = rawCode === 'ENOENT' || rawCode === 'EACCES' || rawCode === 'EPERM';
        resolveResult({
          exitCode: code,
          stdout: (stdout ?? '') as string,
          stderr: ((stderr ?? '') as string) || String(err.message ?? err),
          durationMs,
          unknownEffects: !spawnFailed && typeof rawCode !== 'number',
        });
      },
    );
  });
}

export async function assertNoMultipleHardlinks(absPath: string): Promise<void> {
  const { stat } = await import('node:fs/promises');
  try {
    const info = await stat(absPath);
    if (info.isFile() && info.nlink > 1) {
      throw new Error(`拒绝操作 hardlink 文件：${absPath}`);
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

/** 读取文本文件（动态 import，仅 Node 环境可用）。 */
export async function readTextFile(absPath: string): Promise<string> {
    await assertNoMultipleHardlinks(absPath);
    const { readFile } = await import('node:fs/promises');
    return readFile(absPath, 'utf8');
}

/** 写入文本文件（动态 import，仅 Node 环境可用）。 */
export async function writeTextFile(absPath: string, content: string): Promise<void> {
    await assertNoMultipleHardlinks(absPath);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(absPath, content, 'utf8');
}

/** 解析相对路径到绝对路径（防 ../ 逃逸：结果必须仍以 root 为前缀；仅 Node 环境可用）。 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  const { resolve, dirname, basename, join } = await import('node:path');
  const { realpath, lstat } = await import('node:fs/promises');
  if (process.platform === 'win32' && relPath.includes(':')) {
    throw new Error(`拒绝 Windows ADS/stream 路径：${relPath}`);
  }
  const abs = resolve(root, relPath);
  const rootNorm = resolve(root);
  const absKey = pathComparisonKey(abs);
  const rootKey = pathComparisonKey(rootNorm);
  if (absKey !== rootKey && !absKey.startsWith(rootKey + '/')) {
    throw new Error(`路径逃逸拒绝：${relPath}（root=${rootNorm}）`);
  }
  let realAbs: string;
  try {
    realAbs = await realpath(abs);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    const entry = await lstat(abs).catch((lstatError: unknown) => {
      if (typeof lstatError === 'object' && lstatError !== null && 'code' in lstatError && lstatError.code === 'ENOENT') return null;
      throw lstatError;
    });
    if (entry?.isSymbolicLink()) {
      throw new Error(`拒绝解析 broken symlink：${relPath}`);
    }
    const realParent = await realpath(dirname(abs));
    realAbs = join(realParent, basename(abs));
  }
  const realRoot = await realpath(rootNorm);
  const realAbsKey = pathComparisonKey(realAbs);
  const realRootKey = pathComparisonKey(realRoot);
  if (realAbsKey !== realRootKey && !realAbsKey.startsWith(realRootKey + '/')) {
    throw new Error(`真实路径逃逸拒绝：${relPath}（root=${realRoot}）`);
  }
  return realAbs;
}

/** 计算绝对路径相对于 root 的规范化相对路径（POSIX 分隔符，无 .. 段）。 */
export async function relativePath(root: string, abs: string): Promise<string> {
  const { relative } = await import('node:path');
  return relative(root, abs).replace(/\\/g, '/');
}
