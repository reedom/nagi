import {
  findTranscript
} from "../chunk-MXPDRPU6.js";
import {
  send
} from "../chunk-ZO2TLVOL.js";

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/hook/report-result-via-agentbus.js
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/core/validate.js
var KNOWN_TYPES = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "object", "array"]);
function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const candidates = [
    { start: body.indexOf("{"), end: body.lastIndexOf("}") },
    { start: body.indexOf("["), end: body.lastIndexOf("]") }
  ].filter((c) => c.start !== -1 && c.end !== -1 && c.start < c.end).sort((a, b) => a.start - b.start);
  for (const { start, end } of candidates) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
    }
  }
  return void 0;
}
function typeOk(value, type) {
  if (type === void 0)
    return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}
function validateAgainstSchema(value, schema, path = "") {
  const where = path === "" ? "(root)" : path;
  const errors = [];
  if (schema.type !== void 0 && !KNOWN_TYPES.has(schema.type)) {
    return { ok: false, errors: [`${where}: unsupported schema type "${schema.type}"`] };
  }
  if (!typeOk(value, schema.type)) {
    return { ok: false, errors: [`${where}: expected ${schema.type}`] };
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${where}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value;
    for (const key of schema.required ?? []) {
      if (!(key in obj))
        errors.push(`${where}: missing required "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        errors.push(...validateAgainstSchema(obj[key], sub, path === "" ? key : `${path}.${key}`).errors);
      }
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`).errors);
    });
  }
  return { ok: errors.length === 0, errors };
}

// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/hook/report-result-via-agentbus.js
var DEFAULT_MAX_REPAIRS = 3;
function defaultReadSchema(schemaPath) {
  if (!existsSync(schemaPath))
    return null;
  try {
    return JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch {
    return null;
  }
}
function attemptsPath(runDir, key) {
  return join(runDir, `repair-attempts-${key}`);
}
function defaultReadAttempts(path) {
  if (!existsSync(path))
    return 0;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^\d+$/.test(raw))
    return Number.MAX_SAFE_INTEGER;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}
function defaultWriteAttempts(path, n) {
  writeFileSync(path, String(n));
}
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function takeArg(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0)
    return void 0;
  return argv[i + 1];
}
function extractText(content) {
  if (typeof content === "string") {
    const t = content.trim();
    return t.length !== 0 ? t : null;
  }
  if (Array.isArray(content)) {
    const parts = content.map((b) => typeof b === "object" && b !== null ? b : null).filter((b) => b !== null && b.type === "text" && typeof b.text === "string").map((b) => b.text);
    const joined = parts.join("\n").trim();
    return joined.length !== 0 ? joined : null;
  }
  return null;
}
function lastAssistantText(transcriptPath) {
  if (!existsSync(transcriptPath))
    return null;
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; 0 <= i; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      const isAssistant = ev.type === "assistant" || ev.message?.role === "assistant";
      if (!isAssistant)
        continue;
      const text = extractText(ev.message?.content);
      if (text)
        return text;
    } catch {
    }
  }
  return null;
}
async function runResultHook(argv, stdinJson, deps = {}) {
  const metaPath = takeArg(argv, "--meta");
  if (!metaPath)
    throw new Error("usage: report-result-via-agentbus --meta <file>");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const hook = JSON.parse(stdinJson);
  const readText = deps.readLastAssistantText ?? lastAssistantText;
  const resolveTranscript = deps.findTranscript ?? findTranscript;
  const sleep = deps.sleep ?? defaultSleep;
  const candidates = () => {
    const list = [];
    if (typeof hook.transcript_path === "string" && hook.transcript_path.length !== 0)
      list.push(hook.transcript_path);
    const byId = meta.sessionId ? resolveTranscript(meta.sessionId) : null;
    if (byId)
      list.push(byId);
    return list;
  };
  let text = null;
  for (let attempt2 = 0; attempt2 < 6; attempt2 += 1) {
    for (const path of candidates()) {
      text = readText(path);
      if (text)
        break;
    }
    if (text)
      break;
    await sleep(250);
  }
  const send2 = deps.send ?? send;
  const from = `ext:awe-${meta.runId}`;
  const finalText = text ?? "";
  if (!meta.schemaPath) {
    await send2(meta.nagiInstance, from, { type: "result", runId: meta.runId, text: finalText });
    return JSON.stringify({});
  }
  const readSchema = deps.readSchema ?? defaultReadSchema;
  const schema = readSchema(meta.schemaPath);
  if (!schema) {
    await send2(meta.nagiInstance, from, {
      type: "result",
      runId: meta.runId,
      text: finalText,
      error: `declared schema could not be read: ${meta.schemaPath}`
    });
    return JSON.stringify({});
  }
  const data = extractJsonObject(finalText);
  const validation = data === void 0 ? { ok: false, errors: ["final message was not a JSON object"] } : validateAgainstSchema(data, schema);
  if (validation.ok) {
    await send2(meta.nagiInstance, from, { type: "result", runId: meta.runId, text: finalText, data });
    return JSON.stringify({});
  }
  const runDir = dirname(metaPath);
  const apath = attemptsPath(runDir, meta.sessionId ?? meta.runId);
  const readAttempts = deps.readAttempts ?? defaultReadAttempts;
  const writeAttempts = deps.writeAttempts ?? defaultWriteAttempts;
  const attempt = readAttempts(apath);
  const declaredMax = meta.maxRepairs;
  const max = typeof declaredMax === "number" && Number.isInteger(declaredMax) && 0 <= declaredMax ? declaredMax : DEFAULT_MAX_REPAIRS;
  if (attempt < max) {
    writeAttempts(apath, attempt + 1);
    const feedback = `Your final message must be ONLY a JSON object matching the required schema, with no prose or code fences. Validation errors:
- ${validation.errors.join("\n- ")}
Re-output the corrected JSON object as your final message now.`;
    return JSON.stringify({
      decision: "block",
      reason: feedback,
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: feedback }
    });
  }
  await send2(meta.nagiInstance, from, {
    type: "result",
    runId: meta.runId,
    text: finalText,
    error: `schema validation failed after ${max} repair attempt(s): ${validation.errors.join("; ")}`
  });
  return JSON.stringify({});
}
async function readAllStdin() {
  let data = "";
  for await (const chunk of process.stdin)
    data += chunk;
  return data;
}
var entry = process.argv[1];
if (entry !== void 0 && import.meta.url === pathToFileURL(entry).href) {
  readAllStdin().then((stdin) => runResultHook(process.argv.slice(2), stdin)).then((out) => {
    process.stdout.write(`${out}
`);
    process.exit(0);
  }).catch((err) => {
    process.stderr.write(`report-result-hook: ${err instanceof Error ? err.message : String(err)}
`);
    process.stdout.write(`${JSON.stringify({})}
`);
    process.exit(0);
  });
}
export {
  defaultReadAttempts,
  lastAssistantText,
  runResultHook
};
