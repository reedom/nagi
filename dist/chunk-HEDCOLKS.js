// src/config.ts
import { readFileSync } from "fs";
import { z } from "zod";
var triageSchema = z.object({
  model: z.string().min(1).default("claude-sonnet-4-6"),
  // Below this, triage posts a clarification instead of dispatching.
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  // The triage call gets its own runtime policy (escalation disabled).
  timeoutMs: z.number().int().positive().default(6e4),
  // Advisory ceiling; an overrun is audited, not fatal (triage output is
  // schema-bounded and small).
  tokenCap: z.number().int().positive().default(2e3)
});
var configSchema = z.object({
  slack: z.object({
    // The auth gate pins the workspace AND the user allowlist (D14).
    allowedTeamId: z.string().min(1),
    allowedUserIds: z.array(z.string().min(1)).min(1)
  }),
  // The host/owner scope allowlist: ghq repos whose segments match one of
  // these globs are the only candidates an agent may ever touch (security).
  repoScopes: z.array(z.string().min(1)).min(1),
  // Where learned ticket->repo-graph resolutions persist (runtime-written).
  learnedReposPath: z.string().default("./learned-repos.json"),
  // Upper bound on a ticket's dependency graph; protects against runaway growth.
  maxRepos: z.number().int().positive().default(10),
  // The provisioner script nagi runs to create/enter a worktree. Selecting a
  // different script swaps the mechanism (worktrunk, plain git, ...).
  worktree: z.object({ script: z.string().min(1).default("scripts/worktree-provision.worktrunk.sh") }).default({}),
  // Optional explicit cmux access for the surfaced lane. When omitted, the host
  // runs `cmux` with no --socket/--password and cmux self-resolves from its env
  // (CMUX_SOCKET_PATH, CMUX_SOCKET_PASSWORD), default socket, and saved Settings.
  // Set this only when nagi's environment does NOT inherit those (e.g. bare
  // launchd); prefer the env vars otherwise to keep the password out of config.
  cmux: z.object({
    socketPath: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    window: z.string().min(1).optional()
  }).optional(),
  triage: triageSchema.default({}),
  // Default per-request token budget; entries may override (3A). null = unbounded.
  defaultBudget: z.number().int().positive().nullable().default(null),
  auditLogPath: z.string().default("./audit.jsonl")
});
function parseConfig(raw) {
  return configSchema.parse(raw);
}
function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read config at ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return parseConfig(JSON.parse(text));
}
function loadSecrets(env) {
  const botToken = env["SLACK_BOT_TOKEN"];
  const appToken = env["SLACK_APP_TOKEN"];
  if (!botToken) throw new Error("SLACK_BOT_TOKEN is required");
  if (!appToken) throw new Error("SLACK_APP_TOKEN is required");
  return { botToken, appToken };
}

// src/logger.ts
function emit(level, msg, meta) {
  const suffix = meta && 0 < Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`[nagi:${level}] ${msg}${suffix}
`);
}
var logger = {
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta)
};

// src/util/env.ts
import { existsSync } from "fs";
function loadDotenv(path = process.env["NAGI_ENV_FILE"] ?? ".env") {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/runtime/runner.js
import { statSync } from "fs";
import { resolve as resolve2 } from "path";
import { pathToFileURL } from "url";

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/escalation/types.js
var DEFAULT_POLICY = { timeoutMs: 3e5, onTimeout: "deny" };

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/escalation/broker.js
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join as join2, dirname, sep } from "path";
import { createServer } from "net";

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/escalation/rules.js
import { readFileSync as readFileSync2 } from "fs";
import { homedir } from "os";
import { join } from "path";
function matchesRule(toolName, toolInput, rule) {
  const m = /^([A-Za-z][\w]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m)
    return false;
  const ruleTool = m[1];
  const arg = m[2];
  if (ruleTool !== toolName)
    return false;
  if (arg === void 0 || arg === "*")
    return true;
  if (toolName === "Bash")
    return matchesBashArg(toolInput, arg);
  return false;
}
function matchesBashArg(toolInput, arg) {
  const input = toolInput;
  const command = typeof input?.["command"] === "string" ? input["command"] : "";
  if (arg.endsWith(":*")) {
    const prefix = arg.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === arg;
}
function matchesAnyRule(toolName, toolInput, rules) {
  return rules.some((rule) => matchesRule(toolName, toolInput, rule));
}
function loadHomeDeferRules(home = homedir()) {
  return readDeferRules(join(home, ".claude", "settings.json"));
}
function loadProjectDeferRules(cwd) {
  return [
    ...readDeferRules(join(cwd, ".claude", "settings.json")),
    ...readDeferRules(join(cwd, ".claude", "settings.local.json"))
  ];
}
function readDeferRules(file) {
  const perms = readPermissions(file);
  return [...perms.allow ?? [], ...perms.deny ?? []];
}
function readPermissions(file) {
  try {
    const json = JSON.parse(readFileSync2(file, "utf8"));
    return json.permissions ?? {};
  } catch {
    return {};
  }
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/escalation/broker.js
var EscalationBroker = class {
  runId;
  socketPath;
  opts;
  inflight = /* @__PURE__ */ new Set();
  server;
  closing = false;
  constructor(opts) {
    this.opts = opts;
    this.runId = opts.runId;
    this.socketPath = join2(mkdtempSync(join2(tmpdir(), "awe-esc-")), "broker.sock");
  }
  async decide(req) {
    if (this.closing)
      return { behavior: "deny", reason: "run shutdown" };
    const rules = [
      ...req.rules ?? [],
      ...this.opts.settingsRules ?? [],
      ...this.projectRulesFor(req)
    ];
    if (matchesAnyRule(req.toolName, req.toolInput, rules))
      return { behavior: "defer" };
    const policy = req.policy ?? this.opts.defaultPolicy ?? DEFAULT_POLICY;
    this.log(`escalating ${req.agentLabel}: ${req.toolName} ${summarize(req.toolInput)}`);
    const decision = await this.escalate(req, policy);
    this.log(`decision for ${req.agentLabel}: ${decision.behavior}${decision.reason ? ` (${decision.reason})` : ""}`);
    return decision;
  }
  // A request with no cwd is assumed to run in the rules directory (the
  // run-level cwd) — the hook omits cwd only in that default case.
  projectRulesFor(req) {
    const pr = this.opts.projectRules;
    if (!pr)
      return [];
    const agentCwd = req.cwd ?? pr.cwd;
    const within = agentCwd === pr.cwd || agentCwd.startsWith(pr.cwd + sep);
    return within ? pr.rules : [];
  }
  escalate(req, policy) {
    return new Promise((resolve3) => {
      const settle = (d) => {
        if (!this.inflight.has(settle))
          return;
        this.inflight.delete(settle);
        resolve3(d);
      };
      this.inflight.add(settle);
      if (policy.onTimeout === "deny") {
        const timer = setTimeout(() => settle({ behavior: "deny", reason: "escalation timeout" }), policy.timeoutMs);
        timer.unref();
      }
      this.opts.channel.request(req).then(
        (d) => settle({ behavior: d.behavior, reason: d.reason }),
        // Channel failure must never be more permissive than today; a hung
        // channel is also useless to wait on, so deny immediately.
        (err) => settle({ behavior: "deny", reason: `channel error: ${String(err)}` })
      );
    });
  }
  async start() {
    if (this.server)
      throw new Error("EscalationBroker already started");
    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise((resolve3, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, resolve3);
    });
  }
  handleConnection(sock) {
    let buf = "";
    let answered = false;
    sock.on("data", (d) => {
      if (answered)
        return;
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0)
        return;
      answered = true;
      void this.answer(sock, buf.slice(0, nl));
    });
    sock.on("error", () => {
    });
  }
  async answer(sock, line) {
    let decision;
    try {
      decision = await this.decide(JSON.parse(line));
    } catch (err) {
      decision = { behavior: "deny", reason: `bad request: ${String(err)}` };
    }
    sock.end(`${JSON.stringify(decision)}
`);
  }
  async close() {
    this.closing = true;
    for (const settle of [...this.inflight])
      settle({ behavior: "deny", reason: "run shutdown" });
    if (this.server) {
      await new Promise((resolve3) => this.server?.close(() => resolve3()));
      this.server = void 0;
    }
    rmSync(dirname(this.socketPath), { recursive: true, force: true });
    await this.opts.channel.close?.();
  }
  log(msg) {
    this.opts.log?.(msg);
  }
};
function summarize(toolInput) {
  const text = JSON.stringify(toolInput) ?? "";
  return text.length <= 120 ? text : `${text.slice(0, 120)}...`;
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/runtime/orchestration.js
import { resolve } from "path";

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/runtime/limiter.js
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next)
      next();
  };
  return function limit(fn) {
    return new Promise((resolve3, reject) => {
      const run = () => {
        active += 1;
        fn().then(resolve3, reject).finally(release);
      };
      if (active < max)
        run();
      else
        queue.push(run);
    });
  };
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/runtime/orchestration.js
function createWorkflowApi(deps) {
  const limit = makeLimiter(deps.concurrency);
  let currentPhase = "";
  function resolveAgentCwd(opts) {
    const perCall = opts.cwd || void 0;
    if (perCall === void 0)
      return deps.cwd;
    return deps.cwd ? resolve(deps.cwd, perCall) : resolve(perCall);
  }
  function buildEscalation(prompt, opts) {
    const esc = deps.escalation;
    if (!esc || opts.escalation?.disabled)
      return void 0;
    return {
      runId: esc.broker.runId,
      socketPath: esc.broker.socketPath,
      agentLabel: opts.label ?? prompt.slice(0, 40),
      policy: {
        timeoutMs: opts.escalation?.timeoutMs ?? esc.defaultPolicy.timeoutMs,
        onTimeout: opts.escalation?.onTimeout ?? esc.defaultPolicy.onTimeout
      },
      rules: opts.tools ?? []
    };
  }
  async function agent(prompt, opts = {}) {
    const cliId = opts.cli ?? "claude";
    const adapter = deps.adapters[cliId];
    if (!adapter)
      throw new Error(`unknown cli adapter: ${cliId}`);
    if (deps.budget.total !== null && deps.budget.remaining() <= 0) {
      throw new Error("budget exhausted");
    }
    return limit(async () => {
      const result = await adapter.run({
        prompt,
        model: opts.model,
        schema: opts.schema,
        instructions: opts.instructions,
        tools: opts.tools,
        cwd: resolveAgentCwd(opts),
        escalation: buildEscalation(prompt, opts)
      });
      deps.budget.add(result.usage.inputTokens + result.usage.outputTokens);
      return result;
    });
  }
  async function parallel(thunks) {
    return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch((err) => {
      if (deps.onLog)
        deps.onLog(`parallel: task failed: ${String(err)}`);
      return null;
    })));
  }
  async function pipeline(items, ...stages) {
    return Promise.all(items.map(async (item, index) => {
      let acc = item;
      for (const stage of stages) {
        try {
          acc = await stage(acc, item, index);
        } catch {
          return null;
        }
      }
      return acc;
    }));
  }
  function phase(title) {
    currentPhase = title;
    if (deps.onLog)
      deps.onLog(`=== ${title} ===`);
  }
  function log(message) {
    if (deps.onLog)
      deps.onLog(currentPhase ? `[${currentPhase}] ${message}` : message);
  }
  return { agent, parallel, pipeline, phase, log, budget: deps.budget, args: deps.args };
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/runtime/budget.js
function makeBudget(total) {
  let spent = 0;
  return {
    total,
    spent: () => spent,
    remaining: () => total === null ? Infinity : Math.max(0, total - spent),
    add: (tokens) => {
      spent += tokens;
    }
  };
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/runtime/runner.js
function pinRunCwd(opts) {
  if (opts.cwd === void 0)
    return opts;
  const cwd = resolve2(opts.cwd);
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`run cwd is not a directory: ${cwd}`);
  }
  return { ...opts, cwd };
}
async function runWorkflow(mod, rawOpts) {
  const opts = pinRunCwd(rawOpts);
  const escalation = opts.escalation ? await startEscalation(opts) : void 0;
  try {
    const api = createWorkflowApi({
      adapters: opts.adapters,
      args: opts.args,
      budget: makeBudget(opts.budget ?? null),
      concurrency: opts.concurrency ?? 8,
      cwd: opts.cwd,
      onLog: opts.onLog,
      escalation
    });
    return await mod.default(api);
  } finally {
    await escalation?.broker.close();
  }
}
async function startEscalation(opts) {
  const cfg = opts.escalation;
  if (!cfg)
    throw new Error("unreachable");
  const defaultPolicy = { ...DEFAULT_POLICY, ...cfg.defaultPolicy };
  const rulesCwd = opts.cwd ?? process.cwd();
  const settingsRules = loadHomeDeferRules();
  const projectRules = cfg.trustCwdSettings ?? true ? { cwd: rulesCwd, rules: loadProjectDeferRules(rulesCwd) } : void 0;
  opts.onLog?.(`escalation: loaded ${settingsRules.length} home + ${projectRules?.rules.length ?? 0} project defer rules from ${rulesCwd}`);
  const broker = new EscalationBroker({
    runId: cfg.runId,
    channel: cfg.channel,
    settingsRules,
    projectRules,
    defaultPolicy,
    log: opts.onLog
  });
  try {
    await broker.start();
  } catch (err) {
    await broker.close();
    throw err;
  }
  return { broker, defaultPolicy };
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/adapters/claude.js
import { spawn } from "child_process";
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2, writeFileSync } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join3 } from "path";
import { fileURLToPath } from "url";
function buildClaudeArgs(spec) {
  const args = ["-p", spec.prompt, "--output-format", "json"];
  if (spec.model)
    args.push("--model", spec.model);
  if (spec.schema !== void 0)
    args.push("--json-schema", JSON.stringify(spec.schema));
  if (spec.instructions)
    args.push("--append-system-prompt", spec.instructions);
  const tools = spec.tools ?? [];
  if (0 < tools.length)
    args.push("--allowedTools", ...tools);
  return args;
}
function parseClaudeResult(stdout) {
  if (!stdout.trim())
    throw new Error("claude produced empty stdout");
  let env;
  try {
    env = JSON.parse(stdout);
  } catch {
    throw new Error(`claude stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }
  if (env["is_error"] === true) {
    const detail = env["result"] ?? env["api_error_status"] ?? "no detail";
    throw new Error(`claude error (${String(env["subtype"] ?? "unknown")}): ${String(detail)}`);
  }
  const usage = env["usage"] ?? {};
  return {
    text: typeof env["result"] === "string" ? env["result"] : "",
    data: "structured_output" in env ? env["structured_output"] : void 0,
    raw: env,
    usage: {
      inputTokens: Number(usage["input_tokens"] ?? 0),
      outputTokens: Number(usage["output_tokens"] ?? 0)
    },
    sessionId: typeof env["session_id"] === "string" ? env["session_id"] : void 0
  };
}
function runProcess(cmd, args, cwd) {
  return new Promise((resolve3, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve3({ stdout, stderr, code: code ?? -1 }));
  });
}
function buildEscalationSettings(esc, dir) {
  const metaPath = join3(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({
    runId: esc.runId,
    agentLabel: esc.agentLabel,
    policy: esc.policy,
    rules: esc.rules
  }));
  const helper = esc.helperCommand ?? defaultHelperCommand();
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${helper} --socket "${esc.socketPath}" --meta "${metaPath}"`,
              timeout: hookTimeoutSeconds(esc.policy)
            }
          ]
        }
      ]
    }
  };
  const settingsPath = join3(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings));
  return settingsPath;
}
function hookTimeoutSeconds(policy) {
  if (policy.onTimeout === "wait")
    return 86400;
  return Math.ceil(policy.timeoutMs / 1e3) + 60;
}
function defaultHelperCommand() {
  const helper = fileURLToPath(new URL("../escalation/hook-helper.js", import.meta.url));
  return `"${process.execPath}" "${helper}"`;
}
function makeClaudeAdapter(opts = {}) {
  const bin2 = opts.bin ?? "claude";
  const run = opts.spawnFn ?? runProcess;
  return {
    id: "claude",
    caps: { schema: true, resume: true, tools: true },
    async run(spec) {
      const args = buildClaudeArgs(spec);
      let tempDir;
      if (spec.escalation) {
        tempDir = mkdtempSync2(join3(tmpdir2(), "awe-claude-"));
        args.push("--settings", buildEscalationSettings(spec.escalation, tempDir));
      }
      try {
        const { stdout, stderr, code } = await run(bin2, args, spec.cwd);
        if (code !== 0)
          throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`);
        return parseClaudeResult(stdout);
      } finally {
        if (tempDir)
          rmSync2(tempDir, { recursive: true, force: true });
      }
    }
  };
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/adapters/codex.js
function buildCodexArgs(spec, sandbox) {
  if (spec.schema !== void 0) {
    throw new Error("codex adapter does not support schema output yet");
  }
  const prompt = spec.instructions ? `${spec.instructions}

${spec.prompt}` : spec.prompt;
  const args = [
    "exec",
    prompt,
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    sandbox
  ];
  if (spec.model)
    args.push("--model", spec.model);
  return args;
}
function parseCodexEvents(stdout) {
  if (!stdout.trim())
    throw new Error("codex produced empty stdout");
  let text;
  let sessionId;
  let usage = {};
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started")
      sessionId = event.thread_id;
    if (event.type === "turn.failed") {
      throw new Error(`codex turn failed: ${event.error?.message ?? "no detail"}`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      text = event.item.text;
    }
    if (event.type === "turn.completed" && event.usage)
      usage = event.usage;
  }
  if (text === void 0)
    throw new Error("codex emitted no agent message");
  return {
    text,
    raw: stdout,
    usage: {
      inputTokens: Number(usage["input_tokens"] ?? 0),
      outputTokens: Number(usage["output_tokens"] ?? 0)
    },
    sessionId
  };
}
function makeCodexAdapter(opts = {}) {
  const bin2 = opts.bin ?? "codex";
  const run = opts.spawnFn ?? runProcess;
  const sandbox = opts.sandbox ?? "workspace-write";
  return {
    id: "codex",
    caps: { schema: false, resume: true, tools: false },
    async run(spec) {
      const { stdout, stderr, code } = await run(bin2, buildCodexArgs(spec, sandbox), spec.cwd);
      if (code !== 0)
        throw new Error(`codex exited ${code}: ${stderr.trim().slice(0, 500)}`);
      return parseCodexEvents(stdout);
    }
  };
}

// node_modules/.pnpm/ai-workflow-engine@file+..+ai-workflow-engine/node_modules/ai-workflow-engine/dist/escalation/channels/agentbus.js
import { mkdtempSync as mkdtempSync3, writeFileSync as writeFileSync2, rmSync as rmSync3 } from "fs";
import { tmpdir as tmpdir3 } from "os";
import { join as join4, dirname as dirname2 } from "path";

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/adapter.js
import { mkdirSync, writeFileSync as writeFileSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join5 } from "path";
import { randomUUID } from "crypto";

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/prompt.js
function agentbusDirective(runId, nagiInstance) {
  const from = `ext:awe-${runId}`;
  return [
    `You are running as an agent under nagi, runId "${runId}".`,
    `You may send progress updates at meaningful milestones over the agentbus CLI (optional, zero or more times):`,
    `  printf '%s' '{"type":"progress","runId":"${runId}","text":"<short status>"}' | agentbus send ${nagiInstance} --from ${from}`,
    `Your FINAL assistant message is automatically captured and reported as the result, so end with a clear, complete final answer. Do NOT ask follow-up questions or wait for further input.`,
    `Tool approvals are handled automatically by the harness; just proceed with your work.`
  ].join("\n");
}
function composeSystemPrompt(instructions, directive) {
  return instructions ? `${instructions}

${directive}` : directive;
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/launcher.js
function shellQuote(arg) {
  const escaped = arg.replaceAll("'", `'\\''`);
  return `'${escaped}'`;
}
function launcherScript(bin2, args) {
  const line = [bin2, ...args].map(shellQuote).join(" ");
  return `#!/usr/bin/env bash
exec ${line}
`;
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/adapter.js
var DEFAULT_POLICY2 = { timeoutMs: 864e5, onTimeout: "wait" };
function makeSurfaceAdapter(deps) {
  const nagiInstance = deps.nagiInstance ?? "nagi";
  const runsDir = deps.runsDir ?? join5(homedir2(), ".agent-surface-adapters", "runs");
  const id = deps.id ?? deps.host.id;
  return {
    id,
    caps: { schema: false, resume: false, tools: true },
    async run(spec) {
      const runId = spec.escalation?.runId ?? deps.newRunId?.() ?? randomUUID();
      const sessionId = deps.newSessionId?.() ?? randomUUID();
      const policy = spec.escalation?.policy ?? DEFAULT_POLICY2;
      const runDir = join5(runsDir, runId);
      mkdirSync(runDir, { recursive: true });
      const settingsFile = deps.agent.writeApprovalSettings({ runDir, runId, sessionId, nagiInstance, policy });
      const systemPrompt = composeSystemPrompt(spec.instructions, agentbusDirective(runId, nagiInstance));
      const args = deps.agent.buildArgs({
        sessionId,
        settingsFile,
        systemPrompt,
        prompt: spec.prompt,
        model: spec.model,
        addDir: spec.cwd
      });
      const scriptPath = join5(runDir, "launch.sh");
      writeFileSync3(scriptPath, launcherScript(deps.agent.bin, args));
      const surface = await deps.host.launch({ cwd: spec.cwd, command: `bash ${shellQuote(scriptPath)}` });
      deps.onSurface?.(surface);
      const result = await deps.awaitResult(runId);
      const usage = deps.agent.readUsage(sessionId, spec.cwd) ?? { inputTokens: 0, outputTokens: 0 };
      return { text: result.text, raw: { surface, runId, sessionId }, usage, sessionId };
    }
  };
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/run.js
import { spawn as spawn2 } from "child_process";
var runProcess2 = (cmd, args, opts) => new Promise((resolve3, reject) => {
  const useStdin = opts?.input !== void 0;
  const child = spawn2(cmd, args, {
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
  child.on("close", (code) => resolve3({ stdout, stderr, code: code ?? -1 }));
  if (useStdin && child.stdin) {
    child.stdin.write(opts.input);
    child.stdin.end();
  }
});

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/hosts/cmux.js
function makeCmuxHost(opts = {}) {
  const bin2 = opts.bin ?? "cmux";
  const run = opts.runner ?? runProcess2;
  const globalArgs = () => {
    const args = [];
    if (opts.socketPath)
      args.push("--socket", opts.socketPath);
    if (opts.password)
      args.push("--password", opts.password);
    return args;
  };
  const runOrThrow = async (verb, args) => {
    const r = await run(bin2, [...globalArgs(), ...args]);
    if (r.code !== 0)
      throw new Error(`cmux ${verb} failed: ${r.stderr.trim().slice(0, 300)}`);
  };
  return {
    id: "cmux",
    async launch(input) {
      const args = globalArgs();
      args.push("new-workspace");
      if (input.cwd)
        args.push("--cwd", input.cwd);
      args.push("--command", input.command, "--json");
      if (opts.window)
        args.push("--window", opts.window);
      const r = await run(bin2, args);
      if (r.code !== 0)
        throw new Error(`cmux new-workspace failed: ${r.stderr.trim().slice(0, 300)}`);
      let ref;
      try {
        const j = JSON.parse(r.stdout);
        const found = j.surface ?? j.workspace ?? j.id;
        ref = typeof found === "string" ? found : void 0;
      } catch {
      }
      return { raw: r.stdout.trim(), ref };
    },
    // Drive a resident REPL: type text, then submit/control with a key.
    async send(surfaceRef, text) {
      await runOrThrow("send", ["send", "--surface", surfaceRef, text]);
    },
    async sendKey(surfaceRef, key) {
      await runOrThrow("send-key", ["send-key", "--surface", surfaceRef, key]);
    }
  };
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/profile.js
import { execPath } from "process";
import { fileURLToPath as fileURLToPath2 } from "url";

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/command.js
function buildClaudeArgs2(input) {
  const args = [
    "--session-id",
    input.sessionId,
    "--settings",
    input.settingsFile,
    "--append-system-prompt",
    input.systemPrompt
  ];
  if (input.model)
    args.push("--model", input.model);
  if (input.addDir)
    args.push("--add-dir", input.addDir);
  args.push("--", input.prompt);
  return args;
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/settings.js
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync4 } from "fs";
import { join as join6 } from "path";
function hookTimeoutSeconds2(policy) {
  if (policy.onTimeout === "wait")
    return 86400;
  return Math.ceil(policy.timeoutMs / 1e3) + 60;
}
function writeApprovalSettings(input) {
  mkdirSync2(input.runDir, { recursive: true });
  const metaPath = join6(input.runDir, "meta.json");
  writeFileSync4(metaPath, JSON.stringify({
    runId: input.runId,
    sessionId: input.sessionId,
    nagiInstance: input.nagiInstance,
    timeoutMs: input.policy.onTimeout === "wait" ? 864e5 : input.policy.timeoutMs
  }));
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${input.hookCommand} --meta "${metaPath}"`,
              timeout: hookTimeoutSeconds2(input.policy)
            }
          ]
        }
      ],
      // At end of turn, report the final assistant message as the run's result
      // over agentbus (deterministic reporting; does not block the agent).
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `${input.stopHookCommand} --meta "${metaPath}"`,
              timeout: 120
            }
          ]
        }
      ]
    }
  };
  const settingsPath = join6(input.runDir, "settings.json");
  writeFileSync4(settingsPath, JSON.stringify(settings));
  return settingsPath;
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/result.js
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join7 } from "path";
function projectsBase(deps) {
  return deps.projectsDir ?? join7(homedir3(), ".claude", "projects");
}
function findTranscript(sessionId, deps = {}) {
  const base = projectsBase(deps);
  if (!existsSync2(base))
    return null;
  for (const dir of readdirSync(base)) {
    const candidate = join7(base, dir, `${sessionId}.jsonl`);
    if (existsSync2(candidate))
      return candidate;
  }
  return null;
}
function readUsage(sessionId, deps = {}) {
  const file = findTranscript(sessionId, deps);
  if (!file)
    return null;
  const lines = readFileSync3(file, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; 0 <= i; i--) {
    try {
      const event = JSON.parse(lines[i]);
      const usage = event.message?.usage;
      if (usage && (usage.input_tokens !== void 0 || usage.output_tokens !== void 0)) {
        return { inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) };
      }
    } catch {
    }
  }
  return null;
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/profile.js
function makeClaudeProfile(opts = {}) {
  const bin2 = opts.bin ?? "claude";
  const hookHelperPath = opts.hookHelperPath ?? fileURLToPath2(new URL("./hook/approve-via-agentbus.js", import.meta.url));
  const reportHookHelperPath = opts.reportHookHelperPath ?? fileURLToPath2(new URL("./hook/report-result-via-agentbus.js", import.meta.url));
  return {
    id: "claude",
    bin: bin2,
    buildArgs: (input) => buildClaudeArgs2(input),
    writeApprovalSettings: ({ runDir, runId, sessionId, nagiInstance, policy }) => writeApprovalSettings({
      runDir,
      runId,
      sessionId,
      nagiInstance,
      policy,
      hookCommand: `"${execPath}" "${hookHelperPath}"`,
      stopHookCommand: `"${execPath}" "${reportHookHelperPath}"`
    }),
    readUsage: (sessionId) => readUsage(sessionId)
  };
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/presets.js
function makeCmuxClaudeAdapter(opts) {
  return makeSurfaceAdapter({
    id: "cmux",
    host: makeCmuxHost({ bin: opts.cmuxBin, socketPath: opts.cmuxSocketPath, password: opts.cmuxPassword, window: opts.cmuxWindow }),
    agent: makeClaudeProfile({ bin: opts.claudeBin, hookHelperPath: opts.hookHelperPath }),
    awaitResult: opts.awaitResult,
    nagiInstance: opts.nagiInstance,
    runsDir: opts.runsDir,
    newRunId: opts.newRunId,
    newSessionId: opts.newSessionId,
    onSurface: opts.onSurface
  });
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/agentbus.js
function bin(opts) {
  return opts.bin ?? "agentbus";
}
function runner(opts) {
  return opts.runner ?? runProcess2;
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

// src/audit.ts
import { appendFileSync } from "fs";
function makeAuditLog(path, log, clock = () => (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    record(entry) {
      const line = `${JSON.stringify({ ts: clock(), ...entry })}
`;
      try {
        appendFileSync(path, line);
      } catch (err) {
        log.warn("audit write failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
}

// src/registry/types.ts
var Registry = class {
  byId;
  constructor(entries) {
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
  }
  get(id) {
    return this.byId.get(id);
  }
  has(id) {
    return this.byId.has(id);
  }
  ids() {
    return [...this.byId.keys()];
  }
  list() {
    return [...this.byId.values()];
  }
};
function buildRegistry(factories, ctx) {
  return new Registry(factories.map((make) => make(ctx)));
}

// src/thread-state.ts
function makeThreadStore(opts = {}) {
  const ttlMs = opts.ttlMs ?? 15 * 60 * 1e3;
  const now = opts.now ?? (() => Date.now());
  const entries = /* @__PURE__ */ new Map();
  const live = (entry) => {
    if (!entry) return void 0;
    return now() < entry.expiresAt ? entry : void 0;
  };
  return {
    get(threadTs) {
      const entry = live(entries.get(threadTs));
      if (!entry) entries.delete(threadTs);
      return entry;
    },
    set(threadTs, pending) {
      entries.set(threadTs, { ...pending, expiresAt: now() + ttlMs });
    },
    delete(threadTs) {
      entries.delete(threadTs);
    },
    sweep() {
      const cutoff = now();
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= cutoff) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size() {
      return entries.size;
    }
  };
}

// src/escalation/approval-registry.ts
var ApprovalRegistry = class {
  pending = /* @__PURE__ */ new Map();
  register(requestId, resolve3) {
    this.pending.set(requestId, resolve3);
  }
  /** Returns true if a pending approval was found and resolved. */
  resolve(requestId, decision) {
    const resolver = this.pending.get(requestId);
    if (!resolver) return false;
    this.pending.delete(requestId);
    resolver(decision);
    return true;
  }
  has(requestId) {
    return this.pending.has(requestId);
  }
  size() {
    return this.pending.size;
  }
};

// src/agentbus-bridge/pending-runs.ts
var defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};
function bindingOf(e) {
  const b = { channel: e.channel, threadTs: e.threadTs, ceilingMs: e.ceilingMs };
  if (e.surfaceRef !== void 0) b.surfaceRef = e.surfaceRef;
  return b;
}
var PendingRuns = class {
  map = /* @__PURE__ */ new Map();
  await(runId, binding, deps = {}) {
    const schedule = deps.schedule ?? defaultSchedule;
    const promise = new Promise((resolve3, reject) => {
      const cancelTimer = schedule(() => {
        this.map.delete(runId);
        reject(new Error("surfaced run exceeded its wait ceiling"));
      }, binding.ceilingMs);
      const entry = {
        ...binding,
        resolve: (text) => resolve3({ text }),
        reject,
        cancelTimer,
        promise: void 0
      };
      this.map.set(runId, entry);
    });
    const e = this.map.get(runId);
    if (e) e.promise = promise;
    return promise;
  }
  awaitExisting(runId) {
    const e = this.map.get(runId);
    if (!e) return Promise.reject(new Error(`no pending run ${runId}`));
    return e.promise;
  }
  get(runId) {
    const e = this.map.get(runId);
    return e ? bindingOf(e) : void 0;
  }
  setSurfaceRef(runId, surfaceRef) {
    const e = this.map.get(runId);
    if (e) e.surfaceRef = surfaceRef;
  }
  resolveResult(runId, text) {
    const e = this.map.get(runId);
    if (!e) return false;
    this.map.delete(runId);
    e.cancelTimer();
    e.resolve(text);
    return true;
  }
  cancel(runId) {
    const e = this.map.get(runId);
    if (!e) return void 0;
    this.map.delete(runId);
    e.cancelTimer();
    e.reject(new Error("surfaced run cancelled"));
    return bindingOf(e);
  }
  active() {
    return [...this.map.keys()];
  }
  /** Cancels every active run; returns how many. Bindings are returned via the iterator for surface cleanup. */
  cancelAll() {
    const ids = this.active();
    for (const id of ids) this.cancel(id);
    return ids.length;
  }
};

// src/residents/resident-sessions.ts
var ResidentSessions = class {
  byThread = /* @__PURE__ */ new Map();
  threadByRun = /* @__PURE__ */ new Map();
  add(session) {
    this.byThread.set(session.threadTs, session);
    this.threadByRun.set(session.runId, session.threadTs);
  }
  getByThread(threadTs) {
    return this.byThread.get(threadTs);
  }
  getByRun(runId) {
    const threadTs = this.threadByRun.get(runId);
    return threadTs === void 0 ? void 0 : this.byThread.get(threadTs);
  }
  remove(threadTs) {
    const session = this.byThread.get(threadTs);
    if (!session) return void 0;
    this.byThread.delete(threadTs);
    this.threadByRun.delete(session.runId);
    return session;
  }
  list() {
    return [...this.byThread.values()];
  }
};

// src/slack/ports.ts
function makeReplier(poster, channel, threadTs) {
  return {
    async say(text) {
      await poster.postMessage({ channel, thread_ts: threadTs, text });
    }
  };
}
function makeGate(poster, channel, threadTs) {
  return {
    async post(text, blocks) {
      const res = await poster.postMessage({ channel, thread_ts: threadTs, text, blocks });
      if (!res.ts) throw new Error("Slack postMessage returned no message ts");
      return { ts: res.ts };
    },
    async update(ts, text, blocks) {
      await poster.update({ channel, ts, text, blocks });
    },
    async uploadSnippet(title, content) {
      await poster.uploadSnippet({ channel, thread_ts: threadTs, title, content });
    }
  };
}

// src/escalation/blocks.ts
var APPROVE_ACTION = "nagi_approve";
var DENY_ACTION = "nagi_deny";
var INLINE_LIMIT = 2500;
function formatToolInput(input) {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
function shouldInline(formatted) {
  return formatted.length <= INLINE_LIMIT;
}
function header(req) {
  return `:lock: *Approval needed* \u2014 \`${req.agentLabel}\` (${req.cli}) wants to run *${req.toolName}*`;
}
function buildApprovalBlocks(req, requestId) {
  const formatted = formatToolInput(req.toolInput);
  const inline = shouldInline(formatted);
  const body = inline ? `\`\`\`${formatted}\`\`\`` : "_Tool input is large; full payload attached as a snippet below._";
  return {
    text: `Approval needed for ${req.toolName} (${req.agentLabel})`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${header(req)}
${body}` } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            action_id: APPROVE_ACTION,
            value: requestId
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Deny" },
            action_id: DENY_ACTION,
            value: requestId
          }
        ]
      }
    ]
  };
}
function buildDecisionBlocks(req, decision) {
  const verb = decision.behavior === "allow" ? ":white_check_mark: Approved" : ":no_entry: Denied";
  const reason = decision.reason ? ` \u2014 ${decision.reason}` : "";
  return {
    text: `${verb}: ${req.toolName}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${verb} *${req.toolName}* (\`${req.agentLabel}\`)${reason}` }
      }
    ]
  };
}

// src/escalation/slack-channel.ts
var defaultSchedule2 = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
function makeSlackApprovalChannel(deps) {
  const schedule = deps.schedule ?? defaultSchedule2;
  let tail = Promise.resolve();
  const handle = async (req) => {
    const requestId = deps.newId();
    const formatted = formatToolInput(req.toolInput);
    const { text, blocks } = buildApprovalBlocks(req, requestId);
    const posted = await deps.gate.post(text, blocks);
    if (!shouldInline(formatted)) {
      await deps.gate.uploadSnippet(`tool input \u2014 ${req.toolName}`, formatted);
    }
    const decision = await waitForDecision(deps, schedule, requestId, req.policy ?? DEFAULT_POLICY);
    const final = buildDecisionBlocks(req, decision);
    await deps.gate.update(posted.ts, final.text, final.blocks);
    deps.onResolved?.(decision);
    return decision;
  };
  return {
    id: "slack",
    request(req) {
      const result = tail.then(() => handle(req));
      tail = result.then(
        () => void 0,
        () => void 0
      );
      return result;
    }
  };
}
function waitForDecision(deps, schedule, requestId, policy) {
  return new Promise((resolve3) => {
    let cancelTimer;
    const finish = (decision) => {
      cancelTimer?.();
      resolve3(decision);
    };
    deps.registry.register(requestId, finish);
    if (policy.onTimeout === "deny") {
      cancelTimer = schedule(() => {
        deps.registry.resolve(requestId, { behavior: "deny", reason: "approval timed out" });
      }, policy.timeoutMs);
    }
  });
}

// src/agentbus-bridge/bridge.ts
async function handleEnvelope(env, deps) {
  const runId = typeof env.payload.runId === "string" ? env.payload.runId : void 0;
  const type = env.payload.type;
  if (!runId) {
    deps.log.warn("agentbus envelope without runId", { id: env.id });
    return;
  }
  const pendingBinding = deps.pending.get(runId);
  const resident = deps.residents.getByRun(runId);
  const binding = pendingBinding ?? resident;
  if (!binding) {
    deps.log.warn("agentbus envelope for unknown/expired run", { runId, type });
    return;
  }
  if (env.kind === "ask" && type === "approval") {
    const cwd = typeof env.payload["cwd"] === "string" ? env.payload["cwd"] : void 0;
    const req = {
      runId,
      agentLabel: "surface",
      cli: "cmux",
      toolName: String(env.payload["tool"] ?? ""),
      toolInput: env.payload["input"],
      policy: DEFAULT_POLICY,
      ...cwd !== void 0 ? { cwd } : {}
    };
    const channel = makeSlackApprovalChannel({
      gate: makeGate(deps.poster, binding.channel, binding.threadTs),
      registry: deps.registry,
      newId: deps.newId
    });
    const decision = await channel.request(req);
    await deps.agentbusReply(env.id, decision);
    return;
  }
  if (type === "progress") {
    const text = typeof env.payload["text"] === "string" ? env.payload["text"] : "";
    await makeReplier(deps.poster, binding.channel, binding.threadTs).say(`:hourglass_flowing_sand: ${text}`);
    return;
  }
  if (type === "result") {
    const text = typeof env.payload["text"] === "string" ? env.payload["text"] : "";
    if (pendingBinding) {
      deps.pending.resolveResult(runId, text);
    } else {
      await makeReplier(deps.poster, binding.channel, binding.threadTs).say(text);
    }
    return;
  }
  deps.log.warn("agentbus envelope of unknown type", { runId, type });
}

// src/dispatcher/queue.ts
var WorkQueue = class {
  constructor(log) {
    this.log = log;
  }
  log;
  active;
  pending = [];
  /** Returns whether the job starts now or is queued behind the active one. */
  enqueue(job) {
    const idle = this.active === void 0 && this.pending.length === 0;
    this.pending.push(job);
    if (this.active === void 0) void this.pump();
    if (idle) return { accepted: true };
    const busyWith = this.active?.label ?? "a queued task";
    return { accepted: false, busyWith, position: this.pending.length };
  }
  status() {
    return {
      ...this.active ? { active: this.active.label } : {},
      queued: this.pending.map((job) => job.label)
    };
  }
  /** Drops not-yet-started jobs (used by `cancel`); the active run is killed elsewhere. */
  clearPending() {
    const dropped = this.pending.length;
    this.pending.length = 0;
    return dropped;
  }
  async pump() {
    while (this.pending.length !== 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.active = job;
      try {
        await job.run();
      } catch (err) {
        this.log.error("queue job threw past its handler", {
          label: job.label,
          error: err instanceof Error ? err.message : String(err)
        });
      } finally {
        this.active = void 0;
      }
    }
  }
};

// src/dispatcher/kill-tree.ts
import { execFileSync } from "child_process";
function readProcessTable() {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  return children;
}
function descendantPids(root, table) {
  const result = [];
  const stack = [...table.get(root) ?? []];
  while (stack.length !== 0) {
    const pid = stack.pop();
    if (pid === void 0) continue;
    result.push(pid);
    stack.push(...table.get(pid) ?? []);
  }
  return result;
}
function killActiveRunDescendants(log, rootPid = process.pid) {
  let pids;
  try {
    pids = descendantPids(rootPid, readProcessTable());
  } catch (err) {
    log.warn("could not enumerate processes to cancel", {
      error: err instanceof Error ? err.message : String(err)
    });
    return 0;
  }
  for (const pid of pids.reverse()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  }
  return pids.length;
}

// src/auth/allowlist.ts
function checkAuth(config, req) {
  if (req.teamId !== config.slack.allowedTeamId) {
    return { allowed: false, reason: "workspace not allowlisted" };
  }
  if (!config.slack.allowedUserIds.includes(req.userId)) {
    return { allowed: false, reason: "user not allowlisted" };
  }
  return { allowed: true };
}
var REFUSAL_MESSAGE = "Sorry, I can't act on requests from this account. Ask the operator to add you to the allowlist.";

// src/util/timeout.ts
var TimeoutError = class extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
};
function withTimeout(work, ms, label) {
  return new Promise((resolve3, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve3(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

// src/triage/describe.ts
import { z as z2 } from "zod";
function zodToReadable(schema) {
  if (schema instanceof z2.ZodObject) {
    const shape = schema.shape;
    const fields = Object.entries(shape).map(([key, value]) => `${key}: ${describeField(value)}`);
    return `{ ${fields.join(", ")} }`;
  }
  return describeField(schema);
}
function describeField(schema) {
  if (schema instanceof z2.ZodOptional) return `${describeField(schema.unwrap())}?`;
  if (schema instanceof z2.ZodDefault) return `${describeField(schema._def.innerType)} (optional)`;
  if (schema instanceof z2.ZodEnum) return `one of [${schema.options.join(" | ")}]`;
  if (schema instanceof z2.ZodString) return "string";
  if (schema instanceof z2.ZodNumber) return "number";
  if (schema instanceof z2.ZodBoolean) return "boolean";
  return "value";
}

// src/triage/prompt.ts
function buildTriagePrompt(registry) {
  const entries = registry.list().map((e) => `- id: ${e.id}
  description: ${e.description}
  args: ${zodToReadable(e.argsSchema)}`).join("\n");
  return [
    "You are the triage step of an AI concierge. Given a user request, pick the single",
    "best workflow to run and extract its arguments. You MUST return JSON matching the",
    "provided schema and nothing else.",
    "",
    "Available workflows:",
    entries,
    "",
    "Rules:",
    "- workflowId MUST be one of the listed ids. If none fits, set confidence low and",
    "  put a one-sentence clarificationQuestion describing what you need.",
    "- Extract args strictly from the listed arg shapes.",
    "- confidence is your honest probability (0..1) that this dispatch is correct.",
    "- If the request is ambiguous or under-specified, lower confidence and ask via",
    "  clarificationQuestion instead of guessing."
  ].join("\n");
}
function buildTriageUserPrompt(text) {
  return `User request:
${text}`;
}

// src/triage/schema.ts
import { z as z3 } from "zod";
var triageResultSchema = z3.object({
  workflowId: z3.string(),
  args: z3.record(z3.string(), z3.unknown()).default({}),
  confidence: z3.number().min(0).max(1),
  clarificationQuestion: z3.string().nullish()
});
var triageJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workflowId: { type: "string" },
    args: { type: "object" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    clarificationQuestion: { type: ["string", "null"] }
  },
  required: ["workflowId", "args", "confidence"]
};

// src/triage/triage.ts
async function runTriage(deps, text) {
  const instructions = buildTriagePrompt(deps.registry);
  const spec = {
    prompt: buildTriageUserPrompt(text),
    model: deps.policy.model,
    schema: triageJsonSchema,
    instructions,
    tools: []
  };
  const result = await withTimeout(deps.adapter.run(spec), deps.policy.timeoutMs, "triage");
  if (deps.policy.tokenCap < result.usage.outputTokens) {
    deps.log.warn("triage exceeded token cap", {
      cap: deps.policy.tokenCap,
      outputTokens: result.usage.outputTokens
    });
  }
  if (result.data === void 0) {
    throw new Error("triage returned no structured output");
  }
  return triageResultSchema.parse(result.data);
}

// src/dispatcher/decide.ts
function decide(config, registry, triage) {
  const punt = triage.clarificationQuestion?.trim();
  if (punt) return { kind: "clarify", question: punt };
  if (triage.confidence < config.triage.confidenceThreshold) {
    return { kind: "clarify", question: chooseWorkflowQuestion(registry) };
  }
  const entry = registry.get(triage.workflowId);
  if (!entry) return { kind: "clarify", question: chooseWorkflowQuestion(registry) };
  const parsed = entry.argsSchema.safeParse(triage.args);
  if (!parsed.success) {
    return { kind: "clarify", question: schemaQuestion(parsed.error) };
  }
  const args = parsed.data;
  const budget = entry.budgetOverride ?? config.defaultBudget;
  return { kind: "dispatch", entry, args, budget };
}
function chooseWorkflowQuestion(registry) {
  const options = registry.list().map((e) => `\u2022 *${e.id}* \u2014 ${e.description}`).join("\n");
  return `I'm not sure which workflow fits. I can run:
${options}
Which would you like, and with what details?`;
}
function schemaQuestion(error) {
  const issue = error.issues[0];
  const field = issue && issue.path.length !== 0 ? String(issue.path[0]) : "an argument";
  return `I need a clearer value for \`${field}\` (${issue?.message ?? "invalid"}). Could you restate it?`;
}

// src/dispatcher/control.ts
function parseControl(text) {
  const normalized = text.trim().toLowerCase();
  if (normalized === "status") return "status";
  if (normalized === "cancel" || normalized === "stop" || normalized === "abort") return "cancel";
  if (normalized === "done" || normalized === "close") return "done";
  return void 0;
}

// src/dispatcher/format.ts
function shortLabel(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 47)}\u2026`;
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function formatStatus(status) {
  const active = status.active ? `Running: *${status.active}*` : "Idle \u2014 nothing running.";
  if (status.queued.length === 0) return active;
  const queued = status.queued.map((label, i) => `  ${i + 1}. ${label}`).join("\n");
  return `${active}
Queued (${status.queued.length}):
${queued}`;
}
function formatResult(result) {
  if (result && typeof result === "object") {
    const record = result;
    const summary = record["summary"] ?? record["answer"];
    if (typeof summary === "string") return summary;
  }
  return `\`\`\`${JSON.stringify(result, null, 2)}\`\`\``;
}

// src/dispatcher/dispatcher.ts
var RESIDENT_HINT = ":speech_balloon: Surface is live \u2014 reply here to keep talking; say `done` to close it.";
var Dispatcher = class {
  constructor(deps) {
    this.deps = deps;
    this.runWorkflowFn = deps.runWorkflowFn ?? runWorkflow;
  }
  deps;
  cancelling = false;
  runWorkflowFn;
  /** Entry point for every inbound Slack message. Never throws. */
  async handle(req) {
    const replier = this.deps.makeReplier(req);
    const auth = checkAuth(this.deps.config, req);
    if (!auth.allowed) {
      await this.safeSay(replier, REFUSAL_MESSAGE);
      this.record(req, "refused", auth.reason ? { detail: auth.reason } : {});
      return;
    }
    const control = parseControl(req.text);
    if (control) {
      await this.handleControl(control, req, replier);
      return;
    }
    const resident = this.deps.residents.getByThread(req.threadTs);
    if (resident) {
      await this.feedResident(resident, req, replier);
      return;
    }
    const pending = this.deps.threadStore.get(req.threadTs);
    const text = pending ? `${pending.originalText}

[follow-up] ${req.text}` : req.text;
    if (pending) this.deps.threadStore.delete(req.threadTs);
    const admission = this.deps.queue.enqueue({
      label: shortLabel(req.text),
      run: () => this.process(req, text, replier)
    });
    if (!admission.accepted) {
      await this.safeSay(
        replier,
        `I'm busy with \u201C${admission.busyWith}\u201D. Queued your request (position ${admission.position}); I'll run it when the current one finishes.`
      );
    }
  }
  /** Pipe an in-thread message straight into a resident's live REPL (send-immediately). */
  async feedResident(resident, req, replier) {
    try {
      await this.deps.host.send(resident.surfaceRef, req.text);
      await this.deps.host.sendKey(resident.surfaceRef, "Return");
      this.record(req, "resident-input");
    } catch (err) {
      this.deps.residents.remove(req.threadTs);
      await this.safeSay(replier, ":ghost: Resident seems gone; closing. Send your message again to start fresh.");
      this.record(req, "failed", { detail: `resident send: ${errorMessage(err)}` });
    }
  }
  async handleControl(command, req, replier) {
    if (command === "status") {
      await this.safeSay(replier, formatStatus(this.deps.queue.status()));
      this.record(req, "control", { detail: "status" });
      return;
    }
    if (command === "done") {
      const resident = this.deps.residents.remove(req.threadTs);
      if (!resident) {
        const liveKeys = this.deps.residents.list().map((r) => r.threadTs);
        await this.safeSay(replier, "No resident agent in this thread.");
        this.record(req, "control", {
          detail: `done: none (lookup=${req.threadTs} live=[${liveKeys.join(",")}])`
        });
        return;
      }
      void this.deps.closeSurface(resident.surfaceRef).catch(
        (e) => this.deps.log.warn("close-surface failed", { runId: resident.runId, error: errorMessage(e) })
      );
      await this.safeSay(replier, ":octagonal_sign: Resident closed.");
      this.record(req, "control", { detail: "done" });
      return;
    }
    this.cancelling = true;
    const killed = this.deps.cancelActiveRun();
    const dropped = this.deps.queue.clearPending();
    const surfaced = this.deps.pending.active();
    for (const runId of surfaced) {
      const binding = this.deps.pending.cancel(runId);
      if (binding?.surfaceRef) {
        void this.deps.closeSurface(binding.surfaceRef).catch(
          (e) => this.deps.log.warn("close-surface failed", { runId, error: errorMessage(e) })
        );
      }
    }
    const residents = this.deps.residents.list();
    for (const resident of residents) {
      this.deps.residents.remove(resident.threadTs);
      void this.deps.closeSurface(resident.surfaceRef).catch(
        (e) => this.deps.log.warn("close-surface failed", { runId: resident.runId, error: errorMessage(e) })
      );
    }
    await this.safeSay(
      replier,
      `Cancelling: signalled ${killed} process(es), dropped ${dropped} queued request(s), cancelled ${surfaced.length} surface run(s), and closed ${residents.length} resident(s).`
    );
    this.record(req, "cancelled", {
      detail: `killed=${killed} dropped=${dropped} surfaced=${surfaced.length} residents=${residents.length}`
    });
  }
  async process(req, text, replier) {
    this.cancelling = false;
    let triageResult;
    try {
      triageResult = await runTriage(this.deps.triage, text);
    } catch (err) {
      await this.safeSay(replier, `:warning: I couldn't triage that: ${errorMessage(err)}`);
      this.record(req, "failed", { detail: `triage: ${errorMessage(err)}` });
      return;
    }
    const decision = decide(this.deps.config, this.deps.registry, triageResult);
    if (decision.kind === "clarify") {
      this.deps.threadStore.set(req.threadTs, { originalText: text, question: decision.question });
      await this.safeSay(replier, decision.question);
      this.record(req, "clarification", {
        workflowId: triageResult.workflowId,
        args: triageResult.args,
        detail: decision.question
      });
      return;
    }
    await this.safeSay(
      replier,
      `On it \u2014 running *${decision.entry.id}* with \`${JSON.stringify(decision.args)}\`.`
    );
    this.record(req, "dispatched", { workflowId: decision.entry.id, args: decision.args });
    if (decision.entry.surfaced) {
      this.launchSurfaced(req, replier, decision);
      return;
    }
    await this.runDispatched(req, replier, decision);
  }
  async runDispatched(req, replier, decision) {
    const runId = this.deps.newRunId();
    let approvals = 0;
    const channel = makeSlackApprovalChannel({
      gate: this.deps.makeGate(req),
      registry: this.deps.approvals,
      newId: this.deps.newApprovalId,
      onResolved: () => {
        approvals += 1;
      }
    });
    const options = {
      adapters: { claude: this.deps.adapters.claude, codex: this.deps.adapters.codex },
      args: decision.args,
      budget: decision.budget,
      ...decision.cwd ? { cwd: decision.cwd } : {},
      escalation: { channel, runId, defaultPolicy: { onTimeout: "wait" } },
      onLog: (m) => this.deps.log.info(`[wf:${runId}] ${m}`)
    };
    try {
      const result = await this.runWorkflowFn(decision.entry.module, options);
      await this.safeSay(replier, formatResult(result));
      this.record(req, "completed", { workflowId: decision.entry.id, args: decision.args, approvals });
    } catch (err) {
      const cancelled = this.cancelling;
      const prefix = cancelled ? ":octagonal_sign: Run cancelled" : ":warning: Run failed";
      await this.safeSay(replier, `${prefix}: ${errorMessage(err)}`);
      this.record(req, cancelled ? "cancelled" : "failed", {
        workflowId: decision.entry.id,
        args: decision.args,
        approvals,
        detail: errorMessage(err)
      });
    }
  }
  launchSurfaced(req, replier, decision) {
    const runId = this.deps.newRunId();
    const adapter = this.deps.makeSurfaceAdapter(
      runId,
      (surfaceRef) => this.deps.residents.add({ runId, surfaceRef, channel: req.channel, threadTs: req.threadTs })
    );
    const awaited = this.deps.pending.await(runId, {
      channel: req.channel,
      threadTs: req.threadTs,
      ceilingMs: this.deps.surfaceCeilingMs
    });
    const options = {
      adapters: { cmux: adapter },
      args: decision.args,
      budget: decision.budget,
      ...decision.cwd ? { cwd: decision.cwd } : {},
      onLog: (m) => this.deps.log.info(`[surface:${runId}] ${m}`)
    };
    void this.runWorkflowFn(decision.entry.module, options).then(async (result) => {
      await this.safeSay(replier, formatResult(result));
      await this.safeSay(replier, RESIDENT_HINT);
      this.record(req, "resident-ready", { workflowId: decision.entry.id, args: decision.args });
    }).catch(async (err) => {
      const stale = this.deps.residents.remove(req.threadTs);
      if (stale) {
        void this.deps.closeSurface(stale.surfaceRef).catch(
          (e) => this.deps.log.warn("close-surface failed", { runId, error: errorMessage(e) })
        );
      }
      const cancelled = /cancelled/.test(errorMessage(err));
      const prefix = cancelled ? ":octagonal_sign: Surface run cancelled" : ":warning: Surface run failed";
      await this.safeSay(replier, `${prefix}: ${errorMessage(err)}`);
      this.record(req, cancelled ? "cancelled" : "failed", {
        workflowId: decision.entry.id,
        args: decision.args,
        detail: errorMessage(err)
      });
    });
    void awaited.catch(() => {
    });
  }
  record(req, outcome, extra = {}) {
    this.deps.audit.record({
      teamId: req.teamId,
      userId: req.userId,
      channel: req.channel,
      threadTs: req.threadTs,
      text: req.text,
      outcome,
      ...extra
    });
  }
  async safeSay(replier, text) {
    try {
      await replier.say(text);
    } catch (err) {
      this.deps.log.error("failed to post to Slack", { error: errorMessage(err) });
    }
  }
};

// src/slack/app.ts
import bolt from "@slack/bolt";
var { App } = bolt;
function stripMentions(text) {
  return text.replace(/<@[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function toRequestContext(args) {
  const { event, context } = args;
  const teamId = context.teamId;
  if (!teamId || !event.user || !event.channel || !event.ts) return void 0;
  return {
    teamId,
    userId: event.user,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: stripMentions(event.text ?? "")
  };
}
function createSlackBot(deps) {
  const app = new App({
    token: deps.secrets.botToken,
    appToken: deps.secrets.appToken,
    socketMode: true
  });
  const dispatch = (args) => {
    const req = toRequestContext(args);
    if (!req) return;
    if (args.event.bot_id || req.userId === args.context.botUserId) return;
    void deps.handle(req).catch((err) => deps.log.error("handle threw", { error: String(err) }));
  };
  app.event("app_mention", async (a) => dispatch(a));
  app.message(async (a) => {
    const args = a;
    if (args.event.channel_type === "im") dispatch(args);
  });
  registerApprovalActions(app, deps);
  return {
    poster: boltPoster(app.client),
    async start() {
      await app.start();
      deps.log.info("nagi is listening (socket mode)");
    }
  };
}
function registerApprovalActions(app, deps) {
  const resolve3 = (allow) => async (raw) => {
    const a = raw;
    await a.ack();
    const requestId = a.action.value;
    if (!requestId) return;
    const who = a.body.user?.id ? `<@${a.body.user.id}>` : "a user";
    const found = deps.approvals.resolve(requestId, {
      behavior: allow ? "allow" : "deny",
      reason: `${allow ? "approved" : "denied"} by ${who}`
    });
    if (!found) deps.log.warn("approval click for unknown/expired request", { requestId });
  };
  app.action(APPROVE_ACTION, resolve3(true));
  app.action(DENY_ACTION, resolve3(false));
}
function boltPoster(client) {
  return {
    postMessage: (a) => client.chat.postMessage({ ...a }).then((r) => r.ts ? { ts: r.ts } : {}),
    update: (a) => client.chat.update({ ...a }).then(() => void 0),
    uploadSnippet: (a) => client.files.uploadV2({
      channel_id: a.channel,
      thread_ts: a.thread_ts,
      filename: `${a.title}.txt`,
      title: a.title,
      content: a.content
    }).then(() => void 0)
  };
}

// src/util/id.ts
import { randomUUID as randomUUID2 } from "crypto";
function newId(prefix) {
  return `${prefix}_${randomUUID2().slice(0, 8)}`;
}

// src/create-nagi.ts
var SWEEP_INTERVAL_MS = 5 * 60 * 1e3;
var SURFACE_CEILING_MS = 30 * 60 * 1e3;
var NAGI_INSTANCE = "nagi";
function createNagi(options) {
  if (options.workflows.length === 0) throw new Error("createNagi requires at least one workflow");
  const config = typeof options.config === "string" ? loadConfig(options.config) : parseConfig(options.config);
  const log = options.logger ?? logger;
  const registry = buildRegistry(options.workflows, { config });
  let started = false;
  let pumping = false;
  let sweep;
  let botRef;
  async function start() {
    if (started) return;
    started = true;
    loadDotenv();
    const secrets = loadSecrets(process.env);
    const claude = options.adapters?.claude ?? makeClaudeAdapter();
    const codex = options.adapters?.codex ?? makeCodexAdapter({ sandbox: "danger-full-access" });
    const audit = makeAuditLog(config.auditLogPath, log);
    const queue = new WorkQueue(log);
    const threadStore = makeThreadStore();
    const approvals = new ApprovalRegistry();
    const pending = new PendingRuns();
    const residents = new ResidentSessions();
    const makeSurfaceAdapter2 = (runId, onSurfaceRef) => makeCmuxClaudeAdapter({
      nagiInstance: NAGI_INSTANCE,
      newRunId: () => runId,
      awaitResult: () => pending.awaitExisting(runId),
      onSurface: (surface) => {
        if (surface.ref) {
          pending.setSurfaceRef(runId, surface.ref);
          onSurfaceRef?.(surface.ref);
        }
      },
      ...config.cmux?.socketPath ? { cmuxSocketPath: config.cmux.socketPath } : {},
      ...config.cmux?.password ? { cmuxPassword: config.cmux.password } : {},
      ...config.cmux?.window ? { cmuxWindow: config.cmux.window } : {}
    });
    const closeSurface = async (surfaceRef) => {
      const args = [];
      if (config.cmux?.socketPath) args.push("--socket", config.cmux.socketPath);
      if (config.cmux?.password) args.push("--password", config.cmux.password);
      args.push("close-surface", surfaceRef);
      await runProcess2("cmux", args);
    };
    const cmuxHost = makeCmuxHost({
      ...config.cmux?.socketPath ? { socketPath: config.cmux.socketPath } : {},
      ...config.cmux?.password ? { password: config.cmux.password } : {},
      ...config.cmux?.window ? { window: config.cmux.window } : {}
    });
    const host = {
      send: (surfaceRef, text) => cmuxHost.send(surfaceRef, text),
      sendKey: (surfaceRef, key) => cmuxHost.sendKey(surfaceRef, key)
    };
    let poster;
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
      newRunId: () => newId("run"),
      newApprovalId: () => newId("appr"),
      cancelActiveRun: () => killActiveRunDescendants(log),
      pending,
      makeSurfaceAdapter: makeSurfaceAdapter2,
      surfaceCeilingMs: SURFACE_CEILING_MS,
      closeSurface,
      residents,
      host
    });
    const bot = createSlackBot({
      secrets,
      approvals,
      log,
      handle: (req) => dispatcher.handle(req)
    });
    poster = bot.poster;
    botRef = bot;
    await register(NAGI_INSTANCE, { persistent: true });
    const bridgeDeps = {
      poster,
      pending,
      residents,
      registry: approvals,
      newId: () => newId("appr"),
      agentbusReply: (askId, payload) => reply(askId, NAGI_INSTANCE, payload),
      log
    };
    pumping = true;
    const pump = async () => {
      while (pumping) {
        try {
          const envs = await awaitInbox(NAGI_INSTANCE, 1e3);
          for (const env of envs) {
            void handleEnvelope(env, bridgeDeps).catch(
              (e) => log.error("bridge handleEnvelope threw", { error: String(e) })
            );
          }
        } catch (e) {
          log.error("agentbus inbox poll failed", { error: String(e) });
          await new Promise((r) => setTimeout(r, 1e3));
        }
      }
    };
    void pump();
    sweep = setInterval(() => {
      const removed = threadStore.sweep();
      if (removed !== 0) log.info("swept expired clarifications", { removed });
    }, SWEEP_INTERVAL_MS);
    sweep.unref();
    await bot.start();
  }
  async function stop() {
    pumping = false;
    if (sweep) clearInterval(sweep);
    await botRef?.stop?.();
    started = false;
  }
  return { start, stop };
}

export {
  parseConfig,
  loadConfig,
  logger,
  loadDotenv,
  createNagi
};
