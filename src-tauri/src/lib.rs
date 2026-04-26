// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod account;
mod autostart;
mod machine;
mod browser_auto_login;
mod logger;
mod custom_tempmail;
mod quick_register_backend;
mod privacy;

use std::collections::HashMap;
use anyhow::anyhow;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri::webview::PageLoadEvent;
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;
use warp::Filter;

use account::{AccountBrief, AccountManager, Account};
use api::{TraeApiClient, UsageSummary, UsageQueryResponse, UserStatisticResult, is_auth_expired_error_message};

/// 安全地获取 std::sync::Mutex 锁，如果锁被 poisoned 则恢复
fn safe_lock<T>(mutex: &StdMutex<T>) -> Option<std::sync::MutexGuard<'_, T>> {
    match mutex.lock() {
        Ok(guard) => Some(guard),
        Err(poisoned) => {
            log::warn!("Mutex was poisoned, recovering...");
            Some(poisoned.into_inner())
        }
    }
}

#[cfg(target_os = "windows")]
fn hide_console_window() {
    use windows_sys::Win32::System::Console::GetConsoleWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    unsafe {
        let hwnd = GetConsoleWindow();
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub quick_register_show_window: bool,
    pub auto_refresh_enabled: bool,
    pub privacy_auto_enable: bool,
    pub auto_update_check: bool,
    pub auto_start_enabled: bool,
    pub api_key: String,
    pub custom_tempmail_config: custom_tempmail::CustomTempMailConfig,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            quick_register_show_window: false,
            auto_refresh_enabled: true,
            privacy_auto_enable: true,
            auto_update_check: true,
            auto_start_enabled: false,
            api_key: "9201".to_string(),
            custom_tempmail_config: custom_tempmail::CustomTempMailConfig::default(),
        }
    }
}

fn get_settings_path() -> anyhow::Result<PathBuf> {
    let proj_dirs = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow::anyhow!("无法获取应用配置目录"))?;
    let config_dir = proj_dirs.config_dir();
    fs::create_dir_all(config_dir)?;
    Ok(config_dir.join("settings.json"))
}

fn load_settings_from_disk() -> anyhow::Result<AppSettings> {
    let path = get_settings_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(AppSettings::default());
    }
    let settings = serde_json::from_str(&content)
        .unwrap_or_else(|_| AppSettings::default());
    Ok(settings)
}

fn save_settings_to_disk(settings: &AppSettings) -> anyhow::Result<()> {
    let path = get_settings_path()?;
    let content = serde_json::to_string_pretty(settings)?;
    fs::write(path, content)?;
    Ok(())
}

/// 应用状态
pub struct AppState {
    pub account_manager: Mutex<AccountManager>,
    browser_login: Mutex<Option<BrowserLoginSession>>,
    browser_login_cancel: Mutex<Option<oneshot::Sender<()>>>,
    settings: Mutex<AppSettings>,
}

struct BrowserLoginSession {
    receiver: oneshot::Receiver<(String, String)>,
    shutdown: Arc<StdMutex<Option<oneshot::Sender<()>>>>,
    cancel: oneshot::Receiver<()>,
    window_close: oneshot::Receiver<()>,
    webview: WebviewWindow,
    credentials: Arc<StdMutex<BrowserLoginCredentials>>,
}

#[derive(Debug, Default, Clone)]
struct BrowserLoginCredentials {
    email: Option<String>,
    password: Option<String>,
}

/// 错误类型
#[derive(Debug, serde::Serialize)]
pub struct ApiError {
    pub message: String,
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        Self {
            message: err.to_string(),
        }
    }
}

type Result<T> = std::result::Result<T, ApiError>;

// ============ Tauri 命令 ============

/// 添加账号（通过 Token，可选 Cookies）
#[tauri::command]
async fn add_account_by_token(token: String, cookies: Option<String>, state: State<'_, AppState>) -> Result<Account> {
    log::info!("Adding account by token");
    let mut manager = state.account_manager.lock().await;
    let result = manager.add_account_by_token(token, cookies, None).await.map_err(ApiError::from);
    match &result {
        Ok(_) => log::info!("Account added successfully by token"),
        Err(e) => log::error!("Failed to add account by token: {:?}", e),
    }
    result
}

/// 添加账号（通过邮箱密码登录）
#[tauri::command]
async fn add_account_by_email(email: String, password: String, state: State<'_, AppState>) -> Result<Account> {
    log::info!("Adding account by email: {}", email);
    let mut manager = state.account_manager.lock().await;
    let result = manager.add_account_by_email(email, password).await.map_err(ApiError::from);
    match &result {
        Ok(_) => log::info!("Account added successfully by email"),
        Err(e) => log::error!("Failed to add account by email: {:?}", e),
    }
    result
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings> {
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
async fn update_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<AppSettings> {
    if let Err(err) = autostart::set_auto_start(settings.auto_start_enabled) {
        return Err(ApiError::from(err));
    }
    {
        let mut current = state.settings.lock().await;
        *current = settings.clone();
    }
    save_settings_to_disk(&settings).map_err(ApiError::from)?;
    Ok(settings)
}

/// 下载并运行更新安装包（Windows: .msi）
#[tauri::command]
async fn download_and_run_installer(url: String) -> Result<String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(anyhow::anyhow!("安装包链接为空").into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(anyhow::anyhow!("安装包链接无效").into());
    }

    // Prefer keeping the original filename, but avoid collisions.
    let raw_filename = url
        .split('/')
        .last()
        .unwrap_or("Trae账号管理Update.msi")
        .split('?')
        .next()
        .unwrap_or("Trae账号管理Update.msi")
        .trim();
    let filename = if raw_filename.is_empty() {
        "Trae账号管理Update.msi"
    } else {
        raw_filename
    };

    let mut dest_path = std::env::temp_dir();
    dest_path.push(format!(
        "Trae账号管理-update-{}-{}",
        Uuid::new_v4(),
        filename
    ));

    let client = Client::builder()
        .user_agent("Trae账号管理 @ Updater")
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| ApiError::from(anyhow::Error::new(e)))?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| ApiError::from(anyhow::Error::new(e)))?;
    if !response.status().is_success() {
        return Err(anyhow::anyhow!("下载失败: {}", response.status()).into());
    }

    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::new(e)))?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| ApiError::from(anyhow::Error::new(e)))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::new(e)))?;
    }
    file.flush()
        .await
        .map_err(|e| ApiError::from(anyhow::Error::new(e)))?;
    drop(file);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(dest_path.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| anyhow::anyhow!("无法启动安装程序: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        open::that(&dest_path).map_err(|e| anyhow::anyhow!("无法打开安装程序: {}", e))?;
    }

    Ok(dest_path.to_string_lossy().to_string())
}



#[tauri::command]
async fn quick_register(_app: AppHandle, _show_window: bool, _state: State<'_, AppState>) -> Result<Account> {
    // 快速注册功能已禁用，请使用 quick_register_with_custom_tempmail
    Err(ApiError::from(anyhow::anyhow!("快速注册功能已禁用，请在设置中配置自定义临时邮箱后使用新功能")))
}

/// 使用自定义临时邮箱进行快速注册
#[tauri::command]
async fn quick_register_with_custom_tempmail(
    app: AppHandle,
    show_window: bool,
    state: State<'_, AppState>,
) -> Result<Account> {
    use custom_tempmail::{CustomTempMailClient, generate_password};
    use reqwest::Url;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::oneshot;
    use warp::Filter;

    // 检查是否已有浏览器登录在进行中
    if state.browser_login.lock().await.is_some() {
        return Err(ApiError::from(anyhow::anyhow!("浏览器登录正在进行中，请稍后再试")));
    }

    // 获取配置
    let config = {
        let settings = state.settings.lock().await;
        settings.custom_tempmail_config.clone()
    };

    // 检查配置是否有效
    if !config.is_valid() {
        return Err(ApiError::from(anyhow::anyhow!(
            "自定义临时邮箱配置无效，请在设置中配置 API URL、密钥和邮箱域名"
        )));
    }

    // 初始化临时邮箱客户端
    println!("[快速注册] 生成临时邮箱...");
    let mut mail_client = CustomTempMailClient::new(config);

    let password = generate_password();
    let email = mail_client.generate_email();
    println!("[快速注册] 邮箱: {}", email);

    // 启动本地回调服务器（用于接收 JS 拦截的 Token）
    let (token_tx, token_rx) = oneshot::channel::<(String, String)>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (window_close_tx, window_close_rx) = oneshot::channel::<()>();
    let (window_close_tx2, window_close_rx2) = oneshot::channel::<()>();
    let token_sender = Arc::new(StdMutex::new(Some(token_tx)));
    let shutdown_sender = Arc::new(StdMutex::new(Some(shutdown_tx)));
    let window_close_sender = Arc::new(StdMutex::new(Some(window_close_tx)));
    let window_close_sender2 = Arc::new(StdMutex::new(Some(window_close_tx2)));

    let token_sender_route = token_sender.clone();
    let shutdown_sender_route = shutdown_sender.clone();
    let app_handle_route = app.clone();

    let route = warp::path("callback")
        .and(warp::query::<HashMap<String, String>>())
        .map(move |query: HashMap<String, String>| {
            let token = query.get("token").cloned().unwrap_or_default();
            let url = query.get("url").cloned().unwrap_or_default();
            let log = query.get("log").cloned().unwrap_or_default();
            let status = query.get("status").cloned().unwrap_or_default();
            let message = query.get("message").cloned().unwrap_or_default();

            // 处理日志
            if !log.is_empty() {
                println!("[quick-register-js] {}", log);
            }

            // 处理状态通知
            if !status.is_empty() && !message.is_empty() {
                println!("[quick-register-status] {}: {}", status, message);
                let app_handle = app_handle_route.clone();
                let status_clone = status.clone();
                let message_clone = message.clone();
                tokio::spawn(async move {
                    let _ = app_handle.emit("quick_register_notice", serde_json::json!({
                        "id": status_clone,
                        "message": message_clone,
                        "status": status_clone
                    }));
                });
            }

            if !token.is_empty() {
                if let Some(mut guard) = safe_lock(&token_sender_route) {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send((token, url));
                    }
                }
                if let Some(mut guard) = safe_lock(&shutdown_sender_route) {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(());
                    }
                }
                warp::reply::html("已收到 Token，注册成功。".to_string())
            } else {
                warp::reply::html("ok".to_string())
            }
        });

    let (addr, server) = warp::serve(route)
        .bind_with_graceful_shutdown(([127, 0, 0, 1], 0), async move {
            let _ = shutdown_rx.await;
        });
    tokio::spawn(server);

    let port = addr.port();

    // 准备注册助手脚本
    let pending_completion: Arc<StdMutex<Option<(String, String)>>> = Arc::new(StdMutex::new(None));
    let pending_completion_onload = pending_completion.clone();
    let helper_script = build_register_helper_script(port);
    let helper_script_onload = helper_script.clone();
    let helper_script_init = helper_script.clone();
    let email_onload = email.clone();

    // 关闭已存在的窗口
    if let Some(existing) = app.get_webview_window("trae-register") {
        let _ = existing.destroy();
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let webview = WebviewWindowBuilder::new(&app, "trae-register", WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Trae 注册")
        .inner_size(1000.0, 720.0)
        .visible(show_window)
        .initialization_script(&helper_script_init)
        .on_page_load(move |window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = window.eval(helper_script_onload.clone());
                if let Some((code, password)) = safe_lock(&pending_completion_onload).and_then(|g| g.clone()) {
                    let code_js = serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".to_string());
                    let password_js = serde_json::to_string(&password).unwrap_or_else(|_| "\"\"".to_string());
                    let _ = window.eval(format!(
                        "window.__traeAutoRegister && window.__traeAutoRegister.complete({}, {});",
                        code_js, password_js
                    ));
                } else {
                    let email_js = serde_json::to_string(&email_onload).unwrap_or_else(|_| "\"\"".to_string());
                    let _ = window.eval(format!(
                        "window.__traeAutoRegister && window.__traeAutoRegister.start({});",
                        email_js
                    ));
                }
            }
        })
        .build()
        .map_err(|e| ApiError::from(anyhow::anyhow!("无法打开注册窗口: {}", e)))?;

    // 监听窗口关闭事件
    let window_close_sender_clone = window_close_sender.clone();
    let window_close_sender_clone2 = window_close_sender2.clone();
    webview.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            println!("[custom-tempmail] 浏览器窗口被关闭");
            if let Some(mut guard) = safe_lock(&window_close_sender_clone) {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
            if let Some(mut guard) = safe_lock(&window_close_sender_clone2) {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
        }
    });

    // 清除浏览数据并导航到注册页面
    let _ = webview.clear_all_browsing_data();
    let _ = webview.navigate(Url::parse("https://www.trae.ai/sign-up").unwrap());
    // 页面加载完成后 on_page_load 回调会自动注入脚本并调用 start()

    // 等待验证码邮件（同时监听窗口关闭）
    println!("[快速注册] 等待验证码...");
    let code = tokio::select! {
        result = mail_client.wait_for_code(120) => {
            match result {
                Ok(code) => {
                    println!("[快速注册] 获取验证码: {}", code);
                    code
                }
                Err(err) => {
                    let _ = webview.close();
                    return Err(ApiError::from(err));
                }
            }
        }
        _ = window_close_rx => {
            return Err(ApiError::from(anyhow::anyhow!("浏览器窗口被关闭，注册取消")));
        }
    };

    // 填入验证码和密码
    if let Some(mut guard) = safe_lock(&pending_completion) {
        *guard = Some((code.clone(), password.clone()));
    }
    let code_js = serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".to_string());
    let password_js = serde_json::to_string(&password).unwrap_or_else(|_| "\"\"".to_string());
    let _ = webview.eval(format!(
        "window.__traeAutoRegister && window.__traeAutoRegister.complete({}, {});",
        code_js, password_js
    ));

    // 等待 token 拦截（60秒超时，同时监听窗口关闭）
    println!("[快速注册] 等待登录完成...");
    let (token, url) = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(60), token_rx) => {
            match result {
                Ok(Ok(res)) => res,
                Ok(Err(_)) => {
                    let _ = webview.close();
                    if let Some(mut guard) = safe_lock(&pending_completion) {
                        *guard = None;
                    }
                    return Err(ApiError::from(anyhow::anyhow!("等待 Token 失败")));
                }
                Err(_) => {
                    let _ = webview.close();
                    if let Some(mut guard) = safe_lock(&pending_completion) {
                        *guard = None;
                    }
                    return Err(ApiError::from(anyhow::anyhow!("等待 Token 超时（60秒）")));
                }
            }
        }
        _ = window_close_rx2 => {
            if let Some(mut guard) = safe_lock(&pending_completion) {
                *guard = None;
            }
            return Err(ApiError::from(anyhow::anyhow!("浏览器窗口被关闭，注册取消")));
        }
    };

    // Token 已获取，清除 pending_completion 防止 on_page_load 重复执行
    if let Some(mut guard) = safe_lock(&pending_completion) {
        *guard = None;
    }

    println!("[快速注册] 登录成功，保存账号...");

    // 获取 cookies
    let cookies = match wait_for_request_cookies(&webview, &url, Duration::from_secs(6)).await {
        Ok(cookies) => Some(cookies),
        Err(_) => None,
    };

    // 关闭浏览器窗口
    let _ = webview.close();
    let mut manager = state.account_manager.lock().await;
    let mut account = manager.add_account_by_token(token, cookies, Some(password.clone())).await.map_err(ApiError::from)?;

    // 如果邮箱为空或包含*，更新邮箱
    if account.email.trim().is_empty() || account.email.contains('*') || !account.email.contains('@') {
        let _ = manager.update_account_email(&account.id, email.clone());
        account = manager.get_account(&account.id).map_err(ApiError::from)?;
    }

    println!("[快速注册] 完成! 账号: {}", account.email);

    Ok(account)
}

fn build_browser_login_script(port: u16) -> String {
    let script = include_str!("../assets/browser_login.js");
    script.replace("__PORT__", &port.to_string())
}

#[allow(dead_code)]
fn collect_trae_cookies(webview: &WebviewWindow, extra_url: Option<&str>) -> String {
    let mut cookie_map: HashMap<String, String> = HashMap::new();
    let mut urls = vec![
        "https://www.trae.ai/".to_string(),
        "https://api-sg-central.trae.ai/".to_string(),
        "https://ug-normal.trae.ai/".to_string(),
    ];
    
    if let Some(url) = extra_url {
        if !url.is_empty() {
             // 尝试提取 base url (e.g. https://api-us-east.trae.ai)
             if let Ok(parsed) = Url::parse(url) {
                 let base = format!("{}://{}/", parsed.scheme(), parsed.host_str().unwrap_or_default());
                 urls.push(base);
             }
             urls.push(url.to_string());
        }
    }

    for raw_url in urls {
        if let Ok(url) = Url::parse(&raw_url) {
            if let Ok(cookies) = webview.cookies_for_url(url) {
                for cookie in cookies {
                    cookie_map
                        .entry(cookie.name().to_string())
                        .or_insert(cookie.value().to_string());
                }
            }
        }
    }

    let mut cookies = cookie_map
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    if !cookies.is_empty()
        && !cookies.contains("store-idc=")
        && !cookies.contains("trae-target-idc=")
    {
        cookies.push_str("; store-idc=alisg");
    }
    cookies
}
#[tauri::command]
async fn start_browser_login(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let mut browser_login = state.browser_login.lock().await;
    if browser_login.is_some() {
        return Err(anyhow::anyhow!("浏览器登录已在进行中").into());
    }
    let (token_tx, token_rx) = oneshot::channel::<(String, String)>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (window_close_tx, window_close_rx) = oneshot::channel::<()>();
    let token_sender = Arc::new(StdMutex::new(Some(token_tx)));
    let shutdown_sender = Arc::new(StdMutex::new(Some(shutdown_tx)));
    let window_close_sender = Arc::new(StdMutex::new(Some(window_close_tx)));
    let credentials = Arc::new(StdMutex::new(BrowserLoginCredentials::default()));

    let token_sender_route = token_sender.clone();
    let shutdown_sender_route = shutdown_sender.clone();
    let credentials_route = credentials.clone();
    let route = warp::path("callback")
        .and(warp::query::<HashMap<String, String>>())
        .map(move |query: HashMap<String, String>| {
            let mut log_query = query.clone();
            if log_query.contains_key("password") {
                log_query.insert("password".to_string(), "***".to_string());
            }
            let token = query.get("token").cloned().unwrap_or_default();
            let state = query.get("state").cloned().unwrap_or_default();
            let href = query.get("href").cloned().unwrap_or_default();
            let url = query.get("url").cloned().unwrap_or_default();
            let email = query.get("email").cloned().unwrap_or_default();
            let password = query.get("password").cloned().unwrap_or_default();

            if !email.trim().is_empty() || !password.is_empty() {
                if let Some(mut creds) = safe_lock(&credentials_route) {
                    if !email.trim().is_empty() {
                        creds.email = Some(email.trim().to_string());
                    }
                    if !password.is_empty() {
                        creds.password = Some(password);
                    }
                }
            }
            if !token.is_empty() {
                if let Some(mut guard) = safe_lock(&token_sender_route) {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send((token, url));
                    }
                }
                if let Some(mut guard) = safe_lock(&shutdown_sender_route) {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(());
                    }
                }
                warp::reply::html("已收到 Token，可以关闭此页面并返回应用。".to_string())
            } else if state == "logged_in" {
                warp::reply::html(format!("检测到登录完成，等待获取 Token。{href}"))
            } else {
                warp::reply::html("未收到 Token，请重试。".to_string())
            }
        });

    let (addr, server): (std::net::SocketAddr, _) = warp::serve(route)
        .bind_with_graceful_shutdown(([127, 0, 0, 1], 0), async move {
            let _ = shutdown_rx.await;
        });

    tokio::spawn(server);

    let script = build_browser_login_script(addr.port());
    let script_init = script.clone();

    // 关闭已存在的登录窗口
    if let Some(existing) = app.get_webview_window("trae-login") {
        let _ = existing.destroy();
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
    // 再次检查确保窗口已关闭
    if app.get_webview_window("trae-login").is_some() {
        return Err(anyhow::anyhow!("无法关闭已存在的登录窗口，请重启应用后重试").into());
    }

    let webview = WebviewWindowBuilder::new(&app, "trae-login", WebviewUrl::External("https://www.trae.ai/login".parse().unwrap()))
        .title("Trae 登录")
        .inner_size(1000.0, 720.0)
        .initialization_script(&script_init)
        .build()
        .map_err(|e| anyhow::anyhow!("无法打开登录窗口: {}", e))?;

    let window_close_sender_clone = window_close_sender.clone();
    webview.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(mut guard) = safe_lock(&window_close_sender_clone) {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
        }
    });

    let _ = webview.clear_all_browsing_data();
    let _ = webview.set_focus();

    *browser_login = Some(BrowserLoginSession {
        receiver: token_rx,
        shutdown: shutdown_sender,
        cancel: cancel_rx,
        window_close: window_close_rx,
        webview,
        credentials,
    });
    *state.browser_login_cancel.lock().await = Some(cancel_tx);

    Ok(())
}

#[tauri::command]
async fn finish_browser_login(state: State<'_, AppState>) -> Result<Account> {
    let session = {
        let mut browser_login = state.browser_login.lock().await;
        browser_login.take().ok_or_else(|| anyhow::anyhow!("浏览器登录未开始"))?
    };

    let (token, _url) = tokio::select! {
        res = session.receiver => {
            match res {
                Ok(token) => token,
                Err(_) => {
                    let _ = state.browser_login_cancel.lock().await.take();
                    if let Some(mut guard) = safe_lock(&session.shutdown) {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(());
                        }
                    }
                    let _ = session.webview.close();
                    // 清理 browser_login 状态
                    let mut browser_login = state.browser_login.lock().await;
                    *browser_login = None;
                    return Err(anyhow::anyhow!("浏览器登录已取消").into());
                }
            }
        }
        _ = session.cancel => {
            let _ = state.browser_login_cancel.lock().await.take();
            if let Some(mut guard) = safe_lock(&session.shutdown) {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
            let _ = session.webview.close();
            // 清理 browser_login 状态
            let mut browser_login = state.browser_login.lock().await;
            *browser_login = None;
            return Err(anyhow::anyhow!("浏览器登录已取消").into());
        }
        _ = session.window_close => {
            let _ = state.browser_login_cancel.lock().await.take();
            if let Some(mut guard) = safe_lock(&session.shutdown) {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
            // 清理 browser_login 状态
            let mut browser_login = state.browser_login.lock().await;
            *browser_login = None;
            return Err(anyhow::anyhow!("浏览器被主动关闭").into());
        }
        _ = tokio::time::sleep(Duration::from_secs(300)) => {
            let _ = state.browser_login_cancel.lock().await.take();
            if let Some(mut guard) = safe_lock(&session.shutdown) {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
            let _ = session.webview.close();
            // 清理 browser_login 状态
            let mut browser_login = state.browser_login.lock().await;
            *browser_login = None;
            return Err(anyhow::anyhow!("等待浏览器登录超时").into());
        }
    };

    if let Some(mut guard) = safe_lock(&session.shutdown) {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
    let _ = state.browser_login_cancel.lock().await.take();

    // 获取 cookies
    let cookies = session.webview.cookies()
        .map(|cookies: Vec<tauri::webview::Cookie>| {
            cookies.iter()
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default();

    let mut credentials = safe_lock(&session.credentials).map(|g| g.clone()).unwrap_or_default();
    if credentials.email.as_deref().unwrap_or("").trim().is_empty()
        && credentials.password.as_deref().unwrap_or("").is_empty()
    {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let snapshot = safe_lock(&session.credentials).map(|g| g.clone()).unwrap_or_default();
            if !snapshot.email.as_deref().unwrap_or("").trim().is_empty()
                || !snapshot.password.as_deref().unwrap_or("").is_empty()
            {
                credentials = snapshot;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    let _ = session.webview.close();
    let cookies = if cookies.is_empty() { None } else { Some(cookies) };

    let mut manager = state.account_manager.lock().await;
    let mut account = manager
        .upsert_account_by_token(token, cookies, None)
        .await
        .map_err(ApiError::from)?;

    let email = credentials.email.unwrap_or_default();
    let password = credentials.password.unwrap_or_default();
    let has_email = !email.trim().is_empty();
    let has_password = !password.is_empty();
    if has_email || has_password {
        account = manager
            .update_account_profile(
                &account.id,
                if has_email { Some(email) } else { None },
                if has_password { Some(password) } else { None },
            )
            .map_err(ApiError::from)?;
    }

    Ok(account)
}

#[tauri::command]
async fn cancel_browser_login(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    if let Some(tx) = state.browser_login_cancel.lock().await.take() {
        let _ = tx.send(());
    }
    let session = {
        let mut browser_login = state.browser_login.lock().await;
        browser_login.take()
    };
    if let Some(session) = session {
        if let Some(mut guard) = safe_lock(&session.shutdown) {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        let _ = session.webview.destroy();
    }
    // 关闭自动登录窗口（如果存在）
    if let Some(window) = app.get_webview_window("auto_login") {
        let _ = window.destroy();
    }
    Ok(())
}

#[tauri::command]
async fn browser_auto_login_command(
    app: AppHandle,
    email: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<Account> {
    browser_auto_login::browser_auto_login(app, email, password, &state).await.map_err(|e| e.into())
}

#[tauri::command]
async fn remove_account(account_id: String, state: State<'_, AppState>) -> Result<()> {
    let mut manager = state.account_manager.lock().await;
    manager.remove_account(&account_id).map_err(ApiError::from)
}

/// 获取所有账号
#[tauri::command]
async fn get_accounts(state: State<'_, AppState>) -> Result<Vec<AccountBrief>> {
    let manager = state.account_manager.lock().await;
    Ok(manager.get_accounts())
}

/// 获取单个账号详情
#[tauri::command]
async fn get_account(account_id: String, state: State<'_, AppState>) -> Result<Account> {
    let manager = state.account_manager.lock().await;
    manager.get_account(&account_id).map_err(ApiError::from)
}

/// 切换账号（设置活跃账号并更新机器码）
#[tauri::command]
async fn switch_account(account_id: String, force: Option<bool>, state: State<'_, AppState>) -> Result<()> {
    log::info!("Switching account: {}", account_id);
    {
        let mut manager = state.account_manager.lock().await;
        let force = force.unwrap_or(false);
        if let Err(e) = manager.switch_account(&account_id, force).await {
            log::error!("Failed to switch account: {}", e);
            return Err(ApiError::from(e));
        }
        log::info!("Account switched successfully");
    }

    let settings = state.settings.lock().await.clone();
    if settings.privacy_auto_enable {
        log::info!("Waiting for Trae IDE to start before writing privacy settings");
        let db_path = match machine::get_trae_state_db_path() {
            Ok(path) => path,
            Err(err) => {
                log::error!("Failed to find Trae database: {}", err);
                // 即使查找数据库失败，也尝试启动 Trae
                let _ = tokio::task::spawn_blocking(|| {
                    let _ = machine::open_trae();
                }).await;
                return Ok(());
            }
        };
        
        // 先启动 Trae，等待数据库文件生成
        let db_path_clone = db_path.clone();
        let start_result = tokio::task::spawn_blocking(move || {
            // 启动 Trae
            if let Err(e) = machine::open_trae() {
                println!("[ERROR] 启动 Trae IDE 失败: {}", e);
                return Err(e);
            }
            
            // 等待数据库文件存在（最多等待 30 秒）
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(30);
            while !db_path_clone.exists() {
                if start.elapsed() > timeout {
                    return Err(anyhow::anyhow!("等待 Trae 数据库超时"));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            
            Ok(())
        }).await;
        
        match start_result {
            Ok(Ok(())) => {
                // Trae 启动成功，数据库文件已生成，现在写入隐私模式
                let result = tokio::task::spawn_blocking(move || {
                    privacy::enable_privacy_mode_at_path_with_restart(db_path, || {
                        machine::kill_trae()?;
                        machine::open_trae()
                    })
                }).await;

                let _ = result;
            }
            Ok(Err(_)) => {}
            Err(_) => {}
        }
    } else {
        // 隐私模式未启用，直接启动 Trae
        let _ = tokio::task::spawn_blocking(|| {
            let _ = machine::open_trae();
        }).await;
    }

    Ok(())
}

/// 获取账号使用量
#[tauri::command]
async fn get_account_usage(account_id: String, state: State<'_, AppState>) -> Result<UsageSummary> {
    // 1. 获取账号信息（持有锁的时间极短）
    let account = {
        let manager = state.account_manager.lock().await;
        manager.get_account(&account_id).map_err(ApiError::from)?
    };

    // 2. 执行网络请求（不持有锁，可并行）
    let (summary, new_token) = fetch_usage_for_account(&account).await.map_err(ApiError::from)?;

    // 3. 更新账号信息（持有锁的时间极短）
    {
        let mut manager = state.account_manager.lock().await;
        // 忽略更新错误（可能账号已被删除），但不影响返回结果
        let _ = manager.update_account_info_after_usage_check(
            &account_id,
            summary.plan_type.clone(),
            new_token,
        );
    }

    Ok(summary)
}

async fn fetch_usage_for_account(account: &Account) -> anyhow::Result<(UsageSummary, Option<(String, String)>)> {
    let mut new_token_info = None;

    let summary = if let Some(token) = &account.jwt_token {
        // 优先使用 Token
        let client = TraeApiClient::new_with_token(token)?;
        match client.get_usage_summary_by_token().await {
            Ok(summary) => summary,
            Err(e) => {
                let error_msg = e.to_string();
                // 如果是 401 错误且有 Cookies，尝试刷新 Token
                if error_msg.contains("401") && !account.cookies.is_empty() {
                    // 使用 Cookies 刷新 Token
                    let mut cookie_client = TraeApiClient::new(&account.cookies)?;
                    let token_result = cookie_client.get_user_token().await?;
                    
                    new_token_info = Some((token_result.token.clone(), token_result.expired_at.clone()));

                    // 使用新 Token 重新获取使用量
                    let new_client = TraeApiClient::new_with_token(&token_result.token)?;
                    new_client.get_usage_summary_by_token().await?
                } else if error_msg.contains("401") {
                    return Err(anyhow::anyhow!("Token 已过期，请更新 Token 或 Cookies"));
                } else {
                    return Err(e);
                }
            }
        }
    } else if !account.cookies.is_empty() {
        // 使用 Cookies
        let mut client = TraeApiClient::new(&account.cookies)?;
        // 先获取 token 以便保存
        let token_result = client.get_user_token().await?;
        new_token_info = Some((token_result.token.clone(), token_result.expired_at.clone()));
        
        client.get_usage_summary().await?
    } else {
        return Err(anyhow::anyhow!("账号没有有效的 Token 或 Cookies"));
    };

    Ok((summary, new_token_info))
}

/// 更新账号 Token
#[tauri::command]
async fn update_account_token(account_id: String, token: String, state: State<'_, AppState>) -> Result<UsageSummary> {
    let mut manager = state.account_manager.lock().await;
    manager.update_account_token(&account_id, token).await.map_err(ApiError::from)
}

/// 刷新 Token（使用 Cookies）
#[tauri::command]
async fn refresh_token(account_id: String, state: State<'_, AppState>) -> Result<()> {
    let mut manager = state.account_manager.lock().await;
    manager.refresh_token(&account_id).await.map_err(ApiError::from)
}

/// 使用密码刷新 Token/Cookies
#[tauri::command]
async fn refresh_token_with_password(
    account_id: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut manager = state.account_manager.lock().await;
    manager
        .refresh_token_with_password(&account_id, &password)
        .await
        .map_err(ApiError::from)
}

/// 使用邮箱密码重新登录并更新账号
#[tauri::command]
async fn login_account_with_email(
    account_id: String,
    email: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<UsageSummary> {
    let mut manager = state.account_manager.lock().await;
    manager
        .login_account_with_email(&account_id, email, password)
        .await
        .map_err(ApiError::from)
}

/// 更新账号邮箱/密码
#[tauri::command]
async fn update_account_profile(
    account_id: String,
    email: Option<String>,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<Account> {
    let mut manager = state.account_manager.lock().await;
    manager
        .update_account_profile(&account_id, email, password)
        .map_err(ApiError::from)
}

/// 清空账号数据
#[tauri::command]
async fn clear_accounts(state: State<'_, AppState>) -> Result<usize> {
    let mut manager = state.account_manager.lock().await;
    manager.clear_accounts().map_err(ApiError::from)
}

/// 导出账号到指定路径
#[tauri::command]
async fn export_accounts_to_path(path: String, state: State<'_, AppState>) -> Result<()> {
    let manager = state.account_manager.lock().await;
    let content = manager.export_accounts().map_err(ApiError::from)?;
    fs::write(&path, content)
        .map_err(|err| ApiError::from(anyhow::Error::from(err)))?;
    Ok(())
}

/// 导出账号
#[tauri::command]
async fn export_accounts(state: State<'_, AppState>) -> Result<String> {
    let manager = state.account_manager.lock().await;
    manager.export_accounts().map_err(ApiError::from)
}

/// 导入账号结果
#[derive(Debug, serde::Serialize)]
pub struct ImportAccountsResult {
    pub count: usize,
    pub success: Vec<String>,
    pub failed: Vec<(String, String, String)>, // (邮箱, 密码, 原因)
}

/// 导入账号
#[tauri::command]
async fn import_accounts(
    data: String,
    state: State<'_, AppState>
) -> Result<ImportAccountsResult> {
    let mut manager = state.account_manager.lock().await;
    let (count, success, failed) = manager.import_accounts(&data).await.map_err(ApiError::from)?;
    Ok(ImportAccountsResult { count, success, failed })
}

/// 获取使用事件
#[tauri::command]
async fn get_usage_events(
    account_id: String,
    start_time: i64,
    end_time: i64,
    page_num: i32,
    page_size: i32,
    state: State<'_, AppState>
) -> Result<UsageQueryResponse> {
    let mut manager = state.account_manager.lock().await;
    manager.get_usage_events(&account_id, start_time, end_time, page_num, page_size)
        .await
        .map_err(ApiError::from)
}

/// 从 Trae IDE 读取账号
#[tauri::command]
async fn read_trae_account(state: State<'_, AppState>) -> Result<Option<Account>> {
    let mut manager = state.account_manager.lock().await;
    manager.read_trae_ide_account().await.map_err(ApiError::from)
}

/// 获取当前系统机器码
#[tauri::command]
async fn get_machine_id() -> Result<String> {
    machine::get_machine_guid().map_err(ApiError::from)
}

/// 重置系统机器码（生成新的随机机器码）
#[tauri::command]
async fn reset_machine_id() -> Result<String> {
    machine::reset_machine_guid().map_err(ApiError::from)
}

/// 设置系统机器码为指定值
#[tauri::command]
async fn set_machine_id(machine_id: String) -> Result<()> {
    machine::set_machine_guid(&machine_id).map_err(ApiError::from)
}

/// 绑定账号机器码（保存当前系统机器码到账号）
#[tauri::command]
async fn bind_account_machine_id(account_id: String, state: State<'_, AppState>) -> Result<String> {
    let mut manager = state.account_manager.lock().await;
    manager.bind_machine_id(&account_id).map_err(ApiError::from)
}

/// 获取 Trae IDE 的机器码
#[tauri::command]
async fn get_trae_machine_id() -> Result<String> {
    machine::get_trae_machine_id().map_err(ApiError::from)
}

/// 设置 Trae IDE 的机器码
#[tauri::command]
async fn set_trae_machine_id(machine_id: String) -> Result<()> {
    machine::set_trae_machine_id(&machine_id).map_err(ApiError::from)
}

/// 清除 Trae IDE 登录状态（让 IDE 变成全新安装状态）
#[tauri::command]
async fn clear_trae_login_state() -> Result<()> {
    machine::clear_trae_login_state().map_err(ApiError::from)
}

/// 备份账号的 Trae 上下文数据
#[tauri::command]
async fn backup_account_context(account_id: String) -> Result<String> {
    let backup_path = machine::backup_account_context(&account_id).map_err(ApiError::from)?;
    Ok(backup_path.to_string_lossy().to_string())
}

/// 恢复账号的 Trae 上下文数据
#[tauri::command]
async fn restore_account_context(account_id: String) -> Result<()> {
    machine::restore_account_context(&account_id).map_err(ApiError::from)
}

/// 检查账号是否有上下文备份
#[tauri::command]
async fn has_account_context_backup(account_id: String) -> Result<bool> {
    Ok(machine::has_account_context_backup(&account_id))
}

/// 删除账号的上下文备份
#[tauri::command]
async fn delete_account_context_backup(account_id: String) -> Result<()> {
    machine::delete_account_context_backup(&account_id).map_err(ApiError::from)
}

/// 合并两个账号的对话记录（当前账号的对话合并到目标账号）
#[tauri::command]
async fn merge_two_accounts_context(
    current_account_id: String,
    target_account_id: String,
) -> Result<()> {
    machine::merge_two_accounts_context(&current_account_id, &target_account_id).map_err(ApiError::from)
}

/// 获取保存的 Trae IDE 路径
#[tauri::command]
async fn get_trae_path() -> Result<String> {
    machine::get_saved_trae_path().map_err(ApiError::from)
}

/// 设置 Trae IDE 路径
#[tauri::command]
async fn set_trae_path(path: String) -> Result<()> {
    machine::save_trae_path(&path).map_err(ApiError::from)
}

/// 自动扫描 Trae IDE 路径
#[tauri::command]
async fn scan_trae_path() -> Result<String> {
    machine::scan_trae_path().map_err(ApiError::from)
}

/// 检查更新
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<serde_json::Value>> {
    let updater = app.updater().map_err(|e| {
        ApiError::from(anyhow::anyhow!("获取更新器失败: {}", e))
    })?;
    
    match updater.check().await {
        Ok(Some(update)) => {
            let info = serde_json::json!({
                "version": update.version,
                "current_version": update.current_version,
                "body": update.body,
                "date": update.date.map(|d| d.to_string())
            });
            Ok(Some(info))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(ApiError::from(anyhow::anyhow!("检查更新失败: {}", e)))
    }
}

/// 下载并安装更新
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<()> {
    let updater = app.updater().map_err(|e| ApiError::from(anyhow::anyhow!("获取更新器失败: {}", e)))?;
    
    if let Some(update) = updater.check().await.map_err(|e| ApiError::from(anyhow::anyhow!("检查更新失败: {}", e)))? {
        update.download_and_install(|_, _| {}, || {}).await.map_err(|e| ApiError::from(anyhow::anyhow!("下载安装失败: {}", e)))?;
    }
    
    Ok(())
}

/// 打开购买页面（内置浏览器，携带账号 Cookies）
#[tauri::command]
async fn open_pricing(account_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let account = {
        let manager = state.account_manager.lock().await;
        manager.get_account(&account_id).map_err(ApiError::from)?
    };

    // 如果窗口已存在，先关闭它
    if let Some(existing) = app.get_webview_window("trae-pricing") {
        // 使用 destroy 强制销毁窗口
        let _ = existing.destroy();
        // 等待窗口完全销毁
        tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
    }
    // 再次检查确保窗口已关闭
    if app.get_webview_window("trae-pricing").is_some() {
        return Err(anyhow::anyhow!("无法关闭已存在的购买窗口，请重启应用后重试").into());
    }

    let cookies = account.cookies.clone();
    let cookies_for_js = cookies.replace('\\', "\\\\").replace('`', "\\`");
    let js_onload = format!(
        r#"
(() => {{
  try {{
    // 只在 trae.ai 域名下执行
    if (!location.hostname.endsWith('trae.ai')) return;

    // 如果已经在 pricing 页面且已注入过，就不再执行
    if (location.href.includes('/pricing') && sessionStorage.getItem('trae_auth_injected')) return;

    console.log('[pricing] Starting auth injection...');

    // 1. 尽力清除旧数据 (JS 能访问到的)
    try {{
        localStorage.clear();
        sessionStorage.clear();
        const oldCookies = document.cookie.split(";");
        for (let i = 0; i < oldCookies.length; i++) {{
            const cookie = oldCookies[i];
            const eqPos = cookie.indexOf("=");
            const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
            document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.trae.ai";
            document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=www.trae.ai";
            document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        }}
    }} catch (e) {{
        console.warn('[pricing] Clear old data failed', e);
    }}

    // 2. 注入新 Cookie
    const raw = `{cookies}`;
    const parts = raw ? raw.split(';').map(s => s.trim()).filter(Boolean) : [];
    const seen = new Set();
    for (const kv of parts) {{
      const idx = kv.indexOf('=');
      if (idx <= 0) continue;
      const name = kv.slice(0, idx);
      const value = kv.slice(idx + 1);
      if (seen.has(name)) continue;
      seen.add(name);
      document.cookie = `${{name}}=${{value}}; path=/; domain=.trae.ai; secure; samesite=lax`;
    }}
    // 补全 IDC cookie
    if (!raw.includes('store-idc=') && !raw.includes('trae-target-idc=')) {{
      document.cookie = `store-idc=alisg; path=/; domain=.trae.ai; secure; samesite=lax`;
    }}
    
    // 3. 标记并跳转
    sessionStorage.setItem('trae_auth_injected', 'true');
    
    if (!location.href.includes('/pricing')) {{
        console.log('[pricing] Redirecting to pricing...');
        window.location.href = "https://www.trae.ai/pricing";
    }} else {{
        console.log('[pricing] Reloading to apply cookies...');
        location.reload();
    }}
  }} catch (e) {{
    console.error('[pricing] cookie inject error', e);
  }}
}})();
"#,
        cookies = cookies_for_js
    );

    let script_onload = js_onload.clone();
    let webview = WebviewWindowBuilder::new(
        &app,
        "trae-pricing",
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Trae 购买 Pro")
    .inner_size(1000.0, 720.0)
    .on_page_load(move |window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = window.eval(script_onload.clone());
        }
    })
    .build()
    .map_err(|e| anyhow::anyhow!("无法打开购买窗口: {}", e))?;

    // 强制清理数据
    let _ = webview.clear_all_browsing_data();

    // 先导航到一个轻量页(404)来建立域上下文并执行注入，然后再由脚本跳转到 pricing
    // 这样可以确保 Cookie 在请求 pricing 之前就已经准备好
    let _ = webview.navigate(Url::parse("https://www.trae.ai/404_auth_init").unwrap());
    let _ = webview.set_focus();
    Ok(())
}

/// 获取用户统计数据
#[tauri::command]
async fn get_user_statistics(account_id: String, state: State<'_, AppState>) -> Result<UserStatisticResult> {
    let manager = state.account_manager.lock().await;
    manager.get_account_statistics(&account_id).await.map_err(ApiError::from)
}

/// 检测 Token 无效的账号（只检测，不删除）
#[tauri::command]
async fn check_invalid_accounts(state: State<'_, AppState>) -> Result<Vec<(String, String, String)>> {
    let manager = state.account_manager.lock().await;
    manager.check_invalid_token_accounts().await.map_err(ApiError::from)
}

/// 删除指定的账号
#[tauri::command]
async fn remove_accounts_by_ids(account_ids: Vec<String>, state: State<'_, AppState>) -> Result<Vec<(String, String)>> {
    let mut manager = state.account_manager.lock().await;
    manager.remove_accounts_by_ids(&account_ids).map_err(ApiError::from)
}

/// 构建注册助手脚本
fn build_register_helper_script(port: u16) -> String {
    let script = include_str!("../assets/register_helper.js");
    script.replace("__PORT__", &port.to_string())
}

/// 等待请求 cookies
async fn wait_for_request_cookies(
    webview: &tauri::webview::WebviewWindow,
    request_url: &str,
    timeout: Duration,
) -> anyhow::Result<String> {
    let parsed_url = normalize_request_url(request_url)
        .ok_or_else(|| anyhow::anyhow!("URL 无效: {}", request_url))?;
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Ok(cookie_list) = webview.cookies_for_url(parsed_url.clone()) {
            let cookies = cookie_list
                .into_iter()
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ");
            if !cookies.is_empty() {
                return Ok(cookies);
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(anyhow::anyhow!("未能获取 Cookie"))
}

fn normalize_request_url(url: &str) -> Option<Url> {
    let trimmed = url.split('?').next().unwrap_or(url);
    Url::parse("https://www.trae.ai/")
        .ok()?
        .join(trimmed)
        .ok()
}

async fn handle_silent_start() -> anyhow::Result<()> {
    let mut manager = AccountManager::new()?;
    
    // 1. Refresh all accounts
    let account_ids: Vec<String> = manager.get_accounts().into_iter().map(|a| a.id).collect();
    for id in account_ids {
        let _ = manager.refresh_token(&id).await;
    }

    // 2. Sync with Trae IDE if it's not running
    if !machine::is_trae_running() {
        let accounts = manager.get_accounts();
        if let Some(current) = accounts.iter().find(|a| a.is_current) {
             if let Ok(account) = manager.get_account(&current.id) {
                if let Some(token) = account.jwt_token {
                     let login_info = machine::TraeLoginInfo {
                        token,
                        refresh_token: None,
                        user_id: account.user_id,
                        email: account.email,
                        username: account.name,
                        avatar_url: account.avatar_url,
                        host: String::new(),
                        region: if account.region.is_empty() { "SG".to_string() } else { account.region },
                    };
                    let _ = machine::write_trae_login_info(&login_info);
                }
             }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logger first
    let _ = logger::init_logger();
    
    // Set up panic handler
    std::panic::set_hook(Box::new(|info| {
        logger::log_panic(info);
        // Also show a message box on Windows
        #[cfg(target_os = "windows")]
        {
            use std::ffi::CString;
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxA, MB_ICONERROR, MB_OK};
            let message = format!("应用程序发生错误:\n{}\n\n请查看日志文件获取详细信息。", info);
            if let Ok(c_message) = CString::new(message) {
                if let Ok(c_title) = CString::new("Trae账号管理 - 错误") {
                    unsafe {
                        MessageBoxA(
                            std::ptr::null_mut(),
                            c_message.as_ptr() as *const u8,
                            c_title.as_ptr() as *const u8,
                            MB_OK | MB_ICONERROR,
                        );
                    }
                }
            }
        }
    }));
    
    log::info!("Application starting...");
    
    // Check for silent flag
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--silent".to_string()) {
        #[cfg(target_os = "windows")]
        hide_console_window();
        let rt = tokio::runtime::Runtime::new().expect("Failed to create runtime");
        rt.block_on(async {
            let _ = handle_silent_start().await;
        });
        std::process::exit(0);
    }

    log::info!("Initializing account manager...");
    let account_manager = AccountManager::new().expect("无法初始化账号管理器");
    let settings = load_settings_from_disk().unwrap_or_default();
    let _ = autostart::set_auto_start(settings.auto_start_enabled);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            account_manager: Mutex::new(account_manager),
            browser_login: Mutex::new(None),
            browser_login_cancel: Mutex::new(None),
            settings: Mutex::new(settings),
        })
        .invoke_handler(tauri::generate_handler![
            add_account_by_token,
            add_account_by_email,
            get_settings,
            update_settings,
            download_and_run_installer,
            quick_register,
            quick_register_with_custom_tempmail,
            start_browser_login,
            finish_browser_login,
            cancel_browser_login,
            browser_auto_login_command,
            remove_account,
            get_accounts,
            get_account,
            switch_account,
            get_account_usage,
            update_account_token,
            refresh_token,
            refresh_token_with_password,
            login_account_with_email,
            update_account_profile,
            export_accounts,
            export_accounts_to_path,
            import_accounts,
            clear_accounts,
            get_usage_events,
            read_trae_account,
            get_machine_id,
            reset_machine_id,
            set_machine_id,
            bind_account_machine_id,
            get_trae_machine_id,
            set_trae_machine_id,
            clear_trae_login_state,
            backup_account_context,
            restore_account_context,
            has_account_context_backup,
            delete_account_context_backup,
            merge_two_accounts_context,
            get_trae_path,
            set_trae_path,
            scan_trae_path,
            get_user_statistics,
            open_pricing,
            check_update,
            install_update,
            get_logs,
            export_logs_cmd,
            clear_logs_cmd,
            get_log_file_path_cmd,
            check_invalid_accounts,
            remove_accounts_by_ids,
            quick_register_backend::quick_register_create_task,
            quick_register_backend::quick_register_get_status,
            quick_register_backend::quick_register_claim_resource,
            quick_register_backend::quick_register_get_stats,
            // 新流程：扫码即绑定，令牌即身份
            quick_register_backend::exchange_pc_token,
            quick_register_backend::get_user_info,
            quick_register_backend::claim_resource_with_token,
        ])
        .setup(|app| {
            // 获取主窗口并显示，标题加上版本号
            if let Some(window) = app.get_webview_window("main") {
                let version = app.package_info().version.to_string();
                let _ = window.set_title(&format!("Trae账号管理 v{}", version));
                window.show().unwrap();
                window.set_focus().unwrap();
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 仅在主窗口关闭时才退出应用
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    api.prevent_close();
                    std::process::exit(0);
                }
            }
            _ => {}
        })

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Logger commands
#[tauri::command]
async fn get_logs(count: usize) -> std::result::Result<Vec<String>, String> {
  logger::get_recent_logs(count).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_logs_cmd(path: String) -> std::result::Result<(), String> {
  let path_buf = std::path::PathBuf::from(path);
  logger::export_logs(&path_buf).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_logs_cmd() -> std::result::Result<(), String> {
  logger::clear_logs().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_log_file_path_cmd() -> std::result::Result<String, String> {
  Ok(logger::get_log_file_path().to_string_lossy().to_string())
}
