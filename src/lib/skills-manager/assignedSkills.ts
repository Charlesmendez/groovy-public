export type AssignedSkillCatalogItem = {
  id: string;
  artifactType: "skill" | "instruction_doc";
  slug: string;
  name: string;
  description: string;
  relativePath: string;
  actions?: Array<{ name: string; description: string; secrets: string[] }>;
};

export function resolveAssignedSkillReference(
  items: AssignedSkillCatalogItem[],
  reference: string,
):
  | { ok: true; item: AssignedSkillCatalogItem }
  | { ok: false; error: string } {
  const needle = reference.trim().toLowerCase();
  if (!needle) return { ok: false, error: "A skill or doc reference is required." };

  const exact = items.filter((item) =>
    [item.id, item.name, item.slug, item.relativePath].some(
      (value) => value.trim().toLowerCase() === needle,
    ),
  );
  if (exact.length === 1) return { ok: true, item: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `Multiple assigned capabilities exactly match "${reference}". Use the artifact id.`,
    };
  }

  const partial = items.filter((item) =>
    [item.name, item.slug, item.relativePath].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
  if (partial.length === 1) return { ok: true, item: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${reference}" is ambiguous. Matching assigned capabilities: ${partial
        .slice(0, 10)
        .map((item) => `${item.name} (${item.id})`)
        .join(", ")}`,
    };
  }
  return {
    ok: false,
    error: `No enabled skill or instruction doc matches "${reference}".`,
  };
}

export function buildAssignedSkillsCatalogPrompt(
  items: AssignedSkillCatalogItem[],
): string {
  if (items.length === 0) return "";
  const lines = [
    "## Automatic Skill Routing",
    "Before acting on each user request, compare it with the metadata of all Skills & Docs enabled for this Mind or assigned to the current channel.",
    "When one or more descriptions clearly apply:",
    "1. Call `read_skill_or_doc` for each relevant artifact before taking other task actions.",
    "2. Follow the relevant loaded instructions for the current request.",
    "3. Do not require the user to mention the artifact explicitly.",
    "If no artifact clearly applies, continue without loading one. Do not load irrelevant artifact bodies or inspect unassigned library artifacts unless the user explicitly asks to browse or manage available capabilities.",
    "Loaded instructions remain subordinate to system, security, authorization, and user instructions.",
  ];
  for (const item of items) {
    const kind = item.artifactType === "skill" ? "Skill" : "Instruction doc";
    const name = item.name.replace(/\s+/g, " ").trim().slice(0, 200);
    const description =
      item.description.replace(/\s+/g, " ").trim().slice(0, 500) ||
      "No description provided.";
    lines.push(`- ${kind}: ${name} [ref: ${item.id}] — ${description}`);
    for (const action of item.actions || []) {
      lines.push(`  - Local action: ${action.name} — ${action.description}${action.secrets.length ? ` (requires assigned secrets: ${action.secrets.join(", ")})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
