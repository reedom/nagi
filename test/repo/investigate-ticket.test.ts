// test/repo/investigate-ticket.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config.js';
import { makeInvestigateTicketEntry, investigateTicket } from '../../src/registry/workflows/investigate-ticket.js';

const config = parseConfig({
  slack: { allowedTeamId: 'T', allowedUserIds: ['U'] },
  repoScopes: ['github.com/acme/*'],
  learnedReposPath: join(mkdtempSync(join(tmpdir(), 'nagi-it-')), 'm.json'),
});

describe('investigate-ticket entry', () => {
  it('accepts a ticketRef arg and rejects empty', () => {
    const entry = makeInvestigateTicketEntry(config);
    expect(entry.id).toBe('investigate-ticket');
    expect(entry.argsSchema.safeParse({ ticketRef: 'ABC-1' }).success).toBe(true);
    expect(entry.argsSchema.safeParse({}).success).toBe(false);
  });

  it('investigateTicket factory reads config from ctx', () => {
    expect(investigateTicket({ config }).id).toBe('investigate-ticket');
  });
});
