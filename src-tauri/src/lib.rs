//! SlimeMold 桌面壳：
//! - plugin-http：LLM 等网络请求经 Rust 侧转发（规避 WebView CORS）
//! - plugin-fs：插件目录扫描、工作流文件读写
//! - plugin-dialog：导入导出文件对话框

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // 首屏优化：窗口初始隐藏，待前端页面 ready 后再显示，消除 webview 白屏
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                win.hide().ok();
            }
            Ok(())
        })
        .on_page_load(|win, _payload| {
            // 页面初次加载完成即显示窗口（SPA 仅触发一次）
            win.show().ok();
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
