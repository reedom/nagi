import bolt from '@slack/bolt';
import type { Secrets } from '../config.js';
import type { Logger } from '../logger.js';
import type { RequestContext } from '../types.js';
import type { ApprovalRegistry } from '../escalation/approval-registry.js';
import { APPROVE_ACTION, DENY_ACTION } from '../escalation/blocks.js';
import type { SlackPoster } from './ports.js';

const { App } = bolt;

// Thin @slack/bolt socket-mode front door. It normalizes Slack events into a
// RequestContext, hands them to the dispatcher, and routes approval-button
// clicks back to the ApprovalRegistry. All decision logic lives elsewhere.

interface RawEvent {
  type?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
  bot_id?: string;
}
interface RawArgs {
  event: RawEvent;
  context: { teamId?: string; botUserId?: string };
}
interface RawActionArgs {
  ack: () => Promise<void>;
  action: { value?: string };
  body: { user?: { id?: string } };
}

export function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function toRequestContext(args: RawArgs): RequestContext | undefined {
  const { event, context } = args;
  const teamId = context.teamId;
  if (!teamId || !event.user || !event.channel || !event.ts) return undefined;
  return {
    teamId,
    userId: event.user,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: stripMentions(event.text ?? ''),
  };
}

export interface SlackAppDeps {
  secrets: Secrets;
  approvals: ApprovalRegistry;
  log: Logger;
  handle: (req: RequestContext) => Promise<void>;
}

export interface SlackBot {
  start(): Promise<void>;
  poster: SlackPoster;
}

export function createSlackBot(deps: SlackAppDeps): SlackBot {
  const app = new App({
    token: deps.secrets.botToken,
    appToken: deps.secrets.appToken,
    socketMode: true,
  });

  const dispatch = (args: RawArgs): void => {
    const req = toRequestContext(args);
    if (!req) return;
    if (args.event.bot_id || req.userId === args.context.botUserId) return; // ignore our own posts
    void deps.handle(req).catch((err) => deps.log.error('handle threw', { error: String(err) }));
  };

  // Channel mentions arrive as app_mention; DMs arrive as message(im). Handling
  // them separately avoids double-processing a mention that also fires message.
  app.event('app_mention', async (a) => dispatch(a as unknown as RawArgs));
  app.message(async (a) => {
    const args = a as unknown as RawArgs;
    if (args.event.channel_type === 'im') dispatch(args);
  });

  registerApprovalActions(app, deps);

  return {
    poster: boltPoster(app.client as unknown as BoltClient),
    async start() {
      await app.start();
      deps.log.info('nagi is listening (socket mode)');
    },
  };
}

function registerApprovalActions(app: InstanceType<typeof App>, deps: SlackAppDeps): void {
  const resolve = (allow: boolean) => async (raw: unknown): Promise<void> => {
    const a = raw as RawActionArgs;
    await a.ack();
    const requestId = a.action.value;
    if (!requestId) return;
    const who = a.body.user?.id ? `<@${a.body.user.id}>` : 'a user';
    const found = deps.approvals.resolve(requestId, {
      behavior: allow ? 'allow' : 'deny',
      reason: `${allow ? 'approved' : 'denied'} by ${who}`,
    });
    if (!found) deps.log.warn('approval click for unknown/expired request', { requestId });
  };
  app.action(APPROVE_ACTION, resolve(true));
  app.action(DENY_ACTION, resolve(false));
}

interface BoltClient {
  chat: {
    postMessage(a: Record<string, unknown>): Promise<{ ts?: string }>;
    update(a: Record<string, unknown>): Promise<unknown>;
  };
  files: { uploadV2(a: Record<string, unknown>): Promise<unknown> };
}

function boltPoster(client: BoltClient): SlackPoster {
  return {
    postMessage: (a) => client.chat.postMessage({ ...a }).then((r) => (r.ts ? { ts: r.ts } : {})),
    update: (a) => client.chat.update({ ...a }).then(() => undefined),
    uploadSnippet: (a) =>
      client.files
        .uploadV2({
          channel_id: a.channel,
          thread_ts: a.thread_ts,
          filename: `${a.title}.txt`,
          title: a.title,
          content: a.content,
        })
        .then(() => undefined),
  };
}
