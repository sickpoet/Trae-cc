import { useRef, useState, useEffect } from "react";
import * as api from "../api";
import type { Account, AppSettings } from "../types";
import type { ErrorCode } from "../types/errorCodes";
import { parseBackendError } from "../types/errorCodes";
import { WorkerSetupGuide } from "./WorkerSetupGuide";
import { ErrorModal } from "./ErrorModal";
import {
  getStoredUserInfo,
  getCurrentOpenid,
  getCurrentPlatformId,
  initOrUpdateUserInfo,
  recordClaim,
  getTodayClaimCount,
  getRemainingClaims,
  savePcToken,
  getPcToken,
  clearPcToken,
  getPcTokenRemainingTime,
  getCurrentVirtualId,
  updateUserVirtualId,
  type StoredUserInfo,
} from "../utils/userStorage";

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
// 新流程步骤：扫码 -> 换取 Token -> 显示用户信息 -> 领取
type QuickRegisterStep = 
  | "initial"      // 初始状态，检查是否有有效 Token
  | "qrcode"       // 展示二维码，等待扫码
  | "waiting"      // 轮询等待验证
  | "exchanging"   // 换取 PC Token 中
  | "verified"     // 已验证，显示用户信息和领取按钮
  | "claiming"     // 领取资源中
  | "success"      // 领取成功
  | "manual"       // 手动导入
  | "error";       // 错误状态

// 历史记录项类型
interface RegisterHistoryItem {
  id: string;
  timestamp: number;
  status: "success" | "failed" | "manual";
  accounts: { account: string; password: string }[];
  errorMessage?: string;
}

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

export function AddAccountModal({
  isOpen,
  onClose,
  onToast,
  onAccountAdded,
  quickRegisterShowWindow = true,
  settings,
  onSettingsChange,
}: AddAccountModalProps) {
  const [mode, setMode] = useState<AddMode>("quick-register");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  
  // Worker 配置教程弹窗状态
  const [showWorkerGuide, setShowWorkerGuide] = useState(false);
  
  // 浏览器登录表单状态
  const [loginProgress, setLoginProgress] = useState(0);
  const [loginStatus, setLoginStatus] = useState("");
  const [browserEmail, setBrowserEmail] = useState("");
  const [browserPassword, setBrowserPassword] = useState("");
  
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

  // 用户信息
  const [, setUserInfo] = useState<StoredUserInfo | null>(null);
  const [todayClaimed, setTodayClaimed] = useState(0);
  const [remainingQuota, setRemainingQuota] = useState(0);
  const [inviteCount, setInviteCount] = useState(0);                    // 邀请人数

  // ===== 新流程状态 =====
  const [, setPcToken] = useState<string | null>(null);                  // PC 绑定令牌
  const [, setUserOpenid] = useState<string | null>(null);               // 当前用户 OpenID
  const [userVirtualId, setUserVirtualId] = useState<string | null>(null); // 当前用户 Virtual ID（显示用）
  const [baseLimit, setBaseLimit] = useState(2);                         // 基础每日限额
  const [bonusLimit, setBonusLimit] = useState(0);                       // 邀请奖励剩余额度
  const [, setTokenCountdown] = useState(600);                           // Token 倒计时
  const [, setCanClaim] = useState(false);                               // 是否可以领取
  const [claimCooldown, setClaimCooldown] = useState(0);                 // 领取按钮冷却时间
  const [, setIsUsingBonusQuota] = useState(false);                      // 是否正在使用邀请奖励额度

  // 历史记录弹窗状态
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [registerHistory, setRegisterHistory] = useState<RegisterHistoryItem[]>([]);

  // 错误弹窗状态
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  
  // ===== 邀请码相关状态 =====
  const [inviteCode, setInviteCode] = useState("");
  const [, setClaimMessage] = useState("");
  const [myInviteCode, setMyInviteCode] = useState("");
  
  // ===== 轮询取消函数 =====
  const cancelPollingRef = useRef<(() => void) | null>(null);

  // 清理进度定时器和轮询
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      // 组件卸载时取消轮询
      if (cancelPollingRef.current) {
        cancelPollingRef.current();
        cancelPollingRef.current = null;
      }
    };
  }, []);

  // 打开模态框时自动获取剩余账号数量
  useEffect(() => {
    if (isOpen) {
      void fetchStats(true);
    }
  }, [isOpen]);

  // 加载用户信息
  useEffect(() => {
    if (isOpen) {
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

        // 如果有 PC Token，从后端获取最新的配额信息
        const fetchUserInfo = async () => {
          try {
            const userResponse = await api.getUserInfo(existingToken);
            if (userResponse.success) {
              const { basic, claim_limit, invitation } = userResponse.data;

              // 更新用户信息
              setUserOpenid(basic.openid);
              setUserVirtualId(basic.virtual_id);
              setTodayClaimed(claim_limit.current_usage);
              setRemainingQuota(claim_limit.remaining);
              setBaseLimit(claim_limit.base_limit);
              setBonusLimit(claim_limit.bonus_limit);
              setInviteCount(invitation?.total_invited || 0);
              setCanClaim(claim_limit.remaining > 0);
              setIsUsingBonusQuota(claim_limit.current_usage >= claim_limit.base_limit && claim_limit.remaining > 0);

              // 更新本地存储
              const platformId = getCurrentPlatformId();
              initOrUpdateUserInfo(basic.openid, platformId, basic.virtual_id);

              // 如果还有剩余次数，自动进入已验证状态
              if (claim_limit.remaining > 0) {
                setQrStep("verified");
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
            onToast?.("error", "获取用户信息失败，请重新扫码");
          }
        };

        void fetchUserInfo();
      } else {
        // 没有 PC Token，使用本地存储的数据
        setTodayClaimed(getTodayClaimCount());
        setRemainingQuota(getRemainingClaims());
      }
    }
  }, [isOpen]);

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

  // 二维码倒计时效果
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

  // Token 有效期倒计时
  useEffect(() => {
    if (qrStep !== "verified") return;

    const timer = setInterval(() => {
      const remaining = getPcTokenRemainingTime();
      if (remaining <= 0) {
        clearInterval(timer);
        // Token 过期，返回初始状态
        setQrStep("initial");
        setQrError("登录已过期，请重新扫码");
        clearPcToken();
        setPcToken(null);
        setTokenCountdown(0);
      } else {
        setTokenCountdown(remaining);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [qrStep]);

  // 领取按钮冷却倒计时
  useEffect(() => {
    if (claimCooldown <= 0) return;

    const timer = setInterval(() => {
      setClaimCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [claimCooldown]);

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

  // 保存历史记录到 localStorage
  const saveHistory = (history: RegisterHistoryItem[]) => {
    localStorage.setItem("quick_register_history", JSON.stringify(history));
    setRegisterHistory(history);
  };

  // 添加历史记录
  const addHistory = (item: Omit<RegisterHistoryItem, "id" | "timestamp">) => {
    const newItem: RegisterHistoryItem = {
      ...item,
      id: Date.now().toString(),
      timestamp: Date.now(),
    };
    const updated = [newItem, ...registerHistory].slice(0, 50); // 最多保留50条
    saveHistory(updated);
  };

  // 显示错误弹窗
  const showErrorModal = (code: ErrorCode, message?: string) => {
    setErrorCode(code);
    setErrorMessage(message || "");
    setErrorModalOpen(true);
  };

  // 关闭错误弹窗
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setErrorCode(null);
    setErrorMessage("");
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
    setInviteCode("");
    setClaimMessage("");
    setMyInviteCode("");
    // 新流程状态重置
    setPcToken(null);
    setUserOpenid(null);
    setUserVirtualId(null);
    setBaseLimit(2);
    setBonusLimit(0);
    setTokenCountdown(600);
    setCanClaim(false);
    setClaimCooldown(0);
    setIsUsingBonusQuota(false);
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
    if (!browserEmail || !browserPassword) {
      setError("请输入邮箱和密码");
      return;
    }

    setLoading(true);
    setError("");
    setLoginProgress(10);
    setLoginStatus("正在打开浏览器...");

    try {
      const account = await api.browserAutoLogin(browserEmail, browserPassword);
      
      setLoginProgress(100);
      setLoginStatus("登录成功!");
      
      onAccountAdded?.(account);
      
      setTimeout(() => {
        setLoading(false);
        setLoginProgress(0);
        setLoginStatus("");
        setBrowserEmail("");
        setBrowserPassword("");
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
      // 获取当前用户的 platformId 和 openid（如果有）
      const platformId = getCurrentPlatformId();
      const openid = getCurrentOpenid();

      // 创建任务（传递 openid 以便后端识别老用户）
      const response = await api.createQuickRegisterTaskWithOpenid({
        platformId,
        openid: openid || undefined,
      });
      setTicket(response.ticket);
      setQrcodeUrl(response.qrcode_url);
      setQrStep("qrcode");
      setCountdown(600);
      onToast?.("info", "请使用微信扫描二维码");
    } catch (err: any) {
      // 解析后端错误码并使用 ErrorModal
      const { code, message } = parseBackendError(err);
      showErrorModal(code, message);
      setQrError(message);
      setQrStep("error");
      // 添加到历史记录
      addHistory({
        status: "failed",
        accounts: [],
        errorMessage: message,
      });
    } finally {
      setIsQrLoading(false);
    }
  };

  // 开始轮询验证（新流程）
  const startPolling = async (ticketToUse: string) => {
    if (!ticketToUse) return;

    setQrStep("waiting");

    // 10秒后自动取消轮询
    const autoCancelTimeout = setTimeout(() => {
      if (cancelPollingRef.current) {
        cancelPollingRef.current();
        cancelPollingRef.current = null;
        setQrStep("qrcode");
        onToast?.("warning", "验证超时，请完成后点击");
      }
    }, 10000); // 10秒

    try {
      // 使用新的轮询 API，支持取消
      const { promise, cancel } = api.pollTaskVerification(ticketToUse, 600000, 3000);
      cancelPollingRef.current = cancel;

      const finalStatus = await promise;

      // 轮询成功，清除取消函数和自动取消定时器
      clearTimeout(autoCancelTimeout);
      cancelPollingRef.current = null;

      // 进入换取 Token 步骤
      setQrStep("exchanging");
      onToast?.("info", "正在换取登录凭证...");

      // ===== 第二步：换取 PC 绑定令牌 =====
      const tokenResponse = await api.exchangePcToken(ticketToUse);
      
      if (!tokenResponse.success || !tokenResponse.pc_bind_token) {
        throw new Error(tokenResponse.message || "换取登录凭证失败");
      }

      // 保存 PC Token（有效期 24 小时）
      savePcToken(tokenResponse.pc_bind_token, 86400);
      setPcToken(tokenResponse.pc_bind_token);

      // ===== 第三步：获取用户信息 =====
      const userResponse = await api.getUserInfo(tokenResponse.pc_bind_token);
      
      if (!userResponse.success) {
        throw new Error(userResponse.message || "获取用户信息失败");
      }

      // 从嵌套数据结构中提取用户信息
      const { basic, claim_limit, invitation } = userResponse.data;
      
      // 保存用户信息
      setUserOpenid(basic.openid);
      setUserVirtualId(basic.virtual_id);  // 保存 virtual_id 用于显示
      setTodayClaimed(claim_limit.current_usage);
      setRemainingQuota(claim_limit.remaining);
      setBaseLimit(claim_limit.base_limit);
      setBonusLimit(claim_limit.bonus_limit);
      setInviteCount(invitation?.total_invited || 0);
      setCanClaim(claim_limit.remaining > 0);

      // 判断是否正在使用邀请奖励额度（基础额度已用完但还有剩余次数）
      setIsUsingBonusQuota(claim_limit.current_usage >= claim_limit.base_limit && claim_limit.remaining > 0);

      // 更新本地存储的用户信息（同时保存 virtualId）
      const platformId = finalStatus.platform_id || getCurrentPlatformId();
      const newUserInfo = initOrUpdateUserInfo(basic.openid, platformId, basic.virtual_id);
      setUserInfo(newUserInfo);
      
      // 保存 virtualId 到本地存储
      updateUserVirtualId(basic.virtual_id);

      // 验证成功，自动领取账号（静默处理）
      onToast?.("success", "身份验证成功，正在自动领取账号...");
      
      // 延迟一下让用户看到提示，然后自动领取
      setTimeout(() => {
        void autoClaimResource();
      }, 1500);

    } catch (err: any) {
      // 用户取消不显示错误
      if (err.message === "用户已取消") {
        return;
      }
      // 解析后端错误码并使用 ErrorModal
      const { code, message } = parseBackendError(err);
      showErrorModal(code, message);
      setQrError(message);
      setQrStep("error");
    }
  };

  // ===== 第四步：自动领取资源（验证成功后自动调用）=====
  const autoClaimResource = async () => {
    const currentToken = getPcToken();
    if (!currentToken) {
      setQrError("登录凭证已过期，请重新扫码");
      setQrStep("error");
      return;
    }

    if (!ticket) {
      setQrError("任务票据无效");
      setQrStep("error");
      return;
    }

    // 检查是否还有剩余额度
    if (remainingQuota <= 0) {
      showErrorModal("DAILY_LIMIT_REACHED");
      return;
    }

    setQrStep("claiming");
    setClaimCooldown(10); // 10 秒冷却

    try {
      const response = await api.claimResourceWithToken(currentToken, {
        ticket,
        invite_code: inviteCode || undefined,
      });

      if (!response.success) {
        // 处理特定的错误码
        if (response.code === "RATE_LIMITED") {
          throw new Error("操作太快了，请 10 秒后再试");
        }
        if (response.code === "DAILY_LIMIT_REACHED") {
          throw new Error("今日额度已用完");
        }
        throw new Error(response.message || "领取资源失败");
      }

      // 保存后端返回的 message
      setClaimMessage(response.message || "");

      // 从 message 中提取用户的专属邀请码
      const inviteCodeMatch = response.message?.match(/您的专属邀请码[：:]\s*([A-Z0-9]+)/i);
      if (inviteCodeMatch) {
        const extractedCode = inviteCodeMatch[1].toUpperCase();
        setMyInviteCode(extractedCode);
        localStorage.setItem('my_invite_code', extractedCode);
      }

      const accountsData = response.resource_payload || [];

      if (accountsData.length === 0) {
        setQrError("后端返回的账号数据为空");
        setQrStep("error");
        return;
      }

      // 导入账号
      const importedAccounts: Account[] = [];
      for (const accountData of accountsData) {
        try {
          // 添加超时处理，避免卡住
          const account = await Promise.race([
            api.addAccountByEmail(
              accountData.account,
              accountData.password
            ),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error("导入账号超时")), 30000)
            )
          ]);
          importedAccounts.push(account);
        } catch (err: any) {
          console.error(`导入账号失败 ${accountData.account}:`, err);
          onToast?.("error", `导入账号 ${accountData.account} 失败: ${err.message || "未知错误"}`);
        }
      }

      if (importedAccounts.length > 0) {
        setAddedAccounts(importedAccounts);
        setQrStep("success");
        // 记录领取
        recordClaim();
        // 更新剩余次数
        setTodayClaimed(prev => prev + 1);
        setRemainingQuota(prev => Math.max(0, prev - 1));
        setCanClaim(remainingQuota > 1);
        
        importedAccounts.forEach(acc => onAccountAdded?.(acc));
        onToast?.("success", `成功导入 ${importedAccounts.length} 个账号`);
        // 添加到历史记录
        addHistory({
          status: "success",
          accounts: accountsData,
        });
      } else {
        setManualAccounts(accountsData);
        setQrStep("manual");
        onToast?.("warning", "自动导入失败，请手动复制账号密码登录");
        addHistory({
          status: "manual",
          accounts: accountsData,
        });
      }
    } catch (err: any) {
      const { code, message } = parseBackendError(err);
      showErrorModal(code, message);
      setQrError(message);
      setQrStep("error");
      addHistory({
        status: "failed",
        accounts: [],
        errorMessage: message,
      });
    }
  };

  // 取消轮询
  const handleCancelPolling = () => {
    if (cancelPollingRef.current) {
      cancelPollingRef.current();
      cancelPollingRef.current = null;
    }
    setQrStep("qrcode");
    onToast?.("info", "已取消验证");
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
    setMode("quick-register");
    setLoginProgress(0);
    setLoginStatus("");
    setBrowserEmail("");
    setBrowserPassword("");
    stopProgressSimulation();
    resetQrState();
    void api.cancelBrowserLogin();
    // 关闭时清除 PC Token（可选：如果希望保持登录状态可以注释掉）
    clearPcToken();
    onClose();
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
          
          {/* 用户信息 - 显示用户ID、今日已领、邀请人数、额外奖励（已隐藏） */}
          {/*
          <div className="user-info-header" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '8px 16px',
            padding: '12px 16px',
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            border: '1px solid var(--border-color)'
          }}>
            <div className="user-info-item" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="label" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>用户ID:</span>
              <span className="value" style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{userVirtualId || "--"}</span>
            </div>
            <div className="user-info-item" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="label" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>邀请人数:</span>
              <span className="value" style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{inviteCount}</span>
            </div>
            <div className="user-info-item" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="label" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>今日已领:</span>
              <span className="value" style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>
                {todayClaimed}/{baseLimit}
                {bonusLimit > 0 && (
                  <span className="bonus-text" style={{ color: '#F97316', marginLeft: '2px' }}>+{bonusLimit}</span>
                )}
              </span>
            </div>
            <div className="user-info-item" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className="label" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>额外奖励:</span>
              <span className="value bonus-value" style={{ fontSize: '13px', fontWeight: 500, color: '#F97316' }}>{bonusLimit}</span>
            </div>
          </div>
          */}
        </div>

        <div className="add-mode-tabs">
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
                <span>系统将自动打开浏览器跳转到 Trae 登录页面</span>
              </div>
              <div className="info-item">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>登录成功后账号将自动导入到本地</span>
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
                {loading ? "等待登录..." : "打开 Trae 登录页面"}
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
                <span 
                  className={`config-badge ${isConfigComplete ? 'configured' : 'unconfigured'}`}
                  onClick={() => setShowWorkerGuide(true)}
                  style={{ cursor: 'pointer' }}
                  title={isConfigComplete ? '点我重新配置' : '点击查看配置教程'}
                >
                  {isConfigComplete ? '点我重新配置' : '去配置'}
                </span>
              </div>
              
              <div className="config-field">
                <label className="config-label">Worker URL</label>
                <input
                  type="text"
                  value={settings?.custom_tempmail_config?.api_url || ''}
                  onChange={(e) => {
                    let url = e.target.value.trim();
                    // 自动添加 https:// 前缀（如果不存在）
                    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
                      url = 'https://' + url;
                    }
                    handleUpdateSettings({
                      ...(settings || {} as AppSettings),
                      custom_tempmail_config: {
                        api_url: url,
                        secret_key: settings?.custom_tempmail_config?.secret_key || '',
                        email_domain: settings?.custom_tempmail_config?.email_domain || '',
                      },
                    });
                  }}
                  disabled={loading}
                  placeholder="your-worker.your-subdomain.workers.dev 或 https://..."
                  className="config-input"
                />
                <small style={{ color: '#888', fontSize: '11px', marginTop: '4px', display: 'block' }}>
                  支持自动补全 https://，只需输入域名即可
                </small>
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
          <div className="trae-ide-mode" style={{ padding: '24px' }}>
            {/* 初始步骤 */}
            {qrStep === "initial" && (
              <div className="step-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* 标题区域 */}
                <div style={{ textAlign: 'center', marginBottom: '8px' }}>
                  <h3 style={{
                    fontSize: '22px',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    marginBottom: '8px',
                    letterSpacing: '-0.5px'
                  }}>
                    扫码快速获取账号
                  </h3>
                  <p style={{
                    fontSize: '14px',
                    color: 'var(--text-secondary)',
                    margin: 0
                  }}>
                    每次获取1个，每日基础额度2个
                  </p>
                </div>



                {qrError && (
                  <div style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '12px',
                    padding: '12px 16px',
                    color: '#dc2626',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    {qrError}
                  </div>
                )}

                {/* 信息提示区域 */}
                <div style={{ 
                  background: '#f8fafc', 
                  borderRadius: '12px', 
                  padding: '16px',
                  border: '1px solid #e2e8f0'
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    marginBottom: '12px'
                  }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: '#dbeafe',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#3b82f6',
                      flexShrink: 0
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '2px' }}>
                        每日限额
                      </div>
                      <div style={{ fontSize: '13px', color: '#64748b' }}>
                        每日基础额度2个，邀请好友可获额外奖励
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: '#d1fae5',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#10b981',
                      flexShrink: 0
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', marginBottom: '2px' }}>
                        领取流程
                      </div>
                      <div style={{ fontSize: '13px', color: '#64748b' }}>
                        扫码后在小程序内完成登录并观看视频后领取
                      </div>
                    </div>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: '12px', marginTop: 'auto' }}>
                  <button 
                    type="button" 
                    onClick={() => setHistoryModalOpen(true)} 
                    disabled={isQrLoading}
                    style={{
                      flex: 1,
                      padding: '14px 20px',
                      borderRadius: '12px',
                      border: '1px solid #e2e8f0',
                      background: 'white',
                      color: '#64748b',
                      fontSize: '14px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    历史记录
                  </button>
                  <button
                    type="button"
                    onClick={handleGetQrcode}
                    disabled={isQrLoading}
                    style={{
                      flex: 2,
                      padding: '14px 20px',
                      borderRadius: '12px',
                      border: 'none',
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      color: 'white',
                      fontSize: '14px',
                      fontWeight: 600,
                      cursor: isQrLoading ? 'not-allowed' : 'pointer',
                      opacity: isQrLoading ? 0.7 : 1,
                      transition: 'all 0.2s',
                      boxShadow: '0 4px 14px rgba(102, 126, 234, 0.4)'
                    }}
                  >
                    {isQrLoading ? (
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                        </svg>
                        获取中...
                      </span>
                    ) : (
                      '获取二维码'
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* 展示二维码步骤 */}
            {qrStep === "qrcode" && (
              <div className="step-content">
                {/* 有效期 */}
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    有效期: <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{formatCountdown(countdown)}</span>
                  </span>
                </div>

                {/* 二维码 */}
                <div className="qrcode-container" style={{ marginBottom: '20px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                  {qrcodeUrl ? (
                    <img src={qrcodeUrl} alt="微信扫码" className="qrcode-image" />
                  ) : (
                    <div className="qrcode-placeholder">加载中...</div>
                  )}
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
                
                <div className="modal-actions" style={{ marginTop: '20px' }}>
                  <button type="button" onClick={handleCancelPolling}>
                    请查看完成后点击
                  </button>
                </div>
              </div>
            )}

            {/* 换取 Token 步骤 */}
            {qrStep === "exchanging" && (
              <div className="step-content">
                <div className="waiting-section">
                  <div className="loading-spinner large"></div>
                  <h3>正在换取登录凭证...</h3>
                  <p>验证成功，正在获取访问令牌</p>
                </div>
              </div>
            )}

            {/* 已验证步骤 - 简化显示，自动领取中 */}
            {qrStep === "verified" && (
              <div className="step-content">
                <div className="waiting-section">
                  <div className="loading-spinner large"></div>
                  <h3>身份验证成功</h3>
                  <p>正在自动领取账号，请稍候...</p>
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
                <div className="success-section" style={{ position: 'relative' }}>
                  <div className="success-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                  <h3>导入成功!</h3>
                  <p>已成功导入 {addedAccounts.length} 个账号</p>

                  {/* 剩余次数提示 */}
                  {remainingQuota > 0 ? (
                    <div style={{
                      background: '#f0fdf4',
                      border: '1px solid #86efac',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      margin: '12px 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      <span style={{ fontSize: '13px', color: '#15803d' }}>
                        今日还可领取 {remainingQuota} 次
                      </span>
                    </div>
                  ) : (
                    <div style={{
                      background: '#fef2f2',
                      border: '1px solid #fecaca',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      margin: '12px 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      <span style={{ fontSize: '13px', color: '#b91c1c' }}>
                        今日次数已用完，请邀请好友获取更多额度
                      </span>
                    </div>
                  )}
                  
                  {/* 我的专属邀请码 */}
                  {myInviteCode && (
                    <div style={{ 
                      background: 'var(--bg-secondary)', 
                      borderRadius: '8px', 
                      padding: '12px', 
                      margin: '12px 0',
                      textAlign: 'center',
                      border: '1px solid var(--border)'
                    }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>我的专属邀请码</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                        <span style={{ 
                          fontSize: '20px', 
                          fontWeight: 700, 
                          color: '#F97316', 
                          letterSpacing: '3px',
                          background: 'var(--bg-input)',
                          padding: '6px 12px',
                          borderRadius: '6px',
                          border: '1px solid var(--border)'
                        }}>
                          {myInviteCode}
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(myInviteCode);
                            onToast?.("success", "邀请码已复制");
                          }}
                          className="copy-btn"
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                        >
                          复制
                        </button>
                      </div>
                      <p style={{ fontSize: '11px', color: '#F97316', marginTop: '6px' }}>
                        分享给好友，双方均可获得额外奖励！
                      </p>
                    </div>
                  )}
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
      
      {/* Worker 配置教程弹窗 */}
      <WorkerSetupGuide 
        isOpen={showWorkerGuide} 
        onClose={() => setShowWorkerGuide(false)} 
      />

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
            handleQrRetry();
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
