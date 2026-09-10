export type ChatMessageMenuPlacement = "above" | "below";

export function chatMessageMenuPlacement({
  rootTop,
  rootBottom,
  viewportHeight,
  estimatedMenuHeight = 260,
}: {
  rootTop: number;
  rootBottom: number;
  viewportHeight: number;
  estimatedMenuHeight?: number;
}): ChatMessageMenuPlacement {
  const roomAbove = rootTop - 8;
  const roomBelow = viewportHeight - rootBottom - 8;

  if (roomAbove >= estimatedMenuHeight) return "above";
  if (roomBelow >= estimatedMenuHeight) return "below";
  return roomAbove >= roomBelow ? "above" : "below";
}
