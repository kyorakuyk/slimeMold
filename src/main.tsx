import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/typora.css';

// 默认深色主题（面向开发者），可通过顶栏按钮切换为浅色
document.documentElement.setAttribute('data-theme', 'dark');

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
    try {
      localStorage.setItem('sm_lastError', `${error.message}\n${error.stack ?? ''}`);
    } catch {
      /* ignore */
    }
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
