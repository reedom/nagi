import { z, type ZodType, type ZodTypeAny } from 'zod';

// A compact, human/LLM-readable description of an entry's arg schema for the
// triage prompt. Deliberately shallow: enough to extract args, not a full JSON
// Schema dump.

export function zodToReadable(schema: ZodType): string {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodTypeAny>;
    const fields = Object.entries(shape).map(([key, value]) => `${key}: ${describeField(value)}`);
    return `{ ${fields.join(', ')} }`;
  }
  return describeField(schema as ZodTypeAny);
}

function describeField(schema: ZodTypeAny): string {
  if (schema instanceof z.ZodOptional) return `${describeField(schema.unwrap())}?`;
  if (schema instanceof z.ZodDefault) return `${describeField(schema._def.innerType)} (optional)`;
  if (schema instanceof z.ZodEnum) return `one of [${(schema.options as string[]).join(' | ')}]`;
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  return 'value';
}
