import type { NagiConfig } from '../config.js';
import { repoAliases } from '../config.js';
import { buildRegistry, type EntryFactory, type Registry } from './types.js';
import { reviewRepoEntry } from './workflows/review-repo.js';
import { researchEntry } from './workflows/research.js';
import { approvalDemoEntry } from './workflows/approval-demo.js';

// The hand-registered workflow set for v1. Compose-on-the-fly is v2 (foundry).
export const SEED_FACTORIES: EntryFactory[] = [reviewRepoEntry, researchEntry];

export function makeRegistry(config: NagiConfig): Registry {
  // The approval demo is opt-in so it never competes for triage in normal use.
  const factories =
    process.env['NAGI_ENABLE_APPROVAL_DEMO'] === '1'
      ? [...SEED_FACTORIES, approvalDemoEntry]
      : SEED_FACTORIES;
  return buildRegistry(factories, repoAliases(config));
}

export { Registry } from './types.js';
export type { RegistryEntry } from './types.js';
