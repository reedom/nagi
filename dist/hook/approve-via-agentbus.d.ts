interface Decision {
    behavior: 'allow' | 'deny';
    reason?: string;
}

type AskFn = (to: string, from: string, timeoutMs: number, payload: unknown) => Promise<Decision>;
interface HookDeps {
    ask?: AskFn;
}
/**
 * True when the Bash command is SOLELY the agent's own agentbus reporting to
 * nagiInstance: a single simple pipeline of an optional printf/echo feeder piped
 * into one `agentbus send <nagi>` / `agentbus reply <id> <nagi>` / `agentbus
 * publish`. Any top-level chaining means it is not a pure self-report (the gate is
 * never widened to let an arbitrary command ride along).
 */
declare function isSelfReport(toolName: string, toolInput: unknown, nagiInstance: string): boolean;
declare function runApprovalHook(argv: string[], stdinJson: string, deps?: HookDeps): Promise<string>;

export { type HookDeps, isSelfReport, runApprovalHook };
