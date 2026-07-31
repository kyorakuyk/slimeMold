/**
 * 运行环境适配层：
 * - Tauri 桌面端：HTTP 走 plugin-http（Rust 侧转发，规避 CORS 且不暴露密钥于渲染层网络栈）
 * - 浏览器预览：退化为 window.fetch（用于开发调试，本地 Ollama 等同源可用场景）
 */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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

/** 选择文件夹对话框（Tauri 桌面端）。浏览器环境返回 null。 */
export async function openDirDialog(): Promise<string | null> {
  if (isTauri) {
    try {
      const tauri = (window as any).__TAURI__;
      const selected: string[] | string | null = await tauri.dialog.open({
        directory: true,
        multiple: false,
        title: '选择工作区文件夹',
      });
      return Array.isArray(selected) ? selected[0] ?? null : selected;
    } catch {
      return null;
    }
  }
  return null;
}
