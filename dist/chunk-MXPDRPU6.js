// node_modules/.pnpm/agent-surface-adapters@file+..+agent-surface-adapters/node_modules/agent-surface-adapters/dist/agents/claude/result.js
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
function projectsBase(deps) {
  return deps.projectsDir ?? join(homedir(), ".claude", "projects");
}
function findTranscript(sessionId, deps = {}) {
  const base = projectsBase(deps);
  if (!existsSync(base))
    return null;
  for (const dir of readdirSync(base)) {
    const candidate = join(base, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate))
      return candidate;
  }
  return null;
}
function readUsage(sessionId, deps = {}) {
  const file = findTranscript(sessionId, deps);
  if (!file)
    return null;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
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

export {
  findTranscript,
  readUsage
};
