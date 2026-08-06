/**
 * Vitest 全局 setup（jsdom 环境下补全浏览器 API 缺口）。
 * jsdom 不实现 matchMedia / ResizeObserver / structuredClone 等，
 * 而 store 初始化（viewStore.applyTheme 等）会调用它们；此处补最小桩，
 * 让依赖 window 的 Zustand store 能在测试里正常初始化。
 */
import { vi } from 'vitest';

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  if (!(window as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!(globalThis as unknown as { structuredClone?: unknown }).structuredClone) {
    (globalThis as unknown as { structuredClone: unknown }).structuredClone = (v: unknown) =>
      JSON.parse(JSON.stringify(v));
  }
}
