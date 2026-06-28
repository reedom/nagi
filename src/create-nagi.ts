import { makeClaudeAdapter, makeCodexAdapter, type CliAdapter } from 'ai-workflow-engine';
import {
  makeCmuxClaudeAdapter,
  makeCmuxHost,
  register,
  awaitInbox,
  reply,
  runProcess,
} from 'agent-surface-adapters';
import { parseConfig, loadConfig, loadSecrets, type NagiConfig } from './config.js';
import { logger as defaultLogger } from './logger.js';
import type { Logger } from './logger.js';
import { makeAuditLog } from './audit.js';
import { buildRegistry, type WorkflowFactory } from './registry/types.js';
import { makeThreadStore } from './thread-state.js';
import { ApprovalRegistry } from './escalation/approval-registry.js';
import { PendingRuns } from './agentbus-bridge/pending-runs.js';
import { ResidentSessions } from './residents/resident-sessions.js';
import { handleEnvelope, type BridgeDeps } from './agentbus-bridge/bridge.js';
import { WorkQueue } from './dispatcher/queue.js';
import { killActiveRunDescendants } from './dispatcher/kill-tree.js';
import { Dispatcher } from './dispatcher/dispatcher.js';
import { createSlackBot } from './slack/app.js';
import { makeGate, makeReplier, type SlackPoster } from './slack/ports.js';
import { newId } from './util/id.js';
import { loadDotenv } from './util/env.js';

export interface CreateNagiOptions {
  config: NagiConfig | string;
  workflows: WorkflowFactory[];
  adapters?: Partial<{ claude: CliAdapter; codex: CliAdapter }>;
  logger?: Logger;
}

export interface NagiHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface StoppableBot {
  start(): Promise<void>;
  stop?: () => Promise<void>;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SURFACE_CEILING_MS = 30 * 60 * 1000;
const NAGI_INSTANCE = 'nagi';

export function createNagi(options: CreateNagiOptions): NagiHandle {
  if (options.workflows.length === 0) throw new Error('createNagi requires at least one workflow');
  const config =
    typeof options.config === 'string' ? loadConfig(options.config) : parseConfig(options.config);
  const log = options.logger ?? defaultLogger;
  const registry = buildRegistry(options.workflows, { config });

  let started = false;
  let pumping = false;
  let sweep: ReturnType<typeof setInterval> | undefined;
  let botRef: StoppableBot | undefined;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    loadDotenv(); // populate process.env from .env before reading secrets/config
    const secrets = loadSecrets(process.env);
    const claude = options.adapters?.claude ?? makeClaudeAdapter();
    const codex = options.adapters?.codex ?? makeCodexAdapter({ sandbox: 'danger-full-access' });

    const audit = makeAuditLog(config.auditLogPath, log);
    const queue = new WorkQueue(log);
    const threadStore = makeThreadStore();
    const approvals = new ApprovalRegistry();
    const pending = new PendingRuns();
    const residents = new ResidentSessions();

    // A per-run cmux adapter: bound to nagi's chosen runId and to the pending
    // registry, so the engine's adapter.run() blocks on the SAME promise the
    // agentbus bridge resolves when the surfaced agent reports its result.
    const makeSurfaceAdapter = (runId: string, onSurfaceRef?: (surfaceRef: string) => void) =>
      makeCmuxClaudeAdapter({
        nagiInstance: NAGI_INSTANCE,
        newRunId: () => runId,
        awaitResult: () => pending.awaitExisting(runId),
        onSurface: (surface) => {
          if (surface.ref) {
            pending.setSurfaceRef(runId, surface.ref);
            onSurfaceRef?.(surface.ref);
          }
        },
        ...(config.cmux?.socketPath ? { cmuxSocketPath: config.cmux.socketPath } : {}),
        ...(config.cmux?.password ? { cmuxPassword: config.cmux.password } : {}),
        ...(config.cmux?.window ? { cmuxWindow: config.cmux.window } : {}),
      });

    // Best-effort cmux close-surface for surface-aware stop (B6).
    const closeSurface = async (surfaceRef: string): Promise<void> => {
      const args: string[] = [];
      if (config.cmux?.socketPath) args.push('--socket', config.cmux.socketPath);
      if (config.cmux?.password) args.push('--password', config.cmux.password);
      args.push('close-surface', surfaceRef);
      await runProcess('cmux', args);
    };

    // A standalone cmux host used to drive resident REPLs (send + Return). Shares
    // the same socket/window config as the surface adapter.
    const cmuxHost = makeCmuxHost({
      ...(config.cmux?.socketPath ? { socketPath: config.cmux.socketPath } : {}),
      ...(config.cmux?.password ? { password: config.cmux.password } : {}),
      ...(config.cmux?.window ? { window: config.cmux.window } : {}),
    });
    const host = {
      send: (surfaceRef: string, text: string) => cmuxHost.send!(surfaceRef, text),
      sendKey: (surfaceRef: string, key: string) => cmuxHost.sendKey!(surfaceRef, key),
    };

    // `poster` is filled in once the bot is built; the dispatcher only touches it
    // lazily (inside makeReplier/makeGate), so the late binding is safe.
    let poster: SlackPoster;
    const dispatcher = new Dispatcher({
      config,
      registry,
      triage: { adapter: claude, policy: config.triage, registry, log },
      adapters: { claude, codex },
      audit,
      queue,
      threadStore,
      approvals,
      log,
      makeReplier: (req) => makeReplier(poster, req.channel, req.threadTs),
      makeGate: (req) => makeGate(poster, req.channel, req.threadTs),
      newRunId: () => newId('run'),
      newApprovalId: () => newId('appr'),
      cancelActiveRun: () => killActiveRunDescendants(log),
      pending,
      makeSurfaceAdapter,
      surfaceCeilingMs: SURFACE_CEILING_MS,
      closeSurface,
      residents,
      host,
    });

    const bot = createSlackBot({
      secrets,
      approvals,
      log,
      handle: (req) => dispatcher.handle(req),
    });
    poster = bot.poster;
    botRef = bot;

    // Register nagi on the agentbus and pump its inbox through the bridge. agentbus
    // is a hard dependency for the surfaced lane: a missing binary fails startup
    // here (fail-fast). A transient poll error mid-run is logged and retried so it
    // never crashloops the daemon.
    await register(NAGI_INSTANCE, { persistent: true });
    const bridgeDeps: BridgeDeps = {
      poster,
      pending,
      residents,
      registry: approvals,
      newId: () => newId('appr'),
      agentbusReply: (askId, payload) => reply(askId, NAGI_INSTANCE, payload),
      log,
    };
    pumping = true;
    const pump = async (): Promise<void> => {
      while (pumping) {
        try {
          const envs = await awaitInbox(NAGI_INSTANCE, 1000);
          for (const env of envs) {
            void handleEnvelope(env as never, bridgeDeps).catch((e) =>
              log.error('bridge handleEnvelope threw', { error: String(e) }),
            );
          }
        } catch (e) {
          log.error('agentbus inbox poll failed', { error: String(e) });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void pump();

    sweep = setInterval(() => {
      const removed = threadStore.sweep();
      if (removed !== 0) log.info('swept expired clarifications', { removed });
    }, SWEEP_INTERVAL_MS);
    sweep.unref();

    await bot.start();
  }

  async function stop(): Promise<void> {
    pumping = false;
    if (sweep) clearInterval(sweep);
    await botRef?.stop?.();
    started = false;
  }

  return { start, stop };
}
