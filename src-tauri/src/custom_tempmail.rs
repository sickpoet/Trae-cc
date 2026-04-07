//! 可配置的临时邮箱客户端
//!
//! 支持用户自定义 Cloudflare Worker 地址和密钥
//! 通过 HTTP API 获取随机邮箱和验证码

use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::sleep;

/// 自定义临时邮箱配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTempMailConfig {
    /// Cloudflare Worker 地址，例如：https://your-worker.your-subdomain.workers.dev
    pub api_url: String,
    /// API 密钥
    pub secret_key: String,
    /// 邮箱域名
    pub email_domain: String,
}

impl Default for CustomTempMailConfig {
    fn default() -> Self {
        Self {
            api_url: String::new(),
            secret_key: String::new(),
            email_domain: String::new(),
        }
    }
}

impl CustomTempMailConfig {
    /// 检查配置是否有效
    pub fn is_valid(&self) -> bool {
        !self.api_url.is_empty() 
            && !self.secret_key.is_empty() 
            && !self.email_domain.is_empty()
    }
}

/// 自定义临时邮箱客户端
pub struct CustomTempMailClient {
    config: CustomTempMailConfig,
    http_client: Client,
    current_email: Option<String>,
}

/// 验证码查询响应
#[derive(Debug, Deserialize)]
struct CodeResponse {
    email: String,
    code: String,
    time: String,
}

/// 错误响应
#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: String,
}

impl CustomTempMailClient {
    /// 创建新的客户端
    pub fn new(config: CustomTempMailConfig) -> Self {
        let http_client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        
        Self {
            config,
            http_client,
            current_email: None,
        }
    }

    /// 生成随机邮箱地址
    pub fn generate_email(&mut self) -> String {
        let random_part: String = (0..8)
            .map(|_| rand::thread_rng().gen_range(b'a'..=b'z') as char)
            .collect();
        
        let email = format!("{}@{}", random_part, self.config.email_domain);
        self.current_email = Some(email.clone());
        
        println!("[CustomTempMail] 生成邮箱: {}", email);
        email
    }

    /// 获取当前邮箱
    pub fn get_email(&self) -> Option<&String> {
        self.current_email.as_ref()
    }

    /// 等待并获取验证码
    pub async fn wait_for_code(&self, timeout_secs: u64) -> anyhow::Result<String> {
        let email = self.current_email.as_ref()
            .ok_or_else(|| anyhow::anyhow!("未生成邮箱地址"))?;
        
        let start_time = std::time::Instant::now();
        let timeout_duration = Duration::from_secs(timeout_secs);
        
        println!("[CustomTempMail] 开始等待验证码，邮箱: {}，超时: {} 秒", email, timeout_secs);
        
        // 构建 API URL
        let api_url = format!(
            "{}/api/get-code?key={}&email={}",
            self.config.api_url.trim_end_matches('/'),
            urlencoding::encode(&self.config.secret_key),
            urlencoding::encode(email)
        );
        
        loop {
            // 检查是否超时
            if start_time.elapsed() > timeout_duration {
                return Err(anyhow::anyhow!("等待验证码超时"));
            }
            
            // 查询验证码
            match self.query_code(&api_url).await {
                Ok(code) => {
                    println!("[CustomTempMail] 成功获取验证码: {}", code);
                    return Ok(code);
                }
                Err(e) => {
                    // 如果是 404，说明还没收到邮件，继续等待
                    let error_msg = e.to_string();
                    if error_msg.contains("404") || error_msg.contains("没收到邮件") {
                        println!("[CustomTempMail] 尚未收到邮件，继续等待...");
                    } else {
                        println!("[CustomTempMail] 查询失败: {}", e);
                    }
                }
            }
            
            // 等待 3 秒后重试
            sleep(Duration::from_secs(3)).await;
        }
    }

    /// 查询验证码
    async fn query_code(&self, api_url: &str) -> anyhow::Result<String> {
        let response = self.http_client
            .get(api_url)
            .send()
            .await?;
        
        let status = response.status();
        let text = response.text().await?;
        
        if status.is_success() {
            // 解析成功响应
            let code_response: CodeResponse = serde_json::from_str(&text)
                .map_err(|e| anyhow::anyhow!("解析响应失败: {}", e))?;
            
            if code_response.code == "未找到验证码" {
                return Err(anyhow::anyhow!("邮件中未找到6位验证码"));
            }
            
            Ok(code_response.code)
        } else if status.as_u16() == 404 {
            // 邮箱没有收到邮件
            let error: ErrorResponse = serde_json::from_str(&text)
                .unwrap_or(ErrorResponse { error: "未收到邮件".to_string() });
            Err(anyhow::anyhow!("404: {}", error.error))
        } else {
            // 其他错误
            let error: ErrorResponse = serde_json::from_str(&text)
                .unwrap_or(ErrorResponse { error: format!("HTTP {}", status) });
            Err(anyhow::anyhow!("{}", error.error))
        }
    }
}

/// 生成随机密码
pub fn generate_password() -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let mut rng = rand::thread_rng();
    
    let password: String = (0..12)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect();
    
    password
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_password() {
        let pwd = generate_password();
        assert_eq!(pwd.len(), 12);
    }

    #[test]
    fn test_generate_email() {
        let config = CustomTempMailConfig {
            api_url: "https://test.workers.dev".to_string(),
            secret_key: "test_key".to_string(),
            email_domain: "test.com".to_string(),
        };
        
        let mut client = CustomTempMailClient::new(config);
        let email = client.generate_email();
        
        assert!(email.ends_with("@test.com"));
        assert_eq!(email.len(), 8 + 1 + 9); // 8位随机 + @ + 域名
    }
}
