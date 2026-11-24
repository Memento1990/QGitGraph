#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, rename, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PROJECT, assertSameSnapshot, createRun, errorInfo, fingerprint, git, gitExecutable, inside, isMain, json, parseArgs, powershell, readJson, required, samePath, sha256, until } from './lib/run.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';
import { repositorySnapshot } from './lib/fixtures.mjs';

export const RUN_BUDGET_MS = 600_000;
export const ROOT_KINDS = Object.freeze(['directory-root', 'submodules-root', 'tags-root', 'stashes-root']);
export const SUITES = Object.freeze(['smoke', 'actions', 'full']);
// Full retains an independent fixed release contract, including controlled
// negative scenarios. Narrow diagnostics never remove labels from this list.
export const PENDING_FULL_SCENARIOS = Object.freeze([]);
export const REQUIRED_LABELS = Object.freeze({
  smoke: Object.freeze(['actual-native-startup-and-profile-gate', 'vue-native-boot-isolated-profile', 'native-usage-explicit-automated-source', 'repository-open-dialog-real-path-and-read-only', 'trust-dialog-explicit-repository-confirmation', 'history-commit-parent-diff-old-new-unified-split', 'local-staged-unstaged-path-identity-and-draft', 'directory-four-root-current-repository-navigation', 'settings-deep-global-repository-language-theme-state', 'sidebar-real-separator-keyboard-and-collapse', 'native-titlebar-actual-maximize-restore-minimize', 'native-profile-reopen-restores-settings-trust-sidebar', 'native-titlebar-close-actual-window-exit']),
  actions: Object.freeze(['stage-unstage-exact-file-and-group-review-cancel', 'commit-expected-index-only-not-unstaged-or-untracked', 'sync-real-local-bare-pull-merge-push']),
  full: Object.freeze(['binary-diff-explicit-no-text', 'repository-open-error-explicit-and-cancel-no-write', 'in-flight-diff-cancel-observed-not-inferred', 'native-review-only-successfully-loaded-files', 'native-sync-conflict-no-push', 'native-sync-push-error-no-false-success', 'native-sync-inflight-cancel-no-push', 'native-diff-read-error-and-retry', 'native-working-stale-expected-index-rejection', 'native-gitlink-snapshot-rejection', ...PENDING_FULL_SCENARIOS]),
});
export const FULL_REQUIRED_SCENARIOS = Object.freeze([...REQUIRED_LABELS.smoke, ...REQUIRED_LABELS.actions, ...REQUIRED_LABELS.full]);
export function requiredLabels(suite) { assert(SUITES.includes(suite)); return [...REQUIRED_LABELS.smoke, ...(suite !== 'smoke' ? REQUIRED_LABELS.actions : []), ...(suite === 'full' ? REQUIRED_LABELS.full : [])]; }
export function coverageFor(suite, results, { assisted = false } = {}) {
  const required = requiredLabels(suite), grouped = new Map();
  for (const result of results) { const values = grouped.get(result.label) ?? []; values.push(result); grouped.set(result.label, values); }
  const missing = required.filter(label => !grouped.has(label));
  const blocked = required.filter(label => grouped.get(label)?.some(result => result.status === 'blocked'));
  if (assisted) blocked.push('default-local-preview-layout-without-assisted-resize');
  const failed = required.filter(label => grouped.get(label)?.some(result => result.status === 'failed'));
  const duplicates = [...grouped].filter(([, values]) => values.length !== 1).map(([label]) => label);
  return { required, missing, blocked, failed, duplicates };
}
export const SCOPE = 'Actual supplied Windows Vue binary only, never a browser/demo/prototype. No repository argument is accepted. Only new run-owned fixtures, profile, HOME, WebView2 and local bare remotes. Harness Git writes finish before sealing except three explicitly ledgered fault cases in one dedicated run-owned repository: a literal-path update-index --cacheinfo replacement with pre-created blob OIDs and unchanged path/XY status, a temporarily quarantined loose blob with SHA/identity-checked non-overwriting restoration, and its pre-created dirty gitlink. All other post-seal Git is read-only. Product writes require real WebDriver controls and explicit native UI trust. Scripts observe DOM/native windows only: no private App, business IPC, renderer mutation or synthetic events. OwnedProcesses cleanup uses exact PID plus creation time. Evidence source is automated-test, never userusage. Binary SHA-256, every failed/blocked step, actual PNG/DOM and fixture snapshots are retained locally. No download, install, build, commit/push of the project, or board writes.';
export const SELECTORS = Object.freeze({
  open: '.native-titlebar .breadcrumb', openForm: '[role="dialog"] .open-form', openMode: '.open-form select', openPath: '.open-form .path-input input', openDepth: '.open-form input[type="number"]', openSubmit: '.open-form button[type="submit"]',
  trust: '.repository-commandbar .trust-chip', settings: '.native-titlebar button[aria-label="Open global settings"]', refresh: '.repository-commandbar button[aria-label="Refresh current repository"]', sync: '.repository-commandbar > button.wb-button:not(.branch):not(.primary)',
  history: '.hp-list', inspector: '.ci-panel', parent: '.ci-parent-select select', fileView: '.ci-view select', diff: '.dp-panel', mode: '.dp-toolbar label:first-child select',
  local: '[data-testid="local-changes-panel"]', message: '.ch-message', commit: '[data-action="commit-staged"]', separator: '.sidebar-separator',
  settingsDialog: '[data-settings-dialog]', settingsSave: '[data-settings-dialog] [data-action="save-settings"]', settingsClose: '[data-settings-dialog] [data-action="close-settings"]',
  minimize: '.native-window-buttons button[aria-label="Minimize window"]', maximize: '.native-window-buttons button[aria-label="Maximize or restore window"]', close: '.native-window-buttons .close',
});
const css = value => JSON.stringify(String(value));
export const localFile = (group, path) => `.ch-file-row[data-group=${css(group)}][data-path=${css(path)}]`;
export const commitRow = oid => `[id=${css(`history-row-${oid}`)}]`;
export const fileRow = path => `.ci-panel [id=${css(`file-tree-${encodeURIComponent(`file:${path}`)}`)}]`;
const KEY = Object.freeze({ enter: '\uE007', escape: '\uE00C', right: '\uE014', left: '\uE012', down: '\uE015', end: '\uE010' });

// Observation-only code. All changes are clicks/keys/options through real WebDriver.
export const READ_VUE_DOM = `
const visible=e=>!!e&&!e.hidden&&e.getClientRects().length>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
const text=e=>e?.textContent.trim()??null;
const box=e=>{if(!visible(e))return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
const control=e=>({label:e.getAttribute('aria-label'),disabled:e.disabled,visible:visible(e),box:box(e)});
const shell=document.querySelector('.app-shell'),local=document.querySelector('[data-testid="local-changes-panel"]'),message=local?.querySelector('.ch-message'),ci=document.querySelector('.ci-panel'),dp=[...document.querySelectorAll('.dp-panel')].find(visible),dialog=[...document.querySelectorAll('[role="dialog"]')].filter(visible),settings=document.querySelector('[data-settings-dialog]'),sep=document.querySelector('.sidebar-separator');
return {locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth},
 shell:shell?{path:shell.dataset.repoPath,head:shell.dataset.repoHead,task:shell.dataset.taskState,sequence:shell.dataset.taskSequence,profile:shell.dataset.configDirectory,mode:shell.dataset.hostMode,generation:shell.dataset.openGeneration}:null,
 errors:[...document.querySelectorAll('.notice-strip.error[role=alert],.ch-error[role=alert],.hp-error[role=alert],.ci-state[role=alert],.dp-state[role=alert],[role=dialog] [role=alert],.usage-error[role=alert]')].filter(visible).map(text),
 roots:[...document.querySelectorAll('.repository-tree .root-row')].map(e=>({kind:e.dataset.nodeKind,level:e.getAttribute('aria-level'),expanded:e.getAttribute('aria-expanded'),context:e.querySelector('.root-context')?.title??null,count:text(e.querySelector('.node-count')),box:box(e)})),
 repositories:[...document.querySelectorAll('.repository-row')].map(e=>({path:e.dataset.repositoryPath,current:e.getAttribute('aria-current'),branch:text(e.querySelector('.branch-button span')),branchControl:control(e.querySelector('.branch-button')),box:box(e)})),
 sidebar:box(document.querySelector('.repository-sidebar')),main:box(document.querySelector('.main-workspace')),separator:sep?{box:box(sep),role:sep.getAttribute('role'),value:sep.getAttribute('aria-valuenow'),min:sep.getAttribute('aria-valuemin'),max:sep.getAttribute('aria-valuemax'),focused:document.activeElement===sep}:null,
 trust:{trusted:document.querySelector('.trust-chip')?.classList.contains('trusted')??false},
 history:{visible:visible(document.querySelector('.hp-list')),busy:document.querySelector('.hp-list')?.getAttribute('aria-busy'),rows:[...document.querySelectorAll('.hp-row')].map(e=>({oid:e.id.replace('history-row-',''),selected:e.getAttribute('aria-selected')==='true'}))},
 inspector:{visible:visible(ci),busy:ci?.getAttribute('aria-busy'),oids:[...ci?.querySelectorAll('.ci-oid')??[]].map(text),parent:ci?.querySelector('.ci-parent-select select')?.value??null,parents:[...ci?.querySelectorAll('.ci-parent-select option')??[]].map(e=>e.value),files:[...ci?.querySelectorAll('.ft-row')??[]].map(e=>({id:e.id,title:e.title,selected:e.getAttribute('aria-selected')})),reviewed:[...ci?.querySelectorAll('.ft-row')??[]].filter(e=>e.querySelector('.ft-reviewed')).map(e=>e.title),footer:text(ci?.querySelector('.ci-footer'))},
 diff:{visible:!!dp,path:text(dp?.querySelector('.dp-identity strong')),target:text(dp?.querySelector('.dp-target')),group:text(dp?.querySelector('.dp-target > span:last-child')),mode:dp?.querySelector('.dp-toolbar label:first-child select')?.value??null,busy:dp?.querySelector('.dp-viewport')?.getAttribute('aria-busy'),code:[...dp?.querySelectorAll('.dp-code')??[]].map(text),state:text(dp?.querySelector('.dp-state')),warning:[...dp?.querySelectorAll('.dp-warning')??[]].map(text),split:dp?.classList.contains('is-split')??false},
 local:{visible:visible(local),busy:local?.getAttribute('aria-busy'),inline:!!local?.closest('.repository-sidebar'),message:message?{value:message.value,start:message.selectionStart,end:message.selectionEnd,direction:message.selectionDirection}:null,commitDisabled:local?.querySelector('[data-action="commit-staged"]')?.disabled,
 groups:[...local?.querySelectorAll('.ch-group')??[]].map(e=>({id:e.dataset.group,count:Number(text(e.querySelector('.ch-group-count'))),expanded:e.querySelector('.ch-group-toggle')?.getAttribute('aria-expanded')})),filesBox:box(local?.querySelector('.ch-files')),files:[...local?.querySelectorAll('.ch-file-row')??[]].filter(visible).map(e=>({group:e.dataset.group,path:e.dataset.path,selected:e.classList.contains('ch-file-row--selected')}))},
 dialogs:dialog.map(e=>({title:text(e.querySelector('h2')),text:text(e),paths:[...e.querySelectorAll('.ch-confirm-paths li')].map(text),expected:text(e.querySelector('label code')),confirmDisabled:e.querySelector('[data-action^="confirm-"]')?.disabled})),
 settings:{visible:visible(settings),values:Object.fromEntries([...settings?.querySelectorAll('[data-setting]')??[]].map(e=>[e.dataset.setting,e.type==='checkbox'?e.checked:e.value])),sections:[...settings?.querySelectorAll('[data-section]')??[]].map(e=>e.dataset.section),scope:settings?.querySelector('[data-setting-scope]')?.value,saveDisabled:settings?.querySelector('[data-action="save-settings"]')?.disabled,profile:text(settings?.querySelector('[data-config-directory]'))},
 usage:{open:document.querySelector('.usage-recorder')?.open,status:text(document.querySelector('.usage-status')),source:document.querySelector('.usage-source select')?.value,digest:text(document.querySelector('.usage-panel dl'))},
 titlebar:{box:box(document.querySelector('.native-titlebar')),buttons:[...document.querySelectorAll('.native-window-buttons button')].map(control)}};`;

export function parseOptions(argv) {
  const options = parseArgs(argv, { values: ['binary', 'driver', 'output', 'git', 'tauri-driver', 'suite', 'only'], flags: ['help', 'expand-local-list'] });
  if (options.help) return options;
  required(options, ['binary', 'driver', 'output']);
  options.suite ??= 'smoke';
  assert(SUITES.includes(options.suite), '--suite must be smoke, actions or full.');
  if (options.only) {
    assert.equal(options.suite, 'full', '--only diagnostics retain the full suite contract; missing scenarios are not passed.');
    assert(['sync-negatives', 'faults', 'window', 'reopen'].includes(options.only), '--only must be sync-negatives, faults, window or reopen.');
  }
  assertLocalOutput(options.output);
  return options;
}
export function assertLocalOutput(directory) {
  assert(inside(join(PROJECT, 'artifacts'), resolve(directory)), 'Raw native evidence/profile/usage must stay in a new ignored artifacts subdirectory.');
  return resolve(directory);
}
export function assertRootContract(view, profile, previous) {
  assert(view.shell, 'Actual Vue .app-shell diagnostics are required.');
  assert.equal(view.shell.mode, 'desktop', 'Never accept browser/demo mode.');
  assert(samePath(view.shell.profile, profile), 'Native profile must exactly match the run-owned profile.');
  assert(['idle', 'running', 'created', 'loading'].includes(view.shell.task), 'Unknown/missing task-state contract.');
  assert(/^\d+$/.test(view.shell.sequence ?? ''), 'task-sequence must be a nonnegative integer, not missing/empty/NaN.');
  const sequence = Number(view.shell.sequence);
  assert(Number.isSafeInteger(sequence));
  if (previous !== undefined) assert(sequence >= previous, 'task-sequence regressed within the native session.');
  return sequence;
}
export function assertWideLayout(view) {
  assert(view.viewport.width >= 1200 && view.viewport.height >= 650, 'This suite only accepts an actual native wide viewport.');
  assert(view.viewport.scrollWidth <= view.viewport.width + 2, 'Root document horizontally overflows.');
  assert(view.sidebar && view.sidebar.width >= 298 && view.sidebar.width <= 642, 'Actual sidebar escaped its 300–640px budget.');
  assert(view.main && view.main.width >= 498, 'Actual main workspace must retain at least 500px.');
  assert(view.titlebar.box && Math.abs(view.titlebar.box.width - view.viewport.width) <= 2);
  return { viewport: view.viewport, sidebar: view.sidebar, main: view.main, titlebar: view.titlebar.box };
}
export function assertFourRoots(view, repository) {
  assert.deepEqual(view.roots.map(item => item.kind), ROOT_KINDS, 'Exactly four sibling roots in canonical order; no branch root.');
  assert(view.roots.every(item => item.level === '1' && item.box), 'All four roots must be actual visible peers.');
  if (repository) for (const item of view.roots.slice(1)) assert(samePath(item.context, repository), 'Submodules/tags/stashes must follow the current repository.');
  assert.equal(view.repositories.filter(item => item.current === 'true').length, repository ? 1 : 0);
}
export function assertGroups(view, facts) {
  assert(view.local.visible, 'Actual local changes panel must be visible.');
  assert.deepEqual(view.local.groups.map(item => item.id), ['staged', 'unstaged', 'untracked']);
  for (const group of view.local.groups) {
    assert.equal(group.count, facts[group.id].length, `${group.id}: count must come from Git, never old suite/demo counts.`);
    if (group.expanded === 'true') assert.deepEqual(view.local.files.filter(item => item.group === group.id).map(item => item.path).sort(), [...facts[group.id]].sort());
  }
}
const workingBytes = snapshot => [...snapshot.tracked.map(({ path, working }) => ({ path, working })), ...snapshot.untracked.map(({ path, working }) => ({ path, working }))].sort((a, b) => a.path.localeCompare(b.path));
export function assertIndexOnly(before, after) {
  for (const name of ['identity', 'head', 'headFile', 'refs', 'untracked']) assert.deepEqual(after[name], before[name], `Index-only action changed ${name}.`);
  assert.deepEqual(workingBytes(after), workingBytes(before), 'Stage/unstage changed real working bytes.');
  if (!before.index) assert.notDeepEqual(after.index, before.index, 'Real index did not change.');
  else assert.notEqual(after.index?.sha256, before.index.sha256, 'Real index bytes did not change.');
}
export function assertCommitOnly(before, after, actual, expected) {
  assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.headFile, before.headFile);
  assert.deepEqual(after.tracked.map(({ working, ...entry }) => entry), before.tracked.map(({ working, ...entry }) => entry), 'Commit must preserve exact index entries.');
  assert.notEqual(after.head, before.head); assert.equal(actual.parent, before.head);
  assert.equal(actual.message, expected.message); assert.deepEqual(actual.paths, [expected.path]); assert.equal(actual.blob, expected.stagedOid);
  assert.deepEqual(workingBytes(after), workingBytes(before)); assert.deepEqual(after.untracked, before.untracked);
  assert.deepEqual(after.refs, before.refs.map(ref => ref === `refs/heads/main ${before.head} commit` ? `refs/heads/main ${after.head} commit` : ref).sort());
}
export function assertUsageRecords(records, binarySha256, privateValues = []) {
  assert(records.length >= 3, 'A complete native usage log needs a session, start and stop.');
  assert.equal(records[0].kind, 'native-session'); assert.equal(records[0].runtime.exeSha256, binarySha256);
  assert.equal(records.at(-1).kind, 'boundary'); assert.equal(records.at(-1).boundary, 'stop', 'An interrupted session is not complete.');
  let sequence = 0;
  for (const record of records) {
    assert.equal(record.source, 'automated-test', 'Assistant automation must never claim userusage.');
    assert.equal(record.build, `native-${binarySha256}`); assert.equal(record.sessionId, records[0].sessionId);
    if (record.kind !== 'native-session') assert.equal(record.sequence, ++sequence);
  }
  const serialized = JSON.stringify(records);
  for (const value of privateValues.filter(Boolean)) assert(!serialized.includes(JSON.stringify(value).slice(1, -1)), 'Native usage log leaked fixture path/content/draft.');
  return { source: 'automated-test', sessionId: records[0].sessionId, build: records[0].build, records: records.length, events: sequence, stopped: true };
}
function assertSameObjectEntry(left, right) {
  assert.equal(left.dev, right.dev); assert.equal(left.ino, right.ino); assert.equal(left.size, right.size);
}
export function resultStatus(results) {
  if (!results.length || results.some(result => !['passed', 'failed', 'blocked'].includes(result.status))) return 'failed';
  if (results.some(result => result.status === 'failed')) return 'failed';
  return results.some(result => result.status === 'blocked') ? 'blocked' : 'passed';
}
export async function selectOption(wd, selector, value) {
  await wd.click(selector);
  await wd.click(`${selector} > option[value=${css(value)}]`);
}

export async function createVueFixtures(run, check = () => {}, { full = false } = {}) {
  const workspace = join(run.output, 'fixtures'); await mkdir(workspace);
  await json(join(workspace, '.fixture-owner.json'), { runId: run.manifest.runId, source: 'automated-test' });
  const root = join(workspace, 'Vue workspace 中文'); await mkdir(root);
  const alpha = join(root, 'Alpha 中文'), bravo = join(root, 'Bravo'), moduleSource = join(workspace, 'module-source'), remote = join(workspace, 'sync-origin.git'), sync = join(workspace, 'sync-worktree'), seed = join(workspace, 'sync-seed');
  let sealed = false, clock = 0;
  const setup = (path, args, options) => { check(); assert(!sealed && (samePath(workspace, path) || inside(workspace, path))); return git(run, path, args, options); };
  const text = (path, args) => setup(path, args).stdout.toString('utf8').trim();
  const write = async (repo, path, bytes) => { assert(!sealed && inside(workspace, repo)); await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), bytes); };
  const configure = path => { for (const [key, value] of [['user.name', 'Vue desktop fixture'], ['user.email', 'vue@example.invalid'], ['core.hooksPath', run.manifest.git.hooksDirectory], ['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['credential.helper', ''], ['protocol.allow', 'never'], ['protocol.file.allow', 'always']]) setup(path, ['config', '--local', key, value]); };
  const init = async path => { await mkdir(path); setup(path, ['init', '-b', 'main', `--template=${run.manifest.git.templateDirectory}`]); configure(path); };
  const commit = (path, message) => { setup(path, ['add', '--all']); const date = new Date(Date.UTC(2026, 0, 4, 8, clock++)).toISOString(); setup(path, ['commit', '--quiet', '-m', message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }); return text(path, ['rev-parse', 'HEAD']); };
  await init(moduleSource); await write(moduleSource, 'module.txt', 'Real local module.\n'); commit(moduleSource, 'Module initial');
  await init(alpha); setup(alpha, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', moduleSource, 'module']); configure(join(alpha, 'module'));
  const readPath = 'read.txt', overlap = 'overlap 中文.txt', keep = 'keep.txt', untracked = 'delete me 中文.txt';
  const oldText = 'FIRST PARENT real Git text\nLine two context\n', newText = 'MERGED real Git text\nLine two context\n';
  await write(alpha, readPath, 'BASE real Git text\nLine two context\n'); await write(alpha, overlap, 'HEAD original bytes\n'); await write(alpha, keep, 'HEAD keep bytes\n'); await write(alpha, 'binary.bin', Buffer.from([0, 1, 2, 3])); commit(alpha, 'Base real history');
  setup(alpha, ['checkout', '-b', 'feature-parent']); await write(alpha, 'side.txt', 'Second parent independent file\n'); const parent2 = commit(alpha, 'Feature second parent');
  setup(alpha, ['checkout', 'main']); await write(alpha, readPath, oldText); const parent1 = commit(alpha, 'Main first parent');
  setup(alpha, ['merge', '--no-ff', '--no-commit', 'feature-parent']); await write(alpha, readPath, newText); await write(alpha, 'binary.bin', Buffer.from([0, 4, 5, 6])); const review = commit(alpha, 'Merge actual two-parent review');
  setup(alpha, ['tag', 'vue-fixture-tag']); await write(alpha, 'stash.txt', 'Real stash content\n'); setup(alpha, ['add', '--', 'stash.txt']); setup(alpha, ['stash', 'push', '-m', 'Owned native Vue stash']);
  await write(alpha, overlap, 'INDEX independently staged bytes\n'); setup(alpha, ['add', '--', overlap]); await write(alpha, overlap, 'WORKTREE independently unstaged bytes\n'); await write(alpha, keep, 'WORKTREE keep bytes\n'); await write(alpha, untracked, 'Only owned deletion target\n');
  const stagedOid = text(alpha, ['rev-parse', `:${overlap}`]);
  await init(bravo); await write(bravo, 'clean.txt', 'Independent clean repository\n'); const bravoHead = commit(bravo, 'Bravo initial');
  await init(seed); await write(seed, 'base.txt', 'Sync base\n'); commit(seed, 'Sync base'); await mkdir(remote); setup(remote, ['init', '--bare', '-b', 'main', `--template=${run.manifest.git.templateDirectory}`]); configure(remote); setup(seed, ['remote', 'add', 'origin', remote]); setup(seed, ['-c', 'protocol.file.allow=always', 'push', '--set-upstream', 'origin', 'main']);
  setup(workspace, ['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', '--', remote, sync]); configure(sync); await write(sync, 'local.txt', 'Local outgoing change\n'); const syncLocal = commit(sync, 'Sync local outgoing');
  await write(seed, 'incoming.txt', 'Remote incoming change\n'); const syncIncoming = commit(seed, 'Sync remote incoming'); setup(seed, ['-c', 'protocol.file.allow=always', 'push', 'origin', 'main']);
  const repositories = { alpha, bravo, moduleSource, module: join(alpha, 'module'), remote, sync, seed };
  const syncNegatives = {};
  if (full) {
    for (const kind of ['conflict', 'push-error', 'cancel']) {
      const prefix = kind === 'conflict' ? 'conflict' : kind === 'cancel' ? 'cancel' : 'pushError', negativeSeed = join(workspace, `${prefix}-seed`), negativeRemote = join(workspace, `${prefix}-origin.git`), worktree = join(workspace, `${prefix}-worktree`);
      await init(negativeSeed); await write(negativeSeed, 'shared.txt', 'Common base\n'); commit(negativeSeed, `${kind} common base`);
      await mkdir(negativeRemote); setup(negativeRemote, ['init', '--bare', '-b', 'main', `--template=${run.manifest.git.templateDirectory}`]); configure(negativeRemote); setup(negativeSeed, ['remote', 'add', 'origin', negativeRemote]); setup(negativeSeed, ['-c', 'protocol.file.allow=always', 'push', '--set-upstream', 'origin', 'main']);
      setup(workspace, ['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', '--', negativeRemote, worktree]); configure(worktree);
      await write(worktree, kind === 'conflict' ? 'shared.txt' : 'outgoing.txt', 'Local side of negative sync\n'); const localHead = commit(worktree, `${kind} outgoing`);
      await write(negativeSeed, kind === 'conflict' ? 'shared.txt' : 'incoming.txt', 'Remote side of negative sync\n'); const incomingHead = commit(negativeSeed, `${kind} incoming`); setup(negativeSeed, ['-c', 'protocol.file.allow=always', 'push', 'origin', 'main']);
      if (kind === 'push-error') setup(worktree, ['remote', 'set-url', '--push', 'origin', join(workspace, 'missing-push-destination.git')]);
      if (kind === 'cancel') {
        // The only executable fixture hook is a bounded local wait. Its sole
        // purpose is exposing a real in-flight pull cancellation window; it has
        // no network access or repository writes. Never install hooks outside
        // this new owned fixture, and never claim rollback after cancellation.
        const hooks = join(workspace, 'cancel-only-hooks'); await mkdir(hooks);
        await writeFile(join(hooks, 'pre-merge-commit'), '#!/bin/sh\nsleep 12\nexit 0\n', { flag: 'wx' });
        setup(worktree, ['config', '--local', 'core.hooksPath', hooks]);
      }
      repositories[`${prefix}Seed`] = negativeSeed; repositories[`${prefix}Remote`] = negativeRemote; repositories[`${prefix}Worktree`] = worktree;
      syncNegatives[kind] = { prefix, worktree, remote: negativeRemote, seed: negativeSeed, localHead, incomingHead };
    }
    const fault = join(workspace, 'fault-read-stale-gitlink'); await init(fault);
    await write(fault, 'fault.txt', 'Original dedicated read-error blob\n'); await write(fault, 'index-only.txt', 'HEAD dedicated stale index\n'); commit(fault, 'Fault baseline');
    setup(fault, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', moduleSource, 'fault-module']); configure(join(fault, 'fault-module'));
    await write(fault, 'fault.txt', 'Dedicated missing-object diff target\n'); const faultReview = commit(fault, 'Dedicated fault review');
    const faultOid = text(fault, ['rev-parse', 'HEAD:fault.txt']), staleIndex = 'index-only.txt';
    await write(fault, staleIndex, 'INDEX controlled stale index A\n'); setup(fault, ['add', '--', staleIndex]);
    const staleOidBefore = text(fault, ['rev-parse', `:${staleIndex}`]);
    await write(fault, staleIndex, 'INDEX controlled stale index B\n'); const staleOidAfter = text(fault, ['hash-object', '-w', '--', staleIndex]);
    await write(fault, staleIndex, 'WORKTREE controlled stale index\n'); await write(join(fault, 'fault-module'), 'module.txt', 'Dirty dedicated gitlink child\n');
    repositories.fault = fault; repositories.faultModule = join(fault, 'fault-module');
    syncNegatives.fault = { path: fault, review: faultReview, oid: faultOid, looseObject: join(fault, '.git/objects', faultOid.slice(0, 2), faultOid.slice(2)), stalePath: staleIndex, staleOidBefore, staleOidAfter };
  }
  sealed = true; run.vueRepositories = Object.values(repositories); run.vueFixtureRoot = workspace;
  const snapshots = {};
  for (const [name, path] of Object.entries(repositories)) {
    const snapshot = await repositorySnapshot(run, path);
    for (const identity of [snapshot.identity.path, snapshot.identity.gitDir, await realpath(resolve(path, readOwned(run, path, ['rev-parse', '--git-common-dir']).toString('utf8').trim()))]) assert(inside(workspace, identity), 'Fixture Git identity escaped this new run.');
    snapshots[name] = snapshot;
  }
  const fixture = { schemaVersion: 1, source: 'automated-test', runId: run.manifest.runId, workspace, root: await realpath(root), repositories, review, parent1, parent2, bravoHead, readPath, oldText, newText, overlap, keep, untracked, stagedOid, syncLocal, syncIncoming, syncNegatives, snapshots };
  await json(join(run.output, 'vue-fixtures.json'), fixture); return fixture;
}
function readOwned(run, path, args) {
  assert(run.vueRepositories?.some(item => samePath(item, path)), 'Git read is not one of this runner\'s exact owned repositories.');
  assert(['rev-parse', 'show', 'diff', 'diff-tree', 'ls-files', 'status', 'for-each-ref', 'log', 'config'].includes(args[0]), 'Post-seal Git must be an explicit read.');
  if (args[0] === 'config') assert(args[1] === '--get', 'Config reads only after sealing.');
  return git(run, path, args).stdout;
}
function gitFacts(run, path) {
  const names = args => readOwned(run, path, args).toString('utf8').split('\0').filter(Boolean).sort();
  return { staged: names(['diff', '--cached', '--name-only', '-z']), unstaged: names(['diff', '--name-only', '-z']), untracked: names(['ls-files', '--others', '--exclude-standard', '-z']) };
}

// Exact owned application identities only. This probe never manipulates windows.
export const NATIVE_WINDOW_PROBE = `param([string]$OwnershipFile,[string]$Binary)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class QGVueWindow { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; } [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder t,int n); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder t,int n); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p,IntPtr l); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); delegate bool EnumProc(IntPtr h,IntPtr l); public static long[] ForPid(uint pid) { var a=new System.Collections.Generic.List<long>(); EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid)a.Add(h.ToInt64());return true;},IntPtr.Zero);return a.ToArray(); } }'
$ownership=Get-Content -LiteralPath $OwnershipFile -Raw | ConvertFrom-Json
$items=@();$seen=@{}
foreach($expected in @($ownership.roots)+@($ownership.known)) {
 if(!$expected -or !$expected.executable -or ![string]::Equals([IO.Path]::GetFullPath($expected.executable),[IO.Path]::GetFullPath($Binary),[StringComparison]::OrdinalIgnoreCase)){continue}
 $key=[string]$expected.pid+':'+[string]$expected.creationTime;if($seen.ContainsKey($key)){continue};$seen[$key]=$true
 $actual=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$expected.pid) -ErrorAction SilentlyContinue
 if(!$actual -or $actual.CreationDate.ToUniversalTime().ToString('o') -ne [string]$expected.creationTime){continue}
 foreach($handle in [QGVueWindow]::ForPid([uint32]$expected.pid)) {
 $window=[IntPtr]$handle;if(![QGVueWindow]::IsWindowVisible($window)){continue}
 $rect=New-Object QGVueWindow+RECT;$null=[QGVueWindow]::GetWindowRect($window,[ref]$rect)
 $title=New-Object Text.StringBuilder 1024;$null=[QGVueWindow]::GetWindowText($window,$title,1024)
 $class=New-Object Text.StringBuilder 1024;$null=[QGVueWindow]::GetClassName($window,$class,1024)
 $items+= [pscustomobject]@{pid=[int]$expected.pid;creationTime=$expected.creationTime;handle=$handle;title=$title.ToString();class=$class.ToString();minimized=[QGVueWindow]::IsIconic($window);maximized=[QGVueWindow]::IsZoomed($window);rect=[pscustomobject]@{left=$rect.left;top=$rect.top;width=$rect.right-$rect.left;height=$rect.bottom-$rect.top}}
 }
}
ConvertTo-Json -InputObject @($items) -Depth 10 -Compress
`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log('node scripts/test-vue-desktop.mjs --binary <supplied-vue.exe> --driver <verified-msedgedriver.exe> --output <new-artifacts-run> [--suite smoke|actions|full] [--git <exe>] [--tauri-driver <exe>] [--only sync-negatives|faults|window|reopen]\nReal native Windows WebDriver, fresh fixtures/profile only; no real repository argument. smoke: boot/open/trust/history/Diff/local/navigation/settings/language/theme/sidebar/window/reopen. actions adds index-only stage/unstage/commit and local bare sync. full adds binary, error and cancellation negatives. Exit 0 passed, 1 failed, 2 blocked; automated-test evidence is never userusage. No download/install/build/board writes.'); return; }
  const run = await createRun(resolve(options.output), 'vue-desktop'), owned = new OwnedProcesses(run), controller = new AbortController();
  const deadline = Date.now() + RUN_BUDGET_MS, mutations = [], transitions = [], cleanupErrors = [];
  let wd, monitor, fixture, accepted, failure, lastSequence;
  const timer = setTimeout(() => controller.abort(new BlockedError('Vue desktop ten-minute work budget expired; remaining scenarios are not passed.')), RUN_BUDGET_MS); timer.unref();
  const interrupt = () => controller.abort(new Error('Interrupted; partial evidence is retained.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  run.manifest.vue = { suite: options.suite, ...(options.only ? { scenarioFilter: options.only } : {}), source: 'automated-test', scope: SCOPE, workBudgetMs: RUN_BUDGET_MS, mutations, transitions, limitations: ['Integration evidence only unless caller independently identifies this binary as final.', 'No actual userusage; no completion/board assessment is made.', 'No external URL/network remote/native file picker/editor/terminal is exercised.'] };
  function check() { controller.signal.throwIfAborted(); monitor?.check(); }
  async function observe({ allowErrors = false } = {}) {
    check(); const view = await wd.script(READ_VUE_DOM); lastSequence = assertRootContract(view, run.profileDirectory, lastSequence);
    if (!allowErrors) assert.deepEqual(view.errors, [], 'Actual Vue UI error.');
    const signature = JSON.stringify([view.shell, view.trust, view.inspector.oids, view.inspector.busy, view.diff.path, view.diff.mode, view.local.busy]);
    if (transitions.length < 500 && transitions.at(-1)?.signature !== signature) transitions.push({ at: new Date().toISOString(), signature, shell: view.shell, errors: view.errors });
    return view;
  }
  const wait = (label, predicate, timeout = 25_000, observationOptions) => until(label, async () => { const view = await observe(observationOptions); return predicate(view) ? view : false; }, { timeout: Math.max(1, Math.min(timeout, deadline - Date.now())), interval: 100, signal: controller.signal });
  async function archive(name, options) { const view = await observe(options); await json(join(run.output, `evidence/${name}-observed.json`), view); const evidence = await archiveDesktop(run, wd, name); assert.deepEqual(evidence.errors, [], 'Actual evidence must be complete.'); return view; }
  async function step(label, work, { allowBlocked = false, continueOnFailure = false } = {}) {
    if (options.only) {
      const allowed = ['actual-native-startup-and-profile-gate', 'vue-native-boot-isolated-profile', 'native-usage-explicit-automated-source'];
      if (options.only === 'window') allowed.push('native-titlebar-actual-maximize-restore-minimize');
      if (options.only === 'reopen') allowed.push('repository-open-dialog-real-path-and-read-only', 'trust-dialog-explicit-repository-confirmation', 'directory-four-root-current-repository-navigation', 'settings-deep-global-repository-language-theme-state', 'sidebar-real-separator-keyboard-and-collapse', 'native-profile-reopen-restores-settings-trust-sidebar', 'native-titlebar-close-actual-window-exit');
      if (options.only === 'sync-negatives') allowed.push('native-sync-conflict-no-push', 'native-sync-push-error-no-false-success', 'native-sync-inflight-cancel-no-push');
      if (options.only === 'faults') allowed.push('native-diff-read-error-and-retry', 'native-working-stale-expected-index-rejection', 'native-gitlink-snapshot-rejection');
      if (!allowed.includes(label)) return;
    }
    const result = { label, source: 'automated-test', status: 'running', startedAt: new Date().toISOString() }; run.manifest.results.push(result); await run.save();
    try { check(); result.observed = await work(); check(); result.status = 'passed'; console.log(`PASS ${label}`); return result.observed; }
    catch (error) {
      result.status = error instanceof BlockedError ? 'blocked' : 'failed'; result.error = errorInfo(error); console.error(`${result.status.toUpperCase()} ${label}: ${error.message}`);
      if (wd?.sessionId) {
        try { const view = await wd.script(READ_VUE_DOM); await json(join(run.output, `evidence/failure-${label}-observed.json`), view); await archiveDesktop(run, wd, `failure-${label}`); }
        catch (captureError) { result.captureError = errorInfo(captureError); }
      }
      if (!(allowBlocked && error instanceof BlockedError) && !continueOnFailure) throw error;
    }
    finally { result.finishedAt = new Date().toISOString(); await run.save(); }
  }
  async function open(path, mode = 'repository', depth = 0) {
    if (mode === 'repository') assert(run.vueRepositories.some(item => samePath(item, path)), 'Open UI accepts this run\'s exact fixtures only.');
    else assert(samePath(path, fixture.root), 'Directory UI accepts this run\'s exact fixture discovery root only.');
    await wd.click(SELECTORS.open); await wait('real repository open dialog', view => view.dialogs.some(dialog => /Open repository or directory/.test(dialog.title ?? '')), 10_000, { allowErrors: true });
    await selectOption(wd, SELECTORS.openMode, mode); await wd.fill(SELECTORS.openPath, path); if (mode === 'directory') await wd.fill(SELECTORS.openDepth, String(depth));
    const before = (await observe({ allowErrors: true })).shell.sequence; await wd.click(SELECTORS.openSubmit);
    return wait('actual fixture open and native refresh', view => {
      // The previous verified negative read error can remain rendered while
      // this request is running. Only its terminal state is new evidence.
      if (view.shell.task !== 'idle') return false;
      assert.deepEqual(view.errors, [], 'New repository open finished with a real error.');
      return !view.dialogs.length && Number(view.shell.sequence) > Number(before) && (mode === 'directory' || samePath(view.shell.path, path));
    }, 45_000, { allowErrors: true });
  }
  async function trust(path) {
    assert(run.vueRepositories.some(item => samePath(item, path)), 'Never trust a non-fixture repository.');
    const before = await observe(); assert(samePath(before.shell.path, path)); assert.equal(before.trust.trusted, false, 'A newly opened repository must initially be read-only.');
    await wd.click(SELECTORS.trust); await wait('real native trust dialog', view => view.dialogs.some(dialog => /Directory and repository trust/.test(dialog.title ?? '')));
    await wd.clickText('[role="dialog"] .trust-actions button', 'Trust only this repository'); await wait('explicit trust scope review', view => view.dialogs.some(dialog => dialog.text.includes(path) && dialog.text.includes('Confirm trust scope')));
    await wd.clickText('[role="dialog"] footer button', 'Confirm rule'); await wait('actual native trust granted and refreshed', view => view.trust.trusted && view.shell.task === 'idle');
    await wd.click('[role="dialog"] .trust-header button[aria-label="Close"]'); await wait('trust dialog closed', view => !view.dialogs.length); return archive(`trust-${mutations.length}`);
  }
  async function historyTab() { await wd.clickText('.workbench-tabs > button', 'Commit history'); return wait('history is visible', view => view.history.visible); }
  async function localTab() { await wd.click('.workbench-tabs > button:nth-child(2)'); return wait('actual local panel visible', view => view.local.visible && view.shell.task === 'idle'); }
  async function selectCommit(oid) {
    await historyTab(); const current = await observe();
    if (current.inspector.visible && current.inspector.busy === 'false' && current.inspector.oids.includes(oid)) return current;
    if (current.inspector.visible) { await wd.click('.ci-panel button[aria-label="Close commit inspector"]'); await wait('previous inspector closed', view => !view.inspector.visible); }
    await wd.click(commitRow(oid)); return wait('actual selected commit detail', view => view.inspector.visible && view.inspector.busy === 'false' && view.inspector.oids.includes(oid));
  }
  async function openFile(path) { await selectOption(wd, SELECTORS.fileView, 'list'); await wd.click(fileRow(path)); return wait('real historical diff loaded', view => view.diff.visible && view.diff.path === path && view.diff.busy === 'false' && (view.diff.code.length > 0 || !!view.diff.state)); }
  async function mode(value, expected) { await selectOption(wd, SELECTORS.mode, value); return wait('actual diff mode/content', view => view.diff.mode === value && view.diff.busy === 'false' && (!expected || view.diff.code.join('\n').includes(expected))); }
  async function openSettings(scope = 'global') { await wd.click(SELECTORS.settings); await wait('actual settings dialog', view => view.settings.visible); if (scope !== (await observe()).settings.scope) await selectOption(wd, '[data-setting-scope]', scope); }
  async function editSettings(section, fields) { await wd.click(`[data-settings-dialog] [data-section=${css(section)}]`); for (const [key, value] of Object.entries(fields)) { const selector = `[data-settings-dialog] [data-setting=${css(key)}]`; const current = (await observe()).settings.values[key]; if (current === value) continue; if (typeof value === 'boolean') await wd.click(selector); else if (await wd.script('return document.querySelector(arguments[0])?.tagName === "SELECT";', [selector])) await selectOption(wd, selector, String(value)); else await wd.fill(selector, String(value)); } }
  async function saveSettings() { await wd.click(SELECTORS.settingsSave); await wait('settings save completed', view => view.settings.saveDisabled === true); await wd.click(SELECTORS.settingsClose); return wait('settings closed', view => !view.settings.visible); }
  async function dismissExpectedErrors() {
    const view = await observe({ allowErrors: true });
    if (view.errors.length) {
      const canDismiss = await wd.script('const e=document.querySelector(".notice-strip.error button[aria-label=\\"Dismiss error\\"]");return !!e&&!!e.getClientRects().length;');
      if (canDismiss) await wd.click('.notice-strip.error button[aria-label="Dismiss error"]');
    }
  }
  async function nativeDrag(selector, dx, dy) {
    const bounds = await wd.script('const e=document.querySelector(arguments[0]);if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};', [selector]);
    assert(bounds, 'Real native drag handle must be visible.');
    try { await wd.call('POST', `${wd.prefix}/actions`, { actions: [{ type: 'pointer', id: 'vue-owned-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(bounds.x), y: Math.round(bounds.y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', duration: 400, origin: 'viewport', x: Math.round(bounds.x + dx), y: Math.round(bounds.y + dy) }, { type: 'pointerUp', button: 0 }] }] }); }
    finally { await wd.call('DELETE', `${wd.prefix}/actions`); }
  }
  async function faultStageIndex(path) {
    const target = fixture.syncNegatives.fault;
    assert(target && samePath(path, target.path));
    const before = await repositorySnapshot(run, path); assertSameSnapshot(accepted.fault, before, 'Fault injection identity/snapshot must be unchanged.');
    assert(samePath(before.identity.path, target.path) && inside(run.vueFixtureRoot, before.identity.gitDir));
    const item = before.tracked.find(item => item.path === target.stalePath); assert(item?.working);
    const bytes = await fingerprint(join(path, target.stalePath)); assert.equal(bytes.sha256, item.working.sha256);
    const beforeFacts = gitFacts(run, path); const beforeXY = readOwned(run, path, ['status', '--porcelain=v2', '--untracked-files=all', '-z']).toString('utf8').split('\0').filter(line => line.startsWith('1 ')).map(line => ({ xy: line.split(' ')[1], path: line.split(' ').slice(8).join(' ') }));
    assert.equal(before.tracked.find(item => item.path === target.stalePath)?.oid, target.staleOidBefore);
    git(run, path, ['update-index', '--cacheinfo', '100644', target.staleOidAfter, target.stalePath]);
    const after = await repositorySnapshot(run, path); assertIndexOnly(before, after); accepted.fault = after;
    const afterXY = readOwned(run, path, ['status', '--porcelain=v2', '--untracked-files=all', '-z']).toString('utf8').split('\0').filter(line => line.startsWith('1 ')).map(line => ({ xy: line.split(' ')[1], path: line.split(' ').slice(8).join(' ') }));
    assert.deepEqual(afterXY, beforeXY, 'Fault must preserve every path/XY status while changing the actual index blob.'); assert.deepEqual(gitFacts(run, path), beforeFacts);
    const event = { label: 'harness-fault-stage-literal-index-path', actor: 'harness', source: 'automated-test', at: new Date().toISOString(), path: target.stalePath, preBytesSha256: bytes.sha256, before, after, beforeXY, afterXY, indexBlob: [target.staleOidBefore, target.staleOidAfter] };
    mutations.push(event); await json(join(run.output, 'accepted-mutations.json'), mutations); return event;
  }
  async function nativeWindow() { await owned.snapshot(); const windows = JSON.parse(powershell(join(run.output, 'native-window-probe.ps1'), [owned.file, run.manifest.binary.path])); assert(Array.isArray(windows)); (run.manifest.nativeWindows ??= []).push({ at: new Date().toISOString(), windows }); await json(join(run.output, 'native-window-observations.json'), run.manifest.nativeWindows); return windows.filter(window => window.title === 'QGitGraph' && window.class === 'Tauri Window'); }
  async function mutation(label, action, verify) {
    const path = fixture.repositories.alpha, previous = await repositorySnapshot(run, path); assertSameSnapshot(accepted.alpha, previous, `before ${label}`); const sequence = (await observe()).shell.sequence;
    await action(); await wait(`${label}: actual write and refreshed snapshot`, view => view.shell.task === 'idle' && Number(view.shell.sequence) > Number(sequence) && view.local.busy === 'false');
    const next = await repositorySnapshot(run, path); const facts = gitFacts(run, path); const observed = await verify(previous, next, facts); accepted.alpha = next;
    const record = { label, source: 'automated-test', at: new Date().toISOString(), before: previous, after: next, facts, observed }; mutations.push(record); await json(join(run.output, 'accepted-mutations.json'), mutations); return record;
  }
  try {
    // Fingerprint even failed setup, before launching anything or touching fixtures.
    run.manifest.binary = await fingerprint(options.binary); await run.save();
    if (process.platform !== 'win32') throw new BlockedError('Actual Windows native desktop is required; no emulated pass.');
    run.gitBinary = gitExecutable(options.git); run.manifest.git.executable = run.gitBinary;
    fixture = await createVueFixtures(run, check, { full: options.suite === 'full' }); accepted = structuredClone(fixture.snapshots); await writeFile(join(run.output, 'native-window-probe.ps1'), NATIVE_WINDOW_PROBE, { flag: 'wx' });
    await step('actual-native-startup-and-profile-gate', async () => {
      wd = await startDesktop(run, options, owned); monitor = monitorOwnedProcesses(owned);
      const originalCall = wd.call.bind(wd); wd.call = (method, path, body, timeout = 20_000) => { check(); return originalCall(method, path, body, Math.max(1, Math.min(timeout, 45_000, deadline - Date.now()))); };
      return { sessionId: wd.sessionId, nativeProfile: run.manifest.profileVerified, binarySha256: run.manifest.binary.sha256 };
    });
    await step('vue-native-boot-isolated-profile', async () => { const view = await observe(); assert.equal(view.shell.path, ''); assert.equal(view.shell.task, 'idle'); assert.equal(view.locale, 'en'); assert(view.titlebar.box && view.titlebar.buttons.length === 3); const saved = await readJson(join(run.profileDirectory, 'state.json')); assert.deepEqual(saved.trusted, []); assert.equal(saved.lastRepo, null); await wd.call('POST', `${wd.prefix}/window/rect`, { width: 1455, height: 950 }); const resized = await wait('actual native wide layout settles', view => view.viewport.width >= 1200 && !!view.sidebar && !!view.main); assertWideLayout(resized); return archive('01-boot'); });
    await step('native-usage-explicit-automated-source', async () => { await wd.click('.usage-recorder > summary'); await selectOption(wd, '.usage-source select', 'automated-test'); await wd.click('.usage-consent input'); await wd.clickText('.usage-actions button', 'Start'); const view = await wait('native automated-test recording', view => view.usage.status?.startsWith('Recording') && view.usage.source === 'automated-test'); assert(view.usage.digest.includes(run.manifest.binary.sha256), 'Native recorder must bind the actual executable SHA-256.'); await wd.click('.usage-close'); return { source: view.usage.source, exeSha256: run.manifest.binary.sha256 }; });
    await step('repository-open-dialog-real-path-and-read-only', async () => { const view = await open(fixture.repositories.alpha); assert.equal(view.shell.head, fixture.review); assert.equal(view.trust.trusted, false); assertFourRoots(view, fixture.repositories.alpha); await localTab(); assertGroups(await observe(), gitFacts(run, fixture.repositories.alpha)); assert.equal((await observe()).local.commitDisabled, true); return archive('02-open-read-only'); });
    await step('trust-dialog-explicit-repository-confirmation', () => trust(fixture.repositories.alpha));
    await step('history-commit-parent-diff-old-new-unified-split', async () => {
      await selectCommit(fixture.review); let view = await observe(); assert.deepEqual(view.inspector.parents, [fixture.parent1, fixture.parent2]);
      await selectOption(wd, SELECTORS.parent, fixture.parent2); await wait('second parent selected', view => view.inspector.parent === fixture.parent2 && view.inspector.busy === 'false');
      await selectOption(wd, SELECTORS.parent, fixture.parent1); await wait('first parent selected', view => view.inspector.parent === fixture.parent1 && view.inspector.busy === 'false');
      await openFile(fixture.readPath); await mode('old', fixture.oldText.split('\n')[0]); await archive('03-diff-old'); await mode('new', fixture.newText.split('\n')[0]); await archive('04-diff-new'); await mode('unified', fixture.newText.split('\n')[0]); await archive('05-diff-unified'); view = await mode('split', fixture.newText.split('\n')[0]); assert(view.diff.split); return archive('06-diff-split');
    });
    await step('local-staged-unstaged-path-identity-and-draft', async () => {
      await localTab(); assertGroups(await observe(), gitFacts(run, fixture.repositories.alpha)); const observations = [];
      for (const [group, expected, absent] of [['staged', 'INDEX independently staged bytes', 'WORKTREE independently unstaged bytes'], ['unstaged', 'WORKTREE independently unstaged bytes', 'HEAD original bytes']]) {
        await wd.click(`${localFile(group, fixture.overlap)} .ch-file-open`);
        const view = await wait('local real group/path diff', view => view.diff.path === fixture.overlap && view.diff.busy === 'false' && view.diff.code.length > 0 && view.diff.group === group);
        assert(view.local.files.some(item => item.group === group && item.path === fixture.overlap && item.selected)); assert(view.diff.code.join('\n').includes(expected)); assert(!view.diff.code.join('\n').includes(absent)); observations.push({ group, target: view.diff.target, code: view.diff.code });
        if (options['expand-local-list'] && group === 'staged') {
          await archive('local-default-layout-before-assisted-resize');
          await nativeDrag('.size-handle[aria-label="Resize local file list"]', 0, 320);
          await wait('real local list expanded with native pointer drag', view => view.local.filesBox?.height >= 120);
          run.manifest.vue.assistedLocalResize = { source: 'automated-test', reason: 'Explicit investigation flag: default list layout failed in an earlier run; native pointer drag on the actual separator enables remaining coverage. Not a repaired-default-layout pass.' };
          run.manifest.vue.limitations.push('Assisted local-list resize was used; default local preview layout is not passed by this run.');
        }
      }
      await wd.fill(SELECTORS.message, 'Owned Vue draft 中文'); await wd.click('.repository-sidebar .repository-row.current-repository .repository-name'); await wd.click('.repository-sidebar .repository-row.current-repository .repository-name'); const view = await wait('repository-specific draft survives panel toggle', view => view.local.visible && view.local.message?.value === 'Owned Vue draft 中文'); return { observations, draft: view.local.message, evidence: await archive('07-local-group-path') };
    });
    await step('directory-four-root-current-repository-navigation', async () => { await open(fixture.root, 'directory', 1); let view = await observe(); assertFourRoots(view, fixture.repositories.alpha); assert(view.repositories.some(item => samePath(item.path, fixture.repositories.bravo))); await wd.click(`.repository-row[data-repository-path=${css(fixture.repositories.bravo)}] .repository-name`); view = await wait('Bravo actual activation', view => samePath(view.shell.path, fixture.repositories.bravo) && view.shell.head === fixture.bravoHead && view.shell.task === 'idle'); assertFourRoots(view, fixture.repositories.bravo); await wd.click(`.repository-row[data-repository-path=${css(fixture.repositories.alpha)}] .repository-name`); view = await wait('Alpha actual reactivation', view => samePath(view.shell.path, fixture.repositories.alpha) && view.shell.task === 'idle'); assertFourRoots(view, fixture.repositories.alpha); assert(view.repositories.find(item => item.current === 'true').branchControl.visible); return archive('08-four-root-navigation'); });
    await step('settings-deep-global-repository-language-theme-state', async () => {
      await openSettings(); const initial = await observe(); assert.deepEqual(initial.settings.sections, ['appearance', 'history', 'files', 'messages', 'tools', 'defaults', 'shortcuts', 'columns', 'about']);
      await editSettings('appearance', { theme: 'dark', language: 'en', localChangesPosition: 'middle', detailPosition: 'bottom' }); await editSettings('defaults', { 'dialogDefaults.pullMode': 'merge', 'dialogDefaults.resetMode': 'keep' }); await editSettings('shortcuts', { 'shortcuts.find': 'Ctrl+Shift+F' }); await editSettings('tools', { discoveryDepth: 2 }); await saveSettings(); await wait('actual dark layout', view => view.theme === 'dark'); assertWideLayout(await observe()); await archive('09-settings-dark');
      await openSettings(); await editSettings('appearance', { theme: 'light', language: 'zh-CN' }); await saveSettings(); const light = await wait('actual zh-CN and light applied', view => view.theme === 'light' && view.locale === 'zh-CN'); assertFourRoots(light, fixture.repositories.alpha); assertWideLayout(light); await archive('10-settings-light-zh');
      await wd.click('.native-titlebar button[aria-label="打开全局设置"]'); await wait('Chinese settings available', view => view.settings.visible); await editSettings('appearance', { language: 'en' }); await saveSettings(); await wait('English language reapplied', view => view.locale === 'en');
      await openSettings('repository'); await editSettings('appearance', { diffView: 'split' }); await saveSettings();
      await openSettings(); await editSettings('appearance', { localChangesPosition: 'inline' }); await saveSettings(); await localTab(); const inline = await wait('actual inline local panel', view => view.local.visible && view.local.inline); assertGroups(inline, gitFacts(run, fixture.repositories.alpha)); await archive('10-inline-local-light');
      await openSettings(); await editSettings('appearance', { localChangesPosition: 'middle' }); await saveSettings(); await wait('actual middle local panel', view => view.local.visible && !view.local.inline);
      await openSettings(); await wd.click('[data-section="about"]'); const about = await wait('native settings diagnostics profile', view => samePath(view.settings.profile, run.profileDirectory)); await wd.click(SELECTORS.settingsClose);
      const state = await readJson(join(run.profileDirectory, 'state.json')); assert.equal(state.settings.language, 'en'); assert.equal(state.settings.theme, 'light'); assert.equal(state.settings.dialogDefaults.resetMode, 'keep'); assert.equal(state.settings.shortcuts.find, 'Ctrl+Shift+F'); assert.equal(state.settings.discoveryDepth, 2); assert.equal(state.repoSettings[about.shell.path ? (await wd.script('return document.querySelector(".app-shell").dataset.repoId;')) : ''].diffView, 'split'); return { settings: state.settings, diagnosticsProfile: about.settings.profile };
    });
    await step('sidebar-real-separator-keyboard-and-collapse', async () => { const before = await observe(); await wd.click(SELECTORS.separator); await wd.keys([KEY.right, KEY.right, KEY.right]); const resized = await wait('real sidebar width changed', view => Math.abs(view.sidebar.width - before.sidebar.width) > 2); await wd.click('.native-titlebar button[aria-label="Collapse repository navigation"]'); await wait('sidebar actually collapsed', view => !view.sidebar); await wd.click('.native-titlebar button[aria-label="Expand repository navigation"]'); const after = await wait('sidebar actually reopened', view => !!view.sidebar); assert(Math.abs(after.sidebar.width - resized.sidebar.width) <= 3); return { before: before.sidebar, resized: resized.sidebar, after: after.sidebar, evidence: await archive('11-sidebar-reopen') }; }, { continueOnFailure: true });
    if (options.suite !== 'smoke') {
      await step('stage-unstage-exact-file-and-group-review-cancel', async () => {
        await localTab(); await mutation('stage-keep-only', () => wd.click(`${localFile('unstaged', fixture.keep)} [data-action="stage-file"]`), (before, after, facts) => { assertIndexOnly(before, after); assert.deepEqual(facts.staged, [fixture.keep, fixture.overlap].sort()); return facts; });
        await mutation('unstage-keep-only', () => wd.click(`${localFile('staged', fixture.keep)} [data-action="unstage-file"]`), (before, after, facts) => { assertIndexOnly(before, after); assert.deepEqual(facts.staged, [fixture.overlap]); return facts; });
        const previous = await repositorySnapshot(run, fixture.repositories.alpha); await wd.click('.ch-group[data-group="unstaged"] [data-action="stage-listed"]'); const review = await wait('literal group path review', view => view.dialogs.some(dialog => dialog.paths.length > 0)); assert.deepEqual(review.dialogs[0].paths.sort(), gitFacts(run, fixture.repositories.alpha).unstaged); await wd.clickText('.ch-confirm footer button', 'Cancel'); await wait('group review cancelled', view => !view.dialogs.length); assertSameSnapshot(previous, await repositorySnapshot(run, fixture.repositories.alpha)); return archive('12-index-writes');
      });
      await step('commit-expected-index-only-not-unstaged-or-untracked', async () => { await localTab(); const message = 'Owned Vue exact index commit'; await wd.fill(SELECTORS.message, message); return mutation('commit-index-only', () => wd.click(SELECTORS.commit), (before, after, facts) => { const path = fixture.repositories.alpha, string = args => readOwned(run, path, args).toString('utf8').trim(); const actual = { parent: string(['show', '-s', '--format=%P', 'HEAD']), message: string(['show', '-s', '--format=%B', 'HEAD']), paths: readOwned(run, path, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD']).toString('utf8').split('\0').filter(Boolean), blob: string(['rev-parse', `HEAD:${fixture.overlap}`]) }; assertCommitOnly(before, after, actual, { path: fixture.overlap, stagedOid: fixture.stagedOid, message }); assert.deepEqual(facts.staged, []); assert(facts.unstaged.includes(fixture.overlap)); assert(facts.untracked.includes(fixture.untracked)); return actual; }); });
      await step('sync-real-local-bare-pull-merge-push', async () => {
        await open(fixture.repositories.sync); await trust(fixture.repositories.sync); const before = await repositorySnapshot(run, fixture.repositories.sync), remoteBefore = await repositorySnapshot(run, fixture.repositories.remote); assertSameSnapshot(accepted.sync, before); assertSameSnapshot(accepted.remote, remoteBefore); const sequence = (await observe()).shell.sequence;
        assert(samePath(readOwned(run, fixture.repositories.sync, ['config', '--get', 'remote.origin.url']).toString('utf8').trim(), fixture.repositories.remote), 'Sync remote must be the exact owned local bare fixture.');
        await wd.click(SELECTORS.sync); await wait('native sync and refresh settled', view => view.shell.task === 'idle' && Number(view.shell.sequence) > Number(sequence), 60_000);
        const next = await repositorySnapshot(run, fixture.repositories.sync), remoteNext = await repositorySnapshot(run, fixture.repositories.remote); const parents = readOwned(run, fixture.repositories.sync, ['show', '-s', '--format=%P', 'HEAD']).toString('utf8').trim().split(' '); assert.deepEqual(parents, [fixture.syncLocal, fixture.syncIncoming]); assert.equal(remoteNext.head, next.head); assert.deepEqual(workingBytes(before).filter(item => item.path !== 'incoming.txt'), workingBytes(next).filter(item => item.path !== 'incoming.txt')); assert.equal(next.status, ''); accepted.sync = next; accepted.remote = remoteNext; mutations.push({ label: 'sync-local-bare', source: 'automated-test', before, after: next, remoteBefore, remoteAfter: remoteNext }); return { head: next.head, parents, remoteHead: remoteNext.head, evidence: await archive('13-sync-local-bare') };
      });
    }
    if (options.suite === 'full') {
      await step('binary-diff-explicit-no-text', async () => { await open(fixture.repositories.alpha); await selectCommit(fixture.review); await openFile('binary.bin'); const view = await wait('explicit binary diff state', view => /二进制|binary/i.test(view.diff.state ?? '')); assert.equal(view.diff.code.length, 0); return archive('14-binary'); });
      await step('repository-open-error-explicit-and-cancel-no-write', async () => { const before = await observe(); await wd.click(SELECTORS.open); await selectOption(wd, SELECTORS.openMode, 'repository'); await wd.fill(SELECTORS.openPath, join(fixture.workspace, 'does-not-exist')); await wd.click(SELECTORS.openSubmit); const error = await wait('actual invalid repository error', view => view.errors.length > 0 && view.shell.task === 'idle', 25_000, { allowErrors: true }); assert(samePath(error.shell.path, before.shell.path)); await archive('15-open-error', { allowErrors: true }); await wd.keys([KEY.escape]); if ((await observe({ allowErrors: true })).errors.length) await wd.click('.notice-strip.error button[aria-label="Dismiss error"]'); await wait('explicit error dismissed', view => !view.errors.length); await wd.click(SELECTORS.open); await wd.fill(SELECTORS.openPath, fixture.repositories.bravo); await wd.keys([KEY.escape]); const after = await wait('open dialog cancelled before action', view => !view.dialogs.length); assert.equal(after.shell.path, before.shell.path); return { errors: error.errors, unchangedPath: after.shell.path }; });
      await step('in-flight-diff-cancel-observed-not-inferred', async () => { await selectCommit(fixture.review); await selectOption(wd, SELECTORS.fileView, 'list'); await wd.click(fileRow(fixture.readPath)); const view = await observe(); if (view.diff.busy !== 'true') throw new BlockedError('Fixture diff finished before a real in-flight cancel control could be observed. Cancellation is not passed by inference.'); await wd.clickText('.dp-state button', 'Cancel'); const cancelled = await wait('actual diff cancelled state', view => /取消|cancel/i.test(view.diff.state ?? '')); return { state: cancelled.diff.state }; }, { allowBlocked: true });
      await step('native-review-only-successfully-loaded-files', async () => {
        await selectCommit(fixture.review); await selectOption(wd, SELECTORS.fileView, 'list');
        await wd.clickText('.ci-actions button', 'Start review');
        await wait('review explicitly active with no inferred marks', view => /Reviewing/.test(view.inspector.footer) && view.inspector.reviewed.length === 0);
        await openFile('binary.bin'); await wait('binary read visible', view => /binary/i.test(view.diff.state ?? ''));
        await historyTab(); let view = await observe(); assert.equal(view.inspector.reviewed.length, 0, 'Binary/unloaded text must not be auto-reviewed.');
        await openFile(fixture.readPath); await mode('unified', fixture.newText.split('\n')[0]); await historyTab();
        view = await wait('only successful real text diff reviewed', view => view.inspector.reviewed.length === 1 && view.inspector.reviewed[0] === fixture.readPath);
        await wd.clickText('.ci-actions button', 'End review'); return archive('14-review-success-only');
      });
      for (const [kind, label] of [['conflict', 'native-sync-conflict-no-push'], ['push-error', 'native-sync-push-error-no-false-success']]) {
        await step(label, async () => {
          const target = fixture.syncNegatives[kind]; await open(target.worktree); await trust(target.worktree);
          const before = await repositorySnapshot(run, target.worktree), remoteBefore = await repositorySnapshot(run, target.remote); assertSameSnapshot(accepted[`${target.prefix}Worktree`], before); assertSameSnapshot(accepted[`${target.prefix}Remote`], remoteBefore);
          await wd.click(SELECTORS.sync);
          const error = await wait('real negative sync stops with visible error', view => view.errors.length > 0 && view.shell.task === 'idle' && view.local.busy === 'false', 60_000, { allowErrors: true });
          const next = await repositorySnapshot(run, target.worktree), remoteNext = await repositorySnapshot(run, target.remote); assertSameSnapshot(remoteBefore, remoteNext, 'Negative sync must not push after conflict/failure.');
          if (kind === 'conflict') { assert.equal(next.head, target.localHead, 'Conflicted merge must not falsely advance HEAD.'); assert(readOwned(run, target.worktree, ['ls-files', '-u']).length > 0, 'Need actual conflicted index stages.'); assert.equal((await readFile(join(next.identity.gitDir, 'MERGE_HEAD'), 'utf8')).trim(), target.incomingHead); }
          else { assert.deepEqual(readOwned(run, target.worktree, ['show', '-s', '--format=%P', 'HEAD']).toString('utf8').trim().split(' '), [target.localHead, target.incomingHead]); assert.equal(next.status, '', 'Successful pull integration must be preserved after push failure.'); }
          accepted[`${target.prefix}Worktree`] = next;
          mutations.push({ label, source: 'automated-test', before, after: next, remoteBefore, remoteAfter: remoteNext, expectedFailureObserved: error.errors });
          await archive(`negative-sync-${kind}`, { allowErrors: true });
          await wd.click('.notice-strip.error button[aria-label="Dismiss error"]');
          if ((await observe({ allowErrors: true })).errors.length) {
            // Component-local expected-error text belongs to this repository.
            // A real repository activation clears that owner; it is not hidden
            // by DOM mutation or accepted as a successful sync.
            await wd.click(SELECTORS.open); await wait('actual open dialog after negative sync', view => view.dialogs.length > 0, 10_000, { allowErrors: true });
            await selectOption(wd, SELECTORS.openMode, 'repository'); await wd.fill(SELECTORS.openPath, fixture.repositories.bravo); await wd.click(SELECTORS.openSubmit);
            await wait('actual repository switch clears previous owner error', view => !view.dialogs.length && samePath(view.shell.path, fixture.repositories.bravo) && view.shell.task === 'idle');
          }
          return { head: next.head, remoteHeadUnchanged: remoteNext.head, errors: error.errors };
        });
      }
      await step('native-sync-inflight-cancel-no-push', async () => {
        const target = fixture.syncNegatives.cancel; await open(target.worktree); await trust(target.worktree);
        const before = await repositorySnapshot(run, target.worktree), remoteBefore = await repositorySnapshot(run, target.remote);
        await wd.click(SELECTORS.sync); await wait('actual guarded sync is running', view => view.shell.task === 'running' && view.local.busy === 'true', 15_000);
        await wd.clickText('.notice-strip button', 'Cancel current task');
        const stopped = await wait('actual sync cancellation settles', view => view.shell.task === 'idle' && view.local.busy === 'false', 45_000, { allowErrors: true });
        assert(stopped.errors.some(message => /cancel/i.test(message)), 'Cancellation must report its real stopped result, not infer success.');
        const next = await repositorySnapshot(run, target.worktree), remoteNext = await repositorySnapshot(run, target.remote); assertSameSnapshot(remoteBefore, remoteNext, 'Cancelled sync must never push.'); assert.equal(next.head, before.head, 'Bounded pre-merge hook cancellation should leave HEAD unchanged; this is observed, not promised rollback.');
        accepted.cancelWorktree = next; mutations.push({ label: 'native-sync-inflight-cancel-no-push', source: 'automated-test', before, after: next, remoteBefore, remoteAfter: remoteNext, cancelledErrors: stopped.errors }); await archive('negative-sync-cancel', { allowErrors: true });
        await wd.click('.notice-strip.error button[aria-label="Dismiss error"]');
        await wd.click(SELECTORS.open); await wait('actual open dialog after sync cancel', view => view.dialogs.length > 0, 10_000, { allowErrors: true }); await selectOption(wd, SELECTORS.openMode, 'repository'); await wd.fill(SELECTORS.openPath, fixture.repositories.alpha); await wd.click(SELECTORS.openSubmit); await wait('actual switch away from cancelled owner', view => !view.dialogs.length && samePath(view.shell.path, fixture.repositories.alpha) && view.shell.task === 'idle');
        return { errors: stopped.errors, head: next.head, remoteHead: remoteNext.head };
      });
      await step('native-diff-read-error-and-retry', async () => {
        const target = fixture.syncNegatives.fault; await open(target.path); await trust(target.path); await selectCommit(target.review); await selectOption(wd, SELECTORS.fileView, 'list');
        const before = await repositorySnapshot(run, target.path); assertSameSnapshot(accepted.fault, before);
        const object = await fingerprint(target.looseObject), objectIdentity = await lstat(target.looseObject); assert(inside(before.identity.gitDir, target.looseObject));
        const quarantine = join(run.output, 'quarantined-loose-blob'); await mkdir(quarantine); const stored = join(quarantine, 'owned-blob');
        const event = { label: 'harness-fault-quarantine-loose-blob', actor: 'harness', source: 'automated-test', at: new Date().toISOString(), repositoryIdentity: before.identity, object, status: 'pending' }; mutations.push(event);
        await rename(target.looseObject, stored); assertSameObjectEntry(objectIdentity, await lstat(stored)); event.status = 'quarantined'; await json(join(run.output, 'accepted-mutations.json'), mutations);
        let error;
        try {
          await wd.click(fileRow('fault.txt'));
          error = await wait('actual missing blob diff error', view => view.diff.visible && view.diff.path === 'fault.txt' && view.diff.busy === 'false' && view.errors.length > 0, 25_000, { allowErrors: true });
          assert.equal(error.diff.code.length, 0);
          assert(error.errors.some(message => /bad object|bad blob|unable to read|could not read|missing|does not exist|not a valid object|invalid object|object.*not found|couldn't resolve|unable to resolve/i.test(message)), 'The observed failure must identify the deliberately missing owned object, not any arbitrary UI error.');
          assert(error.errors.some(message => message.includes(target.oid)), 'Missing-object error must reference this exact quarantined blob OID.');
          await archive('negative-missing-blob', { allowErrors: true });
        } finally {
          assertSameObjectEntry(objectIdentity, await lstat(stored));
          assert.equal((await fingerprint(stored)).sha256, object.sha256, 'Quarantine changed; refuse restoration over unknown bytes.');
          let absent = false; try { await lstat(target.looseObject); } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
          assert(absent, 'The original object path appeared concurrently; retain quarantine and never overwrite it.');
          // Copy with an exclusive create instead of rename-overwrite: a racing
          // writer can never have its object replaced by the recovery path.
          await writeFile(target.looseObject, await readFile(stored), { flag: 'wx' }); event.status = 'restored-exclusive'; event.restoredAt = new Date().toISOString();
          assert.equal((await fingerprint(target.looseObject)).sha256, object.sha256); await json(join(run.output, 'accepted-mutations.json'), mutations);
        }
        await wd.clickText('.dp-state button', 'Retry');
        await wait('real diff retry succeeds after exact object restoration', view => view.diff.path === 'fault.txt' && view.diff.busy === 'false' && view.diff.code.join('\n').includes('Dedicated missing-object diff target'), 25_000, { allowErrors: true });
        await dismissExpectedErrors(); assertSameSnapshot(before, await repositorySnapshot(run, target.path)); return { expectedError: error.errors, restoredObjectSha256: object.sha256, evidence: await archive('negative-missing-blob-retry') };
      });
      await step('native-working-stale-expected-index-rejection', async () => {
        const target = fixture.syncNegatives.fault; await wd.click('.workbench-tabs > button:nth-child(2)'); await wait('dedicated stale-index local panel', view => view.local.visible && view.shell.task === 'idle');
        await wd.click(`${localFile('unstaged', target.stalePath)} [data-action="discard-file"]`);
        const review = await wait('destructive intent captured before index mutation', view => view.dialogs.some(dialog => dialog.expected === 'discard'));
        assert(review.dialogs[0].paths.includes(target.stalePath)); await wd.fill('.ch-confirm input[name="confirmation"]', 'discard');
        await faultStageIndex(target.path);
        // Give the real watcher a bounded opportunity to invalidate the old
        // lease; do not manufacture or assume a rejection. If the dialog still
        // owns an enabled confirmation, submit it through the real UI and
        // require an explicit rejection with no additional bytes/index changes.
        let stopped;
        try { stopped = await wait('same-XY index fingerprint invalidates intent', view => view.dialogs.length === 0 || view.errors.length > 0 || view.dialogs.some(dialog => dialog.confirmDisabled === true), 5000, { allowErrors: true }); }
        catch (error) { if (!error.message.startsWith('Timed out')) throw error; await wd.click('.ch-confirm [data-action="confirm-discard"]'); stopped = await wait('same-XY stale confirmation explicitly rejected', view => view.errors.length > 0 || view.dialogs.length === 0, 15_000, { allowErrors: true }); }
        assertSameSnapshot(accepted.fault, await repositorySnapshot(run, target.path), 'Stale destructive intent must not mutate beyond the explicit harness index replacement.');
        if (stopped.dialogs.length) await wd.clickText('.ch-confirm footer button', 'Cancel'); await dismissExpectedErrors();
        await open(fixture.repositories.bravo); await open(target.path); return { expectedStaleStop: true, errors: stopped.errors, harnessMutation: 'harness-fault-stage-literal-index-path' };
      });
      await step('native-gitlink-snapshot-rejection', async () => {
        const target = fixture.syncNegatives.fault; await wd.click('.workbench-tabs > button:nth-child(2)'); await wait('dirty gitlink listed', view => view.local.visible && view.local.files.some(item => item.path === 'fault-module' && item.group === 'unstaged'));
        const before = await repositorySnapshot(run, target.path), childBefore = await repositorySnapshot(run, fixture.repositories.faultModule);
        const disabled = await wd.script('return document.querySelector(arguments[0])?.disabled;', [`${localFile('unstaged', 'fault-module')} [data-action="stage-file"]`]);
        if (!disabled) await wd.click(`${localFile('unstaged', 'fault-module')} [data-action="stage-file"]`);
        else await wd.click('.ch-group[data-group="unstaged"] [data-action="stage-listed"]');
        const blocked = await wait('gitlink staging explicitly rejected by native/controller guard', view => view.errors.some(message => /submodule|gitlink|child HEAD.*unchanged|dirty child/i.test(message)), 15_000, { allowErrors: true });
        assertSameSnapshot(before, await repositorySnapshot(run, target.path)); assertSameSnapshot(childBefore, await repositorySnapshot(run, fixture.repositories.faultModule));
        await archive('negative-gitlink', { allowErrors: true }); await dismissExpectedErrors(); await open(fixture.repositories.alpha); return { disabledSinglePath: disabled, blocked: blocked.errors };
      });
      for (const scenario of PENDING_FULL_SCENARIOS) await step(scenario, async () => { throw new BlockedError('This release scenario has not yet been implemented in the Vue WebDriver fixture runner. It was not executed and is not passed by another suite.'); }, { allowBlocked: true });
    }
    await step('native-titlebar-actual-maximize-restore-minimize', async () => {
      await wd.call('POST', `${wd.prefix}/window/rect`, { width: 1455, height: 950 }); let windows = await nativeWindow(); assert.equal(windows.length, 1); assert.equal(windows[0].maximized, false); const baseline = windows[0];
      await wd.click(SELECTORS.maximize); const maximized = await until('native IsZoomed after titlebar maximize', async () => { const items = await nativeWindow(); return items.length === 1 && items[0].maximized ? items[0] : false; }, { timeout: 12_000 });
      await wd.click(SELECTORS.maximize); const restored = await until('native IsZoomed after titlebar restore', async () => { const items = await nativeWindow(); return items.length === 1 && !items[0].maximized ? items[0] : false; }, { timeout: 12_000 }); assert(Math.abs(restored.rect.width - baseline.rect.width) <= 2);
      await archive('16-window-restored'); await wd.click(SELECTORS.minimize); const minimized = await until('native IsIconic after titlebar minimize', async () => { const items = await nativeWindow(); return items.length === 1 && items[0].minimized ? items[0] : false; }, { timeout: 12_000 });
      await wd.call('POST', `${wd.prefix}/window/maximize`, {}); await wd.call('POST', `${wd.prefix}/window/rect`, { width: 1455, height: 950 }); const returned = await until('native window restored by driver', async () => { const items = await nativeWindow(); return items.length === 1 && !items[0].minimized ? items[0] : false; }, { timeout: 12_000 }); return { baseline, maximized, restored, minimized, returned };
    });
    await step('native-profile-reopen-restores-settings-trust-sidebar', async () => {
      // Persist the actual directory/sidebar owner before restart. A single
      // repository intentionally has no directory-scope width preference.
      await open(fixture.repositories.alpha); await open(fixture.root, 'directory', 1);
      // Establish a measured user-chosen width for this exact directory owner,
      // then require the persisted file to contain that same pixel width before
      // deleting the session. A scope default alone is not resize evidence.
      await wd.click(SELECTORS.separator); await wd.keys([KEY.right]);
      const baselineView = await observe();
      await until('actual directory sidebar width flushed before restart', async () => { const state = await readJson(join(run.profileDirectory, 'state.json')); return samePath(state.directoryScope?.root, fixture.root) && Math.abs(state.directoryScope.width - baselineView.sidebar.width) <= 3 ? state : false; }, { timeout: 10_000 });
      const before = await observe(); const beforeNativeRect = await wd.call('GET', `${wd.prefix}/window/rect`); await wd.click('.usage-recorder > summary'); await wd.clickText('.usage-actions button', 'Stop'); await wait('automated usage session explicitly stopped', view => view.usage.status?.startsWith('Stopped')); await wd.click('.usage-close'); await archive('17-before-reopen');
      const oldSession = { ...run.manifest.session, closedAt: new Date().toISOString() };
      await wd.call('DELETE', wd.prefix); wd.sessionId = null; run.manifest.session = null; (run.manifest.sessions ??= []).push(oldSession); lastSequence = undefined; await run.save();
      const session = await wd.call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: run.manifest.binary.path, args: [`--profile-dir=${run.profileDirectory}`], webviewOptions: { userDataFolder: run.manifest.webviewDataDirectory } } } } }, 90_000); wd.sessionId = session.sessionId; assert(wd.sessionId); assert.notEqual(wd.sessionId, oldSession.id); run.manifest.session = { id: wd.sessionId, endpoint: wd.endpoint, capabilities: session.capabilities, createdAt: new Date().toISOString(), restartedFrom: oldSession.id, args: oldSession.args, webviewOptions: oldSession.webviewOptions }; await owned.snapshot(); await run.save();
      await wd.call('POST', `${wd.prefix}/window/rect`, { width: beforeNativeRect.width, height: beforeNativeRect.height, x: beforeNativeRect.x, y: beforeNativeRect.y });
      const after = await wait('same native isolated profile reopened', view => view.shell.task === 'idle' && samePath(view.shell.path, before.shell.path), 60_000); assert.equal(after.theme, 'light'); assert.equal(after.locale, 'en'); assert.equal(after.trust.trusted, true); assert.equal(after.viewport.width, before.viewport.width, 'Restart width comparison requires the same real viewport.'); assert.equal(after.viewport.height, before.viewport.height); assert.equal(after.viewport.dpr, before.viewport.dpr, 'Restart width comparison requires the same real DPI.'); if (before.sidebar && after.sidebar) assert(Math.abs(after.sidebar.width - before.sidebar.width) <= 3); assertFourRoots(after, after.shell.path); assert.equal((await fingerprint(options.binary)).sha256, run.manifest.binary.sha256); return archive('18-reopened');
    }, { continueOnFailure: true });
    await step('native-titlebar-close-actual-window-exit', async () => { await wd.click(SELECTORS.close); const exited = await until('owned application native window actually closed', async () => (await nativeWindow()).length === 0, { timeout: 15_000 }); return { nativeWindowClosed: exited, source: 'automated-test' }; });
  } catch (error) { failure = error; run.manifest.error = errorInfo(error); run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; }
  finally {
    wd ??= run.webDriver;
    // Failure evidence is captured before cleanup, including startDesktop failures.
    // This preserves the actual session rather than inventing a missing screenshot.
    if (wd?.sessionId && (failure || options.only)) {
      try { await archiveDesktop(run, wd, 'failure'); } catch (error) { cleanupErrors.push({ phase: 'archive', ...errorInfo(error) }); }
      try {
        let view = await wd.script(READ_VUE_DOM);
        if (/^(Recording|Paused)|正在记录|已暂停/.test(view.usage.status ?? '')) {
          // Close only run-owned UI modals before a real Stop click. Never invoke
          // the native recorder directly, rewrite JSONL, or relabel the failure.
          for (let count = 0; count < 3 && view.dialogs.length; count++) { await wd.keys([KEY.escape]); view = await wd.script(READ_VUE_DOM); }
          if (!view.usage.open) await wd.click('.usage-recorder > summary');
          await wd.clickText('.usage-actions button', view.locale === 'zh-CN' ? '结束' : 'Stop');
          await until('failure usage explicit stop', async () => { const current = await wd.script(READ_VUE_DOM); return /^(Stopped)|已结束/.test(current.usage.status ?? '') && !/Saving|保存/.test(current.usage.status) ? current : false; }, { timeout: 5000 });
          run.manifest.failureUsageStop = { status: 'stopped', source: 'automated-test', businessResult: failure ? 'failed' : 'subset-only' };
        }
      } catch (error) { run.manifest.failureUsageStop = { status: 'not-confirmed', source: 'automated-test', error: errorInfo(error) }; }
    }
    if (wd?.sessionId) { try { await wd.call('DELETE', wd.prefix, undefined, 12_000); if (run.manifest.session) run.manifest.session.closedAt = new Date().toISOString(); } catch (error) { run.manifest.sessionCloseError = errorInfo(error); } wd.sessionId = null; }
    if (monitor) try { await monitor.stop(); } catch (error) { cleanupErrors.push({ phase: 'monitor', ...errorInfo(error) }); }
    try { run.manifest.cleanup = await owned.cleanup(); if (run.manifest.cleanup.remaining?.length || run.manifest.cleanup.errors?.length) throw new Error('Exact owned process cleanup was incomplete.'); } catch (error) { cleanupErrors.push({ phase: 'owned-cleanup', ...errorInfo(error) }); }
    if (fixture) {
      try {
        const directory = join(run.profileDirectory, 'usage');
        const files = (await readdir(directory)).filter(name => name.endsWith('.jsonl'));
        run.manifest.usageLogs = [];
        for (const name of files) {
          const records = (await readFile(join(directory, name), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
          const verified = assertUsageRecords(records, run.manifest.binary.sha256, [run.profileDirectory, fixture.workspace, ...Object.values(fixture.repositories), fixture.oldText.split('\n')[0], fixture.newText.split('\n')[0], 'Owned Vue draft 中文', 'Owned Vue exact index commit']);
          run.manifest.usageLogs.push({ ...verified, file: `profile/usage/${name}`, sha256: sha256(await readFile(join(directory, name))) });
        }
        if (run.manifest.results.some(result => result.label === 'native-usage-explicit-automated-source' && result.status === 'passed')) assert(files.length > 0, 'Native usage start passed but no log was saved.');
      } catch (error) { run.manifest.usageValidationError = errorInfo(error); if (!failure) run.manifest.status = 'failed'; }
      const after = {};
      try { for (const [name, path] of Object.entries(fixture.repositories)) after[name] = await repositorySnapshot(run, path); await json(join(run.output, 'repository-after.json'), after); for (const name of Object.keys(accepted)) assertSameSnapshot(accepted[name], after[name], `final integrity ${name}`); run.manifest.integrity = { status: 'passed', repositories: Object.keys(after), acceptedMutations: mutations.length }; }
      catch (error) { run.manifest.integrity = { status: 'failed', error: errorInfo(error) }; run.manifest.status = 'failed'; }
    }
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    run.manifest.cleanupErrors = cleanupErrors; if (cleanupErrors.length) run.manifest.status = 'failed';
    run.manifest.coverage = coverageFor(options.suite, run.manifest.results, { assisted: Boolean(run.manifest.vue.assistedLocalResize) });
    if (run.manifest.status === 'running') run.manifest.status = resultStatus(run.manifest.results);
    if (run.manifest.status === 'passed' && (run.manifest.coverage.missing.length || run.manifest.coverage.duplicates.length || run.manifest.coverage.failed.length)) run.manifest.status = 'failed';
    if (run.manifest.status === 'passed' && run.manifest.coverage.blocked.length) run.manifest.status = 'blocked';
    run.manifest.finishedAt = new Date().toISOString(); await run.save();
    await json(join(run.output, 'report.json'), { schemaVersion: 1, kind: 'vue-desktop', startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt, source: 'automated-test', status: run.manifest.status, suite: options.suite, scenarioFilter: options.only ?? null, assisted: Boolean(run.manifest.vue.assistedLocalResize), coverage: run.manifest.coverage, binary: run.manifest.binary, results: run.manifest.results, integrity: run.manifest.integrity, usageLogs: run.manifest.usageLogs, usageValidationError: run.manifest.usageValidationError, failureUsageStop: run.manifest.failureUsageStop, cleanup: run.manifest.cleanup, cleanupErrors, limitations: run.manifest.vue.limitations, error: run.manifest.error });
    console.log(`${run.manifest.status.toUpperCase()} ${join(run.output, 'report.json')}`); process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
  }
  return run.manifest;
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.stack ?? error); process.exitCode = error instanceof BlockedError ? 2 : 1; });
