import type { PermissionDecision, PermissionRequest } from 'ai-workflow-engine';
import { DEFAULT_POLICY } from 'ai-workflow-engine';
import type { Logger } from '../logger.js';
import type { SlackPoster } from '../slack/ports.js';
import { makeGate, makeReplier } from '../slack/ports.js';
import { makeSlackApprovalChannel } from '../escalation/slack-channel.js';
import type { ApprovalRegistry } from '../escalation/approval-registry.js';
import type { PendingRuns } from './pending-runs.js';

export interface Envelope {
  id: string;
  kind: string;
  from: string;
  to?: string;
  payload: { type?: string; runId?: string; [k: string]: unknown };
}

export interface BridgeDeps {
  poster: SlackPoster;
  pending: PendingRuns;
  registry: ApprovalRegistry;
  newId: () => string;
  /** Sends a reply back over agentbus for an approval ask. */
  agentbusReply: (askId: string, payload: PermissionDecision) => Promise<void>;
  log: Logger;
}

export async function handleEnvelope(env: Envelope, deps: BridgeDeps): Promise<void> {
  const runId = typeof env.payload.runId === 'string' ? env.payload.runId : undefined;
  const type = env.payload.type;
  if (!runId) {
    deps.log.warn('agentbus envelope without runId', { id: env.id });
    return;
  }
  const binding = deps.pending.get(runId);
  if (!binding) {
    deps.log.warn('agentbus envelope for unknown/expired run', { runId, type });
    return;
  }

  if (env.kind === 'ask' && type === 'approval') {
    const cwd = typeof env.payload['cwd'] === 'string' ? (env.payload['cwd'] as string) : undefined;
    const req: PermissionRequest = {
      runId,
      agentLabel: 'surface',
      cli: 'cmux',
      toolName: String(env.payload['tool'] ?? ''),
      toolInput: env.payload['input'],
      policy: DEFAULT_POLICY,
      ...(cwd !== undefined ? { cwd } : {}),
    };
    const channel = makeSlackApprovalChannel({
      gate: makeGate(deps.poster, binding.channel, binding.threadTs),
      registry: deps.registry,
      newId: deps.newId,
    });
    const decision = await channel.request(req);
    await deps.agentbusReply(env.id, decision);
    return;
  }

  if (type === 'progress') {
    const text = typeof env.payload['text'] === 'string' ? env.payload['text'] : '';
    await makeReplier(deps.poster, binding.channel, binding.threadTs).say(`:hourglass_flowing_sand: ${text}`);
    return;
  }

  if (type === 'result') {
    const text = typeof env.payload['text'] === 'string' ? env.payload['text'] : '';
    deps.pending.resolveResult(runId, text);
    return;
  }

  deps.log.warn('agentbus envelope of unknown type', { runId, type });
}
