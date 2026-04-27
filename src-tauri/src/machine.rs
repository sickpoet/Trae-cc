use anyhow::{anyhow, Result};
use uuid::Uuid;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

#[cfg(target_os = "windows")]
fn command_no_window(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Windows 注册表中 MachineGuid 的路径
#[cfg(target_os = "windows")]
const MACHINE_GUID_PATH: &str = r"SOFTWARE\Microsoft\Cryptography";
#[cfg(target_os = "windows")]
const MACHINE_GUID_KEY: &str = "MachineGuid";

/// 读取当前系统的 MachineGuid
#[cfg(target_os = "windows")]
pub fn get_machine_guid() -> Result<String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey(MACHINE_GUID_PATH)
        .map_err(|e| anyhow!("无法打开注册表: {}", e))?;

    let guid: String = key.get_value(MACHINE_GUID_KEY)
        .map_err(|e| anyhow!("无法读取 MachineGuid: {}", e))?;

    Ok(guid)
}

/// 设置系统的 MachineGuid（需要管理员权限）
#[cfg(target_os = "windows")]
pub fn set_machine_guid(new_guid: &str) -> Result<()> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey_with_flags(MACHINE_GUID_PATH, KEY_SET_VALUE)
        .map_err(|e| anyhow!("无法打开注册表（需要管理员权限）: {}", e))?;

    key.set_value(MACHINE_GUID_KEY, &new_guid)
        .map_err(|e| anyhow!("无法设置 MachineGuid: {}", e))?;

    Ok(())
}

/// 生成新的 MachineGuid
pub fn generate_machine_guid() -> String {
    Uuid::new_v4().to_string()
}

/// 重置 MachineGuid 为新的随机值
#[cfg(target_os = "windows")]
pub fn reset_machine_guid() -> Result<String> {
    let new_guid = generate_machine_guid();
    set_machine_guid(&new_guid)?;
    Ok(new_guid)
}

/// 获取 Trae IDE 数据目录路径
#[cfg(target_os = "windows")]
fn get_trae_data_path() -> Result<PathBuf> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| anyhow!("无法获取 APPDATA 环境变量"))?;
    Ok(PathBuf::from(appdata).join("Trae"))
}

#[cfg(target_os = "macos")]
fn get_trae_data_path() -> Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| anyhow!("无法获取 HOME 环境变量"))?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Trae"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn get_trae_data_path() -> Result<PathBuf> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

/// 获取 Trae IDE 的 state.vscdb 路径
pub fn get_trae_state_db_path() -> Result<PathBuf> {
    let trae_path = get_trae_data_path()?;
    Ok(trae_path.join("User").join("globalStorage").join("state.vscdb"))
}

/// 读取 Trae IDE 的机器码
pub fn get_trae_machine_id() -> Result<String> {
    let trae_path = get_trae_data_path()?;
    let machine_id_path = trae_path.join("machineid");

    if !machine_id_path.exists() {
        return Err(anyhow!("Trae IDE 机器码文件不存在"));
    }

    let content = fs::read_to_string(&machine_id_path)
        .map_err(|e| anyhow!("读取 Trae 机器码失败: {}", e))?;

    Ok(content.trim().to_string())
}

/// 设置 Trae IDE 的机器码
pub fn set_trae_machine_id(new_id: &str) -> Result<()> {
    let trae_path = get_trae_data_path()?;
    let machine_id_path = trae_path.join("machineid");

    fs::write(&machine_id_path, new_id)
        .map_err(|e| anyhow!("写入 Trae 机器码失败: {}", e))?;

    Ok(())
}

/// 检查 Trae IDE 是否正在运行
#[cfg(target_os = "windows")]
pub fn is_trae_running() -> bool {
    let output = command_no_window("tasklist")
        .args(["/FI", "IMAGENAME eq Trae.exe", "/NH"])
        .output();

    match output {
        Ok(out) => {
            let result = String::from_utf8_lossy(&out.stdout);
            result.contains("Trae.exe")
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
pub fn is_trae_running() -> bool {
    // 使用 pgrep -f 匹配进程路径中包含 "Trae.app" 的进程
    Command::new("pgrep")
        .args(["-f", "Trae.app/Contents/MacOS"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// 关闭 Trae IDE 进程
#[cfg(target_os = "windows")]
pub fn kill_trae() -> Result<()> {
    if !is_trae_running() {
        println!("[INFO] Trae IDE 未运行");
        return Ok(());
    }

    println!("[INFO] 正在关闭 Trae IDE...");

    // 先尝试优雅关闭
    let _ = command_no_window("taskkill")
        .args(["/IM", "Trae.exe"])
        .output();

    // 等待一小段时间
    std::thread::sleep(std::time::Duration::from_millis(1000));

    // 如果还在运行，强制关闭
    if is_trae_running() {
        println!("[INFO] 优雅关闭失败，正在强制关闭...");
        let output = command_no_window("taskkill")
            .args(["/F", "/IM", "Trae.exe"])
            .output()
            .map_err(|e| anyhow!("关闭 Trae IDE 失败: {}", e))?;

        if !output.status.success() {
            if !is_trae_running() {
                println!("[INFO] Trae IDE 已关闭");
                return Ok(());
            }
            let err = String::from_utf8_lossy(&output.stderr);
            let err_lower = err.to_lowercase();
            if err_lower.contains("not found")
                || err_lower.contains("cannot find")
                || err_lower.contains("没有找到")
            {
                println!("[WARN] Trae IDE 进程不存在");
                return Ok(());
            }
            if !err.is_empty() {
                return Err(anyhow!("关闭 Trae IDE 失败: {}", err));
            }
        }
    }

    // 等待进程完全退出（轮询检查，最多等待5秒）
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(5);
    
    while is_trae_running() && start.elapsed() < timeout {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    if is_trae_running() {
        return Err(anyhow!("无法完全关闭 Trae IDE，请手动关闭后重试"));
    }

    // 额外等待一段时间确保资源释放
    std::thread::sleep(std::time::Duration::from_millis(1500));

    println!("[INFO] Trae IDE 已完全关闭");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn kill_trae() -> Result<()> {
    if !is_trae_running() {
        println!("[INFO] Trae IDE 未运行");
        return Ok(());
    }

    println!("[INFO] 正在关闭 Trae IDE...");

    // 使用 osascript 优雅关闭 Trae 应用
    let _ = Command::new("osascript")
        .args(["-e", "tell application \"Trae\" to quit"])
        .output();

    // 等待一小段时间
    std::thread::sleep(std::time::Duration::from_millis(1500));

    // 如果还在运行，使用 pkill 强制关闭
    if is_trae_running() {
        println!("[INFO] 优雅关闭失败，正在强制关闭...");
        let _ = Command::new("pkill")
            .args(["-9", "-f", "Trae.app/Contents/MacOS"])
            .output();
        
        // 再等待一下
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }

    if is_trae_running() {
        return Err(anyhow!("无法关闭 Trae IDE，请手动关闭后重试"));
    }

    println!("[INFO] Trae IDE 已关闭");
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn is_trae_running() -> bool {
    false
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn kill_trae() -> Result<()> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

/// 获取 Trae IDE 配置文件路径
fn get_trae_config_path() -> Result<PathBuf> {
    let proj_dirs = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow!("无法获取应用数据目录"))?;
    let config_dir = proj_dirs.config_dir();
    fs::create_dir_all(config_dir)?;
    Ok(config_dir.join("trae_path.txt"))
}

/// 获取保存的 Trae IDE 路径
pub fn get_saved_trae_path() -> Result<String> {
    let config_path = get_trae_config_path()?;
    if config_path.exists() {
        let path = fs::read_to_string(&config_path)?;
        let path = path.trim().to_string();
        if !path.is_empty() && PathBuf::from(&path).exists() {
            return Ok(path);
        }
    }
    Err(anyhow!("未设置 Trae IDE 路径"))
}

/// 保存 Trae IDE 路径
#[cfg(target_os = "windows")]
pub fn save_trae_path(path: &str) -> Result<()> {
    let exe_path = PathBuf::from(path);
    if !exe_path.exists() {
        return Err(anyhow!("指定的路径不存在"));
    }
    if !path.to_lowercase().ends_with(".exe") {
        return Err(anyhow!("请选择 Trae.exe 文件"));
    }
    let config_path = get_trae_config_path()?;
    fs::write(&config_path, path)?;
    println!("[INFO] 已保存 Trae IDE 路径: {}", path);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn save_trae_path(path: &str) -> Result<()> {
    let app_path = PathBuf::from(path);
    if !app_path.exists() {
        return Err(anyhow!("指定的路径不存在"));
    }
    // macOS 应用是 .app bundle 目录
    if !path.to_lowercase().ends_with(".app") {
        return Err(anyhow!("请选择 Trae.app 应用程序"));
    }
    let config_path = get_trae_config_path()?;
    fs::write(&config_path, path)?;
    println!("[INFO] 已保存 Trae IDE 路径: {}", path);
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn save_trae_path(_path: &str) -> Result<()> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

/// 自动扫描 Trae IDE 安装路径
#[cfg(target_os = "windows")]
pub fn scan_trae_path() -> Result<String> {
    use std::path::Path;
    
    // 常见的 Windows 安装路径
    let possible_paths = [
        // 用户安装路径
        &format!("{}\\AppData\\Local\\Programs\\Trae\\Trae.exe", std::env::var("LOCALAPPDATA").unwrap_or_default()),
        &format!("{}\\AppData\\Local\\Trae\\Trae.exe", std::env::var("LOCALAPPDATA").unwrap_or_default()),
        // 系统安装路径
        r"C:\Program Files\Trae\Trae.exe",
        r"C:\Program Files (x86)\Trae\Trae.exe",
        // 通过环境变量查找
        &format!("{}\\Trae\\Trae.exe", std::env::var("ProgramFiles").unwrap_or_default()),
        &format!("{}\\Trae\\Trae.exe", std::env::var("ProgramFiles(x86)").unwrap_or_default()),
    ];
    
    for path in possible_paths {
        if Path::new(path).exists() {
            println!("[INFO] 找到 Trae IDE: {}", path);
            return Ok(path.to_string());
        }
    }
    
    // 尝试从注册表查找
    if let Ok(path) = scan_trae_from_registry() {
        return Ok(path);
    }
    
    Err(anyhow!("未找到 Trae IDE，请手动设置路径"))
}

/// 从 Windows 注册表查找 Trae 安装路径
#[cfg(target_os = "windows")]
fn scan_trae_from_registry() -> Result<String> {
    use std::process::Command;
    
    // 尝试从注册表读取
    let reg_paths = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    
    for reg_path in &reg_paths {
        let output = Command::new("reg")
            .args(&["query", reg_path, "/s", "/f", "Trae", "/k"])
            .output();
        
        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // 查找包含 InstallLocation 的行
            for line in stdout.lines() {
                if line.contains("InstallLocation") {
                    let parts: Vec<&str> = line.splitn(3, "    ").collect();
                    if parts.len() >= 3 {
                        let install_path = parts[2].trim();
                        let exe_path = format!("{}\\Trae.exe", install_path);
                        if Path::new(&exe_path).exists() {
                            return Ok(exe_path);
                        }
                    }
                }
            }
        }
    }
    
    Err(anyhow!("注册表中未找到 Trae"))
}

#[cfg(target_os = "macos")]
pub fn scan_trae_path() -> Result<String> {
    // 常见的 macOS 应用安装位置
    let possible_paths = [
        "/Applications/Trae.app",
        &format!("{}/Applications/Trae.app", std::env::var("HOME").unwrap_or_default()),
    ];
    
    for path in possible_paths {
        if PathBuf::from(path).exists() {
            return Ok(path.to_string());
        }
    }
    
    Err(anyhow!("未找到 Trae IDE，请手动设置路径"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn scan_trae_path() -> Result<String> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

/// 打开 Trae IDE
#[cfg(target_os = "windows")]
pub fn open_trae() -> Result<()> {
    let trae_exe = match get_saved_trae_path() {
        Ok(path) => PathBuf::from(path),
        Err(_) => return Err(anyhow!("未设置 Trae IDE 路径，请在设置中配置")),
    };

    if !trae_exe.exists() {
        return Err(anyhow!("Trae IDE 路径无效，请在设置中重新配置"));
    }

    println!("[INFO] 正在启动 Trae IDE: {}", trae_exe.display());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        
        Command::new(&trae_exe)
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map_err(|e| anyhow!("启动 Trae IDE 失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(&trae_exe)
            .spawn()
            .map_err(|e| anyhow!("启动 Trae IDE 失败: {}", e))?;
    }

    println!("[INFO] Trae IDE 已启动");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn open_trae() -> Result<()> {
    let trae_app = match get_saved_trae_path() {
        Ok(path) => PathBuf::from(path),
        Err(_) => {
            // 尝试自动扫描
            match scan_trae_path() {
                Ok(path) => PathBuf::from(path),
                Err(_) => return Err(anyhow!("未设置 Trae IDE 路径，请在设置中配置")),
            }
        }
    };

    if !trae_app.exists() {
        return Err(anyhow!("Trae IDE 路径无效，请在设置中重新配置"));
    }

    println!("[INFO] 正在启动 Trae IDE: {}", trae_app.display());

    Command::new("open")
        .arg("-a")
        .arg(&trae_app)
        .spawn()
        .map_err(|e| anyhow!("启动 Trae IDE 失败: {}", e))?;

    println!("[INFO] Trae IDE 已启动");
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn open_trae() -> Result<()> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

/// 账号登录信息结构（用于写入 Trae IDE）
#[derive(Debug, Clone)]
pub struct TraeLoginInfo {
    pub token: String,
    pub refresh_token: Option<String>,
    pub user_id: String,
    pub email: String,
    pub username: String,
    pub avatar_url: String,
    pub host: String,
    pub region: String,
}

/// 将账号登录信息写入 Trae IDE
pub fn write_trae_login_info(info: &TraeLoginInfo) -> Result<()> {
    let trae_path = get_trae_data_path()?;

    // 确保目录存在
    let storage_dir = trae_path.join("User").join("globalStorage");
    fs::create_dir_all(&storage_dir)
        .map_err(|e| anyhow!("创建目录失败: {}", e))?;

    let storage_path = storage_dir.join("storage.json");

    // 读取现有配置或创建新的
    let mut json: serde_json::Value = if storage_path.exists() {
        let content = fs::read_to_string(&storage_path)
            .map_err(|e| anyhow!("读取 storage.json 失败: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let obj = json.as_object_mut()
        .ok_or_else(|| anyhow!("storage.json 格式错误"))?;

    // 计算过期时间（14天后）
    let now = chrono::Utc::now();
    let expired_at = now + chrono::Duration::days(14);
    let refresh_expired_at = now + chrono::Duration::days(180);

    // 构建 host URL
    let host = if info.host.is_empty() {
        match info.region.to_uppercase().as_str() {
            "SG" => "https://api-sg-central.trae.ai",
            "CN" => "https://api.trae.com.cn",
            _ => "https://api-sg-central.trae.ai",
        }
    } else {
        &info.host
    };

    // 构建 iCubeAuthInfo
    let auth_info = serde_json::json!({
        "token": info.token,
        "refreshToken": info.refresh_token.clone().unwrap_or_default(),
        "expiredAt": expired_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "refreshExpiredAt": refresh_expired_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "tokenReleaseAt": now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "userId": info.user_id,
        "host": host,
        "userRegion": {
            "region": info.region.to_uppercase(),
            "_aiRegion": info.region.to_uppercase()
        },
        "account": {
            "username": info.username,
            "iss": "",
            "iat": 0,
            "organization": "",
            "work_country": "",
            "email": info.email,
            "avatar_url": info.avatar_url,
            "description": "",
            "scope": "marscode",
            "loginScope": "trae",
            "storeCountryCode": "cn",
            "storeCountrySrc": "uid",
            "storeRegion": info.region.to_uppercase(),
            "userTag": "row"
        }
    });

    // 构建 iCubeEntitlementInfo
    let entitlement_info = serde_json::json!({
        "identityStr": "Free",
        "identity": 0,
        "isPayFreshman": false,
        "isSupportCommercialization": true,
        "hasPackage": false,
        "enableEntitlement": true,
        "detail": {
            "can_gen_solo_code": false,
            "fast_request_per": 1,
            "in_wait": false,
            "permission": 1,
            "toast_read": false,
            "toastRead": false,
            "canGenSoloCode": false,
            "fastRequestPer": 1,
            "inWaitlist": false
        }
    });

    // 写入登录信息
    obj.insert(
        "iCubeAuthInfo://icube.cloudide".to_string(),
        serde_json::Value::String(serde_json::to_string(&auth_info).unwrap())
    );
    obj.insert(
        "iCubeEntitlementInfo://icube.cloudide".to_string(),
        serde_json::Value::String(serde_json::to_string(&entitlement_info).unwrap())
    );

    // 写回文件
    let new_content = serde_json::to_string_pretty(&json)
        .map_err(|e| anyhow!("序列化 JSON 失败: {}", e))?;
    fs::write(&storage_path, new_content)
        .map_err(|e| anyhow!("写入 storage.json 失败: {}", e))?;

    println!("[INFO] 已写入 Trae IDE 登录信息: {}", info.email);
    Ok(())
}

/// 切换 Trae IDE 到指定账号（精确替换认证数据，不删除会话状态）
pub fn switch_trae_account(info: &TraeLoginInfo, machine_id: Option<&str>, auto_start: bool) -> Result<()> {
    // 0. 先关闭 Trae IDE
    kill_trae()?;

    let trae_path = get_trae_data_path()?;

    // 1. 设置机器码（如果提供则使用，否则生成新的）
    let new_machine_id = match machine_id {
        Some(mid) => mid.to_string(),
        None => generate_machine_guid(),
    };
    let machine_id_path = trae_path.join("machineid");
    fs::write(&machine_id_path, &new_machine_id)
        .map_err(|e| anyhow!("写入 Trae 机器码失败: {}", e))?;
    println!("[INFO] 已设置 Trae 机器码: {}", new_machine_id);

    // 2. 更新 storage.json：替换认证信息和 telemetry ID，不动其他数据
    let storage_dir = trae_path.join("User").join("globalStorage");
    fs::create_dir_all(&storage_dir)
        .map_err(|e| anyhow!("创建目录失败: {}", e))?;
    let storage_path = storage_dir.join("storage.json");

    // 生成新的 telemetry ID
    let new_dev_device_id = Uuid::new_v4().to_string();
    let new_sqm_id = format!("{{{}}}", Uuid::new_v4().to_string().to_uppercase());
    let new_telemetry_machine_id = generate_telemetry_machine_id(&new_machine_id);

    // 读取现有配置或创建新的
    let mut json: serde_json::Value = if storage_path.exists() {
        let content = fs::read_to_string(&storage_path)
            .map_err(|e| anyhow!("读取 storage.json 失败: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let obj = json.as_object_mut()
        .ok_or_else(|| anyhow!("storage.json 格式错误"))?;

    // 移除旧的登录信息
    obj.remove("iCubeAuthInfo://icube.cloudide");
    obj.remove("iCubeEntitlementInfo://icube.cloudide");
    obj.remove("iCubeServerData://icube.cloudide");
    obj.remove("iCubeAuthInfo://usertag");

    // 更新 telemetry ID
    obj.insert("telemetry.devDeviceId".to_string(), serde_json::json!(new_dev_device_id));
    obj.insert("telemetry.machineId".to_string(), serde_json::json!(new_telemetry_machine_id));
    obj.insert("telemetry.sqmId".to_string(), serde_json::json!(new_sqm_id));

    // 写回文件
    let new_content = serde_json::to_string_pretty(&json)
        .map_err(|e| anyhow!("序列化 JSON 失败: {}", e))?;
    fs::write(&storage_path, new_content)
        .map_err(|e| anyhow!("写入 storage.json 失败: {}", e))?;

    // 3. 写入新的登录信息（追加 iCubeAuthInfo 和 iCubeEntitlementInfo）
    write_trae_login_info(info)?;

    // 4. 清理 state.vscdb 中的旧认证缓存（精确删除，不删整个数据库）
    let state_db_path = trae_path.join("User").join("globalStorage").join("state.vscdb");
    if state_db_path.exists() {
        let _ = cleanup_auth_from_vscdb(&state_db_path);
    }

    println!("[INFO] 已切换 Trae IDE 到账号: {}", info.email);

    // 5. 自动打开 Trae IDE（仅在需要时）
    if auto_start {
        if let Err(e) = open_trae() {
            println!("[WARN] 自动打开 Trae IDE 失败: {}", e);
        }
    }

    Ok(())
}

/// 从 state.vscdb 中精确清理旧的认证相关缓存键，保留其他所有数据
fn cleanup_auth_from_vscdb(db_path: &PathBuf) -> Result<()> {
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| anyhow!("无法打开 state.vscdb: {}", e))?;

    // 只删除认证相关的历史缓存键，Trae IDE 会从 storage.json 重新读取
    let auth_keys = [
        "icube.auth.token",
        "icube.auth.refreshToken",
        "icube.auth.expiredAt",
        "icube.auth.userId",
        "icube.auth.host",
        "icube.auth.region",
        "icube.server.data",
    ];

    let mut deleted = 0;
    for key in &auth_keys {
        match conn.execute("DELETE FROM ItemTable WHERE key = ?1", [key]) {
            Ok(n) => deleted += n,
            Err(_) => {},
        }
    }

    if deleted > 0 {
        println!("[INFO] 已从 state.vscdb 清理 {} 条旧认证缓存", deleted);
    }

    Ok(())
}

/// 清除 Trae IDE 的登录状态（让 IDE 变成全新安装状态）
pub fn clear_trae_login_state() -> Result<()> {
    let trae_path = get_trae_data_path()?;

    // 1. 生成新的机器码
    let new_machine_id = generate_machine_guid();
    let machine_id_path = trae_path.join("machineid");
    fs::write(&machine_id_path, &new_machine_id)
        .map_err(|e| anyhow!("重置 Trae 机器码失败: {}", e))?;
    println!("[INFO] 已重置 Trae 机器码: {}", new_machine_id);

    // 2. 生成新的 telemetry ID
    let new_dev_device_id = Uuid::new_v4().to_string();
    let new_sqm_id = format!("{{{}}}", Uuid::new_v4().to_string().to_uppercase());
    // machineId 是 machineid 文件的哈希（64位十六进制字符串）
    let new_telemetry_machine_id = generate_telemetry_machine_id(&new_machine_id);

    // 3. 更新 storage.json 中的登录信息和 telemetry ID
    let storage_path = trae_path.join("User").join("globalStorage").join("storage.json");
    if storage_path.exists() {
        let content = fs::read_to_string(&storage_path)
            .map_err(|e| anyhow!("读取 storage.json 失败: {}", e))?;

        // 解析 JSON 并移除登录相关字段
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = json.as_object_mut() {
                // 移除登录相关字段
                obj.remove("iCubeAuthInfo://icube.cloudide");
                obj.remove("iCubeEntitlementInfo://icube.cloudide");
                obj.remove("iCubeServerData://icube.cloudide");
                obj.remove("iCubeAuthInfo://usertag");

                // 更新 telemetry ID
                obj.insert("telemetry.devDeviceId".to_string(), serde_json::json!(new_dev_device_id));
                obj.insert("telemetry.machineId".to_string(), serde_json::json!(new_telemetry_machine_id));
                obj.insert("telemetry.sqmId".to_string(), serde_json::json!(new_sqm_id));

                // 写回文件
                let new_content = serde_json::to_string_pretty(&json)
                    .map_err(|e| anyhow!("序列化 JSON 失败: {}", e))?;
                fs::write(&storage_path, new_content)
                    .map_err(|e| anyhow!("写入 storage.json 失败: {}", e))?;
                println!("[INFO] 已清除 storage.json 中的登录信息并更新 telemetry ID");
            }
        }
    }

    // 4. 删除 state.vscdb 数据库（包含更多登录状态）
    let state_db_path = trae_path.join("User").join("globalStorage").join("state.vscdb");
    if state_db_path.exists() {
        fs::remove_file(&state_db_path)
            .map_err(|e| anyhow!("删除 state.vscdb 失败: {}", e))?;
        println!("[INFO] 已删除 state.vscdb");
    }

    // 5. 删除 state.vscdb.backup
    let state_db_backup_path = trae_path.join("User").join("globalStorage").join("state.vscdb.backup");
    if state_db_backup_path.exists() {
        let _ = fs::remove_file(&state_db_backup_path);
        println!("[INFO] 已删除 state.vscdb.backup");
    }

    // 6. 清除 Local State 中的加密密钥
    let local_state_path = trae_path.join("Local State");
    if local_state_path.exists() {
        let _ = fs::remove_file(&local_state_path);
        println!("[INFO] 已删除 Local State");
    }

    // 7. 清除 IndexedDB 中的登录相关数据（保留浏览记录）
    let indexed_db_path = trae_path.join("IndexedDB");
    if indexed_db_path.exists() {
        // 只删除包含登录相关数据的 IndexedDB，保留其他数据
        let login_related_patterns = ["auth", "login", "token", "session", "credential"];
        if let Ok(entries) = fs::read_dir(&indexed_db_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                if login_related_patterns.iter().any(|p| name.contains(p)) {
                    let _ = fs::remove_dir_all(&path);
                    println!("[INFO] 已清除登录相关的 IndexedDB: {}", name);
                }
            }
        }
    }

    // 8. 清除 Local Storage 中的登录相关数据（保留浏览记录和上下文）
    let local_storage_path = trae_path.join("Local Storage");
    if local_storage_path.exists() {
        // 只删除包含登录相关键值的 Local Storage 文件
        let login_keys = ["auth", "login", "token", "session", "credential", "trae"];
        if let Ok(entries) = fs::read_dir(&local_storage_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext == "localstorage" {
                        // 读取文件内容，检查是否包含登录相关键值
                        if let Ok(content) = fs::read_to_string(&path) {
                            let content_lower = content.to_lowercase();
                            if login_keys.iter().any(|k| content_lower.contains(k)) {
                                let _ = fs::remove_file(&path);
                                println!("[INFO] 已清除登录相关的 Local Storage");
                            }
                        }
                    }
                }
            }
        }
    }

    // 9. 保留 Session Storage（包含浏览记录和上下文）
    // Session Storage 通常只包含当前会话数据，不删除

    // 10. 清除登录相关的 Cookies（保留其他 Cookies）
    let cookies_path = trae_path.join("Network").join("Cookies");
    if cookies_path.exists() {
        // SQLite 数据库，需要特殊处理
        // 暂时保留 Cookies，因为删除会影响所有网站登录状态
        println!("[INFO] 保留 Cookies（避免影响所有网站登录状态）");
    }

    Ok(())
}

/// 生成 telemetry.machineId（64位十六进制字符串）
fn generate_telemetry_machine_id(machine_id: &str) -> String {
    use sha2::{Sha256, Digest};

    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    let result = hasher.finalize();

    // 将前32字节转换为64位十六进制字符串
    hex::encode(&result[..32])
}

// macOS 平台实现
#[cfg(target_os = "macos")]
pub fn get_machine_guid() -> Result<String> {
    // 使用 ioreg 命令读取 IOPlatformUUID
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| anyhow!("执行 ioreg 失败: {}", e))?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    
    // 解析 IOPlatformUUID
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            // 格式: "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            if let Some(uuid) = line.split('"').nth(3) {
                return Ok(uuid.to_string());
            }
        }
    }
    
    Err(anyhow!("无法获取 IOPlatformUUID"))
}

#[cfg(target_os = "macos")]
pub fn set_machine_guid(_new_guid: &str) -> Result<()> {
    // macOS 无法修改系统 UUID
    Err(anyhow!("macOS 不支持修改系统机器码"))
}

#[cfg(target_os = "macos")]
pub fn reset_machine_guid() -> Result<String> {
    // macOS 无法重置系统 UUID
    Err(anyhow!("macOS 不支持重置系统机器码"))
}

// 非 Windows/macOS 平台的占位实现
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn get_machine_guid() -> Result<String> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn set_machine_guid(_new_guid: &str) -> Result<()> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn reset_machine_guid() -> Result<String> {
    Err(anyhow!("此功能仅支持 Windows 和 macOS 系统"))
}

/// 获取 Trae workspaceStorage 路径（聊天记录和上下文存储位置）
pub fn get_trae_workspace_storage_path() -> Result<PathBuf> {
    let trae_path = get_trae_data_path()?;
    Ok(trae_path.join("User").join("workspaceStorage"))
}

/// 获取 Trae globalStorage 路径（全局状态存储）
pub fn get_trae_global_storage_path() -> Result<PathBuf> {
    let trae_path = get_trae_data_path()?;
    Ok(trae_path.join("User").join("globalStorage"))
}

/// 备份指定账号的 Trae 上下文数据
/// 返回备份目录路径
pub fn backup_account_context(account_id: &str) -> Result<PathBuf> {
    let proj_dirs = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow!("无法获取应用数据目录"))?;
    let backup_dir = proj_dirs.data_dir().join("account_contexts").join(account_id);
    
    fs::create_dir_all(&backup_dir)?;
    
    // 备份 workspaceStorage
    let workspace_src = get_trae_workspace_storage_path()?;
    let workspace_dst = backup_dir.join("workspaceStorage");
    if workspace_src.exists() {
        copy_dir_all(&workspace_src, &workspace_dst)?;
    }

    // 备份 globalStorage
    let global_src = get_trae_global_storage_path()?;
    let global_dst = backup_dir.join("globalStorage");
    if global_src.exists() {
        copy_dir_all(&global_src, &global_dst)?;
    }

    // 备份 state.vscdb
    let state_src = get_trae_state_db_path()?;
    let state_dst = backup_dir.join("state.vscdb");
    if state_src.exists() {
        fs::copy(&state_src, &state_dst)?;
    }

    // 备份 IndexedDB
    let trae_path = get_trae_data_path()?;
    let indexed_db_src = trae_path.join("IndexedDB");
    let indexed_db_dst = backup_dir.join("IndexedDB");
    if indexed_db_src.exists() {
        copy_dir_all(&indexed_db_src, &indexed_db_dst)?;
    }

    // 备份 Local Storage
    let local_storage_src = trae_path.join("Local Storage");
    let local_storage_dst = backup_dir.join("LocalStorage");
    if local_storage_src.exists() {
        copy_dir_all(&local_storage_src, &local_storage_dst)?;
    }
    
    Ok(backup_dir)
}

/// 恢复指定账号的 Trae 上下文数据
/// 注意：此函数会保留当前已写入的登录信息，只恢复聊天记录和上下文
pub fn restore_account_context(account_id: &str) -> Result<()> {
    let proj_dirs = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow!("无法获取应用数据目录"))?;
    let backup_dir = proj_dirs.data_dir().join("account_contexts").join(account_id);
    let trae_path = get_trae_data_path()?;

    if !backup_dir.exists() {
        return Err(anyhow!("账号 {} 没有备份的上下文数据", account_id));
    }
    
    // 恢复 workspaceStorage（聊天记录和上下文）
    let workspace_src = backup_dir.join("workspaceStorage");
    let workspace_dst = get_trae_workspace_storage_path()?;
    if workspace_src.exists() {
        // 先删除现有的
        if workspace_dst.exists() {
            fs::remove_dir_all(&workspace_dst)?;
        }
        copy_dir_all(&workspace_src, &workspace_dst)?;

    }
    
    // 恢复 globalStorage，但需要保留当前的登录信息
    let global_src = backup_dir.join("globalStorage");
    let global_dst = get_trae_global_storage_path()?;
    if global_src.exists() {
        // 读取当前 globalStorage 中的登录信息（如果存在）
        let current_storage_path = global_dst.join("storage.json");
        let current_auth_info = if current_storage_path.exists() {
            if let Ok(content) = fs::read_to_string(&current_storage_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    json.get("iCubeAuthInfo://icube.cloudide").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        
        // 删除现有的 globalStorage
        if global_dst.exists() {
            fs::remove_dir_all(&global_dst)?;
        }
        
        // 复制备份的 globalStorage
        copy_dir_all(&global_src, &global_dst)?;
        
        // 如果有当前登录信息，合并回恢复后的 storage.json
        if let Some(auth_info) = current_auth_info {
            let restored_storage_path = global_dst.join("storage.json");
            if let Ok(content) = fs::read_to_string(&restored_storage_path) {
                if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(obj) = json.as_object_mut() {
                        // 保留当前的登录信息
                        obj.insert("iCubeAuthInfo://icube.cloudide".to_string(), auth_info);
                        
                        // 写回文件
                        if let Ok(new_content) = serde_json::to_string_pretty(&json) {
                            let _ = fs::write(&restored_storage_path, new_content);

                        }
                    }
                }
            }
        }
        

    }
    
    // 恢复 state.vscdb（聊天记录数据库）
    let state_src = backup_dir.join("state.vscdb");
    let state_dst = get_trae_state_db_path()?;
    if state_src.exists() {
        fs::copy(&state_src, &state_dst)?;
    }

    // 恢复 IndexedDB
    let indexed_db_src = backup_dir.join("IndexedDB");
    let indexed_db_dst = trae_path.join("IndexedDB");
    if indexed_db_src.exists() {
        if indexed_db_dst.exists() {
            fs::remove_dir_all(&indexed_db_dst)?;
        }
        copy_dir_all(&indexed_db_src, &indexed_db_dst)?;
    }

    // 恢复 Local Storage
    let local_storage_src = backup_dir.join("LocalStorage");
    let local_storage_dst = trae_path.join("Local Storage");
    if local_storage_src.exists() {
        if local_storage_dst.exists() {
            fs::remove_dir_all(&local_storage_dst)?;
        }
        copy_dir_all(&local_storage_src, &local_storage_dst)?;
    }
    
    Ok(())
}

/// 检查账号是否有备份的上下文数据
pub fn has_account_context_backup(account_id: &str) -> bool {
    if let Ok(proj_dirs) = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow!("无法获取应用数据目录")) {
        let backup_dir = proj_dirs.data_dir().join("account_contexts").join(account_id);
        backup_dir.exists()
    } else {
        false
    }
}

/// 删除账号的上下文备份
pub fn delete_account_context_backup(account_id: &str) -> Result<()> {
    let proj_dirs = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow!("无法获取应用数据目录"))?;
    let backup_dir = proj_dirs.data_dir().join("account_contexts").join(account_id);
    
    if backup_dir.exists() {
        fs::remove_dir_all(&backup_dir)?;
    }
    
    Ok(())
}

/// 合并两个账号的对话记录到目标账号的备份中
/// 这会将当前账号的 workspaceStorage 中的对话合并到目标账号的备份
/// 注意：不合并 state.vscdb，因为它包含加密数据，与特定账号绑定
pub fn merge_two_accounts_context(current_account_id: &str, target_account_id: &str) -> Result<()> {
    let proj_dirs = directories::ProjectDirs::from("com", "hhj", "trae-cc")
        .ok_or_else(|| anyhow!("无法获取应用数据目录"))?;
    
    let target_backup_dir = proj_dirs.data_dir().join("account_contexts").join(target_account_id);
    let target_workspace = target_backup_dir.join("workspaceStorage");
    

    
    // 确保目标备份目录存在
    fs::create_dir_all(&target_workspace)?;
    
    // 只合并当前账号的对话到目标账号
    let current_backup_dir = proj_dirs.data_dir().join("account_contexts").join(current_account_id);
    let workspace_src = current_backup_dir.join("workspaceStorage");
    
    let mut total_merged = 0;
    
    // 只合并 workspaceStorage（包含非加密的对话记录）
    // 注意：不合并 state.vscdb，因为它包含加密数据，与特定账号绑定
    if workspace_src.exists() {
        match merge_workspace_storage(&workspace_src, &target_workspace) {
            Ok(count) => {
                total_merged += count;
            }
            Err(_) => {}
        }
    }
    
    Ok(())
}

/// 合并两个 workspaceStorage 目录
/// 将 src 中的对话记录合并到 dst 中
fn merge_workspace_storage(src: &PathBuf, dst: &PathBuf) -> Result<usize> {
    if !src.exists() {
        return Ok(0);
    }
    
    fs::create_dir_all(dst)?;
    
    let mut merged_count = 0;
    
    // 遍历源目录中的所有工作区
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        
        if src_path.is_dir() {
            // 如果是目录，递归合并
            if dst_path.exists() {
                // 目标已存在，合并内部文件
                merged_count += merge_directory_contents(&src_path, &dst_path)?;
            } else {
                // 目标不存在，直接复制
                copy_dir_all(&src_path, &dst_path)?;
                merged_count += 1;
            }
        } else if src_path.is_file() {
            // 如果是文件，根据类型决定是否合并
            let file_name_str = file_name.to_string_lossy();
            
            if file_name_str.ends_with(".vscdb") {
                // SQLite 数据库文件是二进制格式，无法合并
                // 策略：重命名并复制，保留两个文件
                if !dst_path.exists() {
                    fs::copy(&src_path, &dst_path)?;
                    merged_count += 1;
                } else {
                    // 目标已存在，创建副本
                    let mut counter = 1;
                    let mut new_dst_path = dst.with_file_name(format!("{}_{}.vscdb", 
                        file_name_str.strip_suffix(".vscdb").unwrap_or(&file_name_str), 
                        counter));
                    while new_dst_path.exists() {
                        counter += 1;
                        new_dst_path = dst.with_file_name(format!("{}_{}.vscdb", 
                            file_name_str.strip_suffix(".vscdb").unwrap_or(&file_name_str), 
                            counter));
                    }
                    fs::copy(&src_path, &new_dst_path)?;
                    merged_count += 1;
                }
            } else if file_name_str.ends_with(".json") {
                // JSON 文件可以尝试合并
                if dst_path.exists() {
                    merge_database_file(&src_path, &dst_path)?;
                } else {
                    fs::copy(&src_path, &dst_path)?;
                }
                merged_count += 1;
            } else {
                // 其他文件，如果不存在则复制
                if !dst_path.exists() {
                    fs::copy(&src_path, &dst_path)?;
                    merged_count += 1;
                }
            }
        }
    }
    
    Ok(merged_count)
}

/// 合并目录内容
fn merge_directory_contents(src: &PathBuf, dst: &PathBuf) -> Result<usize> {
    let mut count = 0;
    
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        
        if src_path.is_dir() {
            if !dst_path.exists() {
                copy_dir_all(&src_path, &dst_path)?;
                count += 1;
            } else {
                count += merge_directory_contents(&src_path, &dst_path)?;
            }
        } else if src_path.is_file() {
            let file_name_str = file_name.to_string_lossy();
            
            if file_name_str.ends_with(".vscdb") {
                // SQLite 数据库文件是二进制格式，无法合并，直接复制（如果不存在）
                if !dst_path.exists() {
                    fs::copy(&src_path, &dst_path)?;
                    count += 1;
                }
            } else if file_name_str.ends_with(".json") {
                // JSON 文件可以尝试合并
                if dst_path.exists() {
                    merge_database_file(&src_path, &dst_path)?;
                } else {
                    fs::copy(&src_path, &dst_path)?;
                }
                count += 1;
            } else if !dst_path.exists() {
                fs::copy(&src_path, &dst_path)?;
                count += 1;
            }
        }
    }
    
    Ok(count)
}

/// 合并数据库文件（简单的键值合并）
fn merge_database_file(src: &PathBuf, dst: &PathBuf) -> Result<()> {
    // 检查文件扩展名
    let file_name = src.file_name().unwrap_or_default().to_string_lossy();
    
    // .vscdb 文件是 SQLite 二进制数据库，不能直接合并
    // 策略：保留目标文件，因为聊天记录已经在 workspaceStorage 中
    if file_name.ends_with(".vscdb") {
        return Ok(());
    }
    
    // 对于 .json 文件，尝试作为 JSON 合并
    if file_name.ends_with(".json") {
        // 尝试读取为文本
        match (fs::read_to_string(src), fs::read_to_string(dst)) {
            (Ok(src_content), Ok(dst_content)) => {
                // 尝试作为 JSON 合并
                if let (Ok(mut src_json), Ok(mut dst_json)) = (
                    serde_json::from_str::<serde_json::Value>(&src_content),
                    serde_json::from_str::<serde_json::Value>(&dst_content)
                ) {
                    if let (Some(src_obj), Some(dst_obj)) = (src_json.as_object_mut(), dst_json.as_object_mut()) {
                        // 将源对象的键值合并到目标对象
                        for (key, value) in src_obj.iter() {
                            if !dst_obj.contains_key(key) {
                                dst_obj.insert(key.clone(), value.clone());
                            }
                        }
                        
                        // 写回目标文件
                        let merged_content = serde_json::to_string_pretty(&dst_json)?;
                        fs::write(dst, merged_content)?;
                        return Ok(());
                    }
                }
            }
            _ => {}
        }
    }
    
    // 其他情况：如果目标不存在则复制，否则保留目标
    if !dst.exists() {
        fs::copy(src, dst)?;
    }
    
    Ok(())
}

/// 递归复制目录
fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> Result<()> {
    fs::create_dir_all(&dst)?;
    
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        
        if ty.is_dir() {
            copy_dir_all(entry.path(), dst.as_ref().join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.as_ref().join(entry.file_name()))?;
        }
    }
    
    Ok(())
}
