import { N as NagiConfig, W as WorkflowFactory, C as CliAdapter } from './types-DWQjEzd2.js';
export { A as AgentOptions, a as AgentResult, b as NagiContext, R as RegistryEntry, c as WorkflowApi, d as WorkflowModule, l as loadConfig, p as parseConfig } from './types-DWQjEzd2.js';
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

export { CliAdapter, type CreateNagiOptions, type Logger, NagiConfig, type NagiHandle, WorkflowFactory, createNagi };
