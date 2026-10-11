# 取景台 · Live View Studio

[中文](#中文) · [English](#english) · [Project website](https://xnnb04664-afk.github.io/live-view-studio/) · [下载 Windows 安装包](https://github.com/xnnb04664-afk/live-view-studio/releases/latest/download/LiveViewStudio-Setup-0.1.4.exe) · [Download installer](https://github.com/xnnb04664-afk/live-view-studio/releases/latest/download/LiveViewStudio-Setup-0.1.4.exe)

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

### 可选：配置手机收图与 GitHub 私有中转

手机收图使用你自己的 GitHub 私有仓库中转。桌面端在本机先用 AES-256-GCM 加密原图和预览，再直接上传密文；手机端通过桌面生成的只读连接密钥下载照片。首次创建通道前，在启动应用的 PowerShell 会话中设置仓库信息与令牌；令牌建议使用仅对该私有仓库开放 Contents 读写权限的 fine-grained token。不要把令牌提交到仓库或写进 README。

```powershell
$env:GITHUB_TRANSFER_OWNER = "your-github-name"
$env:GITHUB_TRANSFER_REPO = "your-private-photo-repo"
$env:GITHUB_TRANSFER_TOKEN = "your-fine-grained-token"
$env:GITHUB_TRANSFER_READ_TOKEN = "your-read-only-token"
npm run dev
```

`GITHUB_TRANSFER_READ_TOKEN` 是手机连接密钥使用的令牌，必须对该私有仓库仅授予 Contents 只读权限；桌面端的写入令牌不会放进手机连接密钥。照片默认保存在 `D:\照片传送`，也可在桌面应用设置中选择其他文件夹；更改位置不会移动已有照片。桌面端直接向私有 GitHub 仓库上传加密原图、预览和清单；手机端直接从同一仓库读取，照片不经过 ECS。GitHub 仓库保留归档副本。清单包含拍摄时间、文件类型、尺寸和哈希等元数据。旧桌面通道若仍有已保存的 GitHub 备份凭据，会在启动时核对历史照片后切换为 GitHub 主通道；不要在迁移核对完成前删除唯一的数据副本。请自行管理仓库访问权限和令牌。

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

### Optional phone transfer through a private GitHub repository

Phone transfer uses your own private GitHub repository directly. The desktop encrypts the original photo and preview with AES-256-GCM before upload; the phone reads the ciphertext through the desktop-generated read-only pairing key. Set the repository and token in the PowerShell session that launches the app. Use a fine-grained token limited to Contents read/write access for that private repository, and never commit it.

```powershell
$env:GITHUB_TRANSFER_OWNER = "your-github-name"
$env:GITHUB_TRANSFER_REPO = "your-private-photo-repo"
$env:GITHUB_TRANSFER_TOKEN = "your-fine-grained-token"
$env:GITHUB_TRANSFER_READ_TOKEN = "your-read-only-token"
npm run dev
```

Set `GITHUB_TRANSFER_READ_TOKEN` to a separate fine-grained token with **Contents: read-only** access to that one repository. The desktop keeps its write token private and places only this read-only token in the phone pairing key. Restart the desktop app after setting it, then bind the phone with the pairing key shown by the desktop. The Android app stores that key in encrypted Keystore-backed storage. The phone reads photos directly from GitHub; it does not send photo traffic through the ECS.

Photos are saved locally to `D:\照片传送` by default; choose another folder in the desktop app settings if you prefer. Changing the location does not move existing photos. The desktop uploads encrypted photos, previews, and a manifest directly to GitHub. The manifest contains capture time, media type, size, and hash metadata. You remain responsible for repository access and token management. Existing ECS photo channels are only read during one-time migration and are never used for new uploads.

### Repository scope

This repository contains the current Electron desktop app only. The Android, legacy Cloudflare/WPF projects, signing keys, installers, caches, and personal attachments are intentionally excluded.

## License

MIT. See [LICENSE](LICENSE).
