import { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import type { Account } from "../types";
import type { ErrorCode } from "../types/errorCodes";
import { parseBackendError } from "../types/errorCodes";
import { ErrorModal } from "./ErrorModal";

interface QuickRegisterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onToast?: (type: "success" | "error" | "warning" | "info", message: string) => void;
  onAccountsAdded?: (accounts: Account[]) => void;
}

type RegisterStep = "initial" | "qrcode" | "waiting" | "claiming" | "success" | "manual" | "error";

// 历史记录项类型
interface RegisterHistoryItem {
  id: string;
  timestamp: number;
  status: "success" | "failed" | "manual";
  accounts: { account: string; password: string }[];
  errorMessage?: string;
}

// 生成随机平台ID
function generatePlatformId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `user_${timestamp}_${random}`;
}

export function QuickRegisterModal({
  isOpen,
  onClose,
  onToast,
  onAccountsAdded,
}: QuickRegisterModalProps) {
  const [step, setStep] = useState<RegisterStep>("initial");
  const [qrcodeUrl, setQrcodeUrl] = useState("");
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(600); // 10分钟倒计时
  const [addedAccounts, setAddedAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // 手动导入的账号数据（自动导入失败时使用）
  const [manualAccounts, setManualAccounts] = useState<{ account: string; password: string }[]>([]);

  // 错误弹窗状态
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  // 历史记录弹窗状态
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [registerHistory, setRegisterHistory] = useState<RegisterHistoryItem[]>([]);

  // 剩余账号数量统计
  const [availableCount, setAvailableCount] = useState<number | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 重置状态
  const resetState = useCallback(() => {
    setStep("initial");
    setQrcodeUrl("");
    setTicket("");
    setError("");
    setCountdown(600);
    setAddedAccounts([]);
    setManualAccounts([]);
    setIsLoading(false);
  }, []);

  // 关闭弹窗
  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  // 加载历史记录
  useEffect(() => {
    const saved = localStorage.getItem("quick_register_history");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setRegisterHistory(parsed);
      } catch (e) {
        console.error("解析历史记录失败:", e);
      }
    }
  }, []);

  // 保存历史记录到 localStorage
  const saveHistory = useCallback((history: RegisterHistoryItem[]) => {
    localStorage.setItem("quick_register_history", JSON.stringify(history));
    setRegisterHistory(history);
  }, []);

  // 添加历史记录
  const addHistory = useCallback((item: Omit<RegisterHistoryItem, "id" | "timestamp">) => {
    const newItem: RegisterHistoryItem = {
      ...item,
      id: Date.now().toString(),
      timestamp: Date.now(),
    };
    const updated = [newItem, ...registerHistory].slice(0, 50); // 最多保留50条
    saveHistory(updated);
  }, [registerHistory, saveHistory]);

  // 获取剩余账号数量统计
  const fetchStats = useCallback(async (force = false) => {
    const now = Date.now();
    // 限制10秒内只能刷新一次
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
  }, [lastRefreshTime, onToast]);

  // 打开弹窗时自动刷新统计（只执行一次）
  useEffect(() => {
    if (isOpen && step === "initial" && availableCount === null) {
      fetchStats(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, step]);

  // 倒计时效果
  useEffect(() => {
    if (step !== "qrcode" && step !== "waiting") return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setError("二维码已过期，请重新获取");
          setStep("error");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [step]);

  // 格式化倒计时
  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // 显示错误弹窗
  const showErrorModal = useCallback((code: ErrorCode, message?: string) => {
    setErrorCode(code);
    setErrorMessage(message || "");
    setErrorModalOpen(true);
  }, []);

  // 关闭错误弹窗
  const closeErrorModal = useCallback(() => {
    setErrorModalOpen(false);
    setErrorCode(null);
    setErrorMessage("");
  }, []);

  // 开始快速注册流程 - 直接获取二维码
  const handleGetQrcode = async () => {
    setIsLoading(true);
    setError("");

    try {
      // 生成随机平台ID
      const platformId = generatePlatformId();

      // 创建任务
      const response = await api.createQuickRegisterTask(platformId);
      setTicket(response.ticket);
      setQrcodeUrl(response.qrcode_url);
      setStep("qrcode");
      setCountdown(600); // 重置倒计时
      onToast?.("info", "请使用微信扫描二维码");
    } catch (err: any) {
      // 解析后端错误码
      const { code, message } = parseBackendError(err);
      showErrorModal(code, message);
      setError(message);
      setStep("error");
    } finally {
      setIsLoading(false);
    }
  };

  // 开始轮询验证状态
  const startPolling = useCallback(async (ticketToUse: string) => {
    if (!ticketToUse) return;

    setStep("waiting");
    console.log("开始轮询验证状态，ticket:", ticketToUse);

    try {
      // 轮询等待验证完成，返回最终状态
      const finalStatus = await api.pollTaskVerification(ticketToUse, 600000, 3000);
      console.log("轮询结束，最终状态:", finalStatus);

      // 验证成功，开始领取资源
      setStep("claiming");
      onToast?.("success", "验证成功，正在获取账号...");

      let accountsData: { account: string; password: string }[] = [];

      // 如果状态是 claimed 且查询结果中已有资源数据，直接使用
      if (finalStatus.status === "claimed" && finalStatus.resource_payload) {
        console.log("从查询状态获取资源数据:", finalStatus.resource_payload);
        accountsData = finalStatus.resource_payload;
      } else {
        // 否则调用领取资源接口
        const resourceResponse = await api.claimResource(ticketToUse);
        console.log("领取资源响应:", resourceResponse);

        // 检查响应是否成功
        if (!resourceResponse.success) {
          throw new Error(resourceResponse.message || "领取资源失败");
        }

        if (resourceResponse.resource_payload) {
          accountsData = resourceResponse.resource_payload;
        }
      }

      // 检查是否有账号数据
      if (!accountsData || accountsData.length === 0) {
        setError("后端返回的 resource_payload 为空。请检查后端 claim_resource 接口是否正确返回账号数据。");
        setStep("error");
        return;
      }

      // 导入账号
      const importedAccounts: Account[] = [];

      for (const accountData of accountsData) {
        try {
          // 使用邮箱密码登录导入账号
          const account = await api.addAccountByEmail(
            accountData.account,
            accountData.password
          );
          importedAccounts.push(account);
        } catch (err: any) {
          console.error(`导入账号失败 ${accountData.account}:`, err);
          // 继续尝试导入其他账号
        }
      }

      if (importedAccounts.length > 0) {
        setAddedAccounts(importedAccounts);
        setStep("success");
        onAccountsAdded?.(importedAccounts);
        onToast?.(
          "success",
          `成功导入 ${importedAccounts.length} 个账号`
        );
        // 添加到历史记录
        addHistory({
          status: "success",
          accounts: accountsData,
        });
      } else {
        // 自动导入失败，显示手动导入界面
        setManualAccounts(accountsData);
        setStep("manual");
        onToast?.("warning", "自动导入失败，请手动复制账号密码登录");
        // 添加到历史记录
        addHistory({
          status: "manual",
          accounts: accountsData,
        });
      }
    } catch (err: any) {
      console.error("轮询或领取资源失败:", err);
      // 解析后端错误码
      const { code, message } = parseBackendError(err);
      showErrorModal(code, message);
      setError(message);
      setStep("error");
      // 添加到历史记录
      addHistory({
        status: "failed",
        accounts: [],
        errorMessage: message,
      });
    }
  }, [onToast, onAccountsAdded, showErrorModal, addHistory]);

  // 重新获取二维码
  const handleRetry = () => {
    resetState();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal-content quick-register-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="quick-register-header">
          <h2>快速注册</h2>
          <div className="header-actions">
            <button
              className="history-btn"
              onClick={() => setHistoryModalOpen(true)}
              title="查看历史记录"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              历史
            </button>
            <button className="close-btn" onClick={handleClose}>
              ×
            </button>
          </div>
        </div>

        {/* 剩余账号数量显示 - 完全透明背景 */}
        {step === "initial" && (
          <div style={{ 
            display: 'flex', 
            justifyContent: 'center',
            alignItems: 'center',
            padding: '4px 0',
            margin: '0 24px 8px',
            background: 'transparent'
          }}>
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              background: 'transparent'
            }}>
              剩余账号: 
              <span style={{
                fontWeight: 600,
                color: availableCount !== null && availableCount > 0 ? 'var(--accent)' : 'var(--text-muted)',
                background: 'transparent'
              }}>
                {availableCount !== null ? availableCount : "加载中..."}
              </span>
              <button
                onClick={() => fetchStats()}
                disabled={isRefreshing || Date.now() - lastRefreshTime < 10000}
                title={Date.now() - lastRefreshTime < 10000 ? "请稍后再刷新" : "刷新"}
                style={{
                  width: '16px',
                  height: '16px',
                  border: 'none',
                  background: 'transparent',
                  cursor: isRefreshing || Date.now() - lastRefreshTime < 10000 ? 'not-allowed' : 'pointer',
                  opacity: isRefreshing || Date.now() - lastRefreshTime < 10000 ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  marginLeft: '2px'
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isRefreshing ? "spinning" : ""}>
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </span>
          </div>
        )}

        <div className="quick-register-body">
          {/* 步骤指示器 */}
          <div className="step-indicator">
            <div className={`step ${step === "initial" ? "active" : ""}`}>
              <div className="step-number">1</div>
              <div className="step-label">获取二维码</div>
            </div>
            <div className="step-line"></div>
            <div
              className={`step ${step === "qrcode" || step === "waiting" ? "active" : ""}`}
            >
              <div className="step-number">2</div>
              <div className="step-label">扫码验证</div>
            </div>
            <div className="step-line"></div>
            <div
              className={`step ${step === "claiming" || step === "success" ? "active" : ""}`}
            >
              <div className="step-number">3</div>
              <div className="step-label">导入账号</div>
            </div>
          </div>

          {/* 初始步骤 - 获取二维码 */}
          {step === "initial" && (
            <div className="step-content">
              <div className="mode-description" style={{ minHeight: 'auto', padding: '24px' }}>
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                <h3>扫码快速获取账号，测试阶段，每次获取1个，每人每天限量10个</h3>
                <p>点击获取二维码,点击立即获取资源，即可自动获得1个账号</p>
              </div>

              {error && <div className="error-message" style={{ margin: '0 0 16px' }}>{error}</div>}

              <div className="modal-actions">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isLoading}
                  className="secondary"
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={handleGetQrcode}
                  disabled={isLoading}
                >
                  {isLoading ? "获取中..." : "获取二维码"}
                </button>
              </div>
            </div>
          )}

          {/* 展示二维码步骤 */}
          {step === "qrcode" && (
            <div className="step-content">
              <div className="qrcode-section">
                <div className="qrcode-container">
                  {qrcodeUrl ? (
                    <img
                      src={qrcodeUrl}
                      alt="微信扫码"
                      className="qrcode-image"
                    />
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
                <button
                  type="button"
                  onClick={handleRetry}
                  className="secondary"
                >
                  重新获取
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => startPolling(ticket)}
                  disabled={isLoading}
                >
                  已扫码，立即验证
                </button>
              </div>
            </div>
          )}

          {/* 等待验证步骤 */}
          {step === "waiting" && (
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
          {step === "claiming" && (
            <div className="step-content">
              <div className="claiming-section">
                <div className="loading-spinner large"></div>
                <h3>正在获取账号...</h3>
                <p>验证成功，正在导入账号到本地</p>
              </div>
            </div>
          )}

          {/* 成功步骤 */}
          {step === "success" && (
            <div className="step-content">
              <div className="success-section">
                <div className="success-icon">✓</div>
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
          {step === "manual" && (
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
                <button
                  type="button"
                  onClick={handleClose}
                  className="secondary"
                >
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
          {step === "error" && (
            <div className="step-content">
              <div className="error-section">
                <div className="error-icon">✗</div>
                <h3>出错了</h3>
                <p>{error}</p>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  onClick={handleClose}
                  className="secondary"
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={handleRetry}
                >
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 错误弹窗 */}
      <ErrorModal
        isOpen={errorModalOpen}
        errorCode={errorCode}
        customMessage={errorMessage}
        onClose={closeErrorModal}
        onAction={() => {
          closeErrorModal();
          // 根据错误类型执行不同操作
          if (errorCode === "DAILY_LIMIT_REACHED") {
            handleClose();
          } else if (errorCode === "RESOURCE_EMPTY" || errorCode === "TASK_EXPIRED") {
            handleRetry();
          }
        }}
      />

      {/* 历史记录弹窗 */}
      {historyModalOpen && (
        <div className="modal-overlay" onClick={() => setHistoryModalOpen(false)}>
          <div
            className="modal-content history-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="quick-register-header">
              <h2>历史记录</h2>
              <button className="close-btn" onClick={() => setHistoryModalOpen(false)}>
                ×
              </button>
            </div>
            <div className="history-content">
              {registerHistory.length === 0 ? (
                <div className="history-empty">暂无历史记录</div>
              ) : (
                <div className="history-list">
                  {registerHistory.map((item) => (
                    <div key={item.id} className={`history-item ${item.status}`}>
                      <div className="history-header">
                        <span className={`history-status ${item.status}`}>
                          {item.status === "success" ? "✓ 成功" : item.status === "manual" ? "⚠ 手动" : "✗ 失败"}
                        </span>
                        <span className="history-time">
                          {new Date(item.timestamp).toLocaleString()}
                        </span>
                      </div>
                      {item.accounts.length > 0 && (
                        <div className="history-accounts">
                          {item.accounts.map((acc, idx) => (
                            <div key={idx} className="history-account">
                              <div className="history-account-row">
                                <span className="label">账号:</span>
                                <code>{acc.account}</code>
                                <button
                                  className="copy-btn small"
                                  onClick={() => {
                                    navigator.clipboard.writeText(acc.account);
                                    onToast?.("success", "邮箱已复制");
                                  }}
                                >
                                  复制
                                </button>
                              </div>
                              <div className="history-account-row">
                                <span className="label">密码:</span>
                                <code>{acc.password}</code>
                                <button
                                  className="copy-btn small"
                                  onClick={() => {
                                    navigator.clipboard.writeText(acc.password);
                                    onToast?.("success", "密码已复制");
                                  }}
                                >
                                  复制
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {item.errorMessage && (
                        <div className="history-error">{item.errorMessage}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
