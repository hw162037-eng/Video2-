import { describe, expect, it } from "vitest";

import { buildImagePayload, buildVideoPayload, isRetryableStatus, retryDelaySeconds } from "../lib/api-policy";
import { explainError, AgnesApiError } from "../lib/error-policy";
import { formatTaskDuration } from "../lib/task-time";
import { imageRatioLabel, nearestImageRatio } from "../lib/image-ratio";

const baseTask = (patch = {}) => ({
  id: "test-task",
  kind: "video",
  profileId: "profile-1",
  profileName: "Test",
  model: "agnes-video-2.5-flash",
  mode: "text",
  prompt: "A test scene",
  status: "queued",
  stage: "queued",
  progress: 0,
  createdAt: 1,
  updatedAt: 1,
  attempts: 0,
  ...patch,
});

describe("Agnes API policy", () => {
  it("builds 2.5 Flash video payload with string seconds", () => {
    const body = buildVideoPayload(baseTask({ seconds: 5 }));
    expect(body.model).toBe("agnes-video-2.5-flash");
    expect(body.mode).toBe("text");
    expect(body.seconds).toBe("5");
    expect(body.size).toBe("720P");
  });

  it("builds text-to-image payload with URL response format", () => {
    const body = buildImagePayload(baseTask({ kind: "image", model: "agnes-image-2.1-flash", mode: "text2img", size: "1K", ratio: "16:9" }));
    expect(body.model).toBe("agnes-image-2.1-flash");
    expect(body.ratio).toBe("16:9");
    expect(body.extra_body.response_format).toBe("url");
  });

  it("supports Image 2.5 Flash from the HTML studio", () => {
    const body = buildImagePayload(baseTask({ kind: "image", model: "agnes-image-2.5-flash", mode: "text2img" }));
    expect(body.model).toBe("agnes-image-2.5-flash");
    expect(body.size).toBe("1K");
    expect(body.ratio).toBe("1:1");
  });

  it("keeps Free rate-limit policy and exponential retry ceiling", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect([retryDelaySeconds(30, 1), retryDelaySeconds(30, 2), retryDelaySeconds(30, 3)]).toEqual([30, 60, 120]);
    expect(retryDelaySeconds(30, 10)).toBe(900);
  });

  it("clamps video duration to Agnes model and resolution limits", () => {
    expect(buildVideoPayload(baseTask({ seconds: 20 })).seconds).toBe("12");
    expect(buildVideoPayload(baseTask({ model: "agnes-video-v2.0", seconds: 20, size: "720P" })).num_frames).toBe(361);
    expect(buildVideoPayload(baseTask({ model: "agnes-video-v2.0", seconds: 20, size: "1080P" })).num_frames).toBe(241);
  });

  it("explains RPM errors and preserves custom error details", () => {
    expect(explainError(baseTask({ errorCode: 429, errorMessage: "Too many requests" }))).toContain("RPM");
    const error = new AgnesApiError("Invalid payload", { code: 400, retryable: false });
    expect(error.code).toBe(400);
    expect(error.retryable).toBe(false);
  });

  it("formats live and final generation time", () => {
    expect(formatTaskDuration(0)).toBe("00:00");
    expect(formatTaskDuration(125000)).toBe("02:05");
    expect(formatTaskDuration(3723000)).toBe("1:02:03");
  });

  it("detects source image proportions without distortion", () => {
    expect(nearestImageRatio(4032, 3024)).toBe("4:3");
    expect(nearestImageRatio(1080, 1920)).toBe("9:16");
    expect(imageRatioLabel(4032, 3024)).toContain("4:3");
  });
});
