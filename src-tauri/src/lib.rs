// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod account;
mod autostart;
mod machine;
mod privacy;
mod browser_auto_login;
mod logger;
mod custom_tempmail;
mod quick_register_backend;

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
use api::{TraeApiClient, UsageSummary, UsageQueryResponse, UserStatisticResult};

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
    login_complete: oneshot::Receiver<String>,
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
                if let Some(tx) = token_sender_route.lock().unwrap().take() {
                    let _ = tx.send((token, url));
                }
                if let Some(tx) = shutdown_sender_route.lock().unwrap().take() {
                    let _ = tx.send(());
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
                if let Some((code, password)) = pending_completion_onload.lock().unwrap().clone() {
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
            if let Some(tx) = window_close_sender_clone.lock().unwrap().take() {
                let _ = tx.send(());
            }
            if let Some(tx) = window_close_sender_clone2.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    });

    // 清除浏览数据并导航到注册页面
    let _ = webview.clear_all_browsing_data();
    let _ = webview.navigate(Url::parse("https://www.trae.ai/sign-up").unwrap());

    // 等待页面加载完成后再执行脚本
    tokio::time::sleep(Duration::from_millis(800)).await;
    let _ = webview.eval(helper_script.clone());
    let _ = webview.eval(format!(
        "if (window.__traeAutoRegister) {{ window.__traeAutoRegister.start({}); }}",
        serde_json::to_string(&email).unwrap_or_else(|_| "\"\"".to_string())
    ));

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
    *pending_completion.lock().unwrap() = Some((code.clone(), password.clone()));
    let code_js = serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".to_string());
    let password_js = serde_json::to_string(&password).unwrap_or_else(|_| "\"\"".to_string());
    let _ = webview.eval(format!(
        "window.__traeAutoRegister && window.__traeAutoRegister.complete({}, {});",
        code_js, password_js
    ));

    // 等待 token 拦截（同时监听窗口关闭）
    println!("[快速注册] 等待登录完成...");
    let (token, url) = tokio::select! {
        result = token_rx => {
            match result {
                Ok(res) => res,
                Err(_) => {
                    let _ = webview.close();
                    return Err(ApiError::from(anyhow::anyhow!("等待 Token 超时或失败")));
                }
            }
        }
        _ = window_close_rx2 => {
            return Err(ApiError::from(anyhow::anyhow!("浏览器窗口被关闭，注册取消")));
        }
    };

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
    let script = r#"(function() {
  if (window.__traeAutoInjected) return;
  window.__traeAutoInjected = true;

  const callback = "http://127.0.0.1:__PORT__/callback";
  let loginTriggered = false;
  const normalize = (text) => (text || "").toLowerCase();
  const STORAGE_EMAIL_KEY = "__trae_login_email";
  const STORAGE_PASSWORD_KEY = "__trae_login_password";
  let capturedEmail = "";
  let capturedPassword = "";
  let lastSentEmail = "";
  let lastSentPassword = "";
  const boundInputs = new WeakSet();
  try {
    capturedEmail = sessionStorage.getItem(STORAGE_EMAIL_KEY) || "";
    capturedPassword = sessionStorage.getItem(STORAGE_PASSWORD_KEY) || "";
  } catch {}
  const captureEmail = (value) => {
    const next = (value || "").trim();
    if (next) {
      capturedEmail = next;
      try {
        sessionStorage.setItem(STORAGE_EMAIL_KEY, capturedEmail);
      } catch {}
    }
  };
  const capturePassword = (value) => {
    const next = (value || "").toString();
    if (next) {
      capturedPassword = next;
      try {
        sessionStorage.setItem(STORAGE_PASSWORD_KEY, capturedPassword);
      } catch {}
    }
  };
  const maybeCapture = (el) => {
    if (!el || !el.getAttribute) return;
    const type = normalize(el.getAttribute("type") || "");
    const name = normalize(el.getAttribute("name") || "");
    const autocomplete = normalize(el.getAttribute("autocomplete") || "");
    const placeholder = normalize(el.getAttribute("placeholder") || "");
    const value = typeof el.value === "string" ? el.value : "";
    const trimmedValue = value.trim();
    if (type === "password" || name.includes("password") || autocomplete.includes("password") || placeholder.includes("password")) {
      capturePassword(value);
    }
    if (
      type === "email" ||
      name.includes("email") ||
      name.includes("account") ||
      autocomplete.includes("email") ||
      placeholder.includes("email") ||
      placeholder.includes("邮箱")
    ) {
      captureEmail(value);
    } else if (!capturedEmail && trimmedValue.includes("@")) {
      captureEmail(trimmedValue);
    }
  };
  const bindInput = (input) => {
    if (!input || boundInputs.has(input) || !input.addEventListener) return;
    boundInputs.add(input);
    const handler = () => {
      maybeCapture(input);
      syncCredentials();
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
    input.addEventListener("blur", handler);
  };
  const applyCredentialField = (key, value) => {
    if (typeof value !== "string") return;
    const lower = normalize(key);
    if (lower.includes("email")) {
      captureEmail(value);
    }
    if (
      lower.includes("password") ||
      lower.includes("passwd") ||
      lower === "pwd" ||
      lower.endsWith("password")
    ) {
      capturePassword(value);
    }
  };
  const extractCredentialsFromBody = (body) => {
    if (!body) return;
    try {
      if (typeof body === "string") {
        const trimmed = body.trim();
        if (!trimmed) return;
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          const data = JSON.parse(trimmed);
          if (data && typeof data === "object") {
            Object.keys(data).forEach((key) => applyCredentialField(key, data[key]));
          }
        } else {
          const params = new URLSearchParams(trimmed);
          params.forEach((value, key) => applyCredentialField(key, value));
        }
        syncCredentials();
        return;
      }
      if (body instanceof URLSearchParams) {
        body.forEach((value, key) => applyCredentialField(key, value));
        syncCredentials();
        return;
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        body.forEach((value, key) => {
          if (typeof value === "string") {
            applyCredentialField(key, value);
          }
        });
        syncCredentials();
        return;
      }
    } catch {}
  };
  const hookValueSetter = () => {
    try {
      if (window.__traeValueHooked) return;
      if (!window.HTMLInputElement) return;
      const proto = HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (!desc || !desc.set || !desc.get) return;
      Object.defineProperty(proto, "value", {
        get: function() {
          return desc.get.call(this);
        },
        set: function(val) {
          desc.set.call(this, val);
          try {
            maybeCapture(this);
            syncCredentials();
          } catch {}
        }
      });
      window.__traeValueHooked = true;
    } catch {}
  };
  const getInputFromEvent = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : (event.path || []);
    if (path && path.length) {
      for (const node of path) {
        if (node && node.tagName && node.tagName.toLowerCase() === "input") {
          return node;
        }
      }
    }
    return event.target;
  };
  const scanRoot = (root) => {
    if (!root) return;
    try {
      const inputs = root.querySelectorAll ? root.querySelectorAll("input") : [];
      if (inputs && inputs.length) {
        inputs.forEach((input) => {
          maybeCapture(input);
          bindInput(input);
        });
      }
      const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
      if (elements && elements.length) {
        elements.forEach((el) => {
          if (el && el.shadowRoot) {
            scanRoot(el.shadowRoot);
          }
          if (el && el.tagName && el.tagName.toLowerCase() === "iframe") {
            try {
              scanRoot(el.contentDocument || (el.contentWindow && el.contentWindow.document));
            } catch {}
          }
        });
      }
    } catch {}
  };
  const scanInputs = () => {
    scanRoot(document);
    syncCredentials();
  };
  const tryAcceptCookies = () => {
    const cookieSelectors = [
      'button.cm__btn',
      '.cm__btn[role=\"button\"]',
      '.cm__btn'
    ];
    for (const selector of cookieSelectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        btn.click();
        return true;
      }
    }
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a")
    );
    const matchText = (text) => {
      const val = (text || "").toLowerCase();
      return (
        val.includes("got it") ||
        val.includes("accept") ||
        val.includes("agree") ||
        val.includes("允许") ||
        val.includes("同意")
      );
    };
    for (const el of candidates) {
      const text = el.innerText || el.textContent || "";
      if (matchText(text)) {
        el.click();
        return true;
      }
    }
    const wrapper = document.querySelector(".cm-wrapper, .cc__wrapper, .cookie-banner, .cookie-consent");
    if (wrapper) {
      wrapper.remove();
      return true;
    }
    return false;
  };
  const sendPayload = (payload) => {
    const params = new URLSearchParams();
    Object.keys(payload || {}).forEach((key) => {
      const value = payload[key];
      if (value === undefined || value === null || value === "") return;
      params.append(key, value);
    });
    if (capturedEmail) params.append("email", capturedEmail);
    if (capturedPassword) params.append("password", capturedPassword);
    const url = callback + "?" + params.toString();
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url);
    } else {
      fetch(url, { mode: "no-cors" });
    }
  };
  const syncCredentials = () => {
    if (!capturedEmail && !capturedPassword) return;
    if (capturedEmail === lastSentEmail && capturedPassword === lastSentPassword) return;
    lastSentEmail = capturedEmail;
    lastSentPassword = capturedPassword;
    sendPayload({ state: "credentials" });
  };
  const normalizeUrl = (raw) => {
    if (!raw) return "";
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return String(raw);
    }
  };

  const sendToken = (token, url) => {
    if (!token) return;
    loginTriggered = true;
    sendPayload({ token, url: normalizeUrl(url) });
  };
  const sendState = (state, href) => {
    if (!state) return;
    loginTriggered = true;
    sendPayload({ state, href: href || "" });
  };
  const isLoginCompleteUrl = (href) => {
    if (!href) return false;
    const lower = href.toLowerCase();
    if (lower.includes("/login")) return false;
    if (lower.includes("passport")) return false;
    if (lower.includes("sign-up") || lower.includes("signup") || lower.includes("register")) return false;
    if (lower.includes("terms") || lower.includes("privacy")) return false;
    return true;
  };
  const parseToken = (data) => {
    if (!data) return null;
    return (
      data.result?.token ||
      data.result?.Token ||
      data.Result?.token ||
      data.Result?.Token ||
      null
    );
  };

  const markLoginTriggered = () => {
    loginTriggered = true;
  };

  const scanLocalStorage = () => {
    try {
      const storages = [localStorage, sessionStorage];
      storages.forEach(storage => {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key && (key.toLowerCase().includes("token") || key.toLowerCase().includes("auth") || key.toLowerCase().includes("user"))) {
            const val = storage.getItem(key);
            if (val && typeof val === "string" && val.startsWith("ey") && val.split(".").length === 3) {
              sendToken(val, "storage:" + key);
            }
          }
        }
      });
    } catch (e) {}
  };
  scanLocalStorage();
  setInterval(scanLocalStorage, 2000);

  const tryFetch = async () => {
    const endpoints = [
      "https://api-sg-central.trae.ai/cloudide/api/v3/common/GetUserToken",
      "https://api-us-east.trae.ai/cloudide/api/v3/common/GetUserToken"
    ];
    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/plain, */*",
      "origin": "https://www.trae.ai",
      "referer": "https://www.trae.ai/"
    };
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers,
          body: "{}"
        });
        const data = await res.json();
        const token = parseToken(data);
        if (token) {
          sendToken(token, res.url);
          return;
        }
      } catch {}
    }
  };

  const hookFetch = () => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      try {
        const input = args[0];
        const init = args[1];
        if (init && init.body) {
          extractCredentialsFromBody(init.body);
        } else if (input && typeof input === "object" && typeof input.clone === "function") {
          input.clone().text().then((text) => extractCredentialsFromBody(text)).catch(() => {});
        }
      } catch {}
      const res = await orig(...args);
      try {
        if (typeof res.url === "string" && res.url.includes("GetUserToken")) {
          const data = await res.clone().json();
          const token = parseToken(data);
          if (token) sendToken(token, res.url);
        }
      } catch {}
      return res;
    };
  };

  const hookXHR = () => {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__trae_url = url;
      return origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try {
        extractCredentialsFromBody(body);
      } catch {}
      this.addEventListener("load", function() {
        try {
          if ((this.__trae_url || "").includes("GetUserToken")) {
            const data = JSON.parse(this.responseText);
            const token = parseToken(data);
            if (token) sendToken(token, this.__trae_url);
          }
        } catch {}
      });
      return origSend.apply(this, arguments);
    };
  };

  hookFetch();
  hookXHR();
  hookValueSetter();
  tryFetch();
  tryAcceptCookies();
  scanInputs();
  setInterval(tryFetch, 3000);
  setInterval(tryAcceptCookies, 1500);
  setInterval(scanInputs, 2000);
  try {
    const observer = new MutationObserver(() => scanInputs());
    const target = document.documentElement || document;
    observer.observe(target, { childList: true, subtree: true });
  } catch {}
  document.addEventListener("submit", () => {
    scanInputs();
    markLoginTriggered();
  }, true);
  syncCredentials();
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    scanInputs();
    const button = target.closest("button, [role='button'], a, input[type='button'], input[type='submit']");
    if (!button) return;
    const text = normalize(button.innerText || button.textContent || button.getAttribute("aria-label"));
    if (
      text.includes("log in") ||
      text.includes("login") ||
      text.includes("sign in") ||
      text.includes("sign-in") ||
      text.includes("github") ||
      text.includes("google") ||
      text.includes("continue") ||
      text.includes("登录") ||
      text.includes("继续") ||
      text.includes("授权")
    ) {
      markLoginTriggered();
    }
  }, true);
  document.addEventListener("input", (event) => {
    const target = getInputFromEvent(event);
    if (!target) return;
    maybeCapture(target);
    syncCredentials();
    const targetType = target.getAttribute ? normalize(target.getAttribute("type") || "") : "";
    if (targetType === "password") markLoginTriggered();
  }, true);
  let lastHref = location.href;
  let stateSent = false;
  const checkHref = () => {
    const href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      if (!stateSent && isLoginCompleteUrl(href)) {
        stateSent = true;
        sendState("logged_in", href);
        tryFetch();
      }
    }
  };
  setInterval(checkHref, 1000);
  if (isLoginCompleteUrl(location.href)) {
    stateSent = true;
    sendState("logged_in", location.href);
    tryFetch();
  }
})();"#;
    script.replace("__PORT__", &port.to_string())
}

#[allow(dead_code)]
fn collect_trae_cookies(webview: &WebviewWindow, extra_url: Option<&str>) -> String {
    let mut cookie_map: HashMap<String, String> = HashMap::new();
    let mut urls = vec![
        "https://www.trae.ai/".to_string(),
        "https://trae.ai/".to_string(),
        "https://passport.trae.ai/".to_string(),
        "https://api-sg-central.trae.ai/".to_string(),
        "https://api-us-east.trae.ai/".to_string(),
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
    let (login_complete_tx, login_complete_rx) = oneshot::channel::<String>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (window_close_tx, window_close_rx) = oneshot::channel::<()>();
    let token_sender = Arc::new(StdMutex::new(Some(token_tx)));
    let login_complete_sender = Arc::new(StdMutex::new(Some(login_complete_tx)));
    let shutdown_sender = Arc::new(StdMutex::new(Some(shutdown_tx)));
    let window_close_sender = Arc::new(StdMutex::new(Some(window_close_tx)));
    let credentials = Arc::new(StdMutex::new(BrowserLoginCredentials::default()));

    let token_sender_route = token_sender.clone();
    let login_complete_sender_route = login_complete_sender.clone();
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
                let mut creds = credentials_route.lock().unwrap();
                if !email.trim().is_empty() {
                    creds.email = Some(email.trim().to_string());
                }
                if !password.is_empty() {
                    creds.password = Some(password);
                }
            }
            if !token.is_empty() {
                if let Some(tx) = token_sender_route.lock().unwrap().take() {
                    let _ = tx.send((token, url));
                }
                if let Some(tx) = shutdown_sender_route.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                warp::reply::html("已收到 Token，可以关闭此页面并返回应用。".to_string())
            } else if state == "logged_in" {
                if let Some(tx) = login_complete_sender_route.lock().unwrap().take() {
                    let _ = tx.send(href.clone());
                }
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
            if let Some(tx) = window_close_sender_clone.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    });

    let _ = webview.clear_all_browsing_data();
    let _ = webview.set_focus();

    *browser_login = Some(BrowserLoginSession {
        receiver: token_rx,
        login_complete: login_complete_rx,
        shutdown: shutdown_sender,
        cancel: cancel_rx,
        window_close: window_close_rx,
        webview,
        credentials,
    });
    *state.browser_login_cancel.lock().await = Some(cancel_tx);

    Ok(())
}

async fn try_get_browser_login_token_from_cookies(
    webview: &WebviewWindow,
    href: Option<&str>,
) -> anyhow::Result<(String, String)> {
    let mut last_error = anyhow!("尚未获取到登录 Cookie");

    for _ in 0..8 {
        let cookies = collect_trae_cookies(webview, href);
        if !cookies.trim().is_empty() {
            match TraeApiClient::new(&cookies) {
                Ok(mut client) => match client.get_user_token().await {
                    Ok(token_result) => return Ok((token_result.token, cookies)),
                    Err(err) => last_error = err,
                },
                Err(err) => last_error = err,
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Err(anyhow!("登录已完成，但未能通过 Cookies 获取 Token: {}", last_error))
}

#[tauri::command]
async fn finish_browser_login(state: State<'_, AppState>) -> Result<Account> {
    let mut session = {
        let mut browser_login = state.browser_login.lock().await;
        browser_login.take().ok_or_else(|| anyhow::anyhow!("浏览器登录未开始"))?
    };

    let mut fallback_cookies: Option<String> = None;
    let mut logged_in_href: Option<String> = None;
    let mut login_complete_received = false;
    let timeout = tokio::time::sleep(Duration::from_secs(300));
    tokio::pin!(timeout);

    let (token, token_url) = loop {
        tokio::select! {
            res = &mut session.receiver => {
                match res {
                    Ok(token) => break token,
                    Err(_) => {
                        let _ = state.browser_login_cancel.lock().await.take();
                        if let Some(tx) = session.shutdown.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        let _ = session.webview.close();
                        let mut browser_login = state.browser_login.lock().await;
                        *browser_login = None;
                        return Err(anyhow::anyhow!("浏览器登录已取消").into());
                    }
                }
            }
            href = &mut session.login_complete, if !login_complete_received => {
                login_complete_received = true;
                logged_in_href = href.ok().filter(|value| !value.trim().is_empty());
                println!("[browser-login] 检测到网页登录完成，尝试通过 Cookies 获取 Token...");

                match try_get_browser_login_token_from_cookies(&session.webview, logged_in_href.as_deref()).await {
                    Ok((token, cookies)) => {
                        println!("[browser-login] 已通过 Cookies 兜底获取 Token");
                        fallback_cookies = Some(cookies);
                        break (token, logged_in_href.clone().unwrap_or_default());
                    }
                    Err(err) => {
                        println!("[browser-login] Cookies 兜底获取 Token 失败，将继续等待页面回调: {}", err);
                    }
                }
            }
            _ = &mut session.cancel => {
                let _ = state.browser_login_cancel.lock().await.take();
                if let Some(tx) = session.shutdown.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                let _ = session.webview.close();
                let mut browser_login = state.browser_login.lock().await;
                *browser_login = None;
                return Err(anyhow::anyhow!("浏览器登录已取消").into());
            }
            _ = &mut session.window_close => {
                let _ = state.browser_login_cancel.lock().await.take();
                if let Some(tx) = session.shutdown.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                let mut browser_login = state.browser_login.lock().await;
                *browser_login = None;
                return Err(anyhow::anyhow!("浏览器被主动关闭").into());
            }
            _ = &mut timeout => {
                if login_complete_received {
                    match try_get_browser_login_token_from_cookies(&session.webview, logged_in_href.as_deref()).await {
                        Ok((token, cookies)) => {
                            println!("[browser-login] 超时前通过 Cookies 兜底获取 Token 成功");
                            fallback_cookies = Some(cookies);
                            break (token, logged_in_href.clone().unwrap_or_default());
                        }
                        Err(err) => {
                            println!("[browser-login] 超时前 Cookies 兜底仍失败: {}", err);
                        }
                    }
                }

                let _ = state.browser_login_cancel.lock().await.take();
                if let Some(tx) = session.shutdown.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                let _ = session.webview.close();
                let mut browser_login = state.browser_login.lock().await;
                *browser_login = None;
                return Err(anyhow::anyhow!("等待浏览器登录超时").into());
            }
        }
    };

    if let Some(tx) = session.shutdown.lock().unwrap().take() {
        let _ = tx.send(());
    }
    let _ = state.browser_login_cancel.lock().await.take();

    // 获取 cookies，优先使用多域名聚合后的结果
    let cookies = fallback_cookies.unwrap_or_else(|| {
        let collected = collect_trae_cookies(&session.webview, Some(&token_url));
        if !collected.is_empty() {
            return collected;
        }

        session.webview.cookies()
            .map(|cookies: Vec<tauri::webview::Cookie>| {
                cookies.iter()
                    .map(|c| format!("{}={}", c.name(), c.value()))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default()
    });

    let mut credentials = session.credentials.lock().unwrap().clone();
    if credentials.email.as_deref().unwrap_or("").trim().is_empty()
        && credentials.password.as_deref().unwrap_or("").is_empty()
    {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let snapshot = session.credentials.lock().unwrap().clone();
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
        if let Some(tx) = session.shutdown.lock().unwrap().take() {
            let _ = tx.send(());
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

/// 手动检查更新 - 使用 reqwest 获取最新版本信息，支持多镜像重试
#[tauri::command]
async fn check_update_backend() -> Result<serde_json::Value> {
    // 增加 User-Agent 伪装，防止被镜像站拦截
    let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Trae-cc-Client/1.0";
    
    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(std::time::Duration::from_secs(12)) // 略微增加超时
        .build()
        .map_err(|e| ApiError::from(anyhow::anyhow!("创建 HTTP 客户端失败: {}", e)))?;

    let endpoints = [
        "https://hhh9201.github.io/Trae-cc/release/latest.json",
        "https://raw.gitmirror.com/HHH9201/Trae-cc/main/release/latest.json",
        "https://raw.fgit.cf/HHH9201/Trae-cc/main/release/latest.json",
        "https://raw.githubusercontent.com/HHH9201/Trae-cc/main/release/latest.json",
        "https://mirror.ghproxy.com/https://raw.githubusercontent.com/HHH9201/Trae-cc/main/release/latest.json",
    ];

    let mut last_error_msg = String::from("所有更新服务器均无法访问");

    for url in endpoints.iter() {
        println!("[Update] 正在尝试从 {} 检查更新...", url);
        let response = client
            .get(*url)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache") // 禁用缓存
            .send()
            .await;

        match response {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        println!("[Update] ✅ 成功从 {} 获取更新信息", url);
                        return Ok(data);
                    }
                    Err(e) => {
                        println!("[Update] ❌ 解析 JSON 失败 ({}): {}", url, e);
                        last_error_msg = format!("解析数据失败: {}", e);
                    }
                }
            }
            Ok(resp) => {
                let status = resp.status();
                println!("[Update] ⚠️ 服务器返回状态码 {}: {}", status, url);
                last_error_msg = format!("服务器返回错误: {}", status);
            }
            Err(e) => {
                // 打印更详细的错误原因
                let err_type = if e.is_timeout() { "超时" } 
                               else if e.is_connect() { "连接失败" }
                               else if e.is_request() { "请求构造错误" }
                               else { "未知网络错误" };
                
                println!("[Update] ⚠️ {} ({}): {}", err_type, url, e);
                last_error_msg = format!("网络{}: {}", err_type, e);
            }
        }
    }

    Err(ApiError::from(anyhow::anyhow!("{}", last_error_msg)))
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
    let script = r#"(function() {
  if (window.__traeAutoRegister) return;

  const callback = "http://127.0.0.1:__PORT__/callback";

  const sendPayload = (payload) => {
    const params = new URLSearchParams();
    Object.keys(payload || {}).forEach((key) => {
      const value = payload[key];
      if (value === undefined || value === null || value === "") return;
      params.append(key, value);
    });
    const url = callback + "?" + params.toString();
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url);
    } else {
      fetch(url, { mode: "no-cors" });
    }
  };

  const sendLog = (msg) => {
    sendPayload({ log: msg });
  };

  const parseToken = (data) => {
    if (!data) return null;
    return (
      data.result?.token ||
      data.result?.Token ||
      data.Result?.token ||
      data.Result?.Token ||
      data.data?.token ||
      data.Data?.Token ||
      data.token ||
      data.Token ||
      null
    );
  };

  const normalizeUrl = (raw) => {
    if (!raw) return "";
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return String(raw);
    }
  };

  const sendToken = (token, url) => {
    if (!token) return;
    sendLog("Found token: " + token.substring(0, 10) + "...");
    sendPayload({ token, url: normalizeUrl(url) });
  };

  const tryFetch = async () => {
    const endpoints = [
      "https://api-sg-central.trae.ai/cloudide/api/v3/common/GetUserToken",
      "https://api-us-east.trae.ai/cloudide/api/v3/common/GetUserToken"
    ];
    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/plain, */*",
      "origin": "https://www.trae.ai",
      "referer": "https://www.trae.ai/"
    };
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers,
          body: "{}"
        });
        const data = await res.json();
        const token = parseToken(data);
        if (token) {
          sendToken(token, res.url);
          return;
        }
      } catch {}
    }
  };

  const hookFetch = () => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const url = args[0] instanceof Request ? args[0].url : args[0];
      const res = await orig(...args);
      try {
        const resUrl = res.url || "";
        if (resUrl.includes("GetUserToken") || (typeof url === "string" && url.includes("GetUserToken"))) {
          const data = await res.clone().json();
          const token = parseToken(data);
          if (token) {
              sendToken(token, resUrl || url);
          }
        }
      } catch (e) {}
      return res;
    };
  };

  const hookXHR = () => {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__trae_url = url;
      return origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(body) {
      this.addEventListener("load", function() {
        try {
          if ((this.__trae_url || "").includes("GetUserToken")) {
            const data = JSON.parse(this.responseText);
            const token = parseToken(data);
            if (token) {
                sendToken(token, this.__trae_url);
            }
          }
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  };

  try {
      hookFetch();
      hookXHR();
  } catch (e) {}

  const normalize = (text) => (text || "").toLowerCase();

  const setValue = (input, value) => {
    if (!input) return false;
    if (input.value === value) return true;

    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    input.focus();
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value === value;
  };

  const findInputByLabel = (labels) => {
    const labelEls = Array.from(document.querySelectorAll("label"));
    for (const label of labelEls) {
      const text = normalize(label.innerText);
      if (!labels.some((l) => text.includes(l))) continue;
      const forId = label.getAttribute("for");
      if (forId) {
        const target = document.getElementById(forId);
        if (target) return target;
      }
      const nested = label.querySelector("input");
      if (nested) return nested;
    }
    return null;
  };

  const findInput = (labels, selectors) => {
    const byLabel = findInputByLabel(labels);
    if (byLabel) return byLabel;
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  };

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const isClickable = (el) => {
    if (!el || el.disabled) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "a" || tag === "input") return true;
    const role = el.getAttribute && el.getAttribute("role");
    if (role === "button") return true;
    const style = window.getComputedStyle(el);
    if (style && style.cursor === "pointer") return true;
    return !!el.onclick;
  };

  const findClickableAncestor = (el) => {
    let current = el;
    let depth = 0;
    while (current && depth < 4) {
      if (isClickable(current)) return current;
      current = current.parentElement;
      depth += 1;
    }
    return null;
  };

  const findClickableByText = (labels, scope) => {
    const root = scope || document;
    const candidates = Array.from(
      root.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a, div, span")
    );
    return (
      candidates.find((el) => {
        if (!isVisible(el)) return false;
        const text = normalize(el.innerText || el.textContent);
        if (!text) return false;
        if (!labels.some((label) => text.includes(label))) return false;
        return isClickable(el);
      }) || null
    );
  };

  const runWithRetry = (fn, maxTries = 60) => {
    let tries = 0;
    let lastSuccessTime = Date.now();
    const startTime = Date.now();

    const tryExecute = () => {
      tries += 1;
      const ok = fn();

      if (ok) {
        lastSuccessTime = Date.now();
        clearInterval(timer);
        return;
      }

      if (Date.now() - startTime > 30000) {
        console.log('[AutoRegister] 重试超时，结束执行');
        clearInterval(timer);
        return;
      }

      if (tries >= maxTries) {
        clearInterval(timer);
      }
    };

    tryExecute();

    let interval = 100;
    const timer = setInterval(() => {
      if (tries > 10) interval = 200;
      tryExecute();
    }, interval);
  };

  const findTextNodeElement = (labels) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue) continue;
      const text = normalize(node.nodeValue);
      if (!text) continue;
      if (labels.some((label) => text.includes(label))) {
        return node.parentElement;
      }
    }
    return null;
  };

  const clickByText = (labels) => {
    const element = findTextNodeElement(labels);
    if (!element) return false;
    const clickable = findClickableAncestor(element) || element;
    clickable.click();
    return true;
  };

  const tryAcceptCookies = () => {
    const cookieSelectors = [
      'button.cm__btn',
      '.cm__btn[role="button"]',
      '.cm__btn'
    ];
    for (const selector of cookieSelectors) {
      const btn = document.querySelector(selector);
      if (btn && isVisible(btn)) {
        btn.click();
        return true;
      }
    }
    const btn = findClickableByText(["got it", "accept", "agree", "允许", "同意"], document);
    if (btn) {
      btn.click();
      return true;
    }
    const wrapper = document.querySelector(".cm-wrapper, .cc__wrapper, .cookie-banner, .cookie-consent");
    if (wrapper) {
      wrapper.remove();
      return true;
    }
    return false;
  };

  const tryStart = (email) => {
    tryAcceptCookies();
    const emailInput = findInput(["email"], [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="Email"]'
    ]);
    if (emailInput) {
      setValue(emailInput, email);
      if (emailInput.value !== email) {
        return false;
      }
    }
    const codeInput = findInput(["verification", "code", "验证码", "验证"], [
      'input[name="code"]',
      'input[placeholder*="Verification"]',
      'input[placeholder*="Code"]'
    ]);
    const labels = ["send code", "send verification", "get code", "发送验证码", "获取验证码", "发送码"];
    const sendCodeSelectors = [
      ".right-part.send-code",
      ".send-code",
      ".verification-code",
      ".verification-code .send-code",
      ".input-con .right-part"
    ];
    const scope = codeInput ? codeInput.parentElement || codeInput.closest("div") : null;
    let btn = null;
    for (const selector of sendCodeSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && isVisible(candidate)) {
        btn = findClickableAncestor(candidate) || candidate;
        break;
      }
    }
    if (!btn) {
      btn = findClickableByText(labels, scope);
    }
    if (!btn) {
      btn = findClickableByText(labels, document);
    }
    if (!btn) {
      if (clickByText(labels)) return true;
    }
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  };

  const tryComplete = (code, password) => {
    tryAcceptCookies();
    const codeInput = findInput(["verification", "code"], [
      'input[name="code"]',
      'input[placeholder*="Verification"]',
      'input[placeholder*="Code"]'
    ]);
    const passInput = findInput(["password"], [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="new-password"]'
    ]);
    if (codeInput) setValue(codeInput, code);
    if (passInput) setValue(passInput, password);
    const form = passInput?.closest("form") || codeInput?.closest("form");
    if (form) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      if (typeof form.submit === "function") {
        form.submit();
      }
    }
    const signUpSelectors = [".btn-submit", ".trae__btn", ".btn-large", ".btn-submit.trae__btn"];
    let btn = null;
    for (const selector of signUpSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && isVisible(candidate)) {
        btn = findClickableAncestor(candidate) || candidate;
        break;
      }
    }
    if (!btn) {
      btn = findClickableByText(["sign up", "register", "注册"], document);
    }
    if (btn) {
      btn.click();
      // 发送注册按钮点击通知
      sendPayload({ status: "register_clicked", message: "正在注册，请等待..." });
      // 启动状态检测
      startStatusDetection();
      return true;
    }
    return false;
  };

  // 检测注册状态（检测 go3958317564 类名的提示元素）
  const startStatusDetection = () => {
    let attempts = 0;
    const maxAttempts = 30; // 最多检测 30 秒
    let lastStatusText = "";
    const checkInterval = setInterval(() => {
      attempts++;
      const statusDiv = document.querySelector('.go3958317564');
      if (statusDiv) {
        const statusText = (statusDiv.textContent || "").trim();
        // 只处理新出现的提示文本
        if (statusText && statusText !== lastStatusText) {
          lastStatusText = statusText;
          sendLog("检测到提示: " + statusText);
          // 判断成功或失败
          const successKeywords = ['success', 'succeed', 'successful', '成功', 'completed', 'done', 'welcome', '欢迎'];
          const isSuccess = successKeywords.some(keyword => statusText.toLowerCase().includes(keyword));
          if (isSuccess) {
            sendPayload({ status: "register_success", message: "注册成功: " + statusText });
            clearInterval(checkInterval);
          } else {
            // 非成功提示都视为错误/失败
            sendPayload({ status: "register_failed", message: "注册失败: " + statusText });
            clearInterval(checkInterval);
          }
        }
      }
      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        sendPayload({ status: "register_timeout", message: "注册状态检测超时" });
      }
    }, 1000);
  };

  window.__traeAutoRegister = {
    start: (email) => runWithRetry(() => tryStart(email)),
    complete: (code, password) => runWithRetry(() => tryComplete(code, password))
  };

  hookFetch();
  hookXHR();
  tryFetch();
  setInterval(tryFetch, 3000);

  sendLog("AutoRegister helper installed");
})();
"#;

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
            check_update_backend,
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
            quick_register_backend::get_today_analytics,
        ])
        .setup(|app| {
            // 获取主窗口并显示
            if let Some(window) = app.get_webview_window("main") {
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
