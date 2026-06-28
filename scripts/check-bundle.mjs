import { readFileSync } from 'node:fs';

const offenders = ['ai-workflow-engine', 'agent-surface-adapters'];
const jsFiles = ['dist/index.js', 'dist/workflows/index.js', 'dist/cli.js'];
const dtsFiles = ['dist/index.d.ts', 'dist/workflows/index.d.ts', 'dist/cli.d.ts'];
let bad = false;

for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  for (const o of offenders) {
    // a bare specifier import/require of the workspace package == leak
    if (new RegExp(`from\\s+['"]${o}['"]|require\\(['"]${o}['"]\\)`).test(src)) {
      console.error(`LEAK: ${f} still imports ${o}`);
      bad = true;
    }
  }
}

for (const f of dtsFiles) {
  const src = readFileSync(f, 'utf8');
  for (const o of offenders) {
    // bare specifier in declaration file: from 'pkg', require('pkg'), or import('pkg')
    if (new RegExp(`from\\s+['"]${o}['"]|require\\(['"]${o}['"]\\)|import\\(['"]${o}['"]\\)`).test(src)) {
      console.error(`LEAK: ${f} still references ${o}`);
      bad = true;
    }
  }
}

if (bad) process.exit(1);
console.log('bundle is self-contained');
