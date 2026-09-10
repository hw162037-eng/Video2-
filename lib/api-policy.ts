import type { GenerationTask } from "./types";

export function isRetryableStatus(status: number) {
  return [408, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

export function retryDelaySeconds(baseSeconds: number, attempt: number) {
  return Math.min(Math.max(1, baseSeconds) * 2 ** Math.max(0, attempt - 1), 15 * 60);
}

export function buildImagePayload(task: GenerationTask, images: string[] = []) {
  const payload: Record<string, unknown> = {
    model: task.model,
    prompt: task.prompt,
    extra_body: { response_format: "url" },
  };
  if (task.model === "agnes-image-2.0-flash") payload.size = task.size || (task.ratio === "1:1" ? "1024x1024" : ["9:16", "3:4"].includes(task.ratio ?? "") ? "768x1024" : "1024x768");
  else {
    payload.size = task.size || "1K";
    payload.ratio = task.ratio || "1:1";
  }
  if (task.mode !== "text2img") (payload.extra_body as Record<string, unknown>).image = images;
  return payload;
}

export function buildVideoPayload(task: GenerationTask, media: { images?: string[]; audios?: string[]; firstFrame?: string; lastFrame?: string } = {}) {
  const isFlash = task.model === "agnes-video-2.5-flash";
  const apiMode = task.mode.startsWith("reference") ? (isFlash ? "reference" : "ti2vid") : task.mode === "keyframe" ? (isFlash ? "keyframe" : "keyframes") : "text";
  const seconds = Math.min(Number(task.seconds || 5), isFlash ? 12 : task.size === "1080P" ? 10 : 15);
  const payload: Record<string, unknown> = {
    model: task.model,
    prompt: task.prompt,
    mode: apiMode,
    aspect_ratio: task.ratio || "16:9",
    n: 1,
    size: isFlash ? "720P" : task.size || "720P",
  };
  if (task.seed !== undefined) payload.seed = task.seed;
  if (isFlash) payload.seconds = String(seconds);
  else {
    payload.num_frames = seconds * 24 + 1;
    payload.frame_rate = 24;
  }
  if (task.mode === "reference_no_audio" || task.mode === "reference_with_audio") {
    if (isFlash && media.images?.length) payload.images = media.images;
    else if (media.images?.[0]) payload.image = media.images[0];
    if (task.mode === "reference_with_audio" && isFlash && media.audios?.length) payload.audios = media.audios;
  }
  if (task.mode === "keyframe") {
    if (isFlash) {
      if (media.firstFrame) payload.first_frame = media.firstFrame;
      if (media.lastFrame) payload.last_frame = media.lastFrame;
    } else payload.extra_body = { image: [media.firstFrame, media.lastFrame].filter(Boolean), mode: "keyframes" };
  }
  return payload;
}
