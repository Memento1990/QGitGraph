#!/usr/bin/env node
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BlockedError } from './lib/desktop.mjs';
import { fingerprint, gitExecutable, inside, isMain, json, parseArgs, PROJECT, readJson, required, samePath, sha256, until } from './lib/run.mjs';
import { chooseCommitSamples, compareRepositoryDigests, createPerformanceRun, privateOwnedProcesses, READONLY_UI_HELPERS, readOnlyGit, repositoryDigest, safeFailure, startPerformanceDesktop, validateSamplePlan } from './lib/performance.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const SEARCH = 'input[aria-label="Search commits"]';
const FILE_FILTER = 'input[aria-label="Filter changed files"]';
export const SCOPE = 'Actual Windows repository-load and one-commit/file-diff smoke acceptance, not a performance benchmark. Three bounded real nonmerge/text-change samples are selected; only the first is exercised through filter-loaded history, without history-search/paging fallback. No trust grant, Git writes/network, fixtures, source execution, user-state copying or configuration changes. Old/new full-content modes and full performance coverage are not claimed. Concurrent changes block results and are never restored.';
const HELP = 'node scripts/test-repository-readonly.mjs --repository <absolute existing repository root> --binary <absolute frozen app.exe> --driver <absolute verified msedgedriver.exe> --output <absolute fresh empty directory outside repository> [--git <exe>] [--tauri-driver <exe>] [--screenshot]\nActual Windows UI read-only smoke acceptance. Fixed native mode, three in-memory samples, fresh isolated English application/WebView profile; normal Windows Git HOME/config lookup is preserved. No user state/config/trust changes. Private/local-only report: publicEligible=false. Default evidence is bounded counts, booleans, hashes and WebDriver wall timings, never DOM/source/error payloads. An explicitly requested screenshot may expose private data and must not be published. Exit 0=passed, 2=blocked/incomplete, 1=failed. Do not run before the frozen binary and target repository have been authorized.';
function problem(code, blocked = false) { const error = blocked ? new BlockedError('A required read-only smoke condition was not met; private details omitted.') : new Error('Read-only smoke acceptance failed; private details omitted.'); error.code = code; return error; }

export function assertRepositoryReadonlyOutput(repository, output, protectedPaths = []) {
  if (!isAbsolute(repository) || !isAbsolute(output)) throw problem('ABSOLUTE_PATH_REQUIRED', true);
  const overlaps = (a, b) => samePath(a, b) || inside(a, b) || inside(b, a);
  if (overlaps(repository, output) || protectedPaths.some(path => overlaps(path, output))) throw problem('OUTPUT_OVERLAPS_PROTECTED_PATH', true);
  if ((samePath(PROJECT, output) || inside(PROJECT, output)) && !inside(join(PROJECT, 'artifacts'), output)) throw problem('OUTPUT_REQUIRES_PRIVATE_ARTIFACTS', true);
}
export function parseRepositoryReadonlyArgs(argv) {
  let options;
  try { options = parseArgs(argv, { values: ['repository', 'binary', 'driver', 'output', 'git', 'tauri-driver'], flags: ['help', 'screenshot'] }); }
  catch { throw problem('INVALID_OPTIONS', true); }
  if (options.help) return options;
  required(options, ['repository', 'binary', 'driver', 'output']);
  for (const key of ['repository', 'binary', 'driver', 'output']) {
    if (!isAbsolute(options[key]) || /[\x00-\x1f\x7f]/.test(options[key])) throw problem('ABSOLUTE_PATH_REQUIRED', true);
    options[key] = resolve(options[key]);
  }
  for (const key of ['git', 'tauri-driver']) if (options[key]) {
    if (/[\x00-\x1f\x7f]/.test(options[key]) || options[key].startsWith('-') || (/[\\/]/.test(options[key]) && !isAbsolute(options[key]))) throw problem('INVALID_EXECUTABLE_OPTION', true);
  }
  assertRepositoryReadonlyOutput(options.repository, options.output, [options.binary, options.driver]);
  return options;
}
async function unredirectedOutput(path) {
  try { return await realpath(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(path); if (parent === path) throw error; return join(await unredirectedOutput(parent), basename(path)); }
}
async function validateInputs(options) {
  const repository = await realpath(options.repository);
  if (!(await lstat(repository)).isDirectory()) throw problem('REPOSITORY_DIRECTORY_REQUIRED', true);
  // Requiring a root marker prevents a subdirectory input from placing output
  // elsewhere inside its repository before Git can confirm the canonical root.
  const marker = await lstat(join(repository, '.git'));
  if ((!marker.isDirectory() && !marker.isFile()) || marker.isSymbolicLink()) throw problem('REPOSITORY_ROOT_REQUIRED', true);
  const output = await unredirectedOutput(options.output);
  if (!samePath(output, options.output)) throw problem('OUTPUT_REDIRECTED', true);
  const profiles = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map(path => join(path, 'app.qgitgraph.desktop'));
  if (process.env.QGITGRAPH_TEST_HOME) profiles.push(process.env.QGITGRAPH_TEST_HOME);
  const files = await Promise.all([options.binary, options.driver, ...['git', 'tauri-driver'].filter(key => options[key] && isAbsolute(options[key])).map(key => options[key])].map(path => realpath(path)));
  assertRepositoryReadonlyOutput(repository, output, [...profiles, ...files]);
}

// Every browser body below is observation only. All inputs use WebDriver element
// clicks/keys/value/option clicks, never script-side interaction or business IPC.
export const READ_REPOSITORY_UI = `
${READONLY_UI_HELPERS}
const normalized=value=>{let s=String(value??'').replaceAll(String.fromCharCode(92),'/');if(/^[/][/][?][/]unc[/]/i.test(s))s='//'+s.slice(8);else if(s.startsWith('//?/'))s=s.slice(4);while(s.endsWith('/'))s=s.slice(0,-1);const wsl=/^([/][/](?:wsl[.]localhost|wsl[$]))([/].*)$/i.exec(s);return wsl?wsl[1].toLowerCase()+wsl[2]:s.toLowerCase();};
const shell=document.querySelector('.app-shell'), status=document.querySelector('.statusbar');
const oid=arguments[2], path=arguments[3],ui=historyUi({oid,path,parent:arguments[4]});
const detail=ui.detail,diff=ui.diff;
const target=oid?document.getElementById('commit-'+oid):null;
const matchingFiles=path?ui.files.filter(e=>e.dataset.path===path&&visible(e)):[];
const title=diff?.querySelector('.empty-state strong')?.textContent?.trim()??'';
const limited=ui.toolbar?.querySelector('.muted')?.textContent?.trim()==='Limited preview — use external diff for the full file';
const diffRows=ui.rows.length;
let diffKind=null;
if(ui.ready){
  if(ui.patchReady)diffKind=limited?'truncated-text':'text';
  else if(title==='Binary file')diffKind='binary';
  else if(title==='Limited preview · content unavailable')diffKind='truncated';
  else if(['No textual differences','No text hunks','Empty file'].includes(title))diffKind='empty';
}
const errorCount=document.querySelectorAll('.errorbar:not([hidden]),.inline-error,dialog[open] .form-error:not([hidden]),.statusbar-task[data-tone="error"]').length;
return {
  shellPresent:!!shell, repoOpen:!!shell?.dataset.repoPath,
  repositoryMatches:!!arguments[0]&&normalized(shell?.dataset.repoPath)===normalized(arguments[0]),
  headMatches:!!arguments[1]&&shell?.dataset.repoHead===arguments[1],
  idle:shell?.dataset.taskState==='idle', sequence:Number(shell?.dataset.taskSequence??0),
  errorCount, statusWorkingError:status?.dataset.workingState==='error', statusHistoryError:status?.dataset.historyState==='error',
  statusPresent:!!status, workingStateKnown:['clean','changed','conflict','bare'].includes(status?.dataset.workingState),
  statusStale:status?.dataset.stale==='true'||status?.dataset.historyStale==='true', statusHistoryReady:status?.dataset.historyState==='ready',
  untrustedVisible:[...document.querySelectorAll('.trustbar:not(.diagnosticsbar)')].some(visible),
  historyRows:document.querySelectorAll('.commit-row:not(.working-row)').length,
  historyGridRows:Number(document.querySelector('.history-pane')?.getAttribute('aria-rowcount')??0),
  historyBusy:document.querySelector('.history-pane')?.getAttribute('aria-busy')!=='false',
  loadingVisible:[...document.querySelectorAll('.loading-state')].some(visible),
  menuVisible:visible(document.querySelector('[role="menu"]')),
  pathFormVisible:visible(document.querySelector('dialog[open] input[name="path"]')),
  filterLoaded:document.querySelector('select[aria-label="Search scope"]')?.value==='filter',
  hashFilter:document.querySelector('select[aria-label="Search field"]')?.value==='hash',
  targetRowPresent:visible(target), targetRowMatches:!!target&&target.dataset.oid===oid,
  targetHashTextOnly:!!target?.querySelector('.hash-cell')&&!target.querySelector('.hash-cell a,.hash-cell button'),
  detailsVisible:visible(detail), detailMatches:!!oid&&ui.detailOid===oid, filesReady:ui.filesReady,
  fileRows:ui.files.length, matchingFileRows:matchingFiles.length,
  selectedFileMatches:!!path&&ui.file===path,
  historyDocuments:ui.modern, graphVisible:visible(document.querySelector('.graph-surface')),
  embeddedDiffPresent:!!detail?.querySelector('.diff-view'), documentMatches:ui.documentMatches,
  patchReady:ui.patchReady, changedRows:ui.changedRows.length, changeCount:ui.changeCount,
  diffRows, diffKind, contentMode:ui.mode==='diff'?'diff':null
};`;
export const FIND_SAMPLE_FILE = `
const rows=[...document.querySelectorAll('.details-pane:not([hidden]) .file-row')].filter(e=>e.dataset.path===arguments[0]&&!e.closest('[hidden]')&&e.getClientRects().length>0);
return rows.length===1?rows[0]:null;`;
export const BROWSER_SCRIPTS = Object.freeze([READ_REPOSITORY_UI, FIND_SAMPLE_FILE]);
export function assertRepositoryUiHealth(state) {
  if (state?.errorCount || state?.statusWorkingError || state?.statusHistoryError) throw problem('APPLICATION_UI_ERROR');
  if (state?.repoOpen && !state.untrustedVisible) throw problem('UNTRUSTED_BAR_MISSING');
}
export function cleanupCounts(value) {
  const known = Array.isArray(value?.remaining) && Array.isArray(value?.errors) && Array.isArray(value?.stopped);
  return { status: known && !value.remaining.length && !value.errors.length ? 'verified-zero' : 'incomplete', remaining: known ? value.remaining.length : null, errors: known ? value.errors.length : null, stopped: known ? value.stopped.length : null, scope: 'Only PID plus exact creation time and observed run-owned descendants; no process-name termination.' };
}

async function exerciseUi(run, wd, repository, head, sample, signal) {
  const observe = () => wd.script(READ_REPOSITORY_UI, [repository, head, sample.oid, sample.files[0], sample.parents[0] ?? null]);
  async function wait(condition, test, timeout = 90000, paint = false) {
    try { return await until(condition, async () => {
      signal.throwIfAborted(); const state = await observe(); assertRepositoryUiHealth(state);
      if (!test(state)) return false;
      if (!paint) return state;
      // Read-only async observation: recheck after a genuine double-rAF paint
      // opportunity, not a sleep, detached node count or injected DOM flag.
      await wd.call('POST', `${wd.prefix}/execute/async`, { script: 'const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));', args: [] }, 15000);
      signal.throwIfAborted(); const painted = await observe(); assertRepositoryUiHealth(painted);
      return test(painted) ? painted : false;
    }, { timeout, interval: 200, signal }); }
    catch (error) { if (!error.code) error.code = 'UI_CONDITION_TIMEOUT'; throw error; }
  }
  async function check(id, work) {
    const entry = { id, status: 'running' }; run.manifest.checks.push(entry);
    const start = performance.now();
    try { signal.throwIfAborted(); entry.metrics = await work(); signal.throwIfAborted(); entry.status = 'passed'; }
    catch (error) { entry.status = error instanceof BlockedError ? 'blocked' : 'failed'; entry.error = safeFailure(error); throw error; }
    finally { entry.webDriverWallMs = performance.now() - start; await run.save(); }
  }
  await check('fresh-profile-no-repository', async () => { const state = await observe(); assertRepositoryUiHealth(state); if (!state.shellPresent || state.repoOpen || !state.idle) throw problem('FRESH_PROFILE_NOT_EMPTY', true); return { empty: true, profileVerified: run.manifest.profileVerified === true }; });
  await check('open-by-path-real-ui', async () => {
    await wd.click('button[data-action="repository-options"]');
    await wait('repository menu', state => state.menuVisible);
    await wd.click('[role="menuitem"][data-action="open-repository-by-path"]');
    await wait('repository path form', state => state.pathFormVisible);
    await wd.fill('dialog[open] input[name="path"]', repository);
    const sequence = (await observe()).sequence;
    await wd.click('dialog[open] button[data-action="confirm-open-repository"]');
    const state = await wait('actual repository metadata and history', value => value.repositoryMatches && value.headMatches && value.idle && value.sequence > sequence && value.historyRows > 0 && !value.historyBusy && !value.loadingVisible && value.statusPresent && value.workingStateKnown && value.statusHistoryReady && !value.statusStale);
    if (state.historyGridRows > 302) throw problem('INITIAL_HISTORY_BOUND_EXCEEDED', true);
    return { repositoryMatchesCli: true, headMatchesCli: true, untrustedVisible: true, historyRows: state.historyRows, historyGridRows: state.historyGridRows, workingStatusSettled: true, errorCount: state.errorCount };
  });
  await check('first-sample-from-loaded-history', async () => {
    if (!(await observe()).filterLoaded) throw problem('FILTER_LOADED_REQUIRED', true);
    await wd.click('select[aria-label="Search field"]');
    await wd.select('select[aria-label="Search field"]', 'hash');
    await wd.fill(SEARCH, sample.oid);
    const state = await wait('first sampled commit in loaded history', value => value.filterLoaded && value.hashFilter && value.targetRowPresent && value.targetRowMatches && value.targetHashTextOnly && !value.historyBusy, 60000);
    // Only this text-only cell is clicked. Never click messages/ref badges.
    await wd.click(`[id="commit-${sample.oid}"] .hash-cell`);
    const detail = await wait('actual sampled commit file list', value => value.historyDocuments && value.graphVisible && value.detailsVisible && value.detailMatches && value.filesReady && !value.embeddedDiffPresent && !value.documentMatches && !value.loadingVisible, 90000, true);
    return { sampleIndex: 0, loadedHistoryOnly: state.filterLoaded, detailMatchesSample: true, metadataAndFilesOnly: true, embeddedDiffPresent: detail.embeddedDiffPresent, fileRows: detail.fileRows };
  });
  await check('canonical-sampled-file-and-diff', async () => {
    // v3 selects metadata/files only. An explicit canonical file click opens
    // HistoryDocuments; neither a first-file assumption nor hidden diff counts.
    await wd.fill(FILE_FILTER, sample.files[0]);
    await wait('canonical sampled file row', state => state.graphVisible && state.detailMatches && state.matchingFileRows === 1, 60000);
    const file = await wd.script(FIND_SAMPLE_FILE, [sample.files[0]]);
    if (!file?.[ELEMENT]) throw problem('SAMPLED_FILE_ROW_UNAVAILABLE', true);
    await wd.clickElement(file[ELEMENT]);
    const state = await wait('real selected canonical file diff', value => value.historyDocuments && value.documentMatches && !value.graphVisible && value.selectedFileMatches && value.contentMode === 'diff' && value.patchReady && value.changeCount > 0 && value.changedRows > 0 && !value.loadingVisible, 90000, true);
    return { sampleIndex: 0, fileIndex: 0, canonicalPathMatchesSample: true, selectedFileMatches: true, activeTabMatchesSample: true, patchPaintOpportunity: true, changeCount: state.changeCount, changedRows: state.changedRows, diffKind: state.diffKind, diffRows: state.diffRows, fileRows: state.fileRows, errorCount: state.errorCount };
  });
  await check('final-no-hidden-fast-status-error', async () => {
    const state = await wait('final settled repository and diff', value => value.repositoryMatches && value.headMatches && value.idle && value.workingStateKnown && value.statusHistoryReady && !value.statusStale && value.documentMatches && !value.graphVisible && value.selectedFileMatches && value.patchReady && value.changeCount > 0 && value.changedRows > 0 && !value.loadingVisible, 90000, true);
    return { errors: state.errorCount, statusWorkingError: state.statusWorkingError, statusHistoryError: state.statusHistoryError, untrustedVisible: state.untrustedVisible, activeTabMatchesSample: state.documentMatches, patchPaintOpportunity: true, changedRows: state.changedRows };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseRepositoryReadonlyArgs(argv);
  if (options.help) { console.log(HELP); return 0; }
  if (process.platform !== 'win32') throw problem('WINDOWS_DESKTOP_REQUIRED', true);
  await validateInputs(options);
  const run = await createPerformanceRun(options.output, options.repository, 'native', 3);
  const owned = privateOwnedProcesses(run), controller = new AbortController();
  const interrupt = () => controller.abort(problem('RUN_INTERRUPTED', true));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let before, wd, timer; const teardownErrors = [];
  Object.assign(run.manifest, { kind: 'repository-readonly', publicEligible: false, checks: [], scope: SCOPE, sampleSelection: { requested: 3, exercised: 1, privateIdentitiesPersisted: false }, timingPolicy: 'Smoke-test WebDriver wall clock only, including automation overhead; not native/GPU timings, a deep benchmark or cold-cache claim.' });
  try {
    run.gitBinary = gitExecutable(options.git);
    run.manifest.binary = await fingerprint(options.binary);
    before = await repositoryDigest(run, options.repository, undefined, controller.signal);
    await json(join(run.output, 'repository-before-digest.json'), before.digest);
    // Digest cost is outside the finite desktop/selection smoke budget.
    timer = setTimeout(() => controller.abort(problem('SMOKE_BUDGET_EXCEEDED', true)), 180000);
    const identity = await readOnlyGit(run, options.repository, ['rev-parse', '--path-format=absolute', '--show-toplevel'], { signal: controller.signal, maxBytes: 16384 });
    const headResult = await readOnlyGit(run, options.repository, ['rev-parse', '--verify', 'HEAD'], { signal: controller.signal, maxBytes: 1024 });
    const repository = identity.stdout.toString('utf8').trim(), head = headResult.stdout.toString('ascii').trim();
    if (!samePath(repository, options.repository) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw problem('CLI_REPOSITORY_IDENTITY_INVALID', true);
    if (before.digest.headSha256 !== sha256(headResult.stdout)) throw problem('CONCURRENT_HEAD_CHANGE', true);
    const samples = await chooseCommitSamples(run, options.repository, 3, controller.signal);
    const plan = validateSamplePlan({ schemaVersion: 1, repositoryIdentitySha256: sha256(options.repository), privacy: 'private-local-only-do-not-export', samples }, options.repository, 3);
    run.manifest.sampleSelection.selected = plan.samples.length;
    await run.save();
    wd = await startPerformanceDesktop(run, options, owned, controller.signal);
    await exerciseUi(run, wd, repository, head, plan.samples[0], controller.signal);
    run.manifest.status = 'passed';
  } catch (error) { run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = safeFailure(error); }
  finally {
    clearTimeout(timer); wd ??= run.webDriver;
    try {
      if (options.screenshot && wd?.sessionId) {
        try {
          const image = await wd.call('GET', `${wd.prefix}/screenshot`, undefined, 15000);
          if (typeof image !== 'string' || image.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) throw problem('SCREENSHOT_BOUND_INVALID');
          await writeFile(join(run.output, 'evidence', 'repository-private.png'), Buffer.from(image, 'base64'), { flag: 'wx', mode: 0o600 });
          run.manifest.evidence.push({ screenshot: 'evidence/repository-private.png', private: true, publicEligible: false });
        } catch (error) { run.manifest.status = 'failed'; run.manifest.evidenceError = safeFailure(error); }
      }
      if (owned.roots.length) try { await owned.snapshot(); } catch (error) { teardownErrors.push(safeFailure(error)); }
      if (wd?.sessionId) try { await wd.call('DELETE', wd.prefix, undefined, 15000); if (run.manifest.session) run.manifest.session.closedAt = new Date().toISOString(); } catch (error) { teardownErrors.push(safeFailure(error)); }
      try { run.manifest.cleanup = cleanupCounts(await owned.cleanup()); } catch (error) { teardownErrors.push(safeFailure(error)); run.manifest.cleanup = cleanupCounts(null); }
      run.manifest.cleanup.teardownErrors = teardownErrors.length;
      const teardownFailed = run.manifest.cleanup.status !== 'verified-zero' || teardownErrors.length > 0;
      if (teardownFailed) run.manifest.status = 'failed';
      if (before) {
        try {
          const after = await repositoryDigest(run, options.repository, before.plan, AbortSignal.timeout(120000));
          await json(join(run.output, 'repository-after-digest.json'), after.digest);
          run.manifest.repoIntegrity = compareRepositoryDigests(before.digest, after.digest);
          if (run.manifest.repoIntegrity.changed.length && !teardownFailed) run.manifest.status = 'blocked';
        } catch (error) { run.manifest.repoIntegrity = { status: 'blocked', restored: false, error: safeFailure(error) }; if (!teardownFailed) run.manifest.status = 'blocked'; }
      } else run.manifest.repoIntegrity = { status: 'not-captured', restored: false };
      try {
        // Only this run's own fresh profile is read, never the user's profile.
        const state = await readJson(join(run.profileDirectory, 'state.json'));
        if (!Array.isArray(state.trusted) || state.trusted.length) throw problem('OWNED_PROFILE_TRUST_CHANGED');
        run.manifest.trustUnchanged = true;
      } catch (error) { run.manifest.trustUnchanged = false; run.manifest.trustError = safeFailure(error); run.manifest.status = 'failed'; }
      if (controller.signal.aborted && run.manifest.status === 'passed') { run.manifest.status = 'blocked'; run.manifest.error = safeFailure(controller.signal.reason); }
      run.manifest.finishedAt = new Date().toISOString();
      await run.save();
      await json(join(run.output, 'test-report.json'), {
        schemaVersion: 1, kind: 'repository-readonly', status: run.manifest.status, publicEligible: false,
        startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt,
        actualBinary: run.manifest.binary ? { sha256: run.manifest.binary.sha256, bytes: run.manifest.binary.bytes } : null,
        checks: run.manifest.checks, sampleSelection: run.manifest.sampleSelection, repoIntegrity: run.manifest.repoIntegrity,
        cleanup: run.manifest.cleanup, trustUnchanged: run.manifest.trustUnchanged, scope: SCOPE,
        timingPolicy: run.manifest.timingPolicy, environmentPolicy: run.manifest.environmentPolicy,
        privacy: { localOnly: true, publicEligible: false, rawDom: false, sourceContents: false, rawErrors: false, rawDriverPayloads: false, rawGitOutput: false, sampleIdentities: false, screenshotsPrivate: true },
        evidence: run.manifest.evidence, error: run.manifest.error ?? null, evidenceError: run.manifest.evidenceError ?? null, trustError: run.manifest.trustError ?? null,
      });
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
  console.log(JSON.stringify({ kind: 'repository-readonly', status: run.manifest.status, publicEligible: false, passedChecks: run.manifest.checks.filter(check => check.status === 'passed').length, repoIntegrity: run.manifest.repoIntegrity.status, cleanupRemaining: run.manifest.cleanup.remaining }));
  return run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
}
if (isMain(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Repository smoke blocked: invalid explicit inputs or fresh output prerequisite. No private error payload is printed. Use --help.'); process.exitCode = 2; });
