#!/usr/bin/env node
// Local file selection is confined to the CLI. The board server only receives bounded JSONL content.
import { runCli } from '../tools/taskboard/cli.mjs';

const args = process.argv.slice(2);
const preview = args.includes('--preview');
if (args.filter((arg) => arg === '--preview').length > 1) {
  console.error('native-usage: --preview may be supplied once'); process.exitCode = 2;
} else {
  try { await runCli([preview ? 'usage-import-preview' : 'usage-import', ...args.filter((arg) => arg !== '--preview')]); }
  catch (error) { console.error(`native-usage: ${error.message}`); process.exitCode = error.status === 409 ? 3 : 2; }
}
