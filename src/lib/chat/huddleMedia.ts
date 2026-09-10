export function canExpandHuddleScreenShare({
  hasVideo,
  screenSharing,
}: {
  hasVideo: boolean;
  screenSharing: boolean;
}): boolean {
  return hasVideo && screenSharing;
}

export function huddleVideoObjectFit(
  screenSharing: boolean,
): "object-contain" | "object-cover" {
  return screenSharing ? "object-contain" : "object-cover";
}
