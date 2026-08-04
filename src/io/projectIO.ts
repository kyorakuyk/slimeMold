import type { ProjectFile, WorkflowFile } from '../types';
import { isTauri, pickProjectFile, showSaveDirDialog } from '../platform/env';

// 项目配置统一收进项目根下的隐藏目录 .slimemold/（类 Unix 约定）
export const SLIMEMOLD_DIR = '.slimemold';

const PROJECT_JSON = 'project.json';
const WORKFLOWS_DIR = 'workflows';
const RUNS_DIR = 'runs';
const HISTORY_JSON = 'history.json';
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

    // project.json（元数据 + 引用，不再内联所有 workflow 全文）
    const meta: ProjectFile = { ...file, workflows: {} };
    await writeTextFile(joinPath(cfg, PROJECT_JSON), JSON.stringify(meta, null, 2));

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

    return { ...meta, workflows, runs: runs ?? { history: [] } };
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

/** 按路径（项目根或 .slimemold 内任意文件）打开项目。 */
export async function openProjectByPath(path: string): Promise<(ProjectFile & { path: string }) | null> {
  const root = projectRootFromPath(path);
  const dirFile = await loadFromDir(root);
  if (dirFile) return { ...dirFile, path: root };

  if (path.toLowerCase().endsWith(LEGACY_EXT) || root.toLowerCase().endsWith(LEGACY_EXT)) {
    const legacyPath = path.toLowerCase().endsWith(LEGACY_EXT) ? path : root;
    const legacy = await loadFromLegacy(legacyPath);
    if (legacy) return { ...legacy, path: legacyPath, legacy: true };
  }
  return null;
}
