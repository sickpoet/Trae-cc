# Trae-cc (Trae账号管理)

Trae IDE 多账号管理工具，支持账号切换、额度监控、批量操作。

## 技术栈

- 前端: React 19 + TypeScript + Vite
- 后端: Rust + Tauri 2
- 构建: GitHub Actions 云端打包（本地无需 Rust 环境）

## 版本号规则

从 3.0 起，每次改动 +0.1（3.1 → 3.2 → 3.3 ...）。  
版本号在三个文件中同步修改：
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## 打包流程

打包产物固定放在 `appexe/` 文件夹，文件名带版本号：
```
appexe/
  Trae账号管理_3.2.exe
```

### 自动打包

```bash
bash scripts/check-and-build.sh
```

逻辑：读取版本号 → 检查 appexe/ 是否有对应版本 → 没有则推送 tag 触发 GitHub Actions → 等待完成 → 下载 exe 到 appexe/。

### 手动触发

GitHub 仓库 → Actions → Build Windows → Run workflow。

## 窗口标题

启动后标题自动显示：`Trae账号管理 v{版本号}`

## 启动时自动校验 exe

每次进入本项目，执行以下检查（无需用户提示）：

1. 读取 `package.json` 中的版本号（如 `3.2.4`）
2. 检查 `appexe/` 目录是否存在对应文件（如 `Trae账号管理_3.2.4.exe`）
3. 如果不存在，用 `gh` 下载最新 Release 的 exe：
   ```bash
   gh release download v{版本号} -p "*.exe" -D appexe/ -R sickpoet/Trae-cc
   ```
4. 下载完成后用 `ls appexe/` 确认文件到位

注意：只检查不匹配时才下载，已有则跳过，不要重复操作。

## 开发

```bash
npm install
npm run tauri dev
```
