import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  REQUIRED_VERSION, RUN_BUDGET_MS, SELECTORS, OBSERVATIONS, SCOPE,
  assertDiagnostics, assertLanguageControl, assertTree, assertNoDiscoveryActivation,
  assertActive, assertWorking, assertHonestTransient, assertPreserved,
  assertLayout, assertSidebarFocus, assertNativeRect, assertFixtureSnapshots, selectOption, treeKey, unsupportedDriver,
} from '../test-navigation-desktop.mjs';

// Pure contract/assertion tests only. These values are not desktop evidence;
// importing the runner must not launch processes, touch a profile, or create Git fixtures.
const oid = character => character.repeat(40);
const path = name => resolve('owned-test-workspace', name);
const fixture = (patch = {}) => ({ path: path('alpha'), head: oid('a'), key: 'Alpha', branch: 'alpha-main', bare: false,
  counts: { changed: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 }, tracking: { kind: 'counts', upstream: 'origin/alpha-main', ahead: 1, behind: 0 }, ...patch });
const description = '2 distinct changed paths; 1 staged, 1 tracked unstaged, 1 untracked, 0 unmerged. A tracked file may be both staged and unstaged; categories are not additive.';
const tracking = 'origin/alpha-main: 1 ahead, 0 behind, compared with the locally observed upstream ref. No network check was made.';
function active(f = fixture()) {
  return { errors: [], shell: { repoPath: f.path, head: f.head, taskState: 'idle', sequence: 3 },
    tree: { rows: [{ key: f.key, active: true, opening: false }] },
    footer: { state: 'ready', workingState: 'changed', stale: 'false', branch: f.branch, locationHidden: true,
      trackingState: 'counts', summary: '2 changed', summaryTitle: description, counts: '1 staged · 1 unstaged · 1 untracked', countsHidden: false,
      tracking: '↑1 ↓0', trackingTitle: tracking, facts: {} } };
}
function selected() {
  return { shell: { repoPath: path('alpha'), head: oid('a') },
    view: { selectedOids: [oid('a')], activeDescendant: `commit-${oid('a')}`, detailOpen: true, detailOid: oid('a'), subject: 'Actual fixture subject',
      selectedFile: 'summary.txt', filePath: 'summary.txt', mode: 'bottom', graphOids: [oid('a'), oid('b')],
      graphTop: 84, graphLeft: 0, diffTop: 140, diffLeft: 0, filesTop: 0, metadataTop: 0, diffReady: true } };
}
const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height, clientWidth: width, scrollWidth: width });
function layout() {
  const footer = box(0, 652, 744, 28);
  return { viewport: { width: 744, height: 680 }, document: { clientWidth: 744, scrollWidth: 744, bodyScrollWidth: 744 }, theme: 'light', locale: 'en', mode: 'bottom',
    footer, footerItems: [{ name: 'statusbar-branch', ...box(7, 654, 110, 24) }], footerControls: { details: box(712, 654, 25, 24), language: box(680, 654, 25, 24) },
    sidebar: box(0, 80, 236, 572), tree: box(0, 80, 236, 572), treeRows: box(0, 180, 236, 472), rowBounds: [box(0, 180, 236, 28)],
    workspace: box(242, 80, 502, 572), details: box(242, 300, 502, 352), inline: false };
}
function snapshot() {
  return { identity: { path: path('alpha'), gitDir: path('alpha/.git'), bare: false }, head: oid('a'), headFile: { bytes: 21, sha256: 'a'.repeat(64) },
    index: { bytes: 100, sha256: 'b'.repeat(64) }, status: Buffer.from('1 MM tracked\0? untracked\0').toString('base64'),
    tracked: [{ path: 'tracked', mode: '100644', oid: oid('b'), stage: '0', working: { bytes: 12, sha256: 'c'.repeat(64) } }],
    untracked: [{ path: 'untracked', working: { bytes: 10, sha256: 'd'.repeat(64) } }], refs: [`refs/heads/alpha-main ${oid('a')} commit`], commonDir: path('alpha/.git') };
}

test('approved runner version, bounded work budget and actual-only scope', () => {
  assert.equal(REQUIRED_VERSION, '0.3.0'); assert(RUN_BUDGET_MS > 0 && RUN_BUDGET_MS <= 600_000);
  for (const text of ['Actual supplied Windows', 'no browser demo', 'Git-read-only', 'No actual WSL', 'never counted as passes']) assert(SCOPE.includes(text));
});
test('candidate diagnostics require readVersion, Windows, actual Git and isolated profile', () => {
  const profile = path('profile'); const view = { errors: [], shell: { configDirectory: profile }, settings: { installed: 'Installed version: 0.3.0', about: {
    'App version': '0.3.0', Platform: 'windows x86_64', 'Git version': 'git version 2.52.0.windows.1', 'Git path': path('tools/git.exe'), 'Configuration directory': profile,
  } } };
  assertDiagnostics(view, { version: REQUIRED_VERSION }, profile);
  for (const [field, value] of [['App version', '0.2.9'], ['Platform', 'browser · desktop host required'], ['Git version', 'Unavailable'], ['Git path', 'Unavailable'], ['Configuration directory', path('other-profile')]]) {
    const invalid = structuredClone(view); invalid.settings.about[field] = value; assert.throws(() => assertDiagnostics(invalid, { version: REQUIRED_VERSION }, profile));
  }
  assert.throws(() => assertDiagnostics(view, { version: '0.4.0' }, profile));
  assert.throws(() => assertDiagnostics({ ...view, errors: ['Git failure'] }, { version: REQUIRED_VERSION }, profile));
});
test('Settings language is a global header select with real supported options', () => {
  const view = { settings: { open: true, language: { header: true, name: 'language', setting: 'language', disabled: false, value: 'en', options: [
    { value: 'system', label: 'Follow system' }, { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' },
  ] } } };
  assertLanguageControl(view, 'en');
  for (const patch of [{ header: false }, { disabled: true }, { value: 'system' }, { name: 'locale' }, { setting: 'theme' }, { options: [{ value: 'en', label: 'English' }] }]) assert.throws(() => assertLanguageControl({ settings: { ...view.settings, language: { ...view.settings.language, ...patch } } }, 'en'));
});
test('select actions click the actual select before its actual option, never script an event', async () => {
  const calls = []; await selectOption({ async click(selector) { calls.push(selector); } }, SELECTORS.language, 'zh-CN');
  assert.deepEqual(calls, [SELECTORS.language, `${SELECTORS.language} > option[value="zh-CN"]`]);
  assert.equal(calls.length, 2); assert(SELECTORS.openDirectoryPath.includes('open-directory-by-path')); assert(SELECTORS.confirmDirectory.includes('confirm-open-directory'));
});
test('tree component keys preserve native components, spaces and Unicode without private paths', () => {
  assert.equal(treeKey(['Alpha 中文', 'nested', 'B with spaces']), 'Alpha%20%E4%B8%AD%E6%96%87/nested/B%20with%20spaces');
  assert.equal(treeKey([]), ''); assert.notEqual(treeKey(['a/b']), treeKey(['a', 'b']));
});
test('structural tree requires exact root, ancestors, marker titles and honest completeness', () => {
  const root = path('multi'), candidatePath = path('multi/Alpha'), rows = [{ key: '', label: 'multi', level: 1, candidate: false }, { key: 'Alpha', label: 'Alpha', level: 2, candidate: true }];
  const fixtures = { root, name: 'multi', depth: 3, rows, candidates: [{ key: 'Alpha', path: candidatePath, marker: 'git-directory' }] };
  const view = { errors: [], tree: { visible: true, root, busy: 'false', depth: '3', partial: false, error: false, count: '1', rescanDisabled: false, cancelVisible: false, status: 'Scan complete. 1 repositories found.', rows: rows.map(row => ({ ...row, title: row.candidate ? `${candidatePath}\nGit directory marker` : root })) } };
  assertTree(view, fixtures);
  for (const patch of [{ visible: false }, { root: path('other') }, { busy: 'true' }, { depth: '2' }, { partial: true }, { error: true }, { count: '1+' }, { rescanDisabled: true }, { cancelVisible: true }, { status: 'Partial scan.' }, { rows: [view.tree.rows[1]] }]) assert.throws(() => assertTree({ ...view, tree: { ...view.tree, ...patch } }, fixtures));
  const empty = { ...view, tree: { ...view.tree, depth: '0', count: '0', status: 'No repositories found at this depth.', rows: [view.tree.rows[0]] } }; assertTree(empty, fixtures, { empty: true });
});
test('discovery cannot count auto-open, trust, or synthetic recents as a successful result', () => {
  const view = { shell: { repoPath: '', head: '', taskState: 'idle' }, tree: { rows: [{ active: false, opening: false }] }, recents: [], footer: { state: 'empty', workingState: 'none', summary: 'No repository' } };
  const state = { recent: [], trusted: [], lastRepo: null }; assertNoDiscoveryActivation(view, state);
  assert.throws(() => assertNoDiscoveryActivation(view, { ...state, trusted: [path('alpha')] }));
  assert.throws(() => assertNoDiscoveryActivation(view, { ...state, recent: [{ path: path('alpha') }] }));
  assert.throws(() => assertNoDiscoveryActivation({ ...view, shell: { ...view.shell, repoPath: path('alpha') } }, state));
  assert.throws(() => assertNoDiscoveryActivation({ ...view, tree: { rows: [{ active: true }] } }, state));
});
test('actual activation requires distinct actual head, active tree candidate and idle Windows status', () => {
  assertActive(active(), fixture());
  for (const patch of [{ repoPath: path('bravo') }, { head: oid('b') }, { taskState: 'running' }]) assert.throws(() => assertActive({ ...active(), shell: { ...active().shell, ...patch } }, fixture()));
  const bad = active(); bad.tree.rows.push({ key: 'Bravo', active: true }); assert.throws(() => assertActive(bad, fixture()));
});
test('overlapping dirty counts are distinct-path counts, not category sums or visible-file counts', () => {
  assertWorking(active(), fixture());
  for (const patch of [{ summary: '3 changed' }, { summary: 'Clean' }, { counts: '1 staged · 2 unstaged · 1 untracked' }, { stale: 'true' }, { summaryTitle: '3 changed files' }, { branch: 'bravo-main' }]) assert.throws(() => assertWorking({ ...active(), footer: { ...active().footer, ...patch } }, fixture()));
});
test('tracking is the locally returned measurement with explicit no-network wording', () => {
  assertWorking(active(), fixture());
  for (const patch of [{ trackingState: 'no-upstream' }, { tracking: '↑0 ↓0' }, { trackingTitle: 'Up to date' }, { trackingTitle: 'origin/alpha-main: 1 ahead, 0 behind' }]) assert.throws(() => assertWorking({ ...active(), footer: { ...active().footer, ...patch } }, fixture()));
});
test('bare is not clean and has neither fabricated zero counts nor upstream measurement', () => {
  const f = fixture({ bare: true, tracking: { kind: 'unknown' } }), view = active(f);
  Object.assign(view.footer, { workingState: 'bare', trackingState: 'unknown', summary: 'Bare · no worktree', countsHidden: true, counts: '', tracking: 'Tracking unknown', trackingTitle: 'Tracking unknown' });
  assertWorking(view, f);
  for (const patch of [{ summary: 'Clean' }, { countsHidden: false }, { counts: '0 staged · 0 unstaged · 0 untracked' }, { tracking: '↑0 ↓0' }]) assert.throws(() => assertWorking({ ...view, footer: { ...view.footer, ...patch } }, f));
});
test('full status facts must match actual path, branch and unfiltered counts', () => {
  const view = active(); view.footer.facts = Object.fromEntries(Object.entries({ path: fixture().path, branch: 'alpha-main', working: '2 changed', counts: description, tracking, history: 'No more pages. Loaded count is not a repository-wide total.', git: 'git version 2.52.0' }).map(([name, value]) => [name, { value, hidden: false }]));
  assertWorking(view, fixture(), { facts: true });
  const bad = structuredClone(view); bad.footer.facts.counts.value = '1 filtered path'; assert.throws(() => assertWorking(bad, fixture(), { facts: true }));
});
test('unknown/loading/error cannot imply clean or zero divergence, and stale counts must say previous', () => {
  for (const workingState of ['unknown', 'loading', 'error']) {
    const unknown = { workingState, stale: 'false', summary: 'Working tree unknown', countsHidden: true, tracking: 'Tracking unknown' }; assertHonestTransient(unknown);
    for (const patch of [{ summary: 'Clean' }, { summary: '干净' }, { countsHidden: false }, { tracking: '↑0 ↓0' }]) assert.throws(() => assertHonestTransient({ ...unknown, ...patch }));
  }
  const stale = { workingState: 'changed', stale: 'true', summary: 'Previous: 2 changed', summaryTitle: `Previous snapshot · ${description}` }; assertHonestTransient(stale);
  assert.throws(() => assertHonestTransient({ ...stale, summary: '2 changed' })); assert.throws(() => assertHonestTransient({ ...stale, summaryTitle: description }));
});
test('language and repo restoration compare exact immutable selection, file and actual scroll offsets', () => {
  const before = selected(); assertPreserved(before, structuredClone(before));
  for (const [key, value] of [['detailOid', oid('b')], ['selectedFile', 'note.txt'], ['filePath', 'note.txt'], ['mode', 'right'], ['activeDescendant', null], ['graphTop', 0], ['diffTop', 0], ['graphOids', [oid('b')]], ['selectedOids', []]]) {
    const after = structuredClone(before); after.view[key] = value; assert.throws(() => assertPreserved(before, after), `Accepted lost ${key}`);
  }
  const missing = structuredClone(before); missing.view.diffReady = false; assert.throws(() => assertPreserved(missing, before));
});
test('layout fails closed for footer/tree overflow, unbounded sidebar and fake inline detail slot', () => {
  assertLayout(layout(), { theme: 'light', mode: 'bottom' });
  const mutations = [l => { l.footer.scrollWidth++; l.footer.scrollWidth += 10; }, l => { l.footer.height = 60; }, l => { l.footer.right += 15; }, l => { l.footerItems[0].right = 900; }, l => { l.footerControls.details = null; }, l => { l.treeRows.scrollWidth = 500; }, l => { l.sidebar.width = 500; }, l => { l.rowBounds[0].right = 500; }, l => { l.document.scrollWidth = 900; }, l => { l.inline = true; }, l => { l.details = null; }];
  for (const mutate of mutations) { const invalid = layout(); mutate(invalid); assert.throws(() => assertLayout(invalid, { theme: 'light', mode: 'bottom' })); }
  assert.throws(() => assertLayout(layout(), { theme: 'dark', mode: 'bottom' }));
});
test('sidebar keyboard assertions require actual clicked separator focus, not hover or assumed focus', () => {
  const view = { focus: { tag: 'DIV', role: 'separator', label: 'Resize repository navigation', classes: ['resize-handle', 'vertical'], isSidebarSeparator: true }, sidebarSeparator: { visible: true, value: '240', minimum: '180', maximum: '420' } };
  assertSidebarFocus(view);
  for (const patch of [{ isSidebarSeparator: false }, { tag: 'BODY' }, { role: 'treeitem' }, { classes: ['repository-tree-row'] }]) assert.throws(() => assertSidebarFocus({ ...view, focus: { ...view.focus, ...patch } }));
  for (const patch of [{ visible: false }, { minimum: '0' }, { value: 'unknown' }, { maximum: 'unknown' }]) assert.throws(() => assertSidebarFocus({ ...view, sidebarSeparator: { ...view.sidebarSeparator, ...patch } }));
});
test('native widths must be actual driver rectangles, not injected CSS viewport sizes', () => {
  assertNativeRect({ width: 760, height: 680 }, 760); assertNativeRect({ width: 1280, height: 820 }, 1280);
  for (const rect of [undefined, { width: 1280, height: 680 }, { width: 760 }, { width: '760', height: 680 }]) assert.throws(() => assertNativeRect(rect, 760));
  assert(unsupportedDriver(new Error('unsupported operation'))); assert(unsupportedDriver(new Error('unknown command: window rect'))); assert(!unsupportedDriver(new Error('element click intercepted')));
});
test('integrity compares the complete owned scope including worktree common identity and all raw snapshots', () => {
  const before = { alpha: snapshot(), linked: snapshot() }; before.linked.identity.gitDir = path('alpha/.git/worktrees/linked');
  const after = structuredClone(before); assert.deepEqual(assertFixtureSnapshots(before, after), ['alpha', 'linked']);
  for (const key of ['head', 'headFile', 'index', 'status', 'tracked', 'untracked', 'refs', 'commonDir', 'identity']) {
    const changed = structuredClone(after); changed.linked[key] = key === 'head' ? oid('f') : key === 'commonDir' ? path('different-common') : null;
    assert.throws(() => assertFixtureSnapshots(before, changed), `Accepted modified ${key}`);
  }
  assert.throws(() => assertFixtureSnapshots(before, { alpha: snapshot() })); assert.throws(() => assertFixtureSnapshots(null, null));
});
test('every embedded browser observation compiles and cannot mutate the DOM or invoke product business APIs', async () => {
  for (const [name, script] of Object.entries(OBSERVATIONS)) {
    assert.doesNotThrow(() => Function(script), name);
    for (const forbidden of ['__TAURI', 'dispatchEvent', 'fetch(', 'XMLHttpRequest', '.click(', '.focus(', '.scrollTo(', '.scrollBy(', '.value =', '.scrollTop =', '.innerHTML', 'setAttribute(', 'appendChild(', 'localStorage', 'sessionStorage', 'window.App', 'window.Host', 'invoke(']) assert(!script.includes(forbidden), `${name} contains forbidden observation: ${forbidden}`);
  }
  const source = await readFile(new URL('../test-navigation-desktop.mjs', import.meta.url), 'utf8');
  assert(!source.includes('0.2.2')); assert(!/[A-Za-z]:[\\/]Users[\\/]|D:[\\/]projects[\\/]/i.test(source), 'No actual private executable/source/profile path may be hardcoded.');
  assert(source.includes('if (isMain(import.meta.url)) await main()'));
  assert(source.includes('await readVersion(PROJECT)')); assert(source.includes('await repositorySnapshot(run, path)')); assert(source.includes('await startDesktop(run, options, owned)'));
  assert(!/\b(?:execSync|spawn|execFileSync)\s*\(/.test(source), 'Process launch must stay in the shared owned harness.');
  assert(!/\.script\s*\(\s*['"`]/.test(source), 'Browser script payloads must be exported read-only observations, not ad-hoc executable actions.');
  const main = source.slice(source.indexOf('async function main()'));
  assert(!/git(?:Text)?\(run,/.test(main), 'After fixture construction and before/after snapshot helpers, acceptance/teardown cannot write Git.');
  assert(source.includes('await owned.cleanup()'));
  assert(source.includes("await json(join(run.output, 'repository-before.json'), before)"));
  assert(source.includes("await json(join(run.output, 'repository-after.json'), after)"));
});
