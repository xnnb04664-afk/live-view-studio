# 取景台 · Live View Studio

[中文](#中文) · [English](#english) · [Project website](https://xnnb04664-afk.github.io/live-view-studio/) · [下载 Windows 安装包](https://github.com/xnnb04664-afk/live-view-studio/releases/latest/download/LiveViewStudio-Setup-0.1.2.exe) · [Download installer](https://github.com/xnnb04664-afk/live-view-studio/releases/latest/download/LiveViewStudio-Setup-0.1.2.exe)

Windows 摄像头取景与拍照桌面应用。实时预览、镜像、缩放和平移都在本机完成；可选手机收图通道会在上传前使用 AES-256-GCM 加密照片。

## 中文

- Windows 桌面应用，基于 Electron、React 和 TypeScript
- 摄像头实时取景，支持完整适应、填充裁剪、镜像、0.5×–4× 缩放和自由平移
- 可选控制栏、麦克风、全屏与窗口置顶；设置会保存在本机
- 拍照先保存到本机；配置手机通道后，再加密发送照片
- 开源许可：MIT

### 安装与运行

需要 Node.js 和 Windows。

```powershell
npm ci
npm run typecheck
npm run dev
```

生成 Windows x64 安装包：

```powershell
npm run dist
```

安装包写入 `release-electron-restored/`。打包产物和本地依赖不会提交到 Git。

### 可选：配置手机收图

手机收图使用你自己的 GitHub 私有仓库。首次创建通道前，在启动应用的 PowerShell 会话中设置仓库信息与令牌；令牌建议使用仅对该私有仓库开放 Contents 读写权限的 fine-grained token。不要把令牌提交到仓库或写进 README。

```powershell
$env:GITHUB_TRANSFER_OWNER = "your-github-name"
$env:GITHUB_TRANSFER_REPO = "your-private-photo-repo"
$env:GITHUB_TRANSFER_TOKEN = "your-fine-grained-token"
npm run dev
```

照片默认保存在 `D:\照片传送`，也可在桌面应用设置中选择其他文件夹；更改位置不会移动已有照片。启用手机收图后，保存目录中的图片会自动同步。GitHub 中转仅保存 AES-256-GCM 加密后的照片；请自行管理仓库访问权限和令牌。旧 Cloudflare 通道迁移是可选配置，默认不会连接任何个人服务。

### 仓库范围

本仓库只包含当前 Electron 桌面应用。Android、旧 Cloudflare/WPF 子项目、签名密钥、安装包、缓存和个人附件均不属于此开源仓库。

## English

Live View Studio is an open-source Windows webcam viewer and photo-capture desktop app. Live preview, mirroring, zoom, and panning run locally. An optional phone-receiver channel encrypts photos with AES-256-GCM before upload.

- Electron, React, and TypeScript
- Live camera preview with fit/fill, mirroring, 0.5×–4× zoom, and free panning
- Optional microphone, configurable controls, fullscreen, and always-on-top
- Photos are saved locally first; phone transfer is opt-in
- MIT licensed

### Install and run

Requires Node.js and Windows.

```powershell
npm ci
npm run typecheck
npm run dev
```

Build a Windows x64 installer with `npm run dist`. Generated installers and build output are intentionally excluded from Git.

### Optional phone transfer

Phone transfer uses your own private GitHub repository. Set the repository and token in the PowerShell session that launches the app. Use a fine-grained token limited to Contents read/write access for that private repository, and never commit it.

```powershell
$env:GITHUB_TRANSFER_OWNER = "your-github-name"
$env:GITHUB_TRANSFER_REPO = "your-private-photo-repo"
$env:GITHUB_TRANSFER_TOKEN = "your-fine-grained-token"
npm run dev
```

Photos are saved locally to `D:\照片传送` by default; choose another folder in the desktop app settings if you prefer. Changing the location does not move existing photos. When phone transfer is enabled, images in the selected folder are synced automatically. The GitHub relay stores AES-256-GCM-encrypted photos only. You remain responsible for repository access and token management. Legacy Cloudflare migration is optional and no personal service endpoint is enabled by default.

### Repository scope

This repository contains the current Electron desktop app only. The Android, legacy Cloudflare/WPF projects, signing keys, installers, caches, and personal attachments are intentionally excluded.

## License

MIT. See [LICENSE](LICENSE).
