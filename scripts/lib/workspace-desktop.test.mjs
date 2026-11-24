import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  RUN_BUDGET_MS, NATIVE_WIDTHS, THEMES, SCOPE, SELECTORS, OBSERVATIONS,
  parseChangeCounter, expectedMinimalScroll, assertMinimalNavigation, assertToolbars, assertRowControls,
  assertLocalGroups, assertDraft, assertGraphRestored, assertIndexOnly, assertCommitOnly, assertDeleteOnly,
  assertLayout, realChord, navigationText,
} from '../test-workspace-desktop.mjs';

// Pure helper contracts only: these synthetic objects are never native desktop evidence.
// Importing the runner cannot launch processes, write profiles, create fixtures, or read a real repository.
const oid = letter => letter.repeat(40);
const path = value => resolve('owned-pure-workspace', value);
const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height, clientWidth: width, clientHeight: height, scrollWidth: width, scrollHeight: height });
const scroll = (top = 0, height = 400, totalHeight = 3000) => ({ top, left: 0, height, width: 600, totalHeight, totalWidth: 600 });
function snapshot() {
  return { identity: { path: path('alpha'), gitDir: path('alpha/.git'), bare: false }, head: oid('a'), headFile: { bytes: 27, sha256: '1'.repeat(64) },
    index: { bytes: 100, sha256: '2'.repeat(64) }, status: 'actual-base64-NUL-status',
    tracked: [{ path: 'overlap', mode: '100644', oid: oid('b'), stage: '0', working: { bytes: 12, sha256: '3'.repeat(64) } }, { path: 'keep', mode: '100644', oid: oid('c'), stage: '0', working: { bytes: 24, sha256: '4'.repeat(64) } }],
    untracked: [{ path: 'delete 中文.txt', working: { bytes: 11, sha256: '5'.repeat(64) } }, { path: 'keep.txt', working: { bytes: 14, sha256: '6'.repeat(64) } }],
    refs: [`refs/heads/alpha-main ${oid('a')} commit`, `refs/remotes/origin/main ${oid('c')} commit`] };
}
function selection() {
  return { shell: { repoPath: path('alpha'), head: oid('a') },
    local: { message: { value: 'Draft local\n中文', start: 7, end: 10, direction: 'backward', scrollTop: 14 } },
    graph: { visible: true, selected: [oid('b')], activeDescendant: `commit-${oid('b')}`, scroll: scroll(420) },
    history: { visible: false }, tree: { scroll: scroll(120) },
    details: { oid: oid('b'), selectedFile: 'review/summary.txt', filesScroll: scroll(83) } };
}
function navigation(top, active = 1, blocks = [{ id: 'first', top: 100, bottom: 160 }, { id: 'second', top: 950, bottom: 1010 }]) {
  return { history: { path: 'review/nav.txt', counter: `Change ${active} of ${blocks.length}`, activeId: blocks[active - 1].id, blocks, lineHeight: 20, scroll: scroll(top) } };
}
function rowControls() {
  return { candidate: true, branch: 'alpha-main', box: box(0, 170, 400, 32), actionsBox: box(300, 173, 96, 24),
    controls: ['branch', 'sync', 'commit', 'refresh', 'more'].map((action, index) => ({ action: `repository-${action}`, visible: true, opacity: '1', box: box(index === 0 ? 180 : 280 + 24 * (index - 1), 174, index === 0 ? 100 : 24, 24) })) };
}
function layout() {
  return { theme: 'dark', viewport: { width: 1439, height: 860 }, documentBounds: { clientWidth: 1439, scrollWidth: 1439, bodyScrollWidth: 1439 },
    global: { box: box(0, 0, 1439, 42) }, repository: { box: box(246, 42, 1193, 40) }, footer: { box: box(0, 832, 1439, 28) },
    sidebar: box(0, 42, 240, 790), tree: { box: box(0, 180, 240, 650) }, workspace: { position: 'middle' },
    local: { visible: true, box: box(246, 82, 390, 750), listBox: box(246, 120, 390, 330), previewBox: box(246, 450, 390, 380), inTree: false },
    graph: { visible: true, box: box(640, 170, 799, 620), clipBox: box(640, 170, 788, 609), scroll: { ...scroll(420), left: 120 } },
    details: { open: true, inline: true, embeddedDiff: false, box: box(640, 350, 788, 360), metadataBox: box(640, 381, 420, 323), widthResizer: box(1060, 381, 5, 323), filesPaneBox: box(1065, 381, 363, 323), filesBox: box(1066, 415, 362, 289), filesScroll: scroll(83) },
    history: { visible: true, ready: true, box: box(640, 82, 799, 750), diffBox: box(640, 150, 799, 650) } };
}
function narrowDetails() {
  const view = layout();
  view.viewport = { width: 760, height: 760 }; view.documentBounds = { clientWidth: 760, scrollWidth: 760, bodyScrollWidth: 760 };
  view.global.box = box(0, 0, 760, 38); view.repository.box = box(347, 38, 413, 40); view.footer.box = box(0, 732, 760, 28);
  view.sidebar = box(0, 38, 342, 694); view.tree.box = box(0, 110, 342, 600);
  view.graph = { visible: true, box: box(347, 208, 413, 497), clipBox: box(347, 208, 402, 486), scroll: { top: 829, left: 358, width: 402, height: 486, totalWidth: 760, totalHeight: 2040 } };
  view.details = { open: true, inline: true, embeddedDiff: false, box: box(347, 220, 402, 360), metadataBox: box(347, 251, 207, 323), widthResizer: box(554, 251, 5, 323), filesPaneBox: box(559, 251, 190, 323), filesBox: box(560, 285, 189, 289), filesScroll: { top: 120, left: 87, width: 178, height: 278, totalWidth: 530, totalHeight: 1200 } };
  return view;
}

test('native-only scope and approved screenshot widths are explicit and bounded', () => {
  assert.deepEqual(NATIVE_WIDTHS, [760, 1280, 1455]); assert.deepEqual(THEMES, ['dark', 'light']); assert(RUN_BUDGET_MS > 0 && RUN_BUDGET_MS <= 600_000);
  for (const phrase of ['never the browser demo or prototype', 'accepts no repository path', 'only during creation', 'read-only', 'real WebDriver', 'explicit UI trust', 'Blocked prerequisites are never passes']) assert(SCOPE.includes(phrase));
  assert(SELECTORS.settings.startsWith('.app-shell > .toolbar')); assert(SELECTORS.localCommit.startsWith('.repository-toolbar'));
});
test('change counter parses actual English labels, not a fixed three-change demo', () => {
  for (const [value, expected] of [['Change 1 of 3', { active: 1, count: 3 }], ['Change 7 of 17', { active: 7, count: 17 }], ['Change 0 of 0', { active: 0, count: 0 }], ['Change 1,024 of 2,048', { active: 1024, count: 2048 }]]) assert.deepEqual(parseChangeCounter(value), expected);
  for (const value of [null, '', '2/3', 'Change 4 of 3', 'Change -1 of 3', 'Change 1 of unknown', 'Change 1 of 3 demo']) assert.throws(() => parseChangeCounter(value));
});
test('minimal diff scroll preserves fully visible blocks including both flush edges', () => {
  const before = scroll(100, 400, 3000);
  assert.equal(expectedMinimalScroll(before, { top: 100, bottom: 500 }), 100);
  assert.equal(expectedMinimalScroll(before, { top: 101, bottom: 499 }), 100);
  assert.equal(expectedMinimalScroll(before, { top: 200, bottom: 511 }), 111);
  assert.equal(expectedMinimalScroll(before, { top: 89, bottom: 150 }), 89);
  assert.equal(expectedMinimalScroll(scroll(0), { top: 950, bottom: 1010 }), 610);
  assert.equal(expectedMinimalScroll(scroll(0), { top: 950, bottom: 1900 }), 630, 'Oversized blocks reveal their first four lines rather than their end.');
  assert.throws(() => expectedMinimalScroll(before, { top: NaN, bottom: 500 }));
});
test('navigation compares actual block rows and scroll offsets, rejects centering and hidden targets', () => {
  const before = navigation(100), after = navigation(610, 2); assertMinimalNavigation(before, after);
  const visibleBefore = navigation(100, 1, [{ id: 'first', top: 100, bottom: 160 }, { id: 'second', top: 200, bottom: 500 }]);
  const visibleAfter = structuredClone(visibleBefore); visibleAfter.history.activeId = 'second'; visibleAfter.history.counter = 'Change 2 of 2'; assertMinimalNavigation(visibleBefore, visibleAfter, { noScroll: true });
  for (const mutate of [view => { view.history.scroll.top = 900; }, view => { view.history.path = 'another-file'; }, view => { view.history.activeId = 'not-mounted'; }, view => { view.history.counter = 'Change 2 of 3'; }]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertMinimalNavigation(before, invalid)); }
  const moved = structuredClone(visibleAfter); moved.history.scroll.top += 12; assert.throws(() => assertMinimalNavigation(visibleBefore, moved, { noScroll: true }));
});
test('global controls are distinct from exactly scoped repository controls', () => {
  const view = { shell: { repoPath: path('alpha') }, global: { box: box(0, 0, 1200, 42), actions: ['open-repository', 'open-directory', 'repository-options', 'toggle-repository-tree', 'settings'] },
    repository: { path: path('alpha'), box: box(240, 42, 960, 40), actions: ['sync', 'show-local-commit', 'refresh', 'more-git-actions', 'checkout-branch'].map(action => ({ action })) } };
  assertToolbars(view);
  const leaked = structuredClone(view); leaked.global.actions.push('sync'); assert.throws(() => assertToolbars(leaked));
  const duplicate = structuredClone(view); duplicate.repository.actions.push({ action: 'refresh' }); assert.throws(() => assertToolbars(duplicate));
  const wrong = structuredClone(view); wrong.repository.path = path('bravo'); assert.throws(() => assertToolbars(wrong));
});
test('repository rows require a real branch plus four permanently visible equal-width buttons', () => {
  assertRowControls(rowControls());
  for (const mutate of [view => { view.branch = '—'; }, view => { view.controls.pop(); }, view => { view.controls[2].opacity = '0'; }, view => { view.controls[2].visible = false; }, view => { view.controls[2].box.width = 40; }, view => { view.controls[4].box.right = 500; }]) { const invalid = rowControls(); mutate(invalid); assert.throws(() => assertRowControls(invalid)); }
});
test('local three groups compare actual independently measured Git path arrays, not fixed counts', () => {
  const facts = { staged: ['overlap'], unstaged: ['overlap', 'keep', 'third'], untracked: ['a', 'b'] };
  const view = { workspace: { localOpen: true }, local: { visible: true, listBox: box(0, 0, 100, 100), previewBox: box(0, 100, 100, 100), inTreeItem: false,
    groups: Object.entries(facts).map(([id, files]) => ({ id, count: files.length, expanded: 'true' })), files: Object.entries(facts).flatMap(([group, paths]) => paths.map(path => ({ path, group }))) } };
  assertLocalGroups(view, facts);
  const noStaged = structuredClone(view), actualNoStaged = { ...facts, staged: [] }; noStaged.local.groups.shift(); noStaged.local.files = noStaged.local.files.filter(file => file.group !== 'staged'); assertLocalGroups(noStaged, actualNoStaged);
  const invalid = structuredClone(view); invalid.local.groups[1].count = 1; assert.throws(() => assertLocalGroups(invalid, facts));
  const hiddenPath = structuredClone(view); hiddenPath.local.files.pop(); assert.throws(() => assertLocalGroups(hiddenPath, facts));
  assert.throws(() => assertLocalGroups({ ...view, local: { ...view.local, inTreeItem: true } }, facts));
});
test('draft preservation includes selection direction and textarea scroll, not just a matching string', () => {
  const before = selection(); assertDraft(before, structuredClone(before));
  for (const [name, value] of [['value', ''], ['start', 0], ['end', 0], ['direction', 'none'], ['scrollTop', 0]]) { const after = structuredClone(before); after.local.message[name] = value; assert.throws(() => assertDraft(before, after)); }
  const other = structuredClone(before); other.shell.repoPath = path('bravo'); assert.throws(() => assertDraft(before, other));
});
test('return to graph requires nonzero graph and repository-tree offsets and restores file scroll', () => {
  const before = selection(); assertGraphRestored(before, structuredClone(before));
  for (const mutate of [view => { view.graph.scroll.top = 0; }, view => { view.tree.scroll.top = 0; }, view => { view.details.filesScroll.top = 0; }, view => { view.details.selectedFile = 'other'; }, view => { view.graph.selected = []; }, view => { view.history.visible = true; }]) { const after = structuredClone(before); mutate(after); assert.throws(() => assertGraphRestored(before, after)); }
  const zero = structuredClone(before); zero.tree.scroll.top = 0; assert.throws(() => assertGraphRestored(zero, zero));
});
test('stage/unstage requires changed actual index but unchanged HEAD refs and every file byte', () => {
  const before = snapshot(), after = structuredClone(before); after.index.sha256 = '9'.repeat(64); after.tracked[0].oid = oid('d'); after.status = 'changed-index-status'; assertIndexOnly(before, after);
  for (const mutate of [view => { view.head = oid('e'); }, view => { view.refs.pop(); }, view => { view.tracked[0].working.sha256 = '0'.repeat(64); }, view => { view.untracked.pop(); }, view => { view.index = before.index; }]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertIndexOnly(before, invalid)); }
});
test('commit validates parent, exact staged blob, sole committed path, message and single branch advance', () => {
  const before = snapshot(), after = structuredClone(before); after.head = oid('d'); after.refs[0] = `refs/heads/alpha-main ${oid('d')} commit`;
  const options = { branch: 'alpha-main', path: 'overlap', stagedOid: oid('b'), message: 'Owned native commit', actual: { parent: before.head, message: 'Owned native commit', paths: ['overlap'], blob: oid('b') } };
  assertCommitOnly(before, after, options);
  for (const patch of [{ parent: oid('f') }, { message: 'wrong' }, { paths: ['overlap', 'keep'] }, { blob: oid('c') }]) assert.throws(() => assertCommitOnly(before, after, { ...options, actual: { ...options.actual, ...patch } }));
  for (const mutate of [view => { view.tracked[1].working.bytes++; }, view => { view.untracked.pop(); }, view => { view.refs[1] = `refs/remotes/origin/main ${oid('d')} commit`; }, view => { view.headFile.sha256 = 'f'.repeat(64); }]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertCommitOnly(before, invalid, options)); }
});
test('typed deletion may remove exactly one actually untracked file without touching index refs or neighbors', () => {
  const before = snapshot(), after = structuredClone(before); after.untracked.shift(); after.status = 'after-exact-delete'; assertDeleteOnly(before, after, 'delete 中文.txt');
  assert.throws(() => assertDeleteOnly(before, after, 'not-untracked'));
  for (const mutate of [view => { view.untracked.pop(); }, view => { view.head = oid('e'); }, view => { view.index.sha256 = '0'.repeat(64); }, view => { view.tracked[0].working.bytes++; }]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertDeleteOnly(before, invalid, 'delete 中文.txt')); }
});
test('screenshot assertions require a visible actual surface with responsive containment', () => {
  for (const surface of ['local', 'details', 'document']) assertLayout(layout(), { theme: 'dark', position: 'middle', surface });
  const inline = layout(); inline.workspace.position = 'inline'; inline.local.inTree = true; assertLayout(inline, { theme: 'dark', position: 'inline', surface: 'local' });
  for (const mutate of [view => { view.documentBounds.scrollWidth = 1600; }, view => { view.footer.box.bottom = 800; }, view => { view.repository.box.right = 1600; }, view => { view.tree.box.scrollWidth = 500; }, view => { view.local.previewBox = null; }, view => { view.local.inTree = true; }]) { const invalid = layout(); mutate(invalid); assert.throws(() => assertLayout(invalid, { theme: 'dark', position: 'middle', surface: 'local' })); }
  const oldEmbedded = layout(); oldEmbedded.details.embeddedDiff = true; assert.throws(() => assertLayout(oldEmbedded, { theme: 'dark', position: 'middle', surface: 'details' }));
  const pending = layout(); pending.history.ready = false; assert.throws(() => assertLayout(pending, { theme: 'dark', position: 'middle', surface: 'document' }));
});
test('native 760 details keep two 190px columns and resizer inside the graph client clip despite table horizontal scroll', () => {
  const view = narrowDetails(), geometry = assertLayout(view, { theme: 'dark', position: 'middle', surface: 'details' });
  assert(view.graph.scroll.left > 0, 'Regression requires an actually nonzero table horizontal offset.');
  assert.deepEqual(geometry.detailColumns.graphClip, view.graph.clipBox); assert.deepEqual(geometry.detailColumns.metadata, view.details.metadataBox); assert.deepEqual(geometry.detailColumns.filesPane, view.details.filesPaneBox);
  const scrollLeftZero = narrowDetails(); scrollLeftZero.graph.scroll.left = 0; assertLayout(scrollLeftZero, { theme: 'dark', position: 'middle', surface: 'details' });
});
test('detail layout rejects the formerly accepted native06 overwide and horizontally shifted slots without root overflow', () => {
  for (const left of [347, -11]) {
    const view = narrowDetails();
    view.details.box = box(left, 220, 760, 360); view.details.metadataBox = box(left, 251, 418, 323); view.details.widthResizer = box(left + 418, 251, 5, 323); view.details.filesPaneBox = box(left + 423, 251, 337, 323); view.details.filesBox = box(left + 424, 285, 336, 289);
    assert.equal(view.documentBounds.scrollWidth, view.documentBounds.clientWidth);
    assert.throws(() => assertLayout(view, { theme: 'dark', position: 'middle', surface: 'details' }), /Inline details.*horizontal bounds/);
  }
  const shifted = narrowDetails();
  for (const name of ['box', 'metadataBox', 'widthResizer', 'filesPaneBox', 'filesBox']) { shifted.details[name].left -= 100; shifted.details[name].right -= 100; }
  assert.throws(() => assertLayout(shifted, { theme: 'dark', position: 'middle', surface: 'details' }), /Inline details.*horizontal bounds/);
  const scrollbarOverlap = narrowDetails(); scrollbarOverlap.details.box.width += 11; scrollbarOverlap.details.box.right += 11;
  assert.throws(() => assertLayout(scrollbarOverlap, { theme: 'dark', position: 'middle', surface: 'details' }), /client clip.*horizontal bounds/);
});
test('detail layout rejects missing, clipped, too-small or misplaced columns and resizer', () => {
  const mutations = [
    view => { view.graph.clipBox = null; }, view => { view.details.metadataBox = null; }, view => { view.details.filesPaneBox = null; }, view => { view.details.filesBox = null; }, view => { view.details.widthResizer = null; },
    view => { view.details.metadataBox.left = view.graph.box.left - 20; }, view => { view.details.filesPaneBox.right = view.graph.clipBox.right + 20; }, view => { view.details.filesBox.right = view.graph.clipBox.right + 20; },
    view => { view.details.metadataBox.width = 189; }, view => { view.details.filesPaneBox.width = 189; },
    view => { view.details.widthResizer.left += 20; view.details.widthResizer.right += 20; },
    view => { view.details.widthResizer.height = 0; }, view => { view.details.metadataBox.top = 800; view.details.metadataBox.bottom = 1123; },
  ];
  for (const mutate of mutations) { const view = narrowDetails(); mutate(view); assert.throws(() => assertLayout(view, { theme: 'dark', position: 'middle', surface: 'details' })); }
});
test('long file names retain independent list horizontal overflow inside bounded detail columns', () => {
  const view = narrowDetails(); view.details.filesBox.scrollWidth = 2200; view.details.filesPaneBox.scrollWidth = 2200;
  view.details.filesScroll.left = 720; view.details.filesScroll.totalWidth = 2200;
  view.details.fileRows = [{ path: 'a/very/long/owned/path/with spaces 中文.txt', box: box(-160, 310, 2200, 24) }];
  assertLayout(view, { theme: 'dark', position: 'middle', surface: 'details' });
});
test('owned fixture navigation content contains three separated changed regions in arbitrary-length real files', () => {
  const before = navigationText('').trimEnd().split('\n'), after = navigationText('v3').trimEnd().split('\n');
  assert.equal(before.length, 240); assert.equal(after.length, 240);
  assert.deepEqual(before.flatMap((line, index) => line === after[index] ? [] : [index + 1]), [20, 100, 180]);
  assert.equal(navigationText('v3', 300).trimEnd().split('\n').length, 300);
});
test('multi-modifier shortcuts use trusted WebDriver key actions and always release them', async () => {
  const calls = [], wd = { prefix: '/session/owned', async call(...args) { calls.push(args); } };
  await realChord(wd, ['\uE008', '\uE00A', '\uE035']);
  assert.equal(calls[0][0], 'POST'); assert.equal(calls[0][1], '/session/owned/actions');
  assert.deepEqual(calls[0][2].actions[0].actions, [
    { type: 'keyDown', value: '\uE008' }, { type: 'keyDown', value: '\uE00A' }, { type: 'keyDown', value: '\uE035' },
    { type: 'keyUp', value: '\uE035' }, { type: 'keyUp', value: '\uE00A' }, { type: 'keyUp', value: '\uE008' },
  ]); assert.deepEqual(calls[1], ['DELETE', '/session/owned/actions']);
  const failed = []; await assert.rejects(realChord({ prefix: '/session/owned', async call(method) { failed.push(method); if (method === 'POST') throw new Error('unsupported operation'); } }, ['x'])); assert.deepEqual(failed, ['POST', 'DELETE']);
});
test('browser observation scripts compile and contain no event injection, private App API or DOM writes', async () => {
  for (const [name, script] of Object.entries(OBSERVATIONS)) {
    assert.doesNotThrow(() => Function(script), name);
    for (const forbidden of ['__TAURI', 'dispatchEvent', 'new Event', 'new KeyboardEvent', 'fetch(', 'XMLHttpRequest', '.click(', '.focus(', '.scrollTo(', '.scrollBy(', '.value =', '.scrollTop =', '.innerHTML', 'setAttribute(', 'appendChild(', 'localStorage', 'sessionStorage', 'window.App', 'window.Host', 'invoke(']) assert(!script.includes(forbidden), `${name}: ${forbidden}`);
  }
  const source = await readFile(new URL('../test-workspace-desktop.mjs', import.meta.url), 'utf8');
  assert(source.includes('if (isMain(import.meta.url)) await main()'));
  assert(!/\.script\s*\(\s*['"`]/.test(source), 'Only named exported read-only observations can execute in the page.');
  assert(!/\b(?:execSync|spawn|execFileSync)\s*\(/.test(source), 'All process spawning must use shared owned desktop harness.');
  assert(!/[A-Za-z]:[\\/]Users[\\/]|D:[\\/]projects[\\/]/i.test(source), 'No actual user/source/profile path is hardcoded.');
  const main = source.slice(source.indexOf('async function main()'));
  assert(!/git(?:Text)?\(run,/.test(main), 'Acceptance uses sealed explicit read-only Git helper, never direct fixture writes.');
  for (const contract of ['await createRun(', 'await startDesktop(run, options, owned)', 'await repositorySnapshot(run,', 'await owned.cleanup()', 'await readVersion(PROJECT)', "'repository-before.json'", "'repository-after.json'", "'accepted-mutations.json'", 'prototype-v3-native-capture-index.json']) assert(source.includes(contract), contract);
  assert(source.includes("['binary', 'driver', 'output', 'git', 'tauri-driver']"));
  assert(!source.includes("values: ['repository'"));
  for (const name of ['Show file list', 'Show file tree']) {
    assert(source.includes(`button[aria-label="${name}"]`), 'Icon-only toggle uses actual accessible name.');
    assert(!source.includes(`.file-toolbar button', '${name}'`), 'Icon-only buttons have no textContent to match.');
  }
});
