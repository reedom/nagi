import type { ZodType, ZodTypeAny } from 'zod';

// A compact, human/LLM-readable description of an entry's arg schema for the
// triage prompt. Deliberately shallow: enough to extract args, not a full JSON
// Schema dump.
//
// We inspect schemas structurally via `_def.typeName` rather than `instanceof`.
// When nagi is consumed as a linked/git dependency, the bundle and the consumer
// resolve separate physical copies of zod, so a consumer-built schema is never
// `instanceof` the bundle's zod classes. `instanceof` would then collapse every
// field to the literal `value`, and triage would emit `{ value: ... }` instead of
// the real field names. `_def.typeName` is a plain string and survives that split.

interface ZodDef {
  typeName: string;
  innerType?: ZodTypeAny;
  values?: readonly string[];
}

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

export function zodToReadable(schema: ZodType): string {
  if (defOf(schema as ZodTypeAny).typeName === 'ZodObject') {
    const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const fields = Object.entries(shape).map(([key, value]) => `${key}: ${describeField(value)}`);
    return `{ ${fields.join(', ')} }`;
  }
  return describeField(schema as ZodTypeAny);
}

function describeField(schema: ZodTypeAny): string {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodOptional':
      return `${describeField(def.innerType as ZodTypeAny)}?`;
    case 'ZodDefault':
      return `${describeField(def.innerType as ZodTypeAny)} (optional)`;
    case 'ZodEnum':
      return `one of [${(def.values ?? []).join(' | ')}]`;
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    default:
      return 'value';
  }
}
