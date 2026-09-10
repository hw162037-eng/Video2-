import { NativeModules, Platform } from "react-native";

export type NativeWorkStatus = {
  state: "ENQUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "BLOCKED" | "NOT_FOUND";
  runAttemptCount: number;
  progress?: number;
  localUri?: string;
  errorMessage?: string;
};

type AgnesWorkManagerModule = {
  enqueueGeneration(taskId: string, kind: string, apiKey: string, payloadJson: string, pollIntervalSec: number): Promise<string>;
  cancelGeneration(taskId: string): Promise<boolean>;
  getGenerationStatus(taskId: string): Promise<NativeWorkStatus>;
  saveResultToMediaStore(resultUrl: string, taskId: string, kind: string): Promise<string>;
  extractLastFrame(videoUri: string, taskId: string): Promise<string>;
};

function getNativeModule() {
  return Platform.OS === "android"
    ? (NativeModules.AgnesWorkManager as AgnesWorkManagerModule | undefined)
    : undefined;
}

export function hasNativeWorkManager() {
  return Boolean(getNativeModule());
}

export async function enqueueNativeGeneration(taskId: string, kind: string, apiKey: string, payload: unknown, pollIntervalSec: number) {
  const native = getNativeModule();
  if (!native) throw new Error("Native WorkManager недоступен в Expo Go или web preview.");
  return native.enqueueGeneration(taskId, kind, apiKey, JSON.stringify(payload), pollIntervalSec);
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

export async function extractLastFrame(videoUri: string, taskId: string) {
  const native = getNativeModule();
  if (!native) return undefined;
  return native.extractLastFrame(videoUri, taskId);
}
