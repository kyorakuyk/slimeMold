import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Tauri 期望固定端口；浏览器预览同样可用
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // i18n 的 Node 兜底 loader 仅 tsx/headless 使用；浏览器构建 shim 掉 node: 模块，
      // 避免 rollup 解析 node 内置模块报错（Vite 环境实际走 import.meta.glob 分支，shim 不执行）。
      // `node:fs/promises` 必须显式 alias（前缀替换会把 `node:fs/promises` 拼成 `node-fs.ts/promises` → ENOENT）。
      'node:fs/promises': fileURLToPath(new URL('./src/i18n/shims/node-fs.ts', import.meta.url)),
      'node:fs': fileURLToPath(new URL('./src/i18n/shims/node-fs.ts', import.meta.url)),
      'node:path': fileURLToPath(new URL('./src/i18n/shims/node-path.ts', import.meta.url)),
      'node:url': fileURLToPath(new URL('./src/i18n/shims/node-url.ts', import.meta.url)),
      // H4 开发节点执行层仅 headless/Node 可用；浏览器构建 shim 掉 node:child_process。
      'node:child_process': fileURLToPath(new URL('./src/dev/shims/node-child-process.ts', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    allowedHosts: true,
    // 不要监视 Rust 编译产物，避免和 cargo 编译抢锁导致 EBUSY 崩溃
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    // 禁用 dev 服务器缓存，避免 Tauri WebView 命中旧模块（修复 TDZ/HMR 不刷新）
    headers: {
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2021',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          xyflow: ['@xyflow/react'],
          tauri: [
            '@tauri-apps/api',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-http',
          ],
        },
      },
    },
  },
});
