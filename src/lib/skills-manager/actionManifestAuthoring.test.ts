import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSkillActionsManifest,
  skillActionsManifestRelativePath,
} from "./actionManifestAuthoring";
import { normalizeChannelSkillActionsManifest } from "./channelSkillAuthoring";

test("places groovy-actions.json beside the skill Markdown file", () => {
  assert.equal(
    skillActionsManifestRelativePath("skills/customer-lookup/SKILL.md"),
    "skills/customer-lookup/groovy-actions.json",
  );
  assert.equal(
    skillActionsManifestRelativePath("SKILL.md"),
    "groovy-actions.json",
  );
});

test("rejects a companion path for a non-Markdown artifact", () => {
  assert.throws(
    () => skillActionsManifestRelativePath("skills/customer-lookup/config.json"),
    /Markdown file/,
  );
});

test("the browser starter manifest is accepted by server validation", () => {
  const normalized = normalizeChannelSkillActionsManifest(
    defaultSkillActionsManifest(),
  );
  assert.ok(normalized);
  const manifest = JSON.parse(normalized);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.actions[0].name, "get_data");
  assert.deepEqual(manifest.actions[0].secrets, ["YOUR_API_KEY"]);
});
