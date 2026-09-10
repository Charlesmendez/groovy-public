import type { AppAreaHref } from "@/lib/navigation/appArea";

export const APP_AREA_ATTENTION_EVENT = "groovy:app-area-attention";

export type AppAttentionArea = "chat" | "email";

export type AppAreaAttentionDetail = {
  area: AppAttentionArea;
  count: number;
};

const attentionSnapshot: Record<AppAttentionArea, number> = {
  chat: 0,
  email: 0,
};

export function normalizeAppAreaAttentionCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function appAttentionAreaForHref(
  href: AppAreaHref,
): AppAttentionArea | null {
  if (href === "/chat") return "chat";
  if (href === "/email") return "email";
  return null;
}

export function appAreaAttentionDetail(
  value: unknown,
): AppAreaAttentionDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  if (detail.area !== "chat" && detail.area !== "email") return null;
  return {
    area: detail.area,
    count: normalizeAppAreaAttentionCount(detail.count),
  };
}

export function readAppAreaAttention(): Record<AppAttentionArea, number> {
  return { ...attentionSnapshot };
}

export function publishAppAreaAttention(
  area: AppAttentionArea,
  count: unknown,
): void {
  const normalizedCount = normalizeAppAreaAttentionCount(count);
  attentionSnapshot[area] = normalizedCount;
  window.dispatchEvent(
    new CustomEvent<AppAreaAttentionDetail>(APP_AREA_ATTENTION_EVENT, {
      detail: {
        area,
        count: normalizedCount,
      },
    }),
  );
}
