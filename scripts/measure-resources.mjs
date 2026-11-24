#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PROJECT, assertSameSnapshot, createRun, errorInfo, fingerprint, gitExecutable, inside, isMain, json, parseArgs, powershell, readJson, required, samePath, signInfo, until } from './lib/run.mjs';
import { createFixtures, repositorySnapshot } from './lib/fixtures.mjs';
import { archiveDesktop, BlockedError, OwnedProcesses, startDesktop } from './lib/desktop.mjs';
import { openFixture } from './lib/desktop-suites.mjs';
import { percentile, sizeComparison } from './lib/metrics.mjs';

export const VUE_RESOURCE_SELECTORS = Object.freeze({
  open: '.native-titlebar .breadcrumb',
  form: '[role="dialog"] .open-form',
  mode: '[role="dialog"] .open-form select',
  repositoryOption: '[role="dialog"] .open-form select > option[value="repository"]',
  path: '[role="dialog"] .open-form .path-input input',
  submit: '[role="dialog"] .open-form button[type="submit"]',
  refresh: '.repository-commandbar button[aria-label="Refresh current repository"]',
});
// Observation only. Repository/mode/path inputs and refresh use real WebDriver
// element clicks, keys and values, never renderer mutation or business IPC.
export const READ_RESOURCE_VUE_DOM = `
const visible=e=>!!e&&!e.hidden&&e.getClientRects().length>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
const shells=document.querySelectorAll('.app-shell'),e=shells[0],form=[...document.querySelectorAll('[role="dialog"] .open-form')].find(visible),trust=document.querySelector('.repository-commandbar .trust-chip'),refresh=document.querySelector('.repository-commandbar button[aria-label="Refresh current repository"]'),history=document.querySelector('.hp-list');
return e?{rootCount:shells.length,repoPath:e.dataset.repoPath,repoHead:e.dataset.repoHead,taskState:e.dataset.taskState,taskSequence:e.dataset.taskSequence,configDirectory:e.dataset.configDirectory,hostMode:e.dataset.hostMode,actionBusy:e.dataset.actionBusy,locale:document.documentElement.lang,
 errors:[...document.querySelectorAll('.notice-strip.error[role=alert],.ch-error[role=alert],.hp-error[role=alert],.ci-state[role=alert],.dp-state[role=alert],[role=dialog] [role=alert]')].filter(visible).map(e=>e.textContent.trim()),
 dialogCount:[...document.querySelectorAll('[role="dialog"]')].filter(visible).length,openForm:!!form,openMode:form?.querySelector('select')?.value??null,openPath:form?.querySelector('.path-input input')?.value??null,
 trustVisible:visible(trust),trusted:trust?trust.classList.contains('trusted'):null,commitDisabled:document.querySelector('.repository-commandbar > button.primary')?.disabled??null,refreshReady:visible(refresh)&&refresh.disabled===false,
 historyReady:visible(history)&&history.getAttribute('aria-busy')==='false',headRendered:!!e.dataset.repoHead&&!!history?.querySelector('[id="history-row-'+e.dataset.repoHead+'"]')}:null;`;

export function parseResourceOptions(argv) {
  const options = parseArgs(argv, { values: ['binary', 'output', 'driver', 'tauri-driver', 'git', 'frontend', 'seconds', 'interactive-samples', 'installer', 'reference-exe-bytes', 'reference-installer-bytes'], flags: ['help'] });
  if (options.help) return options;
  required(options, ['binary', 'output']);
  options.frontend ??= 'legacy';
  assert(['vue', 'legacy'].includes(options.frontend), '--frontend must be vue or legacy.');
  const seconds = Number(options.seconds ?? 60), sampleCount = Number(options['interactive-samples'] ?? 5);
  assert(Number.isInteger(seconds) && seconds >= 60 && seconds <= 3600, 'Idle duration must be 60..3600 seconds.');
  assert(Number.isInteger(sampleCount) && sampleCount >= 0 && sampleCount <= 50, 'Interactive sample count must be 0..50 (zero disables latency samples only).');
  if (options.frontend === 'vue' && (samePath(PROJECT, options.output) || inside(PROJECT, options.output))) assert(inside(join(PROJECT, 'artifacts'), resolve(options.output)), 'Vue raw resource evidence/profile must stay in an ignored artifacts subdirectory or outside the project.');
  return options;
}

export function assertResourceVueState(state, profile, previousSequence, expected) {
  assert(state && state.rootCount === 1, 'Exactly one actual Vue .app-shell is required.');
  assert.equal(state.hostMode, 'desktop', 'Resource evidence must use actual desktop mode, never demo/browser.');
  assert(state.configDirectory && samePath(state.configDirectory, profile), 'Resource application profile must exactly match the run-owned profile.');
  assert.equal(state.locale, 'en', 'The isolated resource profile must retain English control labels.');
  assert(['idle', 'running', 'created', 'loading'].includes(state.taskState), 'Missing/unknown Vue task-state.');
  assert(/^\d+$/.test(state.taskSequence ?? ''), 'Vue task-sequence must be a nonnegative integer.');
  const sequence = Number(state.taskSequence);
  assert(Number.isSafeInteger(sequence), 'Vue task-sequence must be a safe integer.');
  if (previousSequence !== undefined) assert(sequence >= previousSequence, 'Vue task-sequence regressed.');
  assert.deepEqual(state.errors, [], 'Actual resource UI errors.');
  assert.equal(state.actionBusy, 'false', 'No business write may run during resource observation.');
  if (state.repoPath) {
    assert(expected && samePath(state.repoPath, expected.identity.path), 'Vue resource UI opened a different fixture path.');
    assert.equal(state.repoHead, expected.head, 'Vue resource HEAD must exactly match independent Git facts.');
    assert.equal(state.trustVisible, true, 'Actual read-only trust indicator must be visible.');
    assert.equal(state.trusted, false, 'Resource fixture must remain untrusted/read-only.');
    assert.equal(state.commitDisabled, true, 'Read-only repository commit control must remain disabled.');
  }
  return sequence;
}

export function createResourceFrontend(run, wd, fixtures, frontend = 'legacy', waitOptions = {}) {
  assert(['vue', 'legacy'].includes(frontend), '--frontend must be vue or legacy.');
  if (frontend === 'legacy') return {
    refreshSelector: 'button[data-action="refresh"]',
    open: () => openFixture(run, wd, fixtures),
    idle: (label, afterSequence) => wd.idle(label, afterSequence),
  };
  const repository = fixtures.repositories.base, expected = fixtures.snapshots.base;
  // Never accept a caller-supplied real repository or redirect out of this run.
  assert(inside(join(run.output, 'fixtures'), repository) && samePath(repository, expected.identity.path), 'Vue resources accept only the exact new run-owned base fixture.');
  assert(inside(join(run.output, 'fixtures'), expected.identity.gitDir) && !expected.identity.bare, 'Vue resource Git identity escaped the controlled fixture.');
  assert.equal(fixtures.head, expected.head);
  assert(/^[a-f0-9]{40,64}$/.test(expected.head), 'An actual full fixture HEAD is required.');
  let previous;
  async function observe() {
    const state = await wd.script(READ_RESOURCE_VUE_DOM);
    previous = assertResourceVueState(state, run.profileDirectory, previous, expected);
    return state;
  }
  const wait = (label, predicate) => until(label, async () => { const state = await observe(); return predicate(state) ? state : false; }, { timeout: 60_000, interval: 125, ...waitOptions });
  const ready = state => state.taskState === 'idle' && state.dialogCount === 0 && samePath(state.repoPath, expected.identity.path) && state.repoHead === expected.head && state.historyReady && state.headRendered && state.refreshReady;
  return {
    refreshSelector: VUE_RESOURCE_SELECTORS.refresh,
    idle: (label, afterSequence) => wait(label, state => ready(state) && (afterSequence === undefined || Number(state.taskSequence) > Number(afterSequence))),
    async open() {
      const boot = await wait('actual native Vue bootstrap and isolated profile', state => state.taskState === 'idle');
      assert.equal(boot.repoPath, '', 'A fresh resource profile must not reopen another repository.');
      assert.equal(boot.repoHead, ''); assert.equal(boot.dialogCount, 0);
      await wd.click(VUE_RESOURCE_SELECTORS.open);
      await wait('actual RepositoryOpenDialog', state => state.openForm && state.dialogCount === 1);
      // The default is directory discovery. Explicitly choose the real single
      // repository option before typing the absolute fixture path.
      await wd.click(VUE_RESOURCE_SELECTORS.mode);
      await wd.click(VUE_RESOURCE_SELECTORS.repositoryOption);
      await wd.fill(VUE_RESOURCE_SELECTORS.path, expected.identity.path);
      const before = await wait('actual single-repository path input', state => state.openForm && state.openMode === 'repository' && state.openPath === expected.identity.path);
      await wd.click(VUE_RESOURCE_SELECTORS.submit);
      const observed = await wait('actual fixture path and exact HEAD rendered read-only', state => ready(state) && Number(state.taskSequence) > Number(before.taskSequence));
      run.manifest.results.push({ label: 'real repository identity (base)', status: 'passed', source: 'automated-test', frontend: 'vue', observed: { path: observed.repoPath, head: observed.repoHead, configDirectory: observed.configDirectory, hostMode: observed.hostMode, trusted: observed.trusted, taskSequenceBefore: Number(before.taskSequence), taskSequenceAfter: Number(observed.taskSequence) } });
      await run.save();
      return observed;
    },
  };
}

export async function assertResourceReadOnlyProfile(run) {
  const state = await readJson(join(run.profileDirectory, 'state.json'));
  assert.deepEqual(state.trusted, [], 'Resource runner must never persist legacy repository trust.');
  let nativeTrust;
  try { nativeTrust = await readFile(join(run.profileDirectory, 'native-trust.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(nativeTrust, undefined, 'Resource runner must not write native trust rules, even empty ones.');
  return { status: 'passed', trusted: 0, nativeTrustFileWritten: false };
}

export function assertSameResourceBinary(before, after) {
  assert(before && after && samePath(before.path, after.path), 'Resource executable path changed.');
  assert.equal(after.bytes, before.bytes, 'Resource executable byte size changed.');
  assert.equal(after.sha256, before.sha256, 'Resource executable SHA-256 changed.');
}

export function resourceProcessGroups(sample, binary, application) {
  const key = item => `${item.pid}:${item.creationTime}`;
  assert(Array.isArray(sample.processes));
  for (const item of sample.processes) {
    assert(Number.isInteger(item.pid) && item.pid > 0 && typeof item.creationTime === 'string' && Number.isFinite(Date.parse(item.creationTime)), 'Every resource process needs PID plus exact creation time.');
    for (const field of ['workingSetBytes', 'privateBytes', 'cpuSeconds']) assert(Number.isFinite(item[field]) && item[field] >= 0, `Invalid actual process metric: ${field}`);
  }
  assert.equal(new Set(sample.processes.map(item => item.pid)).size, sample.processes.length, 'A resource snapshot must have one identity per PID.');
  const matches = sample.processes.filter(item => item.executable && samePath(item.executable, binary.path));
  assert.equal(matches.length, 1, 'Exactly one run-owned measured application must still be running.');
  const app = matches[0];
  assert.equal(key(app), key(application), 'Measured application PID/creation-time identity changed.');
  const appIds = new Set([app.pid]);
  for (let pass = 0; pass < sample.processes.length; pass++) for (const process of sample.processes) {
    const parent = sample.processes.find(item => item.pid === process.parentPid);
    if (appIds.has(process.parentPid) && parent && Date.parse(process.creationTime) >= Date.parse(parent.creationTime)) appIds.add(process.pid);
  }
  const observedDescendants = sample.processes.filter(process => appIds.has(process.pid));
  const systemBrokers = observedDescendants.filter(process => process.executable && /[\\/](?:SogouInput|Microsoft Shared[\\/]ink)[\\/]|[\\/](?:ctfmon|TextInputHost|TabTip|conhost)\.exe$/i.test(process.executable));
  const brokerIds = new Set(systemBrokers.map(process => process.pid));
  return { appProcesses: observedDescendants.filter(process => !brokerIds.has(process.pid)), instrumentation: sample.processes.filter(process => !appIds.has(process.pid)), systemBrokers };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseResourceOptions(argv);
  if (options.help) {
    console.log('node scripts/measure-resources.mjs --binary <supplied-app.exe> --output <new-run> [--frontend vue|legacy] --driver <already-verified-driver> [--tauri-driver <existing-driver>] [--seconds 60] [--interactive-samples 5] [--installer <setup.exe>]\nDefault frontend is legacy. Vue uses the actual RepositoryOpenDialog and English aria/data selectors, exact fixture HEAD, explicit isolated profile and desktop mode, read-only without trust or network actions. A verified driver is mandatory even with --interactive-samples 0; zero omits optional latency samples only, never startup verification. Measures >=60s actual idle CPU/WS/private bytes on a fixed fresh local fixture; app PID plus creation-time identity, instrumentation separated and exact owned cleanup. Same-binary and repository before/after integrity are retained. No download/install/build/board writes; evidence is automated-test, not userusage or an assertion of final-release status.');
    return;
  }
  const seconds = Number(options.seconds ?? 60), sampleCount = Number(options['interactive-samples'] ?? 5);
  const run = await createRun(options.output, 'resources');
  run.manifest.frontend = options.frontend; run.manifest.source = 'automated-test';
  run.manifest.actualMeasurements = { startup: false, interactive: false, idle: false };
  const owned = new OwnedProcesses(run);
  const helper = join(PROJECT, 'scripts/lib/windows-processes.ps1');
  const samples = [];
  const interactive = [];
  const problems = [];
  let fixtures; let wd; let failure; let binaryBefore; let ui;
  const began = performance.now();
  try {
    if (process.platform !== 'win32') throw new BlockedError('Resource measurement requires a real Windows application, not a simulated process.');
    if (!options.driver) throw new BlockedError('A verified --driver is required to confirm diagnostics.configDirectory and the fixed fixture path/HEAD. Use --interactive-samples 0 to omit optional latency measurements. No unverified-profile process is launched.');
    binaryBefore = await fingerprint(options.binary);
    run.manifest.binary = binaryBefore; await json(join(run.output, 'binary-before.json'), binaryBefore);
    run.gitBinary = gitExecutable(options.git);
    fixtures = await createFixtures(run);
    // Fixture creation is complete. No transport, including file remotes, is
    // needed by the resource run; all subsequent Git/DOM operations are reads.
    run.env.GIT_ALLOW_PROTOCOL = '';
    run.manifest.signature = await signInfo(options.binary);
    if (options.frontend === 'vue') await assertResourceReadOnlyProfile(run);
    const readyClock = performance.now();
    wd = await startDesktop(run, options, owned);
    assertSameResourceBinary(binaryBefore, run.manifest.binary);
    ui = createResourceFrontend(run, wd, fixtures, options.frontend);
    await ui.open();
    run.manifest.startup = { milliseconds: performance.now() - readyClock, definition: 'Verified run profile, actual DOM idle and fixture repository path+HEAD rendered; one warm startup sample, includes WebDriver/session overhead.' };
    run.manifest.actualMeasurements.startup = true;
    if (options.frontend === 'vue') run.manifest.trustIntegrity = await assertResourceReadOnlyProfile(run);
    const applications = (await owned.snapshot()).filter(item => item.executable && samePath(item.executable, binaryBefore.path));
    assert.equal(applications.length, 1, 'Exactly one owned application identity is required before measuring.');
    const application = applications[0];
    run.manifest.applicationIdentity = { pid: application.pid, creationTime: application.creationTime, executable: application.executable };
    for (let i = 0; i < sampleCount; i++) {
      const state = await ui.idle('ready for interactive refresh');
      const clock = performance.now();
      await wd.click(ui.refreshSelector);
      const complete = await ui.idle('actual refresh task and DOM complete', state.taskSequence);
      assert.equal(complete.repoHead, fixtures.head);
      interactive.push(performance.now() - clock);
    }
    run.manifest.interactive = sampleCount ? { status: 'measured', definition: 'WebDriver click refresh to observed task-sequence advancement and idle DOM; driver round-trip included.', samplesMs: interactive, p50Ms: percentile(interactive, 0.5), p95Ms: percentile(interactive, 0.95) } : { status: 'not-requested', definition: 'Latency samples omitted explicitly; startup/profile/repository identity still verified through actual DOM.' };
    run.manifest.actualMeasurements.interactive = sampleCount > 0;
    const idleState = await ui.idle('fixed fixture is genuinely idle before resource sampling');
    const idleBegan = performance.now();
    // No actions are performed during this wall-clock interval. Each sample is tied
    // to PID plus exact creation time; driver/instrumentation is reported separately.
    while ((performance.now() - idleBegan) / 1000 < seconds) {
      await owned.snapshot();
      const sample = JSON.parse(powershell(helper, ['-Action', 'Metrics', '-InputFile', owned.file]));
      const { appProcesses, instrumentation, systemBrokers } = resourceProcessGroups(sample, run.manifest.binary, application);
      samples.push({ elapsedSeconds: (performance.now() - idleBegan) / 1000, at: sample.at, logicalProcessors: sample.logicalProcessors, processes: appProcesses, instrumentation, systemBrokers,
        workingSetBytes: appProcesses.reduce((n, process) => n + process.workingSetBytes, 0), privateBytes: appProcesses.reduce((n, process) => n + process.privateBytes, 0), cpuSeconds: appProcesses.reduce((n, process) => n + process.cpuSeconds, 0) });
      await json(join(run.output, 'resource-samples.json'), samples);
      // This is a measurement cadence, never an application-readiness wait.
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, seconds * 1000 - (performance.now() - idleBegan)))));
    }
    const measuredSeconds = (performance.now() - idleBegan) / 1000;
    assert(measuredSeconds >= seconds, 'Idle interval shorter than requested.');
    if (options.frontend === 'vue') {
      // Observe only after the undisturbed interval. An unseen intervening task
      // cannot be called idle: the sequence must also be unchanged throughout.
      const final = await ui.idle('fixture still read-only and idle after resource sampling');
      assert.equal(final.taskSequence, idleState.taskSequence, 'An intervening Vue task invalidates the undisturbed idle interval.');
      run.manifest.idleIdentity = { configDirectory: final.configDirectory, path: final.repoPath, head: final.repoHead, hostMode: final.hostMode, taskSequenceBefore: Number(idleState.taskSequence), taskSequenceAfter: Number(final.taskSequence) };
    }
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
    run.manifest.measurement = { idleSeconds: measuredSeconds, sampleCount: samples.length, workingSetP50Bytes: percentile(samples.map(s => s.workingSetBytes), 0.5), workingSetP95Bytes: percentile(samples.map(s => s.workingSetBytes), 0.95), privateP50Bytes: percentile(samples.map(s => s.privateBytes), 0.5), cpuSecondsDelta: cpuDelta, cpuWindowSeconds, meanOneCoreCpuPercent: cpuDelta / cpuWindowSeconds * 100, notes: ['App + observed WebView2/Git descendants only; instrumentation and system brokers separately listed.', 'Working-set sum may double-count shared pages.', 'CPU deltas cover first-to-last observed snapshots only, not the full idle interval; counters before the first snapshot or after a process last appears are not counted.', 'This is one warm run on the current machine, not a cold boot/clean VM benchmark.', 'The supplied binary is measured as-is; this report does not identify it as a final release.'] };
    run.manifest.actualMeasurements.idle = true;
    run.manifest.results.push({ label: 'at least 60 seconds idle measured on fixed fresh fixture', status: 'passed', source: 'automated-test', observedSeconds: measuredSeconds });
    run.manifest.status = 'passed';
  } catch (error) { failure = error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = errorInfo(error); }
  finally {
    wd ??= run.webDriver;
    if (wd) { try { await archiveDesktop(run, wd, failure ? 'resource-failure' : 'resource-final'); } catch (error) { problems.push(errorInfo(error)); } }
    else { run.manifest.evidence.push({ screenshot: null, status: 'blocked', reason: 'No WebDriver/native window screenshot capability selected; no fabricated image.' }); }
    try { await owned.snapshot(); if (wd?.sessionId) { await wd.call('DELETE', wd.prefix, undefined, 30000); run.manifest.session.closedAt = new Date().toISOString(); } }
    catch (error) { problems.push(errorInfo(error)); }
    try { run.manifest.cleanup = await owned.cleanup(); assert.equal(run.manifest.cleanup.remaining?.length ?? 0, 0); assert.equal(run.manifest.cleanup.errors?.length ?? 0, 0); assert.equal(problems.length, 0); }
    catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.cleanup ??= {}; run.manifest.cleanup.error = errorInfo(error); }
    // After process teardown, include any shutdown-time changes in integrity.
    if (fixtures) {
      const after = {};
      try { for (const [name, repo] of Object.entries(fixtures.repositories)) after[name] = await repositorySnapshot(run, repo); await json(join(run.output, 'repository-after.json'), after); for (const name of Object.keys(fixtures.repositories)) assertSameSnapshot(fixtures.snapshots[name], after[name], name); run.manifest.repositoryIntegrity = { status: 'passed', repositories: Object.keys(after), acceptedMutations: 0 }; }
      catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.repositoryIntegrity = { status: 'failed', ...errorInfo(error) }; await json(join(run.output, 'repository-after.json'), after); }
      if (options.frontend === 'vue') {
        try { run.manifest.trustIntegrity = await assertResourceReadOnlyProfile(run); }
        catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.trustIntegrity = { status: 'failed', ...errorInfo(error) }; }
      }
    }
    if (binaryBefore) {
      try { const after = await fingerprint(binaryBefore.path); await json(join(run.output, 'binary-after.json'), after); assertSameResourceBinary(binaryBefore, after); run.manifest.binaryIntegrity = { status: 'passed', before: binaryBefore, after }; }
      catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.binaryIntegrity = { status: 'failed', before: binaryBefore, ...errorInfo(error) }; }
    }
    run.manifest.cleanup.problems = problems;
    run.manifest.finishedAt = new Date().toISOString(); run.manifest.totalElapsedMs = performance.now() - began;
    await run.save(); await json(join(run.output, 'test-report.json'), run.manifest);
  }
  console.log(JSON.stringify({ status: run.manifest.status, frontend: run.manifest.frontend, report: join(run.output, 'test-report.json'), error: failure?.message }, null, 2));
  process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
  return run.manifest;
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.stack ?? error); process.exitCode = error instanceof BlockedError ? 2 : 1; });
