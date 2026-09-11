import { NativeModules, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export type NativeWorkStatus = {
  state: "SUBMITTING" | "PROCESSING" | "SERVER_READY" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "NOT_FOUND";
  runAttemptCount: number;
  startedAt?: number;
  progress?: number;
  serverId?: string;
  resultUrl?: string;
  localUri?: string;
  errorMessage?: string;
};

type AgnesNativeModule = {
  startGeneration(taskId: string, kind: string, apiKey: string, payloadPath: string, pollIntervalSec: number): Promise<boolean>;
  cancelGeneration(taskId: string): Promise<boolean>;
  getGenerationStatus(taskId: string): Promise<NativeWorkStatus>;
  getDiagnosticLog(): Promise<string>;
  clearDiagnosticLog(): Promise<boolean>;
  saveResultToMediaStore(resultUrl: string, taskId: string, kind: string): Promise<string>;
  extractFrameAtTime(videoUri: string, taskId: string, seconds: number): Promise<string>;
};

function getNativeModule() {
  return Platform.OS === "android" ? (NativeModules.AgnesWorkManager as AgnesNativeModule | undefined) : undefined;
}

export function hasNativeWorkManager() { return Boolean(getNativeModule()); }
export function hasNativeForegroundService() { return Boolean(getNativeModule()); }

export async function startNativeGeneration(taskId: string, kind: string, apiKey: string, payload: unknown, pollIntervalSec: number) {
  const native = getNativeModule();
  if (!native) throw new Error("Native Foreground Service недоступен в Expo Go или web preview.");
  if (!FileSystem.documentDirectory) throw new Error("Недоступно внутреннее хранилище приложения.");
  const payloadPath = `${FileSystem.documentDirectory}agnes-payload-${taskId}.json`;
  await FileSystem.writeAsStringAsync(payloadPath, JSON.stringify(payload));
  try {
    return await native.startGeneration(taskId, kind, apiKey, payloadPath, pollIntervalSec);
  } catch (error) {
    await FileSystem.deleteAsync(payloadPath, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

export async function getNativeGenerationStatus(taskId: string) {
  const native = getNativeModule();
  if (!native) return { state: "NOT_FOUND", runAttemptCount: 0 } as NativeWorkStatus;
  return native.getGenerationStatus(taskId);
}

export async function cancelNativeGeneration(taskId: string) {
  const native = getNativeModule();
  if (!native) return false;
  return native.cancelGeneration(taskId);
}

export async function saveResultToMediaStore(resultUrl: string, taskId: string, kind: "image" | "video") {
  const native = getNativeModule();
  if (!native) return undefined;
  return native.saveResultToMediaStore(resultUrl, taskId, kind);
}

export async function extractFrameAtTime(videoUri: string, taskId: string, seconds: number) {
  const native = getNativeModule();
  if (!native) return undefined;
  return native.extractFrameAtTime(videoUri, taskId, seconds);
}

export async function getDiagnosticLog() {
  const native = getNativeModule();
  return native ? native.getDiagnosticLog() : "Native diagnostics unavailable outside Android APK.";
}

export async function clearDiagnosticLog() {
  const native = getNativeModule();
  return native ? native.clearDiagnosticLog() : false;
}
