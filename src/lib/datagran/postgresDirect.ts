const DATAGRAN_POSTGRES_QUERY_ENDPOINT =
  "https://www.datagran.io/api/proxy/postgres/query";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_TEXT_LENGTH = 1_000;

const DIRECT_SQL_START = /^(?:select|with|insert|update|delete)\b/i;

export type DirectPostgresResult = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  usedApiKeyIndex?: number;
};

type ExecuteDirectPostgresArgs = {
  apiKeys: Array<string | null | undefined>;
  connectionId: string;
  sql: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function trimTrailingFence(value: string): string {
  return value.replace(/\s*```\s*$/, "").trim();
}

/**
 * Return a SQL statement only when the data_query input is explicitly SQL.
 * Natural-language requests keep using the specialized data agent.
 */
export function extractDirectPostgresSql(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/```(?:sql|postgres|postgresql)?\s*([\s\S]*?)```/i);
  const candidate = trimTrailingFence(
    fencedMatch?.[1] || trimmed.replace(/^sql\s*:\s*/i, ""),
  );

  if (!DIRECT_SQL_START.test(candidate)) return null;
  return candidate;
}

function uniqueApiKeys(
  apiKeys: Array<string | null | undefined>,
): string[] {
  return apiKeys.reduce<string[]>((keys, value) => {
    const key = typeof value === "string" ? value.trim() : "";
    if (key && !keys.includes(key)) keys.push(key);
    return keys;
  }, []);
}

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorPreview(data: unknown): string {
  const text =
    typeof data === "string"
      ? data
      : (() => {
          try {
            return JSON.stringify(data);
          } catch {
            return String(data);
          }
        })();
  return text.slice(0, MAX_ERROR_TEXT_LENGTH);
}

function isCredentialFailure(status: number): boolean {
  return status === 401 || status === 403;
}

/** Execute one explicit Postgres statement without spending an LLM round. */
export async function executeDirectPostgresSql({
  apiKeys,
  connectionId,
  sql,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: ExecuteDirectPostgresArgs): Promise<DirectPostgresResult> {
  const keys = uniqueApiKeys(apiKeys);
  if (keys.length === 0) {
    return {
      ok: false,
      status: 0,
      error: "Datagran API key is not configured.",
    };
  }

  const url = new URL(DATAGRAN_POSTGRES_QUERY_ENDPOINT);
  url.searchParams.set("connection_id", connectionId);

  for (let index = 0; index < keys.length; index += 1) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Datagran Postgres query timed out")),
      timeoutMs,
    );

    try {
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keys[index],
        },
        body: JSON.stringify({ sql, params: [] }),
        signal: controller.signal,
        redirect: "error",
      });
      const data = parseResponseBody(await response.text());
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          data,
          usedApiKeyIndex: index,
        };
      }

      if (isCredentialFailure(response.status) && index < keys.length - 1) {
        continue;
      }

      return {
        ok: false,
        status: response.status,
        data,
        error: `Datagran Postgres API returned ${response.status}: ${errorPreview(data)}`,
        usedApiKeyIndex: index,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error:
          error instanceof Error
            ? error.message
            : "Datagran Postgres request failed.",
        usedApiKeyIndex: index,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  return {
    ok: false,
    status: 0,
    error: "Datagran Postgres request failed.",
  };
}
