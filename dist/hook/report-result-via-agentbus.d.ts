type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
interface JsonSchema {
    type?: JsonSchemaType;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    enum?: unknown[];
    items?: JsonSchema;
}

type SendFn = (to: string, from: string, payload: unknown) => Promise<void>;
interface ResultHookDeps {
    send?: SendFn;
    readLastAssistantText?: (transcriptPath: string) => string | null;
    findTranscript?: (sessionId: string) => string | null;
    /** Test seam for the flush-retry delay. */
    sleep?: (ms: number) => Promise<void>;
    /** Test seam: read the declared JSON Schema from its file. */
    readSchema?: (schemaPath: string) => JsonSchema | null;
    /** Test seams for the per-step repair-attempt counter (keyed by the attempts file path). */
    readAttempts?: (path: string) => number;
    writeAttempts?: (path: string, n: number) => void;
}
/** Text of the last assistant message in a Claude Code JSONL transcript, or null. */
declare function lastAssistantText(transcriptPath: string): string | null;
/**
 * Stop-hook helper: when the agent finishes a turn, read its final assistant
 * message from the transcript and report it as the run's result over agentbus.
 * This makes result reporting deterministic (the harness reports), instead of
 * relying on the interactive model to remember to run a closing `agentbus send`.
 * It ALWAYS allows the agent to stop (never blocks); a missing result is handled
 * by nagi's wait-ceiling.
 */
declare function runResultHook(argv: string[], stdinJson: string, deps?: ResultHookDeps): Promise<string>;

export { type ResultHookDeps, lastAssistantText, runResultHook };
