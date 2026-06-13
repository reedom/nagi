import { makeClaudeAdapter, makeCodexAdapter } from 'ai-workflow-engine';
import { loadConfig, loadSecrets, repoAliases } from './config.js';
import { logger } from './logger.js';
import { makeAuditLog } from './audit.js';
import { makeRegistry } from './registry/index.js';
import { makeThreadStore } from './thread-state.js';
import { ApprovalRegistry } from './escalation/approval-registry.js';
import { PendingRuns } from './agentbus-bridge/pending-runs.js';
import { WorkQueue } from './dispatcher/queue.js';
import { killActiveRunDescendants } from './dispatcher/kill-tree.js';
import { Dispatcher } from './dispatcher/dispatcher.js';
import { createSlackBot } from './slack/app.js';
import { makeGate, makeReplier, type SlackPoster } from './slack/ports.js';
import { newId } from './util/id.js';
import { loadDotenv } from './util/env.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SURFACE_CEILING_MS = 30 * 60 * 1000;

async function main(): Promise<void> {
  loadDotenv(); // populate process.env from .env before reading secrets/config
  const configPath = process.env['NAGI_CONFIG'] ?? './nagi.config.json';
  const config = loadConfig(configPath);
  const secrets = loadSecrets(process.env);

  const aliases = repoAliases(config);
  const registry = makeRegistry(config);
  const audit = makeAuditLog(config.auditLogPath, logger);
  const queue = new WorkQueue(logger);
  const threadStore = makeThreadStore();
  const approvals = new ApprovalRegistry();
  const pending = new PendingRuns();

  // The claude adapter gets full Bash; the codex adapter runs full-access too —
  // both match the trusted same-machine model the engine targets. The allowlist
  // (D14) is what keeps untrusted callers away from this power.
  const claude = makeClaudeAdapter();
  const codex = makeCodexAdapter({ sandbox: 'danger-full-access' });

  // `poster` is filled in once the bot is built; the dispatcher only touches it
  // lazily (inside makeReplier/makeGate), so the late binding is safe.
  let poster: SlackPoster;
  const dispatcher = new Dispatcher({
    config,
    registry,
    triage: { adapter: claude, policy: config.triage, registry, aliases, log: logger },
    adapters: { claude, codex },
    audit,
    queue,
    threadStore,
    approvals,
    log: logger,
    makeReplier: (req) => makeReplier(poster, req.channel, req.threadTs),
    makeGate: (req) => makeGate(poster, req.channel, req.threadTs),
    newRunId: () => newId('run'),
    newApprovalId: () => newId('appr'),
    cancelActiveRun: () => killActiveRunDescendants(logger),
    pending,
    // TODO(B7): wire the real cmux surface adapter + host + agentbus bridge.
    // Until then a surfaced dispatch fails loudly rather than running headless.
    makeSurfaceAdapter: () => {
      throw new Error('surfaced runs are not wired yet (pending B7 cmux integration)');
    },
    surfaceCeilingMs: SURFACE_CEILING_MS,
    closeSurface: async () => {}, // TODO(B7): cmux close-surface; used by surface-aware stop (B6).
  });

  const bot = createSlackBot({
    secrets,
    approvals,
    log: logger,
    handle: (req) => dispatcher.handle(req),
  });
  poster = bot.poster;

  const sweep = setInterval(() => {
    const removed = threadStore.sweep();
    if (removed !== 0) logger.info('swept expired clarifications', { removed });
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  await bot.start();
}

// Fail-fast (6A): any unhandled fault exits non-zero so launchd KeepAlive
// restarts a clean process rather than limping on in a half-broken state.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

main().catch((err) => {
  logger.error('startup failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
