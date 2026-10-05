import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, session, shell } from "electron";
import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  downloadGithubImage,
  githubPreviewPath,
  githubImagePath,
  listGithubImages,
  readGithubManifest,
  updateGithubManifestImages,
  uploadGithubImagesBatch,
  uploadGithubImage,
  uploadGithubPreviewsBatch,
  type GithubPreviewUpload,
  type GithubTransferCredentials,
} from "./github-transfer";
import type {
  PrivacyTarget,
  RemoteImage,
  SnapshotResult,
  TransferChannelState,
  TransferRetryResult,
  WindowState,
} from "./types";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const OPEN_DEVTOOLS = process.env.OPEN_DEVTOOLS === "1";
const START_FULLSCREEN = process.env.START_FULLSCREEN === "1";
const TRANSFER_API_BASE_URL = (process.env.TRANSFER_API_BASE_URL ?? "").replace(/\/+$/, "");
const LEGACY_TRANSFER_API_BASE_URL = (process.env.TRANSFER_API_BASE_URL ?? "").replace(/\/+$/, "");
const GITHUB_TRANSFER_OWNER = (process.env.GITHUB_TRANSFER_OWNER ?? "").trim();
const GITHUB_TRANSFER_REPO = (process.env.GITHUB_TRANSFER_REPO ?? "").trim();
const GITHUB_TRANSFER_BRANCH = (process.env.GITHUB_TRANSFER_BRANCH ?? "main").trim();
const TRANSFER_PROTOCOL_VERSION = "1";
const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
const TRANSFER_MAX_REQUEST_ATTEMPTS = 4;
const TRANSFER_READ_TIMEOUT_MS = 20_000;
const TRANSFER_WRITE_TIMEOUT_MS = 60_000;
const TRANSFER_MAX_RETRY_DELAY_MS = 15_000;
const PENDING_UPLOAD_RETRY_BASE_MS = 15_000;
const PENDING_UPLOAD_RETRY_MAX_MS = 5 * 60_000;
const BACKGROUND_START_DELAY_MS = 1_500;
const PREVIEW_MAX_DIMENSION = 720;
const PREVIEW_JPEG_QUALITY = 78;
const DEFAULT_SNAPSHOT_DIRECTORY = "D:\\照片传送";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif"]);
const SNAPSHOT_FILE_STAMP_PATTERN = /^取景-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/u;
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};
const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 800,
};

let mainWindow: BrowserWindow | null = null;
let snapshotWatcher: ReturnType<typeof fs.watch> | null = null;
let snapshotSyncTimer: NodeJS.Timeout | null = null;
let snapshotSyncPromise: Promise<void> | null = null;
let snapshotSyncRequested = false;
let snapshotDirectoryOverride: string | null = null;
let snapshotDirectoryOverrideLoaded = false;
let snapshotFolderSyncStarted = false;
let snapshotFolderSyncGeneration = 0;
const inFlightUploads = new Map<string, Promise<RemoteImage>>();
let remoteImagesCache: { channelId: string; expiresAt: number; images: RemoteImage[] } | null = null;
let githubTokenCache: string | null = null;
let githubPreviewRepairScheduledFor: string | null = null;
let pendingUploadRetryTimer: NodeJS.Timeout | null = null;
let pendingUploadRetryDueAt = 0;
let pendingUploadRetryPromise: Promise<TransferRetryResult> | null = null;
let backgroundStartupTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) {
        createMainWindow();
      }
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  });
}

type CloudflareTransferCredentials = {
  mode?: "cloudflare";
  channelId: string;
  ownerToken: string;
  roomKey: string;
  createdAt: string;
};

type TransferCredentials = CloudflareTransferCredentials | GithubTransferCredentials;

type PendingUpload = {
  path: string;
  createdAt: string;
  imageId?: string;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
  mimeType?: string;
  nonce?: string;
  attemptCount?: number;
  lastAttemptAt?: string;
  lastError?: string;
};

type UploadedFileRecord = {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  image: RemoteImage;
  uploadedAt: string;
};

type UploadedFileManifest = Record<string, UploadedFileRecord>;

type ChannelStateResponse = {
  channelId: string;
  paired: boolean;
  receiverCount?: number;
  maxReceivers?: number;
  receiverOnline: boolean;
  imageCount: number;
  pairingToken?: string;
  pairingTokens?: string[];
  pairingExpiresAt?: string;
};

function getTransferCredentialsPath(): string {
  return path.join(app.getPath("userData"), "transfer-channel.json");
}

function getTransferQueuePath(): string {
  return path.join(app.getPath("userData"), "transfer-queue.json");
}

function getUploadedFileManifestPath(): string {
  return path.join(app.getPath("userData"), "transfer-uploaded-files.json");
}

function normalizeFilePath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function getImageMimeType(filePath: string): string | null {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

function isSupportedImageFile(filePath: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Snapshot filenames are created from the desktop's local clock. Persist the
 * corresponding instant rather than the later upload time. Imported files
 * without that filename format use their filesystem modification time.
 */
function getCaptureTimestamp(filePath: string, stat: fs.Stats): string {
  const baseName = path.basename(filePath, path.extname(filePath));
  const match = SNAPSHOT_FILE_STAMP_PATTERN.exec(baseName);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    const localDate = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    if (
      Number.isFinite(localDate.getTime())
      && localDate.getFullYear() === Number(year)
      && localDate.getMonth() === Number(month) - 1
      && localDate.getDate() === Number(day)
      && localDate.getHours() === Number(hour)
      && localDate.getMinutes() === Number(minute)
      && localDate.getSeconds() === Number(second)
    ) {
      return localDate.toISOString();
    }
  }

  const modifiedAt = new Date(stat.mtimeMs);
  return Number.isFinite(modifiedAt.getTime()) ? modifiedAt.toISOString() : new Date().toISOString();
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

function createGithubPreviewUpload(
  filePath: string,
  credentials: GithubTransferCredentials,
  imageId: string,
): GithubPreviewUpload | null {
  try {
    const source = nativeImage.createFromPath(filePath);
    if (source.isEmpty()) {
      return null;
    }
    const { width, height } = source.getSize();
    if (!width || !height) {
      return null;
    }
    const scale = Math.min(1, PREVIEW_MAX_DIMENSION / Math.max(width, height));
    const preview = scale < 1
      ? source.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "good",
      })
      : source;
    const plain = preview.toJPEG(PREVIEW_JPEG_QUALITY);
    if (!plain.length) {
      return null;
    }

    const nonce = randomBytes(12);
    const key = decodeBase64Url(credentials.roomKey);
    const aad = Buffer.from(`${credentials.channelId}:${imageId}:${TRANSFER_PROTOCOL_VERSION}:preview`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return {
      encrypted,
      nonce: encodeBase64Url(nonce),
      sizeBytes: encrypted.length,
      mimeType: "image/jpeg",
      plainSize: plain.length,
      storagePath: githubPreviewPath(credentials, imageId),
    };
  } catch (error) {
    console.warn("Unable to create encrypted photo preview", filePath, error);
    return null;
  }
}

function isGithubCredentials(credentials: TransferCredentials | null): credentials is GithubTransferCredentials {
  return Boolean(
    credentials
    && credentials.mode === "github"
    && credentials.githubOwner
    && credentials.githubRepo
    && credentials.githubBranch
    && credentials.githubToken,
  );
}

const execFileAsync = promisify(execFile);

async function getGithubToken(): Promise<string> {
  const environmentToken = process.env.GITHUB_TRANSFER_TOKEN?.trim();
  if (environmentToken) {
    return environmentToken;
  }
  if (githubTokenCache) {
    return githubTokenCache;
  }
  try {
    const result = await execFileAsync("gh", ["auth", "token"], { windowsHide: true });
    const token = result.stdout.trim();
    if (!token) {
      throw new Error("gh 没有返回 GitHub 登录令牌");
    }
    githubTokenCache = token;
    return token;
  } catch (error) {
    if (error instanceof Error && error.message.includes("gh 没有返回")) {
      throw error;
    }
    throw new Error("没有找到 GitHub 登录令牌，请先在终端运行 gh auth login");
  }
}

function readTransferCredentials(): TransferCredentials | null {
  try {
    const envelope = JSON.parse(fs.readFileSync(getTransferCredentialsPath(), "utf8")) as {
      mode?: "encrypted" | "plain";
      value?: string;
    };
    if (!envelope.value) {
      return null;
    }
    const raw = envelope.mode === "encrypted" && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(envelope.value, "base64"))
      : envelope.value;
    return JSON.parse(raw) as TransferCredentials;
  } catch {
    return null;
  }
}

function writeTransferCredentials(credentials: TransferCredentials): void {
  fs.mkdirSync(path.dirname(getTransferCredentialsPath()), { recursive: true });
  const raw = JSON.stringify(credentials);
  const envelope = safeStorage.isEncryptionAvailable()
    ? { mode: "encrypted" as const, value: safeStorage.encryptString(raw).toString("base64") }
    : { mode: "plain" as const, value: raw };
  fs.writeFileSync(getTransferCredentialsPath(), JSON.stringify(envelope, null, 2), "utf8");
}

function readPendingUploads(): PendingUpload[] {
  try {
    const value = JSON.parse(fs.readFileSync(getTransferQueuePath(), "utf8")) as unknown;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PendingUpload => Boolean(
      item && typeof item === "object" && typeof (item as PendingUpload).path === "string",
    ));
  } catch {
    return [];
  }
}

function writePendingUploads(queue: PendingUpload[]): void {
  fs.mkdirSync(path.dirname(getTransferQueuePath()), { recursive: true });
  fs.writeFileSync(getTransferQueuePath(), JSON.stringify(queue, null, 2), "utf8");
}

function readUploadedFileManifest(): UploadedFileManifest {
  try {
    const value = JSON.parse(fs.readFileSync(getUploadedFileManifestPath(), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as UploadedFileManifest;
  } catch {
    return {};
  }
}

function writeUploadedFileManifest(manifest: UploadedFileManifest): void {
  fs.mkdirSync(path.dirname(getUploadedFileManifestPath()), { recursive: true });
  fs.writeFileSync(getUploadedFileManifestPath(), JSON.stringify(manifest, null, 2), "utf8");
}

function rememberUploadedFile(filePath: string, stat: fs.Stats, sha256: string, image: RemoteImage): void {
  const manifest = readUploadedFileManifest();
  const normalizedPath = normalizeFilePath(filePath);
  const previous = manifest[normalizedPath];
  if (
    previous
    && normalizeFilePath(previous.path) === normalizedPath
    && previous.size === stat.size
    && Math.abs(previous.mtimeMs - stat.mtimeMs) <= 2
    && previous.sha256 === sha256
    && JSON.stringify(previous.image) === JSON.stringify(image)
  ) {
    return;
  }
  manifest[normalizedPath] = {
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256,
    image,
    uploadedAt: new Date().toISOString(),
  };
  writeUploadedFileManifest(manifest);
}

function upsertPendingUpload(
  filePath: string,
  details: { size: number; mtimeMs: number; sha256: string; mimeType: string; createdAt?: string },
): PendingUpload {
  const queue = readPendingUploads();
  const normalizedPath = normalizeFilePath(filePath);
  const existing = queue.find((item) => normalizeFilePath(item.path) === normalizedPath);
  if (
    existing?.imageId
    && existing.size === details.size
    && existing.mtimeMs === details.mtimeMs
    && existing.sha256 === details.sha256
  ) {
    return existing;
  }

  const next: PendingUpload = {
    path: filePath,
    imageId: randomUUID(),
    ...details,
    createdAt: details.createdAt ?? new Date().toISOString(),
  };
  writePendingUploads([
    ...queue.filter((item) => normalizeFilePath(item.path) !== normalizedPath),
    next,
  ]);
  return next;
}

function removePendingUpload(filePath: string): void {
  const normalizedPath = normalizeFilePath(filePath);
  const current = readPendingUploads();
  const next = current.filter((item) => normalizeFilePath(item.path) !== normalizedPath);
  if (next.length !== current.length) {
    writePendingUploads(next);
    if (next.length === 0) {
      clearPendingUploadRetryTimer();
    }
  }
}

function rememberPendingNonce(filePath: string, nonce: string): void {
  const normalizedPath = normalizeFilePath(filePath);
  const next = readPendingUploads().map((item) => (
    normalizeFilePath(item.path) === normalizedPath ? { ...item, nonce } : item
  ));
  writePendingUploads(next);
}

function transferErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "未知传输错误";
}

function markPendingUploadFailure(filePath: string, error: unknown): boolean {
  const normalizedPath = normalizeFilePath(filePath);
  const queue = readPendingUploads();
  let found = false;
  const next = queue.map((item) => {
    if (normalizeFilePath(item.path) !== normalizedPath) {
      return item;
    }
    found = true;
    return {
      ...item,
      attemptCount: (item.attemptCount ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: transferErrorMessage(error),
    };
  });
  if (found) {
    writePendingUploads(next);
  }
  return found;
}

function pendingUploadFeedback(): Pick<TransferChannelState, "pendingUploads" | "lastUploadError" | "retryScheduledAt"> {
  const queue = readPendingUploads();
  const latestFailure = queue
    .filter((item) => item.lastError && item.lastAttemptAt)
    .sort((left, right) => (right.lastAttemptAt ?? "").localeCompare(left.lastAttemptAt ?? ""))[0];
  return {
    pendingUploads: queue.length,
    ...(latestFailure?.lastError ? { lastUploadError: latestFailure.lastError } : {}),
    ...(pendingUploadRetryDueAt > Date.now()
      ? { retryScheduledAt: new Date(pendingUploadRetryDueAt).toISOString() }
      : {}),
  };
}

function getTransferAuthHeaders(ownerToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${ownerToken}`,
    ...extra,
  };
}

async function readTransferError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error ?? body.message ?? `中转服务返回 ${response.status}`;
  } catch {
    return `中转服务返回 ${response.status}`;
  }
}

class TransferHttpError extends Error {}

function isRetryableTransferResponse(response: Response): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(response.status);
}

function transferRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(TRANSFER_MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(TRANSFER_MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
    }
  }
  return Math.min(
    TRANSFER_MAX_RETRY_DELAY_MS,
    600 * (2 ** attempt) + Math.floor(Math.random() * 250),
  );
}

function waitForTransferRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function requestTransfer(
  pathname: string,
  init: RequestInit = {},
  ownerToken?: string,
  baseUrl = TRANSFER_API_BASE_URL,
): Promise<Response> {
  if (!baseUrl) {
    throw new Error("尚未配置手机收图服务地址");
  }
  const headers = new Headers(init.headers);
  if (ownerToken) {
    headers.set("Authorization", `Bearer ${ownerToken}`);
  }

  const method = (init.method ?? "GET").toUpperCase();
  const timeoutMs = method === "GET" || method === "HEAD"
    ? TRANSFER_READ_TIMEOUT_MS
    : TRANSFER_WRITE_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < TRANSFER_MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) {
      onAbort();
    } else {
      init.signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (attempt < TRANSFER_MAX_REQUEST_ATTEMPTS - 1 && isRetryableTransferResponse(response)) {
        const delayMs = transferRetryDelayMs(response, attempt);
        await response.body?.cancel().catch(() => undefined);
        await waitForTransferRetry(delayMs);
        continue;
      }
      if (!response.ok) {
        throw new TransferHttpError(await readTransferError(response));
      }
      return response;
    } catch (error) {
      if (init.signal?.aborted) {
        throw error;
      }
      // HTTP errors that are not explicitly transient must surface directly;
      // retrying authentication or validation failures only delays feedback.
      if (error instanceof TransferHttpError) {
        throw error;
      }
      lastError = timedOut
        ? new Error(`中转服务请求超时（${Math.round(timeoutMs / 1_000)} 秒）`)
        : error;
      if (attempt < TRANSFER_MAX_REQUEST_ATTEMPTS - 1) {
        await waitForTransferRetry(transferRetryDelayMs(null, attempt));
      }
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  throw new Error(`无法连接手机收图服务：${transferErrorMessage(lastError)}`);
}

async function listRemoteImages(
  credentials: CloudflareTransferCredentials,
  baseUrl = TRANSFER_API_BASE_URL,
): Promise<RemoteImage[]> {
  const now = Date.now();
  if (remoteImagesCache && remoteImagesCache.channelId === credentials.channelId && remoteImagesCache.expiresAt > now) {
    return remoteImagesCache.images;
  }

  const response = await requestTransfer(
    `/v1/channel/${encodeURIComponent(credentials.channelId)}/images`,
    {},
    credentials.ownerToken,
    baseUrl,
  );
  const body = await response.json() as { images?: RemoteImage[] };
  const images = Array.isArray(body.images) ? body.images : [];
  remoteImagesCache = {
    channelId: credentials.channelId,
    expiresAt: now + 15_000,
    images,
  };
  return images;
}

function rememberRemoteImage(credentials: CloudflareTransferCredentials, image: RemoteImage): void {
  if (!remoteImagesCache || remoteImagesCache.channelId !== credentials.channelId) {
    return;
  }
  remoteImagesCache = {
    ...remoteImagesCache,
    images: [image, ...remoteImagesCache.images.filter((item) => item.id !== image.id)],
  };
}

function createPairingPayload(credentials: CloudflareTransferCredentials, pairingToken: string | undefined): string | null {
  if (!pairingToken) {
    return null;
  }
  return JSON.stringify({
    version: 1,
    app: "取景台",
    api: TRANSFER_API_BASE_URL,
    channelId: credentials.channelId,
    pairingToken,
    roomKey: credentials.roomKey,
  });
}

function createGithubPairingPayload(credentials: GithubTransferCredentials): string {
  return JSON.stringify({
    version: 2,
    app: "取景台",
    mode: "github",
    channelId: credentials.channelId,
    roomKey: credentials.roomKey,
    github: {
      api: "https://api.github.com",
      owner: credentials.githubOwner,
      repo: credentials.githubRepo,
      branch: credentials.githubBranch,
      token: credentials.githubToken,
    },
  });
}

function unconfiguredTransferState(lastError?: string): TransferChannelState {
  return {
    status: "unconfigured",
    channelId: null,
    pairingPayload: null,
    pairingPayloads: [],
    pairingExpiresAt: null,
    paired: false,
    receiverCount: 0,
    maxReceivers: 2,
    receiverOnline: false,
    imageCount: 0,
    ...pendingUploadFeedback(),
    ...(lastError ? { lastError } : {}),
  };
}

async function getTransferState(): Promise<TransferChannelState> {
  const credentials = readTransferCredentials();
  if (!credentials) {
    return unconfiguredTransferState("点击“创建通道”初始化 GitHub 私有中转。");
  }

  if (isGithubCredentials(credentials)) {
    try {
      const images = await listGithubImagesCached(credentials);
      remoteImagesCache = {
        channelId: credentials.channelId,
        expiresAt: Date.now() + 15_000,
        images,
      };
      return {
        status: "paired",
        backend: "github",
        channelId: credentials.channelId,
        pairingPayload: createGithubPairingPayload(credentials),
        pairingPayloads: [createGithubPairingPayload(credentials)],
        pairingExpiresAt: null,
        paired: true,
        receiverCount: 0,
        maxReceivers: 2,
        receiverOnline: false,
        imageCount: images.length,
        ...pendingUploadFeedback(),
      };
    } catch (error) {
      return {
        status: "offline",
        backend: "github",
        channelId: credentials.channelId,
        pairingPayload: createGithubPairingPayload(credentials),
        pairingPayloads: [createGithubPairingPayload(credentials)],
        pairingExpiresAt: null,
        paired: true,
        receiverCount: 0,
        maxReceivers: 2,
        receiverOnline: false,
        imageCount: remoteImagesCache?.images.length ?? 0,
        ...pendingUploadFeedback(),
        lastError: error instanceof Error ? error.message : "无法连接 GitHub 私有中转",
      };
    }
  }

  if (!TRANSFER_API_BASE_URL) {
    return unconfiguredTransferState("当前是旧的 Cloudflare 通道，请点击创建 GitHub 中转。");
  }

  try {
    const response = await requestTransfer(`/v1/channel/${encodeURIComponent(credentials.channelId)}/state`, {}, credentials.ownerToken);
    const state = await response.json() as ChannelStateResponse;
    const pairingTokens = Array.isArray(state.pairingTokens)
      ? state.pairingTokens
      : state.pairingToken
        ? [state.pairingToken]
        : [];
    const pairingPayloads: string[] = [];
    for (const pairingToken of pairingTokens) {
      const payload = createPairingPayload(credentials, pairingToken);
      if (payload) {
        pairingPayloads.push(payload);
      }
    }
    return {
      status: pairingPayloads.length > 0 ? "ready" : state.paired ? "paired" : "ready",
      backend: "cloudflare",
      channelId: credentials.channelId,
      pairingPayload: pairingPayloads[0] ?? null,
      pairingPayloads,
      pairingExpiresAt: state.pairingExpiresAt ?? null,
      paired: state.paired,
      receiverCount: state.receiverCount ?? (state.paired ? 1 : 0),
      maxReceivers: state.maxReceivers ?? 2,
      receiverOnline: state.receiverOnline,
      imageCount: state.imageCount,
      ...pendingUploadFeedback(),
    };
  } catch (error) {
    return {
      status: "offline",
      backend: "cloudflare",
      channelId: credentials.channelId,
      pairingPayload: null,
      pairingPayloads: [],
      pairingExpiresAt: null,
      paired: false,
      receiverCount: 0,
      maxReceivers: 2,
      receiverOnline: false,
      imageCount: 0,
      ...pendingUploadFeedback(),
      lastError: error instanceof Error ? error.message : "无法连接手机收图服务",
    };
  }
}

async function ensureTransferChannel(): Promise<TransferChannelState> {
  let credentials = readTransferCredentials();
  if (!isGithubCredentials(credentials)) {
    if (!GITHUB_TRANSFER_OWNER || !GITHUB_TRANSFER_REPO) {
      throw new Error("请先配置 GITHUB_TRANSFER_OWNER 和 GITHUB_TRANSFER_REPO，再创建私有收图通道。");
    }
    const token = await getGithubToken();
    const legacyCredentials = credentials && !isGithubCredentials(credentials) ? credentials : null;
    const nextCredentials: GithubTransferCredentials = {
      mode: "github",
      channelId: legacyCredentials?.channelId ?? randomUUID(),
      roomKey: legacyCredentials?.roomKey ?? encodeBase64Url(randomBytes(32)),
      githubOwner: GITHUB_TRANSFER_OWNER,
      githubRepo: GITHUB_TRANSFER_REPO,
      githubBranch: GITHUB_TRANSFER_BRANCH,
      githubToken: token,
      createdAt: new Date().toISOString(),
    };
    if (legacyCredentials) {
      await migrateLegacyCloudflareImages(legacyCredentials, nextCredentials);
    }
    credentials = nextCredentials;
    writeTransferCredentials(nextCredentials);
    remoteImagesCache = null;
  }

  if (isGithubCredentials(credentials)) {
    try {
      await repairGithubCaptureTimes(credentials);
      await repairGithubMissingImages(credentials);
    } catch (error) {
      // A metadata repair must not prevent the desktop from opening or
      // uploading new photos when GitHub is temporarily unavailable.
      console.warn("Unable to repair photo capture times", error);
    }
  }

  const state = await getTransferState();
  if (isGithubCredentials(credentials)) {
    scheduleGithubPreviewRepair(credentials);
  }
  scheduleSnapshotFolderSync(0);
  return state;
}

async function repairGithubCaptureTimes(credentials: GithubTransferCredentials): Promise<void> {
  const manifest = await readGithubManifest(credentials);
  if (manifest.images.length === 0) {
    return;
  }

  const uploadedFiles = readUploadedFileManifest();
  const recordsByImageId = new Map<string, UploadedFileRecord>();
  const recordsBySha256 = new Map<string, UploadedFileRecord>();
  for (const record of Object.values(uploadedFiles)) {
    if (record.image?.id) {
      recordsByImageId.set(record.image.id, record);
    }
    if (record.sha256 && !recordsBySha256.has(record.sha256)) {
      recordsBySha256.set(record.sha256, record);
    }
  }

  const repairedByImageId = new Map<string, RemoteImage>();
  let changed = false;
  const repairedImages = manifest.images.map((image) => {
    const record = recordsByImageId.get(image.id)
      ?? (image.sha256 ? recordsBySha256.get(image.sha256) : undefined);
    if (!record) {
      repairedByImageId.set(image.id, image);
      return image;
    }

    try {
      const stat = fs.statSync(record.path);
      // Do not attach a stale local path to a different cloud image after the
      // user has replaced or edited the file.
      if (!stat.isFile() || stat.size !== record.size || Math.abs(stat.mtimeMs - record.mtimeMs) > 2) {
        repairedByImageId.set(image.id, image);
        return image;
      }
      const capturedAt = getCaptureTimestamp(record.path, stat);
      const repaired = capturedAt === image.createdAt ? image : { ...image, createdAt: capturedAt };
      if (repaired !== image) {
        changed = true;
      }
      repairedByImageId.set(image.id, repaired);
      return repaired;
    } catch {
      repairedByImageId.set(image.id, image);
      return image;
    }
  });

  if (!changed) {
    return;
  }

  await updateGithubManifestImages(credentials, repairedImages);

  const nextUploadedFiles = { ...uploadedFiles };
  for (const [key, record] of Object.entries(uploadedFiles)) {
    const repaired = repairedByImageId.get(record.image.id);
    if (repaired && repaired !== record.image) {
      nextUploadedFiles[key] = { ...record, image: repaired };
    }
  }
  writeUploadedFileManifest(nextUploadedFiles);
}

async function listGithubImagesCached(credentials: GithubTransferCredentials): Promise<RemoteImage[]> {
  const now = Date.now();
  if (remoteImagesCache && remoteImagesCache.channelId === credentials.channelId && remoteImagesCache.expiresAt > now) {
    return remoteImagesCache.images;
  }
  const images = await listGithubImages(credentials);
  remoteImagesCache = {
    channelId: credentials.channelId,
    expiresAt: now + 15_000,
    images,
  };
  return images;
}

async function repairGithubMissingImages(credentials: GithubTransferCredentials): Promise<void> {
  const remoteImages = await listGithubImages(credentials);
  remoteImagesCache = {
    channelId: credentials.channelId,
    expiresAt: Date.now() + 15_000,
    images: remoteImages,
  };
  const remoteIds = new Set(remoteImages.map((image) => image.id));
  const uploadedFiles = readUploadedFileManifest();

  for (const record of Object.values(uploadedFiles)) {
    if (!record.image?.id || remoteIds.has(record.image.id)) {
      continue;
    }

    try {
      const stat = await fs.promises.stat(record.path);
      if (!stat.isFile() || stat.size !== record.size || Math.abs(stat.mtimeMs - record.mtimeMs) > 2) {
        continue;
      }
      const plain = await fs.promises.readFile(record.path);
      const plainSha256 = createHash("sha256").update(plain).digest("hex");
      if (plainSha256 !== record.sha256 || plain.length > MAX_TRANSFER_BYTES) {
        continue;
      }

      const repairedPending: PendingUpload = {
        path: record.path,
        createdAt: getCaptureTimestamp(record.path, stat),
        imageId: record.image.id,
        size: plain.length,
        mtimeMs: stat.mtimeMs,
        sha256: plainSha256,
        mimeType: record.image.mimeType,
        nonce: record.image.nonce,
      };
      const restored = await uploadGithubSnapshotFile(
        credentials,
        record.path,
        plain,
        stat,
        record.image.mimeType,
        plainSha256,
        repairedPending,
      );
      remoteIds.add(restored.id);
    } catch (error) {
      console.warn("Unable to restore missing GitHub photo", record.path, error);
    }
  }
}

async function repairGithubPreviews(credentials: GithubTransferCredentials): Promise<void> {
  const remoteImages = await listGithubImagesCached(credentials);
  if (remoteImages.length === 0) {
    return;
  }
  const uploadedFiles = readUploadedFileManifest();
  const recordsByImageId = new Map<string, UploadedFileRecord>();
  for (const record of Object.values(uploadedFiles)) {
    if (record.image?.id) {
      recordsByImageId.set(record.image.id, record);
    }
  }

  const entries: Array<{ image: RemoteImage; preview: GithubPreviewUpload }> = [];
  for (const image of remoteImages) {
    if (image.previewNonce) {
      continue;
    }
    const record = recordsByImageId.get(image.id);
    if (!record) {
      continue;
    }
    try {
      const stat = await fs.promises.stat(record.path);
      if (!stat.isFile() || stat.size !== record.size || Math.abs(stat.mtimeMs - record.mtimeMs) > 2) {
        continue;
      }
      const preview = createGithubPreviewUpload(record.path, credentials, image.id);
      if (preview) {
        entries.push({ image, preview });
      }
      // Keep the Electron UI responsive while backfilling a large history.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (error) {
      console.warn("Unable to prepare encrypted photo preview", record.path, error);
    }
  }

  if (entries.length === 0) {
    return;
  }
  const repairedImages = await uploadGithubPreviewsBatch(credentials, entries);
  remoteImagesCache = {
    channelId: credentials.channelId,
    expiresAt: Date.now() + 15_000,
    images: repairedImages,
  };
}

function scheduleGithubPreviewRepair(credentials: GithubTransferCredentials): void {
  if (githubPreviewRepairScheduledFor === credentials.channelId) {
    return;
  }
  githubPreviewRepairScheduledFor = credentials.channelId;
  setTimeout(() => {
    void repairGithubPreviews(credentials).catch((error) => {
      console.warn("Unable to repair GitHub photo previews", error);
    });
  }, 10_000);
}

async function resetTransferPairing(): Promise<TransferChannelState> {
  const credentials = readTransferCredentials();
  if (!credentials) {
    return ensureTransferChannel();
  }
  if (isGithubCredentials(credentials)) {
    const nextCredentials: GithubTransferCredentials = {
      ...credentials,
      channelId: randomUUID(),
      roomKey: encodeBase64Url(randomBytes(32)),
      createdAt: new Date().toISOString(),
    };
    writeTransferCredentials(nextCredentials);
    remoteImagesCache = null;
    const state = await getTransferState();
    scheduleSnapshotFolderSync(0);
    return state;
  }
  if (!TRANSFER_API_BASE_URL) {
    return unconfiguredTransferState("当前是旧的 Cloudflare 通道，请点击创建 GitHub 中转。");
  }
  await requestTransfer(`/v1/channel/${encodeURIComponent(credentials.channelId)}/reset`, { method: "POST" }, credentials.ownerToken);
  const state = await getTransferState();
  scheduleSnapshotFolderSync(0);
  return state;
}

async function uploadGithubSnapshotFile(
  credentials: GithubTransferCredentials,
  filePath: string,
  plain: Buffer,
  afterRead: fs.Stats,
  mimeType: string,
  plainSha256: string,
  pending: PendingUpload,
): Promise<RemoteImage> {
  try {
    const existingRemoteImage = (await listGithubImagesCached(credentials)).find((image) => (
      image.sha256 === plainSha256 && image.plainSize === plain.length
    ));
    if (existingRemoteImage) {
      try {
        const preview = createGithubPreviewUpload(filePath, credentials, existingRemoteImage.id);
        const upgradedImage = await uploadGithubImage(credentials, existingRemoteImage, Buffer.alloc(0), preview ?? undefined);
        remoteImagesCache = null;
        rememberUploadedFile(filePath, afterRead, plainSha256, upgradedImage);
        removePendingUpload(filePath);
        return upgradedImage;
      } catch (error) {
        // The original photo already exists. A preview repair is optional and
        // must not make an otherwise successful upload look like a failure.
        console.warn("Unable to upload encrypted photo preview", filePath, error);
      }
      rememberUploadedFile(filePath, afterRead, plainSha256, existingRemoteImage);
      removePendingUpload(filePath);
      return existingRemoteImage;
    }
  } catch (error) {
    console.warn("Unable to check existing GitHub photos", error);
  }

  const imageId = pending.imageId ?? randomUUID();
  let nonce = pending.nonce ? decodeBase64Url(pending.nonce) : randomBytes(12);
  if (nonce.length !== 12) {
    nonce = randomBytes(12);
  }
  if (!pending.nonce || decodeBase64Url(pending.nonce).length !== 12) {
    rememberPendingNonce(filePath, encodeBase64Url(nonce));
  }
  const key = decodeBase64Url(credentials.roomKey);
  const aad = Buffer.from(`${credentials.channelId}:${imageId}:${TRANSFER_PROTOCOL_VERSION}`, "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const image: RemoteImage = {
    id: imageId,
    createdAt: pending.createdAt,
    sizeBytes: encrypted.length,
    mimeType,
    nonce: encodeBase64Url(nonce),
    plainSize: plain.length,
    sha256: plainSha256,
    storagePath: githubImagePath(credentials, imageId),
  };
  const preview = createGithubPreviewUpload(filePath, credentials, imageId);
  const savedImage = await uploadGithubImage(credentials, image, encrypted, preview ?? undefined);
  rememberUploadedFile(filePath, afterRead, plainSha256, savedImage);
  remoteImagesCache = null;
  removePendingUpload(filePath);
  return savedImage;
}

async function migrateLegacyCloudflareImages(
  legacy: CloudflareTransferCredentials,
  github: GithubTransferCredentials,
): Promise<void> {
  if (!LEGACY_TRANSFER_API_BASE_URL) {
    return;
  }
  const legacyImages = await listRemoteImages(legacy, LEGACY_TRANSFER_API_BASE_URL);
  if (legacyImages.length === 0) {
    return;
  }

  const batchSize = 8;
  for (let index = 0; index < legacyImages.length; index += batchSize) {
    const batch = legacyImages.slice(index, index + batchSize);
    const encryptedBatch = await Promise.all(batch.map(async (image) => {
      if (!image.nonce) {
        throw new Error(`旧照片 ${image.id} 缺少解密随机数，无法迁移`);
      }
      const response = await requestTransfer(
        `/v1/channel/${encodeURIComponent(legacy.channelId)}/images/${encodeURIComponent(image.id)}/content`,
        {},
        legacy.ownerToken,
        LEGACY_TRANSFER_API_BASE_URL,
      );
      return {
        image: { ...image, storagePath: githubImagePath(github, image.id) },
        encrypted: Buffer.from(await response.arrayBuffer()),
      };
    }));
    await uploadGithubImagesBatch(github, encryptedBatch);
  }
}

async function uploadSnapshotFileInternal(filePath: string): Promise<RemoteImage> {
  const mimeType = getImageMimeType(filePath);
  if (!mimeType) {
    throw new Error("只支持 PNG、JPG、JPEG、WEBP、GIF、HEIC 和 HEIF 图片");
  }

  try {
    const beforeRead = await fs.promises.stat(filePath);
    if (!beforeRead.isFile()) {
      throw new Error("照片路径不是文件");
    }
    const manifest = readUploadedFileManifest();
    const previous = manifest[normalizeFilePath(filePath)];
    const credentials = readTransferCredentials();

    // Existing files are the common startup path. Two cheap stat calls are
    // enough to avoid reading and hashing every original photo again. Only a
    // new/changed file, or a missing remote copy, needs the full read.
    const afterStat = await fs.promises.stat(filePath);
    const unchangedLocalFile = Boolean(
      previous
      && previous.size === afterStat.size
      && Math.abs(previous.mtimeMs - afterStat.mtimeMs) <= 2
      && beforeRead.size === afterStat.size
      && Math.abs(beforeRead.mtimeMs - afterStat.mtimeMs) <= 2
    );
    if (previous && unchangedLocalFile) {
      if (!isGithubCredentials(credentials)) {
        removePendingUpload(filePath);
        return previous.image;
      }

      // A local upload record is only a hint. The GitHub manifest may have
      // been rewritten or partially restored, so verify the image ID before
      // treating the file as fully uploaded.
      const remoteImages = await listGithubImagesCached(credentials);
      const existingRemoteImage = remoteImages.find((image) => image.id === previous.image.id);
      if (existingRemoteImage) {
        rememberUploadedFile(filePath, afterStat, previous.sha256, existingRemoteImage);
        removePendingUpload(filePath);
        return existingRemoteImage;
      }

      const plain = await fs.promises.readFile(filePath);
      if (plain.length > MAX_TRANSFER_BYTES) {
        throw new Error("照片超过手机收图的大小限制");
      }
      const plainSha256 = createHash("sha256").update(plain).digest("hex");
      if (plain.length !== previous.size || plainSha256 !== previous.sha256) {
        throw new Error("照片在校验时发生变化，稍后会自动重试");
      }

      const recoveredPending: PendingUpload = {
        path: filePath,
        createdAt: getCaptureTimestamp(filePath, afterStat),
        imageId: previous.image.id,
        size: plain.length,
        mtimeMs: afterStat.mtimeMs,
        sha256: plainSha256,
        mimeType,
        nonce: previous.image.nonce,
      };
      return uploadGithubSnapshotFile(credentials, filePath, plain, afterStat, mimeType, plainSha256, recoveredPending);
    }

    const plain = await fs.promises.readFile(filePath);
    const afterRead = await fs.promises.stat(filePath);
    if (beforeRead.size !== afterRead.size || Math.abs(beforeRead.mtimeMs - afterRead.mtimeMs) > 2) {
      throw new Error("照片仍在写入，稍后会自动重试");
    }
    if (plain.length > MAX_TRANSFER_BYTES) {
      throw new Error("照片超过手机收图的大小限制");
    }
    const plainSha256 = createHash("sha256").update(plain).digest("hex");

    const pending = upsertPendingUpload(filePath, {
      size: plain.length,
      mtimeMs: afterRead.mtimeMs,
      sha256: plainSha256,
      mimeType,
      createdAt: getCaptureTimestamp(filePath, afterRead),
    });
    if (!credentials || (!isGithubCredentials(credentials) && !TRANSFER_API_BASE_URL)) {
      throw new Error("手机收图通道尚未准备好");
    }

    if (isGithubCredentials(credentials)) {
      return uploadGithubSnapshotFile(credentials, filePath, plain, afterRead, mimeType, plainSha256, pending);
    }

    try {
      const existingRemoteImage = (await listRemoteImages(credentials)).find((image) => (
        image.sha256 === plainSha256 && image.plainSize === plain.length
      ));
      if (existingRemoteImage) {
        rememberUploadedFile(filePath, afterRead, plainSha256, existingRemoteImage);
        removePendingUpload(filePath);
        return existingRemoteImage;
      }
    } catch (error) {
      console.warn("Unable to check existing remote photos", error);
    }

    const imageId = pending.imageId ?? randomUUID();
    const nonce = pending.nonce ? decodeBase64Url(pending.nonce) : randomBytes(12);
    if (nonce.length !== 12) {
      throw new Error("上传队列中的加密随机数无效，请重试这张照片");
    }
    if (!pending.nonce) {
      rememberPendingNonce(filePath, encodeBase64Url(nonce));
    }
    const key = decodeBase64Url(credentials.roomKey);
    const aad = Buffer.from(`${credentials.channelId}:${imageId}:${TRANSFER_PROTOCOL_VERSION}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const response = await requestTransfer(`/v1/channel/${encodeURIComponent(credentials.channelId)}/images`, {
      method: "POST",
      headers: getTransferAuthHeaders(credentials.ownerToken, {
        "Content-Type": "application/octet-stream",
        "X-Image-Id": imageId,
        "X-Nonce": encodeBase64Url(nonce),
        "X-Mime-Type": mimeType,
        "X-Plain-Size": String(plain.length),
        "X-Plain-Sha256": plainSha256,
        "X-Protocol-Version": TRANSFER_PROTOCOL_VERSION,
        "X-Created-At": pending.createdAt,
      }),
      body: encrypted,
    }, credentials.ownerToken);
    const result = await response.json() as RemoteImage;
    const savedImage: RemoteImage = {
      ...result,
      plainSize: result.plainSize ?? plain.length,
      sha256: result.sha256 ?? plainSha256,
    };
    rememberUploadedFile(filePath, afterRead, plainSha256, savedImage);
    rememberRemoteImage(credentials, savedImage);
    removePendingUpload(filePath);
    return savedImage;
  } catch (error) {
    throw error;
  }
}

async function uploadSnapshotFile(filePath: string): Promise<RemoteImage> {
  const normalizedPath = normalizeFilePath(filePath);
  const currentUpload = inFlightUploads.get(normalizedPath);
  if (currentUpload) {
    return currentUpload;
  }

  const resolvedPath = path.resolve(filePath);
  const trackedUpload = uploadSnapshotFileInternal(resolvedPath)
    .catch((error) => {
      if (markPendingUploadFailure(resolvedPath, error)) {
        schedulePendingUploadRetry();
        throw new Error(`照片已保存在本机，发送失败并已加入后台重试：${transferErrorMessage(error)}`);
      }
      throw error;
    })
    .finally(() => {
      if (inFlightUploads.get(normalizedPath) === trackedUpload) {
        inFlightUploads.delete(normalizedPath);
      }
    });
  inFlightUploads.set(normalizedPath, trackedUpload);
  return await trackedUpload;
}

async function retryPendingUploads(): Promise<TransferRetryResult> {
  if (pendingUploadRetryPromise) {
    return pendingUploadRetryPromise;
  }

  const task = (async (): Promise<TransferRetryResult> => {
    const queue = readPendingUploads();
    let sent = 0;
    let failed = 0;
    let lastError: string | undefined;
    for (const item of queue) {
      try {
        await fs.promises.access(item.path, fs.constants.R_OK);
      } catch (error) {
        markPendingUploadFailure(item.path, error);
        failed += 1;
        lastError = transferErrorMessage(error);
        continue;
      }
      try {
        await uploadSnapshotFile(item.path);
        sent += 1;
      } catch (error) {
        failed += 1;
        lastError = transferErrorMessage(error);
      }
    }
    return {
      sent,
      failed,
      remaining: readPendingUploads().length,
      ...(lastError ? { lastError } : {}),
    };
  })();
  pendingUploadRetryPromise = task;
  try {
    return await task;
  } finally {
    if (pendingUploadRetryPromise === task) {
      pendingUploadRetryPromise = null;
    }
    if (readPendingUploads().length > 0) {
      schedulePendingUploadRetry();
    }
  }
}

function pendingUploadRetryDelayMs(): number {
  const queue = readPendingUploads();
  const attempts = queue.length > 0
    ? Math.min(...queue.map((item) => Math.max(1, item.attemptCount ?? 1)))
    : 1;
  return Math.min(PENDING_UPLOAD_RETRY_MAX_MS, PENDING_UPLOAD_RETRY_BASE_MS * (2 ** Math.min(5, attempts - 1)));
}

function clearPendingUploadRetryTimer(): void {
  if (pendingUploadRetryTimer) {
    clearTimeout(pendingUploadRetryTimer);
    pendingUploadRetryTimer = null;
  }
  pendingUploadRetryDueAt = 0;
}

function schedulePendingUploadRetry(delayMs = pendingUploadRetryDelayMs()): void {
  if (isQuitting) {
    return;
  }
  if (readPendingUploads().length === 0) {
    clearPendingUploadRetryTimer();
    return;
  }
  const nextDueAt = Date.now() + Math.max(0, delayMs);
  if (pendingUploadRetryTimer && pendingUploadRetryDueAt <= nextDueAt) {
    return;
  }
  clearPendingUploadRetryTimer();
  pendingUploadRetryDueAt = nextDueAt;
  pendingUploadRetryTimer = setTimeout(() => {
    pendingUploadRetryTimer = null;
    pendingUploadRetryDueAt = 0;
    void retryPendingUploads().catch((error) => {
      console.warn("Unable to retry queued photo uploads", error);
      schedulePendingUploadRetry();
    });
  }, Math.max(0, nextDueAt - Date.now()));
}

async function runSnapshotFolderSync(): Promise<void> {
  const credentials = readTransferCredentials();
  if (!credentials || (!isGithubCredentials(credentials) && !TRANSFER_API_BASE_URL)) {
    return;
  }

  const directory = getSnapshotDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isSupportedImageFile(entry.name)) {
      continue;
    }
    try {
      await uploadSnapshotFile(path.join(directory, entry.name));
    } catch (error) {
      console.warn("Unable to sync photo", entry.name, error);
    }
  }
}

function syncSnapshotFolder(): void {
  if (snapshotSyncPromise) {
    snapshotSyncRequested = true;
    return;
  }

  const task = runSnapshotFolderSync();
  snapshotSyncPromise = task
    .catch((error) => {
      console.warn("Unable to scan snapshot folder", error);
    })
    .finally(() => {
      snapshotSyncPromise = null;
      if (snapshotSyncRequested) {
        snapshotSyncRequested = false;
        scheduleSnapshotFolderSync(100);
      }
    });
}

function scheduleSnapshotFolderSync(delayMs = 500): void {
  if (snapshotSyncTimer) {
    clearTimeout(snapshotSyncTimer);
  }
  snapshotSyncTimer = setTimeout(() => {
    snapshotSyncTimer = null;
    syncSnapshotFolder();
  }, delayMs);
}

async function startSnapshotFolderSync(): Promise<void> {
  if (snapshotFolderSyncStarted) {
    return;
  }
  snapshotFolderSyncStarted = true;
  const generation = ++snapshotFolderSyncGeneration;
  const directory = getSnapshotDirectory();
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (error) {
    if (generation === snapshotFolderSyncGeneration) {
      snapshotFolderSyncStarted = false;
    }
    throw error;
  }
  if (generation !== snapshotFolderSyncGeneration || directory !== getSnapshotDirectory()) {
    return;
  }
  try {
    snapshotWatcher = fs.watch(directory, { persistent: true }, (_eventType, filename) => {
      if (!filename || isSupportedImageFile(filename.toString())) {
        scheduleSnapshotFolderSync();
      }
    });
    snapshotWatcher.on("error", (error) => {
      console.warn("Snapshot folder watcher stopped", error);
      snapshotWatcher = null;
    });
  } catch (error) {
    console.warn("Unable to watch snapshot folder", error);
  }
  scheduleSnapshotFolderSync(1000);
  schedulePendingUploadRetry(2_000);
}

function stopSnapshotFolderSync(): void {
  snapshotFolderSyncStarted = false;
  snapshotFolderSyncGeneration += 1;
  snapshotSyncRequested = false;
  if (snapshotSyncTimer) {
    clearTimeout(snapshotSyncTimer);
    snapshotSyncTimer = null;
  }
  snapshotWatcher?.close();
  snapshotWatcher = null;
  clearPendingUploadRetryTimer();
}

function getWindowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), "utf8");
    const stored = JSON.parse(raw) as Partial<WindowState>;
    return {
      width: Math.max(stored.width ?? DEFAULT_WINDOW_STATE.width, 720),
      height: Math.max(stored.height ?? DEFAULT_WINDOW_STATE.height, 480),
      ...(typeof stored.x === "number" ? { x: stored.x } : {}),
      ...(typeof stored.y === "number" ? { y: stored.y } : {}),
    };
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
  };

  try {
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.warn("Unable to persist window state", error);
  }
}

function createMainWindow(): void {
  const windowState = readWindowState();

  mainWindow = new BrowserWindow({
    ...windowState,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    resizable: true,
    show: true,
    backgroundColor: "#0b0d0d",
    title: "取景台",
    icon: path.join(app.getAppPath(), "build", "取景台.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    if (START_FULLSCREEN) {
      mainWindow?.setFullScreen(true);
    }
  });

  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    if (OPEN_DEVTOOLS) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("主窗口尚未准备好");
  }
  return mainWindow;
}

function getSnapshotDirectory(): string {
  if (!snapshotDirectoryOverrideLoaded) {
    try {
      const settings = JSON.parse(fs.readFileSync(getSnapshotDirectorySettingsPath(), "utf8")) as { directory?: unknown };
      const directory = typeof settings.directory === "string" ? settings.directory.trim() : "";
      snapshotDirectoryOverride = directory && path.isAbsolute(directory) ? path.normalize(directory) : null;
    } catch {
      snapshotDirectoryOverride = null;
    }
    snapshotDirectoryOverrideLoaded = true;
  }

  if (snapshotDirectoryOverride) {
    return snapshotDirectoryOverride;
  }
  return process.env.SNAPSHOT_DIRECTORY?.trim() || DEFAULT_SNAPSHOT_DIRECTORY;
}

function getSnapshotDirectorySettingsPath(): string {
  return path.join(app.getPath("userData"), "photo-storage.json");
}

function persistSnapshotDirectory(directory: string | null): void {
  const settingsPath = getSnapshotDirectorySettingsPath();
  if (directory) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ directory }, null, 2), "utf8");
  } else {
    try {
      fs.unlinkSync(settingsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  snapshotDirectoryOverride = directory;
  snapshotDirectoryOverrideLoaded = true;
}

function registerIpcHandlers(): void {
  ipcMain.on("window:minimize", () => {
    ensureMainWindow().minimize();
  });

  ipcMain.on("window:close", () => {
    ensureMainWindow().close();
  });

  ipcMain.handle("window:toggle-maximize", () => {
    const window = ensureMainWindow();
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return window.isMaximized();
  });

  ipcMain.handle("window:set-fullscreen", (_event, enabled: boolean) => {
    const window = ensureMainWindow();
    window.setFullScreen(Boolean(enabled));
    return window.isFullScreen();
  });

  ipcMain.handle("window:set-always-on-top", (_event, enabled: boolean) => {
    const window = ensureMainWindow();
    window.setAlwaysOnTop(Boolean(enabled), "floating");
    return window.isAlwaysOnTop();
  });

  ipcMain.handle("window:get-state", () => {
    const window = ensureMainWindow();
    return {
      isFullscreen: window.isFullScreen(),
      isMaximized: window.isMaximized(),
      isAlwaysOnTop: window.isAlwaysOnTop(),
    };
  });

  ipcMain.handle("snapshot:save", async (_event, dataUrl: string): Promise<SnapshotResult> => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("照片数据格式不受支持");
    }

    if (dataUrl.length > 50 * 1024 * 1024) {
      throw new Error("照片数据过大，无法保存");
    }

    const directory = getSnapshotDirectory();
    await fs.promises.mkdir(directory, { recursive: true });
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const fileName = `取景-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
    const filePath = path.join(directory, fileName);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));

    return { path: filePath, directory };
  });

  ipcMain.handle("snapshot:get-directory", () => getSnapshotDirectory());

  ipcMain.handle("snapshot:choose-directory", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(ensureMainWindow(), {
      defaultPath: getSnapshotDirectory(),
      properties: ["openDirectory", "createDirectory"],
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) {
      return null;
    }

    const directory = path.resolve(selectedPath);
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.access(directory, fs.constants.W_OK);
    persistSnapshotDirectory(directory);
    stopSnapshotFolderSync();
    void startSnapshotFolderSync().catch((error) => {
      console.warn("Unable to watch selected photo folder", error);
    });
    return directory;
  });

  ipcMain.handle("snapshot:reset-directory", async (): Promise<string> => {
    persistSnapshotDirectory(null);
    stopSnapshotFolderSync();
    void startSnapshotFolderSync().catch((error) => {
      console.warn("Unable to watch default photo folder", error);
    });
    return getSnapshotDirectory();
  });

  ipcMain.handle("snapshot:open-folder", async () => {
    const directory = getSnapshotDirectory();
    await fs.promises.mkdir(directory, { recursive: true });
    await shell.openPath(directory);
  });

  ipcMain.handle("transfer:get-state", () => getTransferState());
  ipcMain.handle("transfer:ensure-channel", () => ensureTransferChannel());
  ipcMain.handle("transfer:reset-pairing", () => resetTransferPairing());
  ipcMain.handle("transfer:upload-snapshot", (_event, filePath: string) => {
    if (typeof filePath !== "string" || !filePath) {
      throw new Error("照片路径无效");
    }
    return uploadSnapshotFile(filePath);
  });
  ipcMain.handle("transfer:retry-pending", () => retryPendingUploads());

  ipcMain.handle("system:open-privacy-settings", async (_event, target: PrivacyTarget) => {
    const settingsUri = target === "microphone" ? "ms-settings:privacy-microphone" : "ms-settings:privacy-webcam";
    await shell.openExternal(settingsUri);
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media");
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  registerIpcHandlers();
  createMainWindow();
  // Camera preview is the primary activity. Let the first frame settle before
  // GitHub repair/network work and the photo-directory scan compete for CPU,
  // disk and IPC time. A photo captured during this brief delay is picked up by
  // the initial directory scan.
  backgroundStartupTimer = setTimeout(() => {
    backgroundStartupTimer = null;
    if (isQuitting) {
      return;
    }
    // Initialize the GitHub relay before watching the photo folder. Existing
    // Cloudflare credentials are migrated on this first run so the phone keeps
    // seeing the old history under the same channel key.
    void ensureTransferChannel()
      .catch((error) => {
        console.warn("Unable to initialize GitHub photo relay", error);
      })
      .finally(() => {
        if (!isQuitting) {
          void startSnapshotFolderSync().catch((error) => {
            console.warn("Unable to start snapshot folder sync", error);
          });
        }
      });
  }, BACKGROUND_START_DELAY_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (backgroundStartupTimer) {
    clearTimeout(backgroundStartupTimer);
    backgroundStartupTimer = null;
  }
  stopSnapshotFolderSync();
  saveWindowState();
});
