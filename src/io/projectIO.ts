import type { ProjectFile, WorkflowFile } from '../types';
import { isTauri, pickProjectFile, showSaveDirDialog } from '../platform/env';
import type { RunCheckpoint } from '../engine/checkpoint';

// 项目配置统一收进项目根下的隐藏目录 .slimemold/（类 Unix 约定）
export const SLIMEMOLD_DIR = '.slimemold';

const PROJECT_JSON = 'project.json';
const WORKFLOWS_DIR = 'workflows';
const RUNS_DIR = 'runs';
const HISTORY_JSON = 'history.json';
const CHECKPOINTS_JSON = 'checkpoints.json';
const LEGACY_EXT = '.smproj';

// 运行历史（可选，落盘到 .slimemold/runs/history.json；类型层宽松处理，避免与主类型耦合）
type RunHistory = { history: unknown[] };

export interface RecentProject {
  path: string; // 项目根目录（磁盘真相）
  name: string;
  openedAt: string;
}

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

function readRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentProject[]) : [];
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
  const list = readRecent().filter((x) => x.path !== r.path);
  list.unshift(r);
  writeRecent(list.slice(0, RECENT_MAX));
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
export async function saveProjectFile(file: ProjectFile, existingRoot?: string): Promise<string> {
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

    // project.json（元数据 + 引用，不再内联所有 workflow 全文；checkpoints 独立成文件避免膨胀）
    const { checkpoints, ...metaRest } = file;
    const meta: ProjectFile = { ...metaRest, workflows: {} };
    await writeTextFile(joinPath(cfg, PROJECT_JSON), JSON.stringify(meta, null, 2));

    // runs/checkpoints.json（阶段 C 可恢复执行：每工作流最新一次运行的节点级结果）
    const ckptPath = joinPath(runsDir, CHECKPOINTS_JSON);
    await writeTextFile(
      ckptPath,
      JSON.stringify({ checkpoints: checkpoints ?? {} }, null, 2),
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

/**
 * 阶段 C 独立落盘：把运行检查点单独原子写入 `.slimemold/runs/checkpoints.json`。
 * 运行收尾调用（不等项目整体保存），保证「运行结束即落盘」的跨会话断点续传闭环；
 * 不写 project.json、不触发项目脏标记。浏览器端 no-op（localStorage 已由 persist 接管）。
 */
export async function saveCheckpoints(
  root: string,
  checkpoints: Record<string, RunCheckpoint>,
): Promise<void> {
  if (!isTauri) return;
  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
  const runsDir = joinPath(root, SLIMEMOLD_DIR, RUNS_DIR);
  await mkdir(runsDir, { recursive: true });
  await writeTextFile(
    joinPath(runsDir, CHECKPOINTS_JSON),
    JSON.stringify({ checkpoints: checkpoints ?? {} }, null, 2),
  );
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

    // 阶段 C 可恢复执行：读回检查点（独立文件，缺失时保持 project.json 内的兜底）
    let checkpoints = (meta as ProjectFile).checkpoints;
    const ckptPath = joinPath(cfg, RUNS_DIR, CHECKPOINTS_JSON);
    if (await exists(ckptPath)) {
      try {
        const raw = JSON.parse(await readTextTauri(ckptPath)) as { checkpoints?: unknown };
        checkpoints = raw.checkpoints as ProjectFile['checkpoints'];
      } catch {
        /* ignore */
      }
    }

    return { ...meta, workflows, runs: runs ?? { history: [] }, checkpoints };
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
