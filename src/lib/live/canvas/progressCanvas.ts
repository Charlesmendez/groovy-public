import { escapeHtml } from "./errorCanvas";
import { CANVAS_CSP_HEADER } from "./sanitize";

export function renderProgressStart(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CANVAS_CSP_HEADER)}">
<title>live</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#080808;color:#eeeae1;
  font:15px/1.55 ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
body{min-height:100dvh;display:grid;place-items:center;padding:28px}
#live-progress-root{width:min(680px,88vw);display:grid;gap:18px}
#live-progress-root .label{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(238,234,225,.42)}
#live-progress-root .log{display:grid;gap:10px}
#live-progress-root .line{opacity:.72;transform:translateY(3px);animation:enter .28s ease-out forwards}
#live-progress-root .line:before{content:"";display:inline-block;width:7px;height:7px;margin-right:12px;
  border:1px solid rgba(238,234,225,.55);transform:rotate(45deg)}
#live-progress-root .line[data-kind="done"]{opacity:1;color:#fff}
#live-progress-root .line[data-kind="warn"]{color:#e8d6a8}
#live-progress-root .cursor{width:9ch;color:rgba(238,234,225,.38);overflow:hidden;white-space:nowrap;
  animation:typing 1.2s steps(9,end) infinite}
#live-progress-root a{color:inherit;text-underline-offset:4px}
#live-progress-root form{margin-top:8px}
#live-progress-root input[type=text]{width:100%;background:transparent;color:inherit;font:inherit;
  border:0;border-bottom:1px solid #333;padding:12px 0;outline:none}
#live-progress-root input[type=text]:focus{border-color:#888}
@keyframes enter{to{opacity:1;transform:translateY(0)}}
@keyframes typing{0%,100%{width:2ch}50%{width:9ch}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important}}
</style>
</head>
<body>
<main id="live-progress-root">
  <div class="label">live</div>
  <section class="log" aria-live="polite">`;
}

export function renderProgressLine(text: string, kind: "info" | "warn" | "done" = "info"): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const safeText = compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
  return `<div class="line" data-kind="${kind}">${escapeHtml(safeText)}</div>`;
}

export function renderProgressStillWorking(): string {
  return `<div class="cursor">thinking</div>`;
}

export function renderProgressFinish(finalCanvasHtml: string): string {
  const styles = extractStyleBlocks(finalCanvasHtml);
  const body = extractBodyHtml(finalCanvasHtml) || renderInlineFallback(finalCanvasHtml);

  return `${renderProgressLine("opening the canvas", "done")}
  </section>
</main>
<style>
#live-progress-root{display:none!important}
body{display:block;padding:0;overflow:auto}
</style>
${styles}
${body}
</body>
</html>`;
}

export function renderProgressRedirect(resultUrl: string): string {
  return `${renderProgressLine("opening the canvas", "done")}
  <a href="${escapeAttr(resultUrl)}" target="_self">open canvas</a>
</section>
</main>
</body>
</html>`;
}

export function renderProgressFailure(message: string): string {
  return `${renderProgressLine(message, "warn")}
  <form action="/api/live/turn" method="post" target="_self">
    <input type="hidden" name="intent" value="retry">
    <input type="text" name="text" placeholder="try again" required>
  </form>
</section>
</main>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function extractBodyHtml(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return match?.[1]?.trim() ?? "";
}

function extractStyleBlocks(html: string): string {
  return (html.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) ?? []).join("\n");
}

function renderInlineFallback(html: string): string {
  return `<main style="min-height:100dvh;display:grid;place-items:center;padding:24px">
<pre style="white-space:pre-wrap;max-width:80ch">${escapeHtml(html.slice(0, 4000))}</pre>
</main>`;
}
