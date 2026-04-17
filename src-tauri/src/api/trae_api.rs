use anyhow::{anyhow, Result};
use reqwest::{header, Client, Url};
use reqwest::cookie::{CookieStore, Jar};
use serde_json::json;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use std::sync::Arc;
use chrono::{Local, SecondsFormat, Utc};

use super::types::*;

const API_BASE_US: &str = "https://api-us-east.trae.ai";
const API_BASE_SG: &str = "https://api-sg-central.trae.ai";
const API_BASE_UG: &str = "https://ug-normal.trae.ai";

pub struct EmailLoginResult {
    pub token: String,
    pub user_id: String,
    pub tenant_id: String,
    pub cookies: String,
    pub expired_at: String,
}

pub struct TraeApiClient {
    client: Client,
    cookies: String,
    jwt_token: Option<String>,
    api_base: String,
}

impl TraeApiClient {
    pub fn new(cookies: &str) -> Result<Self> {
        let client = Client::builder().build()?;

        let cleaned_cookies = cookies
            .lines()
            .map(|line| line.trim())
            .collect::<Vec<_>>()
            .join("")
            .replace("  ", " ");

        let api_base = Self::detect_api_base_from_cookies(&cleaned_cookies);

        Ok(Self {
            client,
            cookies: cleaned_cookies,
            jwt_token: None,
            api_base,
        })
    }

    pub fn new_with_token(token: &str) -> Result<Self> {
        let client = Client::builder().build()?;

        Ok(Self {
            client,
            cookies: String::new(),
            jwt_token: Some(token.to_string()),
            api_base: API_BASE_SG.to_string(),
        })
    }

    pub fn new_with_token_and_cookies(token: &str, cookies: &str) -> Result<Self> {
        let mut client = Self::new(cookies)?;
        client.jwt_token = Some(token.to_string());
        Ok(client)
    }

    fn detect_api_base_from_cookies(cookies: &str) -> String {
        if cookies.contains("store-idc=useast") || cookies.contains("trae-target-idc=useast") {
            API_BASE_US.to_string()
        } else if cookies.contains("store-idc=alisg") || cookies.contains("trae-target-idc=alisg") {
            API_BASE_SG.to_string()
        } else if cookies.contains("store-idc=apjpn") || cookies.contains("trae-target-idc=apjpn") {
            // 日本区域使用 SG 的 API 基础域名
            API_BASE_SG.to_string()
        } else if cookies.contains("store-country-code=us") {
            API_BASE_US.to_string()
        } else if cookies.contains("store-country-code=jp") {
            API_BASE_SG.to_string()
        } else {
            API_BASE_SG.to_string()
        }
    }

    fn build_headers_token_only(&self) -> Result<header::HeaderMap> {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse()?);
        headers.insert(header::ACCEPT, "application/json, text/plain, */*".parse()?);
        headers.insert(header::ORIGIN, "https://www.trae.ai".parse()?);
        headers.insert(header::REFERER, "https://www.trae.ai/".parse()?);
        headers.insert(
            header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36".parse()?,
        );

        if let Some(token) = &self.jwt_token {
            let auth_value = header::HeaderValue::from_bytes(
                format!("Cloud-IDE-JWT {}", token).as_bytes()
            ).map_err(|e| anyhow!("Token 格式错误: {}", e))?;
            headers.insert(header::AUTHORIZATION, auth_value);
        }

        Ok(headers)
    }

    pub async fn get_user_info_by_token(&self) -> Result<TokenUserInfo> {
        let token = self.jwt_token.as_ref().ok_or_else(|| anyhow!("Token 不存在"))?;
        let jwt_data = Self::parse_jwt_token(token)?;

        let headers = self.build_headers_token_only()?;
        let endpoints = [&self.api_base, API_BASE_SG, API_BASE_US];

        let mut last_error = anyhow!("所有 API 端点都失败");

        for base in endpoints.iter() {
            let url = format!("{}/trae/api/v1/pay/user_current_entitlement_list", base);

            let response = self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&json!({"require_usage": true}))
                .send()
                .await;

            match response {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<EntitlementListResponse>().await {
                        Ok(data) => {
                            let user_id_from_api = data.user_entitlement_pack_list
                                .first()
                                .map(|p| p.entitlement_base_info.user_id.clone())
                                .unwrap_or_else(|| jwt_data.user_id.clone());

                            let user_detail = self.get_user_info_with_token().await.ok();

                            return Ok(TokenUserInfo {
                                user_id: user_id_from_api,
                                tenant_id: jwt_data.tenant_id,
                                screen_name: user_detail.as_ref().map(|u| u.screen_name.clone()),
                                avatar_url: user_detail.as_ref().and_then(|u| {
                                    if u.avatar_url.is_empty() { None } else { Some(u.avatar_url.clone()) }
                                }),
                                email: user_detail.as_ref().and_then(|u| u.non_plain_text_email.clone()),
                            });
                        }
                        Err(e) => last_error = anyhow!("解析响应失败: {}", e),
                    }
                }
                Ok(resp) => last_error = anyhow!("API 返回错误: {}", resp.status()),
                Err(e) => last_error = anyhow!("请求失败: {}", e),
            }
        }

        Err(last_error)
    }

    async fn get_user_info_with_token(&self) -> Result<UserInfoResult> {
        let headers = self.build_headers_token_only()?;
        let endpoints = [API_BASE_UG, API_BASE_SG, API_BASE_US];
        
        let mut last_error = anyhow!("所有 GetUserInfo API 端点都失败");
        
        for base in endpoints.iter() {
            let url = format!("{}/cloudide/api/v3/trae/GetUserInfo", base);
            println!("[TraeApiClient] 尝试 GetUserInfo 端点: {}", base);

            match self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&json!({"IfWebPage": true}))
                .send()
                .await 
            {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<GetUserInfoResponse>().await {
                        Ok(data) => return Ok(data.result),
                        Err(e) => {
                            println!("[TraeApiClient] 解析响应失败: {}", e);
                            last_error = anyhow!("解析响应失败: {}", e);
                        }
                    }
                }
                Ok(resp) => {
                    println!("[TraeApiClient] GetUserInfo API 返回错误: {}", resp.status());
                    last_error = anyhow!("API 返回错误: {}", resp.status());
                }
                Err(e) => {
                    println!("[TraeApiClient] GetUserInfo 请求失败: {}", e);
                    last_error = anyhow!("请求失败: {}", e);
                }
            }
        }

        // 所有 GetUserInfo API 端点都失败，尝试从 Token 解析基本信息
        println!("[TraeApiClient] 所有 GetUserInfo API 端点都失败，尝试从 Token 解析");
        
        if let Some(ref token) = self.jwt_token {
            if let Ok(jwt_data) = Self::parse_jwt_token(token) {
                return Ok(UserInfoResult {
                    screen_name: format!("User_{}", &jwt_data.user_id[..8.min(jwt_data.user_id.len())]),
                    gender: String::new(),
                    avatar_url: String::new(),
                    user_id: jwt_data.user_id,
                    description: String::new(),
                    tenant_id: jwt_data.tenant_id,
                    register_time: String::new(),
                    last_login_time: String::new(),
                    last_login_type: String::new(),
                    region: String::new(),
                    ai_region: Some(String::new()),
                    non_plain_text_email: None,
                    store_country: None,
                });
            }
        }

        Err(last_error)
    }

    fn parse_jwt_token(token: &str) -> Result<JwtPayload> {
        // URL 解码 token（如果它被编码了）
        let decoded_token = urlencoding::decode(token)
            .map_err(|e| anyhow!("URL 解码 token 失败: {}", e))?
            .to_string();
        
        let parts: Vec<&str> = decoded_token.split('.').collect();
        if parts.len() != 3 {
            return Err(anyhow!("无效的 JWT Token 格式，包含 {} 个部分", parts.len()));
        }

        let payload_b64 = parts[1];
        println!("[parse_jwt_token] Payload base64 长度: {}", payload_b64.len());
        
        let padding = (4 - payload_b64.len() % 4) % 4;
        let padded = format!("{}{}", payload_b64, "=".repeat(padding));
        let standard_b64 = padded.replace('-', "+").replace('_', "/");
        
        println!("[parse_jwt_token] 标准 base64 长度: {}", standard_b64.len());

        let payload_bytes = BASE64.decode(&standard_b64)
            .map_err(|e| anyhow!("解码 JWT payload 失败: {}，输入: {}", e, &standard_b64[..standard_b64.len().min(50)]))?;

        let payload_str = String::from_utf8(payload_bytes)
            .map_err(|e| anyhow!("JWT payload 不是有效的 UTF-8: {}", e))?;
        
        println!("[parse_jwt_token] Payload JSON: {}", &payload_str[..payload_str.len().min(100)]);

        let payload: JwtPayloadRaw = serde_json::from_str(&payload_str)
            .map_err(|e| anyhow!("解析 JWT payload 失败: {}", e))?;

        Ok(JwtPayload {
            user_id: payload.data.id,
            tenant_id: payload.data.tenant_id,
        })
    }

    fn build_headers(&self, with_auth: bool) -> Result<header::HeaderMap> {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse()?);
        headers.insert(header::ACCEPT, "application/json, text/plain, */*".parse()?);

        if !self.cookies.trim().is_empty() {
            let cookie_value = header::HeaderValue::from_bytes(self.cookies.as_bytes())
                .map_err(|e| anyhow!("Cookie 格式错误: {}", e))?;
            headers.insert(header::COOKIE, cookie_value);
        }

        headers.insert(header::ORIGIN, "https://www.trae.ai".parse()?);
        headers.insert(header::REFERER, "https://www.trae.ai/".parse()?);
        headers.insert(
            header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".parse()?,
        );

        if with_auth {
            if let Some(token) = &self.jwt_token {
                let auth_value = header::HeaderValue::from_bytes(
                    format!("Cloud-IDE-JWT {}", token).as_bytes()
                ).map_err(|e| anyhow!("Token 格式错误: {}", e))?;
                headers.insert(header::AUTHORIZATION, auth_value);
            }
        }

        Ok(headers)
    }

    pub async fn get_user_token(&mut self) -> Result<UserTokenResult> {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".parse()?);
        headers.insert(header::CONTENT_TYPE, "application/json".parse()?);
        headers.insert(header::ACCEPT, "application/json, text/plain, */*".parse()?);
        headers.insert(header::ORIGIN, "https://www.trae.ai".parse()?);
        headers.insert(header::REFERER, "https://www.trae.ai/".parse()?);
        
        if !self.cookies.trim().is_empty() {
            let cookie_value = header::HeaderValue::from_bytes(self.cookies.as_bytes())
                .map_err(|e| anyhow!("Cookie 格式错误: {}", e))?;
            headers.insert(header::COOKIE, cookie_value);
        }

        // 所有端点按优先级排序
        let endpoints = vec![
            (self.api_base.as_str(), "Primary"),
            (API_BASE_SG, "SG"),
            (API_BASE_US, "US"),
            (API_BASE_UG, "UG"),
        ];
        
        let mut last_error = anyhow!("所有端点都失败");
        
        for (base, name) in endpoints {
            let url = format!("{}/cloudide/api/v3/common/GetUserToken", base);
            println!("[TraeApiClient] 尝试 GetUserToken 端点: {} ({})", name, base);
            
            // 每个端点重试2次
            for attempt in 0..2 {
                if attempt > 0 {
                    println!("[TraeApiClient] 端点 {} 第 {} 次重试...", name, attempt + 1);
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
                
                let response = match self.client.post(&url).headers(headers.clone()).body("{}").send().await {
                    Ok(resp) => resp,
                    Err(e) => {
                        println!("[TraeApiClient] 端点 {} 请求失败: {}", name, e);
                        last_error = anyhow!("请求错误: {}", e);
                        continue;
                    }
                };

                let status = response.status();
                if status.is_success() {
                    match response.json::<GetUserTokenResponse>().await {
                        Ok(data) => {
                            println!("[TraeApiClient] ✅ GetUserToken 成功: {}", name);
                            self.jwt_token = Some(data.result.token.clone());
                            if base != self.api_base {
                                self.api_base = base.to_string();
                            }
                            return Ok(data.result);
                        }
                        Err(e) => {
                            println!("[TraeApiClient] 端点 {} 解析响应失败: {}", name, e);
                            last_error = anyhow!("解析响应失败: {}", e);
                        }
                    }
                } else if status == reqwest::StatusCode::UNAUTHORIZED {
                    println!("[TraeApiClient] 端点 {} 授权失败 (401)，Cookie 可能已失效", name);
                    last_error = anyhow!("授权失败 (401)");
                    // 如果是 401，通常重试也没用，直接跳过当前端点的重试
                    break;
                } else {
                    println!("[TraeApiClient] 端点 {} 返回错误状态: {}", name, status);
                    last_error = anyhow!("HTTP 错误: {}", status);
                }
            }
        }

        Err(anyhow!("获取 Token 失败: {}", last_error))
    }

    pub async fn get_user_info(&self) -> Result<UserInfoResult> {
        let headers = self.build_headers(false)?;
        let endpoints = [API_BASE_UG, API_BASE_SG, API_BASE_US];
        
        let mut last_error = anyhow!("所有 GetUserInfo 端点都失败");
        
        for base in endpoints.iter() {
            let url = format!("{}/cloudide/api/v3/trae/GetUserInfo", base);
            println!("[TraeApiClient] 尝试 GetUserInfo 端点: {}", base);

            match self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&json!({"IfWebPage": true}))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<GetUserInfoResponse>().await {
                        Ok(data) => return Ok(data.result),
                        Err(e) => {
                            println!("[TraeApiClient] 端点 {} 解析失败: {}", base, e);
                            last_error = anyhow!("解析失败: {}", e);
                        }
                    }
                }
                Ok(resp) => {
                    println!("[TraeApiClient] 端点 {} 返回错误: {}", base, resp.status());
                    last_error = anyhow!("HTTP 错误: {}", resp.status());
                }
                Err(e) => {
                    println!("[TraeApiClient] 端点 {} 请求失败: {}", base, e);
                    last_error = anyhow!("请求失败: {}", e);
                }
            }
        }

        // 所有 GetUserInfo 端点都失败，尝试从 Token 解析基本信息
        println!("[TraeApiClient] 所有 GetUserInfo 端点都失败，尝试从 Token 解析用户信息");
        
        if let Some(ref token) = self.jwt_token {
            if let Ok(jwt_data) = Self::parse_jwt_token(token) {
                return Ok(UserInfoResult {
                    screen_name: format!("User_{}", &jwt_data.user_id[..8.min(jwt_data.user_id.len())]),
                    gender: String::new(),
                    avatar_url: String::new(),
                    user_id: jwt_data.user_id,
                    description: String::new(),
                    tenant_id: jwt_data.tenant_id,
                    register_time: String::new(),
                    last_login_time: String::new(),
                    last_login_type: String::new(),
                    region: String::new(),
                    ai_region: Some(String::new()),
                    non_plain_text_email: None,
                    store_country: None,
                });
            }
        }

        Err(last_error)
    }

    pub async fn get_entitlement_list(&self) -> Result<EntitlementListResponse> {
        let headers = self.build_headers(true)?;
        let endpoints = [self.api_base.as_str(), API_BASE_SG, API_BASE_US, API_BASE_UG];
        
        let mut last_error = anyhow!("所有 entitlement 端点都失败");
        
        for base in endpoints.iter() {
            let url = format!("{}/trae/api/v1/pay/user_current_entitlement_list", base);
            println!("[TraeApiClient] 尝试 entitlement 端点: {}", base);
            
            match self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&json!({"require_usage": true}))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<EntitlementListResponse>().await {
                        Ok(data) => {
                            println!("[TraeApiClient] ✅ entitlement 成功: {}", base);
                            return Ok(data);
                        }
                        Err(e) => {
                            println!("[TraeApiClient] 端点 {} 解析失败: {}", base, e);
                            last_error = anyhow!("解析失败: {}", e);
                        }
                    }
                }
                Ok(resp) => {
                    println!("[TraeApiClient] 端点 {} 返回错误: {}", base, resp.status());
                    last_error = anyhow!("HTTP 错误: {}", resp.status());
                }
                Err(e) => {
                    println!("[TraeApiClient] 端点 {} 请求失败: {}", base, e);
                    last_error = anyhow!("请求失败: {}", e);
                }
            }
        }
        
        Err(last_error)
    }

    pub async fn query_usage(
        &self,
        start_time: i64,
        end_time: i64,
        page_size: i32,
        page_num: i32,
    ) -> Result<UsageQueryResponse> {
        let url = format!("{}/trae/api/v1/pay/query_user_usage_group_by_session", self.api_base);
        let headers = self.build_headers(true)?;

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&json!({
                "start_time": start_time,
                "end_time": end_time,
                "page_size": page_size,
                "page_num": page_num
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("查询使用记录失败: {}", response.status()));
        }

        let data: UsageQueryResponse = response.json().await?;
        Ok(data)
    }

    pub async fn get_usage_summary(&mut self) -> Result<UsageSummary> {
        if self.jwt_token.is_none() {
            self.get_user_token().await?;
        }

        let entitlements = self.get_entitlement_list().await?;
        Self::parse_entitlements_to_summary(entitlements)
    }

    pub async fn get_usage_summary_by_token(&self) -> Result<UsageSummary> {
        let headers = self.build_headers_token_only()?;
        let endpoints = [&self.api_base, API_BASE_SG, API_BASE_US];

        let mut last_error = anyhow!("所有 API 端点都失败");

        for base in endpoints.iter() {
            let url = format!("{}/trae/api/v1/pay/user_current_entitlement_list", base);
            // println!("[TraeApiClient] 尝试获取额度信息: {}", base);

            let response = self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&json!({"require_usage": true}))
                .send()
                .await;

            match response {
                Ok(resp) if resp.status().is_success() => {
                    let response_text = resp.text().await?;
                    // println!("[TraeApiClient] 端点 {} 响应长度: {}", base, response_text.len());

                    if !response_text.contains("user_entitlement_pack_list") {
                        println!("[TraeApiClient] 端点 {} 响应不包含 user_entitlement_pack_list", base);
                        last_error = anyhow!("响应不包含额度信息");
                        continue;
                    }

                    match serde_json::from_str::<EntitlementListResponse>(&response_text) {
                        Ok(entitlements) => {
                            // println!("[TraeApiClient] ✅ 成功获取额度信息: {}", base);
                            return Self::parse_entitlements_to_summary(entitlements);
                        }
                        Err(e) => {
                            println!("[TraeApiClient] 解析响应失败: {}", e);
                            last_error = anyhow!("解析响应失败: {}", e);
                        }
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    println!("[TraeApiClient] 端点 {} 返回错误: {}", base, status);
                    last_error = anyhow!("API 返回错误: {}", status);
                }
                Err(e) => {
                    println!("[TraeApiClient] 端点 {} 请求失败: {}", base, e);
                    last_error = anyhow!("请求失败: {}", e);
                }
            }
        }

        Err(last_error)
    }

    fn parse_entitlements_to_summary(entitlements: EntitlementListResponse) -> Result<UsageSummary> {
        let mut summary = UsageSummary::default();
        summary.is_dollar_billing = entitlements.is_dollar_usage_billing;

        for pack in entitlements.user_entitlement_pack_list {
            let base = &pack.entitlement_base_info;
            let usage = &pack.usage;
            let quota = &base.quota;

            if base.product_type == 2 {
                // Extra pack (e.g., Anniversary Treat) - accumulate bonus
                summary.extra_fast_request_limit = quota.premium_model_fast_request_limit;
                summary.extra_fast_request_used = usage.premium_model_fast_amount;
                summary.extra_fast_request_left = summary.extra_fast_request_limit as f64 - summary.extra_fast_request_used;
                summary.extra_expire_time = base.end_time;

                if let Some(pkg_extra) = &base.product_extra.package_extra {
                    if pkg_extra.package_source_type == 6 {
                        summary.extra_package_name = "2026 Anniversary Treat".to_string();
                    }
                }
                
                // Also accumulate bonus from extra packs
                let bonus_limit = quota.bonus_usage_limit as f64;
                let bonus_used = usage.bonus_usage_amount;
                summary.bonus_dollar_limit += bonus_limit;
                summary.bonus_dollar_used += bonus_used;
                
                log::info!("Extra pack bonus - limit: {}, used: {}", bonus_limit, bonus_used);
            } else {
                // Main plan (Free/Pro)
                summary.plan_type = if base.product_id == 0 { "Free".to_string() } else { "Pro".to_string() };
                summary.reset_time = base.end_time;

                summary.fast_request_limit = quota.premium_model_fast_request_limit;
                summary.fast_request_used = usage.premium_model_fast_amount;
                summary.fast_request_left = summary.fast_request_limit as f64 - summary.fast_request_used;

                let basic_limit = quota.basic_usage_limit as f64;
                let basic_used = usage.basic_usage_amount;
                summary.basic_dollar_limit = basic_limit;
                summary.basic_dollar_used = basic_used;
                summary.basic_dollar_left = basic_limit - basic_used;

                let bonus_limit = quota.bonus_usage_limit as f64;
                let bonus_used = usage.bonus_usage_amount;
                summary.bonus_dollar_limit += bonus_limit;
                summary.bonus_dollar_used += bonus_used;
                
                log::info!("Main pack - basic_limit: {}, bonus_limit: {}", basic_limit, bonus_limit);
                log::info!("Main pack - basic_used: {}, bonus_used: {}", basic_used, bonus_used);

                summary.slow_request_limit = quota.premium_model_slow_request_limit;
                summary.slow_request_used = usage.premium_model_slow_amount;
                summary.slow_request_left = summary.slow_request_limit as f64 - summary.slow_request_used;

                summary.advanced_model_limit = quota.advanced_model_request_limit;
                summary.advanced_model_used = usage.advanced_model_amount;
                summary.advanced_model_left = summary.advanced_model_limit as f64 - summary.advanced_model_used;

                summary.autocomplete_limit = quota.auto_completion_limit;
                summary.autocomplete_used = usage.auto_completion_amount;
                summary.autocomplete_left = summary.autocomplete_limit as f64 - summary.autocomplete_used;
            }
        }
        
        // Calculate final values after processing all packs
        summary.bonus_dollar_left = summary.bonus_dollar_limit - summary.bonus_dollar_used;
        summary.fast_dollar_limit = summary.basic_dollar_limit + summary.bonus_dollar_limit;
        summary.fast_dollar_used = summary.basic_dollar_used + summary.bonus_dollar_used;
        summary.fast_dollar_left = summary.fast_dollar_limit - summary.fast_dollar_used;
        
        log::info!("Final - total bonus_limit: {}, total bonus_used: {}", summary.bonus_dollar_limit, summary.bonus_dollar_used);
        log::info!("Final - total limit: {}, total used: {}", summary.fast_dollar_limit, summary.fast_dollar_used);

        Ok(summary)
    }

    pub async fn get_user_statistic_data(&self) -> Result<UserStatisticResult> {
        let headers = self.build_headers(true)?;
        let endpoints = [API_BASE_UG, API_BASE_SG, API_BASE_US];

        let local = Local::now();
        let offset = local.offset().local_minus_utc();
        let offset_minutes = offset.div_euclid(60);
        let offset_hours = offset.div_euclid(3600);

        let payload = json!({
            "LocalTime": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "Offset": offset_hours,
            "OffsetMinutes": offset_minutes
        });

        let mut last_error = anyhow!("所有 GetUserStasticData 端点都失败");

        for base in endpoints.iter() {
            let url = format!("{}/cloudide/api/v3/trae/GetUserStasticData", base);
            println!("[TraeApiClient] 尝试 GetUserStasticData 端点: {}", base);

            match self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    // 先获取原始文本以便调试
                    match resp.text().await {
                        Ok(text) => {
                            println!("[TraeApiClient] 端点 {} 返回数据 (前500字符): {}", base, &text[..text.len().min(500)]);
                            match serde_json::from_str::<GetUserStatisticResponse>(&text) {
                                Ok(data) => {
                                    println!("[TraeApiClient] 解析成功, Result 字段:");
                                    println!("  UserID: {}", data.result.user_id);
                                    println!("  RegisterDays: {}", data.result.register_days);
                                    println!("  AiCnt365d count: {}", data.result.ai_cnt_365d.len());
                                    return Ok(data.result);
                                }
                                Err(e) => {
                                    println!("[TraeApiClient] 端点 {} 解析失败: {}", base, e);
                                    last_error = anyhow!("解析失败: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            println!("[TraeApiClient] 端点 {} 读取响应失败: {}", base, e);
                            last_error = anyhow!("读取响应失败: {}", e);
                        }
                    }
                }
                Ok(resp) => {
                    println!("[TraeApiClient] 端点 {} 返回错误: {}", base, resp.status());
                    last_error = anyhow!("HTTP 错误: {}", resp.status());
                }
                Err(e) => {
                    println!("[TraeApiClient] 端点 {} 请求失败: {}", base, e);
                    last_error = anyhow!("请求失败: {}", e);
                }
            }
        }

        Err(last_error)
    }

    pub async fn query_birthday_bonus(&self) -> Result<bool> {
        let url = format!("{}/trae/api/v1/pay/query_birthday_bonus", self.api_base);
        let headers = self.build_headers(true)?;

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&json!({}))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("查询生日奖励失败: {}", response.status()));
        }

        let data: serde_json::Value = response.json().await?;
        let claimed = data.get("result")
            .and_then(|r| r.get("claimed"))
            .and_then(|c| c.as_bool())
            .unwrap_or(false);
        
        Ok(claimed)
    }

    pub async fn claim_birthday_bonus(&self) -> Result<()> {
        let url = format!("{}/trae/api/v1/pay/claim_birthday_bonus", self.api_base);
        let headers = self.build_headers(true)?;

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&json!({}))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("领取生日奖励失败: {}", response.status()));
        }

        let data: serde_json::Value = response.json().await?;
        let success = data.get("result")
            .and_then(|r| r.get("success"))
            .and_then(|s| s.as_bool())
            .unwrap_or(false);
        
        if !success {
            let msg = data.get("result")
                .and_then(|r| r.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("领取失败");
            return Err(anyhow!("{}", msg));
        }

        Ok(())
    }
}

pub async fn login_with_email(email: &str, password: &str) -> Result<EmailLoginResult> {
    fn encode_xor_hex(input: &str) -> String {
        input
            .as_bytes()
            .iter()
            .map(|b| format!("{:02x}", b ^ 0x05))
            .collect::<Vec<_>>()
            .join("")
    }

    let cookie_jar = Arc::new(Jar::default());
    let client = Client::builder()
        .cookie_store(true)
        .cookie_provider(cookie_jar.clone())
        .build()?;

    let init_url = "https://www.trae.ai/login";
    let _ = client
        .get(init_url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send()
        .await?;

    let encoded_email = encode_xor_hex(email);
    let encoded_password = encode_xor_hex(password);
    let login_body = [
        ("mix_mode", "1"),
        ("fixed_mix_mode", "1"),
        ("email", encoded_email.as_str()),
        ("password", encoded_password.as_str()),
    ];
    let login_params = [
        ("aid", "677332"),
        ("account_sdk_source", "web"),
        ("sdk_version", "2.1.10-tiktok"),
        ("language", "en"),
    ];

    // 尝试多个域名（SG -> US -> JP -> HK/TW）
    let login_urls = [
        "https://ug-normal.trae.ai/passport/web/email/login/",
        "https://ug-normal.us.trae.ai/passport/web/email/login/",
        "https://ug-normal.jp.trae.ai/passport/web/email/login/",
        "https://ug-normal.sg.trae.ai/passport/web/email/login/",
    ];

    let mut last_error = String::new();
    let mut login_result_json: Option<serde_json::Value> = None;
    let mut successful_domain_idx = 0; // 记录成功登录的域名索引

    for (idx, login_url) in login_urls.iter().enumerate() {
        println!("[login_with_email] 尝试登录域名 {}: {}", idx + 1, login_url);
        
        let login_response = client
            .post(*login_url)
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header(header::ORIGIN, "https://www.trae.ai")
            .header(header::REFERER, "https://www.trae.ai/")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .query(&login_params)
            .form(&login_body)
            .send()
            .await;

        match login_response {
            Ok(resp) => {
                if let Ok(body) = resp.text().await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                        let error_code = json.get("error_code")
                            .and_then(|v| v.as_i64())
                            .unwrap_or_else(|| {
                                let ok = json.get("message")
                                    .and_then(|v| v.as_str())
                                    .map(|m| m.eq_ignore_ascii_case("success"))
                                    .unwrap_or(false);
                                if ok { 0 } else { -1 }
                            });

                        if error_code == 0 {
                            println!("[login_with_email] ✅ 域名 {} 登录成功", idx + 1);
                            login_result_json = Some(json);
                            successful_domain_idx = idx; // 记录成功登录的域名索引
                            break;
                        } else {
                            let desc = json.get("data")
                                .and_then(|d| d.get("description"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("未知错误");
                            println!("[login_with_email] 域名 {} 登录失败: {}", idx + 1, desc);
                            last_error = format!("{}: {}", login_url, desc);
                        }
                    }
                }
            }
            Err(e) => {
                println!("[login_with_email] 域名 {} 请求失败: {}", idx + 1, e);
                last_error = format!("{}: {}", login_url, e);
            }
        }
    }

    let _login_result = match login_result_json {
        Some(json) => json,
        None => return Err(anyhow!("所有登录域名都失败，最后一个错误: {}", last_error)),
    };

    // 根据登录成功的域名选择对应的 Trae Login URL
    // 定义所有区域的 Trae Login URL（顺序与 login_urls 对应）
    let trae_login_urls = [
        "https://ug-normal.trae.ai/cloudide/api/v3/trae/Login?type=email",
        "https://ug-normal.us.trae.ai/cloudide/api/v3/trae/Login?type=email",
        "https://ug-normal.jp.trae.ai/cloudide/api/v3/trae/Login?type=email",
        "https://ug-normal.sg.trae.ai/cloudide/api/v3/trae/Login?type=email",
    ];
    
    // 优先使用登录成功的域名，然后尝试其他域名
    let mut trae_login_success = false;
    // successful_domain_idx 已经在前面定义并记录了成功登录的域名索引
    
    // 先尝试登录成功的域名
    let primary_trae_url = trae_login_urls[successful_domain_idx];
    println!("[login_with_email] 尝试主 Trae Login API: {}", primary_trae_url);
    
    let trae_login_response = client
        .post(primary_trae_url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::ORIGIN, "https://www.trae.ai")
        .header(header::REFERER, "https://www.trae.ai/")
        .header(header::CONTENT_TYPE, "application/json")
        .send()
        .await;

    match trae_login_response {
        Ok(resp) => {
            let trae_status = resp.status();
            let _ = resp.text().await;
            println!("[login_with_email] 主 Trae Login 响应状态: {}", trae_status);
            if trae_status.is_success() {
                println!("[login_with_email] ✅ 主 Trae Login 成功");
                trae_login_success = true;
            }
        }
        Err(e) => {
            println!("[login_with_email] 主 Trae Login 请求失败: {}", e);
        }
    }
    
    // 如果主域名失败，尝试其他域名
    if !trae_login_success {
        for (idx, trae_login_url) in trae_login_urls.iter().enumerate() {
            if idx == successful_domain_idx {
                continue; // 跳过已经尝试过的主域名
            }
            
            println!("[login_with_email] 尝试备用 Trae Login API: {}", trae_login_url);
            
            let trae_login_response = client
                .post(*trae_login_url)
                .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                .header(header::ORIGIN, "https://www.trae.ai")
                .header(header::REFERER, "https://www.trae.ai/")
                .header(header::CONTENT_TYPE, "application/json")
                .send()
                .await;

            match trae_login_response {
                Ok(resp) => {
                    let trae_status = resp.status();
                    let _ = resp.text().await;
                    println!("[login_with_email] 备用 Trae Login 响应状态: {}", trae_status);
                    if trae_status.is_success() {
                        println!("[login_with_email] ✅ 备用 Trae Login 成功");
                        trae_login_success = true;
                        break;
                    }
                }
                Err(e) => {
                    println!("[login_with_email] 备用 Trae Login 请求失败: {}", e);
                }
            }
        }
    }

    if !trae_login_success {
        return Err(anyhow!("所有 Trae Login API 都失败"));
    }

    let check_url = Url::parse("https://www.trae.ai")?;
    let _cookies_str = cookie_jar.cookies(&check_url)
        .map(|v| v.to_str().unwrap_or_default().to_string())
        .unwrap_or_default();
    
    // 尝试多个域名获取 Token（使用 ug-normal 域名，与登录一致）
    // 定义所有区域的 Token URL（顺序与 login_urls 对应）
    let token_urls = [
        "https://ug-normal.trae.ai/cloudide/api/v3/common/GetUserToken",
        "https://ug-normal.us.trae.ai/cloudide/api/v3/common/GetUserToken",
        "https://ug-normal.jp.trae.ai/cloudide/api/v3/common/GetUserToken",
        "https://ug-normal.sg.trae.ai/cloudide/api/v3/common/GetUserToken",
    ];
    
    let mut token_result: Option<(GetUserTokenResponse, String)> = None;
    // successful_domain_idx 已经在前面定义并记录了成功登录的域名索引
    
    // 先尝试登录成功的域名
    let primary_token_url = token_urls[successful_domain_idx];
    println!("[login_with_email] 尝试主 Token API: {}", primary_token_url);
    
    let token_response = client
        .post(primary_token_url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::ORIGIN, "https://www.trae.ai")
        .header(header::REFERER, "https://www.trae.ai/")
        .header(header::CONTENT_TYPE, "application/json")
        .send()
        .await;

    match token_response {
        Ok(resp) => {
            let status = resp.status();
            println!("[login_with_email] 主 Token 响应状态: {}", status);
            if status.is_success() {
                match resp.json::<GetUserTokenResponse>().await {
                    Ok(data) => {
                        println!("[login_with_email] ✅ 主 Token 获取成功");
                        token_result = Some((data, primary_token_url.to_string()));
                    }
                    Err(e) => println!("[login_with_email] 主 Token 解析失败: {}", e),
                }
            }
        }
        Err(e) => println!("[login_with_email] 主 Token 请求失败: {}", e),
    }
    
    // 如果主域名失败，尝试其他域名
    if token_result.is_none() {
        for (idx, token_url) in token_urls.iter().enumerate() {
            if idx == successful_domain_idx {
                continue; // 跳过已经尝试过的主域名
            }
            
            println!("[login_with_email] 尝试备用 Token API: {}", token_url);
            
            let token_response = client
                .post(*token_url)
                .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                .header(header::ORIGIN, "https://www.trae.ai")
                .header(header::REFERER, "https://www.trae.ai/")
                .header(header::CONTENT_TYPE, "application/json")
                .send()
                .await;

            match token_response {
                Ok(resp) => {
                    let status = resp.status();
                    println!("[login_with_email] 备用 Token 响应状态: {}", status);
                    if status.is_success() {
                        match resp.json::<GetUserTokenResponse>().await {
                            Ok(data) => {
                                println!("[login_with_email] ✅ 备用 Token 获取成功");
                                token_result = Some((data, token_url.to_string()));
                                break;
                            }
                            Err(e) => println!("[login_with_email] 备用 Token 解析失败: {}", e),
                        }
                    }
                }
                Err(e) => println!("[login_with_email] 备用 Token 请求失败: {}", e),
            }
        }
    }

    let (token_data, successful_token_url) = match token_result {
        Some((data, url)) => (data, url),
        None => return Err(anyhow!("所有 Token API 都失败")),
    };

    let token_url_parsed = Url::parse(&successful_token_url)?;
    let mut cookies = cookie_jar
        .cookies(&token_url_parsed)
        .map(|v| v.to_str().unwrap_or_default().to_string())
        .unwrap_or_default();
    
    // 根据成功的 Token URL 设置正确的 store-idc
    if !cookies.is_empty() && !cookies.contains("store-idc=") && !cookies.contains("trae-target-idc=") {
        let idc = if successful_token_url.contains(".us.") {
            "useast5"
        } else if successful_token_url.contains(".jp.") {
            "apjpn1"
        } else if successful_token_url.contains(".sg.") {
            "alisg"
        } else {
            "alisg" // 默认新加坡
        };
        cookies = format!("{cookies}; store-idc={idc}");
        println!("[login_with_email] 设置 store-idc: {}", idc);
    }

    println!("[login_with_email] ✅ 登录成功，获取到 cookies (长度: {})", cookies.len());
    println!("[login_with_email] cookies 预览: {}", &cookies[..cookies.len().min(200)]);

    Ok(EmailLoginResult {
        token: token_data.result.token,
        user_id: token_data.result.user_id,
        tenant_id: token_data.result.tenant_id,
        cookies,
        expired_at: token_data.result.expired_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::{header, Client};
    use reqwest::cookie::Jar;
    use std::sync::Arc;

    fn encode_xor_hex(input: &str) -> String {
        input
            .as_bytes()
            .iter()
            .map(|b| format!("{:02x}", b ^ 0x05))
            .collect::<Vec<_>>()
            .join("")
    }

    #[tokio::test]
    async fn test_login_step_by_step() {
        let email = "qad77@exbts.com";
        let password = "$K9nA&@w#TXV";

        println!("========== 开始分步测试登录 ==========");
        println!("邮箱: {}", email);
        
        let cookie_jar = Arc::new(Jar::default());
        let client = Client::builder()
            .cookie_store(true)
            .cookie_provider(cookie_jar.clone())
            .build()
            .expect("创建客户端失败");

        // 步骤 1: 访问登录页面初始化
        println!("\n[步骤 1] 访问登录页面初始化...");
        let init_url = "https://www.trae.ai/login";
        let init_response = client
            .get(init_url)
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .send()
            .await;
        
        match init_response {
            Ok(resp) => println!("  初始化响应状态: {}", resp.status()),
            Err(e) => println!("  初始化失败: {}", e),
        }

        // 步骤 2: 发送登录请求
        println!("\n[步骤 2] 发送登录请求...");
        let login_url = "https://ug-normal.trae.ai/passport/web/email/login/";
        let login_params = [
            ("aid", "677332"),
            ("account_sdk_source", "web"),
            ("sdk_version", "2.1.10-tiktok"),
            ("language", "en"),
        ];

        let encoded_email = encode_xor_hex(email);
        let encoded_password = encode_xor_hex(password);
        
        println!("  原始邮箱: {}", email);
        println!("  编码后邮箱: {}", encoded_email);
        println!("  登录URL: {}", login_url);

        let login_body = [
            ("mix_mode", "1"),
            ("fixed_mix_mode", "1"),
            ("email", encoded_email.as_str()),
            ("password", encoded_password.as_str()),
        ];

        let login_response = client
            .post(login_url)
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header(header::ORIGIN, "https://www.trae.ai")
            .header(header::REFERER, "https://www.trae.ai/")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .query(&login_params)
            .form(&login_body)
            .send()
            .await;

        match login_response {
            Ok(resp) => {
                println!("  登录响应状态: {}", resp.status());
                let headers = resp.headers().clone();
                println!("  响应头:");
                for (key, value) in headers.iter() {
                    println!("    {}: {:?}", key, value);
                }
                
                match resp.text().await {
                    Ok(body) => {
                        println!("  响应体: {}", body);
                        
                        // 尝试解析 JSON
                        match serde_json::from_str::<serde_json::Value>(&body) {
                            Ok(json) => {
                                println!("  解析后的 JSON: {:#}", json);
                                
                                let error_code = json.get("error_code")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(-1);
                                println!("  错误码: {}", error_code);
                                
                                if let Some(data) = json.get("data") {
                                    println!("  data 字段: {:#}", data);
                                }
                            }
                            Err(e) => println!("  JSON 解析失败: {}", e),
                        }
                    }
                    Err(e) => println!("  读取响应体失败: {}", e),
                }
            }
            Err(e) => println!("  登录请求失败: {}", e),
        }

        println!("\n========== 测试完成 ==========");
    }

    #[tokio::test]
    async fn test_login_with_email() {
        let email = "qad77@exbts.com";
        let password = "$K9nA&@w#TXV";

        println!("开始测试完整登录流程: {}", email);
        
        match login_with_email(email, password).await {
            Ok(result) => {
                println!("✅ 登录成功!");
                println!("   User ID: {}", result.user_id);
                println!("   Tenant ID: {}", result.tenant_id);
                println!("   Token: {}...", &result.token[..50.min(result.token.len())]);
                println!("   Cookies 长度: {}", result.cookies.len());
                println!("   Expired At: {}", result.expired_at);
            }
            Err(e) => {
                println!("❌ 登录失败: {}", e);
                panic!("登录测试失败: {}", e);
            }
        }
    }

    /// 测试使用不同的 API 域名登录
    #[tokio::test]
    async fn test_login_with_us_domain() {
        let email = "qad77@exbts.com";
        let password = "$K9nA&@w#TXV";

        println!("========== 测试使用 us.trae.ai 域名登录 ==========");
        println!("邮箱: {}", email);
        
        let cookie_jar = Arc::new(Jar::default());
        let client = Client::builder()
            .cookie_store(true)
            .cookie_provider(cookie_jar.clone())
            .build()
            .expect("创建客户端失败");

        // 步骤 1: 访问登录页面初始化
        println!("\n[步骤 1] 访问登录页面初始化...");
        let init_url = "https://www.trae.ai/login";
        let _ = client
            .get(init_url)
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .send()
            .await;

        // 步骤 2: 使用 us.trae.ai 域名发送登录请求
        println!("\n[步骤 2] 使用 ug-normal.us.trae.ai 发送登录请求...");
        let login_url = "https://ug-normal.us.trae.ai/passport/web/email/login/";
        let login_params = [
            ("aid", "677332"),
            ("account_sdk_source", "web"),
            ("sdk_version", "2.1.10-tiktok"),
            ("language", "en"),
        ];

        let encoded_email = encode_xor_hex(email);
        let encoded_password = encode_xor_hex(password);
        
        println!("  登录URL: {}", login_url);

        let login_body = [
            ("mix_mode", "1"),
            ("fixed_mix_mode", "1"),
            ("email", encoded_email.as_str()),
            ("password", encoded_password.as_str()),
        ];

        let login_response = client
            .post(login_url)
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header(header::ORIGIN, "https://www.trae.ai")
            .header(header::REFERER, "https://www.trae.ai/")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .query(&login_params)
            .form(&login_body)
            .send()
            .await;

        match login_response {
            Ok(resp) => {
                println!("  登录响应状态: {}", resp.status());
                
                match resp.text().await {
                    Ok(body) => {
                        println!("  响应体: {}", body);
                        
                        match serde_json::from_str::<serde_json::Value>(&body) {
                            Ok(json) => {
                                println!("  解析后的 JSON: {:#}", json);
                                
                                if let Some(data) = json.get("data") {
                                    if let Some(error_code) = data.get("error_code").and_then(|v| v.as_i64()) {
                                        println!("  错误码: {}", error_code);
                                    }
                                    if let Some(desc) = data.get("description").and_then(|v| v.as_str()) {
                                        println!("  错误描述: {}", desc);
                                    }
                                }
                            }
                            Err(e) => println!("  JSON 解析失败: {}", e),
                        }
                    }
                    Err(e) => println!("  读取响应体失败: {}", e),
                }
            }
            Err(e) => println!("  登录请求失败: {}", e),
        }

        println!("\n========== 测试完成 ==========");
    }
}
