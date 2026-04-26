import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { Sidebar } from "./components/Sidebar";
import { AccountCard } from "./components/AccountCard";
import { AccountListItem } from "./components/AccountListItem";
import { AddAccountModal } from "./components/AddAccountModal";
import { ContextMenu } from "./components/ContextMenu";
import { DetailModal } from "./components/DetailModal";
import { AccountLoginModal } from "./components/AccountLoginModal";
import { Toast, ToastMessage } from "./components/Toast";
import { ConfirmModal } from "./components/ConfirmModal";
import { UpdateModal } from "./components/UpdateModal";
import { Stats } from "./pages/Stats";
import { Settings } from "./pages/Settings";
import { About } from "./pages/About";
import { useDebounce } from "./hooks/useDebounce";
import { useToast } from "./hooks/useToast";
import { SearchIcon, ChevronDownIcon, GridIcon, ListIcon, RefreshIcon, TrashIcon, MoreIcon, DownloadIcon, UploadIcon, DeleteWithLineIcon } from "./components/Icons";

import * as api from "./api";
import type { Account, AccountBrief, AppSettings, UsageSummary } from "./types";
import { checkForUpdate, openDownloadPage } from "./utils/updateChecker";
import type { UpdateInfo } from "./utils/updateChecker";
import "./App.css";

interface AccountWithUsage extends AccountBrief {
  usage?: UsageSummary | null;
  password?: string | null;
}

type ViewMode = "grid" | "list";
const USAGE_CACHE_KEY = "trae_usage_cache_v1";

function App() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [currentPage, setCurrentPage] = useState("accounts");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [emailFilter, setEmailFilter] = useState("");
  const debouncedEmailFilter = useDebounce(emailFilter, 250);
  const [quotaFilter, setQuotaFilter] = useState<"all" | "with" | "without">("all");
  const [showBatchDropdown, setShowBatchDropdown] = useState(false);

  // Toast 通知
  const { toasts, addToast, removeToast } = useToast();

  // 确认弹窗状态
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: "danger" | "warning" | "info";
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
  } | null>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    accountId: string;
  } | null>(null);

  // 详情弹窗状态
  const [detailAccount, setDetailAccount] = useState<AccountWithUsage | null>(null);

  // 刷新中的账号 ID
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());

  // 重新登录弹窗状态
  const [loginModal, setLoginModal] = useState<{
    accountId: string;
    accountName: string;
    initialEmail?: string;
  } | null>(null);

  // 更新弹窗状态
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const quickRegisterNoticeRef = useRef<Map<string, number>>(new Map());
  const quickRegisterShowWindow = appSettings?.quick_register_show_window ?? false;
  const batchDropdownRef = useRef<HTMLDivElement>(null);

  // 网络状态监听
  const offlineToastIdRef = useRef<string | null>(null);

  // 点击外部关闭批量操作下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (batchDropdownRef.current && !batchDropdownRef.current.contains(event.target as Node)) {
        setShowBatchDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);



  useEffect(() => {
    const handleOffline = () => {
      const id = "network-offline";
      addToast("error", "网络连接已断开，请检查网络设置", 0, "network-offline");
      offlineToastIdRef.current = id;
    };

    const handleOnline = () => {
      if (offlineToastIdRef.current) {
        removeToast(offlineToastIdRef.current);
        offlineToastIdRef.current = null;
      }
      addToast("success", "网络已重新连接", 3000);
    };

    // 初始化检查
    if (!navigator.onLine) {
      handleOffline();
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [addToast, removeToast]);

  const readUsageCache = useCallback((): Record<string, UsageSummary> => {
    try {
      const raw = localStorage.getItem(USAGE_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as Record<string, UsageSummary>;
    } catch {
      return {};
    }
  }, []);

  const updateUsageCache = useCallback(
    (updates: Record<string, UsageSummary>, accountIds?: string[]) => {
      const cache = readUsageCache();
      Object.entries(updates).forEach(([id, usage]) => {
        cache[id] = usage;
      });
      if (accountIds) {
        Object.keys(cache).forEach((id) => {
          if (!accountIds.includes(id)) {
            delete cache[id];
          }
        });
      }
      localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(cache));
    },
    [readUsageCache]
  );

  useEffect(() => {
    let active = true;
    api.getSettings()
      .then((settings) => {
        if (active) setAppSettings(settings);
      })
      .catch(() => {
        if (active) {
          setAppSettings({
            quick_register_show_window: false,
            auto_refresh_enabled: true,
            privacy_auto_enable: true,
            auto_start_enabled: false,
            api_key: "9201",
            custom_tempmail_config: {
              api_url: "",
              secret_key: "",
              email_domain: "",
            },
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);



  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ id?: string; message: string; status?: string }>("quick_register_notice", (event) => {
      if (quickRegisterShowWindow) {
        return;
      }
      const { id, message, status } = event.payload || {};
      if (!message) return;
      const key = id || message;
      const now = Date.now();
      const last = quickRegisterNoticeRef.current.get(key);
      if (last && now - last < 800) {
        return;
      }
      quickRegisterNoticeRef.current.set(key, now);

      // 根据状态类型选择提示类型
      let toastType: ToastMessage["type"] = "info";
      if (status === "register_success") {
        toastType = "success";
      } else if (status === "register_failed") {
        toastType = "error";
      } else if (status === "register_timeout") {
        toastType = "warning";
      } else if (status === "register_clicked") {
        toastType = "info";
      }

      addToast(toastType, message, 3000);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [addToast, quickRegisterShowWindow]);

  const refreshUsageForAccounts = useCallback(
    async (list: AccountBrief[]) => {
      if (list.length === 0) return;
      const results = await Promise.allSettled(
        list.map((account) => api.getAccountUsage(account.id))
      );
      const updates: Record<string, UsageSummary> = {};
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          updates[list[index].id] = result.value;
        }
      });
      if (Object.keys(updates).length > 0) {
        setAccounts((prev) =>
          prev.map((account) =>
            updates[account.id] ? { ...account, usage: updates[account.id] } : account
          )
        );
        updateUsageCache(updates, list.map((a) => a.id));
      } else {
        updateUsageCache({}, list.map((a) => a.id));
      }
    },
    [updateUsageCache]
  );

  // 加载账号列表
  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.getAccounts();
      const cache = readUsageCache();
      const accountsWithUsage = list.map((account) => ({
        ...account,
        usage: cache[account.id] ?? null,
      }));
      setAccounts(accountsWithUsage);
      setError(null);
      setHasLoaded(true);
      updateUsageCache({}, list.map((a) => a.id));
      setLoading(false);
      void refreshUsageForAccounts(list);
    } catch (err: any) {
      setError(err.message || "加载账号失败");
      setHasLoaded(true);
      setLoading(false);
    }
  }, [readUsageCache, refreshUsageForAccounts, updateUsageCache]);

  // 初始加载
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // 启动时检查更新（延迟3秒，避免影响启动速度）
  useEffect(() => {
    const checkUpdateOnStartup = async () => {
      // 检查是否已经提示过本次更新
      const lastDismissedVersion = localStorage.getItem("dismissed_update_version");
      
      try {
        const update = await checkForUpdate();
        
        if (update) {
          // 如果用户已经忽略了这个版本，不再提示
          if (lastDismissedVersion === update.version) {
            return;
          }
          
          setUpdateInfo(update);
          setUpdateModalOpen(true);
        }
      } catch (error) {
        console.error("启动时检查更新失败:", error);
      }
    };

    // 延迟3秒检查更新
    const timer = setTimeout(checkUpdateOnStartup, 3000);
    return () => clearTimeout(timer);
  }, []);

  // 处理下载
  const handleDoDownload = async () => {
    try {
      if (updateInfo?.downloadUrl) {
        await openDownloadPage(updateInfo.downloadUrl);
        addToast("success", "已打开下载页面");
      }
    } catch (error) {
      addToast("error", "打开下载页面失败");
      throw error;
    }
  };

  // 关闭更新弹窗时记录用户忽略的版本
  const handleCloseUpdateModal = () => {
    if (updateInfo) {
      localStorage.setItem("dismissed_update_version", updateInfo.version);
    }
    setUpdateModalOpen(false);
  };

  // 删除账号
  const handleDeleteAccount = async (accountId: string) => {
    setConfirmModal({
      isOpen: true,
      title: "删除账号",
      message: "确定要删除此账号吗？删除后无法恢复。",
      type: "danger",
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await api.removeAccount(accountId);
          setAccounts((prev) => prev.filter((account) => account.id !== accountId));
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(accountId);
            return next;
          });
          addToast("success", "账号已删除");
        } catch (err: any) {
          addToast("error", err.message || "删除账号失败");
        }
      },
    });
  };

  // 刷新单个账号
  const handleRefreshAccount = async (
    accountId: string,
    options?: { silent?: boolean }
  ) => {
    // 防止重复刷新
    if (refreshingIds.has(accountId)) {
      return;
    }

    setRefreshingIds((prev) => new Set(prev).add(accountId));

    try {
      const usage = await api.getAccountUsage(accountId);
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, usage } : a))
      );
      updateUsageCache({ [accountId]: usage });
      if (!options?.silent) {
        addToast("success", "数据刷新成功", 1500, "refresh-success");
      }
    } catch (err: any) {
      addToast("error", err.message || "刷新失败");
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  const handleAccountAdded = useCallback(
    (account: Account) => {
      
      // 直接创建新账号对象
      const nextAccount: AccountWithUsage = {
        id: account.id,
        name: account.name,
        email: account.email,
        avatar_url: account.avatar_url,
        plan_type: account.plan_type,
        is_active: account.is_active ?? true,
        created_at: account.created_at,
        machine_id: account.machine_id,
        is_current: false,
        usage: null,
        password: account.password ?? null,
        user_id: account.user_id ?? null,
      };
      
      setAccounts((prev) => {
        const existing = prev.find((item) => item.id === account.id);
        if (existing) {
          return prev.map((item) => (item.id === account.id ? { ...nextAccount, is_current: item.is_current, usage: item.usage } : item));
        }
        return [...prev, nextAccount];
      });
      setError(null);
      setHasLoaded(true);
      
      // 延迟刷新账号信息
      setTimeout(() => {
        void handleRefreshAccount(account.id, { silent: true });
      }, 100);
    },
    [handleRefreshAccount]
  );

  // 选择账号
  const handleSelectAccount = (accountId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  // 全选/取消全选 - 只选中筛选后的账号
  const handleSelectAll = () => {
    const allVisibleSelected = visibleAccounts.every((account) => selectedIds.has(account.id));
    
    if (allVisibleSelected) {
      // 取消全选 - 只取消当前筛选结果的选中状态
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleAccounts.forEach((account) => next.delete(account.id));
        return next;
      });
    } else {
      // 全选 - 选中所有筛选后的账号
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleAccounts.forEach((account) => next.add(account.id));
        return next;
      });
    }
  };

  // 右键菜单
  const handleContextMenu = (e: React.MouseEvent, accountId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, accountId });
  };

  // 复制 Token
  const handleCopyToken = async (accountId: string) => {
    try {
      const account = await api.getAccount(accountId);
      if (account.jwt_token) {
        await navigator.clipboard.writeText(account.jwt_token);
        addToast("success", "Token 已复制到剪贴板");
      } else {
        addToast("warning", "该账号没有有效的 Token");
      }
    } catch (err: any) {
      addToast("error", err.message || "获取 Token 失败");
    }
  };

  // 检查并设置 Trae IDE 路径
  const checkAndSetTraePath = async (): Promise<boolean> => {
    try {
      // 先尝试获取已保存的路径
      await api.getTraePath();
      return true;
    } catch {
      // 路径未设置或无效，尝试自动扫描
      try {
        const path = await api.scanTraePath();
        addToast("success", "已自动找到 Trae IDE: " + path);
        return true;
      } catch {
        // 自动扫描失败，弹出手动选择对话框
        const selected = await open({
          multiple: false,
          filters: [{
            name: "Trae IDE",
            extensions: ["exe"]
          }],
          title: "请选择 Trae.exe 文件"
        });

        if (selected) {
          try {
            await api.setTraePath(selected as string);
            addToast("success", "Trae IDE 路径已设置");
            return true;
          } catch (err: any) {
            addToast("error", err.message || "设置路径失败");
            return false;
          }
        }
        return false;
      }
    }
  };

  // 切换账号 / 重新登录（同逻辑）
  const handleSwitchAccount = async (
    accountId: string,
    options?: { mode?: "switch" | "relogin"; force?: boolean }
  ) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    // 先检查 Trae IDE 路径
    const pathValid = await checkAndSetTraePath();
    if (!pathValid) {
      addToast("error", "未设置 Trae IDE 路径，无法切换账号");
      return;
    }

    const mode = options?.mode ?? "switch";
    const force = options?.force ?? mode === "relogin";
    const title = mode === "relogin" ? "重新登录" : "切换账号";
    const message =
      mode === "relogin"
        ? `确定要重新登录账号 "${account.email || account.name}" 吗？\n\n系统将自动关闭 Trae IDE 并重新写入登录信息。`
        : `确定要切换到账号 "${account.email || account.name}" 吗？\n\n系统将自动关闭 Trae IDE 并切换登录信息。`;
    const infoToast = mode === "relogin" ? "正在重新登录，请稍候..." : "正在切换账号，请稍候...";
    const successToast = mode === "relogin" ? "账号重新登录完成" : "账号切换成功";
    const errorToast = mode === "relogin" ? "重新登录失败" : "切换账号失败";

    setConfirmModal({
      isOpen: true,
      title,
      message,
      type: "warning",
      onConfirm: async () => {
        setConfirmModal(null);
        addToast("info", infoToast);
        try {
          // 1. 获取当前活跃账号（用于备份）
          const currentAccount = accounts.find(a => a.is_active);
          // 2. 如果有当前活跃账号，先备份其上下文
          if (currentAccount && currentAccount.id !== accountId) {
            try {
              await api.backupAccountContext(currentAccount.id);
            } catch {
              // 备份失败不阻止切换
            }
          }
          
          // 3. 执行账号切换
          await api.switchAccount(accountId, { force });

          // 4. 恢复新账号的上下文（如果有备份）
          try {
            const hasBackup = await api.hasAccountContextBackup(accountId);
            if (hasBackup) {
              await api.restoreAccountContext(accountId);
            }
          } catch {
            // 恢复失败不阻止切换
          }
          
          await loadAccounts();
          addToast("success", successToast);
        } catch (err: any) {
          addToast("error", err.message || errorToast);
        }
      },
    });
  };

  // 查看详情
  const handleViewDetail = async (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    try {
      const full = await api.getAccount(accountId);
      setDetailAccount({
        ...account,
        email: full.email,
        password: full.password ?? null,
      });
    } catch (err: any) {
      addToast("error", err.message || "获取账号详情失败");
      setDetailAccount(account);
    }
  };

  const handleUpdateCredentials = async (
    accountId: string,
    updates: { email?: string; password?: string }
  ) => {
    try {
      const updated = await api.updateAccountProfile(accountId, {
        email: updates.email ?? null,
        password: updates.password ?? null,
      });
      setAccounts((prev) =>
        prev.map((account) =>
          account.id === accountId
            ? { ...account, email: updated.email, password: updated.password ?? null }
            : account
        )
      );
      setDetailAccount((prev) =>
        prev && prev.id === accountId
          ? { ...prev, email: updated.email, password: updated.password ?? null }
          : prev
      );
      addToast("success", "账号信息已更新", 1000);
    } catch (err: any) {
      addToast("error", err.message || "更新账号信息失败");
      throw err;
    }
  };

  const handleRelogin = async (
    accountId: string,
    options?: { forceManual?: boolean; source?: "update-token" | "relogin"; suppressToast?: boolean }
  ) => {
    try {
      if (options?.source === "update-token" && !options?.suppressToast) {
        addToast("info", "正在更新 Token...", 2000, "update-token-progress");
      }
      const account = await api.getAccount(accountId);
      const email = account.email || account.name;

      if (!options?.forceManual) {
        if (account.cookies) {
          try {
            await api.refreshToken(accountId);
            await handleRefreshAccount(accountId, { silent: true });
            addToast("success", "已使用 Cookie 刷新 Token");
            return;
          } catch {}
        }

        if (account.password && account.email) {
          try {
            await api.refreshTokenWithPassword(accountId, account.password);
            await handleRefreshAccount(accountId, { silent: true });
            addToast("success", "已使用保存的密码刷新 Token");
            return;
          } catch {}
        }
      }

      if (options?.source === "update-token") {
        const accountLabel = account.email || account.name || "未知账号";
        const passwordLabel = account.password || "未保存";
        setConfirmModal({
          isOpen: true,
          title: "凭据似乎失效了",
          message:
            `账号: ${accountLabel}\n` +
            `密码: ${passwordLabel}\n\n` +
            "账号凭据似乎失效了或网络波动导致的连接异常。请检查网络，或尝试重新登录。",
          type: "warning",
          confirmText: "知道了",
          cancelText: "关闭",
          onConfirm: () => {
            setConfirmModal(null);
          },
        });
        return;
      }

      setLoginModal({
        accountId,
        accountName: email,
        initialEmail: account.email,
      });
    } catch (err: any) {
      addToast("error", err.message || "重新登录失败");
    }
  };

  const handleUpdateToken = async (accountId: string) => {
    if (refreshingIds.has(accountId)) {
      return;
    }

    setRefreshingIds((prev) => new Set(prev).add(accountId));
    addToast("info", "正在更新 Token...", 2000, "update-token-progress");
    try {
      const usage = await api.getAccountUsage(accountId);
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, usage } : a))
      );
      updateUsageCache({ [accountId]: usage });
      addToast("success", "Token 已更新", 1500, "update-token-success");
    } catch (err: any) {
      void handleRelogin(accountId, {
        source: "update-token",
        forceManual: true,
        suppressToast: true,
      });
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  const handleLoginSubmit = async (accountId: string, email: string, password: string) => {
    const usage = await api.loginAccountWithEmail(accountId, email, password);
    setAccounts((prev) =>
      prev.map((account) =>
        account.id === accountId
          ? { ...account, email, password, usage }
          : account
      )
    );
    updateUsageCache({ [accountId]: usage });
    setDetailAccount((prev) =>
      prev && prev.id === accountId
        ? { ...prev, email, password }
        : prev
    );
    addToast("success", "重新登录成功");
  };

  const handleBuyPro = async (accountId: string) => {
    try {
      await api.openPricing(accountId);
      addToast("info", "已打开购买页面");
    } catch (err: any) {
      addToast("error", err.message || "打开购买页面失败");
    }
  };

  // 导出账号
  const handleExportAccounts = async () => {
    try {
      const date = new Date().toISOString().split("T")[0];
      const path = await save({
        defaultPath: `trae-accounts-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await api.exportAccountsToPath(path as string);
      addToast("success", `已导出 ${accounts.length} 个账号`);
    } catch (err: any) {
      addToast("error", err.message || "导出失败");
    }
  };

  // 导入账号
  const handleImportAccounts = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        
        // 解析并显示要导入的账号数量
        let totalAccounts = 0;
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            totalAccounts = parsed.length;
          }
        } catch (e) {
          console.warn("[Import] 无法预览文件内容");
        }
        
        // 显示"正在导入"提示（duration: 0表示不自动消失）
        const importToastId = addToast("info", `正在导入 ${totalAccounts} 个账号，请稍候...`, 0);

        // 导入账号
        const result = await api.importAccounts(text);

        // 导入完成后移除"正在导入"提示并显示结果
        if (importToastId) {
          removeToast(importToastId);
        }
        if (result.failed.length === 0) {
          // 全部成功
          addToast("success", `成功导入 ${result.count} 个账号`);
        } else if (result.count === 0) {
          // 全部失败
          const failedList = result.failed.map(([email, password, reason]) =>
            `• ${email}\n  密码: ${password}\n  原因: ${reason}`
          ).join("\n\n");
          setConfirmModal({
            isOpen: true,
            title: "导入失败",
            message: `所有账号导入失败（共 ${result.failed.length} 个）：\n\n${failedList}`,
            type: "danger",
            confirmText: "确定",
            onConfirm: () => setConfirmModal(null),
          });
        } else {
          // 部分成功
          const successList = result.success.map(email => `• ${email}`).join("\n");
          const failedList = result.failed.map(([email, password, reason]) =>
            `• ${email}\n  密码: ${password}\n  原因: ${reason}`
          ).join("\n\n");
          setConfirmModal({
            isOpen: true,
            title: "导入结果",
            message: `成功导入 ${result.count} 个账号，失败 ${result.failed.length} 个\n\n✅ 成功：\n${successList}\n\n❌ 失败：\n${failedList}`,
            type: "warning",
            confirmText: "确定",
            onConfirm: () => setConfirmModal(null),
          });
        }
        
        await loadAccounts();
      } catch (err: any) {
        addToast("error", err.message || "导入失败");
      }
    };
    input.click();
  };

  // 批量刷新选中账号（并行执行）
  const handleBatchRefresh = async () => {
    if (selectedIds.size === 0) {
      addToast("warning", "请先选择要刷新的账号");
      return;
    }

    addToast("info", `正在刷新 ${selectedIds.size} 个账号...`);

    const results = await Promise.allSettled(
      Array.from(selectedIds).map((id) => handleRefreshAccount(id, { silent: true }))
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      addToast("warning", `${selectedIds.size - failed} 个刷新成功，${failed} 个失败`);
    } else {
      addToast("success", `${selectedIds.size} 个账号刷新完成`);
    }
  };

  // 批量删除选中账号
  const handleBatchDelete = () => {
    if (selectedIds.size === 0) {
      addToast("warning", "请先选择要删除的账号");
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: "批量删除",
      message: `确定要删除选中的 ${selectedIds.size} 个账号吗？此操作无法撤销。`,
      type: "danger",
      onConfirm: async () => {
        try {
          for (const id of selectedIds) {
            await api.removeAccount(id);
          }
          setSelectedIds(new Set());
          addToast("success", `已删除 ${selectedIds.size} 个账号`);
          await loadAccounts();
        } catch (err: any) {
          addToast("error", err.message || "删除失败");
        }
        setConfirmModal(null);
      },
    });
  };

  // 检测并选中无效账号
  const handleCheckInvalidAccounts = async () => {
    addToast("info", "正在检测账号有效性...");
    try {
      const invalidAccounts = await api.checkInvalidAccounts();
      if (invalidAccounts.length === 0) {
        addToast("success", "所有账号均有效");
      } else {
        // 自动选中无效账号
        const invalidIds = new Set(invalidAccounts.map(([id]) => id));
        setSelectedIds(invalidIds);
        
        // 显示确认删除对话框
        const accountList = invalidAccounts.map(([, name, email]) => {
          const displayName = name || email || "未知账号";
          return `• ${displayName}`;
        }).join("\n");
        
        setConfirmModal({
          isOpen: true,
          title: "检测到无效账号",
          message: `已自动选中 ${invalidAccounts.length} 个 Token 无效的账号：\n\n${accountList}\n\n是否删除这些账号？`,
          type: "danger",
          confirmText: "删除选中账号",
          cancelText: "取消",
          onConfirm: () => {
            setConfirmModal(null);
            // 执行删除
            handleDeleteSelectedInvalidAccounts(invalidIds);
          },
        });
      }
    } catch (err: any) {
      addToast("error", err.message || "检测失败");
    }
  };

  // 删除选中的无效账号
  const handleDeleteSelectedInvalidAccounts = async (invalidIds: Set<string>) => {
    try {
      const idsToDelete = Array.from(invalidIds);
      const deletedAccounts = await api.removeAccountsByIds(idsToDelete);
      
      // 更新账号列表
      setAccounts((prev) => prev.filter((account) => !invalidIds.has(account.id)));
      setSelectedIds(new Set());
      
      addToast("success", `已删除 ${deletedAccounts.length} 个无效账号`);
    } catch (err: any) {
      addToast("error", err.message || "删除失败");
    }
  };

  // 删除无额度账号
  const handleDeleteNoQuotaAccounts = async () => {
    // 找出无额度的账号（usage 不存在或 fast_dollar_left <= 0）
    const noQuotaAccounts = accounts.filter(
      (account) => !account.usage || account.usage.fast_dollar_left <= 0
    );

    if (noQuotaAccounts.length === 0) {
      addToast("success", "没有无额度的账号需要删除");
      return;
    }

    // 显示确认对话框
    const accountList = noQuotaAccounts.map((account) => {
      const displayName = account.name || account.email || "未知账号";
      return `• ${displayName}`;
    }).join("\n");

    setConfirmModal({
      isOpen: true,
      title: "删除无额度账号",
      message: `确定要删除 ${noQuotaAccounts.length} 个无额度的账号吗？此操作无法撤销。\n\n${accountList}`,
      type: "danger",
      confirmText: "删除",
      cancelText: "取消",
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const idsToDelete = noQuotaAccounts.map((account) => account.id);
          const deletedAccounts = await api.removeAccountsByIds(idsToDelete);
          setAccounts((prev) =>
            prev.filter((account) => !idsToDelete.includes(account.id))
          );
          setSelectedIds(new Set());
          addToast("success", `已删除 ${deletedAccounts.length} 个无额度账号`);
        } catch (err: any) {
          addToast("error", err.message || "删除失败");
        }
      },
    });
  };

  const normalizedFilter = (debouncedEmailFilter || "").trim().toLowerCase();
  const visibleAccounts = useMemo(() => {
    return Array.isArray(accounts)
      ? [...accounts]
          .filter((account) => {
            // 邮箱搜索过滤
            if (normalizedFilter && !(account.email || account.name || "").toLowerCase().includes(normalizedFilter)) {
              return false;
            }
            // 额度筛选
            if (quotaFilter === "with") {
              // 有剩余额度：usage 存在且 fast_dollar_left > 0
              return account.usage && account.usage.fast_dollar_left > 0;
            } else if (quotaFilter === "without") {
              // 无剩余额度：usage 不存在或 fast_dollar_left <= 0
              return !account.usage || account.usage.fast_dollar_left <= 0;
            }
            return true;
          })
          .sort((a, b) => {
            // 当前使用的账号排在最前面
            if (a.is_current && !b.is_current) return -1;
            if (!a.is_current && b.is_current) return 1;
            return 0;
          })
      : [];
  }, [accounts, normalizedFilter, quotaFilter]);

  return (
    <div className="app">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} onAddAccount={() => setShowAddModal(true)} />

      <div className="app-content">
        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {currentPage === "stats" && (
          <Stats accounts={accounts} hasLoaded={hasLoaded} />
        )}

        {currentPage === "accounts" && (
          <>
            <main className="app-main">
              {accounts.length > 0 && (
                <div className="toolbar">
                  <div className="toolbar-left">
                    <button
                      type="button"
                      className="header-btn"
                      onClick={handleSelectAll}
                      style={{ padding: "8px 14px" }}
                    >
                      {visibleAccounts.length > 0 && visibleAccounts.every((account) => selectedIds.has(account.id)) ? "取消全选" : "全选"}
                    </button>
                    <div className="toolbar-search">
                      <SearchIcon className="search-icon" />
                      <input
                        type="text"
                        className="toolbar-search-input"
                        placeholder="搜索邮箱..."
                        value={emailFilter}
                        onChange={(event) => setEmailFilter(event.target.value)}
                      />
                    </div>
                    <div className="quota-filter">
                      <select
                        className="quota-filter-select"
                        value={quotaFilter}
                        onChange={(e) => setQuotaFilter(e.target.value as "all" | "with" | "without")}
                        title="额度筛选"
                      >
                        <option value="all">全部额度</option>
                        <option value="with">有剩余额度</option>
                        <option value="without">无剩余额度</option>
                      </select>
                      <ChevronDownIcon className="quota-filter-icon" width={16} height={16} />
                    </div>
                    <div className="view-toggle">
                      <button
                        className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
                        onClick={() => setViewMode("grid")}
                        title="卡片视图"
                      >
                        <GridIcon width={16} height={16} />
                      </button>
                      <button
                        className={`view-btn ${viewMode === "list" ? "active" : ""}`}
                        onClick={() => setViewMode("list")}
                        title="列表视图"
                      >
                        <ListIcon width={16} height={16} />
                      </button>
                    </div>
                    
                    {selectedIds.size > 0 && (
                      <div className="batch-actions">
                        <button className="batch-btn" onClick={handleBatchRefresh}>
                          <RefreshIcon width={14} height={14} />
                          刷新
                        </button>
                        <button className="batch-btn danger" onClick={handleBatchDelete}>
                          <TrashIcon width={14} height={14} />
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                  
                  {/* 右侧 - 更多操作 */}
                  <div className="toolbar-right">
                    {/* 更多操作下拉按钮 */}
                    <div ref={batchDropdownRef} className="batch-dropdown-container">
                      <button
                        className="header-btn more-actions-btn"
                        onClick={() => setShowBatchDropdown(!showBatchDropdown)}
                        style={{ padding: "6px 12px", fontSize: "12px" }}
                      >
                        <MoreIcon width={14} height={14} style={{ marginRight: "4px", verticalAlign: "middle" }} />
                        更多
                        <ChevronDownIcon width={12} height={12} style={{ marginLeft: "4px", verticalAlign: "middle", transform: showBatchDropdown ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                      </button>
                      
                      {showBatchDropdown && (
                        <div className="batch-dropdown-menu">
                          <button
                            className="dropdown-item"
                            onClick={() => {
                              setShowBatchDropdown(false);
                              handleImportAccounts();
                            }}
                          >
                            <DownloadIcon width={14} height={14} />
                            导入账号
                          </button>
                          <button
                            className="dropdown-item"
                            onClick={() => {
                              setShowBatchDropdown(false);
                              handleExportAccounts();
                            }}
                            disabled={accounts.length === 0}
                            style={{ opacity: accounts.length === 0 ? 0.5 : 1, cursor: accounts.length === 0 ? "not-allowed" : "pointer" }}
                          >
                            <UploadIcon width={14} height={14} />
                            导出账号
                          </button>
                          <div className="dropdown-divider" />
                          <button
                            className="dropdown-item"
                            onClick={() => {
                              setShowBatchDropdown(false);
                              handleCheckInvalidAccounts();
                            }}
                          >
                            <DeleteWithLineIcon width={14} height={14} />
                            清理无效账号
                          </button>
                          <button
                            className="dropdown-item danger"
                            onClick={() => {
                              setShowBatchDropdown(false);
                              handleDeleteNoQuotaAccounts();
                            }}
                          >
                            <DeleteWithLineIcon width={14} height={14} />
                            删除无额度账号
                          </button>
                          <div className="dropdown-divider" />
                          <button
                            className="dropdown-item"
                            onClick={() => {
                              setShowBatchDropdown(false);
                              handleBatchRefresh();
                            }}
                            disabled={selectedIds.size === 0}
                            style={{ opacity: selectedIds.size === 0 ? 0.5 : 1, cursor: selectedIds.size === 0 ? "not-allowed" : "pointer" }}
                          >
                            <RefreshIcon width={14} height={14} />
                            刷新选中 ({selectedIds.size})
                          </button>
                          <button
                            className="dropdown-item danger"
                            onClick={() => {
                              setShowBatchDropdown(false);
                              handleBatchDelete();
                            }}
                            disabled={selectedIds.size === 0}
                            style={{ opacity: selectedIds.size === 0 ? 0.5 : 1, cursor: selectedIds.size === 0 ? "not-allowed" : "pointer" }}
                          >
                            <TrashIcon width={14} height={14} />
                            删除选中 ({selectedIds.size})
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="loading">
                  <div className="spinner"></div>
                  <p>加载中...</p>
                </div>
              ) : accounts.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📋</div>
                  <h3>暂无账号</h3>
                  <p>点击上方按钮添加账号，或导入已有账号</p>
                  <div className="empty-actions">
                    <button className="empty-btn primary" onClick={() => setShowAddModal(true)}>
                      添加账号
                    </button>
                    <button className="empty-btn" onClick={handleImportAccounts}>
                      导入账号
                    </button>
                  </div>
                </div>
              ) : viewMode === "grid" ? (
                <div className="account-grid">
                  {visibleAccounts.map((account) => (
                    <AccountCard
                      key={account.id}
                      account={account}
                      usage={account.usage || null}
                      selected={selectedIds.has(account.id)}
                      onSelect={handleSelectAccount}
                      onContextMenu={handleContextMenu}
                      onToast={addToast}
                    />
                  ))}
                </div>
              ) : (
                <div className="account-list">
                  <div className="list-header">
                    <div className="list-col checkbox"></div>
                    <div className="list-col avatar"></div>
                    <div className="list-col info">账号信息</div>
                    <div className="list-col plan">套餐</div>
                    <div className="list-col usage">使用量</div>
                    <div className="list-col reset">重置时间</div>
                    <div className="list-col status">状态</div>
                    <div className="list-col actions"></div>
                  </div>
                  {visibleAccounts.map((account) => (
                    <AccountListItem
                      key={account.id}
                      account={account}
                      usage={account.usage || null}
                      selected={selectedIds.has(account.id)}
                      onSelect={handleSelectAccount}
                      onContextMenu={handleContextMenu}
                    />
                  ))}
                </div>
              )}
            </main>
          </>
        )}

        {currentPage === "settings" && (
          <Settings
            onToast={addToast}
            settings={appSettings}
            onSettingsChange={setAppSettings}
          />
        )}

        {currentPage === "about" && <About onToast={addToast} />}
      </div>

      {/* Toast 通知 */}
      <Toast messages={toasts} onRemove={removeToast} />

      {/* 确认弹窗 */}
      {confirmModal && (
        <ConfirmModal
          isOpen={confirmModal.isOpen}
          title={confirmModal.title}
          message={confirmModal.message}
          type={confirmModal.type}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {/* 右键菜单 */}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onRelogin={() => {
            handleSwitchAccount(contextMenu.accountId, { mode: "relogin" });
            setContextMenu(null);
          }}
          onViewDetail={() => {
            void handleViewDetail(contextMenu.accountId);
            setContextMenu(null);
          }}
          onRefresh={() => {
            handleRefreshAccount(contextMenu.accountId);
            setContextMenu(null);
          }}
          onUpdateToken={() => {
            void handleUpdateToken(contextMenu.accountId);
            setContextMenu(null);
          }}
          onCopyToken={() => {
            handleCopyToken(contextMenu.accountId);
            setContextMenu(null);
          }}
          onSwitchAccount={() => {
            handleSwitchAccount(contextMenu.accountId);
            setContextMenu(null);
          }}
          onBuyPro={() => {
            void handleBuyPro(contextMenu.accountId);
            setContextMenu(null);
          }}
          onDelete={() => {
            handleDeleteAccount(contextMenu.accountId);
            setContextMenu(null);
          }}
          isCurrent={accounts.find(a => a.id === contextMenu.accountId)?.is_current || false}
        />
      )}

      {/* 添加账号弹窗 */}
      <AddAccountModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onToast={addToast}
        onAccountAdded={handleAccountAdded}
        quickRegisterShowWindow={quickRegisterShowWindow}
        onImportAccounts={handleImportAccounts}
        onExportAccounts={handleExportAccounts}
        canExport={accounts.length > 0}
        settings={appSettings}
        onSettingsChange={setAppSettings}
      />

      {/* 详情弹窗 */}
      <DetailModal
        isOpen={!!detailAccount}
        onClose={() => setDetailAccount(null)}
        account={detailAccount}
        usage={detailAccount?.usage || null}
        onUpdateCredentials={handleUpdateCredentials}
        onToast={addToast}
      />

      <AccountLoginModal
        isOpen={!!loginModal}
        accountId={loginModal?.accountId || ""}
        accountName={loginModal?.accountName || ""}
        initialEmail={loginModal?.initialEmail}
        onClose={() => setLoginModal(null)}
        onSubmit={handleLoginSubmit}
      />

      {/* 更新弹窗 */}
      <UpdateModal
        isOpen={updateModalOpen}
        updateInfo={updateInfo}
        onClose={handleCloseUpdateModal}
        onDownload={handleDoDownload}
      />
    </div>
  );
}

export default App;
