import type { PermissionDecision } from 'ai-workflow-engine';

// Bridges the async ApprovalChannel.request() promise to the Bolt button
// handler. The channel registers a resolver under a unique request id; the
// button's value carries that id back (D11), so a click resolves exactly the
// right pending approval — misrouting is structurally impossible.

export class ApprovalRegistry {
  private readonly pending = new Map<string, (decision: PermissionDecision) => void>();

  register(requestId: string, resolve: (decision: PermissionDecision) => void): void {
    this.pending.set(requestId, resolve);
  }

  /** Returns true if a pending approval was found and resolved. */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const resolver = this.pending.get(requestId);
    if (!resolver) return false;
    this.pending.delete(requestId);
    resolver(decision);
    return true;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  size(): number {
    return this.pending.size;
  }
}
