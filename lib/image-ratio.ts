export const IMAGE_RATIO_OPTIONS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"] as const;
export type ImageRatio = (typeof IMAGE_RATIO_OPTIONS)[number];

const ratioValue = (ratio: string) => {
  const [width, height] = ratio.split(":").map(Number);
  return width / height;
};

export function nearestImageRatio(width?: number, height?: number): ImageRatio | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  const value = width / height;
  return IMAGE_RATIO_OPTIONS.reduce((closest, candidate) => Math.abs(ratioValue(candidate) - value) < Math.abs(ratioValue(closest) - value) ? candidate : closest, IMAGE_RATIO_OPTIONS[0]);
}

export function imageRatioLabel(width?: number, height?: number) {
  const ratio = nearestImageRatio(width, height);
  return ratio ? `${ratio} · ${width}×${height}` : "соотношение не определено";
}
