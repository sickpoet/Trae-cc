// 后端错误码定义
export type ErrorCode =
  | "DAILY_LIMIT_REACHED"      // 每日限额已达
  | "RESOURCE_EMPTY"           // 资源库告罄
  | "TASK_NOT_FOUND"           // 任务不存在
  | "TASK_EXPIRED"             // 任务已过期
  | "ALREADY_CLAIMED"          // 已领取过
  | "INVALID_TICKET"           // 无效票据
  | "PLATFORM_NOT_SUPPORTED"   // 平台不支持
  | "NETWORK_ERROR"            // 网络错误
  | "SERVER_ERROR";            // 服务器错误

// 错误信息配置
export interface ErrorConfig {
  title: string;
  message: string;
  description?: string;
  icon: "limit" | "empty" | "expired" | "error" | "success";
  actionText?: string;
  action?: () => void;
}

// 错误码对应的配置
export const ERROR_CONFIG_MAP: Record<ErrorCode, ErrorConfig> = {
  DAILY_LIMIT_REACHED: {
    title: "今日额度已用完",
    message: "初步测试，每人每日最多 10 次",
    description: "您已达到今日领取上限，请明天再来尝试",
    icon: "limit",
    actionText: "我知道了",
  },
  RESOURCE_EMPTY: {
    title: "资源暂时告罄",
    message: "账号库正在紧急补充中",
    description: "我们的技术团队正在全力补充新账号，请稍后再试",
    icon: "empty",
    actionText: "稍后再试",
  },
  TASK_NOT_FOUND: {
    title: "任务不存在",
    message: "请重新获取二维码",
    icon: "error",
    actionText: "重新获取",
  },
  TASK_EXPIRED: {
    title: "二维码已过期",
    message: "请重新获取二维码",
    description: "二维码有效期为 10 分钟",
    icon: "expired",
    actionText: "重新获取",
  },
  ALREADY_CLAIMED: {
    title: "已经领取过了",
    message: "每个任务只能领取一次",
    icon: "error",
    actionText: "获取新二维码",
  },
  INVALID_TICKET: {
    title: "无效的票据",
    message: "请重新获取二维码",
    icon: "error",
    actionText: "重新获取",
  },
  PLATFORM_NOT_SUPPORTED: {
    title: "平台不支持",
    message: "当前平台暂不支持此功能",
    icon: "error",
    actionText: "返回",
  },
  NETWORK_ERROR: {
    title: "网络连接异常",
    message: "请检查您的网络连接",
    description: "网络不稳定，请稍后重试",
    icon: "error",
    actionText: "重试",
  },
  SERVER_ERROR: {
    title: "服务器繁忙",
    message: "请稍后再试",
    description: "我们的服务器正在处理大量请求，请耐心等待",
    icon: "error",
    actionText: "重试",
  },
};

// 解析后端错误响应
export function parseBackendError(error: any): { code: ErrorCode; message: string } {
  // 如果错误对象包含 code 字段
  if (error?.code && ERROR_CONFIG_MAP[error.code as ErrorCode]) {
    return {
      code: error.code as ErrorCode,
      message: error.message || ERROR_CONFIG_MAP[error.code as ErrorCode].message,
    };
  }

  // 根据错误消息内容匹配
  const errorMessage = typeof error === "string" ? error : error?.message || "";

  if (errorMessage.includes("DAILY_LIMIT_REACHED") || errorMessage.includes("每日限额")) {
    return { code: "DAILY_LIMIT_REACHED", message: errorMessage };
  }
  if (errorMessage.includes("RESOURCE_EMPTY") || errorMessage.includes("资源") || errorMessage.includes("告罄")) {
    return { code: "RESOURCE_EMPTY", message: errorMessage };
  }
  if (errorMessage.includes("TASK_NOT_FOUND") || errorMessage.includes("任务不存在")) {
    return { code: "TASK_NOT_FOUND", message: errorMessage };
  }
  if (errorMessage.includes("TASK_EXPIRED") || errorMessage.includes("过期")) {
    return { code: "TASK_EXPIRED", message: errorMessage };
  }
  if (errorMessage.includes("ALREADY_CLAIMED") || errorMessage.includes("已领取")) {
    return { code: "ALREADY_CLAIMED", message: errorMessage };
  }
  if (errorMessage.includes("INVALID_TICKET") || errorMessage.includes("无效票据")) {
    return { code: "INVALID_TICKET", message: errorMessage };
  }
  if (errorMessage.includes("NETWORK_ERROR") || errorMessage.includes("网络")) {
    return { code: "NETWORK_ERROR", message: errorMessage };
  }

  // 默认服务器错误
  return { code: "SERVER_ERROR", message: errorMessage };
}
