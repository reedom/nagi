import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAuditLog } from '../src/audit.js';
import { recordingLogger, silentLogger } from './helpers.js';

describe('audit log', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nagi-audit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON object per line with a timestamp', () => {
    const path = join(dir, 'audit.jsonl');
    const audit = makeAuditLog(path, silentLogger, () => '2026-06-12T00:00:00.000Z');
    audit.record({ teamId: 'T1', userId: 'U1', text: 'hi', outcome: 'completed', workflowId: 'review-repo' });
    audit.record({ teamId: 'T1', userId: 'U1', text: 'bye', outcome: 'refused' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first).toMatchObject({ ts: '2026-06-12T00:00:00.000Z', outcome: 'completed', workflowId: 'review-repo' });
  });

  it('never throws on a bad path, only warns', () => {
    const log = recordingLogger();
    const audit = makeAuditLog('/no/such/dir/audit.jsonl', log);
    expect(() => audit.record({ teamId: 'T', userId: 'U', text: 'x', outcome: 'failed' })).not.toThrow();
    expect(log.warns.length).toBe(1);
  });
});
