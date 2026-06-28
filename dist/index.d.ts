import { CliAdapter } from 'ai-workflow-engine';
export { AgentOptions, AgentResult, CliAdapter, WorkflowApi, WorkflowModule } from 'ai-workflow-engine';
import { N as NagiConfig, W as WorkflowFactory } from './types-CFw23SWw.js';
export { a as NagiContext, R as RegistryEntry, l as loadConfig, p as parseConfig } from './types-CFw23SWw.js';
import 'zod';

interface Logger {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
}

interface CreateNagiOptions {
    config: NagiConfig | string;
    workflows: WorkflowFactory[];
    adapters?: Partial<{
        claude: CliAdapter;
        codex: CliAdapter;
    }>;
    logger?: Logger;
}
interface NagiHandle {
    start(): Promise<void>;
    stop(): Promise<void>;
}
declare function createNagi(options: CreateNagiOptions): NagiHandle;

export { type CreateNagiOptions, type Logger, NagiConfig, type NagiHandle, WorkflowFactory, createNagi };
