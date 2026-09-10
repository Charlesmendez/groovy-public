import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  CHAT_PROFILE_MAX_AVATAR_BYTES,
  socialSchemaUnavailable,
} from "@/lib/chat/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AVATAR_BUCKET = "chat_uploads";
const AVATAR_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

function cleanOptionalText(
  value: unknown,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function publicProfile(
  row: Record<string, unknown> | null,
  user: {
    id: string;
    email?: string | null;
    user_metadata?: Record<string, unknown>;
  },
) {
  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name
        : null;
  return {
    user_id: user.id,
    display_name:
      (typeof row?.display_name === "string" && row.display_name) ||
      metadataName ||
      user.email?.split("@")[0] ||
      "Teammate",
    has_avatar:
      typeof row?.avatar_path === "string" && row.avatar_path.length > 0,
    status_emoji:
      typeof row?.status_emoji === "string" ? row.status_emoji : null,
    status_text:
      typeof row?.status_text === "string" ? row.status_text : null,
    status_expires_at:
      typeof row?.status_expires_at === "string"
        ? row.status_expires_at
        : null,
    updated_at:
      typeof row?.updated_at === "string" ? row.updated_at : null,
  };
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("chat_member_profiles")
    .select(
      "user_id,display_name,avatar_path,status_emoji,status_text,status_expires_at,updated_at",
    )
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    if (socialSchemaUnavailable(error)) {
      return NextResponse.json({
        profile: publicProfile(null, user),
        migrationPending: true,
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    profile: publicProfile(data, user),
    migrationPending: false,
  });
}

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid profile" }, { status: 400 });
  }

  const displayName = cleanOptionalText(body.displayName, 80);
  const statusEmoji = cleanOptionalText(body.statusEmoji, 24);
  const statusText = cleanOptionalText(body.statusText, 120);
  let statusExpiresAt: string | null = null;
  if (body.statusExpiresAt !== null && body.statusExpiresAt !== undefined) {
    if (
      typeof body.statusExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(body.statusExpiresAt))
    ) {
      return NextResponse.json(
        { error: "Status expiration must be a valid date" },
        { status: 400 },
      );
    }
    const expiration = Date.parse(body.statusExpiresAt);
    if (
      expiration <= Date.now() ||
      expiration > Date.now() + 366 * 24 * 60 * 60 * 1000
    ) {
      return NextResponse.json(
        { error: "Choose a future status expiration within one year" },
        { status: 400 },
      );
    }
    statusExpiresAt = new Date(expiration).toISOString();
  }
  if (!statusEmoji && !statusText) statusExpiresAt = null;

  const { data, error } = await supabase
    .from("chat_member_profiles")
    .upsert(
      {
        user_id: user.id,
        display_name: displayName,
        status_emoji: statusEmoji,
        status_text: statusText,
        status_expires_at: statusExpiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select(
      "user_id,display_name,avatar_path,status_emoji,status_text,status_expires_at,updated_at",
    )
    .single();
  if (error) {
    return NextResponse.json(
      {
        error: socialSchemaUnavailable(error)
          ? "Chat profiles are still being activated. Try again shortly."
          : error.message,
      },
      { status: socialSchemaUnavailable(error) ? 503 : 500 },
    );
  }
  return NextResponse.json({ profile: publicProfile(data, user) });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("avatar");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose a profile photo" }, { status: 400 });
  }
  const extension = AVATAR_TYPES.get(file.type);
  if (!extension) {
    return NextResponse.json(
      { error: "Use a JPEG, PNG, WebP, or GIF image" },
      { status: 400 },
    );
  }
  if (file.size <= 0 || file.size > CHAT_PROFILE_MAX_AVATAR_BYTES) {
    return NextResponse.json(
      { error: "Profile photos can be up to 3 MB" },
      { status: 400 },
    );
  }

  const { data: previous, error: previousError } = await supabase
    .from("chat_member_profiles")
    .select("avatar_path")
    .eq("user_id", user.id)
    .maybeSingle();
  if (previousError && socialSchemaUnavailable(previousError)) {
    return NextResponse.json(
      { error: "Chat profiles are still being activated. Try again shortly." },
      { status: 503 },
    );
  }
  if (previousError) {
    return NextResponse.json({ error: previousError.message }, { status: 500 });
  }

  const avatarPath = `${user.id}/avatars/${randomUUID()}.${extension}`;
  const admin = createSupabaseAdminClient();
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(avatarPath, bytes, {
      contentType: file.type,
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("chat_member_profiles")
    .upsert(
      {
        user_id: user.id,
        avatar_path: avatarPath,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select(
      "user_id,display_name,avatar_path,status_emoji,status_text,status_expires_at,updated_at",
    )
    .single();
  if (error) {
    await admin.storage.from(AVATAR_BUCKET).remove([avatarPath]);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (
    typeof previous?.avatar_path === "string" &&
    previous.avatar_path !== avatarPath
  ) {
    await admin.storage
      .from(AVATAR_BUCKET)
      .remove([previous.avatar_path])
      .catch(() => undefined);
  }
  return NextResponse.json({ profile: publicProfile(data, user) });
}
