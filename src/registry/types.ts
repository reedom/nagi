import { z, type ZodType } from 'zod';
import type { WorkflowModule } from 'ai-workflow-engine';

// A registry entry embeds a REAL WorkflowModule (2A): the concierge calls
// runWorkflow(entry.module, ...). Generated foundry files (v2) and hand-written
// entries will share the engine's one workflow format.

export interface RegistryEntry {
  id: string;
  description: string;
  /** Validates triage-extracted args; failure becomes a clarification (4A). */
  argsSchema: ZodType;
  module: WorkflowModule;
  /** Per-entry token budget override; falls back to config.defaultBudget (3A). */
  budgetOverride?: number | null;
}

/**
 * Entries are produced from the live repo-alias list so their arg schemas can
 * enumerate known repos (D13) — free-form paths are unrepresentable.
 */
export type EntryFactory = (aliases: string[]) => RegistryEntry;

/** A zod schema accepting exactly the configured repo aliases (D13). */
export function repoEnum(aliases: string[]): ZodType<string> {
  if (aliases.length === 0) {
    return z.string().refine(() => false, 'no repos are configured');
  }
  return z.enum(aliases as [string, ...string[]]);
}

export class Registry {
  private readonly byId: Map<string, RegistryEntry>;

  constructor(entries: RegistryEntry[]) {
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
  }

  get(id: string): RegistryEntry | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  list(): RegistryEntry[] {
    return [...this.byId.values()];
  }
}

export function buildRegistry(factories: EntryFactory[], aliases: string[]): Registry {
  return new Registry(factories.map((make) => make(aliases)));
}
