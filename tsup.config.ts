import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'workflows/index': 'src/workflows/index.ts',
    cli: 'src/cli.ts',
    // The surfaced lane wires Claude Code hooks as `node <path>` commands, where the
    // path is resolved as `new URL('./hook/<name>.js', import.meta.url)` from the
    // bundled chunk — i.e. `dist/hook/<name>.js`. Emit those helpers as real files at
    // exactly that location so a bundled (git-installed) nagi can spawn them; otherwise
    // the surfaced agent's Stop/approval hooks point at non-existent files and never
    // report results. See agent-surface-adapters makeClaudeProfile.
    'hook/approve-via-agentbus':
      'node_modules/agent-surface-adapters/dist/agents/claude/hook/approve-via-agentbus.js',
    'hook/report-result-via-agentbus':
      'node_modules/agent-surface-adapters/dist/agents/claude/hook/report-result-via-agentbus.js',
  },
  format: ['esm'],
  dts: { resolve: true },
  clean: true,
  // Inline the workspace deps so the git dependency is self-contained.
  noExternal: ['ai-workflow-engine', 'agent-surface-adapters'],
  // Keep real npm deps external (consumer installs them).
  external: ['@slack/bolt', 'zod'],
});
