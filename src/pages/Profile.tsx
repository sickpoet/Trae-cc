import { useEffect, useState, useRef, useCallback } from "react";
import * as api from "../api";
import {
  getStoredUserInfo,
  initOrUpdateUserInfo,
  clearUserInfo,
  getCurrentVirtualId,
  getPcToken,
  clearPcToken,
  getPcTokenRemainingTime,
  recordClaim,
  getTodayClaimCount,
  getRemainingClaims,
  getCurrentPlatformId,
} from "../utils/userStorage";
import type { StoredUserInfo } from "../utils/userStorage";

interface ProfileProps {
  onToast?: (type: "success" | "error" | "warning" | "info", message: string, duration?: number) => void;
}

type QrStep = "initial" | "qrcode" | "waiting" | "exchanging" | "verified" | "claiming" | "success" | "error" | "manual";

export function Profile({ onToast }: ProfileProps) {
  // 用户信息
  const [, setUserInfo] = useState<StoredUserInfo | null>(null);
  const [todayClaimed, setTodayClaimed] = useState(0);
  const [remainingQuota, setRemainingQuota] = useState(0);
  const [baseLimit, setBaseLimit] = useState(2);
  const [bonusLimit, setBonusLimit] = useState(0);
  const [isUsingBonusQuota, setIsUsingBonusQuota] = useState(false);

  // 扫码状态
  const [qrStep, setQrStep] = useState<QrStep>("initial");
  const [qrcodeUrl, setQrcodeUrl] = useState("");
  const [, setTicket] = useState("");
  const [qrError, setQrError] = useState("");
  const [countdown, setCountdown] = useState(600);
  const [isQrLoading, setIsQrLoading] = useState(false);

  // 用户标识
  const [, setPcToken] = useState<string | null>(null);
  const [userOpenid, setUserOpenid] = useState<string | null>(null);
  const [userVirtualId, setUserVirtualId] = useState<string | null>(null);
  const [tokenCountdown, setTokenCountdown] = useState(600);
  const [claimCooldown, setClaimCooldown] = useState(0);

  // 邀请码
  const [inviteCode, setInviteCode] = useState("");
  const [myInviteCode, setMyInviteCode] = useState("");

  // 轮询取消函数
  const cancelPollingRef = useRef<(() => void) | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tokenCountdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const claimCooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 格式化倒计时
  const formatCountdown = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // 清理所有定时器
  const clearAllIntervals = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (tokenCountdownIntervalRef.current) {
      clearInterval(tokenCountdownIntervalRef.current);
      tokenCountdownIntervalRef.current = null;
    }
    if (claimCooldownIntervalRef.current) {
      clearInterval(claimCooldownIntervalRef.current);
      claimCooldownIntervalRef.current = null;
    }
  }, []);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      clearAllIntervals();
      if (cancelPollingRef.current) {
        cancelPollingRef.current();
        cancelPollingRef.current = null;
      }
    };
  }, [clearAllIntervals]);

  // 加载用户信息
  useEffect(() => {
    const stored = getStoredUserInfo();
    setUserInfo(stored);

    // 加载 virtualId
    const storedVirtualId = getCurrentVirtualId();
    if (storedVirtualId) {
      setUserVirtualId(storedVirtualId);
    }

    // 检查是否有有效的 PC Token
    const existingToken = getPcToken();
    if (existingToken) {
      setPcToken(existingToken);
      setTokenCountdown(getPcTokenRemainingTime());

      // 启动 Token 倒计时
      tokenCountdownIntervalRef.current = setInterval(() => {
        setTokenCountdown((prev) => {
          if (prev <= 1) {
            clearPcToken();
            setPcToken(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // 从后端获取最新的配额信息
      const fetchUserInfo = async () => {
        try {
          const userResponse = await api.getUserInfo(existingToken);
          if (userResponse.success) {
            const { basic, claim_limit } = userResponse.data;

            // 更新用户信息
            setUserOpenid(basic.openid);
            setUserVirtualId(basic.virtual_id);
            setTodayClaimed(claim_limit.current_usage);
            setRemainingQuota(claim_limit.remaining);
            setBaseLimit(claim_limit.base_limit);
            setBonusLimit(claim_limit.bonus_limit);
            setIsUsingBonusQuota(claim_limit.current_usage >= claim_limit.base_limit && claim_limit.remaining > 0);

            // 更新本地存储
            const platformId = getCurrentPlatformId();
            initOrUpdateUserInfo(basic.openid, platformId, basic.virtual_id);

            // 如果还有剩余次数，显示已验证状态
            if (claim_limit.remaining >= 0) {
              setQrStep("verified");
            }

            // 获取我的邀请码
            try {
              const inviteResponse = await api.getMyInviteCode(existingToken);
              if (inviteResponse.success) {
                setMyInviteCode(inviteResponse.data.invite_code);
              }
            } catch (e) {
              console.error("获取邀请码失败:", e);
            }
          } else {
            // Token 无效，清除本地状态
            clearPcToken();
            setPcToken(null);
            // 回退到本地存储的数据
            setTodayClaimed(getTodayClaimCount());
            setRemainingQuota(getRemainingClaims());
            onToast?.("warning", "登录已过期，请重新扫码");
          }
        } catch (error) {
          console.error("获取用户信息失败:", error);
          // 回退到本地存储的数据
          setTodayClaimed(getTodayClaimCount());
          setRemainingQuota(getRemainingClaims());
        }
      };

      void fetchUserInfo();
    } else {
      // 没有 PC Token，使用本地存储的数据
      setTodayClaimed(getTodayClaimCount());
      setRemainingQuota(getRemainingClaims());
    }
  }, [onToast]);

  // 获取二维码
  const handleGetQrCode = async () => {
    setIsQrLoading(true);
    setQrError("");
    try {
      const platformId = getCurrentPlatformId();
      const openid = getStoredUserInfo()?.openid;

      const response = await api.createQuickRegisterTaskWithOpenid({
        platformId,
        openid: openid || undefined,
      });

      if (response.success) {
        setQrcodeUrl(response.qrcode_url);
        setTicket(response.ticket);
        setCountdown(600);
        setQrStep("qrcode");

        // 启动倒计时
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
        }
        countdownIntervalRef.current = setInterval(() => {
          setCountdown((prev) => {
            if (prev <= 1) {
              setQrStep("initial");
              return 0;
            }
            return prev - 1;
          });
        }, 1000);

        // 开始轮询扫码状态
        startPolling(response.ticket);
      } else {
        setQrError(response.message || "获取二维码失败");
        onToast?.("error", response.message || "获取二维码失败");
      }
    } catch (error) {
      console.error("获取二维码失败:", error);
      setQrError("获取二维码失败，请重试");
      onToast?.("error", "获取二维码失败，请重试");
    } finally {
      setIsQrLoading(false);
    }
  };

  // 轮询扫码状态
  const startPolling = (ticketValue: string) => {
    setQrStep("waiting");

    // 10秒后自动取消轮询
    const autoCancelTimeout = setTimeout(() => {
      if (cancelPollingRef.current) {
        cancelPollingRef.current();
        cancelPollingRef.current = null;
        setQrStep("qrcode");
        onToast?.("warning", "验证超时，请完成后点击");
      }
    }, 10000);

    try {
      // 使用新的轮询 API，支持取消
      const { promise, cancel } = api.pollTaskVerification(ticketValue, 600000, 3000);
      cancelPollingRef.current = cancel;

      promise
        .then(async () => {
          // 轮询成功，清除取消函数和自动取消定时器
          clearTimeout(autoCancelTimeout);
          cancelPollingRef.current = null;

          // 进入换取 Token 步骤
          setQrStep("exchanging");
          onToast?.("info", "正在换取登录凭证...");

          // 换取 PC Token
          const tokenResponse = await api.exchangePcToken(ticketValue);

          if (!tokenResponse.success || !tokenResponse.pc_bind_token) {
            throw new Error(tokenResponse.message || "换取登录凭证失败");
          }

          const pc_token = tokenResponse.pc_bind_token;
          setPcToken(pc_token);

          // 获取用户信息
          const userResponse = await api.getUserInfo(pc_token);
          if (userResponse.success) {
            const { basic, claim_limit } = userResponse.data;

            setUserOpenid(basic.openid);
            setUserVirtualId(basic.virtual_id);
            setTodayClaimed(claim_limit.current_usage);
            setRemainingQuota(claim_limit.remaining);
            setBaseLimit(claim_limit.base_limit);
            setBonusLimit(claim_limit.bonus_limit);
            setIsUsingBonusQuota(claim_limit.current_usage >= claim_limit.base_limit && claim_limit.remaining > 0);

            // 更新本地存储
            const platformId = getCurrentPlatformId();
            initOrUpdateUserInfo(basic.openid, platformId, basic.virtual_id);

            // 获取我的邀请码
            try {
              const inviteResponse = await api.getMyInviteCode(pc_token);
              if (inviteResponse.success) {
                setMyInviteCode(inviteResponse.data.invite_code);
              }
            } catch (e) {
              console.error("获取邀请码失败:", e);
            }

            // 启动 Token 倒计时
            setTokenCountdown(getPcTokenRemainingTime());
            if (tokenCountdownIntervalRef.current) {
              clearInterval(tokenCountdownIntervalRef.current);
            }
            tokenCountdownIntervalRef.current = setInterval(() => {
              setTokenCountdown((prev) => {
                if (prev <= 1) {
                  clearPcToken();
                  setPcToken(null);
                  return 0;
                }
                return prev - 1;
              });
            }, 1000);

            setQrStep("verified");
            onToast?.("success", "身份验证成功");
          } else {
            throw new Error(userResponse.message || "获取用户信息失败");
          }
        })
        .catch((error) => {
          clearTimeout(autoCancelTimeout);
          if (error.message === "用户已取消") {
            return;
          }
          console.error("验证失败:", error);
          setQrStep("qrcode");
          setQrError(error.message || "验证失败，请重试");
          onToast?.("error", error.message || "验证失败，请重试");
        });
    } catch (error) {
      clearTimeout(autoCancelTimeout);
      console.error("启动轮询失败:", error);
      setQrStep("initial");
      setQrError("启动验证失败，请重试");
      onToast?.("error", "启动验证失败，请重试");
    }
  };

  // 重新扫码
  const handleQrRetry = () => {
    // 清除之前的轮询
    if (cancelPollingRef.current) {
      cancelPollingRef.current();
      cancelPollingRef.current = null;
    }
    clearAllIntervals();

    // 清除用户状态
    clearPcToken();
    setPcToken(null);
    clearUserInfo();
    setUserInfo(null);
    setUserOpenid(null);
    setUserVirtualId(null);
    setTodayClaimed(0);
    setRemainingQuota(2);
    setBaseLimit(2);
    setBonusLimit(0);
    setIsUsingBonusQuota(false);
    setMyInviteCode("");
    setInviteCode("");

    setQrStep("initial");
    setQrError("");
  };

  // 领取资源
  const handleClaimResource = async () => {
    const token = getPcToken();
    if (!token) {
      onToast?.("error", "请先完成身份验证");
      return;
    }

    if (remainingQuota <= 0) {
      onToast?.("warning", "今日额度已用完");
      return;
    }

    setQrStep("claiming");

    try {
      const response = await api.claimResourceWithToken(token, {
        ticket: "", // 新流程不需要 ticket
        invite_code: inviteCode || undefined,
      });

      if (response.success && response.resource_payload && response.resource_payload.length > 0) {
        // 更新本地领取记录
        recordClaim();

        // 更新状态
        const newClaimed = todayClaimed + 1;
        const newRemaining = Math.max(0, remainingQuota - 1);
        setTodayClaimed(newClaimed);
        setRemainingQuota(newRemaining);
        setIsUsingBonusQuota(newClaimed > baseLimit && newRemaining > 0);

        // 清空邀请码
        setInviteCode("");

        // 启动领取冷却
        setClaimCooldown(5);
        if (claimCooldownIntervalRef.current) {
          clearInterval(claimCooldownIntervalRef.current);
        }
        claimCooldownIntervalRef.current = setInterval(() => {
          setClaimCooldown((prev) => {
            if (prev <= 1) {
              return 0;
            }
            return prev - 1;
          });
        }, 1000);

        setQrStep("verified");
        const account = response.resource_payload[0];
        onToast?.("success", `领取成功！账号: ${account.account}`);
      } else {
        setQrStep("verified");
        onToast?.("error", response.message || "领取失败");
      }
    } catch (error: any) {
      console.error("领取资源失败:", error);
      setQrStep("verified");
      onToast?.("error", error.message || "领取失败，请重试");
    }
  };

  // 复制邀请码
  const handleCopyInviteCode = async () => {
    if (!myInviteCode) return;
    try {
      await navigator.clipboard.writeText(myInviteCode);
      onToast?.("success", "邀请码已复制");
    } catch (e) {
      onToast?.("error", "复制失败");
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">个人中心</h1>
        <p className="page-subtitle">管理您的身份验证和领取额度</p>
      </div>

      <div className="profile-content">
        {/* 身份验证卡片 */}
        <div className="profile-card">
          <div className="profile-card-header">
            <div className="profile-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </div>
            <h2>身份验证</h2>
          </div>

          <div className="profile-card-body">
            {qrStep === "initial" && (
              <div className="profile-initial-state">
                <div className="profile-illustration">
                  <svg viewBox="0 0 120 120" fill="none">
                    <circle cx="60" cy="60" r="50" fill="var(--bg-secondary)"/>
                    <rect x="35" y="40" width="50" height="50" rx="8" fill="var(--accent)" opacity="0.2"/>
                    <rect x="40" y="35" width="50" height="50" rx="8" fill="var(--accent)" opacity="0.4"/>
                    <rect x="45" y="30" width="50" height="50" rx="8" fill="var(--accent)"/>
                    <path d="M60 45v20M50 55h20" stroke="white" strokeWidth="3" strokeLinecap="round"/>
                  </svg>
                </div>
                <p className="profile-description">
                  扫码完成身份验证，获取每日领取额度
                </p>
                <button
                  className="profile-primary-btn"
                  onClick={handleGetQrCode}
                  disabled={isQrLoading}
                >
                  {isQrLoading ? (
                    <span className="profile-loading">
                      <svg className="profile-spinner" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="31.416" strokeDashoffset="10"/>
                      </svg>
                      加载中...
                    </span>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <path d="M8 8h2v2H8zM14 8h2v2h-2zM8 14h2v2H8z"/>
                      </svg>
                      获取二维码
                    </>
                  )}
                </button>
                {qrError && <p className="profile-error">{qrError}</p>}
              </div>
            )}

            {qrStep === "qrcode" && (
              <div className="profile-qrcode-state">
                <div className="profile-qrcode-container">
                  {qrcodeUrl ? (
                    <img src={qrcodeUrl} alt="扫码二维码" className="profile-qrcode" />
                  ) : (
                    <div className="profile-qrcode-placeholder">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="7" height="7" rx="1"/>
                        <rect x="14" y="3" width="7" height="7" rx="1"/>
                        <rect x="3" y="14" width="7" height="7" rx="1"/>
                        <path d="M14 14h7v7h-7z"/>
                      </svg>
                    </div>
                  )}
                  <div className="profile-countdown">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    {formatCountdown(countdown)}
                  </div>
                </div>
                <p className="profile-hint">请使用微信扫描上方二维码</p>
                <button className="profile-secondary-btn" onClick={handleQrRetry}>
                  取消
                </button>
              </div>
            )}

            {qrStep === "waiting" && (
              <div className="profile-waiting-state">
                <div className="profile-status-icon profile-status-success">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <h3>扫码成功</h3>
                <p>请在手机上确认登录</p>
                <div className="profile-loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}

            {qrStep === "verified" && (
              <div className="profile-verified-state">
                <div className="profile-user-header">
                  <div className="profile-avatar">
                    {userVirtualId?.charAt(0).toUpperCase() || "U"}
                  </div>
                  <div className="profile-user-info">
                    <h3>身份验证成功</h3>
                    <p className="profile-user-id">
                      用户编号: {userVirtualId || `${userOpenid?.substring(0, 12)}...`}
                    </p>
                  </div>
                </div>

                <div className="profile-stats">
                  <div className="profile-stat-item">
                    <span className="profile-stat-label">每日基础额度</span>
                    <span className="profile-stat-value">{baseLimit} 次</span>
                  </div>

                  {bonusLimit > 0 && (
                    <div className="profile-stat-item">
                      <span className="profile-stat-label">邀请奖励剩余</span>
                      <span className="profile-stat-value profile-stat-highlight">{bonusLimit} 次</span>
                    </div>
                  )}

                  <div className="profile-stat-item">
                    <span className="profile-stat-label">今日已领取</span>
                    <span className={`profile-stat-value ${todayClaimed >= baseLimit ? "profile-stat-danger" : "profile-stat-success"}`}>
                      {todayClaimed} 次
                    </span>
                  </div>

                  <div className="profile-stat-item profile-stat-total">
                    <span className="profile-stat-label">当前剩余次数</span>
                    <span className={`profile-stat-value profile-stat-large ${remainingQuota > 0 ? "profile-stat-success" : "profile-stat-danger"}`}>
                      {remainingQuota} 次
                    </span>
                  </div>
                </div>

                {isUsingBonusQuota && (
                  <div className="profile-bonus-notice">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v20M2 12h20"/>
                    </svg>
                    基础额度已用完，当前正在消耗邀请奖励额度
                  </div>
                )}

                <div className="profile-token-info">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                  登录有效期剩余: {formatCountdown(tokenCountdown)}
                </div>

                {remainingQuota > 0 && (
                  <div className="profile-invite-section">
                    <input
                      type="text"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value.toUpperCase().trim())}
                      placeholder="邀请码（选填）"
                      maxLength={6}
                      disabled={claimCooldown > 0}
                      className="profile-invite-input"
                    />
                    <p className="profile-invite-hint">输入邀请码可获得额外奖励</p>
                  </div>
                )}

                <div className="profile-actions">
                  <button className="profile-secondary-btn" onClick={handleQrRetry}>
                    重新扫码
                  </button>
                  {remainingQuota > 0 ? (
                    <button
                      className="profile-primary-btn"
                      onClick={handleClaimResource}
                      disabled={claimCooldown > 0}
                    >
                      {claimCooldown > 0 ? `等待 ${claimCooldown}s` : "立即领取账号"}
                    </button>
                  ) : (
                    <button className="profile-disabled-btn" disabled>
                      今日额度已用完
                    </button>
                  )}
                </div>

                {myInviteCode && (
                  <div className="profile-my-invite">
                    <span>我的邀请码: <strong>{myInviteCode}</strong></span>
                    <button onClick={handleCopyInviteCode} className="profile-copy-btn">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      复制
                    </button>
                  </div>
                )}
              </div>
            )}

            {qrStep === "claiming" && (
              <div className="profile-claiming-state">
                <div className="profile-loading-spinner">
                  <svg viewBox="0 0 50 50">
                    <circle cx="25" cy="25" r="20" fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeDasharray="80" strokeDashoffset="20">
                      <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                </div>
                <h3>正在领取账号...</h3>
                <p>请稍候</p>
              </div>
            )}
          </div>
        </div>

        {/* 使用说明卡片 */}
        <div className="profile-card profile-info-card">
          <div className="profile-card-header">
            <div className="profile-card-icon profile-card-icon-info">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </div>
            <h2>使用说明</h2>
          </div>
          <div className="profile-card-body">
            <div className="profile-info-list">
              <div className="profile-info-item">
                <div className="profile-info-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                </div>
                <div className="profile-info-content">
                  <h4>每日限额</h4>
                  <p>每日基础额度 2 个，邀请好友可获额外奖励</p>
                </div>
              </div>
              <div className="profile-info-item">
                <div className="profile-info-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <div className="profile-info-content">
                  <h4>领取流程</h4>
                  <p>扫码后在小程序内完成登录并观看视频后领取</p>
                </div>
              </div>
              <div className="profile-info-item">
                <div className="profile-info-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  </svg>
                </div>
                <div className="profile-info-content">
                  <h4>邀请好友</h4>
                  <p>分享您的邀请码，好友使用后可获得额外领取次数</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
