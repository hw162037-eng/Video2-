export type GenerationKind = "image" | "video";
export type TaskStatus = "queued" | "preparing" | "submitting" | "processing" | "completed" | "failed" | "retry_wait" | "cancelled";

export type FileAsset = {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  width?: number;
  height?: number;
};

export type ApiProfile = {
  id: string;
  name: string;
  agnesKey: string;
  enabled: boolean;
};

export type AppSettings = {
  pollIntervalSec: number;
  minImageIntervalSec: number;
  minVideoIntervalSec: number;
  retryBaseSec: number;
  maxAutoRetries: number;
  autoContinue: boolean;
  notifications: boolean;
};

export type GenerationTask = {
  id: string;
  kind: GenerationKind;
  profileId: string;
  profileName: string;
  model: string;
  mode: string;
  prompt: string;
  status: TaskStatus;
  stage: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  serverId?: string;
  resultUrl?: string;
  localUri?: string;
  errorCode?: number | string;
  errorMessage?: string;
  attempts: number;
  seconds?: number;
  size?: string;
  ratio?: string;
  sourceRatio?: string;
  fitMode?: "preserve" | "crop" | "fill";
  seed?: number;
  imageAssets?: FileAsset[];
  audioAssets?: FileAsset[];
  firstFrame?: FileAsset;
  lastFrame?: FileAsset;
  targetImage?: FileAsset;
  faceImage?: FileAsset;
};

export type PersistedState = {
  profiles: ApiProfile[];
  sharedImgbbKey: string;
  settings: AppSettings;
  tasks: GenerationTask[];
};

export const DEFAULT_SETTINGS: AppSettings = {
  pollIntervalSec: 15,
  minImageIntervalSec: 60,
  minVideoIntervalSec: 60,
  retryBaseSec: 30,
  maxAutoRetries: 4,
  autoContinue: true,
  notifications: true,
};

export const DEFAULT_PROFILES: ApiProfile[] = [
  { id: "profile-1", name: "Основной профиль", agnesKey: "", enabled: true },
];

export const STAGE_LABELS: Record<TaskStatus, string> = {
  queued: "В очереди",
  preparing: "Подготовка",
  submitting: "Отправка запроса",
  processing: "Обработка сервером",
  completed: "Готово",
  failed: "Ошибка",
  retry_wait: "Ожидание повтора",
  cancelled: "Отменено",
};

export function formatTaskDate(timestamp: number) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function shortKey(value: string) {
  if (!value) return "ключ не задан";
  if (value.length < 10) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
