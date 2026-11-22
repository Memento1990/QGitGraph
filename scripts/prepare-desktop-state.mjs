#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { inside, json, parseArgs, readJson, required, samePath } from './lib/run.mjs';
const options = required(parseArgs(process.argv.slice(2), { values: ['output'] }), ['output']);
const output = resolve(options.output);
const manifest = await readJson(join(output, 'run-manifest.json'));
assert(samePath(output, manifest.outputDirectory), 'Manifest output identity mismatch.');
assert(inside(output, manifest.profileDirectory), 'Only a run-owned explicit profile may be changed.');
assert.equal(manifest.session, null, 'State preparation is allowed only before any desktop session exists.');
assert.equal(manifest.status, 'running', 'A finished run must never be reused.');
const statePath = join(manifest.profileDirectory, 'state.json');
const state = await readJson(statePath);
state.settings = { ...state.settings, theme: 'dark', detailPosition: 'bottom', diffView: 'unified' };
await json(statePath, state);
console.log(JSON.stringify({ statePath, scope: 'Explicit new run profile only; no APPDATA fallback.' }));
