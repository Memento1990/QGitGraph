#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createRun, required, parseArgs, gitExecutable, errorInfo, json, assertSameSnapshot } from './lib/run.mjs';
import { createFixtures, repositorySnapshot } from './lib/fixtures.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';
import { actions, recordPlannedCoverage, smoke } from './lib/desktop-suites.mjs';
import { parity } from './desktop-parity-suite.mjs';

const options = parseArgs(process.argv.slice(2), { values: ['binary', 'driver', 'output', 'tauri-driver', 'git', 'suite'], flags: ['help'] });
if (options.help) {
  console.log('node scripts/test-desktop.mjs --binary <app.exe> --driver <verified-msedgedriver.exe> --output <new-empty-run> [--tauri-driver <exe>] [--git <exe>] [--suite baseline|read-only|parity]\nCreates local-only fixtures, a unique profile/HOME/ports/session, archives evidence on failure, and finally closes only run-owned processes. Exit 2 = blocked prerequisite, not pass.');
  process.exit(0);
}
required(options, ['binary', 'driver', 'output']);
if (!['baseline', 'read-only', 'parity'].includes(options.suite ?? 'baseline')) throw new Error('Supported suites: baseline, read-only, parity.');
const run = await createRun(resolve(options.output), 'desktop');
const owned = new OwnedProcesses(run);
let fixtures;
let wd;
let failure;
const cleanupErrors = [];
const controller = new AbortController();
const onSignal = signal => { controller.abort(new Error(`${signal}: interrupted`)); failure ??= new Error(`${signal}: interrupted`); };
const sigint = () => onSignal('SIGINT'); const sigterm = () => onSignal('SIGTERM');
process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
let monitor;
try {
  if (process.platform !== 'win32') throw new BlockedError('Real Windows desktop automation is required; no browser/sample fallback is allowed.');
  run.gitBinary = gitExecutable(options.git);
  run.manifest.git.executable = run.gitBinary;
  await run.save();
  fixtures = await createFixtures(run);
  controller.signal.throwIfAborted();
  monitor = monitorOwnedProcesses(owned);
  wd = await startDesktop(run, options, owned);
  monitor.check();
  controller.signal.throwIfAborted();
  await smoke(run, wd, fixtures);
  monitor.check();
  if (['baseline','parity'].includes(options.suite ?? 'baseline')) await actions(run, wd, fixtures);
  monitor.check();
  if (options.suite === 'parity') await parity(run, wd, fixtures);
  else recordPlannedCoverage(run);
  await archiveDesktop(run, wd, 'history-final');
  run.manifest.status = 'passed';
} catch (error) {
  failure = error;
  run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed';
  run.manifest.error = errorInfo(error);
} finally {
  if (monitor) {
    try { await monitor.stop(); }
    catch (error) {
      failure ??= error; run.manifest.status = 'failed';
      cleanupErrors.push({ phase: 'ownership-monitor', ...errorInfo(error) });
    }
  }
  wd ??= run.webDriver;
  try { await archiveDesktop(run, wd, failure ? 'failure' : 'final'); } catch (error) { cleanupErrors.push({ phase: 'archive', ...errorInfo(error) }); }
  if (fixtures) {
    const after = {};
    try {
      for (const [name, repository] of Object.entries(fixtures.repositories)) after[name] = await repositorySnapshot(run, repository);
      await json(join(run.output, 'repository-after.json'), after);
      for (const name of Object.keys(fixtures.snapshots)) assertSameSnapshot(fixtures.snapshots[name], after[name], name);
      run.manifest.repositoryIntegrity = { status: 'passed', checked: ['identity', 'HEAD', 'HEAD-file', 'index-sha256', 'status-v2-NUL', 'tracked-bytes', 'untracked-bytes', 'refs'], repositories: Object.keys(after) };
    } catch (error) {
      failure ??= error;
      run.manifest.repositoryIntegrity = { status: 'failed', ...errorInfo(error) };
      run.manifest.status = 'failed';
    }
  }
  try { await owned.snapshot(); } catch (error) { cleanupErrors.push({ phase: 'ownership-before-close', ...errorInfo(error) }); }
  if (wd?.sessionId) {
    try { await wd.call('DELETE', wd.prefix, undefined, 30000); run.manifest.session.closedAt = new Date().toISOString(); }
    catch (error) { cleanupErrors.push({ phase: 'webdriver-session-delete', ...errorInfo(error) }); }
  }
  try {
    const cleanup = await owned.cleanup();
    run.manifest.cleanup = { ...cleanup, errors: [...(cleanup.errors ?? []), ...cleanupErrors] };
    assert.equal(cleanup.remaining?.length ?? 0, 0, 'Run-owned processes remain after cleanup.');
    assert.equal(cleanup.errors?.length ?? 0, 0, 'Run-owned process cleanup reported errors.');
    assert.equal(cleanupErrors.length, 0, 'Evidence or graceful cleanup reported errors.');
  } catch (error) {
    failure ??= error; run.manifest.status = 'failed';
    run.manifest.cleanup ??= { errors: cleanupErrors };
    run.manifest.cleanup.failure = errorInfo(error);
  }
  run.manifest.finishedAt = new Date().toISOString();
  if (failure && !run.manifest.error) run.manifest.error = errorInfo(failure);
  await run.save();
  await json(join(run.output, 'test-report.json'), {
    schemaVersion: 1, kind: 'desktop', runId: run.manifest.runId, status: run.manifest.status,
    startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt, binary: run.manifest.binary,
    results: run.manifest.results, repositoryIntegrity: run.manifest.repositoryIntegrity, cleanup: run.manifest.cleanup,
    evidence: run.manifest.evidence, error: run.manifest.error,
    scope: 'Real WebDriver against supplied binary and local-only repositories. Blocked extended features are not counted as passing tests.',
  });
  process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
}
console.log(JSON.stringify({ status: run.manifest.status, output: run.output, report: join(run.output, 'test-report.json'), error: failure?.message }, null, 2));
process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
