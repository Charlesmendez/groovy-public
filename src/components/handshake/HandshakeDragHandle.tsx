"use client";

import { useCallback, useRef, useState } from "react";
import { Link2 } from "lucide-react";

type HandshakeDragHandleProps = {
  paneId: string;
  disabled?: boolean;
  onDragStart?: (paneId: string) => void;
  onDragEnd?: () => void;
};

/**
 * A small drag handle rendered in each pane header (multi-view only).
 * The user drags from one pane's handle and drops on another pane to
 * initiate a handshake connection.
 *
 * Uses HTML5 Drag & Drop with a custom dataTransfer type.
 */
export const HANDSHAKE_DRAG_TYPE = "application/x-groovy-handshake";

export function HandshakeDragHandle({
  paneId,
  disabled,
  onDragStart,
  onDragEnd,
}: HandshakeDragHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData(HANDSHAKE_DRAG_TYPE, paneId);
      e.dataTransfer.effectAllowed = "link";

      // Create a small custom drag image
      const ghost = document.createElement("div");
      ghost.style.cssText =
        "width:24px;height:24px;border-radius:50%;background:rgba(249,115,22,0.6);position:absolute;top:-999px;box-shadow:0 0 12px rgba(249,115,22,0.5);";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      requestAnimationFrame(() => document.body.removeChild(ghost));

      setIsDragging(true);
      onDragStart?.(paneId);
    },
    [paneId, disabled, onDragStart]
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    onDragEnd?.();
  }, [onDragEnd]);

  return (
    <div
      ref={handleRef}
      draggable={!disabled}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={`
        flex items-center justify-center w-6 h-6 rounded-md cursor-grab
        transition-all duration-200 shrink-0
        ${
          isDragging
            ? "bg-orange-500/20 text-orange-300 scale-110"
            : disabled
              ? "text-zinc-600 cursor-not-allowed opacity-40"
              : "text-zinc-500 hover:text-orange-400 hover:bg-orange-500/10"
        }
      `}
      title={disabled ? "Connect to another pane (needs a session)" : "Drag to connect to another pane"}
    >
      <Link2 className="w-3.5 h-3.5" />
    </div>
  );
}
