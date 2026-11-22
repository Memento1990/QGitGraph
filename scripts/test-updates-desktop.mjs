#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createRun, errorInfo, isMain, json, parseArgs, required, until } from './lib/run.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';

export const EXPECTED_VERSION = '0.2.2';
const expectedGitHubRepo = 'Memento1990/QGitGraph';
const IDLE_TEXT = 'Updates are checked only when you choose Check for updates.';
const NETWORK_ERRORS = new Set([
  'The update check timed out. Try again later.',
  'GitHub or your proxy requires authentication. This check does not send credentials.',
  'GitHub has temporarily limited update checks. Try again later.',
  'A secure connection to GitHub could not be verified.',
  'Could not reach GitHub. Check your network connection and try again.',
  'GitHub returned an unexpected response. Try again later.',
].map(message => `Could not check for updates: ${message} Retry using Check for updates.`));
const SCOPE = 'Real supplied Windows binary, public production update service, one explicit WebDriver check-button click, and no repository. Idle observations cover unsolicited UI checks only: neither OS-wide network traffic nor HTTP/service-call counts are audited. The transient checking state is asserted only if observed; pending/duplicate-call behavior is covered separately by unit tests. Current-result UI exposes the latest version, not its release tag or URL. No available-update simulation, external browser launch, download, installation, mock, or privileged IPC call is performed. Raw evidence is local-only and contains isolated profile paths.';

// Read-only DOM observations; every product action uses actual WebDriver clicks/keys.
export const READ_UPDATE_DOM = `
const dialogs = [...document.querySelectorAll('.settings-dialog[open]')];
const dialog = dialogs[0];
const section = dialog?.querySelector('.update-check');
const pairs = root => Object.fromEntries([...root?.querySelectorAll('dt') ?? []].map(dt => [dt.textContent.trim(), dt.nextElementSibling?.textContent.trim()]));
const about = pairs(dialog?.querySelector('.settings-panel > .about-details'));
const latest = pairs(section);
const status = section?.querySelector('[data-update-status]');
const check = section?.querySelector('[data-action="check-for-updates"]');
const shell = document.querySelector('.app-shell');
return {
  dialogs: dialogs.length, sections: dialog?.querySelectorAll('.update-check').length ?? 0,
  statusElements: section?.querySelectorAll('[data-update-status]').length ?? 0,
  selectedTab: dialog?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
  appVersion: about['App version'] ?? null, platform: about.Platform ?? null,
  installed: section?.querySelector('[data-update-current-version]')?.textContent.trim() ?? null,
  status: status?.dataset.updateStatus ?? null, statusText: status?.textContent.trim() ?? null,
  checkButtons: section?.querySelectorAll('[data-action="check-for-updates"]').length ?? 0,
  checkLabel: check?.textContent.trim() ?? null, checkDisabled: check?.disabled ?? null,
  releaseButtons: dialog?.querySelectorAll('[data-action="open-update-release"]').length ?? 0,
  latestVersion: latest['Latest stable'] ?? null, published: latest.Published ?? null,
  repoPath: shell?.dataset.repoPath ?? null, taskState: shell?.dataset.taskState ?? null
};`;

function assertUpdateView(view) {
  for (const key of ['dialogs', 'sections', 'statusElements', 'checkButtons']) assert.equal(view[key], 1, `Expected exactly one ${key}.`);
  assert.equal(view.selectedTab, 'About & privacy');
  assert.equal(view.appVersion, EXPECTED_VERSION, 'About diagnostics must identify the supplied 0.2.2 binary.');
  assert.match(view.platform, /^windows\s/, 'Browser/demo fallback is not desktop evidence.');
  assert.equal(view.installed, `Installed version: ${EXPECTED_VERSION}`);
  assert.equal(view.checkLabel, 'Check for updates');
  assert.equal(view.repoPath, '', 'No fixture or user repository may be open.');
  assert.equal(view.taskState, 'idle', 'Update checks must not borrow repository busy state.');
}
export function assertIdleUpdate(view) {
  assertUpdateView(view);
  assert.equal(view.status, 'idle'); assert.equal(view.statusText, IDLE_TEXT);
  assert.equal(view.checkDisabled, false); assert.equal(view.releaseButtons, 0);
  assert.equal(view.latestVersion, null); assert.equal(view.published, null);
  return view;
}
export function assertTerminalUpdate(view, expected) {
  assert(['no-release', 'current'].includes(expected), 'Expectation must be no-release or current.');
  assertUpdateView(view); assert.equal(view.checkDisabled, false, 'Check button must be re-enabled after completion.');
  assert.equal(view.releaseButtons, 0, 'No-release/current must not offer Open release page.');
  if (view.status === 'error' && NETWORK_ERRORS.has(view.statusText)) throw new BlockedError(`Live GitHub prerequisite blocked: ${view.statusText}`);
  assert.equal(view.status, expected, `Unexpected actual update result: ${view.statusText}`);
  if (expected === 'current') {
    assert.equal(view.latestVersion, EXPECTED_VERSION, 'Published latest stable must be 0.2.2, not an older release.');
    assert.equal(view.statusText, 'Your installed version is at least as recent as the latest stable release.');
    assert.match(view.published, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } else {
    assert.equal(view.statusText, 'No publicly published stable release was found. You can check again later.');
    assert.equal(view.latestVersion, null); assert.equal(view.published, null);
  }
  return view;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { values: ['binary', 'driver', 'output', 'tauri-driver', 'expect'], flags: ['help'] });
  if (options.help) {
    console.log('node scripts/test-updates-desktop.mjs --binary <0.2.2-app.exe> --driver <verified-msedgedriver.exe> --output <new-empty-run> [--tauri-driver <exe>] [--expect no-release|current]\nDefault expectation: no-release. Use current after publishing v0.2.2, with the same binary and a fresh output. Creates an isolated profile/HOME and opens no repository. Exit 2 = blocked live-network/prerequisite, never pass. No external browser is opened.');
    return;
  }
  required(options, ['binary', 'driver', 'output']);
  const expected = options.expect ?? 'no-release';
  assert(['no-release', 'current'].includes(expected), '--expect must be no-release or current.');
  const run = await createRun(resolve(options.output), 'updates-desktop');
  const owned = new OwnedProcesses(run); const controller = new AbortController(); const cleanupErrors = [];
  let wd; let monitor; let failure;
  run.manifest.updateCheck = { expectedGitHubRepo, expectedVersion: EXPECTED_VERSION, expected, explicitCheckClicks: 0, scope: SCOPE };
  const interrupt = signal => controller.abort(new Error(`${signal}: interrupted`));
  const sigint = () => interrupt('SIGINT'); const sigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  async function step(label, work) {
    const result = { label, status: 'running', startedAt: new Date().toISOString() }; run.manifest.results.push(result); await run.save();
    try { controller.signal.throwIfAborted(); monitor?.check(); result.observed = await work(); controller.signal.throwIfAborted(); monitor?.check(); result.status = 'passed'; }
    catch (error) { result.status = error instanceof BlockedError ? 'blocked' : 'failed'; result.error = errorInfo(error); throw error; }
    finally { result.finishedAt = new Date().toISOString(); await run.save(); }
  }
  async function archive(name) { const evidence = await archiveDesktop(run, wd, name); assert.equal(evidence.errors.length, 0, `Incomplete ${name} evidence: ${JSON.stringify(evidence.errors)}`); }
  async function openAbout() {
    await wd.click('button[data-action="settings"]');
    await wd.wait('Settings dialog', 'return document.querySelectorAll(".settings-dialog[open]").length === 1;');
    await wd.clickText('.settings-tabs [role="tab"]', 'About & privacy');
    await wd.wait('About update controls', 'return document.querySelectorAll(".settings-dialog[open] .update-check [data-update-status]").length === 1;');
  }
  try {
    if (process.platform !== 'win32') throw new BlockedError('A real Windows desktop and verified Tauri/Edge WebDriver are required. No browser/sample fallback is permitted.');
    wd = await startDesktop(run, options, owned); monitor = monitorOwnedProcesses(owned);
    assert.equal((await wd.state()).repoPath, '', 'Fresh startup must not open any repository.');
    await step('source-ui-default-idle', async () => {
      await openAbout(); const initial = assertIdleUpdate(await wd.script(READ_UPDATE_DOM)); await archive('about-idle');
      return { initial, beforeClick: assertIdleUpdate(await wd.script(READ_UPDATE_DOM)), scope: 'Observed default idle UI; no claim of zero native HTTP calls or a complete network audit.' };
    });
    let liveBlock;
    try {
      await step(`actual-manual-check-${expected}`, async () => {
        assertIdleUpdate(await wd.script(READ_UPDATE_DOM));
        await wd.click('[data-action="check-for-updates"]'); run.manifest.updateCheck.explicitCheckClicks++;
        let checkingObserved = false;
        const terminal = await until('actual manual update result', async () => {
          monitor.check(); const view = await wd.script(READ_UPDATE_DOM); assertUpdateView(view);
          if (view.status === 'checking') { checkingObserved = true; assert.equal(view.checkDisabled, true); return false; }
          if (view.status === 'idle') return false;
          assert(['no-release', 'current', 'available', 'unsupported', 'error'].includes(view.status), `Unknown update status: ${view.status}`);
          return view;
        }, { timeout: 60000, signal: controller.signal });
        run.manifest.updateCheck.actual = terminal;
        run.manifest.updateCheck.checking = { status: checkingObserved ? 'observed-disabled' : 'not-observed', scope: 'A fast native response may finish before the first DOM sample; not-observed is not a checking-state pass.' };
        await archive('manual-check-result');
        assert.equal(run.manifest.updateCheck.explicitCheckClicks, 1); return assertTerminalUpdate(terminal, expected);
      });
    } catch (error) { if (!(error instanceof BlockedError)) throw error; liveBlock = error; }
    await step('close-dialog-and-no-auto-check-on-reopen', async () => {
      await wd.keys(['\uE00C']);
      await wd.wait('Settings closed', 'return document.querySelectorAll(".settings-dialog[open]").length === 0;');
      await openAbout(); const reopened = assertIdleUpdate(await wd.script(READ_UPDATE_DOM)); await archive('about-reopened-idle');
      assert.equal(run.manifest.updateCheck.explicitCheckClicks, 1);
      return { reopened, afterEvidence: assertIdleUpdate(await wd.script(READ_UPDATE_DOM)), scope: 'New dialog controller remains idle without another explicit check; HTTP/service-call counts are not audited.' };
    });
    if (liveBlock) throw liveBlock;
    run.manifest.status = 'passed';
  } catch (error) { failure = error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = errorInfo(error); }
  finally {
    if (monitor) try { await monitor.stop(); } catch (error) { cleanupErrors.push({ phase: 'ownership-monitor', ...errorInfo(error) }); }
    wd ??= run.webDriver;
    if (wd?.sessionId) try { await archive(failure ? 'failure' : 'final'); } catch (error) { cleanupErrors.push({ phase: 'archive', ...errorInfo(error) }); }
    if (owned.roots.length) try { await owned.snapshot(); } catch (error) { cleanupErrors.push({ phase: 'ownership-before-close', ...errorInfo(error) }); }
    if (wd?.sessionId) try { await wd.call('DELETE', wd.prefix, undefined, 30000); run.manifest.session.closedAt = new Date().toISOString(); } catch (error) { cleanupErrors.push({ phase: 'webdriver-session-delete', ...errorInfo(error) }); }
    try {
      const cleanup = await owned.cleanup(); run.manifest.cleanup = { ...cleanup, errors: [...(cleanup.errors ?? []), ...cleanupErrors] };
      assert.equal(cleanup.remaining?.length ?? 0, 0, 'Run-owned processes remain.');
      assert.equal(run.manifest.cleanup.errors.length, 0, 'Evidence or owned-process cleanup reported errors.');
    } catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.cleanup ??= { errors: cleanupErrors }; run.manifest.cleanup.failure = errorInfo(error); }
    if (controller.signal.aborted) { failure ??= controller.signal.reason; run.manifest.status = 'failed'; }
    run.manifest.finishedAt = new Date().toISOString(); if (failure && !run.manifest.error) run.manifest.error = errorInfo(failure);
    await run.save();
    await json(join(run.output, 'test-report.json'), {
      schemaVersion: 1, kind: 'updates-desktop', runId: run.manifest.runId, status: run.manifest.status,
      startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt, binary: run.manifest.binary ?? null,
      updateCheck: run.manifest.updateCheck, results: run.manifest.results, cleanup: run.manifest.cleanup,
      evidence: run.manifest.evidence, error: run.manifest.error, scope: SCOPE,
    });
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  }
  console.log(JSON.stringify({ status: run.manifest.status, output: run.output, report: join(run.output, 'test-report.json'), error: failure?.message }, null, 2));
  process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
}
if (isMain(import.meta.url)) await main();
