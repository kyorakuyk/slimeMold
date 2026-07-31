import { isTauri } from '../platform/env';
import type { ProjectFile, RecentProject } from '../types';

const RECENT_KEY = 'sm-recent-projects';
const PROJECTS_KEY = 'sm-projects'; // 浏览器退化：项目集合
const RECENT_MAX = 10;

/* ---------------- 最近项目（localStorage 持久化） ---------------- */

export function getRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RecentProject[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function pushRecentProject(p: RecentProject) {
  const list = getRecentProjects().filter((r) => r.path !== p.path);
  list.unshift(p);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

export function clearRecentProjects() {
  localStorage.removeItem(RECENT_KEY);
}

/* ---------------- 新建项目 ---------------- */

export function createProjectFile(name: string): ProjectFile {
  const now = new Date().toISOString();
  const activeId = `wf-${Date.now()}`;
  return {
    version: 1,
    kind: 'project',
    name,
    createdAt: now,
    updatedAt: now,
    activeId,
    workflows: {
      [activeId]: {
        version: 1,
        name: '未命名工作流',
        savedAt: now,
        nodes: [],
        edges: [],
        agents: [],
        roles: [],
        variables: {},
      },
    },
    roles: [],
    variables: {},
  };
}

/* ---------------- 保存项目 ---------------- */

export async function saveProjectFile(file: ProjectFile): Promise<string> {
  file.updatedAt = new Date().toISOString();
  const text = JSON.stringify(file, null, 2);

  if (isTauri) {
    // 动态引入 Tauri 插件（避免浏览器侧打包报错）
    const [{ save }, { writeTextFile }, { BaseDirectory }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/api/path'),
    ]);
    const path = await save({
      defaultPath: `${file.name}.smproj`,
      filters: [{ name: 'SlimeMold Project', extensions: ['smproj'] }],
    });
    if (!path) return file.name; // 用户取消
    await writeTextFile(path, text);
    return path;
  }

  // 浏览器退化：用项目 name 作为 key 存入 localStorage
  const map = readBrowserProjects();
  map[file.name] = file;
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(map));
  return file.name;
}

/* ---------------- 打开项目 ---------------- */

export async function openProjectFile(): Promise<ProjectFile | null> {
  if (isTauri) {
    const [{ open }, { readTextFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await open({
      multiple: false,
      filters: [{ name: 'SlimeMold Project', extensions: ['smproj'] }],
    });
    if (typeof path !== 'string') return null;
    const text = await readTextFile(path);
    const file = JSON.parse(text) as ProjectFile;
    if (file.kind !== 'project') throw new Error('不是有效的项目文件');
    return file;
  }

  // 浏览器退化：列出已存项目让用户选择
  const map = readBrowserProjects();
  const names = Object.keys(map);
  if (names.length === 0) {
    alert('浏览器模式下暂无已保存的项目。请先新建并保存项目。');
    return null;
  }
  const name = window.prompt(`输入要打开的项目名（可选：${names.join('、')}）`, names[0]);
  if (!name) return null;
  return map[name] ?? null;
}

export async function openProjectByPath(path: string): Promise<ProjectFile | null> {
  if (isTauri) {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const text = await readTextFile(path);
    const file = JSON.parse(text) as ProjectFile;
    if (file.kind !== 'project') throw new Error('不是有效的项目文件');
    return file;
  }
  const map = readBrowserProjects();
  return map[path] ?? null;
}

/* ---------------- 浏览器退化辅助 ---------------- */

function readBrowserProjects(): Record<string, ProjectFile> {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ProjectFile>) : {};
  } catch {
    return {};
  }
}
