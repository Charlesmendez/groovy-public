/** Enforce the body budget and deadline while streaming, not just at headers. */
export async function readHomeJson(
  response: Pick<Response, "body" | "headers">,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > maxBytes
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("home_response_size");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("home_response_size");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
