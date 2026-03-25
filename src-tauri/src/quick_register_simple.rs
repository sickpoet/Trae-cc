//! 简化版快速注册模块 - 使用 Trae-Account-Manager 的实现方式

use std::time::Duration;
use anyhow::anyhow;
use reqwest::Url;
use tauri::{AppHandle, Manager, State, WebviewUrl};
use tauri::webview::WebviewWindowBuilder;
use tokio::sync::oneshot;
use warp::Filter;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use crate::{
    tempmail_client::{TempMailClient, generate_password},
    Account, AppState, ApiError,
};

pub async fn quick_register_simple(
    app: AppHandle,
    show_window: bool,
    state: State<'_, AppState>,
) -> Result<Account, ApiError> {
    println!("\n========================================");
    println!("[quick-register-simple] 开始快速注册流程");
    println!("========================================\n");

    // 检查是否已有浏览器登录在进行中
    if state.browser_login.lock().await.is_some() {
        return Err(ApiError::from(anyhow!("浏览器登录正在进行中，请稍后再试")));
    }

    // 初始化 TempMailClient
    println!("[quick-register-simple] 初始化 TempMailClient...");
    let mut mail_client = TempMailClient::new();
    let password = generate_password();
    let email = mail_client.generate_email().await;
    
    if email == "error@tempmail.cn" {
        return Err(ApiError::from(anyhow!("创建临时邮箱失败，请重试")));
    }
    
    println!("[quick-register-simple] 邮箱: {}", email);
    println!("[quick-register-simple] 密码: {}******", &password[..3]);

    // 启动本地回调服务器（用于接收 JS 拦截的 Token）
    let (token_tx, token_rx) = oneshot::channel::<(String, String)>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let token_sender = Arc::new(StdMutex::new(Some(token_tx)));
    let shutdown_sender = Arc::new(StdMutex::new(Some(shutdown_tx)));

    let token_sender_route = token_sender.clone();
    let shutdown_sender_route = shutdown_sender.clone();

    let route = warp::path("callback")
        .and(warp::query::<HashMap<String, String>>())
        .map(move |query: HashMap<String, String>| {
            if let Some(msg) = query.get("log") {
                println!("[quick-register-js] {}", msg);
                return warp::reply::html("ok".to_string());
            }

            let token = query.get("token").cloned().unwrap_or_default();
            let url = query.get("url").cloned().unwrap_or_default();
            
            if !token.is_empty() {
                println!("[quick-register-simple] 收到Token回调");
                if let Some(tx) = token_sender_route.lock().unwrap().take() {
                    let _ = tx.send((token, url));
                }
                if let Some(tx) = shutdown_sender_route.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                warp::reply::html("已收到 Token，注册成功。".to_string())
            } else {
                warp::reply::html("未收到 Token".to_string())
            }
        });

    let (addr, server) = warp::serve(route)
        .bind_with_graceful_shutdown(([127, 0, 0, 1], 0), async move {
            let _ = shutdown_rx.await;
        });
    tokio::spawn(server);

    let port = addr.port();
    println!("[quick-register-simple] 回调服务器启动在端口: {}", port);

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

    println!("[quick-register-simple] 创建浏览器窗口...");
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
        .map_err(|e| ApiError::from(anyhow!("无法打开注册窗口: {}", e)))?;

    // 清除浏览数据并导航到注册页面
    let _ = webview.clear_all_browsing_data();
    let _ = webview.navigate(Url::parse("https://www.trae.ai/sign-up").unwrap());
    let _ = webview.eval(helper_script);

    // 等待验证码邮件
    println!("[quick-register-simple] 等待验证码邮件...");
    let code = match mail_client.wait_for_code(Duration::from_secs(60)).await {
        Ok(code) => code,
        Err(err) => {
            let _ = webview.close();
            return Err(ApiError::from(err));
        }
    };
    
    println!("[quick-register-simple] 获取验证码: {}", code);

    // 填入验证码和密码
    *pending_completion.lock().unwrap() = Some((code.clone(), password.clone()));
    let code_js = serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".to_string());
    let password_js = serde_json::to_string(&password).unwrap_or_else(|_| "\"\"".to_string());
    let _ = webview.eval(format!(
        "window.__traeAutoRegister && window.__traeAutoRegister.complete({}, {});",
        code_js, password_js
    ));

    // 等待 token 拦截
    println!("[quick-register-simple] 等待登录完成 (token 拦截)...");
    let (token, url) = match token_rx.await {
        Ok(res) => res,
        Err(_) => {
            println!("[quick-register-simple] Token 等待超时或失败");
            let _ = webview.close();
            return Err(ApiError::from(anyhow!("等待 Token 超时或失败")));
        }
    };
    
    println!("[quick-register-simple] Token 拦截成功");

    // 获取 cookies
    let cookies = match wait_for_request_cookies(&webview, &url, Duration::from_secs(6)).await {
        Ok(cookies) => {
            println!("[quick-register-simple] 获取到 cookies: {}", &cookies[..cookies.len().min(100)]);
            cookies
        }
        Err(err) => {
            println!("[quick-register-simple] 获取 cookies 失败: {}", err);
            let _ = webview.close();
            return Err(ApiError::from(err));
        }
    };

    // 关闭浏览器窗口
    let _ = webview.close();

    // 保存账号
    println!("[quick-register-simple] 保存账号...");
    let mut manager = state.account_manager.lock().await;
    let mut account = manager.add_account_by_token(token, Some(cookies), Some(password.clone())).await.map_err(ApiError::from)?;
    
    // 如果邮箱为空或包含*，更新邮箱
    if account.email.trim().is_empty() || account.email.contains('*') || !account.email.contains('@') {
        let _ = manager.update_account_email(&account.id, email.clone());
        account = manager.get_account(&account.id).map_err(ApiError::from)?;
    }

    println!("\n========================================");
    println!("[quick-register-simple] 快速注册完成!");
    println!("[quick-register-simple] 邮箱: {}", account.email);
    println!("========================================\n");

    Ok(account)
}

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
      if (typeof url === "string" && (url.includes("GetUserToken") || url.includes("cloudide/api/v3"))) {
          sendLog("Fetch request: " + url);
      }
      
      const res = await orig(...args);
      try {
        const resUrl = res.url || "";
        if (resUrl.includes("GetUserToken") || (typeof url === "string" && url.includes("GetUserToken"))) {
          sendLog("Intercepted GetUserToken response from: " + resUrl);
          const data = await res.clone().json();
          const token = parseToken(data);
          if (token) {
              sendToken(token, resUrl || url);
          } else {
              sendLog("Parsed token is null from data: " + JSON.stringify(data).substring(0, 100));
          }
        }
      } catch (e) {
          sendLog("Error reading fetch response: " + e.message);
      }
      return res;
    };
  };

  const hookXHR = () => {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__trae_url = url;
      if (typeof url === "string" && (url.includes("GetUserToken") || url.includes("cloudide/api/v3"))) {
         sendLog("XHR open: " + url);
      }
      return origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(body) {
      this.addEventListener("load", function() {
        try {
          if ((this.__trae_url || "").includes("GetUserToken")) {
            sendLog("Intercepted GetUserToken XHR load: " + this.__trae_url);
            const data = JSON.parse(this.responseText);
            const token = parseToken(data);
            if (token) {
                sendToken(token, this.__trae_url);
            } else {
                sendLog("Parsed token is null from XHR data");
            }
          }
        } catch (e) {
             sendLog("Error reading XHR response: " + e.message);
        }
      });
      return origSend.apply(this, arguments);
    };
  };

  try {
      hookFetch();
      hookXHR();
      sendLog("Network hooks installed via initialization script");
  } catch (e) {
      sendLog("Failed to install hooks: " + e.message);
  }

  const normalize = (text) => (text || "").toLowerCase();

  const setValue = (input, value) => {
    if (!input) return false;
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
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
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
  
  const runWithRetry = (fn, maxTries = 40) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const ok = fn();
      if (ok || tries >= maxTries) {
        clearInterval(timer);
      }
    }, 500);
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
      return true;
    }
    return false;
  };

  window.__traeAutoRegister = {
    start: (email) => runWithRetry(() => tryStart(email)),
    complete: (code, password) => runWithRetry(() => tryComplete(code, password))
  };

  // 安装 hooks 并开始定时获取 token
  hookFetch();
  hookXHR();
  tryFetch();
  setInterval(tryFetch, 3000);
  
  sendLog("AutoRegister helper installed");
})();
"#;

    script.replace("__PORT__", &port.to_string())
}

pub async fn wait_for_request_cookies(
    webview: &tauri::webview::WebviewWindow,
    request_url: &str,
    timeout: Duration,
) -> anyhow::Result<String> {
    let parsed_url = normalize_request_url(request_url)
        .ok_or_else(|| anyhow!("URL 无效: {}", request_url))?;
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
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(anyhow!("未能获取 Cookie"))
}

fn normalize_request_url(url: &str) -> Option<Url> {
    let trimmed = url.split('?').next().unwrap_or(url);
    Url::parse("https://www.trae.ai/")
        .ok()?
        .join(trimmed)
        .ok()
}
