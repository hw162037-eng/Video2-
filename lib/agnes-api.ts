import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";

import type { FileAsset, GenerationTask } from "@/lib/types";
import { AgnesApiError, explainError } from "@/lib/error-policy";
import { buildImagePayload, buildVideoPayload, isRetryableStatus } from "@/lib/api-policy";
import { saveResultToMediaStore } from "@/lib/native-work-manager";

export { AgnesApiError, explainError } from "@/lib/error-policy";

const AGNES_BASE = "https://apihub.agnes-ai.com/v1";
const AGNES_VIDEO_POLL = "https://apihub.agnes-ai.com/agnesapi";
const IMGBB_UPLOAD = "https://api.imgbb.com/1/upload";

async function readError(response: Response) {
  const body = await response.text();
  let message = body || response.statusText || "Неизвестная ошибка API";
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || parsed?.error || message;
  } catch {
    // Keep the raw text when the API response is not JSON.
  }
  return { message: String(message), body };
}

export async function fileToBase64(asset: FileAsset) {
  if (Platform.OS === "web") {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(blob);
    });
  }
  const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" });
  return `data:${asset.mimeType || "application/octet-stream"};base64,${base64}`;
}

async function uploadToImgBB(asset: FileAsset, apiKey: string) {
  if (!apiKey) throw new AgnesApiError("Не задан общий ImgBB API key.");
  const formData = new FormData();

  if (Platform.OS === "web") {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    formData.append("image", blob, asset.name);
  } else {
    formData.append("image", {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType || "image/jpeg",
    } as unknown as Blob);
  }

  const response = await fetch(`${IMGBB_UPLOAD}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const error = await readError(response);
    throw new AgnesApiError(`ImgBB: ${error.message}`, { code: response.status, retryable: isRetryableStatus(response.status), responseBody: error.body });
  }
  const data = await response.json();
  const url = data?.data?.url || data?.data?.display_url;
  if (!data?.success || !url) throw new AgnesApiError("ImgBB не вернул публичную ссылку на изображение.");
  return String(url);
}

function headers(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function agnesRequest(path: string, apiKey: string, body: unknown) {
  const response = await fetch(`${AGNES_BASE}${path}`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await readError(response);
    throw new AgnesApiError(error.message, { code: response.status, retryable: isRetryableStatus(response.status), responseBody: error.body });
  }
  return response.json();
}

export type SubmitResult = { serverId: string; resultUrl?: string; payloadSummary: string };

/** Prepare every mode's file data before handing the request to WorkManager. */
export async function buildNativePayload(task: GenerationTask, imgbbKey: string) {
  if (task.kind === "image") {
    const sourceAssets = task.mode === "face_swap"
      ? [task.targetImage, task.faceImage].filter(Boolean) as FileAsset[]
      : task.imageAssets ?? [];
    const images = task.mode === "text2img" ? [] : task.model === "agnes-image-2.0-flash"
      ? await Promise.all(sourceAssets.map(fileToBase64))
      : await Promise.all(sourceAssets.map((asset) => uploadToImgBB(asset, imgbbKey)));
    return buildImagePayload(task, images);
  }

  const isFlash = task.model === "agnes-video-2.5-flash";
  const media: { images?: string[]; audios?: string[]; firstFrame?: string; lastFrame?: string } = {};
  if (task.mode === "reference_no_audio" || task.mode === "reference_with_audio") {
    const assets = task.imageAssets ?? [];
    if (assets.length) media.images = isFlash ? await Promise.all(assets.map(fileToBase64)) : [await uploadToImgBB(assets[0], imgbbKey)];
    if (task.mode === "reference_with_audio" && isFlash && task.audioAssets?.length) media.audios = await Promise.all(task.audioAssets.map(fileToBase64));
  }
  if (task.mode === "keyframe") {
    if (isFlash) {
      if (task.firstFrame) media.firstFrame = await fileToBase64(task.firstFrame);
      if (task.lastFrame) media.lastFrame = await fileToBase64(task.lastFrame);
    } else {
      const frames = await Promise.all([task.firstFrame, task.lastFrame].filter(Boolean).map((asset) => uploadToImgBB(asset as FileAsset, imgbbKey)));
      media.firstFrame = frames[0];
      media.lastFrame = frames[1];
    }
  }
  return buildVideoPayload(task, media);
}

export async function saveResultLocally(resultUrl: string, task: GenerationTask) {
  if (Platform.OS === "web" || !FileSystem.documentDirectory) return undefined;
  try {
    if (Platform.OS === "android") {
      let nativeUri: string | undefined;
      try {
        nativeUri = await saveResultToMediaStore(resultUrl, task.id, task.kind);
      } catch {
        nativeUri = undefined;
      }
      if (nativeUri) return nativeUri;

      // Fallback for APKs where the custom bridge is unavailable: reuse an existing
      // full gallery grant and let expo-media-library insert the downloaded asset.
      const permission = await MediaLibrary.getPermissionsAsync(false, ["photo", "video"]);
      if (!permission.granted) {
        const requested = await MediaLibrary.requestPermissionsAsync(false, ["photo", "video"]);
        if (!requested.granted) return undefined;
      }
      const extension = task.kind === "video" ? "mp4" : "png";
      const destination = `${FileSystem.cacheDirectory}agnes-${task.id}.${extension}`;
      const downloaded = await FileSystem.downloadAsync(resultUrl, destination);
      const asset = await MediaLibrary.createAssetAsync(downloaded.uri);
      const albumName = "Agnes-AI";
      const album = await MediaLibrary.getAlbumAsync(albumName);
      if (album) await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      else await MediaLibrary.createAlbumAsync(albumName, asset, false);
      return asset.uri;
    }
    const folder = `${FileSystem.documentDirectory}agnes-ai/`;
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    const extension = task.kind === "video" ? "mp4" : "png";
    const destination = `${folder}${task.id}.${extension}`;
    const downloaded = await FileSystem.downloadAsync(resultUrl, destination);
    return downloaded.uri;
  } catch {
    return undefined;
  }
}

export async function submitImage(task: GenerationTask, apiKey: string, imgbbKey: string): Promise<SubmitResult> {
  const payload = buildImagePayload(task);

  if (task.mode !== "text2img") {
    const sourceAssets = task.mode === "face_swap"
      ? [task.targetImage, task.faceImage].filter(Boolean) as FileAsset[]
      : task.imageAssets ?? [];
    if (!sourceAssets.length) throw new AgnesApiError("Для выбранного режима не добавлены исходные изображения.");

    const images = task.model === "agnes-image-2.0-flash"
      ? await Promise.all(sourceAssets.map(fileToBase64))
      : await Promise.all(sourceAssets.map((asset) => uploadToImgBB(asset, imgbbKey)));
    (payload.extra_body as Record<string, unknown>).image = images;
  }

  const data = await agnesRequest("/images/generations", apiKey, payload);
  const first = data?.data?.[0];
  const resultUrl = first?.url || first?.image_url;
  if (!resultUrl) throw new AgnesApiError("API ответил без ссылки на изображение.");
  return { serverId: String(data?.id || `image-${Date.now()}`), resultUrl: String(resultUrl), payloadSummary: JSON.stringify({ model: payload.model, mode: task.mode, size: payload.size }) };
}

export async function submitVideo(task: GenerationTask, apiKey: string, imgbbKey: string): Promise<SubmitResult> {
  const isFlash = task.model === "agnes-video-2.5-flash";
  const payload = buildVideoPayload(task);

  if (task.mode === "reference_no_audio" || task.mode === "reference_with_audio") {
    const assets = task.imageAssets ?? [];
    if (assets.length) {
      if (isFlash) payload.images = await Promise.all(assets.map(fileToBase64));
      else payload.image = await uploadToImgBB(assets[0], imgbbKey);
    }
    if (task.mode === "reference_with_audio" && isFlash && task.audioAssets?.length) {
      payload.audios = await Promise.all(task.audioAssets.map(fileToBase64));
    }
  }

  if (task.mode === "keyframe") {
    if (!task.firstFrame && !task.lastFrame) throw new AgnesApiError("Добавьте начальный или конечный кадр.");
    if (isFlash) {
      if (task.firstFrame) payload.first_frame = await fileToBase64(task.firstFrame);
      if (task.lastFrame) payload.last_frame = await fileToBase64(task.lastFrame);
    } else {
      const frames = await Promise.all([task.firstFrame, task.lastFrame].filter(Boolean).map((asset) => uploadToImgBB(asset as FileAsset, imgbbKey)));
      payload.extra_body = { image: frames, mode: "keyframes" };
    }
  }

  const data = await agnesRequest("/videos", apiKey, payload);
  const serverId = data?.video_id || data?.id;
  if (!serverId) throw new AgnesApiError("API не вернул video_id.");
  return { serverId: String(serverId), payloadSummary: JSON.stringify({ model: payload.model, mode: payload.mode, seconds: payload.seconds || task.seconds || 5 }) };
}

export async function pollVideo(videoId: string, apiKey: string, model?: string) {
  const url = new URL(AGNES_VIDEO_POLL);
  url.searchParams.set("video_id", videoId);
  if (model) url.searchParams.set("model_name", model);
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) {
    const error = await readError(response);
    throw new AgnesApiError(error.message, { code: response.status, retryable: isRetryableStatus(response.status), responseBody: error.body });
  }
  const data = await response.json();
  const status = String(data?.status || "processing").toLowerCase();
  const resultUrl = data?.metadata?.url || data?.url || data?.video_url;
  if (status === "failed") {
    const message = data?.error?.message || data?.error || "Сервер сообщил об ошибке генерации.";
    throw new AgnesApiError(String(message), { code: data?.error?.code, retryable: false });
  }
  return { status, resultUrl: resultUrl ? String(resultUrl) : undefined, raw: data };
}
