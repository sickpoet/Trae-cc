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

## 开发

```bash
npm install
npm run tauri dev
```
