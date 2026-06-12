import { z } from 'zod';

// The triage agent must return exactly this shape. workflowId + args drive
// dispatch; confidence gates it; clarificationQuestion lets triage punt when
// it cannot decide (the dispatcher also punts on its own checks, 4A).

export const triageResultSchema = z.object({
  workflowId: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  clarificationQuestion: z.string().nullish(),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

// JSON Schema handed to the claude adapter's --json-schema flag. Kept in lockstep
// with triageResultSchema above.
export const triageJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workflowId: { type: 'string' },
    args: { type: 'object' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    clarificationQuestion: { type: ['string', 'null'] },
  },
  required: ['workflowId', 'args', 'confidence'],
} as const;
