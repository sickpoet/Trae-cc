//! 浏览器自动登录模块
//!
//! 打开浏览器让用户手动登录，登录成功后自动提取token

use std::time::Duration;
use anyhow::anyhow;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use warp::Filter;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use crate::{Account, AppState, TraeApiClient};

/// 打开浏览器让用户手动登录，登录成功后自动提取token
pub async fn browser_auto_login(
    app: AppHandle,
    _email: String,
    _password: String,
    state: &AppState,
) -> anyhow::Result<Account> {
    println!("[browser-auto-login] 开始浏览器登录流程");
    println!("[browser-auto-login] 提示用户手动登录...");

    // 创建取消通道
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    {
        let mut cancel_guard = state.browser_login_cancel.lock().await;
        *cancel_guard = Some(cancel_tx);
    }

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
                println!("[browser-login-js] {}", msg);
            }

            let token = query.get("token").cloned().unwrap_or_default();
            let url = query.get("url").cloned().unwrap_or_default();

            if !token.is_empty() {
                println!("[browser-auto-login] 收到Token回调");
                if let Some(tx) = token_sender_route.lock().unwrap().take() {
                    let _ = tx.send((token, url));
                }
                if let Some(tx) = shutdown_sender_route.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                warp::reply::html("已收到 Token，登录成功。".to_string())
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
    println!("[browser-auto-login] 回调服务器启动在端口: {}", port);

    // 准备 Token 拦截脚本
    let init_script = format!(
        r#"
        (function() {{
            if (window.__tokenInterceptorInstalled) return;
            window.__tokenInterceptorInstalled = true;
            
            var callbackUrl = 'http://127.0.0.1:{}/callback';
            
            var sendToken = function(token, url) {{
                if (!token || window.__trae_last_token) return;
                window.__trae_last_token = token;
                console.log('[TokenIntercept] 捕获到 Token:', token.substring(0, 20) + '...');
                var fullUrl = callbackUrl + '?token=' + encodeURIComponent(token) + '&url=' + encodeURIComponent(url);
                if (navigator.sendBeacon) {{
                    navigator.sendBeacon(fullUrl);
                }} else {{
                    fetch(fullUrl, {{ mode: 'no-cors' }});
                }}
            }};
            
            var isValidToken = function(token) {{
                return token && typeof token === 'string' && token.length > 50 && token.split('.').length === 3;
            }};
            
            var parseToken = function(data) {{
                if (!data) return null;
                
                // 尝试多种可能的token位置
                var token = null;
                if (data.token) token = data.token;
                else if (data.Token) token = data.Token;
                else if (data.data && data.data.token) token = data.data.token;
                else if (data.data && data.data.Token) token = data.data.Token;
                else if (data.result && data.result.token) token = data.result.token;
                else if (data.result && data.result.Token) token = data.result.Token;
                else if (typeof data === 'string' && isValidToken(data)) token = data;
                
                if (isValidToken(token)) {{
                    return token;
                }}
                return null;
            }};
            
            // 拦截所有API响应
            var originalFetch = window.fetch;
            window.fetch = async function() {{
                var url = arguments[0];
                var urlStr = typeof url === 'string' ? url : (url.url || '');
                
                try {{
                    var response = await originalFetch.apply(this, arguments);
                    
                    // 检查所有API响应
                    if (urlStr.includes('/api/') || urlStr.includes('token') || urlStr.includes('user') || urlStr.includes('login') || urlStr.includes('auth')) {{
                        console.log('[TokenIntercept] 捕获到API请求:', urlStr);
                        try {{
                            var cloned = response.clone();
                            var data = await cloned.json();
                            var token = parseToken(data);
                            if (token) {{
                                console.log('[TokenIntercept] 成功从Fetch提取Token');
                                sendToken(token, urlStr);
                            }}
                        }} catch (e) {{}}
                    }}
                    return response;
                }} catch (e) {{
                    throw e;
                }}
            }};
            
            // 拦截XHR
            var originalOpen = XMLHttpRequest.prototype.open;
            var originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {{
                this._url = url;
                return originalOpen.apply(this, arguments);
            }};
            XMLHttpRequest.prototype.send = function() {{
                var xhr = this;
                var url = this._url || '';
                if (url.includes('/api/') || url.includes('token') || url.includes('user') || url.includes('login') || url.includes('auth')) {{
                    this.addEventListener('load', function() {{
                        try {{
                            var data = JSON.parse(xhr.responseText);
                            var token = parseToken(data);
                            if (token) {{
                                console.log('[TokenIntercept] 成功从XHR提取Token');
                                sendToken(token, url);
                            }}
                        }} catch (e) {{}}
                    }});
                }}
                return originalSend.apply(this, arguments);
            }};
            
            // 检查所有存储位置
            var checkAllStorage = function() {{
                console.log('[TokenIntercept] 检查所有存储...');
                
                // 检查localStorage
                try {{
                    for (var i = 0; i < localStorage.length; i++) {{
                        var key = localStorage.key(i);
                        var value = localStorage.getItem(key);
                        if (isValidToken(value)) {{
                            console.log('[TokenIntercept] 在localStorage发现Token, key:', key);
                            sendToken(value, 'localStorage:' + key);
                            return;
                        }}
                    }}
                }} catch(e) {{}}
                
                // 检查sessionStorage
                try {{
                    for (var i = 0; i < sessionStorage.length; i++) {{
                        var key = sessionStorage.key(i);
                        var value = sessionStorage.getItem(key);
                        if (isValidToken(value)) {{
                            console.log('[TokenIntercept] 在sessionStorage发现Token, key:', key);
                            sendToken(value, 'sessionStorage:' + key);
                            return;
                        }}
                    }}
                }} catch(e) {{}}
                
                // 检查全局变量
                try {{
                    for (var key in window) {{
                        try {{
                            var value = window[key];
                            if (typeof value === 'string' && isValidToken(value)) {{
                                console.log('[TokenIntercept] 在window发现Token, key:', key);
                                sendToken(value, 'window:' + key);
                                return;
                            }}
                        }} catch(e) {{}}
                    }}
                }} catch(e) {{}}
            }};
            
            // 更频繁地检查
            setTimeout(checkAllStorage, 2000);
            setTimeout(checkAllStorage, 5000);
            setTimeout(checkAllStorage, 10000);
            setTimeout(checkAllStorage, 15000);
            setTimeout(checkAllStorage, 20000);
            setTimeout(checkAllStorage, 30000);
            
            // 持续检查
            setInterval(function() {{
                if (!window.__trae_last_token) {{
                    checkAllStorage();
                }}
            }}, 3000);
            
            console.log('[TokenIntercept] Token 拦截器已安装，等待登录...');
        }})();
        "#,
        port
    );

    // 关闭已存在的窗口
    if let Some(existing) = app.get_webview_window("auto_login") {
        let _: Result<(), _> = existing.destroy();
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // 创建浏览器窗口
    println!("[browser-auto-login] 创建浏览器窗口...");
    let webview = WebviewWindowBuilder::new(
        &app,
        "auto_login",
        WebviewUrl::External(Url::parse("https://www.trae.ai/login").unwrap()),
    )
    .title("请登录 Trae 账号")
    .inner_size(1000.0, 720.0)
    .visible(true)
    .center()
    .initialization_script(&init_script)
    .build()?;

    println!("[browser-auto-login] 等待用户登录...");

    // 等待 token 或取消信号
    let result = tokio::select! {
        res = token_rx => {
            match res {
                Ok((token, _url)) => {
                    println!("[browser-auto-login] 成功获取 Token");
                    Ok(token)
                }
                Err(_) => Err(anyhow!("Token 接收失败")),
            }
        }
        _ = &mut cancel_rx => {
            println!("[browser-auto-login] 登录被取消");
            let _ = webview.destroy();
            Err(anyhow!("登录已取消"))
        }
    };

    // 关闭回调服务器
    if let Some(tx) = shutdown_sender.lock().unwrap().take() {
        let _ = tx.send(());
    }

    // 清除取消信号
    {
        let mut cancel_guard = state.browser_login_cancel.lock().await;
        *cancel_guard = None;
    }

    let token = result?;

    // 获取 Cookies
    println!("[browser-auto-login] 正在获取 Cookies...");
    let cookies = webview.cookies()?;
    let cookies_str = cookies
        .into_iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    println!("[browser-auto-login] 获取到 Cookies");

    // 关闭窗口
    let _ = webview.destroy();

    // 调试：打印 token 信息
    println!("[browser-auto-login] Token 长度: {}", token.len());
    println!("[browser-auto-login] Token 前50字符: {}", &token[..token.len().min(50)]);
    println!("[browser-auto-login] Token 包含的点数: {}", token.matches('.').count());
    
    // 使用 token 创建客户端并获取用户信息
    println!("[browser-auto-login] 获取账号信息...");
    let client = TraeApiClient::new_with_token(&token)?;
    let _user_info = client.get_user_info_by_token().await?;
    
    // 保存账号
    println!("[browser-auto-login] 保存账号...");
    let mut manager = state.account_manager.lock().await;
    
    let account = manager.add_account_by_token(
        token,
        Some(cookies_str),
        None, // 不保存密码，因为是用户手动登录的
    ).await?;

    println!("[browser-auto-login] 账号添加成功: {}", account.email);
    Ok(account)
}
