import { z } from "zod";

export const usageWindowSchema = z
  .object({
    tenant_id: z.string().uuid(),
    project_id: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.to) > Date.parse(value.from) &&
      Date.parse(value.to) - Date.parse(value.from) <= 90 * 86400000,
    "Invalid reporting window",
  );
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usageTotalsSchema = z
  .object({
    records: counter,
    input_tokens: counter.nullable(),
    output_tokens: counter.nullable(),
    cached_input_tokens: counter.nullable(),
    known_cost_micros: counter,
    unmetered_records: counter,
    unpriced_records: counter,
  })
  .strict()
  .refine(
    (value) =>
      value.unmetered_records <= value.records &&
      value.unpriced_records <= value.records,
  );

/** Aggregated metadata only. Never expose decision inputs, prompts, results,
 * credentials, workspace IDs or another Home origin's project bindings. */
export async function groovyUsageReport(
  input: z.infer<typeof usageWindowSchema>,
  deps: {
    homeOrigin: string;
    query: (
      input: Record<string, string>,
    ) => Promise<{ data: unknown; error: unknown }>;
  },
) {
  const scope = usageWindowSchema.parse(input);
  const result = await deps.query({
    p_tenant: scope.tenant_id,
    p_project: scope.project_id,
    p_origin: deps.homeOrigin,
    p_from: scope.from,
    p_to: scope.to,
  });
  if (result.error) throw new Error("usage_report_unavailable");
  return {
    ok: true as const,
    scope: {
      tenant_id: scope.tenant_id,
      project_id: scope.project_id,
      product_key: "groovy" as const,
    },
    window: {
      from: scope.from,
      to: scope.to,
      basis: "execution_started" as const,
    },
    fetched_at: new Date().toISOString(),
    totals: usageTotalsSchema.parse(result.data),
  };
}
