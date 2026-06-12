import type {
  ApprovalChannel,
  PermissionDecision,
  PermissionRequest,
} from 'ai-workflow-engine';
import { DEFAULT_POLICY } from 'ai-workflow-engine';
import type { ApprovalRegistry } from './approval-registry.js';
import { buildApprovalBlocks, buildDecisionBlocks, formatToolInput, shouldInline } from './blocks.js';

// A thread-bound port for posting and finalizing the approval message.
export interface ApprovalGate {
  post(text: string, blocks: unknown[]): Promise<{ ts: string }>;
  update(ts: string, text: string, blocks: unknown[]): Promise<void>;
  uploadSnippet(title: string, content: string): Promise<void>;
}

/** Cancellable timer, injectable for tests. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export interface SlackChannelDeps {
  gate: ApprovalGate;
  registry: ApprovalRegistry;
  newId: () => string;
  schedule?: Schedule;
  onResolved?: (decision: PermissionDecision) => void;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * A Slack-thread ApprovalChannel. Concurrent request() calls from a parallel
 * swarm are SERIALIZED internally (1A): one approval question is outstanding at
 * a time, in arrival order, regardless of how the previous one resolved.
 */
export function makeSlackApprovalChannel(deps: SlackChannelDeps): ApprovalChannel {
  const schedule = deps.schedule ?? defaultSchedule;
  let tail: Promise<unknown> = Promise.resolve();

  const handle = async (req: PermissionRequest): Promise<PermissionDecision> => {
    const requestId = deps.newId();
    const formatted = formatToolInput(req.toolInput);
    const { text, blocks } = buildApprovalBlocks(req, requestId);
    const posted = await deps.gate.post(text, blocks);
    if (!shouldInline(formatted)) {
      await deps.gate.uploadSnippet(`tool input — ${req.toolName}`, formatted);
    }
    const decision = await waitForDecision(deps, schedule, requestId, req.policy ?? DEFAULT_POLICY);
    const final = buildDecisionBlocks(req, decision);
    await deps.gate.update(posted.ts, final.text, final.blocks);
    deps.onResolved?.(decision);
    return decision;
  };

  return {
    id: 'slack',
    request(req: PermissionRequest): Promise<PermissionDecision> {
      const result = tail.then(() => handle(req));
      // Serialize regardless of the prior request's outcome.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function waitForDecision(
  deps: SlackChannelDeps,
  schedule: Schedule,
  requestId: string,
  policy: { timeoutMs: number; onTimeout: 'deny' | 'wait' },
): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    let cancelTimer: (() => void) | undefined;
    const finish = (decision: PermissionDecision): void => {
      cancelTimer?.();
      resolve(decision);
    };
    deps.registry.register(requestId, finish);
    // onTimeout 'wait' relies on the adapter's own ceiling (claude caps the
    // hook at 24h); only 'deny' enforces a concierge-side timeout.
    if (policy.onTimeout === 'deny') {
      cancelTimer = schedule(() => {
        deps.registry.resolve(requestId, { behavior: 'deny', reason: 'approval timed out' });
      }, policy.timeoutMs);
    }
  });
}
