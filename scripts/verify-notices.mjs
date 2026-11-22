#!/usr/bin/env node
import { json, parseArgs, required } from './lib/run.mjs';
import { verifyNotices } from './lib/release.mjs';
const options = required(parseArgs(process.argv.slice(2), { values: ['directory', 'output'], flags: ['verify-inputs'] }), ['directory']);
const result = await verifyNotices(options.directory, { verifyInputs: !!options['verify-inputs'] });
if (options.output) await json(options.output, result);
console.log(JSON.stringify(result, null, 2));
