import { useRef, useState, useEffect } from "react";
import * as api from "../api";
import type { Account, AppSettings } from "../types";

interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onToast?: (type: "success" | "error" | "warning" | "info", message: string) => void;
  onAccountAdded?: (account: Account) => void;
  quickRegisterShowWindow?: boolean;
  onImportAccounts?: () => void;
  onExportAccounts?: () => void;
  canExport?: boolean;
  settings?: AppSettings | null;
  onSettingsChange?: (settings: AppSettings) => void;
}

type AddMode = "browser" | "register" | "quick-register" | "more";
type MoreSubMode = "trae-ide" | "import-export" | null;
type QuickRegisterStep = "initial" | "qrcode" | "waiting" | "claiming" | "success" | "manual" | "error";

// 注册进度步骤
const REGISTER_STEPS = [
  { percent: 5, message: "正在初始化..." },
  { percent: 15, message: "生成临时邮箱..." },
  { percent: 25, message: "打开注册页面..." },
  { percent: 40, message: "填写注册信息..." },
  { percent: 55, message: "等待验证码..." },
  { percent: 70, message: "验证邮箱..." },
  { percent: 85, message: "获取账号 Token..." },
  { percent: 95, message: "保存账号信息..." },
  { percent: 100, message: "注册完成!" },
];

// 生成随机平台ID
function generatePlatformId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `user_${timestamp}_${random}`;
}

export function AddAccountModal({
  isOpen,
  onClose,
  onToast,
  onAccountAdded,
  quickRegisterShowWindow = true,
  onImportAccounts,
  onExportAccounts,
  canExport = false,
  settings,
  onSettingsChange,
}: AddAccountModalProps) {
  const [mode, setMode] = useState<AddMode>("browser");
  const [moreSubMode, setMoreSubMode] = useState<MoreSubMode>(null);
  const [showMoreDropdown, setShowMoreDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // 浏览器登录表单状态
  const [loginProgress, setLoginProgress] = useState(0);
  const [loginStatus, setLoginStatus] = useState("");
  
  // 快速注册进度状态
  const [registerProgress, setRegisterProgress] = useState(0);
  const [registerStatus, setRegisterStatus] = useState("");
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ===== 扫码领号状态 =====
  const [qrStep, setQrStep] = useState<QuickRegisterStep>("initial");
  const [qrcodeUrl, setQrcodeUrl] = useState("");
  const [ticket, setTicket] = useState("");
  const [qrError, setQrError] = useState("");
  const [countdown, setCountdown] = useState(600);
  const [addedAccounts, setAddedAccounts] = useState<Account[]>([]);
  const [isQrLoading, setIsQrLoading] = useState(false);
  const [manualAccounts, setManualAccounts] = useState<{ account: string; password: string }[]>([]);
  const [availableCount, setAvailableCount] = useState<number | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 清理进度定时器
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, []);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowMoreDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 打开模态框时自动获取剩余账号数量
  useEffect(() => {
    if (isOpen) {
      void fetchStats(true);
    }
  }, [isOpen]);

  // 倒计时效果
  useEffect(() => {
    if (qrStep !== "qrcode" && qrStep !== "waiting") return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setQrError("二维码已过期，请重新获取");
          setQrStep("error");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [qrStep]);

  if (!isOpen) return null;

  // 模拟进度更新
  const startProgressSimulation = () => {
    let currentStep = 0;
    setRegisterProgress(0);
    setRegisterStatus(REGISTER_STEPS[0].message);
    
    progressIntervalRef.current = setInterval(() => {
      currentStep++;
      if (currentStep < REGISTER_STEPS.length) {
        const step = REGISTER_STEPS[currentStep];
        setRegisterProgress(step.percent);
        setRegisterStatus(step.message);
      } else {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
        }
      }
    }, 3000);
  };

  // 停止进度模拟
  const stopProgressSimulation = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setRegisterProgress(0);
    setRegisterStatus("");
  };

  // 重置扫码领号状态
  const resetQrState = () => {
    setQrStep("initial");
    setQrcodeUrl("");
    setTicket("");
    setQrError("");
    setCountdown(600);
    setAddedAccounts([]);
    setManualAccounts([]);
    setIsQrLoading(false);
  };

  const handleReadTraeAccount = async () => {
    setLoading(true);
    setError("");

    try {
      const account = await api.readTraeAccount();
      if (account) {
        onToast?.("success", `成功读取 Trae IDE 账号: ${account.email}`);
        onAccountAdded?.(account);
        handleClose();
      } else {
        setError("未找到 Trae IDE 登录账号或账号已存在");
      }
    } catch (err: any) {
      setError(err.message || "读取 Trae IDE 账号失败");
    } finally {
      setLoading(false);
    }
  };

  // 浏览器自动登录
  const handleBrowserAutoLogin = async () => {
    setLoading(true);
    setError("");
    setLoginProgress(10);
    setLoginStatus("正在打开浏览器...");

    try {
      await api.startBrowserLogin();
      setLoginProgress(30);
      setLoginStatus("请在浏览器中完成登录...");
      
      const account = await api.finishBrowserLogin();
      
      setLoginProgress(100);
      setLoginStatus("登录成功!");
      
      onAccountAdded?.(account);
      
      setTimeout(() => {
        setLoading(false);
        setLoginProgress(0);
        setLoginStatus("");
        onClose();
        onToast?.("success", `登录成功，已导入账号: ${account.email}`);
      }, 800);
    } catch (err: any) {
      setError(err.message || "自动登录失败");
      setLoading(false);
      setLoginProgress(0);
      setLoginStatus("");
    }
  };

  const handleQuickRegister = async () => {
    setLoading(true);
    setError("");
    startProgressSimulation();

    try {
      const account = await api.quickRegisterWithCustomTempMail(quickRegisterShowWindow);
      setRegisterProgress(100);
      setRegisterStatus("注册完成!");
      
      onAccountAdded?.(account);
      
      setTimeout(() => {
        onToast?.("success", `注册成功，已导入账号: ${account.email}`);
        setLoading(false);
        stopProgressSimulation();
        onClose();
      }, 800);
    } catch (err: any) {
      setError(err.message || "快速注册失败");
      setLoading(false);
      stopProgressSimulation();
    }
  };

  // 获取剩余账号数量
  const fetchStats = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastRefreshTime < 10000) {
      onToast?.("warning", "请稍后再刷新");
      return;
    }

    setIsRefreshing(true);
    try {
      const response = await api.getQuickRegisterStats();
      if (response.success) {
        setAvailableCount(response.data.available_count);
        setLastRefreshTime(now);
      }
    } catch (err: any) {
      console.error("获取统计失败:", err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // 获取二维码
  const handleGetQrcode = async () => {
    setIsQrLoading(true);
    setQrError("");

    try {
      const platformId = generatePlatformId();
      const response = await api.createQuickRegisterTask(platformId);
      setTicket(response.ticket);
      setQrcodeUrl(response.qrcode_url);
      setQrStep("qrcode");
      setCountdown(600);
      onToast?.("info", "请使用微信扫描二维码");
    } catch (err: any) {
      setQrError(err.message || "获取二维码失败");
      setQrStep("error");
    } finally {
      setIsQrLoading(false);
    }
  };

  // 开始轮询验证
  const startPolling = async (ticketToUse: string) => {
    if (!ticketToUse) return;

    setQrStep("waiting");

    try {
      const finalStatus = await api.pollTaskVerification(ticketToUse, 600000, 3000);

      setQrStep("claiming");
      onToast?.("success", "验证成功，正在获取账号...");

      let accountsData: { account: string; password: string }[] = [];

      if (finalStatus.status === "claimed" && finalStatus.resource_payload) {
        accountsData = finalStatus.resource_payload;
      } else {
        const resourceResponse = await api.claimResource(ticketToUse);
        if (!resourceResponse.success) {
          throw new Error(resourceResponse.message || "领取资源失败");
        }
        if (resourceResponse.resource_payload) {
          accountsData = resourceResponse.resource_payload;
        }
      }

      if (!accountsData || accountsData.length === 0) {
        setQrError("后端返回的 resource_payload 为空");
        setQrStep("error");
        return;
      }

      const importedAccounts: Account[] = [];

      for (const accountData of accountsData) {
        try {
          const account = await api.addAccountByEmail(
            accountData.account,
            accountData.password
          );
          importedAccounts.push(account);
        } catch (err: any) {
          console.error(`导入账号失败 ${accountData.account}:`, err);
        }
      }

      if (importedAccounts.length > 0) {
        setAddedAccounts(importedAccounts);
        setQrStep("success");
        importedAccounts.forEach(acc => onAccountAdded?.(acc));
        onToast?.("success", `成功导入 ${importedAccounts.length} 个账号`);
      } else {
        setManualAccounts(accountsData);
        setQrStep("manual");
        onToast?.("warning", "自动导入失败，请手动复制账号密码登录");
      }
    } catch (err: any) {
      setQrError(err.message || "验证失败");
      setQrStep("error");
    }
  };

  const handleQrRetry = () => {
    resetQrState();
  };

  // 更新设置
  const handleUpdateSettings = async (newSettings: AppSettings) => {
    try {
      const saved = await api.updateSettings(newSettings);
      onSettingsChange?.(saved);
    } catch (err: any) {
      onToast?.("error", err.message || "更新设置失败");
    }
  };

  const handleClose = () => {
    setError("");
    setMode("browser");
    setMoreSubMode(null);
    setShowMoreDropdown(false);
    setLoginProgress(0);
    setLoginStatus("");
    stopProgressSimulation();
    resetQrState();
    void api.cancelBrowserLogin();
    onClose();
  };

  const handleImport = () => {
    onImportAccounts?.();
    handleClose();
  };

  const handleExport = () => {
    onExportAccounts?.();
    handleClose();
  };

  const handleMoreSelect = (subMode: MoreSubMode) => {
    setMoreSubMode(subMode);
    setMode("more");
    setShowMoreDropdown(false);
  };

  const isConfigComplete = settings?.custom_tempmail_config?.api_url && 
                           settings?.custom_tempmail_config?.secret_key && 
                           settings?.custom_tempmail_config?.email_domain;

  // 处理标签切换
  const handleModeChange = (newMode: AddMode) => {
    setMode(newMode);
    setError("");
    if (newMode !== "quick-register") {
      resetQrState();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content add-account-modal" onClick={(e) => e.stopPropagation()}>
        <div className="add-account-header">
          <h2>添加账号</h2>
          
          {/* 剩余账号数量 - 一直显示在头部 */}
          <div className="available-count-header">
            <span>剩余账号: </span>
            <span className={`count ${availableCount !== null && availableCount > 0 ? 'has-count' : ''}`}>
              {availableCount !== null ? availableCount : "--"}
            </span>
            <button
              onClick={() => fetchStats()}
              disabled={isRefreshing || Date.now() - lastRefreshTime < 10000}
              title={Date.now() - lastRefreshTime < 10000 ? "请稍后再刷新" : "刷新"}
              className={`refresh-btn ${isRefreshing ? 'spinning' : ''}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
          
          {/* 更多下拉菜单 */}
          <div className="more-dropdown-container header-dropdown" ref={dropdownRef}>
            <button
              className="quick-register-btn"
              onClick={() => setShowMoreDropdown(!showMoreDropdown)}
              disabled={loading || isQrLoading}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
                <circle cx="5" cy="12" r="1" />
              </svg>
              更多
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginLeft: '4px'}}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            
            {showMoreDropdown && (
              <div className="more-dropdown-menu dropdown-right">
                <button
                  className={`dropdown-item ${moreSubMode === "trae-ide" ? "active" : ""}`}
                  onClick={() => handleMoreSelect("trae-ide")}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                  从 Trae 读取
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setShowMoreDropdown(false);
                    handleImport();
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  导入账号
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setShowMoreDropdown(false);
                    handleExport();
                  }}
                  disabled={!canExport}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  导出账号
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="add-mode-tabs">
          <button
            className={`mode-tab ${mode === "browser" ? "active" : ""}`}
            onClick={() => handleModeChange("browser")}
            disabled={loading || isQrLoading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            浏览器登录
          </button>
          
          <button
            className={`mode-tab ${mode === "register" ? "active" : ""}`}
            onClick={() => handleModeChange("register")}
            disabled={loading || isQrLoading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            快速注册
          </button>
          
          <button
            className={`mode-tab ${mode === "quick-register" ? "active" : ""}`}
            onClick={() => handleModeChange("quick-register")}
            disabled={loading || isQrLoading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            扫码领号
          </button>
        </div>

        {mode === "browser" ? (
          <div className="trae-ide-mode">
            <div className="mode-description mode-description-compact">
              <div className="mode-icon-wrapper">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </div>
              <h3>浏览器登录</h3>
              <p>打开 Trae 官网登录页面，登录成功后自动导入</p>
            </div>

            {loading && loginProgress > 0 && (
              <div className="register-progress-container" style={{ margin: '0 0 20px' }}>
                <div className="register-progress-status">
                  {loginProgress >= 100 && (
                    <span className="progress-check-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </span>
                  )}
                  {loginStatus}
                </div>
                <div className="register-progress-bar">
                  <div 
                    className="register-progress-fill" 
                    style={{ width: `${loginProgress}%` }}
                  />
                </div>
                <div className="register-progress-percent">{loginProgress}%</div>
              </div>
            )}

            {error && <div className="error-message" style={{ margin: '0 0 16px' }}>{error}</div>}

            {/* 信息提示区域 */}
            <div className="info-section" style={{ flex: 1, marginBottom: '20px' }}>
              <div className="info-item">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <span>系统将自动打开浏览器窗口</span>
              </div>
              <div className="info-item">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>登录信息将自动保存到本地</span>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" onClick={handleClose} disabled={loading}>
                取消
              </button>
              <button 
                type="button" 
                className="primary" 
                onClick={handleBrowserAutoLogin} 
                disabled={loading}
              >
                {loading ? "等待登录..." : "打开登录页面"}
              </button>
            </div>
          </div>
        ) : mode === "register" ? (
          <div className="trae-ide-mode">
            {/* Cloudflare Worker 配置区域 */}
            <div className="config-section">
              <div className="config-section-header">
                <div className="config-icon-wrapper">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <span className="config-title">Cloudflare Worker 配置</span>
                <span className={`config-badge ${isConfigComplete ? 'configured' : 'unconfigured'}`}>
                  {isConfigComplete ? '已配置' : '未配置'}
                </span>
              </div>
              
              <div className="config-field">
                <label className="config-label">Worker URL</label>
                <input
                  type="text"
                  value={settings?.custom_tempmail_config?.api_url || ''}
                  onChange={(e) =>
                    handleUpdateSettings({
                      ...(settings || {} as AppSettings),
                      custom_tempmail_config: {
                        api_url: e.target.value,
                        secret_key: settings?.custom_tempmail_config?.secret_key || '',
                        email_domain: settings?.custom_tempmail_config?.email_domain || '',
                      },
                    })
                  }
                  disabled={loading}
                  placeholder="https://your-worker.your-subdomain.workers.dev"
                  className="config-input"
                />
              </div>

              <div className="config-field">
                <label className="config-label">Secret Key</label>
                <input
                  type="password"
                  value={settings?.custom_tempmail_config?.secret_key || ''}
                  onChange={(e) =>
                    handleUpdateSettings({
                      ...(settings || {} as AppSettings),
                      custom_tempmail_config: {
                        api_url: settings?.custom_tempmail_config?.api_url || '',
                        secret_key: e.target.value,
                        email_domain: settings?.custom_tempmail_config?.email_domain || '',
                      },
                    })
                  }
                  disabled={loading}
                  placeholder="your-secret-key"
                  className="config-input"
                />
              </div>

              <div className="config-field">
                <label className="config-label">邮箱域名</label>
                <input
                  type="text"
                  value={settings?.custom_tempmail_config?.email_domain || ''}
                  onChange={(e) =>
                    handleUpdateSettings({
                      ...(settings || {} as AppSettings),
                      custom_tempmail_config: {
                        api_url: settings?.custom_tempmail_config?.api_url || '',
                        secret_key: settings?.custom_tempmail_config?.secret_key || '',
                        email_domain: e.target.value,
                      },
                    })
                  }
                  disabled={loading}
                  placeholder="example.com"
                  className="config-input"
                />
              </div>
            </div>

            {loading && (
              <div className={`register-progress-container ${registerProgress >= 100 ? 'complete' : ''}`}>
                <div className="register-progress-status">
                  {registerProgress >= 100 && (
                    <span className="progress-check-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </span>
                  )}
                  {registerStatus}
                </div>
                <div className="register-progress-bar">
                  <div 
                    className="register-progress-fill" 
                    style={{ width: `${registerProgress}%` }}
                  />
                </div>
                <div className="register-progress-percent">{registerProgress}%</div>
              </div>
            )}

            {error && <div className="error-message">{error}</div>}

            <div className="modal-actions">
              <button type="button" onClick={handleClose} disabled={loading}>
                取消
              </button>
              <button 
                type="button" 
                className="primary" 
                onClick={handleQuickRegister} 
                disabled={loading || !isConfigComplete}
                title={!isConfigComplete ? '请先配置 Cloudflare Worker' : ''}
              >
                {loading ? "注册中..." : "快速注册并导入"}
              </button>
            </div>
          </div>
        ) : mode === "quick-register" ? (
          // ===== 扫码领号标签页内容 =====
          <div className="trae-ide-mode">
            {/* 初始步骤 */}
            {qrStep === "initial" && (
              <div className="step-content" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div className="mode-description mode-description-compact">
                  <div className="mode-icon-wrapper">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                  </div>
                  <h3>扫码快速获取账号</h3>
                  <p>测试阶段，每次获取1个，每人每天限量10个</p>
                </div>

                {qrError && <div className="error-message" style={{ margin: '0 0 16px' }}>{qrError}</div>}

                {/* 信息提示区域 */}
                <div className="info-section" style={{ flex: 1, marginBottom: '20px' }}>
                  <div className="info-item">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    <span>每人每天限量10个账号</span>
                  </div>
                  <div className="info-item">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    <span>扫码后观看视频即可获取</span>
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={handleClose} disabled={isQrLoading}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={handleGetQrcode}
                    disabled={isQrLoading}
                  >
                    {isQrLoading ? "获取中..." : "获取二维码"}
                  </button>
                </div>
              </div>
            )}

            {/* 展示二维码步骤 */}
            {qrStep === "qrcode" && (
              <div className="step-content">
                <div className="qrcode-section">
                  <div className="qrcode-container">
                    {qrcodeUrl ? (
                      <img src={qrcodeUrl} alt="微信扫码" className="qrcode-image" />
                    ) : (
                      <div className="qrcode-placeholder">加载中...</div>
                    )}
                  </div>
                  <div className="qrcode-info">
                    <p className="qrcode-tip">
                      请使用微信扫描二维码
                      <br />
                      观看视频广告后自动验证
                    </p>
                    <div className="countdown">
                      有效期: <span>{formatCountdown(countdown)}</span>
                    </div>
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={handleQrRetry}>
                    重新获取
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => startPolling(ticket)}
                    disabled={isQrLoading}
                  >
                    已扫码，立即验证
                  </button>
                </div>
              </div>
            )}

            {/* 等待验证步骤 */}
            {qrStep === "waiting" && (
              <div className="step-content">
                <div className="waiting-section">
                  <div className="loading-spinner large"></div>
                  <h3>等待验证完成...</h3>
                  <p>请在微信小程序中完成视频观看</p>
                  <div className="countdown">
                    剩余时间: <span>{formatCountdown(countdown)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 领取资源步骤 */}
            {qrStep === "claiming" && (
              <div className="step-content">
                <div className="waiting-section">
                  <div className="loading-spinner large"></div>
                  <h3>正在获取账号...</h3>
                  <p>验证成功，正在导入账号到本地</p>
                </div>
              </div>
            )}

            {/* 成功步骤 */}
            {qrStep === "success" && (
              <div className="step-content">
                <div className="success-section">
                  <div className="success-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                  <h3>导入成功!</h3>
                  <p>已成功导入 {addedAccounts.length} 个账号</p>
                  <div className="imported-accounts">
                    {addedAccounts.map((account, index) => (
                      <div key={account.id} className="imported-account-item">
                        <span className="account-index">{index + 1}</span>
                        <span className="account-email">{account.email}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" className="primary" onClick={handleClose}>
                    完成
                  </button>
                </div>
              </div>
            )}

            {/* 手动导入步骤 */}
            {qrStep === "manual" && (
              <div className="step-content">
                <div className="manual-accounts" style={{ margin: '0 0 20px' }}>
                  {manualAccounts.map((account, index) => (
                    <div key={index} className="manual-account-item">
                      <div className="account-header">
                        <span className="account-index">{index + 1}</span>
                        <span className="account-label">自动注册失败，请手动复制导入登录</span>
                      </div>
                      <div className="account-info">
                        <div className="info-row">
                          <span className="info-label">邮箱:</span>
                          <code className="info-value">{account.account}</code>
                          <button
                            className="copy-btn"
                            onClick={() => {
                              navigator.clipboard.writeText(account.account);
                              onToast?.("success", "邮箱已复制");
                            }}
                          >
                            复制
                          </button>
                        </div>
                        <div className="info-row">
                          <span className="info-label">密码:</span>
                          <code className="info-value">{account.password}</code>
                          <button
                            className="copy-btn"
                            onClick={() => {
                              navigator.clipboard.writeText(account.password);
                              onToast?.("success", "密码已复制");
                            }}
                          >
                            复制
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={handleClose}>
                    关闭
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      handleClose();
                      onToast?.("info", "请使用「浏览器登录」方式导入账号");
                    }}
                  >
                    去导入账号
                  </button>
                </div>
              </div>
            )}

            {/* 错误步骤 */}
            {qrStep === "error" && (
              <div className="step-content">
                <div className="error-section">
                  <div className="error-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  </div>
                  <h3>出错了</h3>
                  <p>{qrError}</p>
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={handleClose}>
                    关闭
                  </button>
                  <button type="button" className="primary" onClick={handleQrRetry}>
                    重试
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="trae-ide-mode">
            <div className="mode-description">
              <div className="mode-icon-wrapper mode-icon-large">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
              </div>
              <h3>自动检测本地 Trae IDE 账号</h3>
              <p>系统将自动读取本地 Trae IDE 客户端当前登录的账号信息</p>
            </div>

            {error && <div className="error-message">{error}</div>}

            <div className="modal-actions">
              <button type="button" onClick={handleClose} disabled={loading}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleReadTraeAccount}
                disabled={loading}
              >
                {loading ? "读取中..." : "读取本地账号"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
