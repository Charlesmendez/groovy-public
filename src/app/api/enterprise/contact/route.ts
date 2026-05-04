import { NextResponse } from "next/server";
import { notifyEnterpriseSalesLead, type EnterpriseLead } from "@/lib/notifications/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asString(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson
    ? ((await req.json().catch(() => null)) as EnterpriseLead | null)
    : Object.fromEntries((await req.formData()).entries());
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const name = asString(body.name, 200);
  const email = asString(body.email, 320);
  const company = asString(body.company, 200);
  if (!name || !email || !company) {
    return NextResponse.json({ error: "name, email, and company are required" }, { status: 400 });
  }
  const notification = await notifyEnterpriseSalesLead(body);
  if (!isJson) {
    return NextResponse.redirect(new URL("/enterprise?submitted=1", req.url), 303);
  }
  return NextResponse.json({ ok: true, notification });
}
