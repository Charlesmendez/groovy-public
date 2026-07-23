import { NextResponse } from "next/server";
import {
  connectSkillsRepository,
  createSkillsArtifact,
  exportRuntimeSkillToRepository,
  listSkillsManagerState,
  preflightAgentSkills,
  pushSkillsRepositoryChanges,
  reassignSkillAssignment,
  setSkillAssignment,
  syncSkillsRepository,
} from "@/lib/skills-manager/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActionBody = {
  action?: string;
  repoUrl?: string;
  label?: string;
  defaultRef?: string;
  repositoryId?: string;
  deviceId?: string;
  artifactId?: string;
  runtimeSkillId?: string;
  assignmentId?: string;
  agentId?: string | null;
  toAgentId?: string | null;
  target?: "all" | "flow" | "claude" | "codex";
  enabled?: boolean;
  artifactType?: "skill" | "instruction_doc";
  relativePath?: string;
  content?: string;
  name?: string;
  description?: string;
  targets?: string[];
  overwrite?: boolean;
  commitMessage?: string;
};

function statusForError(message: string) {
  if (message === "Unauthorized") return 401;
  if (message === "Admin access required") return 403;
  if (message.toLowerCase().includes("not found")) return 404;
  return 400;
}

export async function GET() {
  try {
    const state = await listSkillsManagerState();
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load skills manager";
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as ActionBody | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const action = String(body.action || "").trim();
    if (action === "connect_repo") {
      const result = await connectSkillsRepository({
        repoUrl: body.repoUrl || "",
        label: body.label,
        defaultRef: body.defaultRef,
        deviceId: body.deviceId,
      });
      const syncResult =
        result.syncResult && typeof result.syncResult === "object" && !Array.isArray(result.syncResult)
          ? (result.syncResult as Record<string, unknown>)
          : null;
      return NextResponse.json({
        ...result,
        ok: !syncResult || syncResult.ok === true,
        ...((syncResult && syncResult.ok !== true)
          ? { error: syncResult.error || "Repository connected, but local sync failed" }
          : {}),
      });
    }
    if (action === "sync_repo") {
      const result = await syncSkillsRepository({
        repositoryId: body.repositoryId || "",
        deviceId: body.deviceId || "",
      });
      const resultRecord = result as Record<string, unknown>;
      return NextResponse.json({
        ok: resultRecord.ok === true,
        ...(resultRecord.ok === true ? {} : { error: resultRecord.error || "Skills repo sync failed" }),
        result,
      });
    }
    if (action === "push_repo") {
      const result = await pushSkillsRepositoryChanges({
        repositoryId: body.repositoryId || "",
        deviceId: body.deviceId || "",
      });
      const resultRecord = result as Record<string, unknown>;
      return NextResponse.json({
        ok: resultRecord.ok === true,
        ...(resultRecord.ok === true ? {} : { error: resultRecord.error || "Skills repo push failed" }),
        result,
      });
    }
    if (action === "create_artifact") {
      const result = await createSkillsArtifact({
        repositoryId: body.repositoryId || "",
        deviceId: body.deviceId || "",
        artifactType: body.artifactType === "skill" ? "skill" : "instruction_doc",
        relativePath: body.relativePath || "",
        content: body.content || "",
        name: body.name,
        description: body.description,
        targets: body.targets,
        overwrite: body.overwrite === true,
        commitMessage: body.commitMessage,
      });
      return NextResponse.json({
        ok: result.ok === true,
        ...(result.ok === true ? {} : { error: result.error || "Artifact creation failed" }),
        result,
      });
    }
    if (action === "export_runtime_skill") {
      const result = await exportRuntimeSkillToRepository({
        runtimeSkillId: body.runtimeSkillId || "",
        repositoryId: body.repositoryId || "",
        deviceId: body.deviceId || "",
      });
      const resultRecord = result as Record<string, unknown>;
      return NextResponse.json({
        ok: resultRecord.ok === true,
        ...(resultRecord.ok === true ? {} : { error: resultRecord.error || "Runtime skill export failed" }),
        result,
      });
    }
    if (action === "set_assignment") {
      const result = await setSkillAssignment({
        artifactId: body.artifactId || "",
        agentId: body.agentId || null,
        target: body.target,
        enabled: body.enabled !== false,
      });
      return NextResponse.json(result);
    }
    if (action === "remove_assignment") {
      const result = await setSkillAssignment({
        artifactId: body.artifactId || "",
        agentId: body.agentId || null,
        target: body.target,
        enabled: false,
      });
      return NextResponse.json(result);
    }
    if (action === "reassign_assignment") {
      const result = await reassignSkillAssignment({
        assignmentId: body.assignmentId || "",
        toAgentId: body.toAgentId || "",
      });
      return NextResponse.json(result);
    }
    if (action === "preflight") {
      const result = await preflightAgentSkills({
        deviceId: body.deviceId || "",
        agentId: body.agentId || null,
        target: body.target === "claude" || body.target === "codex" ? body.target : "flow",
      });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Skills manager action failed";
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
