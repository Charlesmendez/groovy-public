import { z } from "zod";

export const HOME_DATA_TOOLS = [
  "home_data_operations",
  "home_data_read",
] as const;
export const HOME_DECISION_TOOLS = [
  "web_search",
  "WebSearch",
  ...HOME_DATA_TOOLS,
];
export function isHomeDataTool(name: string): boolean {
  return HOME_DATA_TOOLS.some((tool) => tool === name);
}

const uuid = z.string().uuid();
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const parameterName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((name) => !["constructor", "prototype"].includes(name));
const inputText = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const inputNumber = z
  .number()
  .finite()
  .min(-1e15)
  .max(1e15)
  .refine((value) => /^-?\d+(\.\d+)?$/.test(String(value)));
export const homeDataListInput = z
  .object({
    after: uuid.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const homeDataReadInput = z
  .object({
    operation_id: uuid,
    parameters: z
      .record(parameterName, z.union([inputText, inputNumber, z.boolean()]))
      .default({}),
  })
  .strict();
export const homeDataOperation = z
  .object({
    id: uuid,
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(1000),
    provider: z.literal("salesforce"),
    effect: z.literal("read"),
    parameters: z
      .array(
        z
          .object({
            name: parameterName,
            type: z.enum(["string", "number", "boolean"]),
            description: z.string().min(1).max(300),
            required: z.literal(true),
          })
          .strict(),
      )
      .max(10),
    fields: z.array(identifier).min(1).max(20),
    max_records: z.number().int().min(1).max(50),
  })
  .strict()
  .refine(
    (operation) =>
      new Set(operation.parameters.map((parameter) => parameter.name)).size ===
        operation.parameters.length &&
      new Set(operation.fields.map((field) => field.toLowerCase())).size ===
        operation.fields.length,
  );
export type HomeDataOperation = z.infer<typeof homeDataOperation>;
export const homeDataCatalog = z
  .object({
    operations: z.array(homeDataOperation).max(50),
    next_cursor: uuid.nullable(),
    readiness: z.literal("local_grants_only"),
  })
  .strict();
export const homeDataResult = z
  .object({
    operation_id: uuid,
    records: z
      .array(
        z.record(
          identifier,
          z.union([
            z.string().max(16_384),
            z.number().finite(),
            z.boolean(),
            z.null(),
          ]),
        ),
      )
      .max(50),
    limit_reached: z.boolean(),
    observed_at: z.string().datetime({ offset: true }),
  })
  .strict();

export function validOperationParameters(
  operation: HomeDataOperation,
  parameters: Record<string, unknown>,
) {
  return (
    Object.keys(parameters).length === operation.parameters.length &&
    operation.parameters.every(
      (parameter) =>
        Object.hasOwn(parameters, parameter.name) &&
        typeof parameters[parameter.name] === parameter.type,
    )
  );
}
