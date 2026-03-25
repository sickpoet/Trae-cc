//! TempMail.cn 客户端模块
//!
//! 使用嵌入式 Python 可执行文件连接 tempmail.cn 获取临时邮箱和接收验证码
//! Python 可执行文件在编译时嵌入到二进制中，运行时解压到临时目录执行

use std::time::Duration;
use tokio::time::timeout;
use std::path::PathBuf;
use std::fs;
use std::env;

/// 嵌入的 Python 可执行文件（编译时包含）
const PYTHON_EXE_BYTES: &[u8] = include_bytes!("../bin/tempmail_socketio_client.exe");

/// TempMail 客户端
pub struct TempMailClient {
    email: Option<String>,
    shortid: Option<String>,
    temp_exe_path: Option<PathBuf>,
}

impl TempMailClient {
    /// 创建新的 TempMail 客户端
    pub fn new() -> Self {
        Self {
            email: None,
            shortid: None,
            temp_exe_path: None,
        }
    }

    /// 初始化并解压嵌入式可执行文件
    pub async fn init(&mut self) -> anyhow::Result<()> {
        let temp_path = extract_embedded_exe().await?;
        self.temp_exe_path = Some(temp_path);
        Ok(())
    }

    /// 生成随机邮箱地址
    pub async fn generate_email(&mut self) -> String {
        // 确保已初始化
        if self.temp_exe_path.is_none() {
            if let Err(e) = self.init().await {
                println!("[TempMailClient] 初始化失败: {}", e);
                return "error@tempmail.cn".to_string();
            }
        }

        match self.create_email().await {
            Ok(email) => {
                self.email = Some(email.clone());
                email
            }
            Err(e) => {
                println!("[TempMailClient] 创建邮箱失败: {}", e);
                "error@tempmail.cn".to_string()
            }
        }
    }

    /// 创建临时邮箱
    async fn create_email(&mut self) -> anyhow::Result<String> {
        println!("[TempMailClient] 正在创建临时邮箱...");

        // 生成随机 shortid (8位随机字符串)
        let shortid = generate_random_shortid();
        
        self.shortid = Some(shortid.clone());
        let email = format!("{}@tempmail.cn", shortid);

        println!("[TempMailClient] 邮箱创建成功: {}", email);
        Ok(email)
    }

    /// 等待并获取验证码
    pub async fn wait_for_code(&self, timeout_duration: Duration) -> anyhow::Result<String> {
        let shortid = self.shortid.as_ref()
            .ok_or_else(|| anyhow::anyhow!("邮箱未初始化"))?;

        let exe_path = self.temp_exe_path.as_ref()
            .ok_or_else(|| anyhow::anyhow!("未初始化，请先调用 init()"))?;

        println!("[TempMailClient] 开始等待验证码，超时: {} 秒", timeout_duration.as_secs());
        println!("[TempMailClient] 邮箱: {}@tempmail.cn", shortid);

        // 使用解压后的可执行文件来获取验证码
        let code = run_socketio_client(exe_path, shortid, timeout_duration).await?;
        
        println!("[TempMailClient] 成功获取验证码: {}", code);
        Ok(code)
    }

    /// 获取当前邮箱地址
    pub fn get_email(&self) -> Option<&String> {
        self.email.as_ref()
    }

    /// 获取 shortid
    pub fn get_shortid(&self) -> Option<&String> {
        self.shortid.as_ref()
    }

    /// 清理临时文件
    pub fn cleanup(&self) {
        if let Some(ref path) = self.temp_exe_path {
            if path.exists() {
                let _ = fs::remove_file(path);
                println!("[TempMailClient] 已清理临时文件: {:?}", path);
            }
        }
    }
}

impl Drop for TempMailClient {
    fn drop(&mut self) {
        self.cleanup();
    }
}

/// 解压嵌入式可执行文件到临时目录
async fn extract_embedded_exe() -> anyhow::Result<PathBuf> {
    // 获取临时目录
    let temp_dir = env::temp_dir();
    let exe_path = temp_dir.join("tempmail_socketio_client.exe");

    // 如果文件已存在，先删除
    if exe_path.exists() {
        let _ = fs::remove_file(&exe_path);
    }

    // 写入嵌入式字节到临时文件
    fs::write(&exe_path, PYTHON_EXE_BYTES)
        .map_err(|e| anyhow::anyhow!("无法写入临时文件: {}", e))?;

    println!("[TempMailClient] 已解压嵌入式可执行文件到: {:?}", exe_path);
    
    Ok(exe_path)
}

/// 生成随机 shortid (8位小写字母和数字)
fn generate_random_shortid() -> String {
    use rand::Rng;
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();

    (0..8)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// 运行 Socket.io 客户端可执行文件来获取验证码
async fn run_socketio_client(
    exe_path: &PathBuf, 
    shortid: &str, 
    timeout_duration: Duration
) -> anyhow::Result<String> {
    use std::process::Stdio;
    use tokio::process::Command;

    println!("[TempMailClient] 启动 Socket.io 客户端...");
    println!("[TempMailClient] 可执行文件: {:?}", exe_path);

    let child = Command::new(exe_path)
        .arg(shortid)
        .arg(timeout_duration.as_secs().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow::anyhow!(
            "无法启动可执行文件: {}\n\
            请确保 {:?} 存在且有执行权限。", e, exe_path
        ))?;

    let result = timeout(timeout_duration + Duration::from_secs(5), async {
        let output = child.wait_with_output().await
            .map_err(|e| anyhow::anyhow!("进程错误: {}", e))?;
        
        if output.status.success() {
            let code = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()) {
                Ok(code)
            } else {
                Err(anyhow::anyhow!("无效的验证码格式: {}", code))
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(anyhow::anyhow!("客户端失败: {}", stderr))
        }
    }).await;

    match result {
        Ok(Ok(code)) => Ok(code),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow::anyhow!("获取验证码超时")),
    }
}

/// 生成随机密码
pub fn generate_password() -> String {
    use rand::Rng;
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let mut rng = rand::thread_rng();

    let password: String = (0..12)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect();

    password
}
