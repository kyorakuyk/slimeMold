export type WorkerCommandIntent =
  | { kind: 'git-names-only'; revision: string }
  | { kind: 'git-diff-scoped'; revision: string; pathspecs: string[] }
  | { kind: 'grep-files'; pattern: string; files: string[] }
  | { kind: 'find'; roots: string[]; predicates: string[] }
  | { kind: 'tsx-script'; script: string; args: string[] };

export type WorkerCommandResult =
  | { ok: true; intent: WorkerCommandIntent }
  | { ok: false; error: string };

const PROTECTED_ROOTS = new Set([
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'scripts',
  'tests',
  'src/orchestrator',
  'src/plugins/sandbox',
  'src-tauri/capabilities',
]);

function isSafeRevision(value: string): boolean {
  if (value === 'HEAD') return true;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return true;
  if (/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(value)) {
    return !value.includes('..') && !value.includes('//') && !value.endsWith('/');
  }
  if (/^(?:feature|bugfix|hotfix|release|worker)\/[A-Za-z0-9._/-]+$/.test(value)) {
    const leaf = value.split('/').at(-1) ?? '';
    return !value.includes('..') && !value.includes('//') && Boolean(leaf) && !leaf.includes('.');
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(value) || /^[A-Za-z0-9]$/.test(value);
}

function isSafePathspec(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const comparable = normalized.toLowerCase();
  if (!normalized || normalized.startsWith('-') || normalized.startsWith('/') || normalized.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(normalized) || normalized.includes(':')) return false;
  if (normalized.split('/').some((part) => part === '.' || part === '..')) return false;
  if (normalized.includes('*') || normalized.includes('?')) return false;
  if (normalized === '.' || /^(?:\.\/?)+$/.test(normalized)) return false;
  return ![...PROTECTED_ROOTS].some((root) => comparable === root || comparable.startsWith(`${root}/`));
}

export function parseWorkerCommand(command: string[]): WorkerCommandResult {
  if (command.length === 4 && command[0] === 'git' && command[1] === 'diff' && command[2] === '--name-only') {
    return isSafeRevision(command[3])
      ? { ok: true, intent: { kind: 'git-names-only', revision: command[3] } }
      : { ok: false, error: 'git revision is not safe' };
  }

  if (command.length >= 5 && command[0] === 'git' && command[1] === 'diff') {
    const revision = command[2];
    const separator = command[3];
    const pathspecs = command.slice(4);
    if (separator === '--' && isSafeRevision(revision) && pathspecs.length > 0 && pathspecs.every(isSafePathspec)) {
      return { ok: true, intent: { kind: 'git-diff-scoped', revision, pathspecs } };
    }
  }

  if (command[0] === 'tsx') {
    const script = command[1] ?? '';
    if (!script.toLowerCase().startsWith('scripts/') || script.includes('..') || !isSafePathspec(script.replace(/^scripts\//i, 'src/'))) {
      return { ok: false, error: 'tsx script path is not safe' };
    }
    const args = command.slice(2);
    const safeOptions = new Set(['--reporter=dot']);
    if (args.some((argument) => (
      argument.includes('..')
      || argument.startsWith('/')
      || /^[A-Za-z]:/.test(argument)
      || argument.includes(':')
      || /[;&|`<>]/.test(argument)
      || (argument.startsWith('-') && !safeOptions.has(argument))
    ))) {
      return { ok: false, error: 'tsx argument is not safe' };
    }
    return { ok: true, intent: { kind: 'tsx-script', script, args } };
  }

  if (command[0] === 'find') {
    const forbidden = ['-L', '-H', '-follow', '-files0-from', '--files0-from', '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0'];
    const safePredicates = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-mount', '-xdev', '-prune', '-print', '-print0', '-ls', '-printf', '-regex', '-iregex', '-not', '!', '-o', '-or', '-a', '-and', '-quit']);
    if (command.some((argument) => forbidden.some((option) => argument === option || argument.startsWith(`${option}=`)))) {
      return { ok: false, error: 'find traversal mode is not safe' };
    }
    let index = 1;
    if (command[index] === '-P') index += 1;
    const roots: string[] = [];
    while (index < command.length && !command[index].startsWith('-')) {
      roots.push(command[index]);
      index += 1;
    }
    const predicates = command.slice(index);
    if (predicates.some((argument) => argument.startsWith('-') && !safePredicates.has(argument))) {
      return { ok: false, error: 'find traversal mode is not safe' };
    }
    if (roots.length > 0 && roots.every(isSafePathspec)) {
      return { ok: true, intent: { kind: 'find', roots, predicates } };
    }
    return { ok: false, error: 'find roots are not safe' };
  }

  if (command[0] === 'grep') {
    const safeOptions = new Set(['-n', '--line-number', '-i', '--ignore-case', '-F', '--fixed-strings', '-v', '--invert-match']);
    let index = 1;
    let pattern: string | undefined;
    while (index < command.length) {
      const argument = command[index];
      if (argument === '--') {
        pattern = command[index + 1];
        index += 2;
        break;
      }
      if (argument === '-e' || argument === '--regexp') {
        const value = command[index + 1];
        if (!value || value.startsWith('-')) {
          return { ok: false, error: 'grep option arguments must be explicit and safe' };
        }
        pattern = value;
        index += 2;
        break;
      }
      if (argument.startsWith('-')) {
        if (!safeOptions.has(argument)) {
          return { ok: false, error: 'grep option arguments must be explicit and safe' };
        }
        index += 1;
        continue;
      }
      pattern = argument;
      index += 1;
      break;
    }
    const files = command.slice(index);
    if (!pattern || files.length === 0 || !files.every(isSafePathspec)) {
      return { ok: false, error: 'grep file operands are not safe' };
    }
    return { ok: true, intent: { kind: 'grep-files', pattern, files } };
  }

  if (command[0] === 'git' && command[1] === 'diff') {
    return { ok: false, error: 'git diff content requires explicit non-protected pathspecs' };
  }
  return { ok: false, error: 'command is not supported' };
}
