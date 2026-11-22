#!/usr/bin/env node
import { join } from 'node:path';
import { createRun, errorInfo, gitExecutable, json, parseArgs, required } from './lib/run.mjs';
import { createFixtures } from './lib/fixtures.mjs';
const options = parseArgs(process.argv.slice(2), { values: ['output', 'git'], flags: ['help'] });
if (options.help) { console.log('node scripts/create-fixture.mjs --output <new-empty-run> [--git <exe>]\nOffline local fixtures with isolated Git HOME/config. Do not reuse this run for test-desktop; the unified runner makes its own fixtures.'); process.exit(0); }
required(options, ['output']);
const run = await createRun(options.output, 'fixture-only');
try {
  run.gitBinary = gitExecutable(options.git);
  run.manifest.git.executable = run.gitBinary;
  const fixture = await createFixtures(run);
  run.manifest.status = 'passed';
  console.log(JSON.stringify({ output: run.output, fixtureManifest: join(run.output, 'fixture-manifest.json'), repository: fixture.repository, head: fixture.head }, null, 2));
} catch (error) { run.manifest.status = 'failed'; run.manifest.error = errorInfo(error); process.exitCode = 1; }
finally { run.manifest.finishedAt = new Date().toISOString(); await run.save(); await json(join(run.output, 'test-report.json'), { kind: 'fixture-only', status: run.manifest.status, error: run.manifest.error, scope: 'Fixture creation only, not desktop UI coverage.' }); }
