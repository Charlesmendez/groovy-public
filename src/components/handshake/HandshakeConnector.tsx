"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { HandshakeState } from "@/hooks/useMultiAgent";

type HandshakeConnectorProps = {
  /** Map of paneId → HandshakeState */
  handshakes: Map<string, HandshakeState>;
  /** Container element that holds the pane grid (for offset calculations) */
  containerRef: React.RefObject<HTMLElement | null>;
};

type LineEndpoints = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isActive: boolean;
  handshakeId: string;
};

/**
 * SVG overlay that draws animated connection lines between handshake-connected panes.
 * Renders as a portal over the grid container.
 */
export function HandshakeConnector({ handshakes, containerRef }: HandshakeConnectorProps) {
  const [lines, setLines] = useState<LineEndpoints[]>([]);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const rafRef = useRef<number>(0);
  const svgRef = useRef<SVGSVGElement>(null);

  const computeLines = useCallback(() => {
    if (!containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const processedHandshakeIds = new Set<string>();
    const newLines: LineEndpoints[] = [];

    handshakes.forEach((hs, paneId) => {
      // Only process each handshake pair once
      if (processedHandshakeIds.has(hs.handshakeId)) return;
      processedHandshakeIds.add(hs.handshakeId);

      const paneAEl = document.querySelector(`[data-pane-id="${paneId}"]`);
      const paneBEl = document.querySelector(`[data-pane-id="${hs.partnerPaneId}"]`);
      if (!paneAEl || !paneBEl) return;

      const rectA = paneAEl.getBoundingClientRect();
      const rectB = paneBEl.getBoundingClientRect();

      // Connect from center of each pane's header area
      const x1 = rectA.left + rectA.width / 2 - containerRect.left;
      const y1 = rectA.top + 20 - containerRect.top;
      const x2 = rectB.left + rectB.width / 2 - containerRect.left;
      const y2 = rectB.top + 20 - containerRect.top;

      const isActive = hs.status === "collaborating" || hs.status === "waiting";

      newLines.push({ x1, y1, x2, y2, isActive, handshakeId: hs.handshakeId });
    });

    setLines(newLines);
  }, [handshakes, containerRef]);

  // Recompute line positions on handshake changes and on scroll/resize
  useEffect(() => {
    setPortalContainer(containerRef.current);
    computeLines();

    const handleUpdate = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(computeLines);
    };

    window.addEventListener("resize", handleUpdate);
    window.addEventListener("scroll", handleUpdate, true);

    // Also observe layout shifts via MutationObserver on grid container
    let observer: MutationObserver | null = null;
    if (containerRef.current) {
      observer = new MutationObserver(handleUpdate);
      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", handleUpdate);
      window.removeEventListener("scroll", handleUpdate, true);
      observer?.disconnect();
    };
  }, [computeLines, containerRef]);

  if (lines.length === 0 || !portalContainer) return null;

  return createPortal(
    <svg
      ref={svgRef}
      className="absolute inset-0 pointer-events-none z-10"
      style={{ width: "100%", height: "100%", overflow: "visible" }}
    >
      <defs>
        {/* Animated dash pattern */}
        <linearGradient id="handshake-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(249,115,22,0.6)" />
          <stop offset="50%" stopColor="rgba(251,146,60,0.8)" />
          <stop offset="100%" stopColor="rgba(249,115,22,0.6)" />
        </linearGradient>

        {/* Glow filter */}
        <filter id="handshake-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {lines.map((line) => {
        // Compute a gentle curve using a quadratic bezier
        const midX = (line.x1 + line.x2) / 2;
        const midY = (line.y1 + line.y2) / 2;
        const dx = line.x2 - line.x1;
        const dy = line.y2 - line.y1;
        // Curve offset perpendicular to the line
        const dist = Math.sqrt(dx * dx + dy * dy);
        const curveOffset = Math.min(dist * 0.15, 40);
        const nx = -dy / (dist || 1);
        const ny = dx / (dist || 1);
        const cx = midX + nx * curveOffset;
        const cy = midY + ny * curveOffset;
        const pathD = `M ${line.x1} ${line.y1} Q ${cx} ${cy} ${line.x2} ${line.y2}`;

        return (
          <g key={line.handshakeId}>
            {/* Background glow */}
            <path
              d={pathD}
              fill="none"
              stroke="rgba(249,115,22,0.15)"
              strokeWidth="6"
              filter="url(#handshake-glow)"
            />
            {/* Main line */}
            <path
              d={pathD}
              fill="none"
              stroke="url(#handshake-gradient)"
              strokeWidth="1.5"
              strokeDasharray={line.isActive ? "5 5" : "6 6"}
              strokeLinecap="round"
              opacity={line.isActive ? 0.75 : 0.45}
            />
            {/* Endpoint dots */}
            <circle cx={line.x1} cy={line.y1} r="2.5" fill="rgba(249,115,22,0.55)" />
            <circle cx={line.x2} cy={line.y2} r="2.5" fill="rgba(249,115,22,0.55)" />
          </g>
        );
      })}
    </svg>,
    portalContainer
  );
}
