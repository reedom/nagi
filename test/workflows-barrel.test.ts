import { describe, expect, it } from 'vitest';
import * as wf from '../src/workflows/index.js';

describe('nagi/workflows barrel', () => {
  it('exports the built-in workflow factories', () => {
    expect(typeof wf.reviewRepo).toBe('function');
    expect(typeof wf.research).toBe('function');
    expect(typeof wf.investigateTicket).toBe('function');
  });
  it('exports repo helpers for authors', () => {
    expect(typeof wf.resolveAndSchedule).toBe('function');
    expect(typeof wf.filterScope).toBe('function');
  });
});
