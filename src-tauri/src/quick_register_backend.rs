use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use once_cell::sync::Lazy;

// API 配置 - 运行时从环境变量或配置文件读取
static QUICK_REGISTER_API_BASE: Lazy<String> = Lazy::new(|| {
    std::env::var("VITE_QUICK_REGISTER_API_BASE")
        .unwrap_or_else(|_| "https://hhxyyq.online".to_string())
});
static APP_ID: Lazy<String> = Lazy::new(|| {
    std::env::var("VITE_APP_ID")
        .unwrap_or_else(|_| "trae_email".to_string())
});
static APP_SECRET: Lazy<String> = Lazy::new(|| {
    std::env::var("VITE_APP_SECRET")
        .unwrap_or_else(|_| "trae_email_secret_key_2026".to_string())
});

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

    let url = format!("{}/api/task/create", *QUICK_REGISTER_API_BASE);
    
    let body = serde_json::json!({
        "platform": "qq_id",
        "platform_id": platform_id,
        "app_id": &*APP_ID,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
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
        *QUICK_REGISTER_API_BASE,
        urlencoding::encode(&ticket)
    );

    let response = client
        .get(&url)
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
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

    let url = format!("{}/api/task/claim_resource", *QUICK_REGISTER_API_BASE);
    
    let body = serde_json::json!({
        "ticket": ticket,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
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

// ============ 新流程：扫码即绑定，令牌即身份 ============

// 换取 PC Token 响应
#[derive(Debug, Serialize, Deserialize)]
pub struct PcTokenResponse {
    pub success: bool,
    #[serde(rename = "pc_bind_token")]
    pub pc_bind_token: Option<String>,
    pub message: Option<String>,
    pub code: Option<String>,
}

// 用户信息 - 基本信息
#[derive(Debug, Serialize, Deserialize)]
pub struct UserBasicInfo {
    pub openid: String,
    #[serde(rename = "virtual_id")]
    pub virtual_id: String,
    #[serde(rename = "qq_id")]
    pub qq_id: Option<String>,
    #[serde(rename = "is_vip")]
    pub is_vip: bool,
    #[serde(rename = "created_at")]
    pub created_at: String,
}

// 用户信息 - 领取限额
#[derive(Debug, Serialize, Deserialize)]
pub struct UserClaimLimit {
    #[serde(rename = "base_limit")]
    pub base_limit: i32,
    #[serde(rename = "bonus_limit")]
    pub bonus_limit: i32,
    #[serde(rename = "total_limit")]
    pub total_limit: i32,
    #[serde(rename = "current_usage")]
    pub current_usage: i32,
    pub remaining: i32,
}

// 用户信息 - 邀请信息
#[derive(Debug, Serialize, Deserialize)]
pub struct UserInvitation {
    #[serde(rename = "invite_code")]
    pub invite_code: Option<String>,
    #[serde(rename = "total_invited")]
    pub total_invited: i32,
    #[serde(rename = "is_invited")]
    pub is_invited: bool,
}

// 用户信息 - 数据
#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfoData {
    pub basic: UserBasicInfo,
    #[serde(rename = "claim_limit")]
    pub claim_limit: UserClaimLimit,
    pub invitation: UserInvitation,
}

// 用户信息响应
#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfoResponse {
    pub success: bool,
    pub openid: Option<String>,
    pub data: UserInfoData,
    pub message: Option<String>,
}

// 领取资源请求（新流程）
#[derive(Debug, Serialize, Deserialize)]
pub struct ClaimResourceNewRequest {
    pub ticket: String,
    #[serde(rename = "invite_code")]
    pub invite_code: Option<String>,
}

// 领取资源响应（新流程）
#[derive(Debug, Serialize, Deserialize)]
pub struct ClaimResourceNewResponse {
    pub success: bool,
    pub resource_payload: Vec<ResourcePayload>,
    pub message: String,
    pub code: Option<String>,
}

// 获取剩余账号数量统计
#[tauri::command]
pub async fn quick_register_get_stats() -> Result<StatsResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/task/stats", *QUICK_REGISTER_API_BASE);

    let response = client
        .get(&url)
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
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

// ============ 新流程 API 实现 ============

// 换取 PC 绑定令牌
#[tauri::command]
pub async fn exchange_pc_token(ticket: String) -> Result<PcTokenResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/task/pc_token/{}", *QUICK_REGISTER_API_BASE, urlencoding::encode(&ticket));

    let response = client
        .get(&url)
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }

    let result: PcTokenResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}，原始数据: {}", e, text))?;

    // 如果后端返回 success: false，返回错误
    if !result.success {
        let code = result.code.clone().unwrap_or_default();
        let message = result.message.clone().unwrap_or_default();
        return Err(format!("{}: {}", code, message));
    }

    Ok(result)
}

// 获取用户信息（需要 PC Token）
#[tauri::command]
pub async fn get_user_info(pc_token: String) -> Result<UserInfoResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/user_center/me", *QUICK_REGISTER_API_BASE);

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", pc_token))
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if status.as_u16() == 401 {
        return Err("UNAUTHORIZED: Token 已过期或无效".to_string());
    }

    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }

    let result: UserInfoResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}，原始数据: {}", e, text))?;

    Ok(result)
}

// 领取资源（新流程，需要 PC Token）
#[tauri::command]
pub async fn claim_resource_with_token(
    pc_token: String,
    ticket: String,
    invite_code: Option<String>,
) -> Result<ClaimResourceNewResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/api/task/claim_resource", *QUICK_REGISTER_API_BASE);

    let body = serde_json::json!({
        "ticket": ticket,
        "invite_code": invite_code,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", pc_token))
        .header("app-id", &*APP_ID)
        .header("app-secret", &*APP_SECRET)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if status.as_u16() == 401 {
        return Err("UNAUTHORIZED: Token 已过期或无效".to_string());
    }

    if status.as_u16() == 429 {
        return Err("RATE_LIMITED: 操作太快了，请 10 秒后再试".to_string());
    }

    if !status.is_success() {
        return Err(format!("服务器错误 ({}): {}", status, text));
    }

    let result: ClaimResourceNewResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {}，原始数据: {}", e, text))?;

    Ok(result)
}
