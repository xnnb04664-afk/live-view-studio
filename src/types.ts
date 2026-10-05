export type DisplayMode = "fit" | "fill";

export type MediaDeviceOption = {
  deviceId: string;
  label: string;
  kind: "videoinput" | "audioinput";
};

export type CaptureState = {
  cameraId: string | null;
  microphoneId: string | null;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  zoom: number;
  panX: number;
  panY: number;
  mirrored: boolean;
  displayMode: DisplayMode;
  freePan: boolean;
};

export type WindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

export type SnapshotResult = {
  path: string;
  directory: string;
};

export type TransferStatus = "unconfigured" | "offline" | "ready" | "paired";

export type RemoteImage = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  mimeType: string;
  nonce: string;
  plainSize?: number;
  sha256?: string;
  width?: number;
  height?: number;
  storagePath?: string;
  previewSizeBytes?: number;
  previewMimeType?: string;
  previewNonce?: string;
  previewPlainSize?: number;
  previewStoragePath?: string;
};

export type TransferChannelState = {
  status: TransferStatus;
  backend?: "cloudflare" | "github";
  channelId: string | null;
  pairingPayload: string | null;
  pairingPayloads: string[];
  pairingExpiresAt: string | null;
  paired: boolean;
  receiverCount: number;
  maxReceivers: number;
  receiverOnline: boolean;
  imageCount: number;
  pendingUploads: number;
  lastError?: string;
  lastUploadError?: string;
  retryScheduledAt?: string;
};

export type TransferRetryResult = {
  sent: number;
  failed: number;
  remaining: number;
  lastError?: string;
};

export type PrivacyTarget = "camera" | "microphone";

export type DesktopBridge = {
  window: {
    minimize: () => void;
    close: () => void;
    toggleMaximize: () => Promise<boolean>;
    setFullscreen: (enabled: boolean) => Promise<boolean>;
    setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
    getState: () => Promise<{ isFullscreen: boolean; isMaximized: boolean; isAlwaysOnTop: boolean }>;
  };
  getSnapshotDirectory: () => Promise<string>;
  chooseSnapshotDirectory: () => Promise<string | null>;
  resetSnapshotDirectory: () => Promise<string>;
  saveSnapshot: (dataUrl: string) => Promise<SnapshotResult>;
  openSnapshotFolder: () => Promise<void>;
  openPrivacySettings: (target: PrivacyTarget) => Promise<void>;
  transfer: {
    getState: () => Promise<TransferChannelState>;
    ensureChannel: () => Promise<TransferChannelState>;
    resetPairing: () => Promise<TransferChannelState>;
    uploadSnapshot: (path: string) => Promise<RemoteImage>;
    retryPendingUploads: () => Promise<TransferRetryResult>;
  };
};

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
