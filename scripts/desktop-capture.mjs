#!/usr/bin/env node
// Screenshots are captured during a complete isolated real-binary run, including
// on failure. There is no implicit attachment to a prior/global session.
process.argv.push('--suite', 'read-only');
await import('./test-desktop.mjs');
