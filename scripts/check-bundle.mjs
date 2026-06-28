import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const offenders = ['ai-workflow-engine', 'agent-surface-adapters'];
const jsFiles = ['dist/index.js', 'dist/workflows/index.js', 'dist/cli.js'];
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

// Collect all *.d.ts files under dist/ recursively so that bundled type
// chunks (e.g. dist/types-*.d.ts) are also checked, not just entry points.
function collectDts(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectDts(full));
    } else if (entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

const dtsFiles = collectDts('dist');

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
