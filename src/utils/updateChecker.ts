import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date: string;
  downloadUrl: string;
}

// 从 package.json 动态获取当前版本
export function getCurrentVersion(): string {
  return import.meta.env.PACKAGE_VERSION || "1.0.7";
}

// 检查更新 - 使用 Rust 后端进行 HTTP 请求以绕过 CORS
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const currentVersion = getCurrentVersion();
    console.log("[Update Check] 当前版本:", currentVersion);

    // 使用 Rust 后端进行 HTTP 请求
    const data = await invoke<{
      version: string;
      notes?: string;
      pub_date?: string;
      download_url?: string;
    }>("check_update_backend");

    console.log("[Update Check] 服务器版本:", data.version);
    console.log("[Update Check] 服务器返回数据:", JSON.stringify(data, null, 2));

    // 比较版本号
    const hasUpdate = isNewerVersion(data.version, currentVersion);
    console.log("[Update Check] 是否有更新:", hasUpdate);

    if (hasUpdate) {
      return {
        version: data.version,
        currentVersion: currentVersion,
        notes: data.notes || "",
        date: data.pub_date || "",
        downloadUrl: data.download_url || `https://github.com/HHH9201/Trae-cc/releases/tag/v${data.version}`,
      };
    }

    return null;
  } catch (error: any) {
    console.log("[Update Check] 检查更新失败:", error);
    // 显示详细错误信息
    alert(
      `检查更新失败:\n${
        error.message || error
      }\n\n请检查网络连接。如果持续失败，您可以访问 GitHub Releases 页面手动下载最新版本：\nhttps://github.com/HHH9201/Trae-cc/releases`
    );
    return null;
  }
}

// 比较版本号
function isNewerVersion(newVersion: string, currentVersion: string): boolean {
  const parseVersion = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const newParts = parseVersion(newVersion);
  const currentParts = parseVersion(currentVersion);
  
  for (let i = 0; i < Math.max(newParts.length, currentParts.length); i++) {
    const newPart = newParts[i] || 0;
    const currentPart = currentParts[i] || 0;
    
    if (newPart > currentPart) return true;
    if (newPart < currentPart) return false;
  }
  
  return false;
}

// 打开下载页面
export async function openDownloadPage(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("打开下载页面失败:", error);
    throw error;
  }
}
