(() => {
  const script = document.currentScript;
  if (!script) return;
  const harness = script.getAttribute("data-harness") || "";
  const key = script.getAttribute("data-key") || "";
  if (!harness || !key) {
    console.error("[Groovy widget] data-harness and data-key are required");
    return;
  }

  const base = new URL(script.src, window.location.href).origin;
  const color = script.getAttribute("data-color") || "#06b6d4";
  const label = script.getAttribute("data-label") || "Chat";
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", `Open ${label}`);
  Object.assign(button.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483646",
    border: "0",
    borderRadius: "999px",
    background: color,
    color: "#fff",
    padding: "13px 18px",
    font: "600 14px system-ui, sans-serif",
    boxShadow: "0 12px 32px rgba(0,0,0,.25)",
    cursor: "pointer",
  });
  button.textContent = `✦ ${label}`;

  const iframe = document.createElement("iframe");
  iframe.title = label;
  iframe.src = `${base}/widget/${encodeURIComponent(harness)}?key=${encodeURIComponent(
    key,
  )}&parentOrigin=${encodeURIComponent(window.location.origin)}`;
  iframe.allow = "clipboard-write";
  Object.assign(iframe.style, {
    display: "none",
    position: "fixed",
    right: "20px",
    bottom: "82px",
    zIndex: "2147483646",
    width: "min(390px, calc(100vw - 32px))",
    height: "min(620px, calc(100vh - 110px))",
    border: "0",
    borderRadius: "18px",
    background: "#fff",
    boxShadow: "0 18px 60px rgba(0,0,0,.3)",
  });

  let open = false;
  button.addEventListener("click", () => {
    open = !open;
    iframe.style.display = open ? "block" : "none";
    button.textContent = open ? "Close" : `✦ ${label}`;
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== base || event.source !== iframe.contentWindow) return;
    if (event.data?.type !== "groovy-widget-resize") return;
    const height = Number(event.data.height);
    if (Number.isFinite(height)) {
      iframe.style.height = `${Math.max(320, Math.min(620, height))}px`;
    }
  });

  document.body.appendChild(iframe);
  document.body.appendChild(button);
})();
