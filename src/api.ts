import { invoke } from "@tauri-apps/api/core";
import type { Account, AccountBrief, AppSettings, UsageSummary, UsageEventsResponse, UserStatisticData } from "./types";

// ============ 快速注册后端 API 配置 ============
// 从环境变量读取配置，如果没有则使用空字符串（功能将不可用）
const QUICK_REGISTER_API_BASE = import.meta.env.VITE_QUICK_REGISTER_API_BASE || "";
const APP_ID = import.meta.env.VITE_APP_ID || "";
const APP_SECRET = import.meta.env.VITE_APP_SECRET || "";

// 验证配置是否有效
export function checkApiConfig(): boolean {
  return !!(QUICK_REGISTER_API_BASE && APP_ID && APP_SECRET);
}

// ============ PC Token 相关类型定义 ============

// 换取 PC Token 响应
export interface PcTokenResponse {
  success: boolean;
  pc_bind_token?: string;
  message?: string;
  code?: string;
}

// 用户信息响应
export interface UserInfoResponse {
  success: boolean;
  data: {
    basic: {
      openid: string;
      virtual_id: string;
      qq_id: string | null;
      is_vip: boolean;
      created_at: string;
    };
    claim_limit: {
      base_limit: number;
      bonus_limit: number;
      total_limit: number;
      current_usage: number;
      remaining: number;
    };
    invitation: {
      invite_code: string | null;
      total_invited: number;
      is_invited: boolean;
    };
  };
  message?: string;
}

// 领取资源请求（新流程）
export interface ClaimResourceRequest {
  ticket: string;
  invite_code?: string;
}

// 领取资源响应（新流程）
export interface ClaimResourceNewResponse {
  success: boolean;
  resource_payload: {
    account: string;
    password: string;
  }[];
  message: string;
  code?: string;
}

// 任务创建响应
export interface CreateTaskResponse {
  success: boolean;
  ticket: string;
  qrcode_url: string;
  is_vip: boolean;
  url_scheme: string;
  message: string;
}

// 带 openid 创建任务的请求参数
export interface CreateTaskWithOpenidRequest {
  platformId: string;
  openid?: string;  // 可选：已存储的用户 openid
}

// 任务状态
export type TaskStatus = "pending" | "verified" | "expired" | "claimed";

// 查询任务状态响应
export interface TaskStatusResponse {
  success: boolean;
  ticket?: string;
  status: TaskStatus;
  platform_id?: string;
  created_at?: number;
  verified_at?: number;
  resource_payload?: {
    account: string;
    password: string;
  }[] | null;
  access_token?: string | null;
  platform?: string;
  openid?: string;           // 用户微信 openid（验证成功后返回）
  daily_claimed?: number;    // 该用户今日已领取次数
  daily_limit?: number;      // 每日限额（通常是2）
}

// 领取资源响应 - 根据后端实际返回格式
export interface ClaimResourceResponse {
  success: boolean;
  resource_payload: {
    account: string;
    password: string;
  }[];
  message: string;
}

function checkNetwork() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error("网络连接已断开，请检查网络设置");
  }
}

async function invokeNetwork<T>(cmd: string, args?: any): Promise<T> {
  checkNetwork();
  return invoke(cmd, args);
}

// 添加账号（通过 Cookies）
export async function addAccount(cookies: string): Promise<Account> {
  return invokeNetwork("add_account", { cookies });
}

// 添加账号（通过 Token，可选 Cookies）
export async function addAccountByToken(token: string, cookies?: string): Promise<Account> {
  return invokeNetwork("add_account_by_token", { token, cookies });
}

// 添加账号（通过邮箱密码登录）
export async function addAccountByEmail(email: string, password: string): Promise<Account> {
  return invokeNetwork("add_account_by_email", { email, password });
}

export async function quickRegister(showWindow?: boolean): Promise<Account> {
  if (typeof showWindow === "boolean") {
    return invokeNetwork("quick_register", { showWindow });
  }
  return invokeNetwork("quick_register");
}

// 使用自定义临时邮箱进行快速注册
export async function quickRegisterWithCustomTempMail(showWindow?: boolean): Promise<Account> {
  if (typeof showWindow === "boolean") {
    return invokeNetwork("quick_register_with_custom_tempmail", { showWindow });
  }
  return invokeNetwork("quick_register_with_custom_tempmail");
}

export async function startBrowserLogin(): Promise<void> {
  return invokeNetwork("start_browser_login");
}

export async function finishBrowserLogin(): Promise<Account> {
  return invokeNetwork("finish_browser_login");
}

export async function cancelBrowserLogin(): Promise<void> {
  return invoke("cancel_browser_login");
}

// 浏览器自动登录
export async function browserAutoLogin(email: string, password: string): Promise<Account> {
  return invokeNetwork("browser_auto_login_command", { email, password });
}

// 下载并运行更新安装包（Windows: .msi）
export async function downloadAndRunInstaller(url: string): Promise<string> {
  return invokeNetwork("download_and_run_installer", { url });
}

// 删除账号
export async function removeAccount(accountId: string): Promise<void> {
  return invoke("remove_account", { accountId });
}

// 获取所有账号
export async function getAccounts(): Promise<AccountBrief[]> {
  return invoke("get_accounts");
}

// 获取单个账号详情（包含 token）
export async function getAccount(accountId: string): Promise<Account> {
  return invoke("get_account", { accountId });
}

// 设置活跃账号
export async function setActiveAccount(
  accountId: string,
  options?: { force?: boolean }
): Promise<void> {
  return invoke("switch_account", { accountId, force: options?.force });
}

// 切换账号（设置活跃账号并更新机器码）
export async function switchAccount(
  accountId: string,
  options?: { force?: boolean }
): Promise<void> {
  return invoke("switch_account", { accountId, force: options?.force });
}

// 获取账号使用量
export async function getAccountUsage(accountId: string): Promise<UsageSummary> {
  return invokeNetwork("get_account_usage", { accountId });
}

// 更新账号 Token
export async function updateAccountToken(accountId: string, token: string): Promise<UsageSummary> {
  return invokeNetwork("update_account_token", { accountId, token });
}

// 刷新 Token
export async function refreshToken(accountId: string): Promise<void> {
  return invokeNetwork("refresh_token", { accountId });
}

export async function refreshTokenWithPassword(accountId: string, password: string): Promise<void> {
  return invokeNetwork("refresh_token_with_password", { accountId, password });
}

export async function loginAccountWithEmail(
  accountId: string,
  email: string,
  password: string
): Promise<UsageSummary> {
  return invokeNetwork("login_account_with_email", { accountId, email, password });
}

export async function updateAccountProfile(
  accountId: string,
  updates: { email?: string | null; password?: string | null }
): Promise<Account> {
  return invokeNetwork("update_account_profile", {
    accountId,
    email: updates.email ?? null,
    password: updates.password ?? null,
  });
}

// 更新 Cookies
export async function updateCookies(accountId: string, cookies: string): Promise<void> {
  return invokeNetwork("update_cookies", { accountId, cookies });
}

// 导出账号
export async function exportAccounts(): Promise<string> {
  return invoke("export_accounts");
}

export async function exportAccountsToPath(path: string): Promise<void> {
  return invoke("export_accounts_to_path", { path });
}

// 导入账号结果
export interface ImportAccountsResult {
  count: number;
  success: string[];
  failed: [string, string, string][]; // [邮箱, 密码, 原因]
}

// 导入账号
export async function importAccounts(data: string): Promise<ImportAccountsResult> {
  return invoke("import_accounts", { data });
}

// 备份账号的 Trae 上下文数据
export async function backupAccountContext(accountId: string): Promise<string> {
  return invoke("backup_account_context", { accountId });
}

// 恢复账号的 Trae 上下文数据
export async function restoreAccountContext(accountId: string): Promise<void> {
  return invoke("restore_account_context", { accountId });
}

// 检查账号是否有上下文备份
export async function hasAccountContextBackup(accountId: string): Promise<boolean> {
  return invoke("has_account_context_backup", { accountId });
}

// 删除账号的上下文备份
export async function deleteAccountContextBackup(accountId: string): Promise<void> {
  return invoke("delete_account_context_backup", { accountId });
}

// 合并两个账号的对话记录（当前账号的对话合并到目标账号）
export async function mergeTwoAccountsContext(
  currentAccountId: string,
  targetAccountId: string
): Promise<void> {
  return invoke("merge_two_accounts_context", { currentAccountId, targetAccountId });
}

export async function clearAccounts(): Promise<number> {
  return invoke("clear_accounts");
}

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function updateSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke("update_settings", { settings });
}

// 获取使用事件
export async function getUsageEvents(
  accountId: string,
  startTime: number,
  endTime: number,
  pageNum: number = 1,
  pageSize: number = 20
): Promise<UsageEventsResponse> {
  return invokeNetwork("get_usage_events", {
    accountId,
    startTime,
    endTime,
    pageNum,
    pageSize
  });
}

// 从 Trae IDE 读取当前登录账号
export async function readTraeAccount(): Promise<Account | null> {
  return invoke("read_trae_account");
}

// ============ 机器码相关 API ============

// 获取当前系统机器码
export async function getMachineId(): Promise<string> {
  return invoke("get_machine_id");
}

// 重置系统机器码（生成新的随机机器码）
export async function resetMachineId(): Promise<string> {
  return invoke("reset_machine_id");
}

// 设置系统机器码为指定值
export async function setMachineId(machineId: string): Promise<void> {
  return invoke("set_machine_id", { machineId });
}

// 绑定账号机器码（保存当前系统机器码到账号）
export async function bindAccountMachineId(accountId: string): Promise<string> {
  return invoke("bind_account_machine_id", { accountId });
}

// ============ Trae IDE 机器码相关 API ============

// 获取 Trae IDE 的机器码
export async function getTraeMachineId(): Promise<string> {
  return invoke("get_trae_machine_id");
}

// 设置 Trae IDE 的机器码
export async function setTraeMachineId(machineId: string): Promise<void> {
  return invoke("set_trae_machine_id", { machineId });
}

// 清除 Trae IDE 登录状态（让 IDE 变成全新安装状态）
export async function clearTraeLoginState(): Promise<void> {
  return invoke("clear_trae_login_state");
}

// ============ Trae IDE 路径相关 API ============

// 获取保存的 Trae IDE 路径
export async function getTraePath(): Promise<string> {
  return invoke("get_trae_path");
}

// 设置 Trae IDE 路径
export async function setTraePath(path: string): Promise<void> {
  return invoke("set_trae_path", { path });
}

// 自动扫描 Trae IDE 路径
export async function scanTraePath(): Promise<string> {
  return invoke("scan_trae_path");
}

// ============ 礼包相关 API ============

// 获取用户统计数据
export async function getUserStatistics(accountId: string): Promise<UserStatisticData> {
  return invokeNetwork("get_user_statistics", { accountId });
}

// 打开购买页面（内置浏览器，携带账号 Cookies）
export async function openPricing(accountId: string): Promise<void> {
  return invokeNetwork("open_pricing", { accountId });
}

// ============ 日志相关 API ============

// 获取最近日志
export async function getLogs(count: number): Promise<string[]> {
  return invoke("get_logs", { count });
}

// 导出日志
export async function exportLogs(path: string): Promise<void> {
  return invoke("export_logs_cmd", { path });
}

// 清空日志
export async function clearLogs(): Promise<void> {
  return invoke("clear_logs_cmd");
}

// 获取日志文件路径
export async function getLogFilePath(): Promise<string> {
  return invoke("get_log_file_path_cmd");
}

// ============ 快速注册后端 API（通过 Tauri Rust 后端调用，绕过 CORS） ============

/**
 * 创建快速注册任务
 * @param platformId 用户平台ID（如QQ号）
 * @returns 包含ticket和二维码链接的响应
 */
export async function createQuickRegisterTask(platformId: string): Promise<CreateTaskResponse> {
  // 通过 Tauri 命令调用 Rust 后端，绕过 CORS 限制
  return invoke("quick_register_create_task", { platformId });
}

/**
 * 创建快速注册任务（带 openid，用于识别老用户）
 * @param params 包含 platformId 和可选的 openid
 * @returns 包含ticket和二维码链接的响应
 */
export async function createQuickRegisterTaskWithOpenid(
  params: CreateTaskWithOpenidRequest
): Promise<CreateTaskResponse> {
  // 通过 Tauri 命令调用 Rust 后端，支持传递 openid
  return invoke("quick_register_create_task", {
    platformId: params.platformId,
    openid: params.openid,
  });
}

/**
 * 查询任务状态
 * @param ticket 任务票据
 * @returns 任务状态响应
 */
export async function getTaskStatus(ticket: string): Promise<TaskStatusResponse> {
  return invoke("quick_register_get_status", { ticket });
}

/**
 * 领取资源（获取账号）
 * @param ticket 任务票据
 * @param inviteCode 可选：邀请码
 * @returns 包含账号信息的响应
 */
export async function claimResource(ticket: string, inviteCode?: string): Promise<ClaimResourceResponse> {
  // 通过 Tauri 命令调用 Rust 后端，绕过 CORS 限制
  return invoke("quick_register_claim_resource", { ticket, inviteCode });
}

// 统计响应
export interface StatsResponse {
  success: boolean;
  data: {
    available_count: number;
    resource_type: string;
  };
  message: string;
}

/**
 * 获取剩余账号数量统计
 * @returns 统计响应
 */
export async function getQuickRegisterStats(): Promise<StatsResponse> {
  // 通过 Tauri 命令调用 Rust 后端，绕过 CORS 限制
  return invoke("quick_register_get_stats");
}

/**
 * 检测 Token 无效的账号（只检测，不删除）
 * @returns 无效账号列表 [(id, name, email), ...]
 */
export async function checkInvalidAccounts(): Promise<[string, string, string][]> {
  return invoke("check_invalid_accounts");
}

/**
 * 删除指定的账号
 * @param accountIds 要删除的账号 ID 列表
 * @returns 被删除的账号列表 [(name, email), ...]
 */
export async function removeAccountsByIds(accountIds: string[]): Promise<[string, string][]> {
  return invoke("remove_accounts_by_ids", { accountIds });
}

/**
 * 轮询等待任务验证完成
 * @param ticket 任务票据
 * @param timeoutMs 超时时间（毫秒）
 * @param intervalMs 轮询间隔（毫秒）
 * @param onStatusChange 状态变化回调
 * @returns 包含验证成功后的任务状态和取消函数的对象
 */
export function pollTaskVerification(
  ticket: string,
  timeoutMs: number = 600000, // 默认10分钟
  intervalMs: number = 3000,  // 默认3秒轮询一次
  onStatusChange?: (status: TaskStatusResponse) => void
): { promise: Promise<TaskStatusResponse>; cancel: () => void } {
  const startTime = Date.now();
  let isCancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<TaskStatusResponse>((resolve, reject) => {
    const poll = async () => {
      if (isCancelled) {
        reject(new Error("用户已取消"));
        return;
      }

      try {
        // 检查是否超时
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error("等待验证超时，请重新尝试"));
          return;
        }

        const status = await getTaskStatus(ticket);
        
        // 调用状态变化回调
        onStatusChange?.(status);

        // 后端可能返回的状态: pending, verified, claimed, expired
        if (status.status === "verified" || status.status === "claimed") {
          resolve(status);
          return;
        }

        if (status.status === "expired") {
          reject(new Error("二维码已过期，请重新获取"));
          return;
        }

        // 继续轮询 (pending 状态)
        if (!isCancelled) {
          timeoutId = setTimeout(poll, intervalMs);
        }
      } catch (error: any) {
        console.error("轮询出错:", error);
        if (!isCancelled) {
          reject(error);
        }
      }
    };

    poll();
  });

  const cancel = () => {
    isCancelled = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return { promise, cancel };
}

// ============ 新流程 API：扫码即绑定，令牌即身份 ============

/**
 * 换取 PC 绑定令牌
 * @param ticket 扫码成功的凭证
 * @returns PC Token 响应
 */
export async function exchangePcToken(ticket: string): Promise<PcTokenResponse> {
  return invoke("exchange_pc_token", { ticket });
}

/**
 * 获取当前用户信息（需要 PC Token）
 * @param pcToken PC 绑定令牌
 * @returns 用户信息响应
 */
export async function getUserInfo(pcToken: string): Promise<UserInfoResponse> {
  return invoke("get_user_info", { pcToken });
}

/**
 * 领取资源（新流程，需要 PC Token）
 * @param pcToken PC 绑定令牌
 * @param params 领取参数
 * @returns 领取结果
 */
export async function claimResourceWithToken(
  pcToken: string,
  params: ClaimResourceRequest
): Promise<ClaimResourceNewResponse> {
  return invoke("claim_resource_with_token", { pcToken, ...params });
}

/**
 * 获取我的邀请码
 * @param pcToken PC 绑定令牌
 * @returns 邀请码信息
 */
export async function getMyInviteCode(pcToken: string): Promise<{ success: boolean; data: { invite_code: string }; message?: string }> {
  return invoke("get_my_invite_code", { pcToken });
}
