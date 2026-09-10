const EMAIL_READER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: http: https:",
].join("; ");

const EMAIL_READER_STYLES = `
:root {
  color-scheme: light only;
  background: #ffffff;
}

html,
body {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin: 0;
  overflow-x: hidden;
  background: #ffffff;
}

body {
  padding: 16px;
  color: #202124;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  word-break: normal;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body :where(a) {
  overflow-wrap: anywhere;
  word-break: break-word;
}

@media (max-width: 480px) {
  body {
    padding: 12px;
    font-size: 15px;
  }
}
`;

// Keep these rules after sender CSS in cascade order. `!important` is
// deliberate: fixed desktop widths are the one part of sender presentation we
// must override so the message remains readable within the phone viewport.
const EMAIL_READER_RESPONSIVE_OVERRIDES = `
html,
body {
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  overflow-x: hidden !important;
}

body * {
  max-width: 100% !important;
  min-width: 0 !important;
}

body :where(img, video) {
  max-width: 100% !important;
  height: auto !important;
}

body :where(pre) {
  white-space: pre-wrap !important;
}

body :where(a, td, th) {
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

@media (max-width: 480px) {
  body :where(blockquote) {
    margin-inline: 0 !important;
    padding-inline-start: 12px;
  }
}
`;

/**
 * Places sanitized sender markup in an isolated, light document. Email HTML
 * commonly assumes a white canvas and a 600px desktop layout; rendering it in
 * Groovy's dark application DOM causes inherited colors and fixed widths to
 * become unreadable on phones.
 */
export function buildEmailReaderDocument(sanitizedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Content-Security-Policy" content="${EMAIL_READER_CSP}">
  <style>${EMAIL_READER_STYLES}</style>
</head>
<body>${sanitizedHtml}<style data-groovy-email-reader>${EMAIL_READER_RESPONSIVE_OVERRIDES}</style></body>
</html>`;
}
