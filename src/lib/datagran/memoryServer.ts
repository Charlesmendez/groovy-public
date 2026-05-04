import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

export async function loadDatagranMemoryConfig(
  supabase: SupabaseClient,
  userId: string
): Promise<
  | { apiKey: string; connectionId: string | null; configured: true }
  | { configured: false }
> {
  const { data: cfg, error } = await supabase
    .from("datagran_memory_configs")
    .select("datagran_api_key_enc, connection_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !cfg?.datagran_api_key_enc) {
    return { configured: false };
  }

  return {
    configured: true,
    apiKey: decryptLlmApiKey(cfg.datagran_api_key_enc),
    connectionId: cfg.connection_id ? String(cfg.connection_id) : null,
  };
}

