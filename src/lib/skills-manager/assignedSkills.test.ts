import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssignedSkillsCatalogPrompt,
  resolveAssignedSkillReference,
  type AssignedSkillCatalogItem,
} from "./assignedSkills";

const items: AssignedSkillCatalogItem[] = [
  {
    id: "skill-1",
    artifactType: "skill",
    slug: "incident-response",
    name: "Incident response",
    description: "Use for production incidents.",
    relativePath: "skills/incident-response/SKILL.md",
  },
  {
    id: "doc-1",
    artifactType: "instruction_doc",
    slug: "release-checklist",
    name: "Release checklist",
    description: "Use before a production release.",
    relativePath: "instructions/release-checklist.md",
  },
];

test("assigned skill catalog advertises metadata without injecting bodies", () => {
  const prompt = buildAssignedSkillsCatalogPrompt(items);
  assert.match(prompt, /## Automatic Skill Routing/);
  assert.match(prompt, /Call `read_skill_or_doc` for each relevant artifact/);
  assert.match(prompt, /Do not require the user to mention the artifact explicitly/);
  assert.match(prompt, /Do not load irrelevant artifact bodies or inspect unassigned library artifacts/);
  assert.match(prompt, /subordinate to system, security, authorization, and user instructions/);
  assert.match(prompt, /Incident response/);
  assert.doesNotMatch(prompt, /secret body/);
});

test("assigned skill references resolve exact ids and unambiguous names", () => {
  assert.equal(
    resolveAssignedSkillReference(items, "skill-1").ok,
    true,
  );
  const resolved = resolveAssignedSkillReference(items, "release checklist");
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.item.id, "doc-1");
});

test("unassigned skill references fail closed", () => {
  assert.deepEqual(resolveAssignedSkillReference(items, "payroll"), {
    ok: false,
    error: 'No enabled skill or instruction doc matches "payroll".',
  });
});
