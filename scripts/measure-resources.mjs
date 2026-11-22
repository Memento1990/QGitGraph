#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PROJECT, assertSameSnapshot, createRun, errorInfo, fingerprint, gitExecutable, json, parseArgs, powershell, required, signInfo, until } from './lib/run.mjs';
import { createFixtures, repositorySnapshot } from './lib/fixtures.mjs';
import { archiveDesktop, BlockedError, OwnedProcesses, startDesktop } from './lib/desktop.mjs';
import { openFixture } from './lib/desktop-suites.mjs';
import { percentile, sizeComparison } from './lib/metrics.mjs';

const options = parseArgs(process.argv.slice(2), { values: ['binary', 'output', 'driver', 'tauri-driver', 'git', 'seconds', 'interactive-samples', 'installer', 'reference-exe-bytes', 'reference-installer-bytes'], flags: ['help'] });
if (options.help) { console.log('node scripts/measure-resources.mjs --binary <app.exe> --output <new-run> [--driver <verified-driver>] [--seconds 60] [--interactive-samples 5] [--installer <setup.exe>]\nWith --driver records actual DOM-ready and refresh p50/p95. Without it records OS window appearance only, never claims interactivity. Measures >=60s idle on a fixed fresh fixture; PID plus creation-time ownership only.'); process.exit(0); }
required(options, ['binary', 'output']);
const seconds = Number(options.seconds ?? 60);
const sampleCount = Number(options['interactive-samples'] ?? 5);
assert(Number.isInteger(seconds) && seconds >= 60 && seconds <= 3600, 'Idle duration must be 60..3600 seconds.');
assert(Number.isInteger(sampleCount) && sampleCount >= 0 && sampleCount <= 50, 'Interactive sample count must be 0..50 (zero disables latency samples).');
const run = await createRun(options.output, 'resources');
const owned = new OwnedProcesses(run);
const helper = join(PROJECT, 'scripts/lib/windows-processes.ps1');
const samples = [];
const interactive = [];
const problems = [];
let fixtures; let wd; let failure;
const began = performance.now();
try {
  if (process.platform !== 'win32') throw new BlockedError('Resource measurement requires a real Windows application, not a simulated process.');
  if (!options.driver) throw new BlockedError('A verified --driver is required to confirm diagnostics.configDirectory and the fixed fixture path/HEAD. Use --interactive-samples 0 to omit optional latency measurements. No unverified-profile process is launched.');
  run.gitBinary = gitExecutable(options.git);
  fixtures = await createFixtures(run);
  run.manifest.binary = await fingerprint(options.binary);
  run.manifest.signature = await signInfo(options.binary);
  const readyClock = performance.now();
  wd = await startDesktop(run, options, owned);
  await openFixture(run, wd, fixtures);
  run.manifest.startup = { milliseconds: performance.now() - readyClock, definition: 'Verified run profile, actual DOM idle and fixture repository path+HEAD rendered; one warm startup sample, includes WebDriver/session overhead.' };
  for (let i = 0; i < sampleCount; i++) {
    const state = await wd.idle('ready for interactive refresh');
    const clock = performance.now();
    await wd.click('button[data-action="refresh"]');
    const complete = await wd.idle('actual refresh task and DOM complete', state.taskSequence);
    assert.equal(complete.repoHead, fixtures.head);
    interactive.push(performance.now() - clock);
  }
  run.manifest.interactive = sampleCount ? { status: 'measured', definition: 'WebDriver click refresh to observed task-sequence advancement and idle DOM; driver round-trip included.', samplesMs: interactive, p50Ms: percentile(interactive, 0.5), p95Ms: percentile(interactive, 0.95) } : { status: 'not-requested', definition: 'Latency samples omitted explicitly; startup/profile/repository identity still verified through actual DOM.' };
  const idleBegan = performance.now();
  // No actions are performed during this wall-clock interval. Each sample is tied
  // to PID plus exact creation time; driver/instrumentation is reported separately.
  while ((performance.now() - idleBegan) / 1000 < seconds) {
    await owned.snapshot();
    const sample = JSON.parse(powershell(helper, ['-Action', 'Metrics', '-InputFile', owned.file]));
    const app = sample.processes.find(item => item.executable && item.executable.toLowerCase() === run.manifest.binary.path.toLowerCase());
    assert(app, 'Measured application is no longer running.');
    const appIds = new Set([app.pid]);
    for (let pass = 0; pass < sample.processes.length; pass++) for (const process of sample.processes) if (appIds.has(process.parentPid)) appIds.add(process.pid);
    const observedDescendants = sample.processes.filter(process => appIds.has(process.pid));
    const systemBrokers = observedDescendants.filter(process => process.executable && /[\\/](?:SogouInput|Microsoft Shared[\\/]ink)[\\/]|[\\/](?:ctfmon|TextInputHost|TabTip|conhost)\.exe$/i.test(process.executable));
    const brokerIds = new Set(systemBrokers.map(process=>process.pid));
    const appProcesses = observedDescendants.filter(process => !brokerIds.has(process.pid));
    const instrumentation = sample.processes.filter(process => !appIds.has(process.pid));
    samples.push({ elapsedSeconds: (performance.now() - idleBegan) / 1000, at: sample.at, logicalProcessors: sample.logicalProcessors, processes: appProcesses, instrumentation, systemBrokers,
      workingSetBytes: appProcesses.reduce((n, process) => n + process.workingSetBytes, 0), privateBytes: appProcesses.reduce((n, process) => n + process.privateBytes, 0), cpuSeconds: appProcesses.reduce((n, process) => n + process.cpuSeconds, 0) });
    await json(join(run.output, 'resource-samples.json'), samples);
    // This is a measurement cadence, never an application-readiness wait.
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, seconds * 1000 - (performance.now() - idleBegan)))));
  }
  const measuredSeconds = (performance.now() - idleBegan) / 1000;
  assert(measuredSeconds >= seconds, 'Idle interval shorter than requested.');
  const installer = options.installer ? await fingerprint(options.installer) : undefined;
  run.manifest.size = sizeComparison({ executableBytes: run.manifest.binary.bytes, installerBytes: installer?.bytes, referenceExecutableBytes: options['reference-exe-bytes'] ? Number(options['reference-exe-bytes']) : undefined, referenceInstallerBytes: options['reference-installer-bytes'] ? Number(options['reference-installer-bytes']) : undefined });
  run.manifest.installer = installer;
  // Aggregate CPU deltas by process identity, including children that exit during
  // the interval; a restarted process cannot steal an older PID's CPU history.
  let cpuDelta = 0;
  const firstCpu = new Map(); const lastCpu = new Map();
  for (const sample of samples) for (const process of sample.processes) { const key = `${process.pid}:${process.creationTime}`; if (!firstCpu.has(key)) firstCpu.set(key, process.cpuSeconds); lastCpu.set(key, process.cpuSeconds); }
  for (const [key, value] of lastCpu) cpuDelta += Math.max(0, value - firstCpu.get(key));
  const cpuWindowSeconds = samples.at(-1)?.elapsedSeconds - samples[0]?.elapsedSeconds;
  assert(Number.isFinite(cpuWindowSeconds) && cpuWindowSeconds > 0, 'At least two timed process snapshots are required for a CPU delta.');
  run.manifest.measurement = { idleSeconds: measuredSeconds, sampleCount: samples.length, workingSetP50Bytes: percentile(samples.map(s => s.workingSetBytes), 0.5), workingSetP95Bytes: percentile(samples.map(s => s.workingSetBytes), 0.95), privateP50Bytes: percentile(samples.map(s => s.privateBytes), 0.5), cpuSecondsDelta: cpuDelta, cpuWindowSeconds, meanOneCoreCpuPercent: cpuDelta / cpuWindowSeconds * 100, notes: ['App + observed WebView2/Git descendants only; instrumentation and system brokers separately listed.', 'Working-set sum may double-count shared pages.', 'CPU deltas cover first-to-last observed snapshots only, not the full idle interval; counters before the first snapshot or after a process last appears are not counted.', 'This is one warm run on the current machine, not a cold boot/clean VM benchmark.'] };
  run.manifest.results.push({ label: 'at least 60 seconds idle measured on fixed fresh fixture', status: 'passed', observedSeconds: measuredSeconds });
  run.manifest.status = 'passed';
} catch (error) { failure = error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = errorInfo(error); }
finally {
  wd ??= run.webDriver;
  if (wd) { try { await archiveDesktop(run, wd, failure ? 'resource-failure' : 'resource-final'); } catch (error) { problems.push(errorInfo(error)); } }
  else { run.manifest.evidence.push({ screenshot: null, status: 'blocked', reason: 'No WebDriver/native window screenshot capability selected; no fabricated image.' }); }
  if (fixtures) {
    try { const after = {}; for (const [name, repo] of Object.entries(fixtures.repositories)) { after[name] = await repositorySnapshot(run, repo); assertSameSnapshot(fixtures.snapshots[name], after[name], name); } await json(join(run.output, 'repository-after.json'), after); run.manifest.repositoryIntegrity = { status: 'passed' }; }
    catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.repositoryIntegrity = { status: 'failed', ...errorInfo(error) }; }
  }
  try { await owned.snapshot(); if (wd?.sessionId) { await wd.call('DELETE', wd.prefix, undefined, 30000); run.manifest.session.closedAt = new Date().toISOString(); } }
  catch (error) { problems.push(errorInfo(error)); }
  try { run.manifest.cleanup = await owned.cleanup(); assert.equal(run.manifest.cleanup.remaining?.length ?? 0, 0); assert.equal(run.manifest.cleanup.errors?.length ?? 0, 0); assert.equal(problems.length, 0); }
  catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.cleanup ??= {}; run.manifest.cleanup.error = errorInfo(error); }
  run.manifest.cleanup.problems = problems;
  run.manifest.finishedAt = new Date().toISOString(); run.manifest.totalElapsedMs = performance.now() - began;
  await run.save(); await json(join(run.output, 'test-report.json'), run.manifest);
}
console.log(JSON.stringify({ status: run.manifest.status, report: join(run.output, 'test-report.json'), error: failure?.message }, null, 2));
process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
