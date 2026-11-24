#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { PROJECT, createRun, errorInfo, isMain, json, parseArgs, readJson, required, until } from './lib/run.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';

export const EXPECTED_VERSION = (await readJson(join(PROJECT, 'package.json'))).version;
const expectedGitHubRepo = 'Memento1990/QGitGraph';
const IDLE_TEXT = 'Updates are checked only when you choose Check for updates.';
// Exact English errorText output for known native prerequisite failures. Machine-code
// summaries precede the original diagnostic; UPDATE_HTTP has no catalog summary.
const NETWORK_ERRORS = new Set([
  ['The update check timed out.', 'The update check timed out. Try again later.'],
  ['GitHub requires authentication for this update request.', 'GitHub or your proxy requires authentication. This check does not send credentials.'],
  ['GitHub has rate-limited update checks. Try again later.', 'GitHub has temporarily limited update checks. Try again later.'],
  ['The update service could not be reached securely.', 'A secure connection to GitHub could not be verified.'],
  ['The update service could not be reached.', 'Could not reach GitHub. Check your network connection and try again.'],
  ['', 'GitHub returned an unexpected response. Try again later.'],
].map(([summary, message]) => `Could not check for updates: ${summary ? `${summary}\n` : ''}${message} Retry using Check for updates.`));
const SCOPE = 'Real supplied Windows binary, public production update service, one explicit WebDriver check-button click, and no repository. The fresh run-owned profile pins English labels. Idle observations cover unsolicited UI checks only: neither OS-wide network traffic nor HTTP/service-call counts are audited. The transient checking state is asserted only if observed; pending/duplicate-call behavior is covered separately by unit tests. Current means installed is at least as recent as the explicitly expected published stable; it does not claim the installed version is published. Current-result UI exposes the latest version, not its release tag or URL. No available-update simulation, external browser launch, download, installation, mock, or privileged IPC call is performed. Raw evidence is local-only and contains isolated profile paths.';

function versionParts(value, label, stable = false) {
  assert.equal(typeof value, 'string', `${label} must be a canonical SemVer string.`);
  assert(value.length <= 128, `${label} is too long.`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  assert(match && match[0] === value, `${label} must be canonical SemVer without a v prefix or whitespace.`);
  const core = match.slice(1, 4).map(Number), pre = match[4]?.split('.') ?? [];
  assert(core.every(Number.isSafeInteger), `${label} must have finite, safe integer version components.`);
  assert(!pre.some(part => /^0\d+$/.test(part)), `${label} has a noncanonical numeric prerelease identifier.`);
  assert(!stable || pre.length === 0, `${label} must be a stable release, not a prerelease.`);
  return { core, pre };
}

// SemVer precedence ignores build metadata. Numeric prerelease identifiers are
// compared exactly, without converting arbitrarily long identifiers to Number.
function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i], b = right.pre[i];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return Math.sign(left.pre.length - right.pre.length);
}

function assertExpectation(expected, currentVersion, latestVersion) {
  assert(['no-release', 'current'].includes(expected), 'Expectation must be no-release or current.');
  const current = versionParts(currentVersion, 'Expected installed version');
  if (expected === 'current') {
    assert(latestVersion !== undefined, 'current requires an explicit latestVersion (--latest-version) for the published stable release.');
    const latest = versionParts(latestVersion, 'Expected latest published version', true);
    assert(compareVersions(latest, current) <= 0, 'A current result cannot have a latest stable version newer than the installed version.');
  } else assert.equal(latestVersion, undefined, 'no-release must not specify a latest published version.');
}

export function parseUpdateArgs(argv) {
  const options = parseArgs(argv, { values: ['binary', 'driver', 'output', 'tauri-driver', 'expect', 'latest-version'], flags: ['help'] });
  if (options.help) return options;
  required(options, ['binary', 'driver', 'output']);
  options.expect ??= 'no-release';
  assertExpectation(options.expect, EXPECTED_VERSION, options['latest-version']);
  return options;
}

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

function assertUpdateView(view, expectedVersion) {
  versionParts(expectedVersion, 'Expected installed version');
  for (const key of ['dialogs', 'sections', 'statusElements', 'checkButtons']) assert.equal(view[key], 1, `Expected exactly one ${key}.`);
  assert.equal(view.selectedTab, 'About & privacy');
  assert.equal(view.appVersion, expectedVersion, `About diagnostics must identify the supplied ${expectedVersion} binary.`);
  assert.match(view.platform, /^windows\s/, 'Browser/demo fallback is not desktop evidence.');
  assert.equal(view.installed, `Installed version: ${expectedVersion}`);
  assert.equal(view.checkLabel, 'Check for updates');
  assert.equal(view.repoPath, '', 'No fixture or user repository may be open.');
  assert.equal(view.taskState, 'idle', 'Update checks must not borrow repository busy state.');
}
export function assertIdleUpdate(view, expectedVersion = EXPECTED_VERSION) {
  assertUpdateView(view, expectedVersion);
  assert.equal(view.status, 'idle'); assert.equal(view.statusText, IDLE_TEXT);
  assert.equal(view.checkDisabled, false); assert.equal(view.releaseButtons, 0);
  assert.equal(view.latestVersion, null); assert.equal(view.published, null);
  return view;
}
export function assertTerminalUpdate(view, expected, { currentVersion = EXPECTED_VERSION, latestVersion } = {}) {
  assertExpectation(expected, currentVersion, latestVersion);
  assertUpdateView(view, currentVersion); assert.equal(view.checkDisabled, false, 'Check button must be re-enabled after completion.');
  assert.equal(view.releaseButtons, 0, 'No-release/current must not offer Open release page.');
  if (view.status === 'error' && NETWORK_ERRORS.has(view.statusText)) {
    assert.equal(view.latestVersion, null, 'A network error must not retain latest release metadata.');
    assert.equal(view.published, null, 'A network error must not retain a publication date.');
    throw new BlockedError(`Live GitHub prerequisite blocked: ${view.statusText}`);
  }
  assert.equal(view.status, expected, `Unexpected actual update result: ${view.statusText}`);
  if (expected === 'current') {
    assert.equal(view.latestVersion, latestVersion, 'Published latest stable must exactly match --latest-version, not the installed version.');
    assert.equal(view.statusText, 'Your installed version is at least as recent as the latest stable release.');
    assert.match(view.published, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const timestamp = Date.parse(view.published);
    assert(Number.isFinite(timestamp), 'Published date must be finite.');
    assert.equal(new Date(timestamp).toISOString(), view.published, 'Published date must be canonical ISO UTC.');
  } else {
    assert.equal(view.statusText, 'No publicly published stable release was found. You can check again later.');
    assert.equal(view.latestVersion, null); assert.equal(view.published, null);
  }
  return view;
}

async function main() {
  const options = parseUpdateArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/test-updates-desktop.mjs --binary <app.exe> --driver <verified-msedgedriver.exe> --output <new-empty-run> [--tauri-driver <exe>] [--expect no-release|current] [--latest-version <published-stable-version>]\nThe expected installed version comes from the project root package.json. Default expectation: no-release (no --latest-version). --expect current requires an explicit --latest-version; installed must be at least as recent as that published stable version. This does not claim the installed version is published. Creates an isolated English profile/HOME and opens no repository. Exit 2 = blocked live-network/prerequisite, never pass. No external browser is opened.');
    return;
  }
  const expected = options.expect, currentVersion = EXPECTED_VERSION, latestVersion = options['latest-version'];
  const versionExpectation = { currentVersion, latestVersion };
  const run = await createRun(resolve(options.output), 'updates-desktop');
  const owned = new OwnedProcesses(run); const controller = new AbortController(); const cleanupErrors = [];
  let wd; let monitor; let failure;
  run.manifest.updateCheck = { expectedGitHubRepo, expectedVersion: currentVersion, expectedLatestVersion: latestVersion ?? null, expected, language: 'en', explicitCheckClicks: 0, scope: SCOPE };
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
      await openAbout(); const initial = assertIdleUpdate(await wd.script(READ_UPDATE_DOM), currentVersion); await archive('about-idle');
      return { initial, beforeClick: assertIdleUpdate(await wd.script(READ_UPDATE_DOM), currentVersion), scope: 'Observed default idle UI; no claim of zero native HTTP calls or a complete network audit.' };
    });
    let liveBlock;
    try {
      await step(`actual-manual-check-${expected}`, async () => {
        assertIdleUpdate(await wd.script(READ_UPDATE_DOM), currentVersion);
        await wd.click('[data-action="check-for-updates"]'); run.manifest.updateCheck.explicitCheckClicks++;
        let checkingObserved = false;
        const terminal = await until('actual manual update result', async () => {
          monitor.check(); const view = await wd.script(READ_UPDATE_DOM); assertUpdateView(view, currentVersion);
          if (view.status === 'checking') { checkingObserved = true; assert.equal(view.checkDisabled, true); return false; }
          if (view.status === 'idle') return false;
          assert(['no-release', 'current', 'available', 'unsupported', 'error'].includes(view.status), `Unknown update status: ${view.status}`);
          return view;
        }, { timeout: 60000, signal: controller.signal });
        run.manifest.updateCheck.actual = terminal;
        run.manifest.updateCheck.checking = { status: checkingObserved ? 'observed-disabled' : 'not-observed', scope: 'A fast native response may finish before the first DOM sample; not-observed is not a checking-state pass.' };
        await archive('manual-check-result');
        assert.equal(run.manifest.updateCheck.explicitCheckClicks, 1); return assertTerminalUpdate(terminal, expected, versionExpectation);
      });
    } catch (error) { if (!(error instanceof BlockedError)) throw error; liveBlock = error; }
    await step('close-dialog-and-no-auto-check-on-reopen', async () => {
      await wd.keys(['\uE00C']);
      await wd.wait('Settings closed', 'return document.querySelectorAll(".settings-dialog[open]").length === 0;');
      await openAbout(); const reopened = assertIdleUpdate(await wd.script(READ_UPDATE_DOM), currentVersion); await archive('about-reopened-idle');
      assert.equal(run.manifest.updateCheck.explicitCheckClicks, 1);
      return { reopened, afterEvidence: assertIdleUpdate(await wd.script(READ_UPDATE_DOM), currentVersion), scope: 'New dialog controller remains idle without another explicit check; HTTP/service-call counts are not audited.' };
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
