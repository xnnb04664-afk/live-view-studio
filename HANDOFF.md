# 取景台工作交接

更新日期：2026-10-14

## 项目结构

- Windows 桌面端：Electron、React、TypeScript。`src/renderer/App.tsx` 管理摄像头预览和界面；`src/main.ts` 管理本地照片、加密和桌面上传；`src/github-transfer.ts` 管理 GitHub 私有仓库读写。
- Android 收图端：Kotlin、Jetpack Compose，源码在 `android/`。根 `.gitignore` 忽略 Android 目录，因此 Android 源码和 APK 不会跟随桌面仓库提交。
- 桌面照片先保存在本机，上传前使用 AES-256-GCM 加密。桌面端向私有 GitHub 仓库写入加密原图、预览和清单；手机端从该仓库读取。

## 当前传输和更新路线

- 照片：GitHub 私有仓库是桌面与手机共用的照片中转。ECS 不再承担照片存储或传输。
- 手机相册：滚动期间按可见卡片优先请求预览，快滑时丢弃过时的等待任务，只对带独立预览的照片做少量方向预取；停下后补附近预览。GitHub 预览下载并发为 3。滑动条的拖动监听器挂在包含轨道和滑块的父容器上，避免滑块作为同级视觉层挡住自身触摸；右侧整条触控轨可拖动定位，按滑动速度调整派发频率，拖动结束后提交最终位置。日期提示紧贴 48dp 滑动触控区外缘显示。设置里可选一键收起到年、月或日，默认按月；顶部按钮按所选层级收起，再点展开全部。年份分组标题纳入滚动位置模型。
- 2026-10-14 MuMu 验证：旧实现从滑块开始拖动没有进入回调，从轨道空白处拖动则能滚到对应日期；原因是滑块是透明 `Spacer` 的后绘制同级节点，会挡住触摸。将拖动监听器移到同时包住轨道和滑块的父容器后，用 120 条调试合成记录从顶部滑块拖到底部、再拖回顶部，列表日期分别到达 8 月下旬和回到今天。调试数据和日志已从最终源码移除。此前本地 APK 为 `0.2.34`，MuMu 安装后显示首次配对页；没有真实照片通道用于验收真实照片加载。
- 2026-10-14 MuMu 更新验证：对 `127.0.0.1:7555` 执行 `adb install -r` 成功，包版本为 `0.2.36` / `versionCode 38`，启动后到达首次配对页。该模拟器当前没有绑定收图通道或照片，因此本次无法在 MuMu 点验分组折叠和日期提示。
- 2026-10-14 Android gallery edge layout: the photo grid keeps its 18dp side inset while the scrollbar overlay spans the full gallery width, placing the thumb on the right edge without taking space from the grid. The status text is `私有相册 · 已绑定`: it confirms a saved pairing, not live network reachability. Version is `0.2.37` / `versionCode 39`; `:app:assembleDebug` succeeded, and `adb install -r` plus launch on MuMu succeeded. MuMu has no paired channel or photos, so the scrollbar position could not be visually checked there.
- 2026-10-14 Android update and gallery settings: update metadata checks now try `gh-proxy.com` first and fall back to GitHub direct; APK downloads keep the same proxy-first/direct-second order and existing integrity/signature checks. Gallery one-tap collapse is configurable as year/month/day in Settings, defaulting to month. Debug APK `0.2.38` / `versionCode 40` built successfully, size 21,187,652 bytes, SHA-256 `7CDCAD2F08ACEDD7E323AE45E28A38D142EBC7F1718562B2A633F05CE2372EF5`; the `android-v0.2.38` GitHub release is published and its asset digest matches the local APK. It was not installed with ADB. Android source and generated APK remain locally ignored by the root `.gitignore`.
- 2026-10-14 Android startup and rebinding: `TransferRepository.sync`, original/thumbnail downloads now resume response parsing, decryption, and file writes on `Dispatchers.IO`; thumbnail cache files are checked on demand for visible cards instead of scanning every image during initial state collection. Update work is enqueued from `ReceiverApplication` only; Activity no longer re-enqueues on create/resume. These are code-path optimizations, not device-profile measurements. Android `0.2.39` / `versionCode 41` built and published as `android-v0.2.39`, asset size 21,187,652 bytes, SHA-256 `385D6134B721B0877EBB7C0BAABCBD877AC88EB3EEEB7ADD818BB9C6277A5ED5`; not installed with ADB. Rebinding on the phone does not delete photos. Desktop `resetTransferPairing()` creates a new `channelId` and `roomKey`, so the new key points at a new album; old encrypted photos remain in the old GitHub channel and are not shown by the new key. Desktop schedules local photo-folder resync after reset. The Android settings copy now explains this distinction.
- 2026-10-14 Android differential updater: `0.2.40` / `versionCode 42` adds BSDIFF support. The updater only applies a release patch when its source version and installed APK SHA-256 both match, verifies the patch asset SHA-256, reconstructs the complete target APK, then reuses the existing target size/hash/package/version/signature checks and `PackageInstaller` flow. A patch larger than 70% of the full APK, incompatible source, low available heap, download/apply failure, or verification failure uses the complete APK fallback. New releases need both the full APK and a matching `.bsdiff` asset named `receiver-target-from-source-sourceApkSha256.bsdiff`; generate it with `android/scripts/create-apk-delta.ps1` using the actual released source APK. The generator reconstructs its output and checks SHA-256. The 0.2.40 APK was built and published as `android-v0.2.40`, size 22,001,396 bytes, SHA-256 `32F8B5656BD46FD56055DFF3F62C466045AD568F09B5D8B0EE9F0415F1BBACA8`; it was not installed on a device. A generated and verified 0.2.39-to-0.2.40 patch was 3,797,460 bytes (17.3% of the full APK), but was not attached to the release because 0.2.39 clients cannot consume delta assets. Existing 0.2.39 clients must install 0.2.40 once using the full APK; later releases can use deltas when a matching patch is published.
- 2026-10-14 Android update progress/restart: `0.2.41` / `versionCode 43` reports ranged and resumed download bytes in Settings, shows indeterminate stages while verifying, applying a delta, and handing the APK to PackageInstaller, and reports progress while copying into the installer session. A user-started update asks the install receiver to reopen `MainActivity` on `PackageInstaller.STATUS_SUCCESS` and posts a quiet “tap to open” notification fallback; when Android requires install confirmation, it also posts a notification that opens the system confirmation. Scheduled background updates remain quiet and do not launch the app. Android may block background Activity launches, so automatic foreground restart still needs device verification. Published as `android-v0.2.41`: `receiver-0.2.41.apk`, 21,667,165 bytes, SHA-256 `A52CE161F63DF2DE76E54B51DCDCAE082AD29BF33D31C91EBB14F44663864B7F`; delta from the actual `0.2.40` release APK, 283,507 bytes, SHA-256 `80AA119EDC3EC9F6FFD141B5C3EE28732CF2D52794E47CF2C31C6299414C943F`. Both GitHub asset digests match local build outputs. Not installed with ADB; automatic restart still needs device verification.
- 2026-10-14 全项目审查修复：Electron 截图画布跟随预览比例、镜像平移方向一致、设置/收图对话框不再触发底层快捷键，控制栏空高度不再缩成最小值；已选摄像头不再静默切换到默认设备，麦克风结束后单独有限重试。快门文件名增加毫秒并用独占创建防止连拍覆盖。批量去重时若要给旧照片补预览，会先用旧照片 ID 重新加密预览。Electron IPC 和媒体权限限制到应用页面；系统加密不可用时不再明文保存新凭据，读到旧明文配置时会在加密可用后迁移。Android 修复残缺缓存、并发同步旧清单覆盖、忙碌状态提前清除、首次配对失败仍保存密钥，以及 Android 8–9 相册存储权限。Android 更新为 `0.2.36` / `versionCode 38`，桌面包版本更新为 `0.1.5`。
- 桌面端此前的 `npm run typecheck` 和 `npm run build` 均通过。Android APK 输出为 `android/app/build/outputs/apk/debug/app-debug.apk`，当前大小 21,414,589 字节，SHA-256：`237BE5E36082E904C0CC456A29AFA65E42C79611E94327B99B535545ECB3A968`，版本 `0.2.37` / `versionCode 39`；已覆盖安装到 MuMu 并启动到配对页，尚未在有照片的相册状态下验收 UI。
- 桌面照片上传：普通照片按最多 4 张、密文合计约 12 MiB 的小批次提交，图片、预览和清单一起进入一次 Git 提交；超出大小的照片单独提交。GitHub blob 请求并发限制为 2。
- Android 更新：公开 Release 元数据检查先请求 `gh-proxy.com`，失败后直连 GitHub。APK 和 `.bsdiff` 按 `gh.llkk.cc`、`ghfast.top`、`ghfile.geekertao.top`、GitHub 直连顺序切换；分段探测或分段下载遇到 403/不支持 Range 时，先在同一节点退回普通下载。节点失败后才切换下一源；各源缓存隔离。下载后校验文件大小、Release SHA-256、包名、版本和签名。公共代理只提高可用机会，不能保证节点长期在线，也不接收用户照片或 GitHub Token。Settings 显示下载百分比及校验/安装阶段；安装成功后尝试重新打开界面，并附低优先级通知作为回退。
- Android 后台任务：WorkManager 在联网后启动检查，应用进程启动时立即排队，之后每 12 小时检查一次；唯一入口为 `ReceiverApplication`。更新下载并校验后会请求系统安装；静默安装是否可用由 Android 版本、系统策略和安装权限决定。
- 2026-10-15 Android updater multi-proxy: `0.2.42` / `versionCode 44` tries APK and `.bsdiff` nodes in order: `gh.llkk.cc` → `ghfast.top` → `ghfile.geekertao.top` → GitHub direct. A probe/segment 403 or unsupported-Range response falls back to a normal GET on the same node before moving on; each node keeps its own partial-download cache. Each route reuses the GitHub release size/SHA-256 and final APK package/version/signature checks. Current execution-network probes returned correct `206 Content-Range` for the three nodes; this is not a phone-network guarantee. Metadata lookup remains `gh-proxy.com` then GitHub direct because the download nodes returned HTTP 403 for GitHub Releases API in this probe. `ghproxy.com` APK downloads and `gitproxy.click` were excluded from the download list after current checks showed a homepage redirect and an unsafe external redirect, respectively. Published as `android-v0.2.42`: APK 21,389,908 bytes, SHA-256 `6404B04510E54F32D41031E65A01571C40EC43568A81A5B408543EA639E753C8`; 0.2.41 delta 284,470 bytes, SHA-256 `2590A674C5DC050FD147F48C8B7878431B1EB0CA0339AA05FE3E2E37BE65D6B3`. GitHub asset digests match local files. Not installed with ADB.
- 2026-10-15 reliability fixes: legacy credential read/migration errors now stop initialization instead of looking like an empty configuration; renderer photo-upload IPC is limited to the configured photo folder, including symlink target validation; missing GitHub originals are restored from a locally retained and hash-verified photo; permanently missing local queue files are removed. GitHub conflict retries reuse a retargeted preview's exact ciphertext and nonce. The desktop microphone no longer silently falls back from the chosen device and retries muted live tracks; Android thumbnail downloads retry with capped exponential backoff instead of stopping permanently after three failures. No device acceptance was performed for these changes.
- 2026-10-15 releases: desktop `v0.1.5` is published at https://github.com/xnnb04664-afk/live-view-studio/releases/tag/v0.1.5; installer size 112,542,152 bytes, SHA-256 `E43FD1479949F912E197250D5D577342427660EF3200C19770580F8C8518CBC8`. Android `android-v0.2.43` is published and marked Latest at https://github.com/xnnb04664-afk/live-view-studio/releases/tag/android-v0.2.43; APK size 21,389,908 bytes, SHA-256 `FDC03178D16C2DCF901F5E1E562E046A871A5EEC8C87FA13C9DD8F5B26B5253D`, package `com.liveviewstudio.receiver`, versionCode 45, and signing certificate SHA-256 `f6feafa2a2296ff1786148d38298fc43a523ed2ce773623b5de95aa9e62d3f40`. The 0.2.42-to-0.2.43 delta is 272,222 bytes, SHA-256 `B6A9526E6A34F067657FC965E17E03FC9E85A4252504EE425CF3A8D93CFF2ADC`. GitHub asset digests match local artifacts. Both builds succeeded; no ADB install or device acceptance was performed.
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

Android 需要 JDK 17 和 Android SDK 36。当前源码版本为 `0.2.43`，`versionCode` 为 `45`：

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
