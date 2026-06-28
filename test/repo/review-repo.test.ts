import { describe, expect, it } from 'vitest';
import { reviewRepoEntry } from '../../src/registry/workflows/review-repo.js';

describe('review-repo entry', () => {
  it('takes a free-form repoHint, not an enum', () => {
    const entry = reviewRepoEntry();
    expect(entry.argsSchema.safeParse({ repoHint: 'engine', scope: 'diff' }).success).toBe(true);
    expect(entry.argsSchema.safeParse({ repo: 'engine' }).success).toBe(false);
  });
});
