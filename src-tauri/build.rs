fn main() {
    // 自动加载 .env 文件中的环境变量，以便在编译时使用 env!() 宏
    if let Ok(content) = std::fs::read_to_string(".env") {
        for line in content.lines() {
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim().trim_matches('"').trim_matches('\'');
                if !key.is_empty() && !key.starts_with('#') {
                    println!("cargo:rustc-env={}={}", key, value);
                }
            }
        }
    }
    tauri_build::build()
}
