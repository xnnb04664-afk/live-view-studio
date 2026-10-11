import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, session, shell } from "electron";
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  githubPreviewPath,
  githubImagePath,
  listGithubFilePaths,
  listGithubImages,
  readGithubManifest,
  updateGithubManifestImages,
  uploadGithubImage,
  uploadGithubPreviewsBatch,
  type GithubManifest,
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
const GITHUB_TRANSFER_OWNER = (process.env.GITHUB_TRANSFER_OWNER ?? "").trim();
const GITHUB_TRANSFER_REPO = (process.env.GITHUB_TRANSFER_REPO ?? "").trim();
const GITHUB_TRANSFER_BRANCH = (process.env.GITHUB_TRANSFER_BRANCH ?? "main").trim();
const GITHUB_TRANSFER_READ_TOKEN = (process.env.GITHUB_TRANSFER_READ_TOKEN ?? "").trim();
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
let githubBackupManifestCache: { channelId: string; expiresAt: number; manifest: GithubManifest } | null = null;
let transferChannelSetupPromise: Promise<TransferChannelState> | null = null;
let pendingUploadRetryTimer: NodeJS.Timeout | null = null;
let pendingUploadRetryDueAt = 0;
let pendingUploadRetryPromise: Promise<TransferRetryResult> | null = null;
let pendingGithubBackupRetryTimer: NodeJS.Timeout | null = null;
let pendingGithubBackupRetryDueAt = 0;
let pendingGithubBackupRetryPromise: Promise<GithubBackupRetryResult> | null = null;
let githubBackupQueueWritePromise: Promise<void> = Promise.resolve();
let githubBackupReconciliationPending = false;
let githubBackupReconciliationAttempts = 0;
let githubBackupLastError: string | undefined;
let legacyGithubMigrationPromise: Promise<GithubTransferCredentials> | null = null;
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
  api?: string;
  channelId: string;
  ownerToken: string;
  roomKey: string;
  createdAt: string;
  initialized?: boolean;
  migrationSourceGithub?: GithubTransferCredentials;
};

type TransferServerBootstrapConfig = {
  api: string;
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

type PendingGithubBackup = {
  channelId: string;
  image: RemoteImage;
  hasImageBlob?: boolean;
  hasPreview: boolean;
  repairImageBlob?: boolean;
  repairPreviewBlob?: boolean;
  revision?: string;
  queuedAt: string;
  attemptCount?: number;
  lastAttemptAt?: string;
  lastError?: string;
};

type GithubBackupRetryResult = {
  sent: number;
  failed: number;
  remaining: number;
  lastError?: string;
};

function getTransferCredentialsPath(): string {
  return path.join(app.getPath("userData"), "transfer-channel.json");
}

function getTransferServerBootstrapPath(): string {
  return path.join(app.getPath("userData"), "transfer-server-bootstrap.json");
}

function readTransferServerBootstrapConfig(): TransferServerBootstrapConfig | null {
  try {
    const value = JSON.parse(fs.readFileSync(getTransferServerBootstrapPath(), "utf8")) as Partial<TransferServerBootstrapConfig>;
    const api = typeof value.api === "string" ? value.api.replace(/\/+$/, "") : "";
    if (!api.startsWith("https://")) {
      return null;
    }
    return { api };
  } catch {
    return null;
  }
}

function transferApiBaseUrl(credentials?: CloudflareTransferCredentials): string {
  return (credentials?.api || readTransferServerBootstrapConfig()?.api || TRANSFER_API_BASE_URL).replace(/\/+$/, "");
}

function getTransferQueuePath(): string {
  return path.join(app.getPath("userData"), "transfer-queue.json");
}

function getUploadedFileManifestPath(): string {
  return path.join(app.getPath("userData"), "transfer-uploaded-files.json");
}

function getGithubCredentialsBackupPath(): string {
  return path.join(app.getPath("userData"), "transfer-channel-github-backup.json");
}

function getGithubBackupQueuePath(): string {
  return path.join(app.getPath("userData"), "transfer-github-backup-queue.json");
}

function getGithubBackupObjectsDirectory(): string {
  return path.join(app.getPath("userData"), "transfer-github-backup-objects");
}

function getGithubBackupObjectPath(imageId: string, preview = false): string {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(imageId)) {
    throw new Error("GitHub 备份照片编号无效");
  }
  return path.join(getGithubBackupObjectsDirectory(), `${imageId}${preview ? ".preview" : ""}.bin`);
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
  const preview = createEncryptedPreviewUpload(filePath, credentials.channelId, credentials.roomKey, imageId);
  return preview ? { ...preview, storagePath: githubPreviewPath(credentials, imageId) } : null;
}

type EncryptedPreviewUpload = Omit<GithubPreviewUpload, "storagePath">;

function createEncryptedPreviewUpload(
  filePath: string,
  channelId: string,
  roomKey: string,
  imageId: string,
): EncryptedPreviewUpload | null {
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
    const key = decodeBase64Url(roomKey);
    const aad = Buffer.from(`${channelId}:${imageId}:${TRANSFER_PROTOCOL_VERSION}:preview`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return {
      encrypted,
      nonce: encodeBase64Url(nonce),
      sizeBytes: encrypted.length,
      mimeType: "image/jpeg",
      plainSize: plain.length,
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

function readGithubCredentialsBackup(): GithubTransferCredentials | null {
  try {
    const envelope = JSON.parse(fs.readFileSync(getGithubCredentialsBackupPath(), "utf8")) as {
      mode?: "encrypted" | "plain";
      value?: string;
    };
    if (!envelope.value) {
      return null;
    }
    const raw = envelope.mode === "encrypted" && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(envelope.value, "base64"))
      : envelope.value;
    const credentials = JSON.parse(raw) as TransferCredentials;
    return isGithubCredentials(credentials) ? credentials : null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
}

async function writeBufferAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = await fs.promises.open(temporaryPath, "wx", 0o600);
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function writeTransferCredentials(credentials: TransferCredentials): void {
  fs.mkdirSync(path.dirname(getTransferCredentialsPath()), { recursive: true });
  const raw = JSON.stringify(credentials);
  const envelope = safeStorage.isEncryptionAvailable()
    ? { mode: "encrypted" as const, value: safeStorage.encryptString(raw).toString("base64") }
    : { mode: "plain" as const, value: raw };
  writeJsonAtomically(getTransferCredentialsPath(), envelope);
}

function writeGithubCredentialsBackup(credentials: GithubTransferCredentials): void {
  const backupPath = getGithubCredentialsBackupPath();
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const raw = JSON.stringify(credentials);
  const envelope = safeStorage.isEncryptionAvailable()
    ? { mode: "encrypted" as const, value: safeStorage.encryptString(raw).toString("base64") }
    : { mode: "plain" as const, value: raw };
  writeJsonAtomically(backupPath, envelope);
}

async function ensureGithubBackupCredentials(
  credentials: CloudflareTransferCredentials,
): Promise<GithubTransferCredentials | null> {
  const saved = readGithubCredentialsBackup();
  if (saved && saved.channelId === credentials.channelId && saved.roomKey === credentials.roomKey) {
    githubBackupLastError = undefined;
    return saved;
  }
  if (!GITHUB_TRANSFER_OWNER || !GITHUB_TRANSFER_REPO) {
    githubBackupLastError = "未找到 GitHub 备用仓库配置";
    return null;
  }
  try {
    const token = await getGithubToken();
    const backup: GithubTransferCredentials = {
      mode: "github",
      channelId: credentials.channelId,
      roomKey: credentials.roomKey,
      createdAt: credentials.createdAt,
      githubOwner: GITHUB_TRANSFER_OWNER,
      githubRepo: GITHUB_TRANSFER_REPO,
      githubBranch: GITHUB_TRANSFER_BRANCH,
      githubToken: token,
    };
    writeGithubCredentialsBackup(backup);
    githubBackupLastError = undefined;
    return backup;
  } catch (error) {
    githubBackupLastError = transferErrorMessage(error);
    githubBackupReconciliationPending = true;
    return null;
  }
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

function readPendingGithubBackups(): PendingGithubBackup[] {
  try {
    const value = JSON.parse(fs.readFileSync(getGithubBackupQueuePath(), "utf8")) as unknown;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PendingGithubBackup => Boolean(
      item
      && typeof item === "object"
      && typeof (item as PendingGithubBackup).channelId === "string"
      && typeof (item as PendingGithubBackup).image?.id === "string"
      && typeof (item as PendingGithubBackup).hasPreview === "boolean",
    ));
  } catch {
    return [];
  }
}

function writePendingGithubBackups(queue: PendingGithubBackup[]): void {
  writeJsonAtomically(getGithubBackupQueuePath(), queue);
}

async function withGithubBackupQueueWrite<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = githubBackupQueueWritePromise;
  let release!: () => void;
  githubBackupQueueWritePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function enqueueGithubBackup(
  credentials: CloudflareTransferCredentials,
  image: RemoteImage,
  encrypted: Buffer,
  encryptedPreview?: Buffer,
  repair: { imageBlob?: boolean; previewBlob?: boolean } = {},
): Promise<void> {
  const hasPreview = Boolean(encryptedPreview && image.previewNonce);
  await withGithubBackupQueueWrite(async () => {
    const queue = readPendingGithubBackups();
    const existingIndex = queue.findIndex((item) => item.channelId === credentials.channelId && item.image.id === image.id);
    if (existingIndex >= 0) {
      const existing = queue[existingIndex];
      if (encrypted.length > 0) {
        await writeBufferAtomically(getGithubBackupObjectPath(image.id), encrypted);
      }
      if (hasPreview && encryptedPreview) {
        await writeBufferAtomically(getGithubBackupObjectPath(image.id, true), encryptedPreview);
      }
      queue[existingIndex] = {
        ...existing,
        image: { ...existing.image, ...image },
        hasImageBlob: existing.hasImageBlob !== false || encrypted.length > 0,
        hasPreview: existing.hasPreview || hasPreview,
        repairImageBlob: existing.repairImageBlob || repair.imageBlob || undefined,
        repairPreviewBlob: existing.repairPreviewBlob || repair.previewBlob || undefined,
        revision: randomUUID(),
        queuedAt: new Date().toISOString(),
      };
      writePendingGithubBackups(queue);
      return;
    }

    if (encrypted.length > 0) {
      await writeBufferAtomically(getGithubBackupObjectPath(image.id), encrypted);
    }
    if (hasPreview && encryptedPreview) {
      await writeBufferAtomically(getGithubBackupObjectPath(image.id, true), encryptedPreview);
    }
    writePendingGithubBackups([
      ...queue,
      {
        channelId: credentials.channelId,
        image,
        hasImageBlob: encrypted.length > 0,
        hasPreview,
        revision: randomUUID(),
        ...(repair.imageBlob ? { repairImageBlob: true } : {}),
        ...(repair.previewBlob ? { repairPreviewBlob: true } : {}),
        queuedAt: new Date().toISOString(),
      },
    ]);
  });
  githubBackupLastError = undefined;
}

async function enqueueGithubBackupFromServer(
  credentials: CloudflareTransferCredentials,
  image: RemoteImage,
  repair: { imageBlob?: boolean; previewBlob?: boolean } = {},
): Promise<void> {
  const github = await ensureGithubBackupCredentials(credentials);
  if (!github) {
    return;
  }
  const manifest = await getGithubBackupManifest(github);
  const existing = manifest.images.find((item) => item.id === image.id);
  if (existing) {
    if ((existing.sha256 && existing.sha256 !== image.sha256)
      || (existing.plainSize !== undefined && existing.plainSize !== image.plainSize)) {
      throw new Error(`GitHub 备用照片 ${image.id} 与主服务器内容不一致`);
    }
    if (!repair.imageBlob && !repair.previewBlob && (!image.previewNonce || existing.previewNonce)) {
      return;
    }
  }
  const needsImageBlob = !existing || repair.imageBlob;
  const needsPreviewBlob = Boolean(image.previewNonce && (!existing?.previewNonce || repair.previewBlob));
  let encrypted = Buffer.alloc(0);
  if (needsImageBlob) {
    const encryptedResponse = await requestTransfer(
      `/v1/channel/${encodeURIComponent(credentials.channelId)}/images/${encodeURIComponent(image.id)}/content`,
      {},
      credentials.ownerToken,
      credentials.api,
    );
    encrypted = Buffer.from(await encryptedResponse.arrayBuffer());
  }
  let encryptedPreview: Buffer | undefined;
  if (needsPreviewBlob && image.previewNonce) {
    const previewResponse = await requestTransfer(
      `/v1/channel/${encodeURIComponent(credentials.channelId)}/images/${encodeURIComponent(image.id)}/preview`,
      {},
      credentials.ownerToken,
      credentials.api,
    );
    encryptedPreview = Buffer.from(await previewResponse.arrayBuffer());
  }
  const normalizedImage = existing
    ? { ...existing, ...image, storagePath: existing.storagePath }
    : image;
  await enqueueGithubBackup(credentials, normalizedImage, encrypted, encryptedPreview, repair);
}

async function getGithubBackupManifest(
  credentials: GithubTransferCredentials,
  refresh = false,
): Promise<GithubManifest> {
  const now = Date.now();
  if (
    !refresh
    && githubBackupManifestCache
    && githubBackupManifestCache.channelId === credentials.channelId
    && githubBackupManifestCache.expiresAt > now
  ) {
    return githubBackupManifestCache.manifest;
  }
  const manifest = await readGithubManifest(credentials);
  githubBackupManifestCache = {
    channelId: credentials.channelId,
    expiresAt: now + 15_000,
    manifest,
  };
  return manifest;
}

async function markGithubBackupFailure(item: PendingGithubBackup, error: unknown): Promise<void> {
  const lastError = transferErrorMessage(error);
  let marked = false;
  await withGithubBackupQueueWrite(() => {
    const queue = readPendingGithubBackups();
    const updated = queue.map((candidate) => (
      candidate.channelId === item.channelId
      && candidate.image.id === item.image.id
      && sameGithubBackupRevision(candidate, item)
        ? {
          ...candidate,
          attemptCount: (candidate.attemptCount ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError,
          revision: randomUUID(),
        }
        : candidate
    ));
    marked = updated.some((candidate, index) => candidate !== queue[index]);
    if (marked) {
      writePendingGithubBackups(updated);
    }
  });
  if (marked) {
    githubBackupLastError = lastError;
  }
}

function sameGithubBackupRevision(left: PendingGithubBackup, right: PendingGithubBackup): boolean {
  return left.revision
    ? left.revision === right.revision
    : !right.revision && left.queuedAt === right.queuedAt;
}

async function removePendingGithubBackup(item: PendingGithubBackup): Promise<boolean> {
  let removed = false;
  await withGithubBackupQueueWrite(async () => {
    const queue = readPendingGithubBackups();
    const matching = queue.some((candidate) => (
      candidate.channelId === item.channelId
      && candidate.image.id === item.image.id
      && sameGithubBackupRevision(candidate, item)
    ));
    if (!matching) {
      return;
    }
    const next = queue.filter((candidate) => (
      candidate.channelId !== item.channelId
      || candidate.image.id !== item.image.id
      || !sameGithubBackupRevision(candidate, item)
    ));
    writePendingGithubBackups(next);
    removed = true;
    for (const objectPath of [getGithubBackupObjectPath(item.image.id), getGithubBackupObjectPath(item.image.id, true)]) {
      await fs.promises.unlink(objectPath).catch(() => undefined);
    }
  });
  return removed;
}

async function uploadPendingGithubBackup(
  credentials: GithubTransferCredentials,
  item: PendingGithubBackup,
): Promise<boolean> {
  if (item.channelId !== credentials.channelId) {
    throw new Error("GitHub 备用通道与当前照片通道不匹配");
  }
  const payload = await withGithubBackupQueueWrite(async () => {
    const current = readPendingGithubBackups().find((candidate) => (
      candidate.channelId === item.channelId && candidate.image.id === item.image.id
    ));
    if (!current) {
      return null;
    }
    const encrypted = current.hasImageBlob === false
      ? Buffer.alloc(0)
      : await fs.promises.readFile(getGithubBackupObjectPath(current.image.id));
    let preview: GithubPreviewUpload | undefined;
    if (current.hasPreview && current.image.previewNonce) {
      const encryptedPreview = await fs.promises.readFile(getGithubBackupObjectPath(current.image.id, true));
      preview = {
        encrypted: encryptedPreview,
        nonce: current.image.previewNonce,
        sizeBytes: current.image.previewSizeBytes ?? encryptedPreview.length,
        mimeType: current.image.previewMimeType ?? "image/jpeg",
        plainSize: current.image.previewPlainSize ?? Math.max(0, encryptedPreview.length - 16),
        storagePath: githubPreviewPath(credentials, current.image.id),
      };
    }
    return { item: current, encrypted, preview };
  });
  if (!payload) {
    return false;
  }
  const { item: current, encrypted, preview } = payload;
  await uploadGithubImage(credentials, current.image, encrypted, preview, {
    restoreImageBlob: current.repairImageBlob,
    restorePreviewBlob: current.repairPreviewBlob,
  });
  githubBackupManifestCache = null;
  const removed = await removePendingGithubBackup(current);
  if (removed) {
    githubBackupLastError = undefined;
  }
  return removed;
}

async function reconcileGithubBackup(
  credentials: CloudflareTransferCredentials,
  github: GithubTransferCredentials,
): Promise<void> {
  const [serverImages, manifest, githubFiles] = await Promise.all([
    listRemoteImages(credentials),
    getGithubBackupManifest(github, true),
    listGithubFilePaths(github),
  ]);
  const githubImages = new Map(manifest.images.map((image) => [image.id, image]));
  const metadataRepairs: RemoteImage[] = [];
  for (const image of serverImages) {
    const existing = githubImages.get(image.id);
    if (!existing) {
      continue;
    }
    if ((existing.sha256 && existing.sha256 !== image.sha256)
      || (existing.plainSize !== undefined && existing.plainSize !== image.plainSize)) {
      throw new Error(`GitHub 备用照片 ${image.id} 与主服务器内容不一致`);
    }
    if (
      !existing.sha256
      || existing.plainSize === undefined
      || !existing.storagePath
      || existing.nonce !== image.nonce
      || existing.createdAt !== image.createdAt
      || existing.mimeType !== image.mimeType
    ) {
      const repaired = {
        ...existing,
        ...image,
        storagePath: existing.storagePath || githubImagePath(github, image.id),
      };
      metadataRepairs.push(repaired);
      githubImages.set(image.id, repaired);
    }
  }
  if (metadataRepairs.length > 0) {
    await updateGithubManifestImages(github, metadataRepairs, "Repair legacy photo metadata");
    githubBackupManifestCache = null;
  }
  const queuedIds = new Set(
    readPendingGithubBackups()
      .filter((item) => item.channelId === credentials.channelId)
      .map((item) => item.image.id),
  );
  for (const image of serverImages) {
    const existing = githubImages.get(image.id);
    const mainPath = existing?.storagePath || githubImagePath(github, image.id);
    const previewPath = existing?.previewStoragePath || githubPreviewPath(github, image.id);
    const repairImageBlob = Boolean(existing && (!githubFiles.has(mainPath) || existing.nonce !== image.nonce));
    const repairPreviewBlob = Boolean(image.previewNonce && existing?.previewNonce
      && (!githubFiles.has(previewPath) || existing.previewNonce !== image.previewNonce));
    const needsBackup = !existing || repairImageBlob || Boolean(image.previewNonce && !existing?.previewNonce) || repairPreviewBlob;
    if (!needsBackup || (queuedIds.has(image.id) && !repairImageBlob && !repairPreviewBlob)) {
      continue;
    }

    await enqueueGithubBackupFromServer(credentials, image, {
      imageBlob: !existing || repairImageBlob,
      previewBlob: Boolean(image.previewNonce && (!existing?.previewNonce || repairPreviewBlob)),
    });
    queuedIds.add(image.id);
    const queued = readPendingGithubBackups().find((item) => item.channelId === credentials.channelId && item.image.id === image.id);
    if (queued) {
      try {
        await uploadPendingGithubBackup(github, queued);
        githubFiles.add(githubImagePath(github, image.id));
        if (image.previewNonce) {
          githubFiles.add(githubPreviewPath(github, image.id));
        }
      } catch (error) {
        const current = readPendingGithubBackups().find((item) => item.channelId === queued.channelId && item.image.id === queued.image.id);
        await markGithubBackupFailure(current ?? queued, error);
        throw error;
      }
    }
  }
  githubBackupReconciliationPending = false;
  githubBackupReconciliationAttempts = 0;
  githubBackupLastError = undefined;
}

async function getGithubMigrationCredentials(
  legacy: CloudflareTransferCredentials,
): Promise<GithubTransferCredentials> {
  const sourceGithub = legacy.migrationSourceGithub;
  if (sourceGithub && sourceGithub.channelId === legacy.channelId && sourceGithub.roomKey === legacy.roomKey) {
    return sourceGithub;
  }

  const saved = readGithubCredentialsBackup();
  if (saved && saved.channelId === legacy.channelId && saved.roomKey === legacy.roomKey) {
    return saved;
  }

  if (!GITHUB_TRANSFER_OWNER || !GITHUB_TRANSFER_REPO) {
    throw new Error("GitHub 私有仓库尚未配置。请配置 GITHUB_TRANSFER_OWNER 和 GITHUB_TRANSFER_REPO；旧 ECS 照片仍保留，本机照片同步已暂停。");
  }

  const token = await getGithubToken();
  return {
    mode: "github",
    channelId: legacy.channelId,
    roomKey: legacy.roomKey,
    githubOwner: GITHUB_TRANSFER_OWNER,
    githubRepo: GITHUB_TRANSFER_REPO,
    githubBranch: GITHUB_TRANSFER_BRANCH,
    githubToken: token,
    createdAt: legacy.createdAt,
  };
}

async function verifyLegacyPhotosInGithub(
  legacyImages: RemoteImage[],
  github: GithubTransferCredentials,
): Promise<void> {
  const [manifest, githubFiles] = await Promise.all([
    readGithubManifest(github),
    listGithubFilePaths(github),
  ]);
  const images = new Map(manifest.images.map((image) => [image.id, image]));

  for (const legacyImage of legacyImages) {
    const image = images.get(legacyImage.id);
    if (!image || image.nonce !== legacyImage.nonce) {
      throw new Error(`旧 ECS 照片 ${legacyImage.id} 尚未完整迁移到 GitHub`);
    }
    if (
      (legacyImage.sha256 && image.sha256 !== legacyImage.sha256)
      || (legacyImage.plainSize !== undefined && image.plainSize !== legacyImage.plainSize)
    ) {
      throw new Error(`旧 ECS 照片 ${legacyImage.id} 的 GitHub 校验信息不一致`);
    }

    const imagePath = image.storagePath || githubImagePath(github, image.id);
    if (!githubFiles.has(imagePath)) {
      throw new Error(`旧 ECS 照片 ${legacyImage.id} 的 GitHub 原图文件缺失`);
    }

    if (legacyImage.previewNonce) {
      if (image.previewNonce !== legacyImage.previewNonce) {
        throw new Error(`旧 ECS 照片 ${legacyImage.id} 的 GitHub 预览图尚未完整迁移`);
      }
      const previewPath = image.previewStoragePath || githubPreviewPath(github, image.id);
      if (!githubFiles.has(previewPath)) {
        throw new Error(`旧 ECS 照片 ${legacyImage.id} 的 GitHub 预览文件缺失`);
      }
    }
  }
}

async function migrateLegacyTransferToGithubInternal(
  legacy: CloudflareTransferCredentials,
): Promise<GithubTransferCredentials> {
  const github = await getGithubMigrationCredentials(legacy);
  const oldApi = transferApiBaseUrl(legacy);
  if (!oldApi) {
    throw new Error("旧 ECS 收图服务地址不可用，无法核对旧照片；本机照片同步已暂停，旧云端照片未删除。");
  }

  // Read the legacy index once, then copy any missing encrypted objects to
  // GitHub. The old ECS is only read during this transition and is never used
  // for new uploads or pairing after the GitHub credentials are saved.
  remoteImagesCache = null;
  const legacyImages = await listRemoteImages(legacy, oldApi);
  // The existing backup queue resolves its target through the saved GitHub
  // credentials. Pin that target before draining it; the main credential is
  // still unchanged until the integrity check succeeds below.
  writeGithubCredentialsBackup(github);
  for (const item of readPendingGithubBackups().filter((entry) => entry.channelId === legacy.channelId)) {
    await uploadPendingGithubBackup(github, item);
  }
  await reconcileGithubBackup(legacy, github);
  await verifyLegacyPhotosInGithub(legacyImages, github);

  if (readPendingGithubBackups().some((item) => item.channelId === legacy.channelId)) {
    throw new Error("仍有旧照片等待写入 GitHub；迁移未完成，本机照片同步已暂停。");
  }

  // Switch the primary credential only after every old ECS image and its
  // preview has a matching GitHub manifest entry and object. Keep the legacy
  // ECS data untouched so a failed or interrupted transition cannot lose it.
  writeGithubCredentialsBackup(github);
  writeTransferCredentials(github);
  remoteImagesCache = null;
  githubBackupManifestCache = null;
  githubBackupReconciliationPending = false;
  githubBackupReconciliationAttempts = 0;
  githubBackupLastError = undefined;
  return github;
}

async function migrateLegacyTransferToGithub(
  legacy: CloudflareTransferCredentials,
): Promise<GithubTransferCredentials> {
  if (legacyGithubMigrationPromise) {
    return legacyGithubMigrationPromise;
  }
  const task = migrateLegacyTransferToGithubInternal(legacy);
  legacyGithubMigrationPromise = task;
  try {
    return await task;
  } finally {
    if (legacyGithubMigrationPromise === task) {
      legacyGithubMigrationPromise = null;
    }
  }
}

function pendingGithubBackupRetryDelayMs(): number {
  const queue = readPendingGithubBackups();
  const attempts = queue.length > 0
    ? Math.min(...queue.map((item) => Math.max(1, item.attemptCount ?? 1)))
    : Math.max(1, githubBackupReconciliationAttempts);
  return Math.min(PENDING_UPLOAD_RETRY_MAX_MS, PENDING_UPLOAD_RETRY_BASE_MS * (2 ** Math.min(5, attempts - 1)));
}

function clearGithubBackupRetryTimer(): void {
  if (pendingGithubBackupRetryTimer) {
    clearTimeout(pendingGithubBackupRetryTimer);
    pendingGithubBackupRetryTimer = null;
  }
  pendingGithubBackupRetryDueAt = 0;
}

function hasGithubBackupRetrySource(): boolean {
  const transfer = readTransferCredentials();
  if (!transfer || isGithubCredentials(transfer)) {
    return false;
  }
  const saved = readGithubCredentialsBackup();
  return Boolean(
    (saved && saved.channelId === transfer.channelId && saved.roomKey === transfer.roomKey)
    || (GITHUB_TRANSFER_OWNER && GITHUB_TRANSFER_REPO),
  );
}

function scheduleGithubBackupRetry(delayMs = pendingGithubBackupRetryDelayMs(), reconcile = false): void {
  if (isQuitting) {
    return;
  }
  if (reconcile) {
    githubBackupReconciliationPending = true;
  }
  if (readPendingGithubBackups().length === 0 && !githubBackupReconciliationPending) {
    clearGithubBackupRetryTimer();
    return;
  }
  if (!hasGithubBackupRetrySource()) {
    githubBackupReconciliationPending = false;
    clearGithubBackupRetryTimer();
    return;
  }
  const nextDueAt = Date.now() + Math.max(0, delayMs);
  if (pendingGithubBackupRetryTimer && pendingGithubBackupRetryDueAt <= nextDueAt) {
    return;
  }
  clearGithubBackupRetryTimer();
  pendingGithubBackupRetryDueAt = nextDueAt;
  pendingGithubBackupRetryTimer = setTimeout(() => {
    pendingGithubBackupRetryTimer = null;
    pendingGithubBackupRetryDueAt = 0;
    void retryPendingGithubBackups().catch((error) => {
      githubBackupLastError = transferErrorMessage(error);
      githubBackupReconciliationPending = true;
      githubBackupReconciliationAttempts += 1;
      scheduleGithubBackupRetry();
    });
  }, Math.max(0, delayMs));
}

async function retryPendingGithubBackups(forceReconcile = false): Promise<GithubBackupRetryResult> {
  if (forceReconcile) {
    githubBackupReconciliationPending = true;
  }
  if (pendingGithubBackupRetryPromise) {
    return pendingGithubBackupRetryPromise;
  }
  clearGithubBackupRetryTimer();

  const task = (async (): Promise<GithubBackupRetryResult> => {
    const transfer = readTransferCredentials();
    if (!transfer || isGithubCredentials(transfer)) {
      githubBackupReconciliationPending = false;
      return { sent: 0, failed: 0, remaining: readPendingGithubBackups().length };
    }
    const github = await ensureGithubBackupCredentials(transfer);
    if (!github) {
      const canRetryConfiguration = Boolean(GITHUB_TRANSFER_OWNER && GITHUB_TRANSFER_REPO);
      githubBackupReconciliationPending = canRetryConfiguration;
      if (canRetryConfiguration) {
        githubBackupReconciliationAttempts += 1;
      }
      const lastError = githubBackupLastError ?? "GitHub 备用通道尚未配置";
      return {
        sent: 0,
        failed: readPendingGithubBackups().length,
        remaining: readPendingGithubBackups().length,
        lastError,
      };
    }

    let sent = 0;
    let failed = 0;
    let lastError: string | undefined;
    const uploadQueue = async () => {
      for (const item of readPendingGithubBackups().filter((entry) => entry.channelId === transfer.channelId)) {
        try {
          if (await uploadPendingGithubBackup(github, item)) {
            sent += 1;
          }
        } catch (error) {
          const current = readPendingGithubBackups().find((candidate) => (
            candidate.channelId === item.channelId && candidate.image.id === item.image.id
          ));
          await markGithubBackupFailure(current ?? item, error);
          failed += 1;
          lastError = transferErrorMessage(error);
        }
      }
    };

    await uploadQueue();
    if (failed === 0 && githubBackupReconciliationPending) {
      try {
        await reconcileGithubBackup(transfer, github);
        await uploadQueue();
        if (failed > 0) {
          githubBackupReconciliationPending = true;
        }
      } catch (error) {
        githubBackupLastError = transferErrorMessage(error);
        githubBackupReconciliationPending = true;
        githubBackupReconciliationAttempts += 1;
        failed += 1;
        lastError = githubBackupLastError;
      }
    }

    return {
      sent,
      failed,
      remaining: readPendingGithubBackups().filter((item) => item.channelId === transfer.channelId).length,
      ...(lastError ? { lastError } : {}),
    };
  })();
  pendingGithubBackupRetryPromise = task;
  try {
    return await task;
  } finally {
    if (pendingGithubBackupRetryPromise === task) {
      pendingGithubBackupRetryPromise = null;
    }
    if (readPendingGithubBackups().length > 0 || githubBackupReconciliationPending) {
      scheduleGithubBackupRetry();
    }
  }
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
  details: { size: number; mtimeMs: number; sha256: string; mimeType: string; createdAt?: string; imageId?: string; nonce?: string },
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
    ...details,
    imageId: details.imageId ?? randomUUID(),
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

function isRetryableLocalUploadError(error: unknown): boolean {
  const message = transferErrorMessage(error);
  if (message === "照片仍在写入，稍后会自动重试" || message === "照片在校验时发生变化，稍后会自动重试") {
    return true;
  }
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EAGAIN" || code === "EINTR" || code === "EPERM" || code === "EACCES";
}

function enqueuePendingUploadPlaceholder(filePath: string): void {
  const normalizedPath = normalizeFilePath(filePath);
  const queue = readPendingUploads();
  if (queue.some((item) => normalizeFilePath(item.path) === normalizedPath)) {
    return;
  }
  writePendingUploads([...queue, { path: filePath, createdAt: new Date().toISOString() }]);
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
  configuredBaseUrl?: string,
): Promise<Response> {
  const baseUrl = (configuredBaseUrl || readTransferServerBootstrapConfig()?.api || TRANSFER_API_BASE_URL).replace(/\/+$/, "");
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
  configuredBaseUrl?: string,
): Promise<RemoteImage[]> {
  const baseUrl = transferApiBaseUrl(credentials) || configuredBaseUrl || "";
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

function createGithubPairingPayload(credentials: GithubTransferCredentials): string | null {
  const receiverToken = GITHUB_TRANSFER_READ_TOKEN;
  if (!receiverToken) {
    return null;
  }
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
      token: receiverToken,
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

function legacyMigrationBlockedState(
  credentials: CloudflareTransferCredentials,
  error: unknown,
): TransferChannelState {
  const reason = transferErrorMessage(error);
  return {
    status: "offline",
    backend: "github",
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
    lastError: `旧 ECS 照片迁移到 GitHub 尚未完成，已暂停照片上传；旧云端照片未删除。${reason}`,
  };
}

async function getTransferState(): Promise<TransferChannelState> {
  let credentials = readTransferCredentials();
  if (!credentials) {
    return unconfiguredTransferState("点击“创建通道”初始化 GitHub 私有中转。");
  }

  if (!isGithubCredentials(credentials)) {
    const legacyCredentials = credentials;
    try {
      credentials = await migrateLegacyTransferToGithub(credentials);
    } catch (error) {
      return legacyMigrationBlockedState(legacyCredentials, error);
    }
  }

  if (isGithubCredentials(credentials)) {
    const pairingPayload = createGithubPairingPayload(credentials);
    const missingReceiverToken = !pairingPayload;
    const receiverTokenError = "请配置 GITHUB_TRANSFER_READ_TOKEN（仅对该私有仓库授予 Contents 只读权限），重启桌面端后生成手机连接密钥。";
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
        pairingPayload,
        pairingPayloads: pairingPayload ? [pairingPayload] : [],
        pairingExpiresAt: null,
        paired: true,
        receiverCount: 0,
        maxReceivers: 2,
        receiverOnline: false,
        imageCount: images.length,
        ...(missingReceiverToken ? { lastError: receiverTokenError } : {}),
        ...pendingUploadFeedback(),
      };
    } catch (error) {
      return {
        status: "offline",
        backend: "github",
        channelId: credentials.channelId,
        pairingPayload,
        pairingPayloads: pairingPayload ? [pairingPayload] : [],
        pairingExpiresAt: null,
        paired: true,
        receiverCount: 0,
        maxReceivers: 2,
        receiverOnline: false,
        imageCount: remoteImagesCache?.images.length ?? 0,
        ...pendingUploadFeedback(),
        lastError: missingReceiverToken
          ? receiverTokenError
          : error instanceof Error ? error.message : "无法连接 GitHub 私有中转",
      };
    }
  }
  return unconfiguredTransferState("GitHub 私有照片通道尚未就绪。");
}

async function ensureTransferChannel(): Promise<TransferChannelState> {
  if (transferChannelSetupPromise) {
    return transferChannelSetupPromise;
  }
  const task = ensureTransferChannelInternal();
  transferChannelSetupPromise = task;
  try {
    return await task;
  } finally {
    if (transferChannelSetupPromise === task) {
      transferChannelSetupPromise = null;
    }
  }
}

async function ensureTransferChannelInternal(): Promise<TransferChannelState> {
  let credentials = readTransferCredentials();
  if (credentials && !isGithubCredentials(credentials)) {
    credentials = await migrateLegacyTransferToGithub(credentials);
  }

  if (!credentials) {
    if (!GITHUB_TRANSFER_OWNER || !GITHUB_TRANSFER_REPO) {
      throw new Error("请配置 GITHUB_TRANSFER_OWNER 和 GITHUB_TRANSFER_REPO，再创建 GitHub 私有收图通道。");
    }
    const token = await getGithubToken();
    const nextCredentials: GithubTransferCredentials = {
      mode: "github",
      channelId: randomUUID(),
      roomKey: encodeBase64Url(randomBytes(32)),
      githubOwner: GITHUB_TRANSFER_OWNER,
      githubRepo: GITHUB_TRANSFER_REPO,
      githubBranch: GITHUB_TRANSFER_BRANCH,
      githubToken: token,
      createdAt: new Date().toISOString(),
    };
    credentials = nextCredentials;
    writeTransferCredentials(nextCredentials);
    remoteImagesCache = null;
  }

  if (!isGithubCredentials(credentials)) {
    throw new Error("桌面照片通道只支持 GitHub 私有仓库。");
  }

  try {
    await repairGithubCaptureTimes(credentials);
    await repairGithubMissingImages(credentials);
  } catch (error) {
    // A metadata repair must not prevent the desktop from opening or
    // uploading new photos when GitHub is temporarily unavailable.
    console.warn("Unable to repair photo capture times", error);
  }

  const state = await getTransferState();
  scheduleGithubPreviewRepair(credentials);
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
  const github = isGithubCredentials(credentials)
    ? credentials
    : await migrateLegacyTransferToGithub(credentials);
  const nextCredentials: GithubTransferCredentials = {
    ...github,
    channelId: randomUUID(),
    roomKey: encodeBase64Url(randomBytes(32)),
    createdAt: new Date().toISOString(),
  };
  writeTransferCredentials(nextCredentials);
  writeGithubCredentialsBackup(nextCredentials);
  remoteImagesCache = null;
  const state = await getTransferState();
  scheduleGithubPreviewRepair(nextCredentials);
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

async function uploadSnapshotFileInternal(filePath: string): Promise<RemoteImage> {
  const mimeType = getImageMimeType(filePath);
  if (!mimeType) {
    throw new Error("只支持 PNG、JPG、JPEG、WEBP、GIF、HEIC 和 HEIF 图片");
  }

  const beforeRead = await fs.promises.stat(filePath);
  if (!beforeRead.isFile()) {
    throw new Error("照片路径不是文件");
  }
  const manifest = readUploadedFileManifest();
  const previous = manifest[normalizeFilePath(filePath)];
  let credentials = readTransferCredentials();
  if (credentials && !isGithubCredentials(credentials)) {
    credentials = await migrateLegacyTransferToGithub(credentials);
  }
  if (!isGithubCredentials(credentials)) {
    throw new Error("GitHub 私有照片通道尚未就绪，照片已保存在本机。");
  }

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
    let remoteImages: RemoteImage[];
    try {
      remoteImages = await listGithubImagesCached(credentials);
    } catch (error) {
      upsertPendingUpload(filePath, {
        size: afterStat.size,
        mtimeMs: afterStat.mtimeMs,
        sha256: previous.sha256,
        mimeType: previous.image.mimeType || mimeType,
        createdAt: previous.image.createdAt ?? getCaptureTimestamp(filePath, afterStat),
        imageId: previous.image.id,
        nonce: previous.image.nonce,
      });
      throw error;
    }
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
    return await uploadGithubSnapshotFile(credentials, filePath, plain, afterStat, mimeType, plainSha256, recoveredPending);
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
  return await uploadGithubSnapshotFile(credentials, filePath, plain, afterRead, mimeType, plainSha256, pending);
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
      let queued = markPendingUploadFailure(resolvedPath, error);
      if (!queued && isRetryableLocalUploadError(error)) {
        enqueuePendingUploadPlaceholder(resolvedPath);
        queued = markPendingUploadFailure(resolvedPath, error);
      }
      if (queued) {
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
  clearPendingUploadRetryTimer();

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
    const backupResult = await retryPendingGithubBackups(true);
    const remainingUploads = readPendingUploads().length;
    return {
      sent: sent + backupResult.sent,
      failed: failed + backupResult.failed,
      remaining: remainingUploads + backupResult.remaining,
      sentBackups: backupResult.sent,
      failedBackups: backupResult.failed,
      remainingBackups: backupResult.remaining,
      ...(lastError || backupResult.lastError ? { lastError: lastError ?? backupResult.lastError } : {}),
      ...(backupResult.lastError ? { lastBackupError: backupResult.lastError } : {}),
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
  if (!isGithubCredentials(credentials)) {
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
    // Legacy photo credentials are migrated on this first run so the phone keeps
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
  clearGithubBackupRetryTimer();
  if (backgroundStartupTimer) {
    clearTimeout(backgroundStartupTimer);
    backgroundStartupTimer = null;
  }
  stopSnapshotFolderSync();
  saveWindowState();
});
