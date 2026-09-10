import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChannelSkillArtifact,
  normalizeChannelSkillActionsManifest,
  resolveChannelSkillRepository,
} from "./channelSkillAuthoring";

test("builds a flow-only standard SKILL.md with safe path and quoted metadata", () => {
  const artifact = buildChannelSkillArtifact({
    name: 'Customer "Escalation"',
    description: "Use when a customer reports a production-blocking problem.",
    instructions: "## Workflow\n\n1. Confirm impact.\n2. Notify the on-call owner.",
  });

  assert.equal(artifact.relativePath, "skills/customer-escalation/SKILL.md");
  assert.match(artifact.content, /name: "Customer \\"Escalation\\""/);
  assert.match(artifact.content, /targets: \[flow\]/);
  assert.match(artifact.content, /## Workflow/);
});

test("builds a validated sibling action manifest for executable skills", () => {
  const artifact = buildChannelSkillArtifact({
    name: "Customer lookup",
    description: "Use when a customer record must be retrieved.",
    instructions: "Call lookup_customer and summarize the result.",
    actionsManifest: JSON.stringify({
      schemaVersion: 1,
      actions: [
        {
          name: "lookup_customer",
          description: "Look up one customer",
          secrets: ["CUSTOMER_API_KEY"],
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          http: {
            method: "GET",
            url: "https://api.example.com/customers/{{args.id}}",
            headers: { Authorization: "Bearer {{secret.CUSTOMER_API_KEY}}" },
          },
        },
      ],
    }),
  });
  assert.equal(
    artifact.actionsRelativePath,
    "skills/customer-lookup/groovy-actions.json",
  );
  assert.deepEqual(JSON.parse(artifact.actionsContent || ""), {
    schemaVersion: 1,
    actions: [
      {
        name: "lookup_customer",
        description: "Look up one customer",
        secrets: ["CUSTOMER_API_KEY"],
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        http: {
          method: "GET",
          url: "https://api.example.com/customers/{{args.id}}",
          headers: { Authorization: "Bearer {{secret.CUSTOMER_API_KEY}}" },
        },
      },
    ],
  });
});

test("rejects malformed action manifests before calling the Connector", () => {
  assert.throws(
    () => normalizeChannelSkillActionsManifest('{"schemaVersion":1,"actions":[]}'),
    /between 1 and 50 actions/i,
  );
  assert.throws(
    () =>
      normalizeChannelSkillActionsManifest(
        JSON.stringify({
          schemaVersion: 1,
          actions: [
            {
              name: "Bad Name",
              secrets: [],
              inputSchema: { type: "object" },
              http: {},
            },
          ],
        }),
      ),
    /invalid or duplicate/i,
  );
});

test("rejects instructions that cannot be selected on demand", () => {
  assert.throws(
    () =>
      buildChannelSkillArtifact({
        name: "Escalation",
        description: "",
        instructions: "Do the thing.",
      }),
    /description of when the skill applies/i,
  );
});

test("selects the only active repository or an exact requested repository", () => {
  const repositories = [
    { id: "repo-1", label: "Company skills", repoUrl: "git@example.com:one.git" },
    { id: "repo-2", label: "Support skills", repoUrl: "git@example.com:two.git" },
  ];
  assert.equal(
    resolveChannelSkillRepository([repositories[0]], null).id,
    "repo-1",
  );
  assert.equal(
    resolveChannelSkillRepository(repositories, "Support skills").id,
    "repo-2",
  );
  assert.throws(
    () => resolveChannelSkillRepository(repositories, null),
    /Multiple Skills & Docs repositories are active/,
  );
});
