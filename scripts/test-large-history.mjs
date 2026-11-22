#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertSameSnapshot, createRun, errorInfo, fingerprint, git, gitExecutable, gitText,
  isolatedEnvironment, json, parseArgs, required, samePath, sha256, until,
} from './lib/run.mjs';
import { repositorySnapshot } from './lib/fixtures.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';

const options = parseArgs(process.argv.slice(2), { values: ['binary', 'driver', 'output', 'commits'], flags: ['help'] });
if (options.help) {
  console.log('node scripts/test-large-history.mjs --binary <app.exe> --driver <verified-msedgedriver.exe> --output <new-empty-run> [--commits 20000]\nWindows desktop acceptance only. Commits must be 1000..50000, including four branch commits and four genuine two-parent merges. Uses installed Git and tauri-driver; downloads nothing. Exit 2 = blocked prerequisite, not pass.');
  process.exit(0);
}
required(options, ['binary', 'driver', 'output']);
assert(/^\d+$/.test(options.commits ?? '20000'), '--commits must be a decimal integer.');
const commitCount = Number(options.commits ?? 20000);
assert(Number.isSafeInteger(commitCount) && commitCount >= 1000 && commitCount <= 50000, '--commits must be 1000..50000.');
options.binary = resolve(options.binary);
options.driver = resolve(options.driver);

// Only internally constructed, length-delimited bytes reach fast-import. Neither
// repository content, user input other than the bounded count, nor upstream code
// is interpreted as a fast-import command, hook, template, or executable source.
function historyBytes(count, runId) {
  assert(/^[a-f0-9-]{36}$/.test(runId));
  const chunks = []; const records = []; const merges = [];
  const simpleCount = count - 8;
  const mergeAt = new Map([Math.floor(simpleCount / 5), Math.floor(simpleCount / 2), simpleCount - 340, simpleCount - 24].map((n, i) => [n, i + 1]));
  assert.equal(mergeAt.size, 4);
  const messageNumber = Math.floor(simpleCount / 8), hashNumber = Math.floor(simpleCount / 4);
  const needle = `QGitGraph large-history unique message ${runId}`;
  const selected = {};
  const line = value => { assert(!/[\r\n\0]/.test(value), 'Invalid internal protocol line.'); chunks.push(Buffer.from(`${value}\n`, 'utf8')); };
  const data = value => {
    const bytes = Buffer.from(value, 'utf8'); assert(!bytes.includes(0));
    line(`data ${bytes.length}`); chunks.push(bytes, Buffer.from('\n'));
  };
  const ref = value => { assert(/^refs\/(heads|tags)\/[a-z0-9][a-z0-9/-]*$/.test(value) && !value.includes('//')); return value; };
  const commit = (reference, subject, parents, file, contents) => {
    assert(/^(history\.txt|branches\/branch-0[1-4]\.txt)$/.test(file));
    assert(!/[\r\n\0]/.test(subject));
    assert(parents.length <= 2 && new Set(parents).size === parents.length);
    for (const parent of parents) assert(Number.isInteger(parent) && parent > 0 && parent <= records.length);
    const mark = records.length + 1, epoch = 1700000000 + mark;
    line(`commit ${ref(reference)}`); line(`mark :${mark}`);
    line(`author QGitGraph large-history <fixture@example.invalid> ${epoch} +0000`);
    line(`committer QGitGraph large-history <fixture@example.invalid> ${epoch} +0000`);
    data(`${subject}\n`);
    if (parents.length) line(`from :${parents[0]}`);
    if (parents.length === 2) line(`merge :${parents[1]}`);
    line(`M 100644 inline ${file}`); data(contents); line('');
    records.push({ mark, subject, parents }); return mark;
  };
  let main = 0, initial = 0, midpoint = 0;
  for (let number = 1; number <= simpleCount; number++) {
    const fork = main;
    main = commit('refs/heads/main', number === messageNumber ? needle : `Large history commit ${String(number).padStart(6, '0')}`, fork ? [fork] : [], 'history.txt', `History value ${number}\n`);
    if (number === 1) initial = main;
    if (number === Math.floor(simpleCount / 2)) midpoint = main;
    if (number === messageNumber) selected.message = main;
    if (number === hashNumber) selected.hash = main;
    if (mergeAt.has(number)) {
      const branch = String(mergeAt.get(number)).padStart(2, '0');
      const reference = `refs/heads/large-history/branch-${branch}`;
      const file = `branches/branch-${branch}.txt`, contents = `Merged branch ${branch}\n`;
      const side = commit(reference, `Large history branch ${branch}`, [fork], file, contents);
      const firstParent = main;
      main = commit('refs/heads/main', `Merge large-history branch ${branch}`, [firstParent, side], file, contents);
      merges.push({ mark: main, side, fork, firstParent, reference, file, contents });
    }
  }
  assert.equal(records.length, count);
  for (const [name, mark] of [['large-history-start', initial], ['large-history-midpoint', midpoint]]) {
    line(`reset ${ref(`refs/tags/${name}`)}`); line(`from :${mark}`); line('');
  }
  line('tag large-history-annotated'); line(`from :${main}`);
  line(`tagger QGitGraph large-history <fixture@example.invalid> ${1700000001 + count} +0000`);
  // Tag records end with their data block; unlike commits/resets they have no
  // extra blank terminator. data() already emits the optional trailing LF.
  data('Local-only annotated large-history fixture.\n'); line('done');
  const bytes = Buffer.concat(chunks);
  assert(bytes.length <= 64 * 1024 * 1024, 'Internal import exceeds the bounded 64 MiB input budget.');
  return { bytes, records, merges, selected, main, simpleCount, needle };
}

async function fastImport(run, owned, repository, bytes, marks, signal) {
  const stop = new AbortController();
  const abort = () => stop.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop.abort(new Error('Bounded fast-import exceeded 180 seconds.')), 180000);
  const stdout = [], stderr = []; let captured = 0, overflow = false, inputError;
  const child = spawn(run.gitBinary, ['--no-pager', '-C', repository, 'fast-import', '--quiet', '--date-format=raw', '--done', `--export-marks=${marks}`], {
    cwd: run.output, env: run.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: stop.signal,
  });
  const finished = new Promise((resolveDone, reject) => {
    child.once('error', reject); child.once('close', (code, terminationSignal) => resolveDone({ code, terminationSignal }));
  });
  void finished.catch(() => undefined);
  for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
    captured += bytes.length;
    if (captured <= 1024 * 1024) target.push(bytes); else overflow = true;
  });
  child.stdin.on('error', error => { inputError = error; });
  try {
    signal.throwIfAborted(); assert(child.pid, 'fast-import failed to spawn.');
    // Register this exact PID/creation-time before supplying any import bytes.
    await owned.add(child.pid);
    signal.throwIfAborted(); child.stdin.end(bytes);
    const result = await finished;
    if (inputError) throw inputError;
    assert(!overflow, 'fast-import diagnostic output exceeded 1 MiB.');
    assert.equal(result.code, 0, `fast-import failed (${result.terminationSignal ?? result.code}): ${Buffer.concat(stderr).toString('utf8')}`);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    // This ChildProcess is our own still-live import, not a name/PID-wide sweep.
    if (child.exitCode === null && child.signalCode === null) { child.stdin.destroy(); child.kill(); await finished.catch(() => undefined); }
    await writeFile(join(run.output, 'fast-import.stdout.txt'), Buffer.concat(stdout), { flag: 'wx' });
    await writeFile(join(run.output, 'fast-import.stderr.txt'), Buffer.concat(stderr), { flag: 'wx' });
  }
}

async function repositorySize(directory) {
  const result = { bytes: 0, gitBytes: 0, workingTreeBytes: 0, files: 0 };
  async function visit(path, isGit = false) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Internal fixture must not contain links.');
      const file = join(path, entry.name), metadata = await lstat(file), gitFile = isGit || (path === directory && entry.name === '.git');
      if (metadata.isDirectory()) await visit(file, gitFile);
      else { assert(metadata.isFile()); result.bytes += metadata.size; result.files++; result[gitFile ? 'gitBytes' : 'workingTreeBytes'] += metadata.size; }
    }
  }
  await visit(directory); return result;
}

async function createHistory(run, owned, signal) {
  const began = performance.now(), repository = join(run.output, 'fixtures', 'large history');
  await mkdir(join(run.output, 'fixtures')); await mkdir(repository);
  run.manifest.fixture = { status: 'creating', repository, requestedCommits: commitCount };
  await run.save();
  assert.equal((await readdir(run.manifest.git.hooksDirectory)).length, 0);
  assert.equal((await readdir(run.manifest.git.templateDirectory)).length, 0);
  git(run, repository, ['init', '-b', 'main', '--object-format=sha1', `--template=${run.manifest.git.templateDirectory}`]);
  for (const [key, value] of [
    ['user.name', 'QGitGraph large-history'], ['user.email', 'fixture@example.invalid'], ['core.hooksPath', run.manifest.git.hooksDirectory],
    ['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'],
    ['credential.helper', ''], ['protocol.allow', 'never'], ['protocol.file.allow', 'never'], ['gc.auto', '0'], ['maintenance.auto', 'false'],
  ]) git(run, repository, ['config', '--local', key, value]);
  const source = historyBytes(commitCount, run.manifest.runId), marksFile = join(run.output, 'fast-import.marks');
  await writeFile(join(run.output, 'fast-import.fi'), source.bytes, { flag: 'wx' });
  run.manifest.fixture.import = { path: join(run.output, 'fast-import.fi'), bytes: source.bytes.length, sha256: sha256(source.bytes), marksFile };
  await run.save(); await fastImport(run, owned, repository, source.bytes, marksFile, signal); signal.throwIfAborted();
  git(run, repository, ['reset', '--hard', 'HEAD']);
  const marks = new Map();
  for (const line of (await readFile(marksFile, 'utf8')).trim().split('\n')) {
    const match = /^:(\d+) ([a-f0-9]{40})\r?$/.exec(line); assert(match, 'Invalid exported import mark.');
    const mark = Number(match[1]); assert(mark > 0 && mark <= commitCount && !marks.has(mark)); marks.set(mark, match[2]);
  }
  assert.equal(marks.size, commitCount); assert.equal(new Set(marks.values()).size, commitCount);
  const all = gitText(run, repository, ['rev-list', '--date-order', '--all']).split(/\r?\n/);
  assert.equal(all.length, commitCount); assert.equal(new Set(all).size, commitCount);
  assert.deepEqual([...all].sort(), [...marks.values()].sort(), 'All imported commits must be reachable, without extra commits.');
  const head = marks.get(source.main); assert.equal(gitText(run, repository, ['rev-parse', 'HEAD']), head);
  const mergeOids = source.merges.map(merge => marks.get(merge.mark));
  assert.deepEqual(gitText(run, repository, ['rev-list', '--min-parents=2', '--all']).split(/\r?\n/).sort(), [...mergeOids].sort());
  const merges = [];
  for (const merge of source.merges) {
    const oid = marks.get(merge.mark), parents = [marks.get(merge.firstParent), marks.get(merge.side)];
    assert.deepEqual(gitText(run, repository, ['rev-list', '--parents', '-n', '1', oid]).split(' '), [oid, ...parents]);
    assert.equal(gitText(run, repository, ['merge-base', ...parents]), marks.get(merge.fork), 'Merge parents must genuinely diverge from their fork.');
    assert.equal(gitText(run, repository, ['rev-parse', merge.reference]), parents[1]);
    assert.equal(gitText(run, repository, ['show', `${head}:${merge.file}`]), merge.contents.trim());
    merges.push({ oid, parents, fork: marks.get(merge.fork), reference: merge.reference, side: parents[1] });
  }
  const expectedRefs = ['refs/heads/main', ...merges.map(item => item.reference), 'refs/tags/large-history-start', 'refs/tags/large-history-midpoint', 'refs/tags/large-history-annotated'];
  assert.deepEqual(gitText(run, repository, ['for-each-ref', '--format=%(refname)']).split(/\r?\n/).sort(), expectedRefs.sort());
  assert.equal(gitText(run, repository, ['cat-file', '-t', 'refs/tags/large-history-annotated']), 'tag');
  assert.equal(gitText(run, repository, ['rev-parse', 'refs/tags/large-history-annotated^{}']), head);
  assert.equal(gitText(run, repository, ['remote']), '', 'Fixture must not have a network or local remote.');
  git(run, repository, ['fsck', '--full', '--strict', '--no-reflogs']);
  const subjects = new Map(source.records.map(record => [marks.get(record.mark), record.subject]));
  const targets = Object.fromEntries(Object.entries(source.selected).map(([kind, mark]) => {
    const oid = marks.get(mark), index = all.indexOf(oid); assert(index >= 500, 'Search target must be beyond every tested loaded page.');
    return [kind, { oid, subject: subjects.get(oid), historyIndex: index }];
  }));
  const before = await repositorySnapshot(run, repository);
  before.localConfig = await fingerprint(join(before.identity.gitDir, 'config'));
  assert.equal(before.head, head); assert.equal(before.status, ''); assert.equal(before.tracked.length, 5); assert.equal(before.untracked.length, 0);
  await json(join(run.output, 'repository-before.json'), before);
  const fixture = {
    ...run.manifest.fixture, status: 'ready', repository: before.identity.path, head, totalCommits: all.length,
    mainlineSimpleCommits: source.simpleCount, branchCommits: 4, mergeCommits: 4, refCount: expectedRefs.length,
    merges, targets, expectedPages: all.slice(0, 500).map(oid => ({ oid, subject: subjects.get(oid) })),
    size: await repositorySize(repository), creationWallMs: performance.now() - began,
    creationTimingDefinition: 'Local fixture construction, fast-import, materialization and validation wall time; not a Git-only performance measurement.',
    countDefinition: '--commits is the total, including four divergent branch commits and four two-parent merges; remaining commits are simple mainline edits.',
    validation: ['internal length-delimited bytes', 'complete exported marks', 'all commits reachable', 'four genuinely divergent merges', 'exact refs', 'merged file contents', 'annotated tag', 'no remotes', 'git fsck --full --strict', 'clean complete repository snapshot'],
  };
  run.manifest.fixture = fixture; await json(join(run.output, 'fixture-manifest.json'), fixture); await run.save();
  return { ...fixture, before };
}

// Source-backed DOM only: no injected host calls, private App state, sample data,
// fixed-sleep readiness, fake tasks, or wrappers that artificially slow Git.
async function readUI(wd) {
  return wd.script(`
    const shell=document.querySelector('.app-shell'); if(!shell) return null;
    const grid=document.querySelector('.history-pane[role="grid"]'), viewport=document.querySelector('.table-scroll');
    const load=document.querySelector('button[data-action="load-more"]');
    return {repoPath:shell.dataset.repoPath,repoHead:shell.dataset.repoHead,configDirectory:shell.dataset.configDirectory,
      taskState:shell.dataset.taskState,taskSequence:shell.dataset.taskSequence,
      errors:[...document.querySelectorAll('.errorbar:not([hidden]),dialog[open] .form-error:not([hidden])')].map(e=>e.innerText),
      footer:document.querySelector('.history-count')?.textContent, rowCount:Number(grid?.getAttribute('aria-rowcount')),
      busy:grid?.getAttribute('aria-busy'), viewportHeight:viewport?.clientHeight,scrollTop:viewport?.scrollTop,
      rowHeight:grid?Number.parseFloat(getComputedStyle(grid).getPropertyValue('--row-height')):null,
      rows:[...document.querySelectorAll('.commit-row')].map(e=>({oid:e.dataset.oid,index:Number(e.getAttribute('aria-rowindex'))-2,
        subject:e.querySelector('.commit-subject')?.textContent,kind:e.querySelector('.graph-cell')?.getAttribute('aria-label'),
        refs:[...e.querySelectorAll('[data-ref]')].map(r=>r.dataset.ref)})),
      loadMore:load?{hidden:load.hidden,disabled:load.disabled,visible:!!load.getClientRects().length}:null,
      query:document.querySelector('input[aria-label="Search commits"]')?.value,
      scope:document.querySelector('select[aria-label="Search scope"]')?.value,
      field:document.querySelector('select[aria-label="Search field"]')?.value,
      order:document.querySelector('select[aria-label="History ordering"]')?.value,
      overlay:document.querySelector('.history-overlay')?.textContent};
  `);
}
function counts(ui) {
  const match = /^([0-9.,\s]+) shown(?: \/ ([0-9.,\s]+) loaded)?( · more available)?$/.exec(ui.footer ?? '');
  if (!match) return null;
  const shown = Number(match[1].replace(/\D/g, '')), loaded = match[2] ? Number(match[2].replace(/\D/g, '')) : shown;
  return { shown, loaded, more: Boolean(match[3]) };
}
function assertIdentity(run, fixture, ui) {
  assert(samePath(ui.configDirectory, run.profileDirectory), `Wrong isolated profile: ${ui.configDirectory}`);
  assert(samePath(ui.repoPath, fixture.repository), `Wrong repository: ${ui.repoPath}`);
  assert.equal(ui.repoHead, fixture.head, 'UI HEAD differs from the actual fixture HEAD.');
}
function assertRows(ui, expected) {
  for (const row of ui.rows) {
    assert(Number.isInteger(row.index) && row.index >= 0 && row.index < expected.length, 'Unexpected virtual row index.');
    assert.equal(row.oid, expected[row.index].oid, `Wrong commit at virtual row ${row.index}.`);
    assert.equal(row.subject, expected[row.index].subject, `Wrong message at virtual row ${row.index}.`);
  }
}

const run = await createRun(resolve(options.output), 'large-history');
const owned = new OwnedProcesses(run), controller = new AbortController(), cleanupErrors = [];
let fixture, wd, monitor, failure;
const onSignal = signal => { const error = new Error(`${signal}: interrupted`); failure ??= error; controller.abort(error); };
const sigint = () => onSignal('SIGINT'), sigterm = () => onSignal('SIGTERM');
process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
run.manifest.requestedCommits = commitCount;
run.manifest.countsLoaded = { first: null, paging: [], messageSearch: null, hashSearch: null, restored: null };
run.manifest.timings = {};
run.manifest.limitations = [
  'One bounded synthetic local history, one run and supplied binary; not an upstream repository, cold-start, production-scale or pure-Git benchmark.',
  'UI timings include WebDriver round trips, DOM/task polling and rendering. Fixture creation and evidence collection are not reported as Git throughput.',
  'Loaded counts come from the footer and accessible grid, not the number of virtualized DOM rows. Page boundaries and rendered immutable OIDs/messages are independently checked against Git.',
  'Only local Git and loopback WebDriver are used; no clone, fetch, push, remote, package installation or download. This is not an OS-level network-isolation audit.',
];
run.manifest.results.push({
  label: 'optional history cancellation through actual task controls', status: 'optionalblocked', required: false,
  reason: 'Source exposes .querybar button[title="Cancel loading"] only while a history request is in flight. Bounded local queries can finish between WebDriver observation and a real click, and cancelLoading marks the DOM idle immediately without exposing native-process cancellation acknowledgement. A repeatable UI-only pending/cancelled gate is unavailable. No fake delay, injected host cancellation or claim of successful cancellation is used.',
});
const guard = () => { controller.signal.throwIfAborted(); monitor?.check(); };
async function waitUI(label, predicate, afterSequence) {
  return until(label, async () => {
    guard(); const ui = await readUI(wd); if (!ui) return false;
    if (!['idle', 'running', 'created', 'loading'].includes(ui.taskState) || !Number.isFinite(Number(ui.taskSequence))) throw new BlockedError('Required task-state/task-sequence diagnostics are unavailable.');
    if (ui.errors.length) throw new Error(`Actual UI errors: ${ui.errors.join('\n')}`);
    if (ui.taskState !== 'idle' || (afterSequence !== undefined && Number(ui.taskSequence) <= Number(afterSequence))) return false;
    assertIdentity(run, fixture, ui);
    return predicate(ui) ? ui : false;
  }, { timeout: 60000, signal: controller.signal });
}
async function page(label, expected, more, afterSequence) {
  const ui = await waitUI(label, ui => {
    const count = counts(ui);
    return count?.shown === expected.length && count.loaded === expected.length && count.more === more && ui.rowCount === expected.length + 1
      && ui.busy === 'false' && ui.viewportHeight > 0 && ui.rows.length > 0 && ui.rows.some(row => row.oid === expected[0].oid);
  }, afterSequence);
  assertRows(ui, expected);
  assert(ui.loadMore && ui.loadMore.hidden === !more && ui.loadMore.visible === more && !ui.loadMore.disabled);
  return ui;
}
async function scrollToIndex(index, expected) {
  await wd.script('const v=document.querySelector(".table-scroll"),g=document.querySelector(".history-pane");const h=Number.parseFloat(getComputedStyle(g).getPropertyValue("--row-height"));if(!v||!(h>0))throw new Error("Missing actual history viewport/row height");v.scrollTop=arguments[0]*h;', [index]);
  const ui = await waitUI(`virtual row ${index} rendered`, ui => ui.rows.some(row => row.oid === expected[index].oid));
  assertRows(ui, expected); return ui;
}
async function step(label, definition, work) {
  guard(); const result = { label, status: 'running', startedAt: new Date().toISOString() };
  run.manifest.results.push(result); await run.save(); const clock = performance.now();
  try { result.observed = await work(); result.status = 'passed'; guard(); return result.observed; }
  catch (error) { result.status = error instanceof BlockedError ? 'blocked' : 'failed'; result.error = errorInfo(error); throw error; }
  finally {
    result.durationMs = performance.now() - clock;
    run.manifest.timings[label] = { milliseconds: result.durationMs, status: result.status, definition };
    await run.save();
  }
}

try {
  if (process.platform !== 'win32') throw new BlockedError('Requires a real Windows desktop and the supplied application; no browser/demo fallback.');
  run.env = { ...isolatedEnvironment(run.manifest.git), GIT_ALLOW_PROTOCOL: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never' };
  run.gitBinary = gitExecutable(); run.manifest.git.executable = run.gitBinary;
  run.manifest.binary = await fingerprint(options.binary);
  await fingerprint(options.driver); await run.save();
  fixture = await createHistory(run, owned, controller.signal);
  run.manifest.git.version = gitText(run, fixture.repository, ['--version']);
  // A fresh, untrusted profile. Only make paging deterministic, prohibit avatar
  // requests, and pin the same Git used to build/verify the local fixture.
  run.manifest.profileOverrides = { gitPath: run.gitBinary, autoLoad: false, avatars: false, showUncommitted: false };
  await json(join(run.profileDirectory, 'state.json'), {
    version: 2, recent: [], lastRepo: null, trusted: [], settings: run.manifest.profileOverrides,
    repoSettings: {}, reviews: [], layout: { detailSize: 360, fileSize: 260 }, views: {},
  });
  guard(); monitor = monitorOwnedProcesses(owned);
  const binaryBefore = run.manifest.binary;
  const startupClock = performance.now(); wd = await startDesktop(run, options, owned);
  run.manifest.timings.desktopStartup = { milliseconds: performance.now() - startupClock, status: 'passed', definition: 'startDesktop through verified isolated profile and initialized idle DOM; includes driver verification, owned listener/session setup and driver round trips, not pure application/Git startup.' };
  assert.deepEqual(run.manifest.binary, binaryBefore, 'Binary changed while the fixture was being prepared.'); guard();
  await wd.click('button[data-action="repository-options"]');
  await wd.click('[role="menuitem"][data-action="open-repository-by-path"]');
  await wd.wait('actual open-repository dialog', 'return [...document.querySelectorAll("dialog[open] h2")].some(e=>e.textContent.trim()==="Open repository");');
  await wd.fill('dialog[open] input[name="path"]', fixture.repository);
  const opening = await wd.state();
  await step('first300', 'WebDriver confirm-open click to advanced task sequence, idle DOM, exact profile/repository/HEAD, 300 shown/loaded and first commit rendered. Driver and DOM overhead included; excludes fixture creation and screenshots.', async () => {
    await wd.click('dialog[open] button[data-action="confirm-open-repository"]');
    const ui = await page('actual first 300 commits', fixture.expectedPages.slice(0, 300), true, opening.taskSequence);
    assert.equal(ui.scope, 'filter'); assert.equal(ui.query, ''); assert.equal(ui.order, 'date');
    assert(ui.rows.find(row => row.oid === fixture.head)?.refs.includes('refs/tags/large-history-annotated'));
    run.manifest.countsLoaded.first = counts(ui).loaded;
    return { counts: counts(ui), renderedRows: ui.rows.length, head: ui.repoHead, taskSequence: ui.taskSequence };
  });
  await archiveDesktop(run, wd, 'first300');
  const latestMerge = fixture.merges.at(-1), mergeIndex = fixture.expectedPages.findIndex(item => item.oid === latestMerge.oid);
  assert(mergeIndex >= 0 && mergeIndex < 300);
  const mergedUI = await scrollToIndex(mergeIndex, fixture.expectedPages.slice(0, 300));
  assert.equal(mergedUI.rows.find(row => row.oid === latestMerge.oid)?.kind, 'Merge commit');
  assert(mergedUI.rows.some(row => row.oid === latestMerge.side && row.refs.includes(latestMerge.reference)), 'Actual branch ref badge must be attached to its real side commit.');
  run.manifest.results.push({ label: 'real merge topology and branch/tag badges in desktop', status: 'passed', observed: { merge: latestMerge.oid, branch: latestMerge.reference } });
  await scrollToIndex(299, fixture.expectedPages.slice(0, 300));
  for (const loaded of [400, 500]) {
    await wd.script('document.querySelector(".table-scroll").scrollTop=0;');
    const before = await waitUI('ready for explicit next page', ui => ui.rows.some(row => row.oid === fixture.head));
    await step(`loadMore${loaded}`, 'WebDriver Load more commits click to advanced task sequence, idle DOM, exactly 100 additional commits, and verified last-page OID/message rendered by scrolling the actual virtual grid. Includes driver, polling, rendering and scroll overhead.', async () => {
      await wd.click('button[data-action="load-more"]');
      const expected = fixture.expectedPages.slice(0, loaded), ui = await page(`actual ${loaded} loaded`, expected, true, before.taskSequence);
      const tail = await scrollToIndex(loaded - 1, expected);
      assert.deepEqual(counts(tail), counts(ui)); assert.equal(tail.rowCount, loaded + 1);
      run.manifest.countsLoaded.paging.push(counts(tail).loaded);
      return { counts: counts(tail), increment: loaded - Number(counts(before).loaded), lastOid: expected.at(-1).oid, renderedRows: tail.rows.length };
    });
    assert.equal(run.manifest.results.at(-1).observed.increment, 100);
    await archiveDesktop(run, wd, `loaded${loaded}`);
  }
  // Stage both queries in Filter loaded: entering text cannot start a debounced
  // Git search. Switching the real Search scope control is the measured trigger.
  async function stageQuery(kind) {
    const before = await wd.state();
    const currentScope = await wd.script('return document.querySelector(arguments[0]).value;', ['select[aria-label="Search scope"]']);
    if (currentScope !== 'filter') {
      await wd.select('select[aria-label="Search scope"]', 'filter');
      await waitUI('return to loaded-filter mode', ui => ui.scope === 'filter' && counts(ui)?.loaded === 300, before.taskSequence);
    }
    await wd.select('select[aria-label="Search field"]', kind);
    const target = fixture.targets[kind], query = kind === 'message' ? target.subject : target.oid;
    await wd.fill('input[aria-label="Search commits"]', query);
    const miss = await waitUI(`${kind} is absent from loaded pages`, ui => ui.scope === 'filter' && ui.field === kind && ui.query === query && counts(ui)?.shown === 0 && counts(ui)?.loaded >= 300 && ui.rowCount === 1 && ui.rows.length === 0);
    assert(miss.overlay.includes('No commits match the loaded-page filters'));
    return { target, query, miss };
  }
  for (const kind of ['message', 'hash']) {
    const { target, query, miss } = await stageQuery(kind);
    run.manifest.results.push({ label: `${kind} negative control: not in loaded pages`, status: 'passed', observed: { query, historyIndex: target.historyIndex, counts: counts(miss) } });
    await archiveDesktop(run, wd, `${kind}-loaded-filter-miss`);
    await step(`${kind}Search`, 'WebDriver Search scope option click (Filter loaded -> Search history), with the known query already staged, to advanced task sequence, idle DOM and one exact known OID/message. Includes Git-backed application work, WebDriver, polling and DOM rendering; not pure Git time.', async () => {
      await wd.select('select[aria-label="Search scope"]', 'search');
      const ui = await page(`actual entire-history ${kind} search`, [target], false, miss.taskSequence);
      assert.equal(ui.scope, 'search'); assert.equal(ui.field, kind); assert.equal(ui.query, query);
      run.manifest.countsLoaded[`${kind}Search`] = counts(ui).loaded;
      return { counts: counts(ui), query, oid: target.oid, subject: target.subject, outsideLoadedPages: true, historyIndex: target.historyIndex };
    });
    await archiveDesktop(run, wd, `${kind}-history-search`);
  }
  const restore = await wd.state();
  await wd.select('select[aria-label="Search scope"]', 'filter');
  await waitUI('restore unsearched history request', ui => ui.scope === 'filter' && counts(ui)?.loaded === 300, restore.taskSequence);
  await wd.fill('input[aria-label="Search commits"]', '');
  const restored = await page('history usable after searches', fixture.expectedPages.slice(0, 300), true);
  run.manifest.countsLoaded.restored = counts(restored).loaded;
  guard(); run.manifest.status = 'passed';
} catch (error) {
  failure ??= error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = errorInfo(error);
  if (run.manifest.fixture?.status === 'creating') run.manifest.fixture.status = 'failed';
} finally {
  if (monitor) try { await monitor.stop(); } catch (error) { cleanupErrors.push({ phase: 'ownership-monitor', ...errorInfo(error) }); }
  wd ??= run.webDriver;
  try { await archiveDesktop(run, wd, failure ? 'failure' : 'final'); }
  catch (error) { cleanupErrors.push({ phase: 'archive', ...errorInfo(error) }); }
  try { await owned.snapshot(); } catch (error) { cleanupErrors.push({ phase: 'ownership-before-close', ...errorInfo(error) }); }
  if (wd?.sessionId) {
    try { await wd.call('DELETE', wd.prefix, undefined, 30000); if (run.manifest.session) run.manifest.session.closedAt = new Date().toISOString(); }
    catch (error) { cleanupErrors.push({ phase: 'webdriver-session-delete', ...errorInfo(error) }); }
  }
  try {
    const cleanup = await owned.cleanup(); run.manifest.cleanup = { ...cleanup, errors: [...(cleanup.errors ?? []), ...cleanupErrors] };
    assert.equal(cleanup.remaining?.length ?? 0, 0, 'Run-owned processes remain.');
    assert.equal(cleanup.errors?.length ?? 0, 0, 'Owned-process cleanup errors.');
    assert.equal(cleanupErrors.length, 0, 'Evidence/ownership/session cleanup errors.');
  } catch (error) {
    failure ??= error; run.manifest.status = 'failed'; run.manifest.cleanup ??= { errors: cleanupErrors }; run.manifest.cleanup.failure = errorInfo(error);
  }
  // Compare the complete repository after desktop/session/process shutdown too,
  // not merely selected target commits or a still-running application's view.
  if (fixture) {
    try {
      const after = await repositorySnapshot(run, fixture.repository);
      after.localConfig = await fingerprint(join(after.identity.gitDir, 'config'));
      await json(join(run.output, 'repository-after.json'), after);
      assertSameSnapshot(fixture.before, after, 'entire large-history fixture');
      assert.deepEqual(after.localConfig, fixture.before.localConfig, 'Repository-local config changed.');
      run.manifest.repositoryIntegrity = { status: 'passed', checkedAfterOwnedCleanup: true, repository: fixture.repository, checked: ['path/git-dir identity', 'HEAD', 'HEAD-file bytes', 'index SHA-256', 'porcelain-v2 NUL status', 'all tracked paths/modes/OIDs/working bytes', 'all untracked bytes', 'all refs/object types', 'repository-local config bytes'] };
    } catch (error) {
      failure ??= error; run.manifest.status = 'failed'; run.manifest.repositoryIntegrity = { status: 'failed', ...errorInfo(error) };
    }
  } else run.manifest.repositoryIntegrity = { status: 'unavailable', reason: 'Fixture construction/validation did not finish; no before/after integrity pass is claimed.' };
  const requiredChecks = ['first300', 'loadMore400', 'loadMore500', 'messageSearch', 'hashSearch'];
  for (const label of requiredChecks) if (!run.manifest.results.some(result => result.label === label)) run.manifest.results.push({ label, status: 'unavailable', required: true, reason: 'Not reached because a preceding prerequisite/check failed or the run was interrupted.' });
  if (failure && run.manifest.status === 'running') run.manifest.status = 'failed';
  run.manifest.finishedAt = new Date().toISOString();
  if (failure && !run.manifest.error) run.manifest.error = errorInfo(failure);
  try { await run.save(); await json(join(run.output, 'test-report.json'), run.manifest); }
  finally { process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm); }
}
console.log(JSON.stringify({ kind: 'large-history', status: run.manifest.status, binarySha256: run.manifest.binary?.sha256, countsLoaded: run.manifest.countsLoaded, report: join(run.output, 'test-report.json'), error: failure?.message }, null, 2));
process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
