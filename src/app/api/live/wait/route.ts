import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CANVAS_CSP_HEADER, sanitizeCanvasHtml } from "@/lib/live/canvas/sanitize";
import { renderErrorCanvas } from "@/lib/live/canvas/errorCanvas";
import { isWorkingCanvasForTurn } from "@/lib/live/canvas/workingCanvas";
import { WikiClient } from "@/lib/live/wiki/client";
import { WELL_KNOWN } from "@/lib/live/wiki/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) return htmlResponse(renderErrorCanvas("unauthorized"), 401);

  const url = new URL(req.url);
  const turnId = sanitizeTurnId(url.searchParams.get("turnId"));
  if (!turnId) return htmlResponse(renderErrorCanvas("missing live turn"), 400);

  const wiki = new WikiClient(supabase, user.id);
  const canvasHtml = (await wiki.read(WELL_KNOWN.canvas)) ?? "";
  if (isWorkingCanvasForTurn(canvasHtml, turnId)) {
    return htmlResponse(renderErrorCanvas("That turn stopped before finishing.", { withRetry: true }));
  }

  return htmlResponse(sanitizeCanvasHtml(canvasHtml || renderErrorCanvas("live canvas missing")).html);
}

function sanitizeTurnId(value: string | null): string | null {
  const raw = value?.trim() ?? "";
  return /^[a-f0-9-]{36}$/i.test(raw) ? raw : null;
}

function htmlResponse(html: string, status = 200): NextResponse {
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CANVAS_CSP_HEADER,
      "Referrer-Policy": "no-referrer",
    },
  });
}
