export type WorkerCommandIntent =
  | { kind: 'git-names-only'; revision: string }
  | { kind: 'git-diff-scoped'; revision: string; pathspecs: string[] }
  | { kind: 'grep-files'; pattern: string; files: string[] }
  | { kind: 'find'; roots: string[]; predicates: string[] }
  | { kind: 'read-files'; command: 'ls' | 'cat' | 'head' | 'tail'; files: string[] }
  | { kind: 'typecheck'; command: 'tsc' | 'node'; args: string[] }
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

const WINDOWS_DEVICE_NAMES = new Set([
  'AUX', 'CLOCK$', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'CON', 'CONIN$', 'CONOUT$', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'NUL', 'PRN',
]);

function isWindowsDeviceName(component: string): boolean {
  return WINDOWS_DEVICE_NAMES.has(component.split('.')[0].toUpperCase());
}

function isSafeGitRef(value: string): boolean {
  if (!value || !/^[\x00-\x7F]*$/.test(value) || !/^[A-Za-z0-9._/-]+$/.test(value) || /[\x00-\x20~^:?*\\[\\]]/.test(value)) return false;
  if (value === '@' || value.includes('..')) return false;
  const components = value.split('/');
  return components.every((part) => (
    part.length > 0
    && part !== '.'
    && part !== '..'
    && !part.startsWith('.')
    && !part.endsWith('.')
    && !part.toLowerCase().endsWith('.lock')
  ));
}

function isSafeRevision(value: string): boolean {
  if (value === 'HEAD') return true;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return true;
  if (/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(value)) return isSafeGitRef(value);
  if (/^(?:feature|bugfix|hotfix|release|worker)\/[A-Za-z0-9._/-]+$/.test(value)) {
    const leaf = value.split('/').at(-1) ?? '';
    return isSafeGitRef(value) && Boolean(leaf) && !leaf.includes('.');
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(value) || /^[A-Za-z0-9]$/.test(value);
}

function isSafePathspec(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const comparable = normalized.toLowerCase();
  const components = normalized.split('/');
  if (!normalized || !/^[\x00-\x7F]*$/.test(normalized) || /[\x00-\x1F\x7F]/.test(normalized)) return false;
  if (normalized.startsWith('-') || normalized.startsWith('/') || normalized.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(normalized) || normalized.includes(':')) return false;
  if (normalized.includes('..')) return false;
  if (components.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part) || isWindowsDeviceName(part))) return false;
  if (normalized.includes('*') || normalized.includes('?') || normalized.includes('[') || normalized.includes(']')) return false;
  if (normalized === '.' || /^(?:\.\/?)+$/.test(normalized)) return false;
  return ![...PROTECTED_ROOTS].some((root) => (
    comparable === root
    || comparable.startsWith(`${root}/`)
    || root.startsWith(`${comparable}/`)
  ));
}

function isSafeTextToken(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1F\x7F]/.test(value);
}

const FIND_VALUE_PREDICATES = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-printf', '-regex', '-iregex']);
const FIND_ATOMIC_PREDICATES = new Set(['-mount', '-xdev', '-prune', '-print', '-print0', '-ls', '-quit']);
const FIND_UNARY_PREDICATES = new Set(['-not', '!']);
const FIND_BINARY_PREDICATES = new Set(['-o', '-or', '-a', '-and']);

function isSafeFindValue(predicate: string, value: string): boolean {
  if (!value || value.startsWith('-') || /[\x00-\x1F\x7F]/.test(value)) return false;
  if (predicate === '-maxdepth' || predicate === '-mindepth') return /^[0-9]+$/.test(value);
  if (predicate === '-type') return /^[bcdpfls]$/.test(value);
  return true;
}

function parseFindPrimary(predicates: string[], start: number): number | null {
  const predicate = predicates[start];
  if (!predicate) return null;
  if (FIND_UNARY_PREDICATES.has(predicate)) return parseFindPrimary(predicates, start + 1);
  if (FIND_ATOMIC_PREDICATES.has(predicate)) return start + 1;
  if (FIND_VALUE_PREDICATES.has(predicate) && isSafeFindValue(predicate, predicates[start + 1] ?? '')) return start + 2;
  return null;
}

function areFindPredicatesSafe(predicates: string[]): boolean {
  let index = parseFindPrimary(predicates, 0);
  if (index === null) return false;
  while (index < predicates.length) {
    if (FIND_BINARY_PREDICATES.has(predicates[index])) {
      index = parseFindPrimary(predicates, index + 1);
      if (index === null) return false;
      continue;
    }
    const next = parseFindPrimary(predicates, index);
    if (next === null) return false;
    index = next;
  }
  return true;
}

function isSafeScriptPath(script: string): boolean {
  return script.startsWith('scripts/')
    && !script.includes('..')
    && isSafePathspec(script.replace(/^scripts\//, 'src/'));
}

function parseSafeTypecheck(command: string[]): WorkerCommandIntent | null {
  if (command[0] === 'tsc' && (command.length === 2 && (command[1] === '--noEmit' || command[1] === '-b'))) {
    return { kind: 'typecheck', command: 'tsc', args: command.slice(1) };
  }
  if (command[0] === 'node' && command.length === 3 && command[1] === '--check' && isSafeScriptPath(command[2])) {
    return { kind: 'typecheck', command: 'node', args: command.slice(1) };
  }
  return null;
}

export function parseWorkerCommand(command: string[]): WorkerCommandResult {
  const typecheck = parseSafeTypecheck(command);
  if (typecheck) return { ok: true, intent: typecheck };

  if (['ls', 'cat', 'head', 'tail'].includes(command[0] as 'ls' | 'cat' | 'head' | 'tail')) {
    const files = command.slice(1);
    if (files.length > 0 && files.every(isSafePathspec)) {
      return {
        ok: true,
        intent: { kind: 'read-files', command: command[0] as 'ls' | 'cat' | 'head' | 'tail', files },
      };
    }
    return { ok: false, error: 'read command file operands are not safe' };
  }

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
    if (!isSafeScriptPath(script)) {
      return { ok: false, error: 'tsx script path is not safe' };
    }
    const args = command.slice(2);
    const safeOptions = new Set(['--reporter=dot']);
    if (args.some((argument) => !safeOptions.has(argument))) {
      return { ok: false, error: 'tsx argument is not safe' };
    }
    return { ok: true, intent: { kind: 'tsx-script', script, args } };
  }

  if (command[0] === 'find') {
    const forbidden = ['-L', '-H', '-follow', '-files0-from', '--files0-from', '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0'];
    if (command.some((argument) => forbidden.some((option) => argument === option || argument.startsWith(`${option}=`)))) {
      return { ok: false, error: 'find traversal mode is not safe' };
    }
    let index = 1;
    if (command[index] === '-P') index += 1;
    const roots: string[] = [];
    while (index < command.length && !command[index].startsWith('-') && command[index] !== '!') {
      roots.push(command[index]);
      index += 1;
    }
    const predicates = command.slice(index);
    if (!areFindPredicatesSafe(predicates)) {
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
        if (!isSafeTextToken(value) || value.startsWith('-')) {
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
    if (!isSafeTextToken(pattern) || files.length === 0 || !files.every(isSafePathspec)) {
      return { ok: false, error: 'grep file operands are not safe' };
    }
    return { ok: true, intent: { kind: 'grep-files', pattern, files } };
  }

  if (command[0] === 'git' && command[1] === 'diff') {
    return { ok: false, error: 'git diff content requires explicit non-protected pathspecs' };
  }
  return { ok: false, error: 'command is not supported' };
}
