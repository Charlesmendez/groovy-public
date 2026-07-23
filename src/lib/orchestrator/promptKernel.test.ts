import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DEFAULT_GROOVY_PERSONA_BLOCK } from "./profilePrompt";
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

  assert.equal(prompt.stableInstructions.length, 19_858);
  assert.equal(
    sha256(prompt.stableInstructions),
    "81bb3192c18b43590f81989eedd7c07cb09d1611d6cc47fd47a091e46aae311e",
  );
  assert.equal(prompt.dynamicContext.length, 746);
  assert.equal(
    sha256(prompt.dynamicContext),
    "9512e74d7d0b2fbb860fa21ba9b60771d0a56db7d691b323f6f852e0fc0fa108",
  );
  assert.equal(prompt.terminalInstructions.length, 1_493);
  assert.equal(composed.length, 22_101);
  assert.equal(
    sha256(composed),
    "09113c879a62be26429cf8fa2728a2a34dd14e2f13075815258a02a91b108354",
  );
});
