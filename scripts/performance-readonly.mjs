#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BlockedError } from './lib/desktop.mjs';
import { gitExecutable, isMain, json, parseArgs, readJson, required, sha256, until } from './lib/run.mjs';
import {
  chooseCommitSamples, compareRepositoryDigests, createPerformanceRun, INSTALL_OBSERVER,
  loadSamplePlan, newNativeOperation, privateOwnedProcesses, repositoryDigest, safeFailure,
  sampleCount, startPerformanceDesktop, summarizeSamples, validateSamplePlan, verifySamplePlan, writeSamplePlan,
} from './lib/performance.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const SEARCH = 'input[aria-label="Search commits"]';
const DETAILS = '.details-pane:not([hidden])';
const help = 'node scripts/performance-readonly.mjs --repository <absolute existing repo> --binary <app.exe> --driver <verified msedgedriver.exe> --output <fresh empty directory> [--samples 20] [--kind installed|native] [--sample-plan <trusted-private-json>] [--tauri-driver <exe>] [--git <exe>]\nReal read-only desktop measurements; no fixtures, trust, Git writes, safe.directory override, remote commands, user-state copying or fabricated readiness. Only a fresh output-owned application/WebView profile is written. Parent Windows user Git config is read unchanged. Always writes sample-plan.private.json exclusively in the fresh output; it contains private commit OIDs/paths and must never be exported. A supplied plan is strictly validated and verified without fallback before GUI. Exit0 = completed coverage; exit2 = blocked/incomplete coverage; exit1 = failure. Screenshots and sample plans are private/local, never public release evidence.';

class Suite {
  constructor(run, wd, signal, monitor) { Object.assign(this, { run, wd, signal, monitor }); this.samples = []; this.blockers = []; }
  check() { this.signal.throwIfAborted(); this.monitor.check(); }
  async wait(label, expression, args = [], timeout = 60000) {
    try { return await until(label, async () => { this.check(); return this.wd.script(expression, args); }, { timeout, signal: this.signal }); }
    catch (error) { error.conditionLabel = label; throw error; }
  }
  async native() {
    return this.wd.script('const api=window.__QGITGRAPH_PERFORMANCE__;return api&&typeof api.read==="function"?api.read():null;');
  }
  async sequence() { return Number(await this.wd.script('return document.querySelector(".app-shell")?.dataset.taskSequence??0;')); }
  async healthy() {
    const state = await this.wd.script('const e=document.querySelector(".app-shell");return {errors:document.querySelectorAll(".errorbar:not([hidden]), .inline-error, dialog[open] .form-error:not([hidden])").length,repoOpen:!!e?.dataset.repoPath,readOnly:!![...document.querySelectorAll(".trustbar:not(.diagnosticsbar)")].find(e=>!e.hidden)};');
    if (state.errors) { const error = new Error('The application reported a private error; payload omitted.'); error.code = 'APPLICATION_ERROR'; throw error; }
    if (state.repoOpen && !state.readOnly) throw new BlockedError('The measured repository is not visibly read-only/untrusted.');
  }
  async idleAfter(sequence) {
    await this.wait('actual history/metadata task completion', 'const e=document.querySelector(".app-shell");return e?.dataset.taskState==="idle"&&Number(e.dataset.taskSequence)>arguments[0]&&!document.querySelector(".history-overlay:not([hidden]) .loading-state");', [sequence]);
    await this.healthy();
  }
  async measure(scenario, index, spec, action, { nativeKind, oid, commitIndex, fileIndex, requiredNative = true, cacheClass } = {}) {
    this.check(); await this.healthy();
    const sample = { scenario, sampleIndex: index, commitIndex, fileIndex, cacheClass, status: 'running', source: this.run.manifest.performanceKind === 'installed' ? 'installed-observer-and-webdriver-wall' : nativeKind ? 'native-webview-span' : 'observational-only', startedAt: new Date().toISOString() };
    this.samples.push(sample);
    const before = nativeKind && this.run.manifest.performanceKind === 'native' ? await this.native() : null;
    await this.wd.script('window.__QGG_READONLY_PERF_OBSERVER__.arm(arguments[0]);return true;', [spec]);
    const start = performance.now(); let failureStage = 'webdriver-action';
    try {
      await action();
      failureStage = 'trusted-input-dom-paint';
      const observed = await this.wait('trusted input and actual DOM paint opportunity', 'const r=window.__QGG_READONLY_PERF_OBSERVER__.read();return r?.started&&r.inputTrusted&&arguments[0].every(name=>Number.isFinite(r.endpoints[name]?.paintOpportunityMs))?r:null;', [spec.endpoints.map(endpoint => endpoint.name)]);
      sample.timings = { webDriverWallMs: performance.now() - start };
      for (const [name, endpoint] of Object.entries(observed.endpoints)) {
        sample.timings[`injectedObservation.${name}.domReadyMs`] = endpoint.readyMs;
        sample.timings[`injectedObservation.${name}.paintOpportunityMs`] = endpoint.paintOpportunityMs;
      }
      sample.trustedInputObserved = true;
      if (before) {
        failureStage = 'native-operation-paint-no-active-descendants';
        const operation = await until('native operation, matching paint opportunity and no active descendant', async () => { this.check(); return newNativeOperation(before, await this.native(), nativeKind, oid); }, { timeout: 60000, signal: this.signal });
        sample.native = operation;
        const startAt = operation.root.startedAt;
        for (const phase of ['operation', 'metadata', 'file-list-paint-opportunity', 'diff-ready', 'paint-opportunity', 'selection-feedback', 'history-paint-opportunity']) {
          const candidates = operation.spans.filter(span => span.phase === phase && Number.isFinite(span.startedAt) && Number.isFinite(span.durationMs));
          if (candidates.length) {
            // Preserve the native webview clock. Never substitute driver wall
            // time or a synthetic sleep when an endpoint is absent.
            sample.timings[`native.${phase}.fromOperationStartMs`] = Math.max(...candidates.map(span => span.startedAt + span.durationMs - startAt));
          }
        }
        if (operation.native?.spans.length) {
          sample.timings['rust.correlatedSpans.totalMs'] = operation.native.spans.reduce((total, span) => total + (span.durationMs ?? 0), 0);
          sample.timings['rust.correlatedSpans.maxMs'] = Math.max(...operation.native.spans.map(span => span.durationMs ?? 0));
        }
        sample.nativeEndpoint = 'Input-associated operation through double-rAF paint opportunity; not GPU presentation time. Rust span totals are diagnostic sums and may overlap, never end-to-end duration.';
      } else if (nativeKind && this.run.manifest.performanceKind === 'native' && requiredNative) throw new BlockedError('Required native telemetry snapshot is unavailable; no wall-time fallback is allowed.');
      failureStage = 'postmeasurement-health';
      await this.healthy(); sample.status = 'measured';
    } catch (error) {
      sample.status = error instanceof BlockedError ? 'blocked' : 'failed'; sample.error = safeFailure(error); sample.failureStage = failureStage;
      try {
        sample.observationState = await this.wd.script('const observed=window.__QGG_READONLY_PERF_OBSERVER__?.read();const endpoints={};for(const [name,value] of Object.entries(observed?.endpoints??{}).slice(0,8)){if(!/^[A-Za-z][A-Za-z0-9_-]{0,64}$/.test(name))continue;const result={};for(const key of ["readyMs","paintOpportunityMs"])if(Number.isFinite(value?.[key]))result[key]=value[key];if(typeof value?.pending==="boolean")result.pending=value.pending;endpoints[name]=result;}const rawMode=document.querySelector(arguments[0])?.value;const mode=["diff","old","new"].includes(rawMode)?rawMode:null;const dump=window.__QGITGRAPH_PERFORMANCE__?.read();const active={};for(const span of dump?.active??[]){if(!/^[A-Za-z][A-Za-z0-9_-]{0,64}$/.test(span.kind)||!/^[A-Za-z][A-Za-z0-9_-]{0,64}$/.test(span.phase))continue;const key=span.kind+"/"+span.phase;if(Object.keys(active).length<32||Object.hasOwn(active,key))active[key]=(active[key]??0)+1;}return {started:observed?.started===true,inputTrusted:observed?.inputTrusted===true,endpoints,currentContentMode:mode,detailsOpen:!!document.querySelector(".details-pane:not([hidden])"),hasLoading:!![...document.querySelectorAll(".loading-state")].find(e=>e.getClientRects().length),errorCount:document.querySelectorAll(".errorbar:not([hidden]),.inline-error,dialog[open] .form-error:not([hidden])").length,nativeActiveCount:dump?.active?.length??null,nativeActiveKindPhaseCounts:active};', ['select[aria-label="Content view"]']);
      } catch (diagnosticError) { sample.observationState = { unavailable: true, error: safeFailure(diagnosticError) }; }
      throw error;
    }
    finally {
      sample.finishedAt = new Date().toISOString();
      await this.wd.script('window.__QGG_READONLY_PERF_OBSERVER__.cancel();return true;').catch(() => undefined);
      this.run.manifest.performanceSummary = summarizeSamples(this.samples); await this.run.save();
      await json(join(this.run.output, 'performance-samples.json'), this.samples);
    }
    return sample;
  }
  async closeDetails() {
    if (await this.wd.script('return !!document.querySelector(arguments[0]);', ['button[aria-label="Close details (Escape)"]'])) {
      await this.wd.click('button[aria-label="Close details (Escape)"]');
      await this.wait('details actually closed', 'return !document.querySelector(".details-pane:not([hidden])");');
    }
  }
  async menu() { await this.wd.click('button[data-action="repository-options"]'); await this.wait('repository menu visible', 'return !!document.querySelector("[role=menu]");'); }
  async closeRepository() {
    await this.closeDetails(); await this.menu(); await this.wd.clickText('[role="menuitem"]', 'Close repository');
    await this.wait('repository closed', 'return document.querySelector(".app-shell")?.dataset.repoPath==="";');
  }
  async openDialog(repository) {
    await this.menu(); await this.wd.click('[role="menuitem"][data-action="open-repository-by-path"]');
    await this.wait('repository path form', 'return !!document.querySelector("dialog[open] input[name=path]");');
    await this.wd.fill('dialog[open] input[name="path"]', repository);
  }
  async open(repository, scenario, index) {
    await this.openDialog(repository); const sequence = await this.sequence();
    return this.measure(scenario, index, { event: 'click', selector: 'button[data-action="confirm-open-repository"]', endpoints: [{ name: 'firstHistory', type: 'repository-history', sequence }, { name: 'repositoryReady', type: 'repository', sequence }] }, () => this.wd.click('dialog[open] button[data-action="confirm-open-repository"]'), { nativeKind: 'openRepository' });
  }
  async selectOption(selector, value) {
    const previous = await this.wd.script('return document.querySelector(arguments[0])?.value;', [selector]);
    if (previous === value) return;
    const sequence = await this.sequence(); await this.wd.select(selector, value);
    if (selector.includes('Search scope') || (selector.includes('Search field') && await this.wd.script('return document.querySelector(arguments[0])?.value==="search";', ['select[aria-label="Search scope"]']))) await this.idleAfter(sequence);
  }
  async resetQuery() {
    await this.closeDetails();
    await this.selectOption('select[aria-label="Search scope"]', 'filter');
    await this.selectOption('select[aria-label="Search field"]', 'all');
    await this.wd.fill(SEARCH, '');
    await this.wait('unfiltered rows visible', 'return !!document.querySelector(".commit-row:not(.working-row)")&&!document.querySelector(".history-overlay:not([hidden]) .loading-state");');
  }
  async prepareCommit(item) {
    await this.closeDetails(); await this.selectOption('select[aria-label="Search scope"]', 'filter');
    await this.selectOption('select[aria-label="Search field"]', 'hash'); await this.wd.fill(SEARCH, item.oid);
    const loaded = await this.wd.script('return !!document.getElementById("commit-"+arguments[0]);', [item.oid]);
    if (!loaded) {
      // A bounded real history query is the only fallback for a commit outside
      // the initial300. This is visible UI, never a private host invocation.
      await this.selectOption('select[aria-label="Search scope"]', 'search');
    }
    await this.wait('actual selected candidate row', 'return !!document.getElementById("commit-"+arguments[0]);', [item.oid]);
  }
  commitSpec(item) { return { event: 'click', selector: '.commit-row', endpoints: [{ name: 'firstFileList', type: 'files', oid: item.oid }, { name: 'firstDiff', type: 'diff', oid: item.oid, text: true }] }; }
  async commit(item, scenario, index, cacheClass) {
    await this.prepareCommit(item);
    return this.measure(scenario, index, this.commitSpec(item), () => this.wd.click(`[id="commit-${item.oid}"] .hash-cell`), { nativeKind: 'commitSelection', oid: item.oid, commitIndex: item.commitIndex, cacheClass });
  }
  async commitUnmeasured(item) {
    await this.prepareCommit(item); await this.wd.click(`[id="commit-${item.oid}"] .hash-cell`);
    await this.wait('real commit detail and first diff', 'const d=document.querySelector(".details-pane:not([hidden])");return d?.querySelector(".detail-summary > .mono")?.textContent.trim()===arguments[0]&&!!d.querySelector(".diff-view .diff-line,.diff-view .empty-state")&&!d.querySelector(".loading-state");', [item.oid]);
  }
  async fileClick(path) {
    // Read an actual element reference rather than putting a private Git path
    // into a CSS string, error or command-log body.
    const element = await this.wd.script('const rows=[...document.querySelectorAll(".file-row")].filter(e=>e.dataset.path===arguments[0]);if(rows.length!==1)return null;return rows[0];', [path]);
    if (!element?.[ELEMENT]) throw new BlockedError('Chosen text file is not a unique visible changed-file row.');
    await this.wd.clickElement(element[ELEMENT]);
  }
  async optional(scenario, work) {
    try { await work(); }
    catch (error) {
      this.check(); const last = this.samples.at(-1);
      if (last?.scenario === scenario && last.status === 'failed') last.status = 'blocked';
      this.blockers.push({ scenario, status: 'blocked', error: safeFailure(error), interpretation: 'No substitute action, injected event or fabricated measurement was used.' });
      const overlayOpen = await this.wd.script('return !!document.querySelector("[role=menu],dialog[open]");').catch(() => false);
      if (overlayOpen) await this.wd.keys(['\uE00C']).catch(() => undefined);
    }
  }
}

async function runScenarios(suite, repository, commits, count) {
  const { wd } = suite; const short = Math.min(3, count);
  await suite.open(repository, 'repository-open-fresh-profile', 0);
  for (let index = 0; index < count; index++) { await suite.closeRepository(); await suite.open(repository, 'repository-open-warm', index); }
  for (let index = 0; index < short; index++) {
    const sequence = await suite.sequence();
    await suite.measure('repository-refresh', index, { event: 'click', selector: 'button[data-action="refresh"]', endpoints: [{ name: 'repositoryReady', type: 'repository', sequence }] }, () => wd.click('button[data-action="refresh"]'), { nativeKind: 'refresh' });
  }
  await suite.optional('history-paging', async () => {
    for (let index = 0; index < short; index++) {
      const available = await wd.script('const b=document.querySelector("button[data-action=load-more]");return !!b&&!b.hidden&&!b.disabled;');
      if (!available) throw new BlockedError('Repository has no further real page for this bounded sample.');
      const sequence = await suite.sequence();
      const rowCount = await wd.script('return Number(document.querySelector(".history-pane")?.getAttribute("aria-rowcount"));');
      await suite.measure('history-paging', index, { event: 'click', selector: 'button[data-action="load-more"]', endpoints: [{ name: 'pageReady', type: 'paging', sequence, rowCount }] }, () => wd.click('button[data-action="load-more"]'), { nativeKind: 'history' });
    }
  });
  //20 distinct nonmerge commits and20 distinct initial diffs are measured BEFORE
  // revisiting them. There is no hidden cache-clearing or fixture substitution.
  for (const [index, item] of commits.entries()) await suite.commit(item, 'commit-first-selection', index, 'first-selection-this-session');
  for (const [index, item] of commits.entries()) await suite.commit(item, 'commit-revisit', index, 'revisit-no-hidden-cache-reset');
  const multi = commits.filter(item => item.files.length > 1);
  await suite.optional('file-change', async () => {
    if (!multi.length) throw new BlockedError('The bounded real commit sample has no second text-change file.');
    const seen = new Set();
    for (let index = 0; index < count; index++) {
      const item = multi[index % multi.length]; await suite.commitUnmeasured(item);
      const original = await wd.script('return document.querySelector(".file-row.selected")?.dataset.path;');
      const path = item.files.find(candidate => candidate !== original); if (!path) throw new BlockedError('No different real text-change path is available.');
      const identity = `${item.commitIndex}:${path}`; const cacheClass = seen.has(identity) ? 'repeated-change' : 'first-explicit-change-this-session'; seen.add(identity);
      await suite.measure('file-change', index, { event: 'click', selector: '.file-row', endpoints: [{ name: 'diff', type: 'diff', oid: item.oid, path, text: true }] }, () => suite.fileClick(path), { nativeKind: 'fileSelection', oid: item.oid, commitIndex: item.commitIndex, fileIndex: item.files.indexOf(path), cacheClass });
      if (original) await suite.measure('file-revisit', index, { event: 'click', selector: '.file-row', endpoints: [{ name: 'diff', type: 'diff', oid: item.oid, path: original }] }, () => suite.fileClick(original), { nativeKind: 'fileSelection', oid: item.oid, commitIndex: item.commitIndex, fileIndex: 0, cacheClass: 'revisit-no-hidden-cache-reset' });
    }
  });
  await suite.commitUnmeasured(commits[0]);
  for (const mode of ['split', 'unified']) await suite.optional(`diff-layout-${mode}`, async () => {
    for (let index = 0; index < short; index++) {
      const opposite = mode === 'split' ? 'Unified diff' : 'Side-by-side diff'; await wd.click(`button[aria-label="${opposite}"]`);
      await suite.measure(`diff-layout-${mode}`, index, { event: 'click', selector: '.diff-toolbar button', endpoints: [{ name: 'layout', type: 'layout', value: mode }] }, () => wd.click(`button[aria-label="${mode === 'split' ? 'Side-by-side diff' : 'Unified diff'}"]`), { nativeKind: 'diffMode' });
    }
  });
  for (const mode of ['old', 'new']) await suite.optional(`file-content-${mode}`, async () => {
    for (let index = 0; index < short; index++) {
      await wd.select('select[aria-label="Content view"]', 'diff');
      const sample = await suite.measure(`file-content-${mode}`, index, { event: 'click', selector: 'select[aria-label="Content view"]', endpoints: [{ name: 'content', type: 'content', value: mode }] }, async () => { await wd.click('select[aria-label="Content view"]'); await wd.select('select[aria-label="Content view"]', mode); }, { nativeKind: 'diffMode' });
      sample.observationalEndpoint = 'Trusted select-opening click through actual selected-mode DOM paint opportunity; includes dropdown-opening and WebDriver routing overhead. Native diffMode starts at its handler and remains a separate population.';
    }
  });
  await suite.optional('diff-scroll', async () => {
    await wd.select('select[aria-label="Content view"]', 'new');
    const geometry = await wd.script('const e=document.querySelector(".diff-scroll");return e?{top:e.scrollTop,max:e.scrollHeight-e.clientHeight}:null;');
    if (!geometry || geometry.max < 2) throw new BlockedError('Chosen real file does not have a scrollable new-content viewport.');
    await wd.click('.diff-scroll'); await wd.keys(['\uE011']);
    for (let index = 0; index < short; index++) {
      const before = await wd.script('return document.querySelector(".diff-scroll").scrollTop;');
      await suite.measure('diff-scroll', index, { event: 'keydown', selector: '.diff-scroll', key: 'PageDown', endpoints: [{ name: 'scroll', type: 'scroll', selector: '.diff-scroll', before }] }, () => wd.keys(['\uE00F']));
      await wd.keys(['\uE011']);
    }
  });
  await suite.resetQuery();
  for (let index = 0; index < short; index++) {
    await suite.selectOption('select[aria-label="Search field"]', 'hash'); await wd.fill(SEARCH, ''); const item = commits[index];
    await suite.measure('filter-loaded', index, { event: 'input', selector: SEARCH, endpoints: [{ name: 'filteredRows', type: 'filter', oid: item.oid }] }, () => wd.fill(SEARCH, item.oid), { commitIndex: item.commitIndex });
  }
  await suite.resetQuery(); await suite.selectOption('select[aria-label="Search scope"]', 'search');
  await suite.selectOption('select[aria-label="Search field"]', 'hash');
  for (let index = 0; index < short; index++) {
    await wd.fill(SEARCH, ''); await wd.keys(['\uE007']); const clearSequence = await suite.sequence();
    await suite.wait('search query fully settled', 'const e=document.querySelector(".app-shell");return e?.dataset.taskState==="idle"&&!document.querySelector(".history-overlay:not([hidden]) .loading-state");');
    const sequence = await suite.sequence(); const item = commits[index];
    await suite.measure('search-history', index, { event: 'input', selector: SEARCH, endpoints: [{ name: 'history', type: 'history', sequence, oid: item.oid }] }, async () => { await wd.fill(SEARCH, item.oid); await wd.keys(['\uE007']); }, { nativeKind: 'history', oid: item.oid, commitIndex: item.commitIndex });
  }
  await suite.resetQuery();
  for (let index = 0; index < short; index++) {
    await suite.measure('repository-menu', index, { event: 'click', selector: 'button[data-action="repository-options"]', endpoints: [{ name: 'menu', type: 'menu' }] }, () => wd.click('button[data-action="repository-options"]'));
    await wd.keys(['\uE00C']); await suite.wait('actual menu closed', 'return !document.querySelector("[role=menu]");');
  }
  await suite.optional('rapid-selection-last-wins', async () => {
    for (let index = 0; index < short; index++) {
      await suite.closeDetails(); await wd.click('.history-pane'); await wd.keys(['\uE011']);
      const rows = await wd.script('return [...document.querySelectorAll(".commit-row:not(.working-row)")].slice(0,3).map(e=>e.dataset.oid);');
      if (rows.length < 3) throw new BlockedError('At least3 real commit rows are required for rapid keyboard navigation.');
      await wd.click(`[id="commit-${rows[0]}"] .hash-cell`);
      await suite.wait('starting rapid selection detail settled', 'return document.querySelector(".detail-summary > .mono")?.textContent.trim()===arguments[0]&&!!document.querySelector(".diff-view")&&!document.querySelector(".details-pane .loading-state");', [rows[0]]);
      await suite.measure('rapid-selection-last-wins', index, { event: 'keydown', selector: '.history-pane', key: 'ArrowDown', endpoints: [{ name: 'lastDiff', type: 'diff', oid: rows[2] }] }, () => wd.keys(['\uE015', '\uE015', '\uE013', '\uE015']), { nativeKind: 'commitSelection', oid: rows[2] });
    }
  });
  suite.blockers.push({ scenario: 'native-cancellation-acknowledgement', status: 'blocked', interpretation: 'Final UI selection is measured independently. Native cancellation/process-exit acknowledgement is not inferred from stale-result suppression, a cancel request, idle state or completed paint.' });
  await suite.optional('window-resize', async () => {
    const original = await wd.call('GET', `${wd.prefix}/window/rect`);
    try {
      for (let index = 0; index < short; index++) {
        const width = index % 2 ? original.width : Math.max(800, original.width - 80); const before = await wd.script('return window.innerWidth;');
        await suite.measure('window-resize', index, { event: 'resize', endpoints: [{ name: 'resize', type: 'resize', before }] }, () => wd.call('POST', `${wd.prefix}/window/rect`, { width, height: original.height }));
      }
    } finally { await wd.call('POST', `${wd.prefix}/window/rect`, { width: original.width, height: original.height }); }
  });
}

async function capturePrivateEvidence(run, wd, label) {
  if (!wd?.sessionId) return;
  const screenshot = await wd.call('GET', `${wd.prefix}/screenshot`);
  await writeFile(join(run.output, 'evidence', `${label}.png`), Buffer.from(screenshot, 'base64'), { flag: 'wx' });
  const geometry = await wd.script('return {width:innerWidth,height:innerHeight,commitRows:document.querySelectorAll(".commit-row").length,fileRows:document.querySelectorAll(".file-row").length,diffRows:document.querySelectorAll(".diff-line").length,detailsOpen:!!document.querySelector(".details-pane:not([hidden])"),menus:document.querySelectorAll("[role=menu]").length,errorCount:document.querySelectorAll(".errorbar:not([hidden]),.inline-error").length};');
  await json(join(run.output, 'evidence', `${label}-geometry.json`), geometry);
  run.manifest.evidence.push({ screenshot: `evidence/${label}.png`, geometry: `evidence/${label}-geometry.json`, visibility: 'Private local only. May show repository/file contents. Never copy into a public release.' });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, { values: ['repository', 'binary', 'driver', 'output', 'samples', 'kind', 'sample-plan', 'tauri-driver', 'git'], flags: ['help'] });
  if (options.help) { console.log(help); return 0; }
  required(options, ['repository', 'binary', 'driver', 'output']);
  const count = sampleCount(options.samples); const kind = options.kind ?? 'installed';
  if (!['installed', 'native'].includes(kind)) throw new Error('--kind must be installed or native.');
  const repository = resolve(options.repository); const output = resolve(options.output);
  const run = await createPerformanceRun(output, repository, kind, count); const owned = privateOwnedProcesses(run);
  const controller = new AbortController(); const stop = () => controller.abort(new BlockedError('Run interrupted; only owned processes will be cleaned up.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let before, suite, wd, monitor, failure; const cleanupErrors = [];
  try {
    if (process.platform !== 'win32') throw new BlockedError('This harness requires an actual Windows desktop.');
    run.gitBinary = gitExecutable(options.git); run.manifest.git.executable = run.gitBinary;
    before = await repositoryDigest(run, repository, undefined, controller.signal);
    await json(join(output, 'repository-before-digest.json'), before.digest);
    run.manifest.repository = { identitySha256: sha256(repository), effectiveConfigSha256: before.digest.effectiveConfigSha256, trackedCount: before.digest.trackedCount, samplesUseIndexesOnly: true };
    let privatePlan;
    if (options['sample-plan']) {
      privatePlan = await loadSamplePlan(resolve(options['sample-plan']), repository, count);
      await verifySamplePlan(run, repository, privatePlan, controller.signal);
    } else {
      const candidates = await chooseCommitSamples(run, repository, count, controller.signal);
      privatePlan = validateSamplePlan({ schemaVersion: 1, repositoryIdentitySha256: sha256(repository), privacy: 'private-local-only-do-not-export', samples: candidates }, repository, count);
    }
    const commits = privatePlan.samples;
    run.manifest.samplePlan = await writeSamplePlan(run, privatePlan);
    run.manifest.selection = { distinctCommits: commits.length, selectedFrom: options['sample-plan'] ? 'Pinned private plan, exact commit/parent and text-change file membership verified via read-only Git before GUI; no fallback.' : 'First300 date-ordered nonmerge candidates via read-only Git; text-change commits only.', parentPolicy: 'nonmerge-default-parent', privateOidsAndPathsArchived: 'Only in sample-plan.private.json; private-local-only, never public metrics.' };
    await run.save();
    // The launch helper records PID+creation-time roots/descendants. Repeated
    // CIM walks during timed input add unrelated contention; take ownership
    // snapshots at launch and finally only, never on a background sample timer.
    monitor = { check() {}, async stop() {} };
    run.manifest.ownershipSampling = 'PID+creation time at launch and shutdown; no background CIM polling during latency samples.';
    wd = await startPerformanceDesktop(run, options, owned, controller.signal); suite = new Suite(run, wd, controller.signal, monitor);
    await wd.script(INSTALL_OBSERVER);
    if (kind === 'native') {
      const snapshot = await suite.native();
      if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.enabled !== true || !Array.isArray(snapshot.spans) || !Array.isArray(snapshot.active)) throw new BlockedError('Native telemetry v1 is not enabled/available. Build with the approved performance gate; no injected/wall-time native fallback is permitted.');
      run.manifest.telemetry = { schemaVersion: snapshot.schemaVersion, capacity: snapshot.capacity, gate: 'QGITGRAPH_PERF=1', readOnly: true };
    } else run.manifest.telemetry = { available: false, interpretation: 'Installed0.2: separate WebDriver wall and injected observational input-to-double-rAF timings, not native IPC/Rust timings.' };
    await runScenarios(suite, repository, commits, count);
    run.manifest.status = suite.blockers.length ? 'blocked' : 'passed';
    run.manifest.measurementStatus = 'completed';
  } catch (error) {
    failure = error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = safeFailure(error); run.manifest.measurementStatus = 'incomplete';
  } finally {
    wd ??= run.webDriver;
    if (monitor) { try { await monitor.stop(); } catch (error) { cleanupErrors.push({ phase: 'ownership-monitor', ...safeFailure(error) }); } }
    if (wd?.sessionId) { try { await capturePrivateEvidence(run, wd, failure ? 'failure-private' : 'final-private'); } catch (error) { cleanupErrors.push({ phase: 'private-evidence', ...safeFailure(error) }); } }
    if (wd?.sessionId) {
      try { await owned.snapshot(); await wd.call('DELETE', wd.prefix, undefined, 30000); if (run.manifest.session) run.manifest.session.closedAt = new Date().toISOString(); }
      catch (error) { cleanupErrors.push({ phase: 'session-close', ...safeFailure(error) }); }
    }
    try {
      const cleanup = await owned.cleanup(); run.manifest.cleanup = { ...cleanup, errors: [...(cleanup.errors ?? []), ...cleanupErrors] };
      if ((cleanup.remaining?.length ?? 0) || (cleanup.errors?.length ?? 0) || cleanupErrors.length) { run.manifest.status = 'failed'; failure ??= new Error('Owned cleanup or evidence was incomplete.'); }
    } catch (error) { run.manifest.cleanup = { errors: [...cleanupErrors, safeFailure(error)] }; run.manifest.status = 'failed'; failure ??= error; }
    if (before) {
      try {
        const after = await repositoryDigest(run, repository, before.plan);
        await json(join(output, 'repository-after-digest.json'), after.digest);
        run.manifest.repositoryIntegrity = compareRepositoryDigests(before.digest, after.digest);
        if (run.manifest.repositoryIntegrity.status !== 'unchanged-within-stated-coverage') { run.manifest.status = 'blocked'; run.manifest.measurementStatus = 'invalidated-by-unattributed-repository-or-config-change'; }
      } catch (error) { run.manifest.repositoryIntegrity = { status: 'blocked', error: safeFailure(error), restored: false }; run.manifest.status = 'blocked'; }
    }
    // Read only our own fresh profile after app exit. Never copy the user's
    // real state, preferences, recent paths, source contents or raw Git output.
    try { const state = await readJson(join(run.profileDirectory, 'state.json')); if (state.trusted?.length) { run.manifest.status = 'failed'; run.manifest.trustIntegrity = 'Unexpected trust entry in run-owned profile.'; } else run.manifest.trustIntegrity = 'No trust entry in run-owned profile.'; }
    catch (error) { cleanupErrors.push({ phase: 'owned-profile-trust-check', ...safeFailure(error) }); run.manifest.status = 'failed'; }
    run.manifest.finishedAt = new Date().toISOString();
    const samples = suite?.samples ?? []; const summary = summarizeSamples(samples);
    const report = {
      schemaVersion: 1, kind: 'performance-readonly', performanceKind: kind, runId: run.manifest.runId, status: run.manifest.status, measurementStatus: run.manifest.measurementStatus,
      startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt, requestedSamples: count, boundedScenarioSamples: Math.min(3, count),
      binary: run.manifest.binary, environmentPolicy: run.manifest.environmentPolicy, preferences: run.manifest.preferences,
      repository: run.manifest.repository, repositoryIntegrity: run.manifest.repositoryIntegrity, samplePlan: run.manifest.samplePlan,
      metrics: summary, samples, coverageBlockers: suite?.blockers ?? [], cleanup: run.manifest.cleanup, privacy: run.manifest.privacy, error: run.manifest.error,
      interpretation: 'Fresh-profile repository open is not an OS/disk-cache-cold claim. WebDriver wall, injected observations and native spans are separate populations. Paint opportunity is double-rAF, not actual GPU presentation. No user file contents or private paths/OIDs are included in metrics; local screenshots and the separate sample-plan.private.json may contain private data and must never be exported. Concurrent repository/config changes invalidate comparison and are never restored. Cancellation acknowledgement is never inferred from last-selection-wins.',
    };
    await run.save(); await json(join(output, 'performance-report.json'), report);
    await json(join(output, 'webdriver-command-metadata.json'), (wd?.commands ?? []).map(({ method, path, startedAt, durationMs, ok, error }) => ({ method, path, startedAt, durationMs, ok, error })));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  console.log(JSON.stringify({ status: run.manifest.status, measurementStatus: run.manifest.measurementStatus, output, report: join(output, 'performance-report.json'), measuredSamples: suite?.samples.filter(sample => sample.status === 'measured').length ?? 0, blockedCoverage: suite?.blockers.length ?? 0, privateErrorOmitted: !!failure }, null, 2));
  return run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
}
if (isMain(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Invalid CLI arguments or fresh output/profile prerequisite. No private error payload is printed. Use --help.'); process.exitCode = 2; });
