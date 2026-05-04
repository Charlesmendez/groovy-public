import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";

function getOpenAIClient(apiKey?: string) {
  const resolved = apiKey ?? process.env.OPENAI_API_KEY;
  if (!resolved) throw new Error("OPENAI_API_KEY not configured");
  return new OpenAI({ apiKey: resolved });
}

// Max ~500 chunks per batch to stay under OpenAI's 300k token limit
const EMBEDDING_BATCH_SIZE = 500;

export async function embedTexts(
  texts: string[],
  opts?: { apiKey?: string | null }
): Promise<number[][]> {
  // If apiKey is explicitly null, disable embeddings (used when we don't want to fall back to server env key).
  if (opts?.apiKey === null) return [];
  const openai = getOpenAIClient(opts?.apiKey ?? undefined);

  const input = texts.map((t) => t.trim()).filter(Boolean);
  if (input.length === 0) return [];

  const allEmbeddings: number[][] = [];

  // Process in batches to avoid token limits
  for (let i = 0; i < input.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = input.slice(i, i + EMBEDDING_BATCH_SIZE);
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    allEmbeddings.push(...res.data.map((d) => d.embedding as number[]));
  }

  return allEmbeddings;
}

export async function embedText(
  text: string,
  opts?: { apiKey?: string | null }
): Promise<number[]> {
  const [embedding] = await embedTexts([text], opts);
  if (!embedding) return [];
  return embedding;
}

// Postgres `vector` literal format, e.g. "[0.1,0.2,...]"
export function embeddingToVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

