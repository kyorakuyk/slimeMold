import type { RecentProject } from '../types/project';
export type { RecentProject } from '../types/project';
import type { AgentConfig } from '../types/agent';
import type { WorkflowFile } from '../types/workflow';
import type { ProjectFile } from '../types/projectFile';
import { isTauri, pickProjectFile, showSaveDirDialog } from '../platform/env';
import type { RunCheckpoint } from '../engine/checkpoint';

// 项目配置统一收进项目根下的隐藏目录 .slimemold/（类 Unix 约定）
export const SLIMEMOLD_DIR = '.slimemold';

const PROJECT_JSON = 'project.json';
const WORKFLOWS_DIR = 'workflows';
const RUNS_DIR = 'runs';
const HISTORY_JSON = 'history.json';

const projectWriteLocks = new Map<string, Promise<void>>();

function projectLockKey(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

async function withProjectWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = projectLockKey(root);
  const previous = projectWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  projectWriteLocks.set(key, current);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (projectWriteLocks.get(key) === current) projectWriteLocks.delete(key);
  }
}
const CHECKPOINTS_JSON = 'checkpoints.json';
const LEGACY_EXT = '.smproj';

// 运行历史（可选，落盘到 .slimemold/runs/history.json；类型层宽松处理，避免与主类型耦合）
type RunHistory = { history: unknown[] };



const RECENT_KEY = 'sm.recentProjects';
const RECENT_MAX = 12;

// ---------- 路径工具 ----------

/** 给定任意路径，解析出项目根目录（即 .slimemold 的父目录，或路径本身）。 */
export function projectRootFromPath(path: string): string {
  if (!path) return path;
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segs = norm.split('/');
  const last = segs[segs.length - 1];
  const secondLast = segs[segs.length - 2];
  const thirdLast = segs[segs.length - 3];
  if (last === SLIMEMOLD_DIR) return segs.slice(0, -1).join('/');
  if (last === PROJECT_JSON && secondLast === SLIMEMOLD_DIR)
    return segs.slice(0, -2).join('/');
  if (last === HISTORY_JSON && secondLast === RUNS_DIR && thirdLast === SLIMEMOLD_DIR)
    return segs.slice(0, -3).join('/');
  return norm;
}

function joinPath(root: string, ...parts: string[]): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return [base, ...parts.map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))]
    .filter(Boolean)
    .join('/');
}

// ---------- 最近项目记录（localStorage 缓存） ----------

/** 最近项目统一保存为项目根目录 + 正斜杠，避免 Windows 分隔符制造重复记录。 */
function normalizeRecentPath(path: string): string {
  return projectRootFromPath(path).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Windows 驱动器/UNC 路径大小写不敏感，其它平台保留大小写语义。 */
function recentPathKey(path: string): string {
  const normalized = normalizeRecentPath(path);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function readRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    let changed = false;
    const list: RecentProject[] = [];
    for (const rawItem of parsed) {
      if (typeof rawItem !== 'object' || rawItem === null) {
        changed = true;
        continue;
      }
      const item = rawItem as Partial<RecentProject>;
      if (typeof item.path !== 'string' || !item.path) {
        changed = true;
        continue;
      }
      const entry: RecentProject = {
        name: typeof item.name === 'string' && item.name ? item.name : item.path,
        path: normalizeRecentPath(item.path),
        openedAt: typeof item.openedAt === 'string' ? item.openedAt : '',
      };
      if (list.some((existing) => recentPathKey(existing.path) === recentPathKey(entry.path))) {
        changed = true;
        continue;
      }
      if (
        entry.name !== item.name ||
        entry.path !== item.path ||
        entry.openedAt !== item.openedAt
      ) {
        changed = true;
      }
      list.push(entry);
    }

    const limited = list.slice(0, RECENT_MAX);
    if (changed || limited.length !== list.length) writeRecent(limited);
    return limited;
  } catch {
    return [];
  }
}
function writeRecent(list: RecentProject[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function getRecentProjects(): RecentProject[] {
  return readRecent();
}
export function pushRecentProject(r: RecentProject) {
  const entry = { ...r, path: normalizeRecentPath(r.path) };
  const key = recentPathKey(entry.path);
  const list = readRecent().filter((x) => recentPathKey(x.path) !== key);
  list.unshift(entry);
  writeRecent(list.slice(0, RECENT_MAX));
}
export function removeRecentProject(path: string) {
  const key = recentPathKey(path);
  const list = readRecent();
  const next = list.filter((x) => recentPathKey(x.path) !== key);
  if (next.length !== list.length) writeRecent(next);
}
export function clearRecentProjects() {
  writeRecent([]);
}

// ---------- 会话恢复：记住上次打开的项目与激活工作流 ----------

const SESSION_KEY = 'sm.lastSession';

export interface LastSession {
  /** 项目根目录（磁盘真相） */
  path: string;
  /** 上次激活的工作流 id */
  activeId?: string;
}

export function saveLastSession(s: LastSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function getLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as LastSession;
    return s && s.path ? s : null;
  } catch {
    return null;
  }
}

export function clearLastSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- 写入：目录式 .slimemold/ ----------

/**
 * 保存项目到磁盘。
 * @param file 待保存的 ProjectFile（已含 workflows 与 runs）
 * @param existingRoot 已知项目根目录（首次保存为 undefined，会弹目录选择）
 * @returns 实际写入的项目根目录
 */
async function saveProjectFileUnlocked(file: ProjectFile, existingRoot?: string): Promise<string> {
  let root = existingRoot;
  if (!root) {
    if (isTauri) {
      const picked = await showSaveDirDialog(file.name);
      if (!picked) throw new Error('已取消保存');
      root = picked;
    } else {
      // 浏览器端：仅存草稿到 localStorage
      try {
        localStorage.setItem('sm.project', JSON.stringify({ ...file, _root: file.name }));
      } catch {
        /* ignore */
      }
      return file.name;
    }
  }

  const cfg = joinPath(root, SLIMEMOLD_DIR);
  const wfDir = joinPath(cfg, WORKFLOWS_DIR);
  const runsDir = joinPath(cfg, RUNS_DIR);

  if (isTauri) {
    const { mkdir, writeTextFile, exists } = await import('@tauri-apps/plugin-fs');
    await mkdir(cfg, { recursive: true });
    await mkdir(wfDir, { recursive: true });
    await mkdir(runsDir, { recursive: true });

    // project.json（元数据 + 引用，不再内联所有 workflow 全文；checkpoints/history 独立成文件避免膨胀）
    const { checkpoints, checkpointHistory, ...metaRest } = file;
    const meta: ProjectFile = { ...metaRest, workflows: {}, agents: undefined, defaultAgentId: undefined };
    await writeTextFile(joinPath(cfg, PROJECT_JSON), JSON.stringify(meta, null, 2));

    // agents.json：项目级智能体独立存储（2026-08-10 起从「随单个工作流」提升为项目级），
    // 与 project.json 同级，保证切换/重开工作流不丢失 agents；与工作流文件解耦，便于跨项目导入共享。
    const agentsData: {
      version: 1;
      agents: AgentConfig[];
      defaultAgentId: string | null;
      agentRouteTable?: import('../types/dispatch').AgentRouteTable;
    } = {
      version: 1,
      agents: file.agents ?? [],
      defaultAgentId: file.defaultAgentId ?? null,
      agentRouteTable: file.agentRouteTable,
    };
    await writeTextFile(joinPath(cfg, 'agents.json'), JSON.stringify(agentsData, null, 2));

    // runs/checkpoints.json（阶段 C/G2 可恢复执行：每工作流最新检查点 + 多版本历史）
    const ckptPath = joinPath(runsDir, CHECKPOINTS_JSON);
    await writeTextFile(
      ckptPath,
      JSON.stringify({ checkpoints: checkpoints ?? {}, checkpointHistory: checkpointHistory ?? {} }, null, 2),
    );

    // 每个工作流一个文件
    for (const [id, wf] of Object.entries(file.workflows ?? {})) {
      await writeTextFile(joinPath(wfDir, `${id}.json`), JSON.stringify(wf, null, 2));
    }

    // runs/history.json（若本次 ProjectFile 附带 runs 历史则写入，否则保留已有）
    const histPath = joinPath(runsDir, HISTORY_JSON);
    const runs = (file as ProjectFile & { runs?: RunHistory }).runs;
    if (runs && runs.history && runs.history.length) {
      await writeTextFile(histPath, JSON.stringify(runs, null, 2));
    } else if (!(await exists(histPath))) {
      await writeTextFile(histPath, JSON.stringify({ history: [] }, null, 2));
    }
  } else {
    try {
      localStorage.setItem('sm.project', JSON.stringify({ ...file, _root: root }));
    } catch {
      /* ignore */
    }
  }

  return root;
}

export async function saveProjectFile(file: ProjectFile, existingRoot?: string): Promise<string> {
  return withProjectWriteLock(existingRoot ?? `new:${file.name}`, () => saveProjectFileUnlocked(file, existingRoot));
}

/**
 * 阶段 C 独立落盘：把运行检查点原子写入 `.slimemold/runs/checkpoints.json`。
 * F9：先写 `checkpoints.json.tmp`，再 rename 覆盖目标文件——避免写入中途崩溃留下
 * 不完整 JSON（直接 writeTextFile 覆盖不具备原子性）。
 *
 * 回退策略（2026-08 加固，应对 Windows 目标被短暂锁定的场景）：
 * - rename 失败（目标可能被杀毒/句柄占用）→ 先 remove 旧目标再重试 rename，
 *   尽量保持「整文件替换」语义（比直接 truncate+write 的非原子写更接近原子）；
 * - 仍失败 → **保留 tmp 文件**（不删除、不静默退化到非原子直接写），
 *   抛出错误由调用方（persistCheckpoint）记录告警；下次运行会重新写 tmp 覆盖。
 *
 * Windows 覆盖语义依据：tauri-plugin-fs `rename()` 文档明确
 * "If newpath already exists and is not a directory, rename() replaces it"，
 * 底层 Rust `std::fs::rename` 在 Windows 用 MoveFileExW + MOVEFILE_REPLACE_EXISTING；
 * 行为已由 src-tauri 集成测试（fs_atomic_replace）在真实文件系统验证。
 * 浏览器端 no-op（localStorage 已由 persist 接管）。
 */
async function saveCheckpointsUnlocked(
  root: string,
  checkpoints: Record<string, RunCheckpoint>,
  checkpointHistory?: Record<string, RunCheckpoint[]>,
): Promise<void> {
  if (!isTauri) return;
  const { mkdir, writeTextFile, rename, remove } = await import('@tauri-apps/plugin-fs');
  const runsDir = joinPath(root, SLIMEMOLD_DIR, RUNS_DIR);
  await mkdir(runsDir, { recursive: true });
  const finalPath = joinPath(runsDir, CHECKPOINTS_JSON);
  const tmpPath = joinPath(runsDir, `${CHECKPOINTS_JSON}.tmp`);
  const content = JSON.stringify(
    { checkpoints: checkpoints ?? {}, checkpointHistory: checkpointHistory ?? {} },
    null,
    2,
  );
  try {
    await writeTextFile(tmpPath, content);
    await rename(tmpPath, finalPath); // rename 覆盖已有目标 = 原子替换
    return;
  } catch {
    // 第一次 rename 失败：尝试先移除旧目标再 rename（处理目标被短暂占用的边界）
    try {
      await remove(finalPath);
      await rename(tmpPath, finalPath);
      return;
    } catch (e2) {
      // 仍失败：保留 tmp（内容完整，供下次覆盖），抛出让调用方记录告警，
      // 不静默退化为非原子的直接覆盖写。
      throw e2 instanceof Error ? e2 : new Error(String(e2));
    }
  }
}

export async function saveCheckpoints(
  root: string,
  checkpoints: Record<string, RunCheckpoint>,
  checkpointHistory?: Record<string, RunCheckpoint[]>,
): Promise<void> {
  return withProjectWriteLock(root, () => saveCheckpointsUnlocked(root, checkpoints, checkpointHistory));
}

// ---------- 读取 ----------

async function readTextTauri(path: string): Promise<string> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  return await readTextFile(path);
}

/** 从 .slimemold 目录结构组装 ProjectFile。 */
async function loadFromDir(root: string): Promise<ProjectFile | null> {
  const cfg = joinPath(root, SLIMEMOLD_DIR);
  const projectJsonPath = joinPath(cfg, PROJECT_JSON);
  if (isTauri) {
    const { exists, readDir } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(projectJsonPath))) return null;
    const text = await readTextTauri(projectJsonPath);
    const meta = JSON.parse(text) as ProjectFile;

    const workflows: Record<string, WorkflowFile> = {};
    const wfDir = joinPath(cfg, WORKFLOWS_DIR);
    if (await exists(wfDir)) {
      const entries = await readDir(wfDir);
      for (const e of entries) {
        if (e.isFile && e.name.endsWith('.json')) {
          const wfText = await readTextTauri(joinPath(wfDir, e.name));
          const wf = JSON.parse(wfText) as WorkflowFile;
          const id = e.name.replace(/\.json$/, '');
          workflows[id] = { ...wf };
        }
      }
    }

    let runs = (meta as ProjectFile & { runs?: RunHistory }).runs;
    const histPath = joinPath(cfg, RUNS_DIR, HISTORY_JSON);
    if (await exists(histPath)) {
      try {
        runs = JSON.parse(await readTextTauri(histPath));
      } catch {
        /* ignore */
      }
    }

    // 阶段 C/G2 可恢复执行：读回检查点 + 多版本历史（独立文件，缺失时保持 project.json 内的兜底）
    let checkpoints = (meta as ProjectFile).checkpoints;
    let checkpointHistory = (meta as ProjectFile).checkpointHistory;
    const ckptPath = joinPath(cfg, RUNS_DIR, CHECKPOINTS_JSON);
    if (await exists(ckptPath)) {
      try {
        const raw = JSON.parse(await readTextTauri(ckptPath)) as {
          checkpoints?: unknown;
          checkpointHistory?: unknown;
        };
        checkpoints = raw.checkpoints as ProjectFile['checkpoints'];
        checkpointHistory = raw.checkpointHistory as ProjectFile['checkpointHistory'];
      } catch {
        /* ignore */
      }
    }

    // 项目级 agents：优先读 .slimemold/Agents/agents.json（2026-08-10 起）。
    // 兼容：旧版本 agents 内联在 project.json（meta.agents）或各工作流 wf.agents，
    // 缺失 agents.json 时回退 meta.agents。
    let agents = (meta as ProjectFile).agents;
    const agentsPath = joinPath(cfg, 'agents.json');
    if (await exists(agentsPath)) {
      try {
        const raw = JSON.parse(await readTextTauri(agentsPath)) as {
          agents?: AgentConfig[];
          defaultAgentId?: string | null;
          agentRouteTable?: import('../types/dispatch').AgentRouteTable;
        };
        if (Array.isArray(raw.agents)) {
          agents = raw.agents;
          meta.defaultAgentId = raw.defaultAgentId ?? meta.defaultAgentId;
          meta.agentRouteTable = raw.agentRouteTable ?? meta.agentRouteTable;
        }
      } catch {
        /* 损坏则回退 meta.agents */
      }
    }

    return { ...meta, workflows, runs: runs ?? { history: [] }, checkpoints, checkpointHistory, agents };
  }
  return null;
}

/** 兼容旧版单文件 .smproj。 */
async function loadFromLegacy(path: string): Promise<ProjectFile | null> {
  let text: string;
  if (isTauri) {
    text = await readTextTauri(path);
  } else {
    const raw = localStorage.getItem('sm.project');
    if (!raw) return null;
    text = raw;
  }
  const data = JSON.parse(text) as ProjectFile;
  if (data.kind !== 'project') return null;
  return data;
}

/**
 * 打开项目文件对话框。支持：
 *  - 旧版单文件 *.smproj
 *  - 新版目录（选 .slimemold 目录、其内 project.json、或项目根目录）
 * 返回带 `path`（项目根）的 ProjectFile。
 */
export async function openProjectFile(): Promise<(ProjectFile & { path: string }) | null> {
  if (isTauri) {
    const picked = await pickProjectFile();
    if (!picked) return null;
    return await openProjectByPath(picked);
  }
  const raw = localStorage.getItem('sm.project');
  if (!raw) return null;
  const data = JSON.parse(raw) as ProjectFile;
  return { ...data, path: data.name };
}

/**
 * 按路径（项目根或 .slimemold 内任意文件）打开项目。
 * F6：统一在入口先授权（grant_project_access 动态注入 fs:scope）再读盘——
 * 保证所有调用方（最近项目 / 欢迎页 / 会话恢复）在非默认目录时都能读到项目文件，
 * 而非「先读盘成功、事后异步授权」的竞态。
 */
export async function openProjectByPath(path: string): Promise<(ProjectFile & { path: string }) | null> {
  const root = projectRootFromPath(path);
  if (isTauri && root) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('grant_project_access', { path: root }).catch(() => {});
    } catch {
      /* 授权失败不阻塞读盘（可能已在 scope 内） */
    }
  }
  const dirFile = await loadFromDir(root);
  if (dirFile) return { ...dirFile, path: root };

  if (path.toLowerCase().endsWith(LEGACY_EXT) || root.toLowerCase().endsWith(LEGACY_EXT)) {
    const legacyPath = path.toLowerCase().endsWith(LEGACY_EXT) ? path : root;
    const legacy = await loadFromLegacy(legacyPath);
    if (legacy) return { ...legacy, path: legacyPath, legacy: true };
  }
  return null;
}
