import { readFileSync } from 'node:fs';

const offenders = ['ai-workflow-engine', 'agent-surface-adapters'];
const files = ['dist/index.js', 'dist/workflows/index.js', 'dist/cli.js'];
let bad = false;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const o of offenders) {
    // a bare specifier import/require of the workspace package == leak
    if (new RegExp(`from\\s+['"]${o}['"]|require\\(['"]${o}['"]\\)`).test(src)) {
      console.error(`LEAK: ${f} still imports ${o}`);
      bad = true;
    }
  }
}
if (bad) process.exit(1);
console.log('bundle is self-contained');
