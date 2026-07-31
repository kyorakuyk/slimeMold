import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/typora.css';

// 默认深色主题（面向开发者），可通过顶栏按钮切换为浅色
document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
