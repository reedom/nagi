import type { AgentResult, AgentSpec, CliAdapter } from 'ai-workflow-engine';
import { parseConfig, type NagiConfig } from '../src/config.js';
import type { AuditEntry, AuditLog } from '../src/audit.js';
import type { Logger } from '../src/logger.js';
import type { ThreadReplier } from '../src/types.js';

export function testConfig(overrides: Partial<Record<string, unknown>> = {}): NagiConfig {
  return parseConfig({
    slack: { allowedTeamId: 'T1', allowedUserIds: ['U1'] },
    repoScopes: ['github.com/reedom/*'],
    triage: { confidenceThreshold: 0.6 },
    defaultBudget: 100_000,
    auditLogPath: '/dev/null',
    ...overrides,
  });
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function recordingLogger(): Logger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return { info() {}, warn: (m) => warns.push(m), error: (m) => errors.push(m), warns, errors };
}

export function recordingAudit(): AuditLog & { entries: Omit<AuditEntry, 'ts'>[] } {
  const entries: Omit<AuditEntry, 'ts'>[] = [];
  return { record: (e) => entries.push(e), entries };
}

export function recordingReplier(): ThreadReplier & { said: string[] } {
  const said: string[] = [];
  return { say: async (t) => void said.push(t), said };
}

/** A CliAdapter that returns scripted results, one per call. */
export function fakeAdapter(results: Array<Partial<AgentResult>>): CliAdapter & { calls: AgentSpec[] } {
  const calls: AgentSpec[] = [];
  let i = 0;
  return {
    id: 'fake',
    caps: { schema: true, resume: false, tools: true },
    calls,
    async run(spec: AgentSpec): Promise<AgentResult> {
      calls.push(spec);
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return {
        text: r?.text ?? '',
        raw: r?.raw ?? {},
        usage: r?.usage ?? { inputTokens: 0, outputTokens: 0 },
        ...(r?.data !== undefined ? { data: r.data } : {}),
      };
    },
  };
}

/** A manually-resolved promise, for driving the single-flight queue in tests. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
