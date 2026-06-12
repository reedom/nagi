import type { PermissionDecision, PermissionRequest } from 'ai-workflow-engine';

// Block Kit rendering for approvals (D11). Approve/Deny buttons carry the
// request id as their value. Tool input is shown in a code block; oversized
// payloads are attached as a snippet rather than truncated, so the human always
// sees exactly what the agent will run.

export const APPROVE_ACTION = 'nagi_approve';
export const DENY_ACTION = 'nagi_deny';
const INLINE_LIMIT = 2500;

export function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function shouldInline(formatted: string): boolean {
  return formatted.length <= INLINE_LIMIT;
}

function header(req: PermissionRequest): string {
  return `:lock: *Approval needed* — \`${req.agentLabel}\` (${req.cli}) wants to run *${req.toolName}*`;
}

export function buildApprovalBlocks(req: PermissionRequest, requestId: string): {
  text: string;
  blocks: unknown[];
} {
  const formatted = formatToolInput(req.toolInput);
  const inline = shouldInline(formatted);
  const body = inline
    ? `\`\`\`${formatted}\`\`\``
    : '_Tool input is large; full payload attached as a snippet below._';
  return {
    text: `Approval needed for ${req.toolName} (${req.agentLabel})`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${header(req)}\n${body}` } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Approve' },
            action_id: APPROVE_ACTION,
            value: requestId,
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: DENY_ACTION,
            value: requestId,
          },
        ],
      },
    ],
  };
}

export function buildDecisionBlocks(req: PermissionRequest, decision: PermissionDecision): {
  text: string;
  blocks: unknown[];
} {
  const verb = decision.behavior === 'allow' ? ':white_check_mark: Approved' : ':no_entry: Denied';
  const reason = decision.reason ? ` — ${decision.reason}` : '';
  return {
    text: `${verb}: ${req.toolName}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${verb} *${req.toolName}* (\`${req.agentLabel}\`)${reason}` },
      },
    ],
  };
}
