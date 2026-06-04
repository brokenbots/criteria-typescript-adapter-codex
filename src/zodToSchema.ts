/**
 * Convert a Zod schema to the Criteria adapter SDK SchemaDef shape.
 */
import { z } from "zod";
import type { SchemaDef, ConfigField } from "@criteria/adapter-sdk";

function zodTypeToString(def: z.ZodTypeAny["_def"]): string {
  const typeName = (def as any).typeName;
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray":
      return "array";
    case "ZodObject":
      return "object";
    case "ZodOptional": {
      const inner = (def as any).innerType as z.ZodTypeAny;
      return zodTypeToString(inner._def);
    }
    case "ZodDefault": {
      const inner = (def as any).innerType as z.ZodTypeAny;
      return zodTypeToString(inner._def);
    }
    case "ZodEnum":
      return "string";
    default:
      return "string";
  }
}

function isOptional(def: z.ZodTypeAny["_def"]): boolean {
  const typeName = (def as any).typeName;
  if (typeName === "ZodOptional") return true;
  if (typeName === "ZodDefault") return false;
  return false;
}

export function zodToSchema(schema: z.ZodTypeAny): SchemaDef {
  const def = schema._def;
  const fields: Record<string, ConfigField> = {};

  if ((def as any).typeName !== "ZodObject") {
    throw new Error("zodToSchema only supports ZodObject schemas at the root level");
  }

  const shape = (def as any).shape() as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(shape)) {
    const fieldDef = value._def;
    fields[key] = {
      type: zodTypeToString(fieldDef),
      required: !isOptional(fieldDef),
      description: (fieldDef as any).description ?? "",
    };
  }

  return { fields };
}
