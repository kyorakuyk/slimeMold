/**
 * 运行环境适配层：
 * - Tauri 桌面端：HTTP 走 plugin-http（Rust 侧转发，规避 CORS 且不暴露密钥于渲染层网络栈）
 * - 浏览器预览：退化为 window.fetch（用于开发调试，本地 Ollama 等同源可用场景）
 */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 平台层轻量日志：直接走 console，不反向依赖 store（避免 env→store 循环）。
 * 用于降级/权限外的非致命提示；需要进 TerminalLog 面板的日志请走
 * useWorkflowStore.getState().addLog。
 */
function log(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[env] ${message}`);
  else if (level === 'warn') console.warn(`[env] ${message}`);
  else console.info(`[env] ${message}`);
}

export async function httpFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (isTauri) {
    const mod = await import('@tauri-apps/plugin-http');
    return mod.fetch(url, init);
  }
  return window.fetch(url, init);
}

/** 简易本地 KV 存储（插件 ctx.storage 底层实现） */
export function scopedStorage(scope: string) {
  const prefix = `sm:${scope}:`;
  return {
    async get(key: string): Promise<string | null> {
      return localStorage.getItem(prefix + key);
    },
    async set(key: string, value: string): Promise<void> {
      localStorage.setItem(prefix + key, value);
    },
  };
}

/** 浏览器副本下载：把文本通过 a 标签下载到本机 */
export function downloadBlob(name: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 选择文件夹对话框（Tauri 桌面端）。浏览器环境返回 null。
 * 使用 Tauri v2 官方 @tauri-apps/plugin-dialog（不依赖 __TAURI__ 全局对象）。
 */
export async function openDirDialog(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择工作区文件夹',
    });
    return Array.isArray(selected) ? selected[0] ?? null : selected;
  } catch {
    return null;
  }
}

/**
 * 游离工作流的默认存放位置：未指定时使用。
 * Tauri 下落到「文档/SlimeMold/未归类/」，浏览器退化为固定逻辑名。
 */
export async function defaultStandaloneDir(): Promise<string> {
  if (isTauri) {
    try {
      const { documentDir } = await import('@tauri-apps/api/path');
      const docs = await documentDir();
      return `${docs}/SlimeMold/未归类`.replace(/\\/g, '/');
    } catch {
      return 'SlimeMold/未归类';
    }
  }
  return 'SlimeMold/未归类';
}

/**
 * 打开项目：优先让用户选择项目根目录 / .slimemold 目录（新形态）；
 * 若取消，再退回到选择旧版 .smproj 单文件。
 * 返回项目根或 .smproj 路径；取消返回 null。
 */
export async function pickProjectFile(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({
      directory: true,
      multiple: false,
      title: '选择项目文件夹（含 .slimemold 的目录）',
    });
    if (dir) {
      return Array.isArray(dir) ? dir[0] ?? null : dir;
    }
    // 退回旧版单文件
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: 'SlimeMold 项目', extensions: ['smproj'] }],
      title: '打开旧版项目文件 (.smproj)',
    });
    return Array.isArray(file) ? file[0] ?? null : file;
  } catch {
    return null;
  }
}

/**
 * 新建项目时选择保存位置：选一个目录作为项目根。
 * Tauri 下可创建目录；浏览器返回 null（走 localStorage 草稿）。
 * 使用 Tauri v2 官方 @tauri-apps/plugin-dialog（不依赖 __TAURI__ 全局对象）。
 */
export async function showSaveDirDialog(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      defaultPath: defaultName,
      title: '选择项目保存位置',
    });
    return Array.isArray(selected) ? selected[0] ?? null : selected;
  } catch {
    return null;
  }
}

/* ----------------------------- 项目级文件读写（#8 记忆/技能落盘） ----------------------------- */

/** 把相对路径按 / 规范化（兼容 Windows 反斜杠） */
export function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 计算项目内绝对路径（Tauri 下 root 为磁盘根）；浏览器返回 null（无磁盘路径） */
export function projectFilePath(root: string | null, rel: string): string | null {
  if (!root) return null;
  return `${root.replace(/[/\\]$/, '')}/${normalizeRelPath(rel)}`;
}

/**
 * 写项目内文本文件。
 * - Tauri：root 为磁盘根，自动建父目录后 writeTextFile（动态 import plugin-fs，避免非桌面环境硬依赖）。
 * - 浏览器：退化为 localStorage（key = sm:proj:<rel>），并存一份用 downloadBlob 触发下载，方便用户留存。
 * 失败（如 Tauri fs 权限不足）抛出，由调用方决定降级策略。
 */
export async function writeProjectText(
  root: string | null | undefined,
  rel: string,
  text: string,
  opts: { downloadOnWeb?: boolean } = {},
): Promise<void> {
  const relNorm = normalizeRelPath(rel);
  if (isTauri && root) {
    try {
      const abs = projectFilePath(root, relNorm)!;
      const fs = await import('@tauri-apps/plugin-fs');
      await fs.mkdir(dirOf(abs), { recursive: true });
      await fs.writeTextFile(abs, text);
    } catch (e) {
      // 项目目录若不在 capabilities fs scope 内（如位于非 $HOME/$DOCUMENT/$APPDATA 盘符），
      // 降级为不落盘并记 warn，避免上层未捕获 Promise rejection 导致应用崩溃。
      log('warn', `项目文件写入跳过（目录可能不在文件系统权限范围内）：${relNorm} — ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  // 浏览器退化：localStorage 草稿
  localStorage.setItem(`sm:proj:${relNorm}`, text);
  if (opts.downloadOnWeb) downloadBlob(relNorm.split('/').pop() ?? relNorm, text);
}

/** 读项目内文本文件；不存在返回 null */
export async function readProjectText(root: string | null | undefined, rel: string): Promise<string | null> {
  const relNorm = normalizeRelPath(rel);
  if (isTauri && root) {
    try {
      const abs = projectFilePath(root, relNorm)!;
      const fs = await import('@tauri-apps/plugin-fs');
      if (!(await fs.exists(abs))) return null;
      return await fs.readTextFile(abs);
    } catch (e) {
      // 同上：权限/IO 异常降级为「无文件」，不向上抛出
      log('warn', `项目文件读取跳过（目录可能不在文件系统权限范围内）：${relNorm} — ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  return localStorage.getItem(`sm:proj:${relNorm}`);
}

/**
 * 追加项目内文本文件（memory.md 场景）：读旧内容 → 拼接 → 回写。
 * 浏览器端用 localStorage 累积。
 */
export async function appendProjectText(
  root: string | null | undefined,
  rel: string,
  text: string,
): Promise<void> {
  const prev = (await readProjectText(root, rel)) ?? '';
  const next = prev ? `${prev}\n${text}` : text;
  await writeProjectText(root, rel, next);
}

/** 取路径的父目录（不含末尾分隔符） */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? '.' : p.slice(0, i);
}
