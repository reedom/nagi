import {
  askApproval
} from "../chunk-ZO2TLVOL.js";

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/hook/approve-via-agentbus.js
import { readFileSync } from "fs";
import { pathToFileURL } from "url";
function takeArg(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0)
    return void 0;
  return argv[i + 1];
}
function topLevelPipeline(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      if (ch === quote)
        quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "`")
      return null;
    if (ch === "$" && next === "(")
      return null;
    if (ch === "&")
      return null;
    if (ch === "|" && next === "|")
      return null;
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote)
    return null;
  segments.push(current);
  return segments;
}
function isSelfReport(toolName, toolInput, nagiInstance) {
  if (toolName !== "Bash")
    return false;
  const command = toolInput?.command;
  if (typeof command !== "string")
    return false;
  const segments = topLevelPipeline(command);
  if (!segments)
    return false;
  const trimmed = segments.map((s) => s.trim());
  if (2 < trimmed.length)
    return false;
  if (trimmed.length === 2 && !/^(printf|echo)\b/.test(trimmed[0] ?? ""))
    return false;
  const report = trimmed[trimmed.length - 1] ?? "";
  const m = report.match(/^agentbus\s+(send|reply|publish)\b(.*)$/);
  if (!m)
    return false;
  const verb = m[1];
  const tokens = (m[2] ?? "").trim().split(/\s+/).filter((t) => t.length !== 0);
  if (verb === "publish")
    return true;
  if (verb === "reply")
    return tokens[1] === nagiInstance;
  return tokens[0] === nagiInstance;
}
function decisionJson(behavior, reason) {
  const decision = behavior === "deny" ? { behavior, message: reason } : { behavior };
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  });
}
async function runApprovalHook(argv, stdinJson, deps = {}) {
  const metaPath = takeArg(argv, "--meta");
  if (!metaPath)
    throw new Error("usage: approve-via-agentbus --meta <file>");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const hook = JSON.parse(stdinJson);
  if (isSelfReport(hook.tool_name ?? "", hook.tool_input, meta.nagiInstance)) {
    return decisionJson("allow", "agentbus self-report");
  }
  const ask = deps.ask ?? askApproval;
  const payload = {
    type: "approval",
    runId: meta.runId,
    tool: hook.tool_name ?? "",
    input: hook.tool_input,
    cwd: hook.cwd
  };
  const decision = await ask(meta.nagiInstance, `ext:awe-${meta.runId}`, meta.timeoutMs, payload);
  return decisionJson(decision.behavior, decision.reason ?? `agentbus: ${decision.behavior}`);
}
async function readAllStdin() {
  let data = "";
  for await (const chunk of process.stdin)
    data += chunk;
  return data;
}
var entry = process.argv[1];
if (entry !== void 0 && import.meta.url === pathToFileURL(entry).href) {
  readAllStdin().then((stdin) => runApprovalHook(process.argv.slice(2), stdin)).then((out) => {
    process.stdout.write(`${out}
`);
    process.exit(0);
  }).catch((err) => {
    process.stderr.write(`approve-hook: ${err instanceof Error ? err.message : String(err)}
`);
    process.stdout.write(`${decisionJson("deny", "approval hook error")}
`);
    process.exit(0);
  });
}
export {
  isSelfReport,
  runApprovalHook
};
