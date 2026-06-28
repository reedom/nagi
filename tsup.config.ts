import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'workflows/index': 'src/workflows/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  dts: { resolve: true },
  clean: true,
  // Inline the workspace deps so the git dependency is self-contained.
  noExternal: ['ai-workflow-engine', 'agent-surface-adapters'],
  // Keep real npm deps external (consumer installs them).
  external: ['@slack/bolt', 'zod'],
});
