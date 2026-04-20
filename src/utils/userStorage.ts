// 用户存储工具 - 用于存储用户的 openid 和限额信息
// 存储位置：localStorage

const STORAGE_KEY = "trae_quick_register_user";
const PC_TOKEN_KEY = "trae_pc_bind_token";           // PC Token 存储键
const PC_TOKEN_EXPIRY_KEY = "trae_pc_token_expiry";  // PC Token 过期时间

// 用户数据接口
export interface StoredUserInfo {
  openid: string;           // 用户微信 openid（核心标识）
  virtualId?: string;       // 用户虚拟ID（显示用，如 user_mo1...）
  platformId: string;       // 绑定的平台ID
  firstUsedAt: number;      // 首次使用时间戳
  lastUsedAt: number;       // 最后使用时间戳
  dailyCount: number;       // 今日已领取次数
  lastClaimDate: string;    // 最后领取日期（YYYY-MM-DD 格式）
  totalClaimed: number;     // 累计领取次数
}

/**
 * 获取存储的用户信息
 */
export function getStoredUserInfo(): StoredUserInfo | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    return JSON.parse(data) as StoredUserInfo;
  } catch (e) {
    console.error("读取用户信息失败:", e);
    return null;
  }
}

/**
 * 保存用户信息
 */
export function saveUserInfo(userInfo: StoredUserInfo): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userInfo));
  } catch (e) {
    console.error("保存用户信息失败:", e);
  }
}

/**
 * 清除用户信息（切换用户时使用）
 */
export function clearUserInfo(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error("清除用户信息失败:", e);
  }
}

/**
 * 检查是否需要重置每日计数
 */
function shouldResetDailyCount(lastClaimDate: string): boolean {
  const today = new Date().toISOString().split("T")[0];
  return lastClaimDate !== today;
}

/**
 * 获取今日已领取次数
 */
export function getTodayClaimCount(): number {
  const user = getStoredUserInfo();
  if (!user) return 0;

  // 检查是否需要重置计数
  if (shouldResetDailyCount(user.lastClaimDate)) {
    return 0;
  }
  return user.dailyCount;
}

/**
 * 获取剩余可领取次数
 */
export function getRemainingClaims(): number {
  return Infinity; // 无限制
}

/**
 * 更新领取记录
 * 在成功领取资源后调用
 */
export function recordClaim(): void {
  const user = getStoredUserInfo();
  if (!user) return;

  const today = new Date().toISOString().split("T")[0];

  // 检查是否需要重置每日计数
  if (shouldResetDailyCount(user.lastClaimDate)) {
    user.dailyCount = 0;
  }

  user.dailyCount += 1;
  user.lastClaimDate = today;
  user.totalClaimed += 1;
  user.lastUsedAt = Date.now();

  saveUserInfo(user);
}

/**
 * 初始化或更新用户信息
 * 在获取到 openid 后调用
 */
export function initOrUpdateUserInfo(openid: string, platformId: string, virtualId?: string): StoredUserInfo {
  const existing = getStoredUserInfo();
  const now = Date.now();
  const today = new Date().toISOString().split("T")[0];

  if (existing && existing.openid === openid) {
    // 更新现有用户信息
    const updated: StoredUserInfo = {
      ...existing,
      openid,
      platformId,
      lastUsedAt: now,
    };
    // 如果提供了 virtualId，更新它
    if (virtualId) {
      updated.virtualId = virtualId;
    }
    saveUserInfo(updated);
    return updated;
  } else {
    // 创建新用户信息
    const newUser: StoredUserInfo = {
      openid,
      platformId,
      firstUsedAt: now,
      lastUsedAt: now,
      dailyCount: 0,
      lastClaimDate: today,
      totalClaimed: 0,
    };
    // 如果提供了 virtualId，保存它
    if (virtualId) {
      newUser.virtualId = virtualId;
    }
    saveUserInfo(newUser);
    return newUser;
  }
}

/**
 * 更新用户的 virtualId
 */
export function updateUserVirtualId(virtualId: string): void {
  const user = getStoredUserInfo();
  if (user) {
    user.virtualId = virtualId;
    saveUserInfo(user);
  }
}

/**
 * 获取当前用户的 virtualId
 */
export function getCurrentVirtualId(): string | null {
  const user = getStoredUserInfo();
  return user?.virtualId || null;
}

/**
 * 获取当前用户的 openid（用于创建任务时传递）
 */
export function getCurrentOpenid(): string | null {
  const user = getStoredUserInfo();
  return user?.openid || null;
}

/**
 * 获取当前用户的 platformId（优先使用存储的，否则生成新的）
 */
export function getCurrentPlatformId(): string {
  const user = getStoredUserInfo();
  if (user?.platformId) {
    return user.platformId;
  }
  // 生成新的 platformId
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `user_${timestamp}_${random}`;
}

/**
 * 检查用户是否还有剩余额度
 */
export function hasRemainingQuota(): boolean {
  return getRemainingClaims() > 0;
}

/**
 * 获取用户状态摘要（用于显示）
 */
export function getUserStatusSummary(): {
  isLoggedIn: boolean;
  openid: string | null;
  todayClaimed: number;
  remaining: number;
  lastUsedAt: number | null;
} {
  const user = getStoredUserInfo();
  const todayCount = getTodayClaimCount();

  return {
    isLoggedIn: !!user,
    openid: user?.openid || null,
    todayClaimed: todayCount,
    remaining: getRemainingClaims(),
    lastUsedAt: user?.lastUsedAt || null,
  };
}

// ============ PC Token 管理 ============

/**
 * 保存 PC 绑定令牌
 * @param token PC Token
 * @param expiresInSeconds 过期时间（秒），默认 86400 秒（24小时）
 */
export function savePcToken(token: string, expiresInSeconds: number = 86400): void {
  try {
    const expiryTime = Date.now() + expiresInSeconds * 1000;
    localStorage.setItem(PC_TOKEN_KEY, token);
    localStorage.setItem(PC_TOKEN_EXPIRY_KEY, expiryTime.toString());
  } catch (e) {
    console.error("保存 PC Token 失败:", e);
  }
}

/**
 * 获取 PC 绑定令牌
 * @returns 如果 Token 存在且未过期则返回 Token，否则返回 null
 */
export function getPcToken(): string | null {
  try {
    const token = localStorage.getItem(PC_TOKEN_KEY);
    const expiryStr = localStorage.getItem(PC_TOKEN_EXPIRY_KEY);
    
    if (!token || !expiryStr) return null;
    
    const expiryTime = parseInt(expiryStr, 10);
    // 检查是否过期（预留 30 秒缓冲）
    if (Date.now() > expiryTime - 30000) {
      // Token 即将过期或已过期，清除它
      clearPcToken();
      return null;
    }
    
    return token;
  } catch (e) {
    console.error("获取 PC Token 失败:", e);
    return null;
  }
}

/**
 * 检查 PC Token 是否有效
 */
export function isPcTokenValid(): boolean {
  return getPcToken() !== null;
}

/**
 * 清除 PC 绑定令牌
 */
export function clearPcToken(): void {
  try {
    localStorage.removeItem(PC_TOKEN_KEY);
    localStorage.removeItem(PC_TOKEN_EXPIRY_KEY);
  } catch (e) {
    console.error("清除 PC Token 失败:", e);
  }
}

/**
 * 获取 PC Token 剩余有效时间（秒）
 */
export function getPcTokenRemainingTime(): number {
  try {
    const expiryStr = localStorage.getItem(PC_TOKEN_EXPIRY_KEY);
    if (!expiryStr) return 0;
    
    const expiryTime = parseInt(expiryStr, 10);
    const remaining = Math.max(0, Math.floor((expiryTime - Date.now()) / 1000));
    return remaining;
  } catch (e) {
    return 0;
  }
}

/**
 * 获取 Authorization Header
 * @returns Bearer Token 格式的 Header 值，如果没有有效 Token 则返回空字符串
 */
export function getAuthHeader(): string {
  const token = getPcToken();
  return token ? `Bearer ${token}` : "";
}
