import type { RemoteImage } from "./types";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "live-view-studio";
const GITHUB_MAX_REQUEST_ATTEMPTS = 4;
const GITHUB_READ_TIMEOUT_MS = 20_000;
const GITHUB_WRITE_TIMEOUT_MS = 60_000;
const GITHUB_MAX_RETRY_DELAY_MS = 15_000;
const GITHUB_MANIFEST_CONFLICT_ATTEMPTS = 5;

class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

// Every operation that can move a repository branch or rewrite a channel
// manifest must share this queue. Per-file upload de-duplication in main.ts is
// not enough because different photos still update the same manifest.json.
const githubWriteQueues = new Map<string, Promise<void>>();

export type GithubTransferCredentials = {
  mode: "github";
  channelId: string;
  roomKey: string;
  createdAt: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubToken: string;
};

type GithubFileMetadata = {
  sha: string;
  content?: string;
  encoding?: string;
};

export type GithubManifest = {
  version: 1;
  protocolVersion: string;
  channelId: string;
  updatedAt: string;
  images: RemoteImage[];
};

export type GithubPreviewUpload = {
  encrypted: Buffer;
  nonce: string;
  sizeBytes: number;
  mimeType: string;
  plainSize: number;
  storagePath: string;
};

function encodePath(pathname: string): string {
  return pathname.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function contentUrl(credentials: GithubTransferCredentials, filePath: string, includeBranch = true): string {
  const base = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(credentials.githubOwner)}/${encodeURIComponent(credentials.githubRepo)}/contents/${encodePath(filePath)}`;
  return includeBranch ? `${base}?ref=${encodeURIComponent(credentials.githubBranch)}` : base;
}

function repositoryUrl(credentials: GithubTransferCredentials, pathname: string): string {
  return `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(credentials.githubOwner)}/${encodeURIComponent(credentials.githubRepo)}/${pathname.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function githubHeaders(credentials: GithubTransferCredentials, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.githubToken}`,
    Accept: accept,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function repositoryWriteKey(credentials: GithubTransferCredentials): string {
  return [
    credentials.githubOwner.toLowerCase(),
    credentials.githubRepo.toLowerCase(),
    credentials.githubBranch,
  ].join("/");
}

async function withGithubWriteLock<T>(
  credentials: GithubTransferCredentials,
  operation: () => Promise<T>,
): Promise<T> {
  const key = repositoryWriteKey(credentials);
  const previous = githubWriteQueues.get(key) ?? Promise.resolve();
  const task = previous.then(operation, operation);
  const barrier = task.then(() => undefined, () => undefined);
  githubWriteQueues.set(key, barrier);
  try {
    return await task;
  } finally {
    if (githubWriteQueues.get(key) === barrier) {
      githubWriteQueues.delete(key);
    }
  }
}

function isRetryableGithubResponse(response: Response): boolean {
  if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
    return true;
  }
  return response.status === 403 && (
    response.headers.has("retry-after")
    || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

function githubRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(GITHUB_MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(GITHUB_MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
    }
  }

  if (response?.headers.get("x-ratelimit-remaining") === "0") {
    const resetAt = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(resetAt)) {
      return Math.min(GITHUB_MAX_RETRY_DELAY_MS, Math.max(0, resetAt * 1_000 - Date.now()));
    }
  }

  const exponential = 600 * (2 ** attempt);
  return Math.min(GITHUB_MAX_RETRY_DELAY_MS, exponential + Math.floor(Math.random() * 250));
}

async function fetchGithub(input: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  const method = (init.method ?? "GET").toUpperCase();
  const timeoutMs = method === "GET" || method === "HEAD"
    ? GITHUB_READ_TIMEOUT_MS
    : GITHUB_WRITE_TIMEOUT_MS;

  for (let attempt = 0; attempt < GITHUB_MAX_REQUEST_ATTEMPTS; attempt += 1) {
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
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (attempt < GITHUB_MAX_REQUEST_ATTEMPTS - 1 && isRetryableGithubResponse(response)) {
        const delayMs = githubRetryDelayMs(response, attempt);
        await response.body?.cancel().catch(() => undefined);
        await wait(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      if (init.signal?.aborted) {
        throw error;
      }
      lastError = timedOut
        ? new Error(`GitHub 请求超时（${Math.round(timeoutMs / 1_000)} 秒）`)
        : error;
      if (attempt < GITHUB_MAX_REQUEST_ATTEMPTS - 1) {
        await wait(githubRetryDelayMs(null, attempt));
      }
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "未知网络错误";
  throw new Error(`GitHub 网络连接失败：${detail}`);
}

async function readGithubError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string; documentation_url?: string };
    return body.message ?? `GitHub 返回 ${response.status}`;
  } catch {
    return `GitHub 返回 ${response.status}`;
  }
}

async function githubApiError(response: Response): Promise<GithubApiError> {
  return new GithubApiError(await readGithubError(response), response.status);
}

function isGithubWriteConflict(error: unknown): boolean {
  return error instanceof GithubApiError && (error.status === 409 || error.status === 422);
}

async function getFileMetadata(
  credentials: GithubTransferCredentials,
  filePath: string,
): Promise<GithubFileMetadata | null> {
  const response = await fetchGithub(contentUrl(credentials, filePath), {
    headers: githubHeaders(credentials),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await githubApiError(response);
  }
  return await response.json() as GithubFileMetadata;
}

async function readRawFile(
  credentials: GithubTransferCredentials,
  filePath: string,
): Promise<Buffer | null> {
  const response = await fetchGithub(contentUrl(credentials, filePath), {
    headers: githubHeaders(credentials, "application/vnd.github.raw+json"),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await githubApiError(response);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return bytes;
  }

  // GitHub may return the regular Contents API envelope if the raw media type
  // is ignored by a proxy. Decode that envelope so downloads remain robust.
  try {
    const envelope = JSON.parse(bytes.toString("utf8")) as GithubFileMetadata;
    if (envelope.content && envelope.encoding === "base64") {
      return Buffer.from(envelope.content.replace(/\s/g, ""), "base64");
    }
  } catch {
    // The raw body can still be JSON (the manifest), so return it as-is.
  }
  return bytes;
}

async function putFile(
  credentials: GithubTransferCredentials,
  filePath: string,
  content: Buffer,
  message: string,
  sha?: string,
): Promise<void> {
  const response = await fetchGithub(contentUrl(credentials, filePath, false), {
    method: "PUT",
    headers: {
      ...githubHeaders(credentials),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: content.toString("base64"),
      branch: credentials.githubBranch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!response.ok) {
    throw await githubApiError(response);
  }
}

async function githubJsonRequest<T>(
  credentials: GithubTransferCredentials,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchGithub(repositoryUrl(credentials, pathname), {
    ...init,
    headers: {
      ...githubHeaders(credentials),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw await githubApiError(response);
  }
  return await response.json() as T;
}

export function githubManifestPath(credentials: GithubTransferCredentials): string {
  return `channels/${credentials.channelId}/manifest.json`;
}

export function githubImagePath(credentials: GithubTransferCredentials, imageId: string): string {
  return `channels/${credentials.channelId}/images/${imageId}.bin`;
}

export function githubPreviewPath(credentials: GithubTransferCredentials, imageId: string): string {
  return `channels/${credentials.channelId}/previews/${imageId}.jpg.bin`;
}

function emptyManifest(credentials: GithubTransferCredentials): GithubManifest {
  return {
    version: 1,
    protocolVersion: "1",
    channelId: credentials.channelId,
    updatedAt: new Date(0).toISOString(),
    images: [],
  };
}

function parseGithubManifest(credentials: GithubTransferCredentials, bytes: Buffer): GithubManifest {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<GithubManifest>;
    return {
      ...emptyManifest(credentials),
      ...parsed,
      channelId: credentials.channelId,
      images: Array.isArray(parsed.images) ? parsed.images : [],
    };
  } catch {
    throw new Error("GitHub 中转清单格式无效");
  }
}

type GithubManifestSnapshot = {
  manifest: GithubManifest;
  sha?: string;
};

async function readGithubManifestSnapshot(
  credentials: GithubTransferCredentials,
): Promise<GithubManifestSnapshot> {
  const filePath = githubManifestPath(credentials);
  const metadata = await getFileMetadata(credentials, filePath);
  if (!metadata) {
    return { manifest: emptyManifest(credentials) };
  }

  let bytes: Buffer | null = null;
  if (metadata.content && metadata.encoding === "base64") {
    bytes = Buffer.from(metadata.content.replace(/\s/g, ""), "base64");
  } else {
    // The Contents API omits inline content for larger files. The blob SHA is
    // still useful for compare-and-swap; a branch race will be retried below.
    bytes = await readRawFile(credentials, filePath);
  }
  if (!bytes) {
    return { manifest: emptyManifest(credentials) };
  }
  return { manifest: parseGithubManifest(credentials, bytes), sha: metadata.sha };
}

export async function readGithubManifest(credentials: GithubTransferCredentials): Promise<GithubManifest> {
  return (await readGithubManifestSnapshot(credentials)).manifest;
}

function sortedImages(images: RemoteImage[]): RemoteImage[] {
  return images.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function updateGithubManifest(
  credentials: GithubTransferCredentials,
  message: string,
  mutateImages: (images: RemoteImage[]) => RemoteImage[],
): Promise<GithubManifest> {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < GITHUB_MANIFEST_CONFLICT_ATTEMPTS; attempt += 1) {
    const snapshot = await readGithubManifestSnapshot(credentials);
    const nextImages = sortedImages(mutateImages(snapshot.manifest.images));
    if (JSON.stringify(nextImages) === JSON.stringify(snapshot.manifest.images)) {
      return snapshot.manifest;
    }
    const nextManifest: GithubManifest = {
      ...snapshot.manifest,
      version: 1,
      protocolVersion: "1",
      channelId: credentials.channelId,
      updatedAt: new Date().toISOString(),
      images: nextImages,
    };

    try {
      await putFile(
        credentials,
        githubManifestPath(credentials),
        Buffer.from(JSON.stringify(nextManifest, null, 2), "utf8"),
        message,
        snapshot.sha,
      );
      return nextManifest;
    } catch (error) {
      if (!isGithubWriteConflict(error) || attempt === GITHUB_MANIFEST_CONFLICT_ATTEMPTS - 1) {
        throw error;
      }
      lastConflict = error;
      await wait(githubRetryDelayMs(null, attempt));
    }
  }
  throw lastConflict instanceof Error ? lastConflict : new Error("GitHub 清单并发写入冲突");
}

async function ensureGithubFileContent(
  credentials: GithubTransferCredentials,
  filePath: string,
  content: Buffer,
  message: string,
  replaceExisting: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < GITHUB_MANIFEST_CONFLICT_ATTEMPTS; attempt += 1) {
    const metadata = await getFileMetadata(credentials, filePath);
    if (metadata) {
      const current = await readRawFile(credentials, filePath);
      if (current?.equals(content)) {
        return;
      }
      if (!replaceExisting) {
        throw new Error("GitHub 中转中已存在同名但内容不同的密文");
      }
    }

    try {
      await putFile(credentials, filePath, content, message, metadata?.sha);
      return;
    } catch (error) {
      // A timed-out request may actually have committed. Re-read before
      // reporting failure so an idempotent replay is recognized as success.
      try {
        const current = await readRawFile(credentials, filePath);
        if (current?.equals(content)) {
          return;
        }
      } catch {
        // Preserve the original write failure, which is more actionable.
      }
      if (!isGithubWriteConflict(error) || attempt === GITHUB_MANIFEST_CONFLICT_ATTEMPTS - 1) {
        throw error;
      }
      await wait(githubRetryDelayMs(null, attempt));
    }
  }
}

export async function listGithubImages(credentials: GithubTransferCredentials): Promise<RemoteImage[]> {
  const manifest = await readGithubManifest(credentials);
  return manifest.images
    .filter((image) => Boolean(image && image.id && image.nonce))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Update only the encrypted-photo manifest. The image blobs stay untouched,
 * so metadata repairs do not require downloading or re-encrypting photos.
 */
export async function updateGithubManifestImages(
  credentials: GithubTransferCredentials,
  images: RemoteImage[],
  message = "Update photo capture times",
): Promise<void> {
  await withGithubWriteLock(credentials, async () => {
    const requestedById = new Map(images.map((image) => [image.id, image]));
    await updateGithubManifest(credentials, message, (currentImages) => {
      const currentById = new Map(currentImages.map((image) => [image.id, image]));
      return [
        // Retain fields (notably preview metadata) added after the repair
        // caller read its older snapshot, while applying requested changes.
        ...images.map((image) => ({ ...currentById.get(image.id), ...image })),
        // Do not discard an image another process added after that snapshot.
        // Repairs update known records; they are not deletions.
        ...currentImages.filter((image) => !requestedById.has(image.id)),
      ];
    });
  });
}

export async function uploadGithubImage(
  credentials: GithubTransferCredentials,
  image: RemoteImage,
  encrypted: Buffer,
  preview?: GithubPreviewUpload,
): Promise<RemoteImage> {
  return await withGithubWriteLock(credentials, async () => {
    const manifest = await readGithubManifest(credentials);
    const existing = manifest.images.find((item) => item.id === image.id);
    const samePhoto = Boolean(
      existing
      && existing.sha256 === image.sha256
      && existing.plainSize === image.plainSize,
    );
    if (existing && !samePhoto) {
      throw new Error("GitHub 清单中相同照片编号对应了不同内容");
    }
    if (existing && samePhoto && (!preview || existing.previewNonce)) {
      return existing;
    }

    const imagePath = githubImagePath(credentials, image.id);
    if (!existing) {
      await ensureGithubFileContent(
        credentials,
        imagePath,
        encrypted,
        `Add encrypted image ${image.id}`,
        false,
      );
    }

    // Preview encryption uses a fresh nonce on a later retry. If a previous
    // attempt stored the blob but failed before the manifest commit, replace
    // that orphan blob so the nonce written below always decrypts its bytes.
    if (preview) {
      await ensureGithubFileContent(
        credentials,
        preview.storagePath,
        preview.encrypted,
        `Add encrypted preview ${image.id}`,
        true,
      );
    }

    const nextImage: RemoteImage = {
      ...(existing ?? image),
      ...image,
      storagePath: imagePath,
      ...(preview ? {
        previewSizeBytes: preview.sizeBytes,
        previewMimeType: preview.mimeType,
        previewNonce: preview.nonce,
        previewPlainSize: preview.plainSize,
        previewStoragePath: preview.storagePath,
      } : {}),
    };
    const savedManifest = await updateGithubManifest(
      credentials,
      existing ? `Add encrypted preview metadata ${image.id}` : `Update photo manifest ${image.id}`,
      (currentImages) => {
        const current = currentImages.find((item) => item.id === image.id);
        if (current && (current.sha256 !== image.sha256 || current.plainSize !== image.plainSize)) {
          throw new Error("GitHub 清单中相同照片编号对应了不同内容");
        }
        return [{ ...(current ?? {}), ...nextImage }, ...currentImages.filter((item) => item.id !== image.id)];
      },
    );
    return savedManifest.images.find((item) => item.id === image.id) ?? nextImage;
  });
}

type GithubBlobResponse = { sha: string };
type GithubRefResponse = { object: { sha: string } };
type GithubCommitResponse = { tree: { sha: string } };
type GithubTreeResponse = { sha: string };
type GithubCreatedCommitResponse = { sha: string };

/**
 * Upload several encrypted images with one Git commit. This is used for the
 * one-time legacy migration; normal new photos still use the simpler
 * idempotent Contents API path above.
 */
export async function uploadGithubImagesBatch(
  credentials: GithubTransferCredentials,
  entries: Array<{ image: RemoteImage; encrypted: Buffer }>,
): Promise<RemoteImage[]> {
  return await withGithubWriteLock(
    credentials,
    async () => await uploadGithubImagesBatchUnlocked(credentials, entries),
  );
}

async function uploadGithubImagesBatchUnlocked(
  credentials: GithubTransferCredentials,
  entries: Array<{ image: RemoteImage; encrypted: Buffer }>,
): Promise<RemoteImage[]> {
  const manifest = await readGithubManifest(credentials);
  const pending = entries.filter(({ image }) => {
    const existing = manifest.images.find((item) => item.id === image.id);
    return !(existing && existing.sha256 === image.sha256 && existing.plainSize === image.plainSize);
  });
  if (pending.length === 0) {
    return manifest.images;
  }

  const blobs = await Promise.all(pending.map(async ({ encrypted }) => await githubJsonRequest<GithubBlobResponse>(
    credentials,
    "git/blobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: encrypted.toString("base64"), encoding: "base64" }),
    },
  )));
  const nextImages = [...pending.map(({ image }) => ({ ...image, storagePath: githubImagePath(credentials, image.id) })), ...manifest.images]
    .filter((image, index, all) => all.findIndex((candidate) => candidate.id === image.id) === index)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const nextManifest: GithubManifest = {
    ...manifest,
    version: 1,
    protocolVersion: "1",
    channelId: credentials.channelId,
    updatedAt: new Date().toISOString(),
    images: nextImages,
  };
  const manifestBlob = await githubJsonRequest<GithubBlobResponse>(
    credentials,
    "git/blobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: Buffer.from(JSON.stringify(nextManifest, null, 2), "utf8").toString("base64"),
        encoding: "base64",
      }),
    },
  );
  const ref = await githubJsonRequest<GithubRefResponse>(
    credentials,
    `git/ref/heads/${credentials.githubBranch}`,
  );
  const commit = await githubJsonRequest<GithubCommitResponse>(
    credentials,
    `git/commits/${ref.object.sha}`,
  );
  const tree = await githubJsonRequest<GithubTreeResponse>(
    credentials,
    "git/trees",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: commit.tree.sha,
        tree: [
          ...pending.map(({ image }, index) => ({
            path: githubImagePath(credentials, image.id),
            mode: "100644",
            type: "blob",
            sha: blobs[index].sha,
          })),
          {
            path: githubManifestPath(credentials),
            mode: "100644",
            type: "blob",
            sha: manifestBlob.sha,
          },
        ],
      }),
    },
  );
  const createdCommit = await githubJsonRequest<GithubCreatedCommitResponse>(
    credentials,
    "git/commits",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Migrate encrypted photos ${pending.length}`,
        tree: tree.sha,
        parents: [ref.object.sha],
      }),
    },
  );
  await githubJsonRequest<Record<string, unknown>>(
    credentials,
    `git/refs/heads/${credentials.githubBranch}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: createdCommit.sha, force: false }),
    },
  );
  return nextImages;
}

/**
 * Backfill compressed encrypted previews for photos uploaded before preview
 * support. The preview blobs and manifest are committed together so the
 * phone never observes preview metadata before the corresponding blob exists.
 */
export async function uploadGithubPreviewsBatch(
  credentials: GithubTransferCredentials,
  entries: Array<{ image: RemoteImage; preview: GithubPreviewUpload }>,
): Promise<RemoteImage[]> {
  return await withGithubWriteLock(
    credentials,
    async () => await uploadGithubPreviewsBatchUnlocked(credentials, entries),
  );
}

async function uploadGithubPreviewsBatchUnlocked(
  credentials: GithubTransferCredentials,
  entries: Array<{ image: RemoteImage; preview: GithubPreviewUpload }>,
): Promise<RemoteImage[]> {
  const manifest = await readGithubManifest(credentials);
  const pending = entries.filter(({ image, preview }) => {
    const existing = manifest.images.find((item) => item.id === image.id);
    return Boolean(existing && !existing.previewNonce && preview.nonce);
  });
  if (pending.length === 0) {
    return manifest.images;
  }

  const blobs = await Promise.all(pending.map(async ({ preview }) => await githubJsonRequest<GithubBlobResponse>(
    credentials,
    "git/blobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: preview.encrypted.toString("base64"), encoding: "base64" }),
    },
  )));
  const previewsById = new Map(pending.map(({ image, preview }) => [image.id, preview]));
  const nextImages = manifest.images.map((image) => {
    const preview = previewsById.get(image.id);
    if (!preview) {
      return image;
    }
    return {
      ...image,
      previewSizeBytes: preview.sizeBytes,
      previewMimeType: preview.mimeType,
      previewNonce: preview.nonce,
      previewPlainSize: preview.plainSize,
      previewStoragePath: preview.storagePath,
    };
  });
  const nextManifest: GithubManifest = {
    ...manifest,
    version: 1,
    protocolVersion: "1",
    channelId: credentials.channelId,
    updatedAt: new Date().toISOString(),
    images: nextImages,
  };
  const manifestBlob = await githubJsonRequest<GithubBlobResponse>(
    credentials,
    "git/blobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: Buffer.from(JSON.stringify(nextManifest, null, 2), "utf8").toString("base64"),
        encoding: "base64",
      }),
    },
  );
  const ref = await githubJsonRequest<GithubRefResponse>(credentials, `git/ref/heads/${credentials.githubBranch}`);
  const commit = await githubJsonRequest<GithubCommitResponse>(credentials, `git/commits/${ref.object.sha}`);
  const tree = await githubJsonRequest<GithubTreeResponse>(
    credentials,
    "git/trees",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: commit.tree.sha,
        tree: [
          ...pending.map(({ preview }, index) => ({
            path: preview.storagePath,
            mode: "100644",
            type: "blob",
            sha: blobs[index].sha,
          })),
          {
            path: githubManifestPath(credentials),
            mode: "100644",
            type: "blob",
            sha: manifestBlob.sha,
          },
        ],
      }),
    },
  );
  const createdCommit = await githubJsonRequest<GithubCreatedCommitResponse>(
    credentials,
    "git/commits",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add encrypted photo previews ${pending.length}`,
        tree: tree.sha,
        parents: [ref.object.sha],
      }),
    },
  );
  await githubJsonRequest<Record<string, unknown>>(
    credentials,
    `git/refs/heads/${credentials.githubBranch}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: createdCommit.sha, force: false }),
    },
  );
  return nextImages;
}

export async function downloadGithubImage(
  credentials: GithubTransferCredentials,
  image: RemoteImage,
): Promise<Buffer> {
  const bytes = await readRawFile(credentials, image.storagePath || githubImagePath(credentials, image.id));
  if (!bytes) {
    throw new Error("GitHub 中转中找不到这张照片");
  }
  return bytes;
}

export async function downloadGithubPreview(
  credentials: GithubTransferCredentials,
  image: RemoteImage,
): Promise<Buffer> {
  const bytes = await readRawFile(
    credentials,
    image.previewStoragePath || githubPreviewPath(credentials, image.id),
  );
  if (!bytes) {
    throw new Error("GitHub 中转中找不到这张照片的预览图");
  }
  return bytes;
}
