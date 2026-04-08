use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

// API 配置 - 编译时从环境变量读取
// 请确保在编译前设置了这些环境变量 (例如在 .env 文件中)
const QUICK_REGISTER_API_BASE: &str = env!("VITE_QUICK_REGISTER_API_BASE");
const APP_ID: &str = env!("VITE_APP_ID");
const APP_SECRET: &str = env!("VITE_APP_SECRET");

// 任务创建响应
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTaskResponse {
    pub success: bool,
    pub ticket: String,
    #[serde(rename = "qrcode_url")]
    pub qrcode_url: String,
    #[serde(rename = "is_vip")]
    pub is_vip: bool,
    #[serde(rename = "url_scheme")]
    pub url_scheme: String,
    pub message: String,
}

// 任务状态 - 使用小写字符串匹配后端返回
#[derive(Debug, Serialize, Deserialize)]
pub enum TaskStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "verified")]
    Verified,
    #[serde(rename = "expired")]
    Expired,
    #[serde(rename = "claimed")]
    Claimed,
}

// 查询任务状态响应
#[derive(Debug, Serialize, Deserialize)]
pub struct TaskStatusResponse {
    pub success: bool,
    pub ticket: Option<String>,
    pub status: TaskStatus,
    pub platform_id: Option<String>,
    pub created_at: Option<i64>,
    pub verified_at: Option<i64>,
    pub resource_payload: Option<Vec<ResourcePayload>>,
    pub access_token: Option<String>,
    pub platform: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResourcePayload {
    pub account: String,
    pub password: String,
}

// 领取资源响应
#[derive(Debug, Serialize, Deserialize)]
pub struct ClaimResourceResponse {
    pub success: bool,
    pub resource_payload: Vec<ResourcePayload>,
    pub message: String,
}

// 创建快速注册任务
#[tauri::command]
pub async fn quick_register_create_task(platform_id: String) -> Result<CreateTaskResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/task/create", QUICK_REGISTER_API_BASE);
    
    let body = serde_json::json!({
        "platform": "qq_id",
        "platform_id": platform_id,
        "app_id": APP_ID,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("app-id", APP_ID)
        .header("app-secret", APP_SECRET)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    // 保存状态码
    let status = response.status();
    
    // 先获取原始文本用于调试
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    
    // 检查 HTTP 状态码
    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }
    
    let result: CreateTaskResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}，原始数据: {}", e, text))?;

    Ok(result)
}

// 查询任务状态
#[tauri::command]
pub async fn quick_register_get_status(ticket: String) -> Result<TaskStatusResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!(
        "{}/api/user/get_result?ticket={}",
        QUICK_REGISTER_API_BASE,
        urlencoding::encode(&ticket)
    );

    let response = client
        .get(&url)
        .header("app-id", APP_ID)
        .header("app-secret", APP_SECRET)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    // 保存状态码
    let status = response.status();
    
    // 先获取原始文本用于调试
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    
    // 检查 HTTP 状态码
    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }
    
    let result: TaskStatusResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}，原始数据: {}", e, text))?;

    Ok(result)
}

// 领取资源
#[tauri::command]
pub async fn quick_register_claim_resource(ticket: String) -> Result<ClaimResourceResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/task/claim_resource", QUICK_REGISTER_API_BASE);
    
    let body = serde_json::json!({
        "ticket": ticket,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("app-id", APP_ID)
        .header("app-secret", APP_SECRET)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    // 保存状态码
    let status = response.status();
    
    // 先获取原始文本用于调试
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    
    // 检查 HTTP 状态码
    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }

    let result: ClaimResourceResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}，原始数据: {}", e, text))?;

    Ok(result)
}

// 统计响应
#[derive(Debug, Serialize, Deserialize)]
pub struct StatsResponse {
    pub success: bool,
    pub data: StatsData,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatsData {
    pub available_count: i32,
    pub resource_type: String,
}

// 获取剩余账号数量统计
#[tauri::command]
pub async fn quick_register_get_stats() -> Result<StatsResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/task/stats", QUICK_REGISTER_API_BASE);

    let response = client
        .get(&url)
        .header("app-id", APP_ID)
        .header("app-secret", APP_SECRET)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    // 保存状态码
    let status = response.status();

    // 先获取原始文本
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    // 检查 HTTP 状态码
    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }

    let result: StatsResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}", e))?;

    Ok(result)
}
