import type { ApprovalGate } from '../escalation/slack-channel.js';
import type { ThreadReplier } from '../types.js';

// A minimal Slack Web API surface, decoupled from @slack/bolt so the reply and
// approval-gate adapters can be unit-tested with a fake.

export interface SlackPoster {
  postMessage(args: {
    channel: string;
    thread_ts: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ts?: string }>;
  update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  uploadSnippet(args: {
    channel: string;
    thread_ts: string;
    title: string;
    content: string;
  }): Promise<void>;
}

export function makeReplier(poster: SlackPoster, channel: string, threadTs: string): ThreadReplier {
  return {
    async say(text: string): Promise<void> {
      await poster.postMessage({ channel, thread_ts: threadTs, text });
    },
  };
}

export function makeGate(poster: SlackPoster, channel: string, threadTs: string): ApprovalGate {
  return {
    async post(text, blocks) {
      const res = await poster.postMessage({ channel, thread_ts: threadTs, text, blocks });
      if (!res.ts) throw new Error('Slack postMessage returned no message ts');
      return { ts: res.ts };
    },
    async update(ts, text, blocks) {
      await poster.update({ channel, ts, text, blocks });
    },
    async uploadSnippet(title, content) {
      await poster.uploadSnippet({ channel, thread_ts: threadTs, title, content });
    },
  };
}
