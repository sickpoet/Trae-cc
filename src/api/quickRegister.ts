import { invoke } from "@tauri-apps/api/core";

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

// 统计响应
export interface StatsResponse {
  success: boolean;
  data: {
    available_count: number;
    resource_type: string;
  };
  message: string;
}

// ============ 快速注册 API ============

import type { Account } from "../types";

export async function quickRegister(showWindow?: boolean): Promise<Account> {
  if (typeof showWindow === "boolean") {
    return invoke("quick_register", { showWindow });
  }
  return invoke("quick_register");
}

// 使用自定义临时邮箱进行快速注册
export async function quickRegisterWithCustomTempMail(showWindow?: boolean): Promise<Account> {
  if (typeof showWindow === "boolean") {
    return invoke("quick_register_with_custom_tempmail", { showWindow });
  }
  return invoke("quick_register_with_custom_tempmail");
}

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
  console.log("查询任务状态 ticket:", ticket);
  // 通过 Tauri 命令调用 Rust 后端，绕过 CORS 限制
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
        console.log("轮询状态:", status);
        
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
