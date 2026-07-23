import { type NextRequest, NextResponse } from "next/server";

/**
 * Bind the widget document to the origin declared by the loader. The API also
 * checks that origin against the publishable key allowlist. Together these
 * prevent another site from replaying an embed URL while claiming an allowed
 * parentOrigin.
 */
export function proxy(request: NextRequest) {
  const rawParentOrigin = request.nextUrl.searchParams.get("parentOrigin") || "";
  let parentOrigin = "";
  try {
    const parsed = new URL(rawParentOrigin);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      parentOrigin = parsed.origin;
    }
  } catch {}

  const response = NextResponse.next();
  response.headers.set(
    "Content-Security-Policy",
    `frame-ancestors ${parentOrigin || "'none'"}`,
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  matcher: ["/widget/:path*"],
};
