export const SEED_CANVAS_HTML = `<!doctype html>
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
main{width:100%;max-width:60ch;display:grid;gap:24px}
.hello{opacity:.55;letter-spacing:.02em}
form{width:100%}
input[type=text]{width:100%;background:transparent;color:inherit;font:inherit;
  border:0;border-bottom:1px solid #2a2a2a;padding:14px 0;outline:none;
  -webkit-appearance:none;border-radius:0}
input[type=text]::placeholder{color:#666}
input[type=text]:focus{border-color:#888}
.hint{opacity:.35;font-size:13px;margin-top:-8px}
</style>
</head>
<body>
<main>
  <div class="hello">a blank space, for you and me to fill</div>
  <form action="/api/live/turn" method="post" target="_self">
    <input type="hidden" name="intent" value="user_message">
    <input
      type="text"
      name="text"
      placeholder="ask me anything"
      inputmode="text"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      required
    >
  </form>
  <div class="hint">press enter</div>
</main>
</body>
</html>
`;
