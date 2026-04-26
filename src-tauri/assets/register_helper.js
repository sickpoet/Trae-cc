(function() {
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
    // 只通过按钮点击提交，不调用 form.submit() 避免页面跳转导致 DOM 销毁
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

  // 检测注册状态（通过页面通知元素和 token 拦截判断）
  const startStatusDetection = () => {
    let attempts = 0;
    const maxAttempts = 45; // 最多检测 45 秒
    let lastStatusText = "";
    let tokenReceived = false;

    // 监听 token 拦截（主判断依据）
    const origSendPayload = sendPayload;
    const tokenListener = (payload) => {
      if (payload && payload.token) {
        tokenReceived = true;
      }
    };

    const checkInterval = setInterval(() => {
      attempts++;

      // 如果已经收到 token，说明注册+登录成功
      if (tokenReceived) {
        sendPayload({ status: "register_success", message: "注册成功，Token 已获取" });
        clearInterval(checkInterval);
        return;
      }

      // 扫描页面上所有可能的 toast/通知元素
      const toastSelectors = [
        '.go3958317564',
        '[class*="toast"]',
        '[class*="Toast"]',
        '[class*="message"]',
        '[class*="notice"]',
        '[class*="alert"]',
        '[role="alert"]',
        '[role="status"]'
      ];
      for (const selector of toastSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (!isVisible(el)) continue;
          const statusText = (el.textContent || "").trim();
          if (!statusText || statusText === lastStatusText) continue;
          // 过滤掉太短或太长的文本
          if (statusText.length < 3 || statusText.length > 200) continue;
          lastStatusText = statusText;
          sendLog("检测到提示: " + statusText);
          const successKeywords = ['success', 'succeed', 'successful', '成功', 'completed', 'done', 'welcome', '欢迎', 'token', 'login'];
          const failKeywords = ['fail', 'error', 'invalid', 'expired', 'wrong', '失败', '错误', '无效', '过期', '验证码', '已过期'];
          const isSuccess = successKeywords.some(k => statusText.toLowerCase().includes(k));
          const isFail = failKeywords.some(k => statusText.toLowerCase().includes(k));
          if (isSuccess) {
            sendPayload({ status: "register_success", message: "注册成功: " + statusText });
            clearInterval(checkInterval);
            return;
          } else if (isFail) {
            sendPayload({ status: "register_failed", message: "注册失败: " + statusText });
            clearInterval(checkInterval);
            return;
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

  // 持续监听 Cookie 弹窗（MutationObserver + 定时检查）
  const cookieObserver = new MutationObserver(() => {
    tryAcceptCookies();
  });
  cookieObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  setInterval(tryAcceptCookies, 2000);

  sendLog("AutoRegister helper installed");
})();
