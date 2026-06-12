import { describe, expect, it } from 'vitest';
import { makeGate, makeReplier, type SlackPoster } from '../src/slack/ports.js';

function fakePoster(ts?: string) {
  const posts: unknown[] = [];
  const updates: unknown[] = [];
  const snippets: unknown[] = [];
  const poster: SlackPoster = {
    async postMessage(a) {
      posts.push(a);
      return ts ? { ts } : {};
    },
    async update(a) {
      updates.push(a);
    },
    async uploadSnippet(a) {
      snippets.push(a);
    },
  };
  return { poster, posts, updates, snippets };
}

describe('slack ports', () => {
  it('replier posts into the bound thread', async () => {
    const { poster, posts } = fakePoster('ts1');
    await makeReplier(poster, 'C1', 'TS1').say('hello');
    expect(posts[0]).toMatchObject({ channel: 'C1', thread_ts: 'TS1', text: 'hello' });
  });

  it('gate.post returns the message ts', async () => {
    const { poster } = fakePoster('ts1');
    const res = await makeGate(poster, 'C1', 'TS1').post('t', []);
    expect(res.ts).toBe('ts1');
  });

  it('gate.post throws if Slack returns no ts', async () => {
    const { poster } = fakePoster(undefined);
    await expect(makeGate(poster, 'C1', 'TS1').post('t', [])).rejects.toThrow(/no message ts/);
  });

  it('gate.uploadSnippet targets the thread', async () => {
    const { poster, snippets } = fakePoster('ts1');
    await makeGate(poster, 'C1', 'TS1').uploadSnippet('title', 'body');
    expect(snippets[0]).toMatchObject({ channel: 'C1', thread_ts: 'TS1', title: 'title', content: 'body' });
  });
});
