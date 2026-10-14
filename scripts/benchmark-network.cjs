"use strict";

// Run from the project root with:
//   .\node_modules\.bin\electron.cmd .\scripts\benchmark-network.cjs
// This uses the current Windows user's encrypted app credentials in memory.
// It never prints credentials. Private-photo proxy tests require an explicit
// in-terminal confirmation before forwarding the GitHub token.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { app, safeStorage } = require("electron");
const qiniu = require("qiniu");

const ECS_MANIFEST_URL = "https://101.201.76.166/v1/app-updates/android/latest.json";
const ECS_APK_BASE_URL = "https://101.201.76.166/v1/app-updates/android/";
const GITHUB_PROXY_BASE_URL = "https://gh-proxy.com/";
const GITHUB_REPOSITORY = "xnnb04664-afk/live-view-studio";
const APP_NAME = "live-view-studio";
const PHOTO_SIZE_BYTES = 5_635_797;
const PREVIEW_SIZE_BYTES = 22_868;
const PROTOCOL_VERSION = "1";
const TEST_CREATED_AT = "2000-01-01T00:00:00.000Z";

const githubTransfer = require(path.join(__dirname, "..", "dist-electron", "github-transfer.js"));

function parseRounds() {
  const arg = process.argv.find((value) => value.startsWith("--rounds="));
  const value = Number(arg?.slice("--rounds=".length) ?? process.env.LVS_BENCH_ROUNDS ?? 3);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 10)) : 3;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readQiniuConfig() {
  const configPath = path.join(os.homedir(), ".qiniu", "benchmark.env");
  const localValues = parseEnvFile(configPath);
  const value = (name) => String(process.env[name] || localValues[name] || "").trim();
  const config = {
    accessKey: value("QINIU_ACCESS_KEY"),
    secretKey: value("QINIU_SECRET_KEY"),
    bucket: value("QINIU_BUCKET"),
    region: value("QINIU_REGION"),
    domain: value("QINIU_DOMAIN").replace(/\/+$/, ""),
  };
  const supplied = Object.values(config).some(Boolean);
  if (!supplied) return null;
  const missing = ["accessKey", "secretKey", "bucket", "domain"].filter((name) => !config[name]);
  if (missing.length) {
    throw new Error(`七牛本机配置缺少字段：${missing.join(", ")}（填写 ${configPath}）`);
  }
  if (!/^https?:\/\//i.test(config.domain)) {
    throw new Error("QINIU_DOMAIN 必须是以 http:// 或 https:// 开头的空间访问域名");
  }
  return config;
}

async function confirmGithubProxyPhotoTest() {
  console.log("反向代理照片测速会把 GitHub Authorization 请求头转发给 gh-proxy.com。");
  console.log("样本是随机生成的 AES-256-GCM 密文，写入临时分支；脚本完成后会删除该分支。");
  console.log("服务端仍会接触你的 GitHub Token，其可访问范围取决于该 Token 的权限。");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("当前不是交互终端，已跳过需要 GitHub Token 的反向代理照片测速。");
    return false;
  }
  const readline = require("node:readline/promises");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("接受以上说明并继续？输入 YES 开始，其他输入跳过：");
    return answer.trim() === "YES";
  } finally {
    terminal.close();
  }
}

async function withGithubApiProxy(operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL ? input.href : input?.url;
    if (typeof requestUrl === "string" && requestUrl.startsWith("https://api.github.com/")) {
      return originalFetch.call(globalThis, GITHUB_PROXY_BASE_URL + requestUrl, init);
    }
    return originalFetch.call(globalThis, input, init);
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function formatSeconds(seconds) {
  return `${seconds.toFixed(3)} 秒`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function speedMbps(bytes, seconds) {
  return seconds > 0 ? bytes / seconds / 1_000_000 : 0;
}

function hashBuffer(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function encryptPayload(plain, roomKey, channelId, imageId, preview = false) {
  const key = decodeBase64Url(roomKey);
  if (key.length !== 32) throw new Error("本机收图密钥长度无效");
  const nonce = crypto.randomBytes(12);
  const suffix = preview ? ":preview" : "";
  const aad = Buffer.from(`${channelId}:${imageId}:${PROTOCOL_VERSION}${suffix}`, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { encrypted, nonce: encodeBase64Url(nonce) };
}

function assertOk(response, label) {
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}`);
}

async function fetchBytes(url, init = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, init = {}, timeoutMs = 30_000) {
  const { response, bytes } = await fetchBytes(url, init, timeoutMs);
  assertOk(response, "请求");
  return JSON.parse(bytes.toString("utf8"));
}

function readEncryptedConfig(userDataPath, filename) {
  const filePath = path.join(userDataPath, filename);
  if (!fs.existsSync(filePath)) return null;
  const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!envelope || typeof envelope.value !== "string") return null;
  let raw = envelope.value;
  if (envelope.mode === "encrypted") {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron 安全存储不可用，无法读取本机测速凭据");
    }
    raw = safeStorage.decryptString(Buffer.from(envelope.value, "base64"));
  }
  return JSON.parse(raw);
}

function findUserDataPath() {
  const appData = app.getPath("appData");
  const candidates = [
    app.getPath("userData"),
    path.join(appData, APP_NAME),
    path.join(appData, "取景台"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "transfer-channel.json")))
    ?? candidates.find((candidate) => fs.existsSync(path.join(candidate, "transfer-channel-github-backup.json")))
    ?? null;
}

async function fetchAndroidUpdateManifest() {
  try {
    const manifest = await fetchJson(ECS_MANIFEST_URL);
    if (manifest.versionName && manifest.assetName) return manifest;
  } catch (error) {
    console.log(`ECS 更新清单暂不可读，将尝试从 GitHub 获取版本信息（${error.message}）`);
  }

  const release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "lvs-network-benchmark" },
  });
  const asset = (release.assets ?? []).find((item) => /^receiver-\d+\.\d+\.\d+\.apk$/i.test(item.name));
  if (!asset) throw new Error("GitHub 最新发行版中没有找到 Android APK");
  const versionName = asset.name.slice("receiver-".length, -".apk".length);
  const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/i, "") : "";
  return {
    versionName,
    assetName: asset.name,
    sizeBytes: asset.size,
    sha256: digest,
    githubDownloadUrl: asset.browser_download_url,
    githubSizeBytes: asset.size,
    githubSha256: digest,
  };
}

async function benchmarkApkDownloads(rounds, temporaryDirectory) {
  console.log("\n一、Android APK 下载测速");
  const manifest = await fetchAndroidUpdateManifest();
  const githubUrl = manifest.githubDownloadUrl;
  const expectedSize = Number(manifest.sizeBytes || manifest.githubSizeBytes || 0);
  const expectedHash = String(manifest.sha256 || manifest.githubSha256 || "").toLowerCase();
  if (!githubUrl || !/^https:\/\/github\.com\//i.test(githubUrl)) {
    throw new Error("更新清单没有提供可信的 GitHub APK 地址");
  }

  const candidates = [
    { key: "github", label: "GitHub 直连", url: githubUrl },
    { key: "proxy", label: "反向代理", url: `${GITHUB_PROXY_BASE_URL}${githubUrl}` },
    { key: "ecs", label: "ECS", url: `${ECS_APK_BASE_URL}${encodeURIComponent(manifest.assetName)}` },
  ];
  const samples = new Map(candidates.map((candidate) => [candidate.key, []]));

  console.log(`版本：${manifest.versionName}；文件：${manifest.assetName}；大小：${expectedSize.toLocaleString()} 字节`);
  for (let round = 0; round < rounds; round += 1) {
    const order = candidates.slice(round % candidates.length).concat(candidates.slice(0, round % candidates.length));
    for (const candidate of order) {
      const outputPath = path.join(temporaryDirectory, `apk-${round + 1}-${candidate.key}.apk`);
      const started = performance.now();
      try {
        const { response, bytes } = await fetchBytes(candidate.url, {}, 180_000);
        assertOk(response, candidate.label);
        fs.writeFileSync(outputPath, bytes);
        const elapsed = (performance.now() - started) / 1000;
        const digest = hashBuffer(bytes);
        const sizeOk = !expectedSize || bytes.length === expectedSize;
        const hashOk = !expectedHash || digest === expectedHash;
        if (!sizeOk || !hashOk) {
          console.log(`第 ${round + 1} 轮 ${candidate.label}：校验失败（${bytes.length} 字节，SHA-256 ${digest}）`);
        } else {
          samples.get(candidate.key).push({ seconds: elapsed, bytes: bytes.length });
          console.log(`第 ${round + 1} 轮 ${candidate.label}：${formatSeconds(elapsed)}，${speedMbps(bytes.length, elapsed).toFixed(2)} MB/s，SHA-256 一致`);
        }
      } catch (error) {
        console.log(`第 ${round + 1} 轮 ${candidate.label}：失败（${error.message}）`);
      } finally {
        fs.rmSync(outputPath, { force: true });
      }
    }
  }

  console.log("APK 中位数（只统计校验成功的样本）：");
  for (const candidate of candidates) {
    const successful = samples.get(candidate.key);
    const medianSeconds = median(successful.map((sample) => sample.seconds));
    if (medianSeconds == null) {
      console.log(`  ${candidate.label}：没有有效样本`);
    } else {
      const bytes = successful[0].bytes;
      console.log(`  ${candidate.label}：${formatSeconds(medianSeconds)}，${speedMbps(bytes, medianSeconds).toFixed(2)} MB/s（${successful.length}/${rounds}）`);
    }
  }
  return manifest;
}

function githubApiUrl(credentials, pathname) {
  const prefix = `https://api.github.com/repos/${encodeURIComponent(credentials.githubOwner)}/${encodeURIComponent(credentials.githubRepo)}`;
  return `${prefix}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

async function githubApiRequest(credentials, pathname, init = {}) {
  const response = await fetch(githubApiUrl(credentials, pathname), {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credentials.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "live-view-studio-network-benchmark",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub API 返回 HTTP ${response.status}`);
  return body ? JSON.parse(body) : null;
}

async function createTemporaryGithubBranch(credentials) {
  const baseRef = await githubApiRequest(credentials, `git/ref/heads/${credentials.githubBranch}`);
  const branch = `codex/speed-test-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  await githubApiRequest(credentials, "git/refs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
  });
  return branch;
}

async function deleteTemporaryGithubBranch(credentials, branch) {
  if (!branch) return;
  const response = await fetch(githubApiUrl(credentials, `git/refs/heads/${branch}`), {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credentials.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "live-view-studio-network-benchmark",
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`临时 GitHub 分支清理失败（HTTP ${response.status}，分支 ${branch}）`);
  }
}

function makeGithubPhoto(imagePlain, previewPlain, credentials, imageId) {
  const original = encryptPayload(imagePlain, credentials.roomKey, credentials.channelId, imageId);
  const preview = encryptPayload(previewPlain, credentials.roomKey, credentials.channelId, imageId, true);
  const createdAt = TEST_CREATED_AT;
  const image = {
    id: imageId,
    createdAt,
    sizeBytes: original.encrypted.length,
    mimeType: "image/jpeg",
    nonce: original.nonce,
    plainSize: imagePlain.length,
    sha256: hashBuffer(imagePlain),
    width: 3840,
    height: 2160,
  };
  return {
    image,
    original,
    preview: {
      encrypted: preview.encrypted,
      nonce: preview.nonce,
      sizeBytes: preview.encrypted.length,
      mimeType: "image/jpeg",
      plainSize: previewPlain.length,
      storagePath: githubTransfer.githubPreviewPath(credentials, imageId),
    },
  };
}

async function uploadEcsPhoto(credentials, imageId, payload) {
  const api = String(credentials.api || process.env.TRANSFER_API_BASE_URL || "").replace(/\/+$/, "");
  if (!api) throw new Error("本机收图通道中没有 ECS 服务地址");
  const imageUrl = `${api}/v1/channel/${encodeURIComponent(credentials.channelId)}/images`;
  const imageResponse = await fetch(imageUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.ownerToken}`,
      "Content-Type": "application/octet-stream",
      "X-Image-Id": imageId,
      "X-Nonce": payload.original.nonce,
      "X-Mime-Type": "image/jpeg",
      "X-Plain-Size": String(payload.imagePlain.length),
      "X-Plain-Sha256": hashBuffer(payload.imagePlain),
      "X-Protocol-Version": PROTOCOL_VERSION,
      "X-Created-At": TEST_CREATED_AT,
    },
    body: payload.original.encrypted,
    signal: AbortSignal.timeout(120_000),
  });
  assertOk(imageResponse, "ECS 照片上传");
  const previewResponse = await fetch(`${imageUrl}/${encodeURIComponent(imageId)}/preview`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.ownerToken}`,
      "Content-Type": "application/octet-stream",
      "X-Nonce": payload.preview.nonce,
      "X-Mime-Type": "image/jpeg",
      "X-Plain-Size": String(payload.previewPlain.length),
    },
    body: payload.preview.encrypted,
    signal: AbortSignal.timeout(120_000),
  });
  assertOk(previewResponse, "ECS 预览图上传");
}

async function downloadEcsPhoto(credentials, imageId) {
  const api = String(credentials.api || process.env.TRANSFER_API_BASE_URL || "").replace(/\/+$/, "");
  const root = `${api}/v1/channel/${encodeURIComponent(credentials.channelId)}/images/${encodeURIComponent(imageId)}`;
  const headers = { Authorization: `Bearer ${credentials.ownerToken}` };
  const original = await fetchBytes(`${root}/content`, { headers });
  assertOk(original.response, "ECS 照片下载");
  const preview = await fetchBytes(`${root}/preview`, { headers });
  assertOk(preview.response, "ECS 预览图下载");
  return { original: original.bytes, preview: preview.bytes };
}

async function deleteEcsPhoto(credentials, imageId) {
  const api = String(credentials.api || process.env.TRANSFER_API_BASE_URL || "").replace(/\/+$/, "");
  if (!api) return;
  const response = await fetch(`${api}/v1/channel/${encodeURIComponent(credentials.channelId)}/images/${encodeURIComponent(imageId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${credentials.ownerToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`ECS 测试照片清理失败（HTTP ${response.status}）`);
}

async function measureEcsPhoto(credentials, imagePlain, previewPlain) {
  const imageId = crypto.randomUUID();
  const payload = makeGithubPhoto(imagePlain, previewPlain, credentials, imageId);
  const totalBytes = payload.original.encrypted.length + payload.preview.encrypted.length;
  let uploadSeconds = null;
  let downloadSeconds = null;
  try {
    let started = performance.now();
    await uploadEcsPhoto(credentials, imageId, { ...payload, imagePlain, previewPlain });
    uploadSeconds = (performance.now() - started) / 1000;

    started = performance.now();
    const downloaded = await downloadEcsPhoto(credentials, imageId);
    downloadSeconds = (performance.now() - started) / 1000;
    if (downloaded.original.length + downloaded.preview.length !== totalBytes ||
        hashBuffer(downloaded.original) !== hashBuffer(payload.original.encrypted) ||
        hashBuffer(downloaded.preview) !== hashBuffer(payload.preview.encrypted)) {
      throw new Error("ECS 下载内容与上传密文校验不一致");
    }
    return { uploadSeconds, downloadSeconds, bytes: totalBytes };
  } finally {
    await deleteEcsPhoto(credentials, imageId);
  }
}

async function measureGithubPhoto(credentials, imagePlain, previewPlain) {
  const imageId = crypto.randomUUID();
  const payload = makeGithubPhoto(imagePlain, previewPlain, credentials, imageId);
  const totalBytes = payload.original.encrypted.length + payload.preview.encrypted.length;

  let started = performance.now();
  const uploaded = await githubTransfer.uploadGithubImagesBatch(credentials, [
    { image: payload.image, encrypted: payload.original.encrypted },
  ]);
  const baseImage = uploaded.find((item) => item.id === imageId) ?? payload.image;
  const withPreview = await githubTransfer.uploadGithubPreviewsBatch(credentials, [
    { image: baseImage, preview: payload.preview },
  ]);
  const storedImage = withPreview.find((item) => item.id === imageId) ?? baseImage;
  const uploadSeconds = (performance.now() - started) / 1000;

  started = performance.now();
  const imageBytes = await githubTransfer.downloadGithubImage(credentials, storedImage);
  const previewBytes = await githubTransfer.downloadGithubPreview(credentials, storedImage);
  const downloadSeconds = (performance.now() - started) / 1000;
  if (imageBytes.length + previewBytes.length !== totalBytes ||
      hashBuffer(imageBytes) !== hashBuffer(payload.original.encrypted) ||
      hashBuffer(previewBytes) !== hashBuffer(payload.preview.encrypted)) {
    throw new Error("GitHub 下载内容与上传密文校验不一致");
  }
  return { uploadSeconds, downloadSeconds, bytes: totalBytes };
}

function createQiniuClient(credentials) {
  const mac = new qiniu.auth.digest.Mac(credentials.accessKey, credentials.secretKey);
  const configOptions = { useHttpsDomain: true };
  // Region is optional: the Node SDK can query the bucket's region using AK + bucket.
  if (credentials.region) {
    configOptions.regionsProvider = qiniu.httpc.Region.fromRegionId(credentials.region);
  }
  const config = new qiniu.conf.Config(configOptions);
  return {
    mac,
    config,
    uploader: new qiniu.form_up.FormUploader(config),
    bucketManager: new qiniu.rs.BucketManager(mac, config),
  };
}

async function uploadQiniuObject(client, credentials, key, bytes) {
  const policy = new qiniu.rs.PutPolicy({
    scope: `${credentials.bucket}:${key}`,
    expires: 600,
    insertOnly: 1,
    fsizeLimit: bytes.length,
  });
  const uploadToken = policy.uploadToken(client.mac);
  const extra = new qiniu.form_up.PutExtra();
  extra.mimeType = "application/octet-stream";
  const { resp } = await client.uploader.put(uploadToken, key, bytes, extra);
  if (resp.statusCode !== 200) throw qiniuResponseError("七牛上传", resp);
}

async function downloadQiniuObject(client, credentials, key) {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const url = client.bucketManager.privateDownloadUrl(credentials.domain, key, deadline);
  const { response, bytes } = await fetchBytes(url, {}, 120_000);
  assertOk(response, "七牛照片下载");
  return bytes;
}

async function deleteQiniuObject(client, credentials, key) {
  const { resp } = await client.bucketManager.delete(credentials.bucket, key);
  if (resp.statusCode !== 200 && resp.statusCode !== 612) {
    throw qiniuResponseError("七牛测试对象清理", resp);
  }
}

function qiniuResponseError(action, resp) {
  const data = resp?.data;
  const detail = typeof data === "string"
    ? data
    : data?.error || data?.message || "";
  const suffix = detail ? `：${String(detail).slice(0, 240)}` : "";
  return new Error(`${action}返回 HTTP ${resp?.statusCode ?? "未知"}${suffix}`);
}

function safeQiniuError(error, credentials) {
  let message = String(error?.message || error || "未知错误");
  for (const secret of [credentials.accessKey, credentials.secretKey]) {
    if (secret) message = message.replaceAll(secret, "[已隐藏]");
  }
  return message;
}

async function measureQiniuPhoto(credentials, imagePlain, previewPlain) {
  const client = createQiniuClient(credentials);
  const imageId = crypto.randomUUID();
  const prefix = `codex-benchmark/${Date.now()}-${imageId}`;
  const imageKey = `${prefix}/photo.bin`;
  const previewKey = `${prefix}/preview.bin`;
  const roomKey = crypto.randomBytes(32).toString("base64url");
  const channelId = `benchmark-${imageId}`;
  const payload = {
    original: encryptPayload(imagePlain, roomKey, channelId, imageId),
    preview: encryptPayload(previewPlain, roomKey, channelId, imageId, true),
  };
  const totalBytes = payload.original.encrypted.length + payload.preview.encrypted.length;
  let imageUploadAttempted = false;
  let previewUploadAttempted = false;
  let failure = null;

  try {
    const startedUpload = performance.now();
    imageUploadAttempted = true;
    await uploadQiniuObject(client, credentials, imageKey, payload.original.encrypted);
    previewUploadAttempted = true;
    await uploadQiniuObject(client, credentials, previewKey, payload.preview.encrypted);
    const uploadSeconds = (performance.now() - startedUpload) / 1000;

    const startedDownload = performance.now();
    const downloadedImage = await downloadQiniuObject(client, credentials, imageKey);
    const downloadedPreview = await downloadQiniuObject(client, credentials, previewKey);
    const downloadSeconds = (performance.now() - startedDownload) / 1000;
    if (downloadedImage.length !== payload.original.encrypted.length ||
        downloadedPreview.length !== payload.preview.encrypted.length ||
        hashBuffer(downloadedImage) !== hashBuffer(payload.original.encrypted) ||
        hashBuffer(downloadedPreview) !== hashBuffer(payload.preview.encrypted)) {
      throw new Error("七牛下载内容与上传密文校验不一致");
    }
    return { uploadSeconds, downloadSeconds, bytes: totalBytes };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = [];
    if (previewUploadAttempted) cleanup.push(deleteQiniuObject(client, credentials, previewKey));
    if (imageUploadAttempted) cleanup.push(deleteQiniuObject(client, credentials, imageKey));
    const outcomes = await Promise.allSettled(cleanup);
    const cleanupFailure = outcomes.find((outcome) => outcome.status === "rejected");
    if (cleanupFailure) {
      const message = `七牛测试对象未能全部清理：${safeQiniuError(cleanupFailure.reason, credentials)}`;
      if (failure) console.error(message);
      else throw new Error(message);
    }
  }
}

function printPhotoSummary(label, rows) {
  const successful = rows.filter((row) => !row.error);
  if (!successful.length) {
    console.log(`  ${label}：没有有效样本`);
    for (const row of rows) if (row.error) console.log(`    ${row.error}`);
    return;
  }
  const uploadMedian = median(successful.map((row) => row.uploadSeconds));
  const downloadMedian = median(successful.map((row) => row.downloadSeconds));
  const bytes = successful[0].bytes;
  console.log(`  ${label} 上传：中位数 ${formatSeconds(uploadMedian)}，${speedMbps(bytes, uploadMedian).toFixed(2)} MB/s（${successful.length} 个有效样本）`);
  console.log(`  ${label} 下载：中位数 ${formatSeconds(downloadMedian)}，${speedMbps(bytes, downloadMedian).toFixed(2)} MB/s（${successful.length} 个有效样本）`);
  for (const row of rows) if (row.error) console.log(`    失败：${row.error}`);
}

async function benchmarkPhotoTransfer(rounds, transferCredentials, backupCredentials, qiniuCredentials) {
  console.log("\n二、照片传送测速");
  console.log(`使用合成密文样本：原图 ${PHOTO_SIZE_BYTES.toLocaleString()} 字节 + 预览 ${PREVIEW_SIZE_BYTES.toLocaleString()} 字节；不使用或上传真实照片。`);
  const imagePlain = crypto.randomBytes(PHOTO_SIZE_BYTES);
  const previewPlain = crypto.randomBytes(PREVIEW_SIZE_BYTES);
  const ecsRows = [];
  const qiniuRows = [];
  const githubRows = [];
  const githubProxyRows = [];
  let temporaryBranch = null;
  let githubTestCredentials = backupCredentials;
  let githubBranchOwnerCredentials = null;
  let proxyAuthorizationConsented = false;

  if (transferCredentials?.mode === "cloudflare" && transferCredentials.ownerToken && transferCredentials.roomKey) {
    console.log("ECS 照片测速会在当前收图通道创建随机测试记录，并在每轮后立即删除。");
  } else {
    console.log("ECS 照片测速跳过：本机没有可用的 ECS 收图通道凭据。");
  }

  if (qiniuCredentials) {
    console.log("七牛照片测速使用随机频道名和 codex-benchmark/ 临时对象；每轮完成后会删除测试对象。");
  } else {
    console.log("七牛照片测速跳过：尚未配置本机七牛测试参数。");
  }

  if (transferCredentials?.mode === "github") githubTestCredentials = transferCredentials;
  if (backupCredentials && transferCredentials?.mode === "cloudflare" &&
      (backupCredentials.channelId !== transferCredentials.channelId || backupCredentials.roomKey !== transferCredentials.roomKey)) {
    githubTestCredentials = null;
    console.log("GitHub 照片测速跳过：本机备份通道与当前 ECS 通道不匹配。");
  }

  try {
    if (githubTestCredentials?.githubToken && githubTestCredentials.githubOwner && githubTestCredentials.githubRepo) {
      try {
        proxyAuthorizationConsented = await confirmGithubProxyPhotoTest();
        temporaryBranch = await createTemporaryGithubBranch(githubTestCredentials);
        githubBranchOwnerCredentials = githubTestCredentials;
        githubTestCredentials = {
          ...githubTestCredentials,
          githubBranch: temporaryBranch,
          channelId: "benchmark-" + crypto.randomUUID(),
          roomKey: crypto.randomBytes(32).toString("base64url"),
        };
        console.log("GitHub 照片测速使用临时分支和临时频道编号，测试完成后会删除分支。");
      } catch (error) {
        githubTestCredentials = null;
        console.log(`GitHub 照片测速跳过：无法创建临时分支（${error.message}）。`);
      }
    } else {
      githubTestCredentials = null;
      console.log("GitHub 照片测速跳过：本机没有可用的私有备份凭据。");
    }

    for (let round = 0; round < rounds; round += 1) {
      const routeOrder = ["ecs", "qiniu", "github", "github-proxy"];
      const offset = round % routeOrder.length;
      const routes = routeOrder.slice(offset).concat(routeOrder.slice(0, offset));
      for (const route of routes) {
        if (route === "ecs" && transferCredentials?.mode === "cloudflare" && transferCredentials.ownerToken) {
          try {
            const result = await measureEcsPhoto(transferCredentials, imagePlain, previewPlain);
            ecsRows.push(result);
            console.log(`第 ${round + 1} 轮 ECS：上传 ${formatSeconds(result.uploadSeconds)}；下载 ${formatSeconds(result.downloadSeconds)}`);
          } catch (error) {
            ecsRows.push({ error: error.message });
            console.log(`第 ${round + 1} 轮 ECS 照片测速失败：${error.message}`);
          }
        } else if (route === "qiniu" && qiniuCredentials) {
          try {
            const result = await measureQiniuPhoto(qiniuCredentials, imagePlain, previewPlain);
            qiniuRows.push(result);
            console.log(`第 ${round + 1} 轮 七牛：上传 ${formatSeconds(result.uploadSeconds)}；下载 ${formatSeconds(result.downloadSeconds)}`);
          } catch (error) {
            const message = safeQiniuError(error, qiniuCredentials);
            qiniuRows.push({ error: message });
            console.log(`第 ${round + 1} 轮 七牛照片测速失败：${message}`);
          }
        } else if (route === "github" && githubTestCredentials) {
          try {
            const result = await measureGithubPhoto(githubTestCredentials, imagePlain, previewPlain);
            githubRows.push(result);
            console.log(`第 ${round + 1} 轮 GitHub 直连：上传 ${formatSeconds(result.uploadSeconds)}；下载 ${formatSeconds(result.downloadSeconds)}`);
          } catch (error) {
            githubRows.push({ error: error.message });
            console.log(`第 ${round + 1} 轮 GitHub 照片测速失败：${error.message}`);
          }
        } else if (route === "github-proxy" && githubTestCredentials && proxyAuthorizationConsented) {
          try {
            const result = await withGithubApiProxy(() => measureGithubPhoto(githubTestCredentials, imagePlain, previewPlain));
            githubProxyRows.push(result);
            console.log(`第 ${round + 1} 轮 GitHub 反向代理：上传 ${formatSeconds(result.uploadSeconds)}；下载 ${formatSeconds(result.downloadSeconds)}`);
          } catch (error) {
            githubProxyRows.push({ error: error.message });
            console.log(`第 ${round + 1} 轮 GitHub 反向代理照片测速失败：${error.message}`);
          }
        }
      }
    }
  } finally {
    if (temporaryBranch) {
      await deleteTemporaryGithubBranch(githubBranchOwnerCredentials, temporaryBranch);
      console.log("GitHub 临时测试分支已删除。");
    }
  }

  console.log("照片测速中位数：");
  printPhotoSummary("ECS", ecsRows);
  if (qiniuCredentials) printPhotoSummary("七牛 Kodo", qiniuRows);
  else console.log("  七牛 Kodo：已跳过（请配置用户目录下的 .qiniu/benchmark.env）");
  printPhotoSummary("GitHub 直连", githubRows);
  if (proxyAuthorizationConsented) {
    printPhotoSummary("GitHub 反向代理", githubProxyRows);
  } else {
    console.log("  GitHub 反向代理照片读写：已跳过（未确认向代理转发 GitHub Token）。");
  }
}

async function main() {
  app.setName(APP_NAME);
  await app.whenReady();
  const rounds = parseRounds();
  const userDataPath = findUserDataPath();
  if (!userDataPath) throw new Error("没有找到桌面端收图配置。请在这台电脑上先启动并配置一次取景台。");

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lvs-network-benchmark-"));
  let cleanupSucceeded = false;
  try {
    console.log(`测速轮数：${rounds}；结果按中位数汇总。`);
    let manifest = null;
    try {
      manifest = await benchmarkApkDownloads(rounds, temporaryDirectory);
    } catch (error) {
      console.log(`APK 下载测速未完成：${error.message}`);
    }
    const transferCredentials = readEncryptedConfig(userDataPath, "transfer-channel.json");
    const backupCredentials = readEncryptedConfig(userDataPath, "transfer-channel-github-backup.json");
    let qiniuCredentials = null;
    try {
      qiniuCredentials = readQiniuConfig();
    } catch (error) {
      console.log(`七牛照片测速配置无效：${error.message}`);
    }
    await benchmarkPhotoTransfer(rounds, transferCredentials, backupCredentials, qiniuCredentials);
    if (manifest) {
      console.log(`\nAPK SHA-256：${manifest.sha256 || manifest.githubSha256 || "清单未提供"}`);
    }
    console.log("测速完成。");
  } finally {
    try {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      cleanupSucceeded = true;
      console.log("本机测速临时文件夹已删除。");
    } catch (error) {
      console.log(`本机测速临时文件夹未能自动删除：${temporaryDirectory}（${error.message}）`);
    }
  }
  if (!cleanupSucceeded) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`测速未完成：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
