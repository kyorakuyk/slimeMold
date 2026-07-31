import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 期望固定端口；浏览器预览同样可用
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    allowedHosts: true,
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
