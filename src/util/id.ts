import { randomUUID } from 'node:crypto';

/** Short, prefixed, collision-resistant id for runs and approval requests. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
