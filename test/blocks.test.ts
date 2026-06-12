import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from 'ai-workflow-engine';
import {
  APPROVE_ACTION,
  DENY_ACTION,
  buildApprovalBlocks,
  buildDecisionBlocks,
  formatToolInput,
  shouldInline,
} from '../src/escalation/blocks.js';

const req: PermissionRequest = {
  runId: 'r',
  agentLabel: 'review',
  cli: 'claude',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf build' },
};

describe('approval blocks', () => {
  it('binds both buttons to the request id (D11)', () => {
    const { blocks } = buildApprovalBlocks(req, 'req_42');
    const actions = blocks.find((b) => (b as { type: string }).type === 'actions') as {
      elements: Array<{ action_id: string; value: string }>;
    };
    const approve = actions.elements.find((e) => e.action_id === APPROVE_ACTION);
    const deny = actions.elements.find((e) => e.action_id === DENY_ACTION);
    expect(approve?.value).toBe('req_42');
    expect(deny?.value).toBe('req_42');
  });

  it('inlines small payloads and offloads large ones', () => {
    expect(shouldInline(formatToolInput({ a: 1 }))).toBe(true);
    expect(shouldInline('x'.repeat(3000))).toBe(false);
  });

  it('decision blocks reflect allow/deny', () => {
    expect(buildDecisionBlocks(req, { behavior: 'allow' }).text).toMatch(/Approved/);
    expect(buildDecisionBlocks(req, { behavior: 'deny', reason: 'nope' }).text).toMatch(/Denied/);
  });
});
