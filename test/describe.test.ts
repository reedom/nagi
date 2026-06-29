import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import { zodToReadable } from '../src/triage/describe.js';

// When nagi is consumed as a linked/git dependency, the bundle and the consumer
// each resolve their own physical copy of zod. Schemas built by the consumer are
// therefore NOT `instanceof` the bundle's zod classes, so any `instanceof`-based
// inspection silently collapses. `foreign` recreates that condition: a structurally
// faithful schema (same `_def.typeName`, same accessors) whose prototype is not this
// realm's zod, so `schema instanceof z.ZodObject` is false — exactly as in production.
function foreign(schema: ZodType): unknown {
  const def = (schema as { _def: { typeName: string; innerType?: ZodType } })._def;
  const typeName = def.typeName;
  const base: Record<string, unknown> = { _def: { typeName } as Record<string, unknown> };
  const baseDef = base._def as Record<string, unknown>;
  if (typeName === 'ZodObject') {
    const shape: Record<string, unknown> = {};
    for (const [key, value] of Object.entries((schema as unknown as z.ZodObject<z.ZodRawShape>).shape)) {
      shape[key] = foreign(value as ZodType);
    }
    base.shape = shape;
    baseDef.shape = () => shape;
  } else if (typeName === 'ZodOptional') {
    const inner = foreign((schema as z.ZodOptional<ZodType>).unwrap());
    baseDef.innerType = inner;
    base.unwrap = () => inner;
  } else if (typeName === 'ZodDefault') {
    baseDef.innerType = foreign(def.innerType as ZodType);
  } else if (typeName === 'ZodEnum') {
    const options = [...(schema as z.ZodEnum<[string, ...string[]]>).options];
    base.options = options;
    baseDef.values = options;
  }
  return base;
}

describe('zodToReadable', () => {
  it('describes object field names and types', () => {
    const schema = z.object({ ticketRef: z.string().min(1) });
    expect(zodToReadable(schema)).toBe('{ ticketRef: string }');
  });

  it('describes a schema created by a different zod copy (linked-dependency case)', () => {
    const schema = z.object({ ticketRef: z.string().min(1) });
    expect(schema instanceof z.ZodObject).toBe(true);
    const cross = foreign(schema) as ZodType;
    expect(cross instanceof z.ZodObject).toBe(false);
    // Must not collapse to the literal `value`; the field name must survive.
    expect(zodToReadable(cross)).toBe('{ ticketRef: string }');
  });

  it('describes optional, default, and enum fields across zod copies', () => {
    const schema = z.object({
      ticketRef: z.string().min(1),
      mode: z.enum(['fix', 'investigate']).optional(),
      retries: z.number().default(3),
    });
    const cross = foreign(schema) as ZodType;
    expect(zodToReadable(cross)).toBe(
      '{ ticketRef: string, mode: one of [fix | investigate]?, retries: number (optional) }',
    );
  });
});
