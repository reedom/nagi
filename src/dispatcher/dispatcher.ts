import { runWorkflow, type CliAdapter, type WorkflowModule } from 'ai-workflow-engine';
import type { RunOptions } from 'ai-workflow-engine';
import type { NagiConfig } from '../config.js';
import type { Registry } from '../registry/index.js';
import type { AuditLog } from '../audit.js';
import type { Logger } from '../logger.js';
import type { RequestContext, ThreadReplier } from '../types.js';
import type { ThreadStore } from '../thread-state.js';
import { checkAuth, REFUSAL_MESSAGE } from '../auth/allowlist.js';
import { runTriage, type TriageDeps } from '../triage/triage.js';
import { ApprovalRegistry } from '../escalation/approval-registry.js';
import type { PendingRuns } from '../agentbus-bridge/pending-runs.js';
import type { ResidentSessions } from '../residents/resident-sessions.js';
import { makeSlackApprovalChannel, type ApprovalGate } from '../escalation/slack-channel.js';
import { WorkQueue } from './queue.js';
import { decide } from './decide.js';
import { parseControl, type ControlCommand } from './control.js';
import { errorMessage, formatResult, formatStatus, shortLabel } from './format.js';

type RunWorkflowFn = (mod: WorkflowModule, opts: RunOptions) => Promise<unknown>;

const RESIDENT_HINT =
  ':speech_balloon: Surface is live — reply here to keep talking; say `done` to close it.';

/** The minimal cmux capability the dispatcher needs to drive a live REPL. */
export interface SurfaceDriver {
  send(surfaceRef: string, text: string): Promise<void>;
  sendKey(surfaceRef: string, key: string): Promise<void>;
}

export interface DispatcherDeps {
  config: NagiConfig;
  registry: Registry;
  triage: TriageDeps;
  adapters: { claude: CliAdapter; codex: CliAdapter };
  audit: AuditLog;
  queue: WorkQueue;
  threadStore: ThreadStore;
  approvals: ApprovalRegistry;
  log: Logger;
  makeReplier: (req: RequestContext) => ThreadReplier;
  makeGate: (req: RequestContext) => ApprovalGate;
  newRunId: () => string;
  newApprovalId: () => string;
  /** Kills the active run's process tree; returns how many processes were signalled. */
  cancelActiveRun: () => number;
  pending: PendingRuns;
  /**
   * Builds a per-run cmux adapter bound to the run's Slack thread; onSurfaceRef fires
   * with the surface ref once launched. The binding lets the adapter re-arm a pending
   * wait per surfaced agent, so one run can drive many sequential agents.
   */
  makeSurfaceAdapter: (
    runId: string,
    binding: { channel: string; threadTs: string },
    onSurfaceRef?: (surfaceRef: string) => void,
  ) => CliAdapter;
  /** Live registry of resident agents (thread-addressed). */
  residents: ResidentSessions;
  /** Drives a live surface's REPL (send text / submit). */
  host: SurfaceDriver;
  /** Wall-clock ceiling for a surfaced run (ms). */
  surfaceCeilingMs: number;
  /** Closes a surface by ref (cmux close-surface); best-effort. */
  closeSurface: (surfaceRef: string) => Promise<void>;
  /** Injectable for tests; defaults to the engine's runWorkflow. */
  runWorkflowFn?: RunWorkflowFn;
}

export class Dispatcher {
  private cancelling = false;
  private readonly runWorkflowFn: RunWorkflowFn;

  constructor(private readonly deps: DispatcherDeps) {
    this.runWorkflowFn = deps.runWorkflowFn ?? runWorkflow;
  }

  /** Entry point for every inbound Slack message. Never throws. */
  async handle(req: RequestContext): Promise<void> {
    this.deps.log.debug('dispatcher: handle', { channel: req.channel, threadTs: req.threadTs, userId: req.userId, text: req.text });
    const replier = this.deps.makeReplier(req);
    const auth = checkAuth(this.deps.config, req);
    if (!auth.allowed) {
      this.deps.log.debug('dispatcher: auth refused', { userId: req.userId, teamId: req.teamId, reason: auth.reason ?? null });
      await this.safeSay(replier, REFUSAL_MESSAGE);
      this.record(req, 'refused', auth.reason ? { detail: auth.reason } : {});
      return;
    }

    const control = parseControl(req.text);
    if (control) {
      this.deps.log.debug('dispatcher: control command', { control });
      await this.handleControl(control, req, replier);
      return;
    }

    const resident = this.deps.residents.getByThread(req.threadTs);
    if (resident) {
      this.deps.log.debug('dispatcher: feeding resident', { threadTs: req.threadTs });
      await this.feedResident(resident, req, replier);
      return;
    }

    const pending = this.deps.threadStore.get(req.threadTs);
    const text = pending ? `${pending.originalText}\n\n[follow-up] ${req.text}` : req.text;
    if (pending) this.deps.threadStore.delete(req.threadTs);

    const admission = this.deps.queue.enqueue({
      label: shortLabel(req.text),
      run: () => this.process(req, text, replier),
    });
    this.deps.log.debug('dispatcher: enqueued', {
      accepted: admission.accepted,
      ...(admission.accepted ? {} : { position: admission.position, busyWith: admission.busyWith }),
    });
    if (!admission.accepted) {
      await this.safeSay(
        replier,
        `I'm busy with “${admission.busyWith}”. Queued your request (position ${admission.position}); ` +
          `I'll run it when the current one finishes.`,
      );
    }
  }

  /** Pipe an in-thread message straight into a resident's live REPL (send-immediately). */
  private async feedResident(
    resident: { surfaceRef: string },
    req: RequestContext,
    replier: ThreadReplier,
  ): Promise<void> {
    try {
      await this.deps.host.send(resident.surfaceRef, req.text);
      await this.deps.host.sendKey(resident.surfaceRef, 'Return');
      this.record(req, 'resident-input');
    } catch (err) {
      this.deps.residents.remove(req.threadTs);
      await this.safeSay(replier, ':ghost: Resident seems gone; closing. Send your message again to start fresh.');
      this.record(req, 'failed', { detail: `resident send: ${errorMessage(err)}` });
    }
  }

  private async handleControl(
    command: ControlCommand,
    req: RequestContext,
    replier: ThreadReplier,
  ): Promise<void> {
    if (command === 'status') {
      await this.safeSay(replier, formatStatus(this.deps.queue.status()));
      this.record(req, 'control', { detail: 'status' });
      return;
    }
    if (command === 'done') {
      const resident = this.deps.residents.remove(req.threadTs);
      if (!resident) {
        const liveKeys = this.deps.residents.list().map((r) => r.threadTs);
        await this.safeSay(replier, 'No resident agent in this thread.');
        this.record(req, 'control', {
          detail: `done: none (lookup=${req.threadTs} live=[${liveKeys.join(',')}])`,
        });
        return;
      }
      void this.deps.closeSurface(resident.surfaceRef).catch((e) =>
        this.deps.log.warn('close-surface failed', { runId: resident.runId, error: errorMessage(e) }),
      );
      await this.safeSay(replier, ':octagonal_sign: Resident closed.');
      this.record(req, 'control', { detail: 'done' });
      return;
    }
    this.cancelling = true;
    const killed = this.deps.cancelActiveRun();
    const dropped = this.deps.queue.clearPending();
    const surfaced = this.deps.pending.active();
    for (const runId of surfaced) {
      const binding = this.deps.pending.cancel(runId); // rejects awaitResult -> the run reports cancelled in its thread
      if (binding?.surfaceRef) {
        void this.deps.closeSurface(binding.surfaceRef).catch((e) =>
          this.deps.log.warn('close-surface failed', { runId, error: errorMessage(e) }),
        );
      }
    }
    const residents = this.deps.residents.list();
    for (const resident of residents) {
      this.deps.residents.remove(resident.threadTs);
      void this.deps.closeSurface(resident.surfaceRef).catch((e) =>
        this.deps.log.warn('close-surface failed', { runId: resident.runId, error: errorMessage(e) }),
      );
    }
    await this.safeSay(
      replier,
      `Cancelling: signalled ${killed} process(es), dropped ${dropped} queued request(s), ` +
        `cancelled ${surfaced.length} surface run(s), and closed ${residents.length} resident(s).`,
    );
    this.record(req, 'cancelled', {
      detail: `killed=${killed} dropped=${dropped} surfaced=${surfaced.length} residents=${residents.length}`,
    });
  }

  private async process(req: RequestContext, text: string, replier: ThreadReplier): Promise<void> {
    this.cancelling = false;
    this.deps.log.debug('dispatcher: triaging', { text });
    let triageResult;
    try {
      triageResult = await runTriage(this.deps.triage, text);
    } catch (err) {
      await this.safeSay(replier, `:warning: I couldn't triage that: ${errorMessage(err)}`);
      this.record(req, 'failed', { detail: `triage: ${errorMessage(err)}` });
      return;
    }
    this.deps.log.debug('dispatcher: triage result', { workflowId: triageResult.workflowId, args: triageResult.args });

    const decision = decide(this.deps.config, this.deps.registry, triageResult);
    this.deps.log.debug('dispatcher: decision', {
      kind: decision.kind,
      ...(decision.kind === 'dispatch'
        ? { entry: decision.entry.id, surfaced: Boolean(decision.entry.surfaced) }
        : {}),
    });
    if (decision.kind === 'clarify') {
      this.deps.threadStore.set(req.threadTs, { originalText: text, question: decision.question });
      await this.safeSay(replier, decision.question);
      this.record(req, 'clarification', {
        workflowId: triageResult.workflowId,
        args: triageResult.args,
        detail: decision.question,
      });
      return;
    }

    await this.safeSay(
      replier,
      `On it — running *${decision.entry.id}* with \`${JSON.stringify(decision.args)}\`.`,
    );
    this.record(req, 'dispatched', { workflowId: decision.entry.id, args: decision.args });
    if (decision.entry.surfaced) {
      this.launchSurfaced(req, replier, decision);
      return; // queue slot frees immediately; the bridge drives completion
    }
    await this.runDispatched(req, replier, decision);
  }

  private async runDispatched(
    req: RequestContext,
    replier: ThreadReplier,
    decision: Extract<ReturnType<typeof decide>, { kind: 'dispatch' }>,
  ): Promise<void> {
    const runId = this.deps.newRunId();
    let approvals = 0;
    const channel = makeSlackApprovalChannel({
      gate: this.deps.makeGate(req),
      registry: this.deps.approvals,
      newId: this.deps.newApprovalId,
      onResolved: () => {
        approvals += 1;
      },
    });
    const options: RunOptions = {
      adapters: { claude: this.deps.adapters.claude, codex: this.deps.adapters.codex },
      args: decision.args,
      budget: decision.budget,
      ...(decision.cwd ? { cwd: decision.cwd } : {}),
      escalation: { channel, runId, defaultPolicy: { onTimeout: 'wait' } },
      onLog: (m) => this.deps.log.info(`[wf:${runId}] ${m}`),
    };
    try {
      const result = await this.runWorkflowFn(decision.entry.module, options);
      await this.safeSay(replier, formatResult(result));
      this.record(req, 'completed', { workflowId: decision.entry.id, args: decision.args, approvals });
    } catch (err) {
      const cancelled = this.cancelling;
      const prefix = cancelled ? ':octagonal_sign: Run cancelled' : ':warning: Run failed';
      await this.safeSay(replier, `${prefix}: ${errorMessage(err)}`);
      this.record(req, cancelled ? 'cancelled' : 'failed', {
        workflowId: decision.entry.id,
        args: decision.args,
        approvals,
        detail: errorMessage(err),
      });
    }
  }

  private launchSurfaced(
    req: RequestContext,
    replier: ThreadReplier,
    decision: Extract<ReturnType<typeof decide>, { kind: 'dispatch' }>,
  ): void {
    const runId = this.deps.newRunId();
    const binding = { channel: req.channel, threadTs: req.threadTs };
    const adapter = this.deps.makeSurfaceAdapter(runId, binding, (surfaceRef) =>
      this.deps.residents.add({ runId, surfaceRef, channel: req.channel, threadTs: req.threadTs }),
    );
    // Pre-arm the first wait so the bridge can route the first agent's progress/approvals
    // immediately. Subsequent agents in the same run re-arm via the adapter (idempotent
    // while live), so a multi-step surfaced workflow runs all its agents on this one run.
    const awaited = this.deps.pending.await(runId, {
      ...binding,
      ceilingMs: this.deps.surfaceCeilingMs,
    });
    const options: RunOptions = {
      adapters: { cmux: adapter },
      args: decision.args,
      budget: decision.budget,
      ...(decision.cwd ? { cwd: decision.cwd } : {}),
      onLog: (m) => this.deps.log.info(`[surface:${runId}] ${m}`),
    };
    // Fire concurrently; do NOT await (the queue job returns now).
    void this.runWorkflowFn(decision.entry.module, options)
      .then(async (result) => {
        await this.safeSay(replier, formatResult(result));
        await this.safeSay(replier, RESIDENT_HINT);
        this.record(req, 'resident-ready', { workflowId: decision.entry.id, args: decision.args });
      })
      .catch(async (err) => {
        const stale = this.deps.residents.remove(req.threadTs);
        if (stale) {
          void this.deps.closeSurface(stale.surfaceRef).catch((e) =>
            this.deps.log.warn('close-surface failed', { runId, error: errorMessage(e) }),
          );
        }
        const cancelled = /cancelled/.test(errorMessage(err));
        const prefix = cancelled ? ':octagonal_sign: Surface run cancelled' : ':warning: Surface run failed';
        await this.safeSay(replier, `${prefix}: ${errorMessage(err)}`);
        this.record(req, cancelled ? 'cancelled' : 'failed', {
          workflowId: decision.entry.id,
          args: decision.args,
          detail: errorMessage(err),
        });
      });
    // Keep `awaited` referenced so the adapter's awaitResult resolves via the same registry entry.
    void awaited.catch(() => {});
  }

  private record(
    req: RequestContext,
    outcome: Parameters<AuditLog['record']>[0]['outcome'],
    extra: Partial<Parameters<AuditLog['record']>[0]> = {},
  ): void {
    this.deps.audit.record({
      teamId: req.teamId,
      userId: req.userId,
      channel: req.channel,
      threadTs: req.threadTs,
      text: req.text,
      outcome,
      ...extra,
    });
  }

  private async safeSay(replier: ThreadReplier, text: string): Promise<void> {
    try {
      await replier.say(text);
    } catch (err) {
      this.deps.log.error('failed to post to Slack', { error: errorMessage(err) });
    }
  }
}
