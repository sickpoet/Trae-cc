import { openUrl } from "@tauri-apps/plugin-opener";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date: string;
  downloadUrl: string;
}

// 获取当前版本
export function getCurrentVersion(): string {
  return "1.0.6";
}

// 检查更新
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const response = await fetch("https://hhh9201.github.io/Trea-cc/release/latest.json", {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });
    
    if (!response.ok) {
      // 静默失败，不抛出错误
      return null;
    }
    
    const data = await response.json();
    const currentVersion = getCurrentVersion();
    
    // 比较版本号
    if (isNewerVersion(data.version, currentVersion)) {
      return {
        version: data.version,
        currentVersion: currentVersion,
        notes: data.notes || "",
        date: data.pub_date || "",
        downloadUrl: data.download_url || `https://github.com/HHH9201/Trae-CC/releases/tag/v${data.version}`,
      };
    }
    
    return null;
  } catch (error) {
    // 静默失败，只在控制台记录错误
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
