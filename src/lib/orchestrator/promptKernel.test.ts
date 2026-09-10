import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DEFAULT_GROOVY_PERSONA_BLOCK } from "./profilePrompt";
import { DEFAULT_GROOVY_PROFILE, type HarnessProfile } from "./harnessProfiles";
import {
  buildKernelPrompt,
  buildOrchestratorPrompt,
  composeProfileWithKernel,
} from "./promptKernel";

test("default profile plus kernel is byte-identical to legacy concatenation", () => {
  const legacyKernel =
    "## HOW YOU WORK\nLine one.\n\n## YOUR TOOLS\n- remember\n- recall";
  const expectedLegacyPrompt = `${DEFAULT_GROOVY_PERSONA_BLOCK}\n\n${legacyKernel}`;
  const composed = composeProfileWithKernel(
    DEFAULT_GROOVY_PERSONA_BLOCK,
    buildKernelPrompt({
      stableParts: ["## HOW YOU WORK\nLine one.", "\n\n## YOUR TOOLS\n- remember\n- recall"],
      dynamicParts: ["Current date/time (UTC): 2026-07-23T00:00:00.000Z"],
    })
  );
  assert.equal(composed.stableInstructions, expectedLegacyPrompt);
  assert.equal(
    composed.dynamicContext,
    "Current date/time (UTC): 2026-07-23T00:00:00.000Z"
  );
});

test("the full production default prompt matches its reviewed snapshot", () => {
  const prompt = buildOrchestratorPrompt(
    "",
    "",
    ["data"],
    [],
    false,
    "2026-07-23T00:00:00.000Z",
    undefined,
    [],
    false,
    false,
    false,
    undefined,
    {
      role: "main",
      mode: "read_only",
      maxBranches: 1,
      maxTurnsPerBranch: 3,
      activeBranches: 0,
    },
    false,
    true,
    false,
    null,
  );
  const sha256 = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const composed = `${prompt.stableInstructions}\n\n${prompt.dynamicContext}\n\n${prompt.terminalInstructions}`;

  assert.equal(prompt.stableInstructions.length, 21_210);
  assert.equal(
    sha256(prompt.stableInstructions),
    "a4fc2493e13b0a9dae0bd3423fc0f73d45c37cb7db4a71d7493bf34271fea829",
  );
  assert.equal(prompt.dynamicContext.length, 795);
  assert.equal(
    sha256(prompt.dynamicContext),
    "537c0f3ae00b38269b5a5de17901b32c269818a37c3c261f604cec69ee76f625",
  );
  assert.equal(prompt.terminalInstructions.length, 2_077);
  assert.equal(composed.length, 24_086);
  assert.equal(
    sha256(composed),
    "ca87cbc811332d4fff145e2b275160a7112e7eb92cf5c48d8e346ca517906e73",
  );
});

test("a custom Mind augments but cannot replace the Groovy orchestration kernel", () => {
  const customMind: HarnessProfile = {
    ...DEFAULT_GROOVY_PROFILE,
    id: "internal-ops",
    name: "InternalOps",
    slug: "internalops",
    personaPrompt: "You are a witty operations teammate.",
    purpose: "Route requests to the correct worker.",
    customInstructions: "Be concise.",
  };
  const prompt = buildOrchestratorPrompt(
    "",
    "",
    ["chat"],
    [],
    false,
    "2026-07-25T00:00:00.000Z",
    undefined,
    [],
    false,
    false,
    false,
    undefined,
    {
      role: "main",
      mode: "read_only",
      maxBranches: 1,
      maxTurnsPerBranch: 3,
      activeBranches: 0,
    },
    false,
    false,
    false,
    customMind,
  );

  assert.ok(prompt.stableInstructions.startsWith(customMind.personaPrompt!));
  assert.ok(prompt.stableInstructions.includes("## HOW YOU WORK"));
  assert.ok(prompt.stableInstructions.includes("## TOOL SELECTION PROTOCOL"));
  assert.ok(prompt.stableInstructions.includes("## ERROR HANDLING & EFFICIENCY"));
  assert.ok(prompt.terminalInstructions.includes("Mind profile boundary:"));
  assert.ok(
    prompt.terminalInstructions.includes(
      "It never replaces Groovy's orchestration kernel",
    ),
  );
});
