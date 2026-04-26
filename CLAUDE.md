# Trae-cc (Trae账号管理)

Trae IDE 多账号管理工具，支持账号切换、额度监控、批量操作。

## 技术栈

- 前端: React 19 + TypeScript + Vite
- 后端: Rust + Tauri 2
- 构建: `npm run tauri build`

## 版本号规则

从 3.0 起，每次改动 +0.1（3.1 → 3.2 → 3.3 ...）。  
版本号在三个文件中同步修改：
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## 打包输出

打包产物固定放在项目根目录的 `appexe/` 文件夹：

```
appexe/
  Trae账号管理.exe      ← 从 src-tauri/target/release/ 复制
```

打包命令：
```bash
npm run tauri build
# 构建完成后手动复制：
cp src-tauri/target/release/Trae账号管理.exe appexe/
```

## 窗口标题

启动后窗口标题自动显示版本号：`Trae账号管理 v3.2.0`

## 开发

```bash
npm install
npm run tauri dev
```
