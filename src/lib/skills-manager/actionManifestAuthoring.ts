export function skillActionsManifestRelativePath(
  markdownRelativePath: string,
): string {
  const normalized = markdownRelativePath.trim().replace(/\\/g, "/");
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("The skill path must point to a Markdown file.");
  }
  const separator = normalized.lastIndexOf("/");
  return `${separator >= 0 ? normalized.slice(0, separator + 1) : ""}groovy-actions.json`;
}

export function defaultSkillActionsManifest(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      actions: [
        {
          name: "get_data",
          description: "Fetch data from the approved API.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          secrets: ["YOUR_API_KEY"],
          http: {
            method: "GET",
            url: "https://api.example.com/v1/resource",
            headers: {
              Authorization: "Bearer {{secret.YOUR_API_KEY}}",
            },
            timeoutMs: 30000,
          },
        },
      ],
    },
    null,
    2,
  )}\n`;
}
