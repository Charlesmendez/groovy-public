import type { SupabaseClient } from "@supabase/supabase-js";
import { logWarn } from "@/lib/observability/log";
import { CANVAS_REVISION_CAP } from "../limits";

export async function appendCanvasRevision(args: {
  supabase: SupabaseClient;
  userId: string;
  html: string;
  reason: string;
}): Promise<{ version: number } | null> {
  const { supabase, userId, html, reason } = args;

  let nextVersion = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: latest, error: readError } = await supabase
      .from("user_canvas_revisions")
      .select("version")
      .eq("user_id", userId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (readError) {
      logWarn("live.revisions.read_failed", { userId, error: readError.message });
      return null;
    }

    nextVersion = (latest?.version ?? 0) + 1;

    const { error: insertError } = await supabase
      .from("user_canvas_revisions")
      .insert({
        user_id: userId,
        version: nextVersion,
        html,
        reason: reason.slice(0, 200),
      });

    if (!insertError) break;
    if (isUniqueViolation(insertError) && attempt < 2) continue;

    logWarn("live.revisions.insert_failed", { userId, error: insertError.message });
    return null;
  }

  const cutoff = nextVersion - CANVAS_REVISION_CAP;
  if (cutoff > 0) {
    const { error: trimError } = await supabase
      .from("user_canvas_revisions")
      .delete()
      .eq("user_id", userId)
      .lte("version", cutoff);
    if (trimError) {
      logWarn("live.revisions.trim_failed", { userId, error: trimError.message });
    }
  }

  return { version: nextVersion };
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === "23505" || /duplicate key/i.test(error.message ?? "");
}
