/**
 * User Preferences API
 * Get and update user preferences like onboarding status.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Onboarding steps.
// Classic flow: welcome -> license -> connector -> whatsapp -> telegram -> api_keys -> chat_agent -> claude_cli -> done
// Harness flow (onboarding_data.flowVersion === "harness_v1"):
//   welcome -> license -> connector_ready -> brain -> first_agent -> first_task -> channels -> done
const VALID_ONBOARDING_STEPS = [
  "welcome",
  "license",
  "connector",
  "whatsapp",
  "telegram",
  "api_keys",
  "chat_agent",
  "claude_cli",
  "connector_ready",
  "brain",
  "first_agent",
  "first_task",
  "channels",
  "done",
] as const;
type OnboardingStep = typeof VALID_ONBOARDING_STEPS[number];

type OnboardingData = {
  apiKeyMode?: "groovy" | "user";
  connectorTested?: boolean;
  whatsappTested?: boolean;
  chatAgentCreated?: boolean;
  branchController?: {
    maxBranches?: number;
    maxTurnsPerBranch?: number;
    mode?: "read_only" | "read_write";
  };
  [key: string]: unknown;
};

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: prefs, error } = await supabase
    .from("user_preferences")
    .select("onboarding_step, onboarding_data, branch_controller, heartbeat_channel, onboarding_completed_at, created_at, updated_at")
    .eq("user_id", user.id)
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is fine for new users
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    onboardingStep: prefs?.onboarding_step || "welcome",
    onboardingData: (prefs?.onboarding_data as OnboardingData) || {},
    branchController: (prefs?.branch_controller as OnboardingData["branchController"]) || null,
    heartbeatChannel: (prefs as Record<string, unknown> | null)?.heartbeat_channel || "whatsapp",
    onboardingCompleted: !!prefs?.onboarding_completed_at,
    onboardingCompletedAt: prefs?.onboarding_completed_at || null,
  });
}

const VALID_HEARTBEAT_CHANNELS = ["whatsapp", "telegram", "both"] as const;
type HeartbeatChannel = typeof VALID_HEARTBEAT_CHANNELS[number];

type PostBody = {
  onboardingStep?: OnboardingStep;
  onboardingData?: Partial<OnboardingData>;
  branchController?: OnboardingData["branchController"];
  onboardingCompleted?: boolean;
  heartbeatChannel?: HeartbeatChannel;
};

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // First, get existing preferences to merge onboarding_data
  const { data: existingPrefs } = await supabase
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", user.id)
    .single();

  const existingData = (existingPrefs?.onboarding_data as OnboardingData) || {};

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // Update onboarding step
  if (body.onboardingStep && VALID_ONBOARDING_STEPS.includes(body.onboardingStep)) {
    updates.onboarding_step = body.onboardingStep;
  }

  // Merge onboarding data
  if (body.onboardingData && typeof body.onboardingData === "object") {
    updates.onboarding_data = { ...existingData, ...body.onboardingData };
    const bc = (body.onboardingData as OnboardingData).branchController;
    if (bc && typeof bc === "object") {
      updates.branch_controller = bc;
    }
  }

  if (body.branchController && typeof body.branchController === "object") {
    updates.branch_controller = body.branchController;
  }

  if (body.heartbeatChannel && VALID_HEARTBEAT_CHANNELS.includes(body.heartbeatChannel)) {
    updates.heartbeat_channel = body.heartbeatChannel;
  }

  // Update completion status
  if (body.onboardingCompleted === true) {
    updates.onboarding_completed_at = new Date().toISOString();
    updates.onboarding_step = "done"; // Ensure step is "done" when completed
  } else if (body.onboardingCompleted === false) {
    updates.onboarding_completed_at = null;
  }

  // Upsert the preferences
  const { error } = await supabase
    .from("user_preferences")
    .upsert(
      {
        user_id: user.id,
        ...updates,
      },
      {
        onConflict: "user_id",
      }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
