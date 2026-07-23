import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { WikiClient } from "@/lib/live/wiki/client";
import { ensureWikiBootstrapped } from "@/lib/live/wiki/bootstrap";
import { injectCanvasCspMeta, sanitizeCanvasHtml } from "@/lib/live/canvas/sanitize";
import { renderErrorCanvas } from "@/lib/live/canvas/errorCanvas";
import { getWorkingCanvasTurnId } from "@/lib/live/canvas/workingCanvas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function LivePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/live");
  }

  const wiki = new WikiClient(supabase, user.id);
  const { canvasHtml } = await ensureWikiBootstrapped(wiki);
  const pendingTurnId = getWorkingCanvasTurnId(canvasHtml);
  const canvasSrcDoc = pendingTurnId
    ? injectCanvasCspMeta(
        renderErrorCanvas("That turn stopped before finishing.", { withRetry: true })
      )
    : injectCanvasCspMeta(sanitizeCanvasHtml(canvasHtml).html);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0a0a0a",
        margin: 0,
        padding: 0,
        overflow: "hidden",
      }}
    >
      {/* allow-forms so the canvas can submit. allow-same-origin so the
          auth cookie flows to /api/live/turn under SameSite=Lax. Crucially
          NOT allow-scripts: no JS can run in the canvas. Sandbox + a CSP
          meta in srcDoc + the /api/live/turn CSP header are the defense
          layers against hostile HTML. */}
      <iframe
        title="live"
        srcDoc={canvasSrcDoc}
        sandbox="allow-forms allow-same-origin"
        style={{
          width: "100%",
          height: "100%",
          border: 0,
          display: "block",
          background: "#0a0a0a",
        }}
      />
    </div>
  );
}
