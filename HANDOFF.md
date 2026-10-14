# 取景台工作交接

更新日期：2026-10-14

## 项目结构

- Windows 桌面端：Electron、React、TypeScript。`src/renderer/App.tsx` 管理摄像头预览和界面；`src/main.ts` 管理本地照片、加密和桌面上传；`src/github-transfer.ts` 管理 GitHub 私有仓库读写。
- Android 收图端：Kotlin、Jetpack Compose，源码在 `android/`。根 `.gitignore` 忽略 Android 目录，因此 Android 源码和 APK 不会跟随桌面仓库提交。
- 桌面照片先保存在本机，上传前使用 AES-256-GCM 加密。桌面端向私有 GitHub 仓库写入加密原图、预览和清单；手机端从该仓库读取。

## 当前传输和更新路线

- 照片：GitHub 私有仓库是桌面与手机共用的照片中转。ECS 不再承担照片存储或传输。
- 手机相册：滚动期间按可见卡片优先请求预览，快滑时丢弃过时的等待任务，只对带独立预览的照片做少量方向预取；停下后补附近预览。GitHub 预览下载并发为 3。右侧整条触控轨可拖动定位；滚动跳转请求在独立派发协程中执行，拖动结束会完成最终定位后再清理。收起月份或日期后，可在相册状态栏点击“展开全部”同时展开所有分组。
- 桌面照片上传：普通照片按最多 4 张、密文合计约 12 MiB 的小批次提交，图片、预览和清单一起进入一次 Git 提交；超出大小的照片单独提交。GitHub blob 请求并发限制为 2。
- Android 更新：读取公开 GitHub Releases；APK 先从 `gh-proxy.com` 下载，失败后直连 GitHub。下载后检查大小、Release 提供的 SHA-256、包名、版本和签名。
- Android 后台任务：WorkManager 在联网后启动检查，应用启动时立即排队，之后每 12 小时检查一次。更新下载并校验后会请求系统安装；静默安装是否可用由 Android 版本、系统策略和安装权限决定。
- 旧桌面配置：旧 ECS 凭据只用于迁移时读取照片；迁移核对完成前不会切换主凭据。不要恢复 ECS 写入路径。

## 服务器处置与照片完整性

- 用户当前 GitHub 通道已完成迁移：ECS 端 395 张照片，与 GitHub 清单中的 395 张照片、395 个原图对象和 395 个预览对象逐一对应；缺失对象为 0，文件大小不匹配为 0，GitHub 文件树未截断。
- 已停止并删除 `live-view-studio-transfer` 服务，以及 ECS 上 `/var/lib/live-view-studio`、`/opt/live-view-studio-server`、`/etc/live-view-studio` 和取景台 Nginx 路由。
- 该 ECS 还承载另一项 `/gomoku-api/` 服务。其 Nginx 配置、证书和 3088 端口保持运行；不要清理整台 ECS、通用 Nginx、证书或共享防火墙规则。

## 构建

桌面端需要 Node.js：

```powershell
npm run typecheck
npm run build
npm run dist
```

Android 需要 JDK 17 和 Android SDK 36。当前源码版本为 `0.2.33`，`versionCode` 为 `35`：

```powershell
Set-Location D:\视频软件开发\android
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat :app:assembleDebug
```

已发布 APK 的签名与本机 Gradle debug 签名一致；发布 Android 更新时不得更换签名密钥。不要把密钥或令牌写入仓库。

## 用户数据与注意事项

- Electron 用户数据位于 `%APPDATA%\live-view-studio`，其中通道凭据由 Electron `safeStorage` 加密；不要输出凭据内容或令牌。
- 照片默认保存在 `D:\照片传送`，设置中的其他照片目录也属于用户数据，不能当作构建缓存删除。
- Android 的 `android/` 路径被 Git 忽略；修改和构建后需单独管理 Android 发布资产。
- 构建成功不代表真机已安装或验收。除非用户另行要求，不要用 ADB 安装。
