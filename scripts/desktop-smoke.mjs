#!/usr/bin/env node
// Compatibility entry point. Every invocation owns a complete fresh run.
// Pass the same --binary, --driver and --output arguments as test-desktop.mjs.
process.argv.push('--suite', 'read-only');
await import('./test-desktop.mjs');
