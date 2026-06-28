// src/registry/workflows/review-repo.ts
import { z } from "zod";
var reviewModule = {
  meta: { name: "review-repo", description: "Review a repository or its working diff and summarize the top risks." },
  async default(wf) {
    const args = wf.args;
    const target = args.scope === "diff" ? "the current uncommitted/working diff" : "the repository as a whole";
    const focus = args.focus ? `

Pay special attention to: ${args.focus}.` : "";
    wf.phase("review");
    const result = await wf.agent(
      `Locate the repo matching "${args.repoHint}" with your tools, cd into it, and review ${target}. Identify the most important correctness, security, and maintainability risks. Use read-only inspection (git, ripgrep, file reads). Return a concise prioritized summary with file:line references.${focus}`,
      { label: "review", tools: ["Bash", "Read", "Grep", "Glob"] }
    );
    return { summary: result.text, usage: result.usage };
  }
};
var reviewRepoEntry = () => ({
  id: "review-repo",
  description: "Review a repository (or its working diff) and summarize the most important risks. Use when the user asks to review, audit, or assess a repo or a diff.",
  argsSchema: z.object({
    repoHint: z.string().min(1),
    scope: z.enum(["repo", "diff"]).default("repo"),
    focus: z.string().optional()
  }),
  module: reviewModule
});

// src/registry/workflows/research.ts
import { z as z2 } from "zod";
var ANGLES = ["fundamentals and definitions", "trade-offs and risks", "concrete current options"];
var researchModule = {
  meta: {
    name: "research",
    description: "Research a question from several angles in parallel, then synthesize.",
    phases: [{ title: "gather" }, { title: "synthesize" }]
  },
  async default(wf) {
    const { question } = wf.args;
    wf.phase("gather");
    const findings = await wf.parallel(
      ANGLES.map(
        (angle) => () => wf.agent(`Research this question focusing on ${angle}: ${question}`, {
          label: `gather:${angle.split(" ")[0]}`,
          tools: ["Bash", "Read", "Grep", "Glob"]
        })
      )
    );
    wf.phase("synthesize");
    const notes = findings.filter((f) => f !== null).map((f, i) => `## Angle ${i + 1}
${f.text}`).join("\n\n");
    const synthesis = await wf.agent(
      `Synthesize these research notes into one concise, balanced answer to "${question}":

${notes}`,
      { label: "synthesize" }
    );
    return { answer: synthesis.text };
  }
};
var researchEntry = () => ({
  id: "research",
  description: "Research an open question from multiple angles and synthesize an answer. Use when the user asks to research, investigate, or compare options for a topic.",
  argsSchema: z2.object({
    question: z2.string().min(1)
  }),
  module: researchModule
});

// src/registry/workflows/surface.ts
import { z as z3 } from "zod";
var surfaceModule = {
  meta: {
    name: "surface",
    description: "Run one interactive agent on a cmux surface and report its result."
  },
  async default(wf) {
    const args = wf.args;
    const result = await wf.agent(args.task, { cli: "cmux" });
    return { text: result.text };
  }
};
var surfaceEntry = () => ({
  id: "surface",
  description: "Run a task as an interactive agent on a visible cmux surface (you can watch and intervene). The surface stays resident: reply in the same thread to keep talking to it, and say `done` to close it. Use when the user asks to open/run something on a surface, or wants a watchable interactive run.",
  argsSchema: z3.object({ task: z3.string().min(1) }),
  module: surfaceModule,
  surfaced: true
});

// src/registry/workflows/approval-demo.ts
import { z as z4 } from "zod";
var demoModule = {
  meta: {
    name: "approval-demo",
    description: "Force a tool-approval prompt to test the escalation round-trip."
  },
  async default(wf) {
    const result = await wf.agent(
      "You MUST use the Bash tool to run exactly `date -u` and report its output verbatim. Do not answer from memory \u2014 you must actually call the tool.",
      { label: "approval-demo" }
      // no `tools` granted → the Bash call escalates
    );
    return { summary: `Approval demo finished. Agent reported:
${result.text}` };
  }
};
var approvalDemoEntry = () => ({
  id: "approval-demo",
  description: "Run a harmless command (`date -u`) that requires tool approval, to test the Approve/Deny escalation buttons. Use when the user asks to test approvals or escalation.",
  argsSchema: z4.object({}),
  module: demoModule
});

// src/registry/workflows/investigate-ticket.ts
import { z as z6 } from "zod";

// src/repo/memory.ts
import { readFileSync, writeFileSync, renameSync } from "fs";
var EMPTY = { version: 1, tickets: {}, aliases: {} };
var RepoMemory = class _RepoMemory {
  constructor(path, data) {
    this.path = path;
    this.data = data;
  }
  path;
  data;
  static load(path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed.version === 1 && parsed.tickets != null && parsed.aliases != null) return new _RepoMemory(path, parsed);
    } catch {
    }
    return new _RepoMemory(path, structuredClone(EMPTY));
  }
  get(ticket) {
    return this.data.tickets[ticket];
  }
  getAlias(name) {
    return this.data.aliases[name];
  }
  remember(ticket, graph) {
    this.data.tickets[ticket] = graph;
    this.flush();
  }
  rememberAlias(name, repoPath) {
    this.data.aliases[name] = repoPath;
    this.flush();
  }
  flush() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
};

// src/repo/worktree.ts
import { execFile } from "child_process";
import { promisify } from "util";
var exec = promisify(execFile);
var defaultRunner = async (script, repoPath, ticket) => {
  const { stdout } = await exec(script, [ticket], {
    cwd: repoPath,
    env: { ...process.env, NAGI_TICKET: ticket, NAGI_REPO_PATH: repoPath }
  });
  return stdout;
};
var ScriptProvisioner = class {
  constructor(script, run2 = defaultRunner) {
    this.script = script;
    this.run = run2;
  }
  script;
  run;
  async provision(repoPath, ticket) {
    if (!/^[A-Za-z0-9._-]+$/.test(ticket)) {
      throw new Error(`invalid ticket: must match [A-Za-z0-9._-], got: ${ticket}`);
    }
    const stdout = await this.run(this.script, repoPath, ticket);
    const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length !== 0);
    const last = lines[lines.length - 1];
    if (!last) throw new Error(`worktree script printed no worktree path: ${this.script}`);
    return last;
  }
};

// src/repo/ghq.ts
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";

// src/repo/scope.ts
function matches(repoPath, scope) {
  const scopeParts = scope.split("/").filter((s) => s.length !== 0);
  if (scopeParts.length < 2) return false;
  const wildcard = scopeParts[scopeParts.length - 1] === "*";
  const needed = wildcard ? scopeParts.slice(0, -1) : scopeParts;
  const parts = repoPath.split("/").filter((s) => s.length !== 0);
  const tailLen = wildcard ? needed.length + 1 : needed.length;
  if (parts.length < tailLen) return false;
  const ownerTail = wildcard ? parts.slice(-tailLen, -1) : parts.slice(-tailLen);
  return needed.every((seg, i) => seg === ownerTail[i]);
}
function filterScope(repoPaths, scopes) {
  const approved = [];
  const rejected = [];
  for (const p of repoPaths) {
    if (scopes.some((s) => matches(p, s))) approved.push(p);
    else rejected.push(p);
  }
  return { approved, rejected };
}

// src/repo/ghq.ts
var run = promisify2(execFile2);
var defaultRunner2 = async () => {
  const { stdout } = await run("ghq", ["list", "-p"]);
  return stdout;
};
async function listScopedRepos(scopes, runner = defaultRunner2) {
  let raw;
  try {
    raw = await runner();
  } catch (err) {
    throw new Error(`ghq list failed (is ghq installed?): ${err instanceof Error ? err.message : err}`);
  }
  const all = raw.split("\n").map((l) => l.trim()).filter((l) => l.length !== 0);
  return filterScope(all, scopes).approved;
}

// src/registry/workflows/steps/resolve-and-schedule.ts
import { z as z5 } from "zod";

// src/repo/graph.ts
var RepoGraph = class _RepoGraph {
  nodes = [];
  edges = [];
  processed = /* @__PURE__ */ new Set();
  addNode(p) {
    if (!this.nodes.includes(p)) this.nodes.push(p);
  }
  has(p) {
    return this.nodes.includes(p);
  }
  size() {
    return this.nodes.length;
  }
  // Dependencies of a node = the out-edge targets.
  dependenciesOf(p) {
    return this.edges.filter((e) => e.from === p).map((e) => e.to);
  }
  // Adding from -> to closes a cycle iff `to` can already reach `from`.
  wouldCreateCycle(from, to) {
    const seen = /* @__PURE__ */ new Set();
    const stack = [to];
    while (stack.length !== 0) {
      const cur = stack.pop();
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.dependenciesOf(cur));
    }
    return false;
  }
  addEdge(from, to, reason) {
    this.addNode(from);
    this.addNode(to);
    if (!this.edges.some((e) => e.from === from && e.to === to)) {
      this.edges.push({ from, to, reason });
    }
  }
  markProcessed(p) {
    this.processed.add(p);
  }
  hasUnprocessed() {
    return this.nodes.some((n) => !this.processed.has(n));
  }
  // Ready = unprocessed AND every dependency already processed.
  readyNodes() {
    return this.nodes.filter(
      (n) => !this.processed.has(n) && this.dependenciesOf(n).every((d) => this.processed.has(d))
    );
  }
  toData() {
    return { nodes: [...this.nodes], edges: this.edges.map((e) => ({ ...e })) };
  }
  static fromData(d) {
    const g = new _RepoGraph();
    for (const n of d.nodes) g.addNode(n);
    for (const e of d.edges) g.addEdge(e.from, e.to, e.reason);
    return g;
  }
  render() {
    const lines = ["graph LR"];
    for (const e of this.edges) lines.push(`  ${JSON.stringify(e.from)} --> ${JSON.stringify(e.to)}`);
    for (const n of this.nodes) if (!this.edges.some((e) => e.from === n || e.to === n)) lines.push(`  ${JSON.stringify(n)}`);
    return lines.join("\n");
  }
};

// src/registry/workflows/steps/resolve-and-schedule.ts
var identifySchema = z5.object({ repos: z5.array(z5.string()) });
var investigateSchema = z5.object({
  findings: z5.string(),
  dependencies: z5.array(z5.object({ repo: z5.string(), reason: z5.string() })).default([])
});
async function seed(wf, ticket, deps, graph, candidates) {
  const known = deps.memory.get(ticket);
  if (known) {
    const approved = new Set(
      filterScope(known.nodes, deps.scopes).approved.filter((n) => candidates.has(n))
    );
    for (const n of approved) graph.addNode(n);
    for (const e of known.edges) {
      if (approved.has(e.from) && approved.has(e.to)) graph.addEdge(e.from, e.to, e.reason);
    }
    return;
  }
  const res = await wf.agent(
    `Ticket: ${ticket}
Using your available ticket tools, read it and pick the repo(s) where investigation should START, choosing only from this candidate list:
${[...candidates].join("\n")}
Return { "repos": [...] } with absolute paths copied verbatim from the list.`,
    { label: "identify", phase: "identify", schema: identifySchema, tools: ["Bash", "Read", "Grep"] }
  );
  const picked = identifySchema.parse(res.data).repos;
  for (const p of filterScope(picked, deps.scopes).approved) {
    if (candidates.has(p)) graph.addNode(p);
  }
}
async function resolveAndSchedule(wf, ticket, deps) {
  const graph = new RepoGraph();
  const candidates = new Set(await deps.listRepos(deps.scopes));
  await seed(wf, ticket, deps, graph, candidates);
  const findings = [];
  let halted;
  while (graph.hasUnprocessed() && !halted) {
    const ready = graph.readyNodes();
    const batch = await wf.parallel(
      ready.map((repo) => async () => investigateNode(wf, ticket, repo, deps))
    );
    for (let i = 0; i < batch.length; i += 1) {
      const node = batch[i];
      const repo = ready[i];
      if (!node) {
        if (halted) break;
        graph.markProcessed(repo);
        findings.push({ repo, findings: "investigation failed (no agent result)", dependencies: [] });
        continue;
      }
      graph.markProcessed(node.repo);
      findings.push(node);
      halted = absorb(graph, node, deps, candidates);
      if (halted) break;
    }
    if (graph.size() !== 0 && deps.maxRepos <= graph.size() && graph.hasUnprocessed() && !halted) {
      halted = { reason: "maxRepos", detail: `graph reached the ${deps.maxRepos}-repo cap` };
    }
  }
  const data = graph.toData();
  if (!halted) deps.memory.remember(ticket, data);
  return { graph: data, findings, ...halted ? { halted } : {} };
}
async function investigateNode(wf, ticket, repo, deps) {
  const cwd = await deps.provisioner.provision(repo, ticket);
  const res = await wf.agent(
    `You are in a worktree for ticket ${ticket} at ${cwd}. Root-cause the ticket here. If the cause depends on OTHER repositories, list each as a dependency with a short reason. Return { "findings": "...", "dependencies": [{ "repo": "<absolute path>", "reason": "..." }] }.`,
    { label: "investigate", phase: "investigate", schema: investigateSchema, tools: ["Bash", "Read", "Grep"], cwd }
  );
  const parsed = investigateSchema.parse(res.data);
  return { repo, findings: parsed.findings, dependencies: parsed.dependencies };
}
function absorb(graph, node, deps, candidates) {
  const approved = filterScope(node.dependencies.map((d) => d.repo), deps.scopes).approved;
  for (const dep of node.dependencies) {
    if (!approved.includes(dep.repo)) continue;
    if (!candidates.has(dep.repo)) continue;
    if (graph.wouldCreateCycle(node.repo, dep.repo)) {
      return { reason: "cycle", detail: `${node.repo} <-> ${dep.repo}` };
    }
    graph.addEdge(node.repo, dep.repo, dep.reason);
  }
  return void 0;
}

// src/registry/workflows/investigate-ticket.ts
function makeModule(config) {
  return {
    meta: { name: "investigate-ticket", description: "Investigate a ticket across its dependent repositories." },
    async default(wf) {
      const args = wf.args;
      const deps = {
        scopes: config.repoScopes,
        maxRepos: config.maxRepos,
        memory: RepoMemory.load(config.learnedReposPath),
        provisioner: new ScriptProvisioner(config.worktree.script),
        listRepos: (scopes) => listScopedRepos(scopes)
      };
      const result = await resolveAndSchedule(wf, args.ticketRef, deps);
      const diagram = RepoGraph.fromData(result.graph).render();
      return {
        ticket: args.ticketRef,
        halted: result.halted ?? null,
        findings: result.findings.map((f) => ({ repo: f.repo, findings: f.findings })),
        graph: diagram
      };
    }
  };
}
var investigateTicket = (ctx) => makeInvestigateTicketEntry(ctx.config);
function makeInvestigateTicketEntry(config) {
  return {
    id: "investigate-ticket",
    description: "Investigate a ticket end-to-end: find the starting repo, root-cause it, and follow repo-to-repo dependencies. Use when the user references a ticket (e.g. ABC-1234, XYZ-1234).",
    argsSchema: z6.object({ ticketRef: z6.string().min(1), repoHint: z6.string().optional() }),
    module: makeModule(config)
  };
}

export {
  reviewRepoEntry,
  researchEntry,
  surfaceEntry,
  approvalDemoEntry,
  RepoMemory,
  ScriptProvisioner,
  filterScope,
  listScopedRepos,
  RepoGraph,
  resolveAndSchedule,
  investigateTicket
};
