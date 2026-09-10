export type ChannelSkillRepositoryCandidate = {
  id: string;
  label: string;
  repoUrl: string;
};

const ACTION_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]{1,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeChannelSkillActionsManifest(
  value?: string | null,
): string | null {
  const source = value?.trim() || "";
  if (!source) return null;
  if (source.length > 250_000) {
    throw new Error("groovy-actions.json must be 250,000 characters or fewer.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error("groovy-actions.json must be valid JSON.");
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.actions) ||
    manifest.actions.length === 0 ||
    manifest.actions.length > 50
  ) {
    throw new Error(
      "groovy-actions.json must use schemaVersion 1 and declare between 1 and 50 actions.",
    );
  }
  const seen = new Set<string>();
  for (const rawAction of manifest.actions) {
    if (!isRecord(rawAction)) throw new Error("Every skill action must be an object.");
    const name = typeof rawAction.name === "string" ? rawAction.name : "";
    if (!ACTION_NAME.test(name) || seen.has(name)) {
      throw new Error(`Invalid or duplicate skill action name: ${name || "(missing)"}.`);
    }
    seen.add(name);
    const secrets = Array.isArray(rawAction.secrets) ? rawAction.secrets : [];
    if (secrets.some((secret) => typeof secret !== "string" || !SECRET_KEY.test(secret))) {
      throw new Error(`Action ${name} has an invalid secret name.`);
    }
    if (!isRecord(rawAction.inputSchema) || rawAction.inputSchema.type !== "object") {
      throw new Error(`Action ${name} must declare an object inputSchema.`);
    }
    const hasHttp = isRecord(rawAction.http);
    const hasCommand = isRecord(rawAction.command);
    if (hasHttp === hasCommand) {
      throw new Error(`Action ${name} must declare exactly one http or command runtime.`);
    }
    if (hasCommand) {
      throw new Error(
        `Action ${name} uses a command runtime, but channel skill authoring cannot create its script. Use an HTTP action or complete the skill in the repository.`,
      );
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function cleanSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildChannelSkillArtifact(input: {
  name: string;
  description: string;
  instructions: string;
  actionsManifest?: string | null;
}) {
  const name = cleanSingleLine(input.name);
  const description = cleanSingleLine(input.description);
  const instructions = input.instructions.trim();
  if (!name) throw new Error("A skill name is required.");
  if (name.length > 120) throw new Error("Skill names must be 120 characters or fewer.");
  if (!description) {
    throw new Error("A short description of when the skill applies is required.");
  }
  if (description.length > 500) {
    throw new Error("Skill descriptions must be 500 characters or fewer.");
  }
  if (!instructions) throw new Error("Skill instructions are required.");
  if (instructions.length > 100_000) {
    throw new Error("Skill instructions must be 100,000 characters or fewer.");
  }

  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new Error("The skill name must contain at least one letter or number.");
  }

  const relativePath = `skills/${slug}/SKILL.md`;
  const content = [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "targets: [flow]",
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
    instructions,
    "",
  ].join("\n");

  const actionsContent = normalizeChannelSkillActionsManifest(
    input.actionsManifest,
  );

  return {
    name,
    description,
    slug,
    relativePath,
    content,
    actionsRelativePath: actionsContent
      ? `skills/${slug}/groovy-actions.json`
      : null,
    actionsContent,
  };
}

export function resolveChannelSkillRepository(
  repositories: ChannelSkillRepositoryCandidate[],
  reference?: string | null,
): ChannelSkillRepositoryCandidate {
  if (repositories.length === 0) {
    throw new Error(
      "No active Skills & Docs repository is connected. Connect one in Skills & Docs first.",
    );
  }
  const needle = cleanSingleLine(reference || "").toLowerCase();
  if (!needle && repositories.length === 1) return repositories[0];

  const matches = needle
    ? repositories.filter((repository) =>
        [repository.id, repository.label, repository.repoUrl].some(
          (value) => value.trim().toLowerCase() === needle,
        ),
      )
    : [];
  if (matches.length === 1) return matches[0];

  const choices = repositories
    .slice(0, 10)
    .map((repository) => `${repository.label} (${repository.id})`)
    .join(", ");
  if (!needle) {
    throw new Error(
      `Multiple Skills & Docs repositories are active. Choose one by exact label or id: ${choices}`,
    );
  }
  throw new Error(
    `No active Skills & Docs repository exactly matches "${reference}". Available repositories: ${choices}`,
  );
}
