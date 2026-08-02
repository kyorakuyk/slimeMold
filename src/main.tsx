import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/typora.css';

// 默认深色主题（面向开发者），可通过顶栏按钮切换为浅色
document.documentElement.setAttribute('data-theme', 'dark');

// 全局兜底：把任何同步/异步错误也写到屏幕与窗口标题，避免“卡加载却无任何提示”
function showFatal(msg: string) {
  try { localStorage.setItem('sm_lastError', msg); } catch { /* ignore */ }
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML =
      '<div style="position:fixed;inset:0;padding:24px;font-family:monospace;color:#ff6b6b;background:#1a1a1a;overflow:auto;z-index:99999">' +
      '<h2>应用运行出错</h2>' +
      '<pre style="white-space:pre-wrap;word-break:break-word">' + String(msg).replace(/</g, '&lt;') + '</pre></div>';
  }
  try { document.title = 'SM 错误: ' + msg.slice(0, 80); } catch { /* ignore */ }
}
window.addEventListener('error', (e) => showFatal(String(e.error?.stack || e.message || e)));
window.addEventListener('unhandledrejection', (e) => showFatal('UnhandledRejection: ' + String(e.reason?.stack || e.reason)));

// 顶层错误边界：把启动期 / 渲染期的报错显示出来，避免只停在「加载中…」白屏
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 同时打到控制台，便于在 Tauri 终端 / 浏览器 devtools 看到完整堆栈
    console.error('[SlimeMold] 渲染错误：', error, info);
    showFatal(`${error.message}\n${error.stack ?? ''}`);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            padding: 24,
            background: '#f7f5f1',
            color: '#7a3b3b',
            fontFamily: 'system-ui, sans-serif',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            fontSize: 13,
            lineHeight: 1.6,
            zIndex: 99999,
          }}
        >
          <h2 style={{ color: '#9a2b2b', marginTop: 0 }}>SlimeMold 启动出错</h2>
          <div style={{ color: '#333', marginBottom: 8 }}>
            请复制以下错误信息反馈：
          </div>
          <code>{this.state.error.message}</code>
          {this.state.error.stack && (
            <pre style={{ marginTop: 12, color: '#555' }}>{this.state.error.stack}</pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  showFatal('致命错误：找不到 #root 挂载节点');
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
