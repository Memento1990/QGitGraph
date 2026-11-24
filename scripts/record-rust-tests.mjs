#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RUST_INTEGRATION_TARGETS, validateRustEvidence } from './lib/release.mjs';
import { PROJECT, inside, isMain, parseArgs, samePath, sha256 } from './lib/run.mjs';

export function rustTestArgs(kind) {
  assert(['rust-unit', 'rust-integration'].includes(kind), 'Unknown Rust test suite.');
  return ['test', '--offline', '--locked', '--color', 'never', '--manifest-path', 'src-tauri/Cargo.toml',
    ...(kind === 'rust-unit' ? ['--lib'] : RUST_INTEGRATION_TARGETS.flatMap(target => ['--test', target])),
    '--features', 'host-tests', '--', '--nocapture'];
}
export function assertRustOutput(root, output) {
  root = resolve(root); output = resolve(output);
  assert(!samePath(root, output) && !inside(output, root), 'Rust output must be separate from source inputs.');
  if (inside(root, output)) assert(inside(join(root, 'artifacts'), output), 'Rust logs inside the project must use a fresh private artifacts directory.');
  return output;
}
export async function recordRustTests(output, { root = PROJECT, spawnCargo = spawn, stdout = process.stdout, stderr = process.stderr } = {}) {
  assert(typeof output === 'string' && output, 'A new private output directory is required.');
  root = resolve(root); output = assertRustOutput(root, output);
  await mkdir(output, { recursive: false }); // Old evidence is never reused or overwritten.
  const reports = [];
  for (const kind of ['rust-unit', 'rust-integration']) {
    const args = rustTestArgs(kind); const startedAt = new Date().toISOString(); const chunks = [];
    const child = spawnCargo('cargo', args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { chunks.push(Buffer.from(bytes)); stdout.write(bytes); });
    child.stderr.on('data', bytes => { chunks.push(Buffer.from(bytes)); stderr.write(bytes); });
    // close, not exit: both pipes must be drained before the log is hashed.
    const code = await new Promise((done, fail) => { child.on('error', fail); child.on('close', done); });
    const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8');
    await writeFile(join(output, `${kind}.log`), bytes, { flag: 'wx' });
    const report = { schemaVersion: 1, kind, status: 'failed', startedAt, finishedAt: new Date().toISOString(), counts: { passed: 0 },
      command: { program: 'cargo', args, exitCode: code }, log: { path: `${kind}.log`, sha256: sha256(bytes) } };
    let failure;
    try { report.counts.passed = validateRustEvidence(report, text); assert(report.counts.passed > 0, 'No actual Rust assertions executed.'); report.status = 'passed'; }
    catch (error) { failure = error; report.error = { name: error.name, message: 'Rust execution or required-target coverage failed; inspect the private command log.' }; }
    await writeFile(join(output, `${kind}.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
    if (failure) throw failure;
    reports.push(report);
  }
  return reports;
}
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help') console.log('node scripts/record-rust-tests.mjs <new-private-output-directory> [--root <project>]\nRuns fresh offline locked Rust library and all required integration targets, including working_actions and untrusted_filters. Refuses reused output and incomplete/legacy target logs.');
  else {
    const output = argv.shift(); const options = parseArgs(argv, { values: ['root'] });
    await recordRustTests(output, { root: options.root });
  }
}
