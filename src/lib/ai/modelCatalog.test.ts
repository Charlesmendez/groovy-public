import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogModelLabel,
  MODEL_CATALOG,
  reasoningEffortsForModel,
} from "./modelCatalog";

test("catalogues the current Anthropic Opus model IDs", () => {
  const anthropic = MODEL_CATALOG.find(
    (group) => group.provider === "anthropic",
  );
  assert.ok(anthropic);
  assert.ok(
    anthropic.models.some((model) => model.id === "claude-opus-4-8"),
  );
  assert.ok(
    anthropic.models.some((model) => model.id === "claude-opus-5"),
  );
  assert.equal(catalogModelLabel("claude-opus-4-8"), "Opus 4.8");
  assert.equal(catalogModelLabel("claude-opus-5"), "Opus 5");
});

test("offers supported API and CLI effort controls for current Opus models", () => {
  assert.deepEqual(reasoningEffortsForModel("claude-opus-5"), [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.deepEqual(reasoningEffortsForModel("claude-opus-4-8", "cli"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});
