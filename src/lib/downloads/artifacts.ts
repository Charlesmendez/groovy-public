import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function hashRequestValue(value: string | null): string | null {
  if (!value?.trim()) return null;
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

export function toStorageReference(value: unknown): { bucket: string; path: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:supabase|storage):\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    bucket: match[1],
    path: match[2],
  };
}

export function buildStorageReference(bucket?: string | null, path?: string | null): string | null {
  const cleanBucket = typeof bucket === "string" ? bucket.trim() : "";
  const cleanPath = typeof path === "string" ? path.trim().replace(/^\/+/, "") : "";
  if (!cleanBucket || !cleanPath) return null;
  return `supabase://${cleanBucket}/${cleanPath}`;
}

export async function signedArtifactUrl(
  admin: SupabaseClient,
  value: unknown,
  expiresInSeconds = 15 * 60
): Promise<string | null> {
  if (typeof value !== "string" || !value.trim()) return null;
  const ref = toStorageReference(value);
  if (!ref) return value.trim();
  const { data, error } = await admin.storage
    .from(ref.bucket)
    .createSignedUrl(ref.path, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
