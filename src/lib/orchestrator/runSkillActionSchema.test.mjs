import { strict as assert } from "node:assert";
import test from "node:test";
import { zodSchema } from "@ai-sdk/provider-utils";
import { runSkillActionSchema } from "./runSkillActionSchema.mjs";

test("run_skill_action satisfies OpenAI strict function schema rules", () => {
  const json = zodSchema(runSkillActionSchema).jsonSchema;
  const serialized = JSON.stringify(json);
  assert.equal(serialized.includes('"propertyNames"'), false);

  const properties = Object.keys(json.properties || {}).sort();
  assert.deepEqual([...(json.required || [])].sort(), properties);

  const args = json.properties?.args;
  assert.equal(args?.type, "array");
  assert.deepEqual([...(args?.items?.required || [])].sort(), ["name", "value"]);
});
