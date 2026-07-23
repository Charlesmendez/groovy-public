export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderErrorCanvas(
  message: string,
  options: { withRetry?: boolean } = {}
): string {
  const retryForm = options.withRetry
    ? `<form action="/api/live/turn" method="post" target="_self">
<input type="hidden" name="intent" value="retry">
<input type="text" name="text" placeholder="try again" required>
</form>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>live</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;background:#0a0a0a;color:#eaeaea;
  font:16px/1.45 ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
body{min-height:100dvh;display:grid;place-items:center;padding:24px}
main{max-width:60ch;display:grid;gap:16px;width:100%}
.tag{opacity:.5}
input[type=text]{width:100%;background:transparent;color:inherit;font:inherit;
  border:0;border-bottom:1px solid #2a2a2a;padding:14px 0;outline:none;
  -webkit-appearance:none;border-radius:0}
input[type=text]:focus{border-color:#888}
</style>
</head>
<body><main>
<div class="tag">// something broke on my end</div>
<div>${escapeHtml(message)}</div>
${retryForm}
</main></body></html>`;
}
