import { WikiClient } from "./client";
import { WELL_KNOWN } from "./paths";
import { DEFAULT_SCHEMA_MD } from "../prompts/schemaDefault";
import { SEED_CANVAS_HTML } from "../canvas/seed";

const INITIAL_INDEX = `# index

(nothing here yet. as we talk, i'll write pages and link them from
this file.)
`;

export type WikiState = {
  schemaMd: string;
  indexMd: string;
  logMd: string;
  canvasHtml: string;
};

export async function ensureWikiBootstrapped(client: WikiClient): Promise<WikiState> {
  const [schema, index, log, canvas] = await Promise.all([
    client.read(WELL_KNOWN.schema),
    client.read(WELL_KNOWN.index),
    client.read(WELL_KNOWN.log),
    client.read(WELL_KNOWN.canvas),
  ]);

  const [schemaMd, indexMd, logMd, canvasHtml] = await Promise.all([
    ensureWikiFile(client, WELL_KNOWN.schema, schema, DEFAULT_SCHEMA_MD),
    ensureWikiFile(client, WELL_KNOWN.index, index, INITIAL_INDEX),
    ensureWikiFile(client, WELL_KNOWN.log, log, ""),
    ensureWikiFile(client, WELL_KNOWN.canvas, canvas, SEED_CANVAS_HTML),
  ]);

  return { schemaMd, indexMd, logMd, canvasHtml };
}

async function ensureWikiFile(
  client: WikiClient,
  path: string,
  existing: string | null,
  initialContent: string
): Promise<string> {
  if (existing != null) return existing;
  const created = await client.writeIfAbsent(path, initialContent);
  if (created) return initialContent;
  return (await client.read(path)) ?? initialContent;
}
