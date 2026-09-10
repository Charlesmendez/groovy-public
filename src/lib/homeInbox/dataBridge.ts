import { randomUUID } from "node:crypto";
import { HomeInboxError, type DecisionScope } from "./contracts";
import {
  homeDataCatalog,
  homeDataListInput,
  homeDataReadInput,
  homeDataResult,
  validOperationParameters,
  type HomeDataOperation,
} from "./dataContracts";
import { createHomePlatformInvoker } from "./homeClient";

/** A server-owned, run-scoped capability. Never deserialize this from a request. */
export type HomeDataBridge = {
  execute: (tool: string, input: unknown) => Promise<unknown>;
  assertHealthy: () => void;
};

export function createHomeDataBridge(options: {
  scope: DecisionScope;
  key: string;
  origin: string;
  authorize: () => Promise<unknown>;
  signal: AbortSignal;
  deadlineAt: number;
  fetcher?: typeof fetch;
  now?: () => number;
}): HomeDataBridge {
  // Copy identity: neither a caller mutating the binding object nor model input
  // may substitute another project during a run.
  const invoke = createHomePlatformInvoker(
    { ...options.scope },
    options.key,
    options.fetcher,
    options.origin,
  );
  const now = options.now ?? Date.now;
  const operations = new Map<string, HomeDataOperation>();
  const cursors = new Set<string>();
  let calls = 0;
  let resultBytes = 0;
  let failure: HomeInboxError | null = null;
  function fail(code: string, message: string): never {
    failure ??= new HomeInboxError(code, message);
    throw failure;
  }
  const assertHealthy = () => {
    if (failure) throw failure;
    if (options.signal.aborted || now() >= options.deadlineAt)
      fail("home_data_deadline", "The decision's data-read window has closed.");
  };
  const authorize = async () => {
    assertHealthy();
    await options.authorize();
    assertHealthy();
  };
  return {
    assertHealthy,
    async execute(tool, rawInput) {
      try {
        assertHealthy();
        // Reserve synchronously before awaiting: parallel tool calls share the
        // same budget. No automatic retry and no second provider query path.
        if (++calls > 12)
          fail(
            "home_data_budget",
            "The decision's data-read budget is exhausted.",
          );
        const listing = tool === "home_data_operations";
        if (!listing && tool !== "home_data_read")
          fail(
            "home_data_tool",
            "This Home capability is not a data-read tool.",
          );
        const parsed = listing
          ? homeDataListInput.safeParse(rawInput)
          : homeDataReadInput.safeParse(rawInput);
        if (!parsed.success)
          fail(
            "home_data_input",
            "Use exactly the operation's declared inputs. Do not supply a query, scope, URL or credential.",
          );
        const input = parsed.data;
        let operation: HomeDataOperation | undefined;
        if ("operation_id" in input) {
          operation = operations.get(input.operation_id);
          if (
            !operation ||
            !validOperationParameters(operation, input.parameters)
          )
            fail(
              "home_data_operation",
              "Discover the granted operation first and supply exactly its typed parameters.",
            );
        } else if (input.after && !cursors.has(input.after)) {
          fail(
            "home_data_cursor",
            "Use a next_cursor returned by this decision's operation discovery.",
          );
        }
        await authorize();
        const capability = listing
          ? "data.operations.list"
          : "data.operations.read";
        const data = await invoke(capability, input, `read-${randomUUID()}`, {
          signal: options.signal,
          // Home may need 30s for ownership verification plus a 15s query.
          timeoutMs: Math.max(1, Math.min(50_000, options.deadlineAt - now())),
          strictDataReceipt: true,
        });
        await authorize();
        // A failure in a parallel call invalidates this result too.
        assertHealthy();
        resultBytes += Buffer.byteLength(JSON.stringify(data), "utf8");
        if (resultBytes > 1024 * 1024)
          fail(
            "home_data_budget",
            "The decision's data response budget is exhausted.",
          );
        if (listing) {
          const result = homeDataCatalog.safeParse(data);
          if (!result.success)
            fail(
              "home_data_response",
              "Home returned an invalid operation catalog.",
            );
          const catalog = result.data;
          const limit = "limit" in input ? (input.limit ?? 25) : 25;
          if (
            catalog.operations.length > limit ||
            new Set(catalog.operations.map((entry) => entry.id)).size !==
              catalog.operations.length ||
            (catalog.next_cursor !== null &&
              (catalog.operations.length === 0 ||
                catalog.next_cursor !== catalog.operations.at(-1)?.id ||
                ("after" in input && catalog.next_cursor === input.after)))
          )
            fail(
              "home_data_response",
              "Home returned invalid operation pagination.",
            );
          for (const entry of catalog.operations) {
            const previous = operations.get(entry.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
              fail(
                "home_data_changed",
                "An operation changed during the decision. Review the grant.",
              );
            // Keep the authorization snapshot separate from returned tool data.
            operations.set(entry.id, structuredClone(entry));
          }
          if (catalog.next_cursor) cursors.add(catalog.next_cursor);
          return catalog;
        }
        const parsedResult = homeDataResult.safeParse(data);
        if (!parsedResult.success || !operation)
          fail(
            "home_data_response",
            "Home returned an invalid data observation.",
          );
        const result = parsedResult.data;
        if (
          result.operation_id !== operation.id ||
          result.records.length > operation.max_records ||
          (result.records.length === operation.max_records &&
            !result.limit_reached) ||
          result.records.some(
            (row) =>
              Object.keys(row).length !== operation.fields.length ||
              operation.fields.some((field) => !Object.hasOwn(row, field)),
          )
        )
          fail(
            "home_data_response",
            "Home returned data outside the approved operation.",
          );
        return result;
      } catch (error) {
        // Never leak provider bodies, record values, credentials or arbitrary
        // authorization errors to the model/logs. A failed read holds the final
        // decision even if the model tries to interpret it as negative evidence.
        if (!failure)
          failure = new HomeInboxError(
            error instanceof HomeInboxError
              ? error.code
              : "home_data_unavailable",
            "Home data could not be verified. Hold this decision; unavailable evidence is not an empty result.",
          );
        throw failure;
      }
    },
  };
}
