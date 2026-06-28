// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/run.js
import { spawn } from "child_process";
var runProcess = (cmd, args, opts) => new Promise((resolve, reject) => {
  const useStdin = opts?.input !== void 0;
  const child = spawn(cmd, args, {
    cwd: opts?.cwd,
    stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d;
  });
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  if (useStdin && child.stdin) {
    child.stdin.write(opts.input);
    child.stdin.end();
  }
});

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/agentbus.js
function bin(opts) {
  return opts.bin ?? "agentbus";
}
function runner(opts) {
  return opts.runner ?? runProcess;
}
function parseAskReply(stdout) {
  try {
    const env = JSON.parse(stdout);
    const reply2 = env.payload ?? {};
    const reason = typeof reply2.reason === "string" ? reply2.reason : void 0;
    if (reply2.behavior === "allow")
      return { behavior: "allow", reason };
    return { behavior: "deny", reason: reason ?? "denied" };
  } catch {
    return { behavior: "deny", reason: "unparseable reply" };
  }
}
async function askApproval(to, from, timeoutMs, payload, opts = {}) {
  const r = await runner(opts)(bin(opts), ["ask", to, "--from", from, "--timeout-ms", String(timeoutMs)], { input: JSON.stringify(payload) });
  if (r.code !== 0)
    return { behavior: "deny", reason: `ask failed: ${r.stderr.trim().slice(0, 200)}` };
  return parseAskReply(r.stdout);
}
async function awaitInbox(id, timeoutMs, opts = {}) {
  const r = await runner(opts)(bin(opts), ["await", id, "--timeout-ms", String(timeoutMs)]);
  if (r.code !== 0)
    return [];
  try {
    return JSON.parse(r.stdout).envelopes ?? [];
  } catch {
    return [];
  }
}
async function send(to, from, payload, opts = {}) {
  const r = await runner(opts)(bin(opts), ["send", to, "--from", from], { input: JSON.stringify(payload) });
  if (r.code !== 0)
    throw new Error(`agentbus send failed: ${r.stderr.trim().slice(0, 200)}`);
}
async function reply(askId, from, payload, opts = {}) {
  const r = await runner(opts)(bin(opts), ["reply", askId, from], { input: JSON.stringify(payload) });
  if (r.code !== 0)
    throw new Error(`agentbus reply failed: ${r.stderr.trim().slice(0, 200)}`);
}
async function register(id, opts = {}) {
  const args = ["register", id];
  if (opts.persistent)
    args.push("--persistent");
  if (opts.pid !== void 0)
    args.push("--pid", String(opts.pid));
  const r = await runner(opts)(bin(opts), args);
  if (r.code !== 0)
    throw new Error(`agentbus register failed: ${r.stderr.trim().slice(0, 200)}`);
}

export {
  runProcess,
  askApproval,
  awaitInbox,
  send,
  reply,
  register
};
