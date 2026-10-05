import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CaptureState, DisplayMode, MediaDeviceOption, TransferChannelState } from "../types";
import { type AppLanguage, readAppLanguage, setAppLanguage as persistAppLanguage, t } from "./i18n";

type IconName =
  | "camera"
  | "cameraOff"
  | "mic"
  | "micOff"
  | "chevronDown"
  | "maximize"
  | "minimize"
  | "square"
  | "close"
  | "pin"
  | "fullscreen"
  | "panel"
  | "mirror"
  | "zoomIn"
  | "rotate"
  | "shutter"
  | "folder"
  | "shield"
  | "alert"
  | "move"
  | "monitor"
  | "settings"
  | "check"
  | "refresh"
  | "phone"
  | "cloud"
  | "lock"
  | "link"
  | "unlink"
  | "copy";

const STORAGE_KEY = "live-view-studio:capture-state";
const DEFAULT_CAPTURE_STATE: CaptureState = {
  cameraId: null,
  microphoneId: null,
  cameraEnabled: true,
  microphoneEnabled: true,
  zoom: 1,
  panX: 0,
  panY: 0,
  mirrored: false,
  displayMode: "fill",
  freePan: false,
};

const MAX_ZOOM = 4;
const MIN_ZOOM = 0.5;
const CONTROL_DOCK_STORAGE_KEY = "live-view-studio:control-dock";
const DEFAULT_DOCK_HEIGHT = 230;
const MIN_DOCK_HEIGHT = 150;
const MAX_DOCK_HEIGHT = 420;
const MIN_DOCK_BUTTON_SCALE = 0.75;
const MAX_DOCK_BUTTON_SCALE = 1.4;
const DEFAULT_DOCK_BUTTON_SCALE = 1;
const CAPTURE_ENDED_RECOVERY_DELAY_MS = 800;
const CAPTURE_HEALTH_CHECK_INTERVAL_MS = 2_000;
const CAPTURE_UNHEALTHY_GRACE_MS = 4_000;

type DockPosition = "bottom" | "top" | "left" | "right";
type DockButtonId = "reset" | "fullscreen" | "alwaysOnTop" | "refresh" | "camera" | "microphone" | "mirror" | "folder";
type ButtonSizeId = DockButtonId | "shutter" | "zoom" | "dockToggle" | "settings";

const DOCK_BUTTON_OPTIONS: Array<{ id: DockButtonId; label: string; icon: IconName }> = [
  { id: "reset", label: t("复位取景"), icon: "rotate" },
  { id: "fullscreen", label: t("全屏查看"), icon: "fullscreen" },
  { id: "alwaysOnTop", label: t("窗口置顶"), icon: "pin" },
  { id: "refresh", label: t("刷新设备"), icon: "refresh" },
  { id: "camera", label: t("摄像头开关"), icon: "camera" },
  { id: "microphone", label: t("麦克风开关"), icon: "mic" },
  { id: "mirror", label: t("左右翻转"), icon: "mirror" },
  { id: "folder", label: t("打开照片目录"), icon: "folder" },
];
const DEFAULT_DOCK_BUTTONS: DockButtonId[] = ["reset", "fullscreen", "alwaysOnTop"];
const DOCK_BUTTON_IDS = new Set<DockButtonId>(DOCK_BUTTON_OPTIONS.map((option) => option.id));
const BUTTON_SIZE_OPTIONS: Array<{ id: ButtonSizeId; label: string }> = [
  { id: "shutter", label: t("拍照按钮") },
  { id: "zoom", label: t("缩放加减按钮") },
  ...DOCK_BUTTON_OPTIONS.map(({ id, label }) => ({ id, label })),
  { id: "dockToggle", label: t("收起/展开按钮") },
  { id: "settings", label: t("设置按钮") },
];

function getPanLimit(zoom: number): number {
  return Math.abs(zoom - 1) * 50;
}

function getZoomProgress(zoom: number): string {
  const progress = ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;
  return `${Math.min(Math.max(progress, 0), 100)}%`;
}

type MediaIssue = {
  target: "camera" | "microphone";
  title: string;
  detail: string;
  permissionDenied: boolean;
};

type CaptureTrackResult = {
  track: MediaStreamTrack | null;
  issue?: MediaIssue;
};

type CaptureResult = {
  stream: MediaStream;
  issues: MediaIssue[];
  startMicrophone: () => Promise<CaptureTrackResult>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readStoredCaptureState(): CaptureState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<CaptureState> | null;
    return {
      ...DEFAULT_CAPTURE_STATE,
      ...stored,
      zoom: clamp(Number(stored?.zoom ?? DEFAULT_CAPTURE_STATE.zoom), MIN_ZOOM, MAX_ZOOM),
      panX: Number(stored?.panX ?? 0),
      panY: Number(stored?.panY ?? 0),
      mirrored: stored?.mirrored === true,
      displayMode: stored?.displayMode === "fit" ? "fit" : "fill",
      freePan: stored?.freePan === true,
    };
  } catch {
    return DEFAULT_CAPTURE_STATE;
  }
}

type ControlDockSettings = {
  height: number | null;
  collapsed: boolean;
  position: DockPosition;
  buttons: DockButtonId[];
  buttonScales: Record<ButtonSizeId, number>;
};

function readControlDockSettings(): ControlDockSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(CONTROL_DOCK_STORAGE_KEY) ?? "null") as Partial<ControlDockSettings> | null;
    const rawHeight = Number(stored?.height);
    const legacyButtonScale = Number((stored as Partial<ControlDockSettings> & { buttonScale?: number } | null)?.buttonScale);
    const storedPosition = stored?.position;
    const storedButtons = Array.isArray(stored?.buttons)
      ? stored.buttons.filter((button): button is DockButtonId => DOCK_BUTTON_IDS.has(button))
      : DEFAULT_DOCK_BUTTONS;
    const storedScales = (stored as Partial<ControlDockSettings> | null)?.buttonScales;
    const fallbackScale = Number.isFinite(legacyButtonScale) ? clamp(legacyButtonScale, MIN_DOCK_BUTTON_SCALE, MAX_DOCK_BUTTON_SCALE) : DEFAULT_DOCK_BUTTON_SCALE;
    const buttonScales = BUTTON_SIZE_OPTIONS.reduce((scales, option) => {
      const rawScale = Number(storedScales?.[option.id]);
      scales[option.id] = Number.isFinite(rawScale) ? clamp(rawScale, MIN_DOCK_BUTTON_SCALE, MAX_DOCK_BUTTON_SCALE) : fallbackScale;
      return scales;
    }, {} as Record<ButtonSizeId, number>);
    return {
      height: Number.isFinite(rawHeight) ? clamp(rawHeight, MIN_DOCK_HEIGHT, MAX_DOCK_HEIGHT) : null,
      collapsed: stored?.collapsed === true,
      position: storedPosition === "top" || storedPosition === "left" || storedPosition === "right" ? storedPosition : "bottom",
      buttons: storedButtons,
      buttonScales,
    };
  } catch {
    return {
      height: null,
      collapsed: false,
      position: "bottom",
      buttons: DEFAULT_DOCK_BUTTONS,
      buttonScales: BUTTON_SIZE_OPTIONS.reduce((scales, option) => ({ ...scales, [option.id]: DEFAULT_DOCK_BUTTON_SCALE }), {} as Record<ButtonSizeId, number>),
    };
  }
}

function getErrorMessage(error: unknown): { title: string; detail: string; permissionDenied: boolean } {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: t("设备权限被拒绝"),
      detail: t("请在 Windows 设置中允许“取景台”使用摄像头和麦克风。"),
      permissionDenied: true,
    };
  }
  if (name === "NotFoundError") {
    return {
      title: t("没有找到设备"),
      detail: t("请连接摄像头或麦克风后点击重试。"),
      permissionDenied: false,
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: t("设备正在被占用"),
      detail: t("请关闭其他正在使用此设备的软件，然后重试。"),
      permissionDenied: false,
    };
  }
  if (name === "OverconstrainedError") {
    return {
      title: t("设备参数不可用"),
      detail: t("当前设备不支持请求的画面参数，正在尝试使用默认参数。"),
      permissionDenied: false,
    };
  }
  return {
    title: t("设备启动失败"),
    detail: t("无法启动这个设备，请检查连接后重试。"),
    permissionDenied: false,
  };
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "camera":
      return <svg {...common}><path d="M14.5 5.5 16 8h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3l1.5-2.5h5Z" /><circle cx="12" cy="13.5" r="3.5" /></svg>;
    case "cameraOff":
      return <svg {...common}><path d="m3 3 18 18" /><path d="M14.5 5.5 16 8h3a2 2 0 0 1 2 2v4.5M8 8H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12" /><path d="M9.2 5.5h2.6M9 13.5a3.5 3.5 0 0 0 5.8 2.6" /></svg>;
    case "mic":
      return <svg {...common}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></svg>;
    case "micOff":
      return <svg {...common}><path d="m3 3 18 18M9 9v4a3 3 0 0 0 5.7 1.3M15 9V6a3 3 0 0 0-5.8-1M5.5 11a6.5 6.5 0 0 0 10.3 5.3M12 17.5V21M8.5 21h7" /></svg>;
    case "chevronDown":
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case "maximize":
      return <svg {...common}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>;
    case "minimize":
      return <svg {...common}><path d="M5 12h14" /></svg>;
    case "square":
      return <svg {...common}><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>;
    case "close":
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case "pin":
      return <svg {...common}><path d="m14 4 6 6-3 1-3 5-2 2-1-4-5-3-1-3 5-3 1-3Z" /><path d="m12 17-3 4" /></svg>;
    case "fullscreen":
      return <svg {...common}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>;
    case "panel":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M7 8h4M7 12h4M7 16h4" /></svg>;
    case "mirror":
      return <svg {...common}><path d="M12 3v18M8 7l-3 5 3 5M16 7l3 5-3 5M3 4h4M17 4h4M3 20h4M17 20h4" /></svg>;
    case "zoomIn":
      return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5M10.5 7.5v6M7.5 10.5h6" /></svg>;
    case "rotate":
      return <svg {...common}><path d="M4 10a8 8 0 0 1 13.7-5.6L20 6.7M20 4v4h-4M20 14a8 8 0 0 1-13.7 5.6L4 17.3M4 20v-4h4" /></svg>;
    case "shutter":
      return <svg {...common}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="5.8" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></svg>;
    case "folder":
      return <svg {...common}><path d="M3.5 7.5h6l1.7 2h9.3v8.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-8.3a2 2 0 0 1 2-2Z" /><path d="M3.5 7.5v-2h5l1.7 2" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3.5 19 6v5.3c0 4.5-3 7.6-7 9.2-4-1.6-7-4.7-7-9.2V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "alert":
      return <svg {...common}><path d="m12 3 9 16H3L12 3Z" /><path d="M12 9v4M12 16h.01" /></svg>;
    case "move":
      return <svg {...common}><path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></svg>;
    case "monitor":
      return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
    case "settings":
      return <svg {...common}><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1-1.7 3-2.1-.8a8 8 0 0 1-1.8 1l-.4 2.2H10l-.4-2.2a8 8 0 0 1-1.8-1l-2.1.8-1.7-3 .1-.1 1.7-1.3a7.6 7.6 0 0 1 0-2.1L4 10.3l1.7-3 2.1.8a8 8 0 0 1 1.8-1L10 4.8h3.5l.4 2.2a8 8 0 0 1 1.8 1l2.1-.8 1.7 3-1.7 1.3a7.6 7.6 0 0 1 0 2.1l1.6 1.4Z" /></svg>;
    case "check":
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 11a8 8 0 0 0-14.8-4L3 9M3 4v5h5M4 13a8 8 0 0 0 14.8 4L21 15M21 20v-5h-5" /></svg>;
    case "phone":
      return <svg {...common}><rect x="7" y="2.8" width="10" height="18.4" rx="2" /><path d="M10 5.5h4M11 18.2h2" /></svg>;
    case "cloud":
      return <svg {...common}><path d="M7.5 18.5h9a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 6.4 9.4 4 4 0 0 0 7.5 18.5Z" /></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></svg>;
    case "link":
      return <svg {...common}><path d="m10 13.8-1.5 1.5a3.2 3.2 0 0 1-4.5-4.5l2.5-2.5a3.2 3.2 0 0 1 4.5 0" /><path d="m14 10.2 1.5-1.5a3.2 3.2 0 0 1 4.5 4.5l-2.5 2.5a3.2 3.2 0 0 1-4.5 0" /><path d="m8.5 15.5 7-7" /></svg>;
    case "unlink":
      return <svg {...common}><path d="m9.5 14.5-1 1a3.2 3.2 0 0 1-4.5-4.5l2-2M14.5 9.5l1-1a3.2 3.2 0 0 1 4.5 4.5l-2 2M8 16l8-8M3 3l18 18" /></svg>;
    case "copy":
      return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="1.5" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>;
  }
}

function DeviceSelect({
  label,
  value,
  options,
  icon,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: MediaDeviceOption[];
  icon: IconName;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="device-field">
      <span className="field-label"><Icon name={icon} size={15} />{t(label)}</span>
      <span className="select-wrap">
        <select value={value} disabled={disabled || options.length === 0} onChange={(event) => onChange(event.target.value)}>
          {options.length === 0 ? <option value="">{t("未检测到设备")}</option> : null}
          {options.map((option, index) => (
            <option key={option.deviceId} value={option.deviceId}>
              {option.label || `${label} ${index + 1}`}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={15} />
      </span>
    </label>
  );
}

function ToggleRow({
  label,
  detail,
  enabled,
  icon,
  onToggle,
}: {
  label: string;
  detail: string;
  enabled: boolean;
  icon: IconName;
  onToggle: () => void;
}) {
  return (
    <button className={`toggle-row ${enabled ? "is-enabled" : "is-disabled"}`} onClick={onToggle} type="button">
      <span className="toggle-icon"><Icon name={icon} size={17} /></span>
      <span className="toggle-copy"><strong>{t(label)}</strong><small>{t(detail)}</small></span>
      <span className="toggle-state"><span className="toggle-dot" />{enabled ? t("开启") : t("关闭")}</span>
    </button>
  );
}

function TransferDialog({
  state,
  isLoading,
  onClose,
  onEnsure,
  onReset,
  onRetry,
  onRefresh,
}: {
  state: TransferChannelState | null;
  isLoading: boolean;
  onClose: () => void;
  onEnsure: () => void;
  onReset: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const [copiedKeyIndex, setCopiedKeyIndex] = useState<number | null>(null);
  const pairingPayloads = state?.pairingPayloads ?? (state?.pairingPayload ? [state.pairingPayload] : []);
  const hasPairingKeys = pairingPayloads.length > 0;
  const isGithub = state?.backend === "github";

  const copyPairingKey = useCallback(async (payload: string, index: number) => {
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = payload;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopiedKeyIndex(index);
    window.setTimeout(() => setCopiedKeyIndex(null), 1800);
  }, []);

  const statusLabel = isGithub
    ? t("GitHub 私有中转已就绪")
    : hasPairingKeys
    ? state?.receiverCount
      ? t(`已绑定 ${state.receiverCount} 台手机，还可绑定 ${pairingPayloads.length} 台`)
      : t("等待手机绑定")
    : state?.status === "offline"
      ? t("中转服务离线")
      : state?.status === "paired"
        ? t(`已绑定 ${state.receiverCount} 台手机`)
        : state?.status === "ready"
          ? t("等待手机填写密钥")
          : t("尚未创建通道");

  return (
    <div className="transfer-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
        <header className="transfer-header">
          <div>
            <div className="eyebrow">PRIVATE LINK / MOBILE</div>
            <h2 id="transfer-title">{t("手机收图")}</h2>
            <p>{t("这是一条只给你的私有通道，照片会先加密，再写入你的 GitHub 私有仓库。")}</p>
          </div>
          <button className="settings-close" type="button" onClick={onClose} aria-label={t("关闭手机收图")}><Icon name="close" size={18} /></button>
        </header>

        <div className="transfer-body">
          <div className={`transfer-state transfer-state-${state?.status ?? "loading"}`}>
            <span className="transfer-state-icon"><Icon name={hasPairingKeys ? "link" : state?.status === "paired" ? "phone" : state?.status === "offline" ? "alert" : "link"} size={20} /></span>
            <div>
              <strong>{isLoading && !state ? t("正在检查通道") : t(statusLabel)}</strong>
              <span>
                {isGithub
                  ? t("把同一条密钥粘贴到手机端；手机会自动从私有仓库同步照片")
                  : hasPairingKeys
                  ? t("复制对应密钥到手机；每条密钥只能绑定一台手机")
                  : state?.status === "paired"
                    ? state.receiverOnline ? t("至少一台手机在线，下一张照片会自动送达") : t("手机已绑定，等待它上线")
                  : state?.status === "offline"
                    ? state.lastError ?? t("请检查网络或服务地址")
                    : t("复制连接密钥到手机，配对只需一次，之后会自动恢复连接")}
              </span>
            </div>
            <button className="transfer-refresh" type="button" onClick={onRefresh} aria-label={t("刷新通道状态")} title={t("刷新状态")}><Icon name="refresh" size={15} /></button>
          </div>

          {!state || state.status === "unconfigured" ? (
            <div className="transfer-empty">
              <div className="transfer-empty-mark"><Icon name="cloud" size={26} /></div>
              <strong>{t("创建你的私有收图通道")}</strong>
              <p>{t("创建后会生成一条连接密钥。桌面端会自动同步 D:\\照片传送 中的照片，GitHub 只保存密文。")}</p>
              <button className="transfer-primary" type="button" onClick={onEnsure} disabled={isLoading}>{t("创建通道")}</button>
            </div>
          ) : pairingPayloads.length > 0 ? (
            <div className="transfer-pairing">
              <div className="transfer-pairing-copy">
                <div className="transfer-step"><span>01</span><div><strong>{t("打开手机端收图")}</strong><small>{isGithub ? t("两台手机可以使用同一条连接密钥") : t("手机使用下面对应的连接密钥")}</small></div></div>
                {pairingPayloads.map((payload, index) => {
                  const phoneNumber = (state?.receiverCount ?? 0) + index + 1;
                  return (
                    <div className="transfer-key-block" key={payload}>
                      <label className="transfer-key-field">
                        <span>{isGithub ? t("GitHub 私有中转连接密钥") : t(`手机 ${phoneNumber} 连接密钥`)}</span>
                        <textarea value={payload} readOnly rows={6} onFocus={(event) => event.currentTarget.select()} aria-label={isGithub ? t("GitHub 私有中转连接密钥") : t(`手机 ${phoneNumber} 收图连接密钥`)} />
                      </label>
                      <button className="transfer-key-copy" type="button" onClick={() => void copyPairingKey(payload, index)}>
                        <Icon name={copiedKeyIndex === index ? "check" : "copy"} size={15} />
                        {copiedKeyIndex === index ? t("已复制连接密钥") : isGithub ? t("复制 GitHub 连接密钥") : t(`复制手机 ${phoneNumber} 密钥`)}
                      </button>
                    </div>
                  );
                })}
                <div className="transfer-step"><span>02</span><div><strong>{t("在手机端点击绑定")}</strong><small>{isGithub ? t("之后打开应用会自动轮询私有仓库") : t("每条密钥只使用一次，过期后可刷新")}</small></div></div>
                <div className="transfer-security"><Icon name="lock" size={15} /><span>{t("AES-256-GCM 端到端加密")}</span></div>
              </div>
            </div>
          ) : (
            <div className="transfer-paired">
              <div className="transfer-paired-orbit"><Icon name="phone" size={30} /></div>
              <strong>{t(`已绑定 ${state?.receiverCount ?? 0} 台手机`)}</strong>
              <span>{t("拍摄或放入 D:\\照片传送 的照片会自动上传，手机会从 GitHub 私有仓库同步，确认后再保存到相册。")}</span>
              <div className="transfer-paired-meta"><span>{t("已收照片")}</span><strong>{state?.imageCount ?? 0}</strong></div>
            </div>
          )}

          {state?.pendingUploads ? (
            <div className="transfer-pending"><span><Icon name="alert" size={15} />{state.pendingUploads} {t("张照片等待发送")}</span><button type="button" onClick={onRetry}>{t("重试发送")}</button></div>
          ) : null}
        </div>

        <footer className="transfer-footer">
          <span>{state?.channelId ? t(`通道 ${state.channelId.slice(0, 8)}`) : t("未配置服务")}</span>
          <div>
            {state?.paired ? <button className="transfer-danger" type="button" onClick={onReset}><Icon name="unlink" size={14} />{t("重新生成连接密钥")}</button> : null}
            <button type="button" onClick={onClose}>{t("完成")}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export default function App() {
  const [language, setLanguage] = useState<AppLanguage>(() => {
    const savedLanguage = readAppLanguage();
    persistAppLanguage(savedLanguage);
    return savedLanguage;
  });
  const [capture, setCapture] = useState<CaptureState>(() => readStoredCaptureState());
  const captureRef = useRef(capture);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [microphoneTrack, setMicrophoneTrack] = useState<MediaStreamTrack | null>(null);
  const [devices, setDevices] = useState<MediaDeviceOption[]>([]);
  const [issues, setIssues] = useState<MediaIssue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<{ title: string; detail?: string; tone?: "success" | "warning" } | null>(null);
  const [isFlashVisible, setIsFlashVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [transferState, setTransferState] = useState<TransferChannelState | null>(null);
  const [isTransferLoading, setIsTransferLoading] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dockSettings, setDockSettings] = useState<ControlDockSettings>(() => readControlDockSettings());
  const [isDockResizing, setIsDockResizing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dockPanelRef = useRef<HTMLElement>(null);
  const dragRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const dockResizeRef = useRef({ startX: 0, startY: 0, startSize: DEFAULT_DOCK_HEIGHT });
  const toastTimerRef = useRef<number | null>(null);
  const captureRequestIdRef = useRef(0);
  const captureRestartingRef = useRef(false);
  const captureRecoveryTimerRef = useRef<number | null>(null);
  const captureUnhealthySinceRef = useRef<number | null>(null);
  const hasHadLiveCameraRef = useRef(false);
  const captureRecoveryBlockedRef = useRef(false);
  const captureMountedRef = useRef(true);

  const cameraDevices = useMemo(() => devices.filter((device) => device.kind === "videoinput"), [devices]);
  const microphoneDevices = useMemo(() => devices.filter((device) => device.kind === "audioinput"), [devices]);
  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live" && !track.muted) && capture.cameraEnabled);
  const hasAudio = Boolean(microphoneTrack && microphoneTrack.readyState === "live" && !microphoneTrack.muted && capture.microphoneEnabled);
  const primaryIssue = issues[0];
  const zoomProgressStyle = { "--zoom-progress": getZoomProgress(capture.zoom) } as CSSProperties;

  const showToast = useCallback((title: string, detail?: string, tone: "success" | "warning" = "success") => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ title: t(title), detail: detail ? t(detail) : detail, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "en-US" ? "en" : "zh-CN";
    document.title = language === "en-US"
      ? "Live View Studio — Webcam Viewer for Windows"
      : t("取景台 · Live View Studio");
  }, [language]);

  const changeLanguage = (nextLanguage: AppLanguage) => {
    persistAppLanguage(nextLanguage);
    setLanguage(nextLanguage);
  };

  const refreshTransferState = useCallback(async () => {
    if (!window.desktop?.transfer) {
      return;
    }
    setIsTransferLoading(true);
    try {
      setTransferState(await window.desktop.transfer.getState());
    } catch (error) {
      showToast("手机收图状态读取失败", error instanceof Error ? error.message : t("无法读取通道状态"), "warning");
    } finally {
      setIsTransferLoading(false);
    }
  }, [showToast]);

  const openTransferDialog = useCallback(() => {
    setIsTransferOpen(true);
    void refreshTransferState();
  }, [refreshTransferState]);

  const ensureTransferChannel = useCallback(async () => {
    if (!window.desktop?.transfer) {
      return;
    }
    setIsTransferLoading(true);
    try {
      const state = await window.desktop.transfer.ensureChannel();
      setTransferState(state);
      if (state.status === "unconfigured") {
        showToast("手机收图服务尚未配置", state.lastError, "warning");
      } else if (state.backend === "github") {
        showToast("GitHub 私有中转已就绪", t("把连接密钥粘贴到手机端即可同步照片"));
      } else {
        showToast(state.paired ? t("手机收图已连接") : t("连接密钥已准备好"), state.paired ? t("下一张照片会自动发送") : t(`复制 ${state.pairingPayloads.length || 1} 条密钥到手机端填写`));
      }
    } catch (error) {
      showToast("手机收图通道创建失败", error instanceof Error ? error.message : t("无法创建通道"), "warning");
    } finally {
      setIsTransferLoading(false);
    }
  }, [showToast]);

  const resetTransferPairing = useCallback(async () => {
    if (!window.desktop?.transfer || !window.confirm(t("重新绑定会让当前连接密钥失效，并生成一条新的 GitHub 密钥，确定继续吗？"))) {
      return;
    }
    setIsTransferLoading(true);
    try {
      const state = await window.desktop.transfer.resetPairing();
      setTransferState(state);
      showToast("连接密钥已重置", t("请把新的 GitHub 密钥填入手机端"));
    } catch (error) {
      showToast("配对重置失败", error instanceof Error ? error.message : t("无法重置配对"), "warning");
    } finally {
      setIsTransferLoading(false);
    }
  }, [showToast]);

  const retryTransferUploads = useCallback(async () => {
    if (!window.desktop?.transfer) {
      return;
    }
    setIsTransferLoading(true);
    try {
      const result = await window.desktop.transfer.retryPendingUploads();
      await refreshTransferState();
      showToast(result.failed ? t("部分照片仍未发送") : t("待发送照片已完成"), result.failed ? t(`${result.sent} 张成功，${result.failed} 张待重试`) : t(`已发送 ${result.sent} 张照片`), result.failed ? "warning" : "success");
    } catch (error) {
      showToast("重试发送失败", error instanceof Error ? error.message : t("无法重试发送"), "warning");
    } finally {
      setIsTransferLoading(false);
    }
  }, [refreshTransferState, showToast]);

  const updateCapture = useCallback((patch: Partial<CaptureState>) => {
    const next = { ...captureRef.current, ...patch };
    captureRef.current = next;
    setCapture(next);
  }, []);

  useEffect(() => {
    captureRef.current = capture;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(capture));
  }, [capture]);

  useEffect(() => {
    localStorage.setItem(CONTROL_DOCK_STORAGE_KEY, JSON.stringify(dockSettings));
  }, [dockSettings]);

  const stopStream = useCallback((target: MediaStream | null) => {
    target?.getTracks().forEach((track) => track.stop());
  }, []);

  const clearCaptureRecoveryTimer = useCallback(() => {
    if (captureRecoveryTimerRef.current !== null) {
      window.clearTimeout(captureRecoveryTimerRef.current);
      captureRecoveryTimerRef.current = null;
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const available = await navigator.mediaDevices.enumerateDevices();
    const nextDevices: MediaDeviceOption[] = available
      .filter((device) => device.kind === "videoinput" || device.kind === "audioinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        kind: device.kind as "videoinput" | "audioinput",
      }));
    setDevices(nextDevices);

    const current = captureRef.current;
    const nextCameraId = current.cameraId && nextDevices.some((device) => device.kind === "videoinput" && device.deviceId === current.cameraId)
      ? current.cameraId
      : nextDevices.find((device) => device.kind === "videoinput")?.deviceId ?? null;
    const nextMicrophoneId = current.microphoneId && nextDevices.some((device) => device.kind === "audioinput" && device.deviceId === current.microphoneId)
      ? current.microphoneId
      : nextDevices.find((device) => device.kind === "audioinput")?.deviceId ?? null;

    if (nextCameraId !== current.cameraId || nextMicrophoneId !== current.microphoneId) {
      updateCapture({ cameraId: nextCameraId, microphoneId: nextMicrophoneId });
    }
  }, [updateCapture]);

  const requestSingleTrack = useCallback(async (kind: "camera" | "microphone", deviceId: string | null): Promise<MediaStreamTrack | null> => {
    const constraints: MediaStreamConstraints = kind === "camera"
      ? {
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } }
            : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } },
          audio: false,
        }
      : {
          video: false,
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        };

    try {
      const requested = await navigator.mediaDevices.getUserMedia(constraints);
      return kind === "camera" ? requested.getVideoTracks()[0] ?? null : requested.getAudioTracks()[0] ?? null;
    } catch {
      return null;
    }
  }, []);

  const acquireCapture = useCallback(async (state: CaptureState, isCurrent: () => boolean): Promise<CaptureResult> => {
    const nextStream = new MediaStream();

    const cameraPromise: Promise<CaptureTrackResult> = state.cameraEnabled
      ? (async () => {
          try {
            const requested = await navigator.mediaDevices.getUserMedia({
              video: state.cameraId
                ? { deviceId: { exact: state.cameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } }
                : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } },
              audio: false,
            });
            return { track: requested.getVideoTracks()[0] ?? null };
          } catch (error) {
            const message = getErrorMessage(error);
            const track = message.permissionDenied || !isCurrent() ? null : await requestSingleTrack("camera", null);
            return { track, ...(!track ? { issue: { target: "camera" as const, ...message } } : {}) };
          }
        })()
      : Promise.resolve({ track: null });

    const startMicrophone = async (): Promise<CaptureTrackResult> => {
      if (!state.microphoneEnabled) {
        return { track: null };
      }

      try {
        const requested = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: state.microphoneId ? { deviceId: { exact: state.microphoneId } } : true,
        });
        return { track: requested.getAudioTracks()[0] ?? null };
      } catch (error) {
        const message = getErrorMessage(error);
        const track = message.permissionDenied || !isCurrent() ? null : await requestSingleTrack("microphone", null);
        return { track, ...(!track ? { issue: { target: "microphone" as const, ...message } } : {}) };
      }
    };

    // Start both devices together, but publish the camera as soon as it is
    // ready. Waiting for Promise.all here made a slow microphone postpone the
    // first camera frame even though the requests themselves were parallel.
    const camera = await cameraPromise;
    const issues = camera.issue ? [camera.issue] : [];
    if (!isCurrent()) {
      camera.track?.stop();
      return { stream: nextStream, issues, startMicrophone };
    }
    if (camera.track) {
      nextStream.addTrack(camera.track);
    }
    return { stream: nextStream, issues, startMicrophone };
  }, [requestSingleTrack, stopStream]);

  const restartCapture = useCallback(async (overrides: Partial<CaptureState> = {}) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      captureRecoveryBlockedRef.current = true;
      setIssues([{
        target: "camera",
        title: t("当前环境不支持摄像头"),
        detail: t("请使用 Windows 桌面版本打开取景台。"),
        permissionDenied: false,
      }]);
      setIsLoading(false);
      return;
    }

    clearCaptureRecoveryTimer();
    const requestId = ++captureRequestIdRef.current;
    const nextState = { ...captureRef.current, ...overrides };
    captureRestartingRef.current = true;
    setIsLoading(true);
    try {
      const result = await acquireCapture(
        nextState,
        () => captureMountedRef.current && requestId === captureRequestIdRef.current,
      );
      if (requestId !== captureRequestIdRef.current) {
        stopStream(result.stream);
        return;
      }

      const previous = streamRef.current;
      streamRef.current = result.stream;
      setStream(result.stream);
      setMicrophoneTrack(result.stream.getAudioTracks()[0] ?? null);
      stopStream(previous);
      setIssues(result.issues);
      const liveCameraTrack = result.stream.getVideoTracks().some((track) => track.readyState === "live");
      if (liveCameraTrack) {
        hasHadLiveCameraRef.current = true;
        captureUnhealthySinceRef.current = null;
      }
      captureRecoveryBlockedRef.current = result.issues.some((issue) => issue.target === "camera" && issue.permissionDenied);

      // The preview is usable now. Complete audio and device-list work without
      // competing with the camera's first frame or holding its loading state open.
      const startMicrophone = () => {
        if (!captureMountedRef.current || requestId !== captureRequestIdRef.current) {
          return;
        }

        void result.startMicrophone().then(({ track, issue }) => {
        if (!captureMountedRef.current || requestId !== captureRequestIdRef.current) {
          track?.stop();
          return;
        }

        const activeStream = streamRef.current;
        if (!activeStream || activeStream !== result.stream) {
          track?.stop();
          return;
        }

        if (track?.readyState === "live") {
          activeStream.addTrack(track);
          setMicrophoneTrack(track);
          track.addEventListener("ended", () => {
            setMicrophoneTrack((current) => current === track ? null : current);
          }, { once: true });
        } else {
          setMicrophoneTrack(null);
        }

        setIssues((current) => {
          const withoutMicrophoneIssue = current.filter((currentIssue) => currentIssue.target !== "microphone");
          return issue ? [...withoutMicrophoneIssue, issue] : withoutMicrophoneIssue;
        });
        });
      };
      const hasLiveCamera = result.stream.getVideoTracks().some((track) => track.readyState === "live");
      const previewVideo = videoRef.current;
      if (hasLiveCamera && previewVideo?.requestVideoFrameCallback) {
        let microphoneStarted = false;
        const startOnce = () => {
          if (microphoneStarted) {
            return;
          }
          microphoneStarted = true;
          window.clearTimeout(microphoneFallbackTimer);
          startMicrophone();
        };
        const microphoneFallbackTimer = window.setTimeout(startOnce, 750);
        previewVideo.requestVideoFrameCallback(startOnce);
      } else if (hasLiveCamera) {
        window.setTimeout(startMicrophone, 100);
      } else {
        startMicrophone();
      }
      void refreshDevices().catch(() => undefined);
    } catch (error) {
      if (requestId !== captureRequestIdRef.current) {
        return;
      }
      const message = getErrorMessage(error);
      captureRecoveryBlockedRef.current = message.permissionDenied;
      setIssues([{ target: "camera", ...message }]);
    } finally {
      if (requestId === captureRequestIdRef.current) {
        captureRestartingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [acquireCapture, clearCaptureRecoveryTimer, refreshDevices, stopStream]);

  const scheduleCaptureRecovery = useCallback((delay = CAPTURE_ENDED_RECOVERY_DELAY_MS) => {
    const state = captureRef.current;
    if (!captureMountedRef.current || !state.cameraEnabled || captureRecoveryBlockedRef.current || captureRecoveryTimerRef.current !== null) {
      return;
    }

    captureRecoveryTimerRef.current = window.setTimeout(() => {
      captureRecoveryTimerRef.current = null;
      const currentTrack = streamRef.current?.getVideoTracks().find((track) => track.readyState === "live" && !track.muted);
      if (!captureMountedRef.current || !captureRef.current.cameraEnabled || currentTrack || captureRestartingRef.current) {
        return;
      }
      captureUnhealthySinceRef.current = Date.now();
      void restartCapture();
    }, delay);
  }, [restartCapture]);

  const retryCapture = useCallback(() => {
    void restartCapture();
  }, [restartCapture]);

  useEffect(() => {
    captureMountedRef.current = true;
    void restartCapture();
    const handleDeviceChange = () => {
      void refreshDevices()
        .catch(() => undefined)
        .finally(() => scheduleCaptureRecovery());
    };
    navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => {
      captureMountedRef.current = false;
      navigator.mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
      captureRequestIdRef.current += 1;
      captureRestartingRef.current = false;
      clearCaptureRecoveryTimer();
      const currentStream = streamRef.current;
      streamRef.current = null;
      stopStream(currentStream);
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, [clearCaptureRecoveryTimer, refreshDevices, restartCapture, scheduleCaptureRecovery, stopStream]);

  useEffect(() => {
    if (!stream) {
      return;
    }

    const videoTracks = stream.getVideoTracks();
    const handleTrackEnded = () => {
      if (!captureMountedRef.current || streamRef.current !== stream || !captureRef.current.cameraEnabled) {
        return;
      }
      captureUnhealthySinceRef.current = Date.now() - CAPTURE_UNHEALTHY_GRACE_MS;
      scheduleCaptureRecovery();
    };
    const handleTrackMuted = () => {
      if (captureMountedRef.current && streamRef.current === stream && captureRef.current.cameraEnabled) {
        captureUnhealthySinceRef.current ??= Date.now();
      }
    };
    const handleTrackUnmuted = () => {
      if (streamRef.current === stream) {
        captureUnhealthySinceRef.current = null;
        void videoRef.current?.play().catch(() => undefined);
      }
    };

    videoTracks.forEach((track) => {
      track.addEventListener("ended", handleTrackEnded);
      track.addEventListener("mute", handleTrackMuted);
      track.addEventListener("unmute", handleTrackUnmuted);
    });
    return () => {
      videoTracks.forEach((track) => {
        track.removeEventListener("ended", handleTrackEnded);
        track.removeEventListener("mute", handleTrackMuted);
        track.removeEventListener("unmute", handleTrackUnmuted);
      });
    };
  }, [scheduleCaptureRecovery, stream]);

  useEffect(() => {
    const checkCaptureHealth = () => {
      if (!captureMountedRef.current) {
        return;
      }
      const state = captureRef.current;
      if (!state.cameraEnabled || !hasHadLiveCameraRef.current) {
        captureUnhealthySinceRef.current = null;
        return;
      }

      const videoTrack = streamRef.current?.getVideoTracks().find((track) => track.readyState === "live");
      if (videoTrack && !videoTrack.muted) {
        captureUnhealthySinceRef.current = null;
        if (videoRef.current?.paused) {
          void videoRef.current.play().catch(() => undefined);
        }
        return;
      }

      const now = Date.now();
      captureUnhealthySinceRef.current ??= now;
      if (
        now - captureUnhealthySinceRef.current >= CAPTURE_UNHEALTHY_GRACE_MS
        && !captureRestartingRef.current
        && !captureRecoveryBlockedRef.current
      ) {
        captureUnhealthySinceRef.current = now;
        scheduleCaptureRecovery(0);
      }
    };

    const handleResume = () => {
      if (!document.hidden) {
        void videoRef.current?.play().catch(() => undefined);
        checkCaptureHealth();
      }
    };
    const healthTimer = window.setInterval(checkCaptureHealth, CAPTURE_HEALTH_CHECK_INTERVAL_MS);
    window.addEventListener("focus", handleResume);
    document.addEventListener("visibilitychange", handleResume);
    return () => {
      window.clearInterval(healthTimer);
      window.removeEventListener("focus", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
    };
  }, [scheduleCaptureRecovery]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.srcObject = stream;
    if (stream) {
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream]);

  useEffect(() => {
    if (!window.desktop) {
      return;
    }
    void window.desktop.window.getState().then((state) => {
      setIsFullscreen(state.isFullscreen);
      setIsMaximized(state.isMaximized);
      setIsAlwaysOnTop(state.isAlwaysOnTop);
    });
  }, []);

  useEffect(() => {
    if (!window.desktop?.transfer) {
      return;
    }
    if (isTransferOpen) {
      return;
    }
    const timer = window.setTimeout(() => void refreshTransferState(), 2_500);
    return () => window.clearTimeout(timer);
  }, [isTransferOpen, refreshTransferState]);

  useEffect(() => {
    if (!isTransferOpen) {
      return;
    }
    const timer = window.setInterval(() => void refreshTransferState(), 15000);
    return () => window.clearInterval(timer);
  }, [isTransferOpen, refreshTransferState]);

  const setZoom = useCallback((nextZoom: number) => {
    const zoom = clamp(Number(nextZoom), MIN_ZOOM, MAX_ZOOM);
    const maxPan = getPanLimit(zoom);
    const current = captureRef.current;
    updateCapture({
      zoom,
      panX: current.freePan ? current.panX : clamp(current.panX, -maxPan, maxPan),
      panY: current.freePan ? current.panY : clamp(current.panY, -maxPan, maxPan),
    });
  }, [updateCapture]);

  const toggleFreePan = useCallback(() => {
    const current = captureRef.current;
    const freePan = !current.freePan;
    if (freePan) {
      updateCapture({ freePan });
      showToast("自由拖动已开启", t("画面不再受取景框边缘限制"));
      return;
    }

    const maxPan = getPanLimit(current.zoom);
    updateCapture({
      freePan,
      panX: clamp(current.panX, -maxPan, maxPan),
      panY: clamp(current.panY, -maxPan, maxPan),
    });
    showToast("边界限制已开启", t("画面已回到当前缩放范围内"));
  }, [showToast, updateCapture]);

  const resetView = useCallback(() => {
    updateCapture({ zoom: 1, panX: 0, panY: 0 });
    showToast("取景已复位", t("画面恢复到 1× 居中状态"));
  }, [showToast, updateCapture]);

  const toggleDoubleClickZoom = useCallback(() => {
    const nextZoom = captureRef.current.zoom > 1 ? 1 : 2;
    updateCapture({ zoom: nextZoom, panX: 0, panY: 0 });
    showToast(nextZoom > 1 ? t("画面已放大") : t("画面已缩回"), t(`${nextZoom.toFixed(1)}× 居中显示`));
  }, [showToast, updateCapture]);

  const handleViewportWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom(captureRef.current.zoom + (event.deltaY > 0 ? -0.1 : 0.1));
  }, [setZoom]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (captureRef.current.zoom === 1 && !captureRef.current.freePan) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: captureRef.current.panX,
      panY: captureRef.current.panY,
    };
    setIsDragging(true);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !viewportRef.current) {
      return;
    }
    const bounds = viewportRef.current.getBoundingClientRect();
    const zoom = captureRef.current.zoom;
    const maxPan = getPanLimit(zoom);
    const nextX = dragRef.current.panX + ((event.clientX - dragRef.current.x) / bounds.width) * 100;
    const nextY = dragRef.current.panY + ((event.clientY - dragRef.current.y) / bounds.height) * 100;
    updateCapture({
      panX: captureRef.current.freePan ? nextX : clamp(nextX, -maxPan, maxPan),
      panY: captureRef.current.freePan ? nextY : clamp(nextY, -maxPan, maxPan),
    });
  }, [isDragging, updateCapture]);

  const stopDragging = useCallback(() => setIsDragging(false), []);

  const handleDockResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dockSettings.collapsed) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = dockPanelRef.current?.getBoundingClientRect();
    const isHorizontalDock = dockSettings.position === "left" || dockSettings.position === "right";
    dockResizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startSize: dockSettings.height ?? (isHorizontalDock ? bounds?.width : bounds?.height) ?? DEFAULT_DOCK_HEIGHT,
    };
    setIsDockResizing(true);
  }, [dockSettings.collapsed, dockSettings.height, dockSettings.position]);

  const handleDockResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDockResizing) {
      return;
    }
    const isHorizontalDock = dockSettings.position === "left" || dockSettings.position === "right";
    const delta = isHorizontalDock
      ? event.clientX - dockResizeRef.current.startX
      : event.clientY - dockResizeRef.current.startY;
    const direction = dockSettings.position === "top" || dockSettings.position === "left" ? 1 : -1;
    const nextSize = clamp(
      dockResizeRef.current.startSize + (delta * direction),
      MIN_DOCK_HEIGHT,
      MAX_DOCK_HEIGHT,
    );
    setDockSettings((current) => ({ ...current, height: Math.round(nextSize) }));
  }, [dockSettings.position, isDockResizing]);

  const stopDockResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDockResizing(false);
  }, []);

  const resetDockHeight = useCallback(() => {
    setDockSettings((current) => ({ ...current, height: DEFAULT_DOCK_HEIGHT }));
  }, []);

  const toggleDockCollapsed = useCallback(() => {
    setDockSettings((current) => ({ ...current, collapsed: !current.collapsed }));
  }, []);

  const setDockPosition = useCallback((position: DockPosition) => {
    setDockSettings((current) => ({ ...current, position }));
  }, []);

  const toggleDockButton = useCallback((buttonId: DockButtonId) => {
    setDockSettings((current) => ({
      ...current,
      buttons: current.buttons.includes(buttonId)
        ? current.buttons.filter((id) => id !== buttonId)
        : [...current.buttons, buttonId],
    }));
  }, []);

  const resetDockButtons = useCallback(() => {
    setDockSettings((current) => ({ ...current, buttons: [...DEFAULT_DOCK_BUTTONS] }));
  }, []);

  const getButtonScale = useCallback((buttonId: ButtonSizeId) => dockSettings.buttonScales[buttonId] ?? DEFAULT_DOCK_BUTTON_SCALE, [dockSettings.buttonScales]);

  const setDockButtonSize = useCallback((buttonId: ButtonSizeId, scale: number) => {
    setDockSettings((current) => ({
      ...current,
      buttonScales: {
        ...current.buttonScales,
        [buttonId]: clamp(scale, MIN_DOCK_BUTTON_SCALE, MAX_DOCK_BUTTON_SCALE),
      },
    }));
  }, []);

  const resetDockButtonSizes = useCallback(() => {
    const buttonScales = BUTTON_SIZE_OPTIONS.reduce((scales, option) => {
      scales[option.id] = DEFAULT_DOCK_BUTTON_SCALE;
      return scales;
    }, {} as Record<ButtonSizeId, number>);
    setDockSettings((current) => ({ ...current, buttonScales }));
  }, []);

  const renderDockButton = (buttonId: DockButtonId) => {
    const option = DOCK_BUTTON_OPTIONS.find((item) => item.id === buttonId);
    if (!option) {
      return null;
    }

    let label = t(option.label);
    let icon = option.icon;
    let active = false;
    let onClick: () => void = () => undefined;

    switch (buttonId) {
      case "reset":
        onClick = resetView;
        break;
      case "fullscreen":
        label = isFullscreen ? t("退出全屏") : t("全屏查看");
        onClick = () => void toggleFullscreen();
        break;
      case "alwaysOnTop":
        label = isAlwaysOnTop ? t("已置顶") : t("窗口置顶");
        active = isAlwaysOnTop;
        onClick = () => void toggleAlwaysOnTop();
        break;
      case "refresh":
        onClick = () => void refreshDevices();
        break;
      case "camera":
        label = capture.cameraEnabled ? t("关闭摄像头") : t("开启摄像头");
        icon = capture.cameraEnabled ? "camera" : "cameraOff";
        active = capture.cameraEnabled;
        onClick = toggleCamera;
        break;
      case "microphone":
        label = capture.microphoneEnabled ? t("关闭麦克风") : t("开启麦克风");
        icon = capture.microphoneEnabled ? "mic" : "micOff";
        active = capture.microphoneEnabled;
        onClick = toggleMicrophone;
        break;
      case "mirror":
        label = capture.mirrored ? t("取消翻转") : t("左右翻转");
        active = capture.mirrored;
        onClick = () => updateCapture({ mirrored: !capture.mirrored });
        break;
      case "folder":
        onClick = () => void window.desktop?.openSnapshotFolder();
        break;
    }

    const buttonScale = getButtonScale(buttonId);
    return (
      <button
        className={`dock-action-button ${active ? "active" : ""}`}
        key={buttonId}
        type="button"
        onClick={onClick}
        title={t(option.label)}
        style={{
          "--dock-action-width": `${Math.round(112 * buttonScale)}px`,
          "--dock-action-height": `${Math.round(42 * buttonScale)}px`,
          "--dock-action-font-size": `${Math.max(9, Math.round(11 * buttonScale))}px`,
          "--dock-icon-size": `${Math.max(13, Math.round(16 * buttonScale))}px`,
          "--dock-action-gap": `${Math.max(4, Math.round(7 * buttonScale))}px`,
        } as CSSProperties}
      >
        <Icon name={icon} size={16} />{label}
      </button>
    );
  };

  const takeSnapshot = useCallback(async () => {
    const video = videoRef.current;
    const viewport = viewportRef.current;
    if (!video || !viewport || !video.videoWidth || !hasVideo) {
      showToast("暂时无法拍照", t("请先开启摄像头并等待画面准备好。"), "warning");
      return;
    }

    setIsSaving(true);
    setIsFlashVisible(true);
    window.setTimeout(() => setIsFlashVisible(false), 180);

    try {
      const width = Math.max(640, Math.round(viewport.clientWidth * window.devicePixelRatio));
      const height = Math.max(360, Math.round(viewport.clientHeight * window.devicePixelRatio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error(t("无法创建照片画布"));
      }

      context.fillStyle = "#0b0d0d";
      context.fillRect(0, 0, width, height);

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const baseScale = captureRef.current.displayMode === "fill"
        ? Math.max(width / sourceWidth, height / sourceHeight)
        : Math.min(width / sourceWidth, height / sourceHeight);
      const scale = baseScale * captureRef.current.zoom;
      const drawWidth = sourceWidth * scale;
      const drawHeight = sourceHeight * scale;
      const drawX = (width - drawWidth) / 2 + (captureRef.current.panX / 100) * width;
      const drawY = (height - drawHeight) / 2 + (captureRef.current.panY / 100) * height;
      context.save();
      if (captureRef.current.mirrored) {
        context.translate(width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(video, drawX, drawY, drawWidth, drawHeight);
      context.restore();

      const result = await window.desktop?.saveSnapshot(canvas.toDataURL("image/png"));
      if (!result) {
        throw new Error(t("桌面保存接口不可用"));
      }
      const shouldTransfer = transferState?.status === "ready" || transferState?.status === "paired" || transferState?.status === "offline";
      if (shouldTransfer && window.desktop?.transfer) {
        showToast("照片已保存", t("正在加密发送到手机"));
        void window.desktop.transfer.uploadSnapshot(result.path)
          .then(async () => {
            await refreshTransferState();
            showToast("照片已发送", t("手机端可以预览这张照片"));
          })
          .catch((transferError) => {
            showToast("照片已保存，但暂未发送", transferError instanceof Error ? transferError.message : t("网络恢复后可在手机收图中重试"), "warning");
          });
      } else {
        showToast("照片已保存", result.path);
      }
    } catch (error) {
      showToast("保存失败", error instanceof Error ? error.message : t("无法保存这张照片。"), "warning");
    } finally {
      setIsSaving(false);
    }
  }, [hasVideo, refreshTransferState, showToast, transferState?.status]);

  const toggleCamera = useCallback(() => {
    const enabled = !captureRef.current.cameraEnabled;
    updateCapture({ cameraEnabled: enabled });
    void restartCapture({ cameraEnabled: enabled });
  }, [restartCapture, updateCapture]);

  const toggleMicrophone = useCallback(() => {
    const enabled = !captureRef.current.microphoneEnabled;
    updateCapture({ microphoneEnabled: enabled });
    void restartCapture({ microphoneEnabled: enabled });
  }, [restartCapture, updateCapture]);

  const selectCamera = useCallback((cameraId: string) => {
    updateCapture({ cameraId });
    if (captureRef.current.cameraEnabled) {
      void restartCapture({ cameraId });
    }
  }, [restartCapture, updateCapture]);

  const selectMicrophone = useCallback((microphoneId: string) => {
    updateCapture({ microphoneId });
    if (captureRef.current.microphoneEnabled) {
      void restartCapture({ microphoneId });
    }
  }, [restartCapture, updateCapture]);

  const toggleFullscreen = useCallback(async () => {
    if (window.desktop) {
      const next = await window.desktop.window.setFullscreen(!isFullscreen);
      setIsFullscreen(next);
      return;
    }
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

  const toggleMaximize = useCallback(async () => {
    if (!window.desktop) {
      return;
    }
    const next = await window.desktop.window.toggleMaximize();
    setIsMaximized(next);
  }, []);

  const toggleAlwaysOnTop = useCallback(async () => {
    if (!window.desktop) {
      return;
    }
    const next = await window.desktop.window.setAlwaysOnTop(!isAlwaysOnTop);
    setIsAlwaysOnTop(next);
    showToast(next ? t("窗口已置顶") : t("窗口已取消置顶"));
  }, [isAlwaysOnTop, showToast]);

  const openPrivacySettings = useCallback((target: "camera" | "microphone") => {
    void window.desktop?.openPrivacySettings(target);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) {
        return;
      }
      if (event.key === "Escape" && isSettingsOpen) {
        setIsSettingsOpen(false);
        return;
      }
      if (event.key === "Escape" && isTransferOpen) {
        setIsTransferOpen(false);
        return;
      }
      if (event.key === " " || event.key.toLowerCase() === "p") {
        event.preventDefault();
        void takeSnapshot();
      } else if (event.key.toLowerCase() === "c") {
        toggleCamera();
      } else if (event.key.toLowerCase() === "m") {
        toggleMicrophone();
      } else if (event.key.toLowerCase() === "f") {
        void toggleFullscreen();
      } else if (event.key.toLowerCase() === "r") {
        resetView();
      } else if (event.key === "Escape" && isFullscreen) {
        void toggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen, isSettingsOpen, isTransferOpen, resetView, takeSnapshot, toggleCamera, toggleFullscreen, toggleMicrophone]);

  const videoStyle = {
    transform: `translate3d(${capture.panX}%, ${capture.panY}%, 0) scale(${capture.zoom}) scaleX(${capture.mirrored ? -1 : 1})`,
    objectFit: capture.displayMode === "fit" ? "contain" : "cover",
  } as const;

  return (
    <div className={`app-shell ${isFullscreen ? "immersive-mode" : ""}`}>
      <header className="titlebar">
        <div className="brand-block">
          <div className="brand-mark"><span /><span /><span /></div>
          <div>
            <h1>{t("取景台")}</h1>
          </div>
        </div>
        <div className="titlebar-status">
          <span className={`live-status ${hasVideo ? "is-live" : ""}`}><i />{hasVideo ? "LIVE" : "STANDBY"}</span>
        </div>
        <div className="window-actions no-drag">
          <button className="window-button transfer-window-button" aria-label={t("打开手机收图")} title={t("打开手机收图")} onClick={openTransferDialog}><Icon name="phone" size={16} /><span>{t("手机收图")}</span></button>
          <button className="window-button" aria-label={t("最小化")} title={t("最小化")} onClick={() => window.desktop?.window.minimize()}><Icon name="minimize" size={15} /></button>
          <button className="window-button" aria-label={isMaximized ? t("还原") : t("最大化")} title={isMaximized ? t("还原") : t("最大化")} onClick={() => void toggleMaximize()}><Icon name={isMaximized ? "square" : "maximize"} size={14} /></button>
          <button className="window-button close-button" aria-label={t("关闭窗口")} title={t("关闭窗口")} onClick={() => window.desktop?.window.close()}><Icon name="close" size={16} /></button>
        </div>
      </header>

      <main className={`workspace dock-${dockSettings.position}`}>
        <section className="viewer-panel">
          <div
            className={`video-surface ${isDragging ? "is-dragging" : ""} ${hasVideo ? "has-video" : "no-video"} ${hasVideo && (capture.freePan || capture.zoom !== 1) ? "can-pan" : ""}`}
            ref={viewportRef}
            onWheel={handleViewportWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onDoubleClick={toggleDoubleClickZoom}
          >
            <video ref={videoRef} className="live-video" style={videoStyle} muted playsInline aria-label={t("摄像头实时画面")} />
            {hasVideo ? null : (
              <div className="empty-view">
                <div className="empty-orbit"><Icon name={capture.cameraEnabled ? "cameraOff" : "camera"} size={25} /></div>
                <strong>{isLoading ? t("正在准备取景") : capture.cameraEnabled ? t("没有可用画面") : t("摄像头已关闭")}</strong>
                <span>{isLoading ? t("正在请求设备权限…") : t(primaryIssue?.detail ?? "点击下方按钮重新开启摄像头")}</span>
                {capture.cameraEnabled ? (
                  <button className="retry-device-button" type="button" onClick={retryCapture} disabled={isLoading}>
                    <Icon name="refresh" size={15} />{isLoading ? t("正在重试…") : t("重新尝试")}
                  </button>
                ) : <button type="button" onClick={toggleCamera}>{t("开启摄像头")}</button>}
              </div>
            )}
            {isFlashVisible ? <div className="capture-flash" /> : null}
          </div>

        </section>

        <aside
          ref={dockPanelRef}
          className={`control-panel action-panel ${dockSettings.collapsed ? "is-collapsed" : ""} ${isDockResizing ? "is-resizing" : ""}`}
          style={({
            ...(dockSettings.height ? { "--dock-height": `${dockSettings.height}px`, "--dock-width": `${dockSettings.height}px` } : {}),
            "--dock-action-height": "42px",
            "--dock-action-font-size": "11px",
            "--dock-icon-size": "16px",
            "--dock-position-width": "62px",
            "--dock-shutter-height": `${Math.round(104 * getButtonScale("shutter"))}px`,
            "--dock-shutter-padding-y": `${Math.round(20 * getButtonScale("shutter"))}px`,
            "--dock-shutter-padding-x": `${Math.round(21 * getButtonScale("shutter"))}px`,
            "--dock-shutter-icon-size": `${Math.round(58 * getButtonScale("shutter"))}px`,
            "--dock-shutter-glyph-size": `${Math.max(24, Math.round(32 * getButtonScale("shutter")))}px`,
            "--dock-shutter-title-size": `${Math.max(16, Math.round(20 * getButtonScale("shutter")))}px`,
            "--dock-shutter-hint-size": `${Math.max(9, Math.round(10 * getButtonScale("shutter")))}px`,
            "--dock-zoom-button-size": `${Math.max(30, Math.round(38 * getButtonScale("zoom")))}px`,
            "--dock-zoom-font-size": `${Math.max(18, Math.round(23 * getButtonScale("zoom")))}px`,
          } as CSSProperties)}
        >
          <div
            className="dock-resize-handle no-drag"
            onPointerDown={handleDockResizeStart}
            onPointerMove={handleDockResizeMove}
            onPointerUp={stopDockResize}
            onPointerCancel={stopDockResize}
            onDoubleClick={resetDockHeight}
            title={dockSettings.collapsed ? t("先展开控制栏") : t("拖动调整控制栏高度，双击恢复默认")}
            aria-label={t("调整控制栏高度")}
          >
            <span />
          </div>
          <div className="panel-heading action-heading">
            <div className="action-heading-title">
              <h2>{t("拍摄控制")}</h2>
              <button className={`dock-toggle ${dockSettings.collapsed ? "is-collapsed" : ""}`} type="button" onClick={toggleDockCollapsed} aria-expanded={!dockSettings.collapsed} aria-label={dockSettings.collapsed ? t("展开控制栏") : t("收起控制栏")} title={dockSettings.collapsed ? t("展开控制栏") : t("收起控制栏")} style={{ "--dock-toggle-font-size": `${Math.max(9, Math.round(10 * getButtonScale("dockToggle")))}px`, "--dock-toggle-icon-size": `${Math.max(13, Math.round(15 * getButtonScale("dockToggle")))}px`, "--dock-toggle-padding-y": `${Math.max(3, Math.round(4 * getButtonScale("dockToggle")))}px`, "--dock-toggle-padding-x": `${Math.max(4, Math.round(5 * getButtonScale("dockToggle")))}px` } as CSSProperties}>
                <Icon name="chevronDown" size={15} />
                <span>{dockSettings.collapsed ? t("展开") : t("收起")}</span>
              </button>
            </div>
            <button className="settings-trigger" type="button" onClick={() => setIsSettingsOpen(true)} title={t("打开设置")} style={{ "--settings-button-height": `${Math.round(32 * getButtonScale("settings"))}px`, "--settings-button-font-size": `${Math.max(9, Math.round(11 * getButtonScale("settings")))}px`, "--settings-button-icon-size": `${Math.max(15, Math.round(18 * getButtonScale("settings")))}px`, "--settings-button-gap": `${Math.max(5, Math.round(7 * getButtonScale("settings")))}px` } as CSSProperties}><Icon name="settings" size={18} /><span>{t("设置")}</span></button>
          </div>

          <div className="quick-actions">
            <button className="shutter-button shutter-button-large" type="button" onClick={() => void takeSnapshot()} disabled={isSaving || !hasVideo}>
              <span className="shutter-icon"><Icon name="shutter" size={32} /></span>
              <span><strong>{isSaving ? t("保存中…") : t("拍一张")}</strong><small>{t("SPACE / 快门")}</small></span>
            </button>

            <div className="quick-zoom zoom-section">
              <div className="quick-label"><span>{t("画面缩放")}</span><strong>{capture.zoom.toFixed(1)}×</strong></div>
              <div className="zoom-control zoom-control-large"><button type="button" onClick={() => setZoom(capture.zoom - 0.1)} aria-label={t("缩小")}>−</button><input aria-label={t("画面缩放")} style={zoomProgressStyle} type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="0.1" value={capture.zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button type="button" onClick={() => setZoom(capture.zoom + 0.1)} aria-label={t("放大")}>+</button></div>
              <div className="zoom-hint"><span>0.5×</span><span>{t("滚轮或拖动画面")}</span><span>4×</span></div>
              <div className={`pan-zone ${isDragging ? "is-dragging" : ""}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={stopDragging} onPointerCancel={stopDragging} onDoubleClick={toggleDoubleClickZoom} title={capture.freePan ? t("自由拖动画面，不受取景框边缘限制；双击切换缩放") : t("拖动取景，双击切换缩放")}><Icon name="move" size={16} /><span>{capture.freePan ? t("自由拖动") : t("拖动取景")}</span><small>{t("双击切换缩放")}</small></div>
            </div>

          </div>

          <div className="quick-status">
            <div><span className={`status-light ${hasVideo ? "ready" : ""}`} /><span>{t("画面")}</span><strong>{hasVideo ? t("正常") : t("等待")}</strong></div>
            <div><span className={`status-light ${hasAudio ? "ready" : ""}`} /><span>{t("声音")}</span><strong>{hasAudio ? t("正常") : t("关闭")}</strong></div>
          </div>

          <div className="action-panel-footer">
            <div className="secondary-actions">
              <select className="dock-position-select" aria-label={t("控制栏位置")} title={t("控制栏位置")} value={dockSettings.position} onChange={(event) => setDockPosition(event.target.value as DockPosition)}>
                <option value="bottom">{t("下方")}</option>
                <option value="top">{t("上方")}</option>
                <option value="left">{t("左侧")}</option>
                <option value="right">{t("右侧")}</option>
              </select>
              {dockSettings.buttons.map(renderDockButton)}
            </div>
            <div className="settings-note"><Icon name="settings" size={14} />{t("摄像头、麦克风与画面模式在设置中调整")}</div>
          </div>
        </aside>
      </main>

      <footer className="bottom-bar"><div className="bottom-message"><span className="tiny-dot" />{primaryIssue ? t(primaryIssue.title) : t("设备状态正常")}</div></footer>

      {isSettingsOpen ? (
        <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setIsSettingsOpen(false); }}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-header">
              <div><h2 id="settings-title">{t("设备与取景设置")}</h2><p>{t("管理输入设备、开关和画面显示方式。")}</p></div>
              <button className="settings-close" type="button" onClick={() => setIsSettingsOpen(false)} aria-label={t("关闭设置")}><Icon name="close" size={18} /></button>
            </header>

            <div className="settings-body">
              <div className="settings-column">
                <div className="setting-group">
                  <div className="settings-group-title">{t("输入设备")}</div>
                  <DeviceSelect label={t("摄像头")} value={capture.cameraId ?? ""} options={cameraDevices} icon={capture.cameraEnabled ? "camera" : "cameraOff"} disabled={isLoading} onChange={selectCamera} />
                  <DeviceSelect label={t("麦克风")} value={capture.microphoneId ?? ""} options={microphoneDevices} icon={capture.microphoneEnabled ? "mic" : "micOff"} disabled={isLoading} onChange={selectMicrophone} />
                </div>

                <div className="setting-group">
                  <div className="settings-group-title">{t("状态控制")}</div>
                  <ToggleRow label={t("摄像头")} detail={hasVideo ? t("实时画面输入") : t("当前未取景")} enabled={capture.cameraEnabled} icon={capture.cameraEnabled ? "camera" : "cameraOff"} onToggle={toggleCamera} />
                  <ToggleRow label={t("麦克风")} detail={hasAudio ? t("声音输入已启用") : t("当前静音")} enabled={capture.microphoneEnabled} icon={capture.microphoneEnabled ? "mic" : "micOff"} onToggle={toggleMicrophone} />
                </div>
              </div>

              <div className="settings-column">
                <div className="setting-group">
                  <div className="settings-group-title">{t("应用显示")}</div>
                  <label className="device-field">
                    <span className="field-label">{t("语言")}</span>
                    <span className="select-wrap">
                      <select aria-label={t("界面语言")} value={language} onChange={(event) => changeLanguage(event.target.value as AppLanguage)}>
                        <option value="zh-CN">{t("简体中文")}</option>
                        <option value="en-US">English</option>
                      </select>
                      <Icon name="chevronDown" size={15} />
                    </span>
                  </label>
                </div>
                <div className="setting-group">
                  <div className="settings-group-title">{t("画面模式")}</div>
                  <div className="display-mode-toggle settings-mode-toggle"><button type="button" className={capture.displayMode === "fill" ? "active" : ""} onClick={() => updateCapture({ displayMode: "fill" })}>{t("填充裁剪")}</button><button type="button" className={capture.displayMode === "fit" ? "active" : ""} onClick={() => updateCapture({ displayMode: "fit" })}>{t("完整适应")}</button></div>
                  <button className={`mirror-toggle settings-mirror-toggle ${capture.mirrored ? "active" : ""}`} type="button" onClick={() => updateCapture({ mirrored: !capture.mirrored })}><Icon name="mirror" size={17} /><span>{t("左右翻转画面")}</span><small>{capture.mirrored ? t("已开启") : t("关闭")}</small></button>
                  <button className={`mirror-toggle settings-mirror-toggle ${capture.freePan ? "active" : ""}`} type="button" onClick={toggleFreePan}><Icon name="move" size={17} /><span>{t("自由拖动画面")}</span><small>{capture.freePan ? t("不受边框限制") : t("边框限制")}</small></button>
                </div>

                <div className="setting-group button-size-settings">
                  <div className="settings-group-title">{t("按钮大小")}</div>
                  <p className="settings-help">{t("每个按钮单独调整，范围 75%–140%，精确到 1%。")}</p>
                  <div className="button-size-options">
                    {BUTTON_SIZE_OPTIONS.map((option) => {
                      const scale = getButtonScale(option.id);
                      const progress = ((scale - MIN_DOCK_BUTTON_SCALE) / (MAX_DOCK_BUTTON_SCALE - MIN_DOCK_BUTTON_SCALE)) * 100;
                      return (
                        <label className="button-size-option" key={option.id}>
                          <span>{t(option.label)}</span>
                          <input
                            type="range"
                            min={MIN_DOCK_BUTTON_SCALE}
                            max={MAX_DOCK_BUTTON_SCALE}
                            step="0.01"
                            value={scale}
                            style={{ "--button-size-progress": `${progress}%` } as CSSProperties}
                            onChange={(event) => setDockButtonSize(option.id, Number(event.target.value))}
                            aria-label={t(`${option.label}大小`)}
                          />
                          <strong>{Math.round(scale * 100)}%</strong>
                        </label>
                      );
                    })}
                  </div>
                  <button className="dock-button-reset button-size-reset" type="button" onClick={resetDockButtonSizes}>{t("全部恢复默认大小")}</button>
                </div>

                <div className="setting-group dock-button-settings">
                  <div className="settings-group-title">{t("控制栏按钮")}</div>
                  <p className="settings-help">{t("勾选要显示的按钮，也可以把隐藏的功能重新添加到控制栏。")}</p>
                  <div className="dock-button-options">
                    {DOCK_BUTTON_OPTIONS.map((option) => (
                      <label className="dock-button-option" key={option.id}>
                        <input type="checkbox" checked={dockSettings.buttons.includes(option.id)} onChange={() => toggleDockButton(option.id)} />
                        <Icon name={option.icon} size={15} />
                        <span>{t(option.label)}</span>
                      </label>
                    ))}
                  </div>
                  <button className="dock-button-reset" type="button" onClick={resetDockButtons}>{t("恢复默认按钮")}</button>
                </div>

                <div className="shortcut-card settings-shortcuts"><div className="shortcut-title"><Icon name="settings" size={14} />{t("快捷操作")}</div><div className="shortcut-grid"><span><kbd>C</kbd>{t("镜头")}</span><span><kbd>M</kbd>{t("麦克风")}</span><span><kbd>F</kbd>{t("全屏")}</span><span><kbd>R</kbd>{t("复位")}</span><span><kbd>Space</kbd>{t("拍照")}</span><span><kbd>Esc</kbd>{t("关闭设置")}</span></div></div>
              </div>
            </div>

            <footer className="settings-footer"><span>{t("设置会自动保存")}</span><button type="button" onClick={() => setIsSettingsOpen(false)}>{t("完成")}</button></footer>
          </section>
        </div>
      ) : null}

      {isTransferOpen ? (
        <TransferDialog
          state={transferState}
          isLoading={isTransferLoading}
          onClose={() => setIsTransferOpen(false)}
          onEnsure={() => void ensureTransferChannel()}
          onReset={() => void resetTransferPairing()}
          onRetry={() => void retryTransferUploads()}
          onRefresh={() => void refreshTransferState()}
        />
      ) : null}

      {primaryIssue?.permissionDenied ? <div className="permission-banner"><div className="permission-icon"><Icon name="shield" size={19} /></div><div><strong>{t(primaryIssue.title)}</strong><span>{t(primaryIssue.detail)}</span></div><button type="button" onClick={() => openPrivacySettings(primaryIssue.target)}>{t("打开 Windows 设置")}</button></div> : null}
      {toast ? <div className={`toast ${toast.tone === "warning" ? "warning" : ""}`}><span className="toast-icon"><Icon name={toast.tone === "warning" ? "alert" : "check"} size={16} /></span><span><strong>{t(toast.title)}</strong>{toast.detail ? <small>{t(toast.detail)}</small> : null}</span></div> : null}
    </div>
  );
}
