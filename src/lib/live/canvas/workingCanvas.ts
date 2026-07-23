import { escapeHtml } from "./errorCanvas";
import { CANVAS_CSP_HEADER } from "./sanitize";

const PENDING_ATTR = "data-live-pending-turn";

export function renderWorkingCanvas(args: {
  turnId: string;
  refreshUrl?: string;
  label?: string;
}): string {
  const refresh = args.refreshUrl
    ? `<meta http-equiv="refresh" content="2;url=${escapeAttr(args.refreshUrl)}">`
    : "";
  const label = args.label || "working the next canvas into shape";
  const escapedTurnId = escapeAttr(args.turnId);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CANVAS_CSP_HEADER)}">
${refresh}
<title>live</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#080808;color:#ece7dc;
  font:15px/1.5 ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
body{min-height:100dvh;display:grid;place-items:center;overflow:hidden}
.field{position:relative;width:min(720px,86vw);height:min(420px,70vh);
  display:grid;place-items:center}
.field:before{content:"";position:absolute;inset:0;
  background:
    linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px),
    linear-gradient(0deg,rgba(255,255,255,.05) 1px,transparent 1px);
  background-size:44px 44px;mask-image:radial-gradient(circle at center,#000 0 42%,transparent 72%);
  animation:breathe 3.8s ease-in-out infinite}
.trace{position:absolute;left:8%;right:8%;top:50%;height:1px;background:rgba(236,231,220,.14);
  overflow:hidden}
.trace:after{content:"";position:absolute;width:34%;height:1px;left:-35%;
  background:linear-gradient(90deg,transparent,#ece7dc,transparent);
  animation:trace 2.2s cubic-bezier(.65,0,.25,1) infinite}
.node{position:absolute;width:7px;height:7px;border:1px solid rgba(236,231,220,.44);
  transform:rotate(45deg);animation:pulse 2.8s ease-in-out infinite}
.n1{left:16%;top:28%;animation-delay:.1s}.n2{left:31%;top:63%;animation-delay:.5s}
.n3{left:45%;top:24%;animation-delay:.9s}.n4{left:57%;top:72%;animation-delay:1.2s}
.n5{left:71%;top:36%;animation-delay:.35s}.n6{left:84%;top:58%;animation-delay:1.6s}
.card{position:relative;text-align:center;display:grid;gap:12px;justify-items:center;
  padding:28px 20px;background:radial-gradient(circle at center,rgba(8,8,8,.84),rgba(8,8,8,.28) 70%,transparent)}
.mark{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(236,231,220,.45)}
.line{font-size:clamp(20px,4vw,42px);letter-spacing:0;color:#f4efe5}
.dots{display:flex;gap:9px;margin-top:2px}
.dots span{width:5px;height:5px;border-radius:999px;background:#ece7dc;opacity:.22;
  animation:dot 1.3s ease-in-out infinite}
.dots span:nth-child(2){animation-delay:.18s}.dots span:nth-child(3){animation-delay:.36s}
@keyframes trace{to{left:105%}}
@keyframes pulse{0%,100%{opacity:.18;transform:rotate(45deg) scale(.7)}
  50%{opacity:.9;transform:rotate(45deg) scale(1.25)}}
@keyframes dot{0%,100%{opacity:.18;transform:translateY(0)}50%{opacity:.9;transform:translateY(-4px)}}
@keyframes breathe{0%,100%{opacity:.24;transform:scale(.98)}50%{opacity:.52;transform:scale(1.02)}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important}}
</style>
</head>
<body ${PENDING_ATTR}="${escapedTurnId}">
<main class="field" aria-live="polite">
  <div class="trace"></div>
  <i class="node n1"></i><i class="node n2"></i><i class="node n3"></i>
  <i class="node n4"></i><i class="node n5"></i><i class="node n6"></i>
  <section class="card">
    <div class="mark">live</div>
    <div class="line">${escapeHtml(label)}</div>
    <div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
  </section>
</main>
</body>
</html>`;
}

export function isWorkingCanvasForTurn(html: string, turnId: string): boolean {
  return getWorkingCanvasTurnId(html) === turnId;
}

export function getWorkingCanvasTurnId(html: string): string | null {
  const match = html.match(new RegExp(`\\s${PENDING_ATTR}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, "i"));
  const turnId = (match?.[1] ?? match?.[2] ?? "").trim();
  return /^[a-f0-9-]{36}$/i.test(turnId) ? turnId : null;
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
