import { z } from "zod";

type JsonSchemaObject = Record<string, unknown>;

function asObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonSchemaObject;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withDescription<T extends z.ZodTypeAny>(schema: T, raw: JsonSchemaObject): T {
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  return description ? (schema.describe(description) as T) : schema;
}

function buildEnumSchema(values: unknown[]): z.ZodType<unknown> {
  const literals = values
    .filter(
      (value): value is string | number | boolean | null =>
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    )
    .map((value) => z.literal(value)) as z.ZodTypeAny[];

  if (literals.length === 0) return z.unknown();
  if (literals.length === 1) return literals[0];
  return z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

export function zodSchemaFromJsonSchema(input: unknown): z.ZodType<unknown> {
  const raw = asObject(input);
  if (!raw) return z.object({}).passthrough();

  if (Array.isArray(raw.enum)) {
    return withDescription(buildEnumSchema(raw.enum), raw);
  }

  const anyOf = Array.isArray(raw.anyOf) ? raw.anyOf : [];
  if (anyOf.length > 0) {
    const schemas = anyOf.map((entry) => zodSchemaFromJsonSchema(entry));
    if (schemas.length === 1) return withDescription(schemas[0], raw);
    return withDescription(
      z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
      raw
    );
  }

  const oneOf = Array.isArray(raw.oneOf) ? raw.oneOf : [];
  if (oneOf.length > 0) {
    const schemas = oneOf.map((entry) => zodSchemaFromJsonSchema(entry));
    if (schemas.length === 1) return withDescription(schemas[0], raw);
    return withDescription(
      z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
      raw
    );
  }

  const rawType =
    typeof raw.type === "string"
      ? raw.type
      : Array.isArray(raw.type) && raw.type.length > 0 && typeof raw.type[0] === "string"
        ? raw.type[0]
        : raw.properties && typeof raw.properties === "object"
          ? "object"
          : null;

  const nullable =
    raw.nullable === true ||
    (Array.isArray(raw.type) && raw.type.includes("null")) ||
    false;

  let schema: z.ZodType<unknown>;
  switch (rawType) {
    case "string": {
      let out = z.string();
      const minLength = asNumber(raw.minLength);
      const maxLength = asNumber(raw.maxLength);
      if (minLength !== null) out = out.min(minLength);
      if (maxLength !== null) out = out.max(maxLength);
      schema = out;
      break;
    }
    case "number": {
      let out = z.number();
      const minimum = asNumber(raw.minimum);
      const maximum = asNumber(raw.maximum);
      if (minimum !== null) out = out.min(minimum);
      if (maximum !== null) out = out.max(maximum);
      schema = out;
      break;
    }
    case "integer": {
      let out = z.number().int();
      const minimum = asNumber(raw.minimum);
      const maximum = asNumber(raw.maximum);
      if (minimum !== null) out = out.min(minimum);
      if (maximum !== null) out = out.max(maximum);
      schema = out;
      break;
    }
    case "boolean":
      schema = z.boolean();
      break;
    case "array": {
      const itemsSchema = zodSchemaFromJsonSchema(raw.items);
      schema = z.array(itemsSchema);
      break;
    }
    case "object": {
      const properties = asObject(raw.properties) || {};
      const required = new Set(asStringArray(raw.required));
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const propertySchema = zodSchemaFromJsonSchema(value);
        shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
      }

      let out = z.object(shape);
      const additionalProperties = raw.additionalProperties;
      const additionalSchema = asObject(additionalProperties);
      if (additionalProperties === false) {
        out = out.strict();
      } else if (additionalSchema) {
        out = out.catchall(zodSchemaFromJsonSchema(additionalSchema));
      } else {
        out = out.passthrough();
      }
      schema = out;
      break;
    }
    case "null":
      schema = z.null();
      break;
    default:
      schema = z.object({}).passthrough();
      break;
  }

  const described = withDescription(schema as z.ZodTypeAny, raw);
  return nullable ? described.nullable() : described;
}
