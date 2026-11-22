#!/usr/bin/env node
// Shared start/state/stop sessions were removed: they could target another run.
// Use the unified runner; inspect <output>/run-manifest.json and evidence/.
if (!process.argv.slice(2).some(arg => arg.startsWith('--'))) {
  throw new Error('Use node scripts/test-desktop.mjs --binary <exe> --driver <verified-driver> --output <new-empty-run>. Manual shared start/stop is intentionally unsupported.');
}
await import('./test-desktop.mjs');
