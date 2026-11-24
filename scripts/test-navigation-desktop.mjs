#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PROJECT, assertSameSnapshot, createRun, errorInfo, git, gitExecutable, gitText, inside, isMain, json, parseArgs, readJson, required, samePath, until } from './lib/run.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';
import { repositorySnapshot } from './lib/fixtures.mjs';
import { readVersion } from './lib/release.mjs';

export const REQUIRED_VERSION = '0.3.0';
export const RUN_BUDGET_MS = 600_000;
export const SELECTORS = Object.freeze({
  repositoryOptions: 'button[data-action="repository-options"]',
  openDirectoryPath: '[role="menuitem"][data-action="open-directory-by-path"]',
  confirmDirectory: 'dialog[open] button[data-action="confirm-open-directory"]',
  path: 'dialog[open] input[name="path"]', depth: 'dialog[open] input[name="depth"]',
  scanDepth: 'select[data-action="repository-scan-depth"]',
  rescan: 'button[data-action="rescan-repositories"]', cancelScan: 'button[data-action="cancel-repository-scan"]',
  collapse: 'button[data-action="collapse-repository-tree"]', toggle: 'button[data-action="toggle-repository-tree"]',
  settings: 'button[data-action="settings"]',
  language: '.settings-dialog[open] .dialog-header select[data-setting-language][data-setting="language"][name="language"]',
  position: '.settings-dialog[open] select[data-setting="detailPosition"]',
  theme: '.settings-dialog[open] select[data-setting="theme"]',
  statusDetails: 'button[data-action="status-details"]',
});
export const SCOPE = 'Actual supplied Windows binary and verified native WebDriver, isolated profile/HOME, only new run-owned Git repositories. All product actions are WebDriver clicks, option clicks, keys, wheel actions, or native window-rectangle commands. Scripts observe DOM only; no browser demo, private application object, business IPC, injected event, or product-state mutation. Git writes finish before the single before-snapshot; acceptance and teardown are Git-read-only. No actual WSL repository, external terminal/editor, native directory picker, update, installation, publication, network synchronization, or OS-wide query/network audit is exercised. Fast unobserved loading/cancellation/stale states are explicitly blocked, never counted as passes. Raw evidence is local-only and includes owned fixture/profile paths.';

// Every browser script below is observation-only. Product actions never execute in scripts.
export const READ_NAVIGATION_DOM = `
const visible = e => !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
const text = e => e?.textContent.trim() ?? null;
const shell = document.querySelector('.app-shell');
const tree = document.querySelector('.repository-tree');
const footer = document.querySelector('footer.statusbar');
const settings = document.querySelector('.settings-dialog[open]');
const language = settings?.querySelector('.dialog-header select[data-setting-language]');
const pane = document.querySelector('.details-pane:not([hidden])');
const graph = document.querySelector('.table-scroll');
const diff = pane?.querySelector('.diff-scroll');
const summary = pane?.querySelector('.detail-summary');
const fullOid = [...summary?.querySelectorAll('.mono') ?? []].map(text).find(s => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(s)) ?? null;
const selected = [...document.querySelectorAll('.commit-row.selected')].map(e => e.id.slice('commit-'.length));
const statusDialog = document.querySelector('.statusbar-dialog[open]');
const activeElement = document.activeElement;
const sidebarSeparator = document.querySelector('.app-content > .resize-handle[role="separator"]');
const about = Object.fromEntries([...settings?.querySelectorAll('.settings-panel > .about-details dt') ?? []].map(e => [text(e), text(e.nextElementSibling)]));
return {
  locale: document.documentElement.lang, theme: document.documentElement.dataset.theme,
  focus: {tag:activeElement?.tagName ?? null,role:activeElement?.getAttribute('role') ?? null,label:activeElement?.getAttribute('aria-label') ?? null,classes:[...activeElement?.classList ?? []],isSidebarSeparator:!!sidebarSeparator && activeElement===sidebarSeparator},
  sidebarSeparator: sidebarSeparator ? {visible:visible(sidebarSeparator),value:sidebarSeparator.getAttribute('aria-valuenow'),minimum:sidebarSeparator.getAttribute('aria-valuemin'),maximum:sidebarSeparator.getAttribute('aria-valuemax')} : null,
  shell: shell ? {repoPath:shell.dataset.repoPath,head:shell.dataset.repoHead,taskState:shell.dataset.taskState,sequence:Number(shell.dataset.taskSequence),configDirectory:shell.dataset.configDirectory} : null,
  errors: [...document.querySelectorAll('.errorbar:not([hidden]),dialog[open] .form-error:not([hidden]),.startup-error')].filter(visible).map(text),
  recents: [...document.querySelectorAll('select.repo-select option')].map(e => ({value:e.value,label:text(e)})).filter(e => e.value),
  trustVisible: visible(document.querySelector('.trustbar:not(.diagnosticsbar)')),
  tree: {visible:visible(document.querySelector('#repository-navigation')),root:tree?.querySelector('.repository-tree-root-name')?.title ?? null,
    heading:text(tree?.querySelector('.repository-tree-heading > strong')),busy:tree?.querySelector('[role="tree"]')?.getAttribute('aria-busy') ?? null,
    count:text(tree?.querySelector('.repository-tree-count')),depth:tree?.querySelector('[data-action="repository-scan-depth"]')?.value ?? null,
    status:text(tree?.querySelector('.repository-tree-status-text')),partial:!!tree?.querySelector('.repository-tree-status.is-partial'),error:!!tree?.querySelector('.repository-tree-status.is-error'),
    rescanDisabled:tree?.querySelector('[data-action="rescan-repositories"]')?.disabled ?? null,cancelVisible:visible(tree?.querySelector('[data-action="cancel-repository-scan"]')),
    toggleExpanded:document.querySelector('[data-action="toggle-repository-tree"]')?.getAttribute('aria-expanded') ?? null,
    focusedKey:document.activeElement?.getAttribute('data-repository-key') ?? null,
    rows:[...tree?.querySelectorAll('[role="treeitem"][data-repository-key]') ?? []].map(e => ({key:e.dataset.repositoryKey,label:text(e.querySelector('.repository-tree-label')),level:Number(e.getAttribute('aria-level')),candidate:e.classList.contains('is-repository'),active:e.getAttribute('aria-selected')==='true',opening:e.getAttribute('aria-busy')==='true',expanded:e.getAttribute('aria-expanded'),title:e.title}))},
  footer: footer ? {state:footer.dataset.state,workingState:footer.dataset.workingState,stale:footer.dataset.stale,historyState:footer.dataset.historyState,trackingState:footer.dataset.trackingState,taskState:footer.dataset.taskState,
    branch:text(footer.querySelector('.statusbar-branch .statusbar-label')),summary:text(footer.querySelector('.statusbar-summary .statusbar-label')),summaryTitle:footer.querySelector('.statusbar-summary')?.title ?? null,
    counts:text(footer.querySelector('.statusbar-counts .statusbar-label')),countsHidden:!!footer.querySelector('.statusbar-counts')?.hidden,
    tracking:text(footer.querySelector('.statusbar-sync .statusbar-label')),trackingTitle:footer.querySelector('.statusbar-sync')?.title ?? null,
    language:text(footer.querySelector('.statusbar-language .statusbar-label')),locationHidden:!!footer.querySelector('.statusbar-location')?.hidden,
    cancelVisible:visible(footer.querySelector('[data-action="status-cancel"]')),cancelScope:footer.dataset.cancelScope,
    facts:Object.fromEntries([...statusDialog?.querySelectorAll('[data-fact]') ?? []].map(e => [e.dataset.fact,{value:text(e.querySelector('dd')),hidden:e.hidden}]))} : null,
  settings:{open:!!settings,title:text(settings?.querySelector('h2')),saveDisabled:settings?.querySelector('[data-action="save-settings"]')?.disabled ?? null,
    values:Object.fromEntries([...settings?.querySelectorAll('select[data-setting]') ?? []].map(e => [e.dataset.setting,e.value])),
    language:language ? {name:language.name,setting:language.dataset.setting,header:!!language.closest('.dialog-header'),disabled:language.disabled,value:language.value,options:[...language.options].map(e => ({value:e.value,label:text(e)}))} : null,
    about,installed:text(settings?.querySelector('[data-update-current-version]'))},
  view:{selectedOids:selected,activeDescendant:document.querySelector('.history-pane')?.getAttribute('aria-activedescendant') ?? null,
    detailOpen:!!pane,detailOid:fullOid,subject:text(pane?.querySelector('.detail-subject')),selectedFile:pane?.querySelector('.file-row.selected')?.dataset.path ?? null,filePath:text(pane?.querySelector('.file-diff-header .file-path')),
    graphTop:graph?.scrollTop ?? null,graphLeft:graph?.scrollLeft ?? null,diffTop:diff?.scrollTop ?? null,diffLeft:diff?.scrollLeft ?? null,
    filesTop:pane?.querySelector('.file-list')?.scrollTop ?? null,metadataTop:pane?.querySelector('.commit-metadata')?.scrollTop ?? null,
    graphOids:[...document.querySelectorAll('.commit-row')].map(e => e.id.slice('commit-'.length)),
    graphScrollable:!!graph && graph.scrollHeight>graph.clientHeight+20,diffScrollable:!!diff && diff.scrollHeight>diff.clientHeight+20,
    diffReady:!!diff && diff.getAttribute('aria-busy')!=='true' && !!diff.querySelector('.diff-line'),
    mode:document.querySelector('.workspace')?.classList.contains('details-inline')?'inline':document.querySelector('.workspace')?.classList.contains('details-right')?'right':'bottom'}
};`;

export const READ_LAYOUT_DOM = `
const visible = e => !!e && !e.hidden && e.getClientRects().length>0 && getComputedStyle(e).display!=='none' && getComputedStyle(e).visibility!=='hidden';
const box = e => {if(!visible(e)) return null; const r=e.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth};};
const footer=document.querySelector('footer.statusbar'), sidebar=document.querySelector('#repository-navigation'), tree=document.querySelector('.repository-tree'), rows=tree?.querySelector('.repository-tree-rows');
const pane=document.querySelector('.details-pane:not([hidden])');
return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth},
  theme:document.documentElement.dataset.theme,locale:document.documentElement.lang,footer:box(footer),
  footerItems:[...footer?.querySelectorAll('.statusbar-item') ?? []].filter(visible).map(e => ({name:[...e.classList].find(s=>s.startsWith('statusbar-') && !['statusbar-item','statusbar-tier-essential','statusbar-tier-secondary','statusbar-tier-tertiary'].includes(s)),...box(e)})),
  footerControls:{details:box(footer?.querySelector('[data-action="status-details"]')),language:box(footer?.querySelector('[data-action="status-language"]'))},
  sidebar:box(sidebar),tree:box(tree),treeRows:box(rows),rowBounds:[...rows?.querySelectorAll('[role="treeitem"]') ?? []].map(box).filter(Boolean),
  workspace:box(document.querySelector('.workspace')),details:box(pane),inline:!!pane?.closest('.inline-detail-slot'),
  mode:document.querySelector('.workspace')?.classList.contains('details-inline')?'inline':document.querySelector('.workspace')?.classList.contains('details-right')?'right':'bottom'};`;
export const OBSERVATIONS = Object.freeze({ navigation: READ_NAVIGATION_DOM, layout: READ_LAYOUT_DOM });
const cssString = value => JSON.stringify(String(value));
export const treeKey = components => components.map(encodeURIComponent).join('/');
const treeLabel = key => `.repository-tree-row[data-repository-key=${cssString(key)}] > .repository-tree-label`;
const treeDisclosure = key => `.repository-tree-row[data-repository-key=${cssString(key)}] > .repository-tree-disclosure`;
export const unsupportedDriver = error => /unsupported operation|unknown command|not implemented|operation is not supported/i.test(String(error?.message ?? error));

export function assertDiagnostics(view, source, profile) {
  assert.equal(source.version, REQUIRED_VERSION, 'Navigation acceptance targets the approved 0.3.0 candidate.');
  assert.equal(view.settings.about['App version'], source.version, 'Actual binary diagnostics must match readVersion().');
  assert.equal(view.settings.installed, `Installed version: ${source.version}`);
  assert.match(view.settings.about.Platform ?? '', /^windows\s/i, 'Browser/sample diagnostics are not desktop evidence.');
  assert.match(view.settings.about['Git version'] ?? '', /^git version \d+\./i);
  assert(view.settings.about['Git path'] && !['Unavailable', 'Unknown'].includes(view.settings.about['Git path']));
  assert(samePath(view.settings.about['Configuration directory'], profile), 'About must identify the isolated run profile.');
  assert(samePath(view.shell.configDirectory, profile)); assert.deepEqual(view.errors, []);
  return view.settings.about;
}
export function assertLanguageControl(view, language) {
  const control = view.settings.language;
  assert(view.settings.open && control?.header, 'Language belongs to the live Settings header, not an appearance-only field.');
  assert.equal(control.name, 'language'); assert.equal(control.setting, 'language'); assert.equal(control.disabled, false);
  assert.equal(control.value, language); assert.deepEqual(control.options.map(item => item.value), ['system', 'en', 'zh-CN']);
  assert.equal(control.options.find(item => item.value === 'en').label, 'English');
  assert.equal(control.options.find(item => item.value === 'zh-CN').label, '简体中文');
  return control;
}
export function assertTree(view, fixtures, { empty = false } = {}) {
  const tree = view.tree;
  assert.equal(tree.visible, true); assert(samePath(tree.root, fixtures.root)); assert.equal(tree.busy, 'false');
  assert.equal(tree.depth, empty ? '0' : String(fixtures.depth)); assert.equal(tree.partial, false); assert.equal(tree.error, false);
  assert.equal(tree.count, empty ? '0' : String(fixtures.candidates.length));
  assert.equal(tree.rescanDisabled, false); assert.equal(tree.cancelVisible, false);
  assert.equal(tree.status, empty ? 'No repositories found at this depth.' : `Scan complete. ${fixtures.candidates.length} repositories found.`);
  const expected = empty ? [{ key: '', label: fixtures.name, level: 1, candidate: false }] : fixtures.rows;
  assert.deepEqual(tree.rows.map(({ key, label, level, candidate }) => ({ key, label, level, candidate })), expected, 'Tree must contain exact structural ancestors/candidates, not arbitrary folders or a flattened repository list.');
  assert.equal(new Set(tree.rows.map(row => row.key)).size, tree.rows.length);
  if (!empty) for (const candidate of fixtures.candidates) {
    const row = tree.rows.find(row => row.key === candidate.key);
    assert(row.title.startsWith(candidate.path), 'Tree candidate keeps its exact native Git-validation path.');
    assert(row.title.includes({ 'git-directory': 'Git directory marker', 'git-file': 'Git file marker', bare: 'Bare repository marker' }[candidate.marker]));
  }
  assert.deepEqual(view.errors, []); return tree;
}
export function assertNoDiscoveryActivation(view, state, recents = []) {
  assert.equal(view.shell.repoPath, ''); assert.equal(view.shell.head, ''); assert.equal(view.shell.taskState, 'idle');
  assert.equal(view.tree.rows.filter(row => row.active || row.opening).length, 0);
  assert.deepEqual(view.recents.map(item => item.value).sort(), [...recents].sort());
  assert.deepEqual(state.recent.map(item => item.path).sort(), [...recents].sort());
  assert.deepEqual(state.trusted, [], 'Discovery and read-only activation must never grant trust.'); assert.equal(state.lastRepo, null);
  assert.equal(view.footer.state, 'empty'); assert.equal(view.footer.workingState, 'none'); assert.notEqual(view.footer.summary, 'Clean');
  return { recents: view.recents, trusted: state.trusted, lastRepo: state.lastRepo };
}
export function assertActive(view, fixture) {
  assert(samePath(view.shell.repoPath, fixture.path), `Wrong actual repository: ${view.shell.repoPath}`);
  assert.equal(view.shell.head, fixture.head, 'Actual Git HEAD must match the owned snapshot, not cached graph/sample data.');
  assert.equal(view.shell.taskState, 'idle'); assert.equal(view.footer.state, 'ready'); assert.equal(view.footer.stale, 'false');
  assert.equal(view.footer.branch, fixture.branch); assert.equal(view.footer.locationHidden, true, 'Local Windows fixtures must not be described as WSL execution.');
  const active = view.tree.rows.filter(row => row.active); assert.equal(active.length, 1); assert.equal(active[0].key, fixture.key);
  assert.equal(view.tree.rows.filter(row => row.opening).length, 0); assert.deepEqual(view.errors, []);
  return view.shell;
}
export function assertWorking(view, fixture, { facts = false } = {}) {
  assertActive(view, fixture);
  const footer = view.footer;
  assert.equal(footer.workingState, fixture.bare ? 'bare' : fixture.counts.changed ? 'changed' : 'clean');
  assert.equal(footer.trackingState, fixture.tracking.kind);
  assert.equal(footer.summary, fixture.bare ? 'Bare · no worktree' : fixture.counts.changed ? `${fixture.counts.changed} changed` : 'Clean');
  if (fixture.bare) {
    assert.equal(footer.countsHidden, true); assert.equal(footer.counts, ''); assert.equal(footer.tracking, 'Tracking unknown');
    assert(!/↑0|↓0|clean/i.test(`${footer.summary} ${footer.trackingTitle}`));
  } else {
    const { changed, staged, unstaged, untracked, conflicts } = fixture.counts;
    assert.equal(footer.summaryTitle, `${changed} distinct changed paths; ${staged} staged, ${unstaged} tracked unstaged, ${untracked} untracked, ${conflicts} unmerged. A tracked file may be both staged and unstaged; categories are not additive.`);
    if (changed) assert.equal(footer.counts, `${staged} staged · ${unstaged} unstaged · ${untracked} untracked`);
    if (fixture.tracking.kind === 'counts') {
      assert.equal(footer.tracking, `↑${fixture.tracking.ahead} ↓${fixture.tracking.behind}`);
      assert.equal(footer.trackingTitle, `${fixture.tracking.upstream}: ${fixture.tracking.ahead} ahead, ${fixture.tracking.behind} behind, compared with the locally observed upstream ref. No network check was made.`);
    } else assert.equal(footer.trackingTitle, 'No upstream');
  }
  if (facts) {
    for (const name of ['path', 'branch', 'working', 'tracking', 'history', 'git']) assert(footer.facts[name] && !footer.facts[name].hidden, `Missing full status fact: ${name}`);
    assert(samePath(footer.facts.path.value, fixture.path)); assert.equal(footer.facts.branch.value, fixture.branch);
    assert.equal(footer.facts.tracking.value, footer.trackingTitle);
    if (fixture.bare) { assert.equal(footer.facts.counts.hidden, true); assert.equal(footer.facts.working.value, 'This bare repository has no working tree; it is not reported as clean.'); }
    else assert.equal(footer.facts.counts.value, footer.summaryTitle);
    assert.match(footer.facts.history.value, /Loaded count is not|Loaded count is not|repository-wide total/);
  }
  return footer;
}
export function assertHonestTransient(footer) {
  assert(footer, 'No status footer observation.');
  if (['unknown', 'loading', 'error'].includes(footer.workingState)) {
    assert(!/^(?:Clean|干净)$/.test(footer.summary ?? ''), 'Unknown/loading/error must not claim clean.');
    assert.equal(footer.countsHidden, true, 'Unknown worktree must not invent zero counts.');
    assert(!/↑0|↓0/.test(footer.tracking ?? ''), 'Unmeasured tracking must not invent zero divergence.');
  }
  if (footer.stale === 'true' && ['clean', 'changed', 'conflict'].includes(footer.workingState)) {
    assert(/^(?:Previously |Previous: |上次)/.test(footer.summary ?? ''), 'Previous counts/cleanliness require an explicit stale label.');
    assert(/^(?:Previous snapshot|上次快照)/.test(footer.summaryTitle ?? ''), 'Stale count tooltip must not look current.');
  }
  return footer;
}
export function assertPreserved(before, after) {
  for (const key of ['detailOpen', 'detailOid', 'subject', 'selectedFile', 'filePath', 'mode', 'activeDescendant']) assert.deepEqual(after.view[key], before.view[key], `Presentation change lost ${key}.`);
  assert(before.view.detailOid && before.view.selectedFile && before.view.diffReady, 'Preservation requires a real selected immutable commit and loaded file diff.');
  assert.deepEqual(after.view.selectedOids, before.view.selectedOids, 'Graph selection changed.');
  assert.deepEqual(after.view.graphOids, before.view.graphOids, 'Visible/overscan Git identities changed.');
  for (const key of ['graphTop', 'graphLeft', 'diffTop', 'diffLeft', 'filesTop', 'metadataTop']) {
    assert(Number.isFinite(before.view[key]) && Number.isFinite(after.view[key]), `Missing actual ${key}.`);
    assert(Math.abs(after.view[key] - before.view[key]) <= 1, `Presentation change lost ${key}: ${before.view[key]} -> ${after.view[key]}`);
  }
  assert.equal(after.shell.repoPath, before.shell.repoPath); assert.equal(after.shell.head, before.shell.head);
  return { oid: after.view.detailOid, file: after.view.selectedFile, graphTop: after.view.graphTop, diffTop: after.view.diffTop };
}
export function assertLayout(layout, { theme, mode } = {}) {
  const epsilon = 2, { viewport, footer, sidebar, tree, treeRows } = layout;
  const contained = (child, parent, label) => { assert(child && parent, `${label} is not visible.`); assert(child.left >= parent.left - epsilon && child.right <= parent.right + epsilon, `${label} escapes horizontal bounds.`); };
  assert(viewport.width >= 660 && viewport.height > 300); assert.equal(layout.theme, theme); assert.equal(layout.mode, mode);
  assert(layout.document.scrollWidth <= layout.document.clientWidth + epsilon && layout.document.bodyScrollWidth <= viewport.width + epsilon, 'Root document horizontally overflows.');
  assert(footer && footer.height >= 26 && footer.height <= 32, 'Footer must remain compact, not a wrapping content pane.');
  assert(Math.abs(footer.left) <= epsilon && Math.abs(footer.right - viewport.width) <= epsilon && Math.abs(footer.bottom - viewport.height) <= epsilon, 'Footer must span and remain at the viewport bottom.');
  assert(footer.scrollWidth <= footer.clientWidth + epsilon, 'Footer horizontally overflows.');
  for (const item of layout.footerItems) contained(item, footer, `Footer item ${item.name}`);
  contained(layout.footerControls.details, footer, 'Status details control'); contained(layout.footerControls.language, footer, 'Language control');
  assert(sidebar && sidebar.width >= 178 && sidebar.width <= Math.min(420, viewport.width * .42) + epsilon, 'Navigation width escaped its native responsive bounds.');
  contained(sidebar, { left: 0, right: viewport.width }, 'Navigation sidebar'); contained(tree, sidebar, 'Repository tree'); contained(treeRows, tree, 'Tree scroll area');
  for (const [name, box] of [['tree', tree], ['tree rows', treeRows]]) assert(box.scrollWidth <= box.clientWidth + epsilon, `${name} horizontally overflows.`);
  for (const row of layout.rowBounds) contained(row, treeRows, 'Tree row');
  assert(layout.details && layout.details.width > 0 && layout.details.height > 0, 'Each layout screenshot needs an actual open details pane.');
  assert.equal(layout.inline, mode === 'inline', 'Inline details must be mounted inside the real virtual-list slot.');
  return layout;
}
export function assertSidebarFocus(view) {
  assert.equal(view.focus?.isSidebarSeparator, true, `Actual sidebar separator did not receive click focus: ${JSON.stringify(view.focus)}`);
  assert.equal(view.focus.tag, 'DIV'); assert.equal(view.focus.role, 'separator');
  assert(view.focus.classes.includes('resize-handle') && view.focus.classes.includes('vertical'));
  assert.equal(view.sidebarSeparator?.visible, true); assert.equal(view.sidebarSeparator.minimum, '180');
  assert(Number.isFinite(Number(view.sidebarSeparator.value)) && Number.isFinite(Number(view.sidebarSeparator.maximum)), 'Separator must expose its actual numeric width and bounds.');
  return { focus: view.focus, separator: view.sidebarSeparator };
}
export function assertNativeRect(rect, width) {
  assert(Number.isFinite(rect?.width) && Number.isFinite(rect?.height), 'Driver must return an actual native rectangle.');
  assert(Math.abs(rect.width - width) <= 2, `Native window width ${rect.width} did not reach requested ${width}.`);
  return rect;
}
export function assertFixtureSnapshots(before, after) {
  assert(before && after && Object.keys(before).length >= 2, 'Integrity requires complete actual before and after snapshots.');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'Every fixture repository must be checked, including shared-common-dir worktrees and bare repositories.');
  for (const name of Object.keys(before)) {
    assertSameSnapshot(before[name], after[name], name);
    assert.equal(after[name].commonDir, before[name].commonDir, `${name}: shared/common Git identity changed.`);
  }
  return Object.keys(before);
}
export async function selectOption(wd, selector, value) {
  // Edge/WebView2 needs the select opened first for a trusted change event.
  // Clicking an option alone, setting .value, or dispatching change is not equivalent.
  await wd.click(selector);
  await wd.click(`${selector} > option[value=${cssString(value)}]`);
}

async function captureFixtureScope(run, repositories) {
  const scope = {};
  for (const [name, path] of Object.entries(repositories)) {
    const snapshot = await repositorySnapshot(run, path);
    const commonDir = await realpath(resolve(path, gitText(run, path, ['rev-parse', '--git-common-dir'])));
    for (const identity of [snapshot.identity.path, snapshot.identity.gitDir, commonDir]) assert(inside(join(run.output, 'workspace'), identity), 'Fixture Git identity escaped this run-owned workspace.');
    scope[name] = { ...snapshot, commonDir };
  }
  return scope;
}
async function createNavigationFixtures(run, check) {
  const workspace = join(run.output, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, '.navigation-owner.json'), JSON.stringify({ runId: run.manifest.runId, scope: 'Fresh local-only navigation acceptance fixtures.' }), { flag: 'wx' });
  const root = join(workspace, 'Multi scope 中文'), aName = 'Alpha repository 中文', bName = 'Bravo repository with a deliberately long navigation label 中文';
  const a = join(root, aName), b = join(a, 'nested', bName), linked = join(root, 'Linked worktree 中文'), bare = join(root, 'Archive bare.git');
  const singleRoot = join(workspace, 'Single scope'), single = join(singleRoot, 'Only repository 中文');
  await mkdir(root); await mkdir(singleRoot);
  const configure = repo => {
    for (const [key, value] of [['user.name', 'Navigation acceptance fixture'], ['user.email', 'navigation@example.invalid'], ['core.hooksPath', run.manifest.git.hooksDirectory], ['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['credential.helper', ''], ['protocol.allow', 'never'], ['protocol.file.allow', 'always']]) git(run, repo, ['config', '--local', key, value]);
  };
  const init = async (repo, branch) => { check(); await mkdir(repo, { recursive: true }); git(run, repo, ['init', '-b', branch, `--template=${run.manifest.git.templateDirectory}`]); configure(repo); };
  const write = async (repo, name, contents) => { await mkdir(dirname(join(repo, name)), { recursive: true }); await writeFile(join(repo, name), contents); };
  let clock = 0;
  const commit = (repo, subject, empty = false) => {
    check(); if (!empty) git(run, repo, ['add', '--all']);
    const date = new Date(Date.UTC(2026, 0, 2, 8, clock++)).toISOString();
    git(run, repo, ['commit', '--quiet', ...(empty ? ['--allow-empty'] : []), '-m', subject], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  const lines = (prefix, count = 180) => Array.from({ length: count }, (_, index) => `${prefix} line ${String(index + 1).padStart(3, '0')}: local Git bytes, not product sample data.`).join('\n') + '\n';
  await init(a, 'alpha-main'); await write(a, '.gitignore', 'nested/\n');
  await write(a, 'note.txt', lines('Alpha initial')); await write(a, 'summary.txt', lines('Alpha initial summary')); commit(a, 'Alpha initial committed files');
  for (let i = 0; i < 28; i++) commit(a, `Alpha actual history ${String(i + 1).padStart(2, '0')}`, true);
  await write(a, 'note.txt', lines('Alpha review')); await write(a, 'summary.txt', lines('Alpha review summary')); commit(a, 'Alpha immutable review selection');
  const aParent = gitText(run, a, ['rev-parse', 'HEAD']);
  await write(a, 'note.txt', lines('Alpha final')); await write(a, 'summary.txt', lines('Alpha final summary')); commit(a, 'Alpha actual final HEAD');
  await init(b, 'bravo-main'); await write(b, 'note.txt', lines('Bravo initial')); await write(b, 'summary.txt', lines('Bravo initial summary')); commit(b, 'Bravo independent initial commit');
  await write(b, 'note.txt', lines('Bravo final')); await write(b, 'summary.txt', lines('Bravo final summary')); commit(b, 'Bravo independent final HEAD');
  git(run, a, ['worktree', 'add', '-b', 'linked-owned', linked, aParent]);
  git(run, workspace, ['-c', 'protocol.file.allow=always', 'clone', '--bare', '--no-hardlinks', '--', a, bare]); configure(bare);
  git(run, a, ['remote', 'add', 'origin', bare]); git(run, a, ['update-ref', 'refs/remotes/origin/alpha-main', aParent]);
  git(run, a, ['branch', '--set-upstream-to=origin/alpha-main', 'alpha-main']);
  await init(single, 'single-owner'); await write(single, 'note.txt', 'One owned repository in this scope.\n'); commit(single, 'Single owned scope initial commit');
  await write(single, 'note.txt', 'One owned repository, independently committed HEAD.\n'); commit(single, 'Single owned scope final HEAD');
  // A single tracked path overlaps staged/unstaged; untracked is independent.
  await write(a, 'note.txt', lines('Alpha staged')); git(run, a, ['add', '--', 'note.txt']);
  await write(a, 'note.txt', lines('Alpha staged and unstaged')); await write(a, 'untracked 中文.txt', 'Owned untracked status fixture.\n');
  // Real bounded filesystem work makes cancellation observable on many machines.
  // These directories have no repository marker and must never appear in the tree.
  for (let start = 0; start < 320; start += 16) {
    check(); await Promise.all(Array.from({ length: 16 }, async (_, offset) => {
      const path = join(root, 'scan-only folders', `entry-${String(start + offset).padStart(3, '0')}`);
      await mkdir(join(path, 'one'), { recursive: true }); await mkdir(join(path, 'two'));
    }));
  }
  const repositories = { alpha: a, bravo: b, linked, bare, single };
  const before = await captureFixtureScope(run, repositories); await json(join(run.output, 'repository-before.json'), before);
  assert.notEqual(before.alpha.head, before.bravo.head); assert.equal(before.alpha.commonDir, before.linked.commonDir); assert.notEqual(before.alpha.identity.gitDir, before.linked.identity.gitDir);
  const clean = { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  const make = (name, components, branch, marker, counts = clean, tracking = { kind: 'no-upstream' }) => ({ name, path: before[name].identity.path, head: before[name].head, branch, components, key: treeKey(components), marker, bare: marker === 'bare', counts, tracking });
  const alpha = make('alpha', [aName], 'alpha-main', 'git-directory', { changed: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 }, { kind: 'counts', upstream: 'origin/alpha-main', ahead: 1, behind: 0 });
  const bravo = make('bravo', [aName, 'nested', bName], 'bravo-main', 'git-directory');
  const linkedFixture = make('linked', ['Linked worktree 中文'], 'linked-owned', 'git-file');
  const bareFixture = make('bare', ['Archive bare.git'], 'alpha-main', 'bare', clean, { kind: 'unknown' });
  const singleFixture = make('single', ['Only repository 中文'], 'single-owner', 'git-directory');
  const actualTracking = gitText(run, a, ['status', '--porcelain=v2', '--branch', '--ahead-behind', '--untracked-files=all']);
  assert(actualTracking.includes('# branch.upstream origin/alpha-main')); assert(actualTracking.includes('# branch.ab +1 -0'));
  const nodes = new Map([['', { key: '', label: 'Multi scope 中文', level: 1, candidate: false }]]);
  for (const candidate of [alpha, bravo, linkedFixture, bareFixture]) for (let length = 1; length <= candidate.components.length; length++) {
    const components = candidate.components.slice(0, length), key = treeKey(components);
    const row = nodes.get(key) ?? { key, label: components.at(-1), level: length + 1, candidate: false };
    row.candidate ||= length === candidate.components.length; nodes.set(key, row);
  }
  const fixture = { schemaVersion: 1, runId: run.manifest.runId, workspace, root: await realpath(root), name: 'Multi scope 中文', depth: 3,
    repositories, alpha, bravo, linked: linkedFixture, bare: bareFixture, single: singleFixture, singleRoot: await realpath(singleRoot),
    candidates: [alpha, bravo, bareFixture, linkedFixture], rows: [...nodes.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    sharedCommonDir: before.alpha.commonDir, beforeSnapshot: 'repository-before.json', actualTracking,
    ownership: 'Every repository, administrative/common directory, local remote and scan-only folder belongs to this new workspace. No external repository is read or written.' };
  await json(join(run.output, 'navigation-fixtures.json'), fixture);
  return { fixture, before };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { values: ['binary', 'driver', 'output', 'git', 'tauri-driver'], flags: ['help'] });
  if (options.help) {
    console.log('node scripts/test-navigation-desktop.mjs --binary <approved-app.exe> --driver <verified-msedgedriver.exe> --output <new-empty-run> [--git <exe>] [--tauri-driver <exe>]\nActual Windows desktop only. Uses readVersion() to require the approved 0.3.0 candidate, creates owned Git fixtures and an isolated English profile, archives real DOM/PNG evidence, and closes only exact run-owned process identities. Exit 2 means a required prerequisite/capability was blocked, never a pass. Does not build, install, publish, or open a browser demo.');
    return;
  }
  required(options, ['binary', 'driver', 'output']);
  const run = await createRun(resolve(options.output), 'navigation-desktop');
  const owned = new OwnedProcesses(run), controller = new AbortController(), cleanupErrors = [];
  const deadline = Date.now() + RUN_BUDGET_MS;
  const timer = setTimeout(() => controller.abort(new BlockedError('Navigation desktop run exceeded its ten-minute work budget; remaining acceptance is not passed.')), RUN_BUDGET_MS); timer.unref();
  const interrupt = signal => controller.abort(new Error(`${signal}: interrupted`));
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM'); process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  let wd, monitor, fixtures, before, failure, originalCall;
  const transitions = [];
  run.manifest.navigation = { requiredVersion: REQUIRED_VERSION, workBudgetMs: RUN_BUDGET_MS, scope: SCOPE, transitions, sessions: [] };
  function check() { controller.signal.throwIfAborted(); monitor?.check(); if (Date.now() >= deadline) throw new BlockedError('Work budget expired; no remaining acceptance is passed.'); }
  async function observe() {
    check(); const view = await wd.script(READ_NAVIGATION_DOM);
    assert(view.shell && view.footer, 'The actual desktop must expose its semantic diagnostics and status footer.');
    assert.deepEqual(view.errors, [], 'Actual UI reported an error.'); assertHonestTransient(view.footer);
    const signature = JSON.stringify([view.shell.repoPath, view.shell.head, view.shell.taskState, view.shell.sequence, view.footer.workingState, view.footer.stale, view.footer.trackingState, view.tree.busy, view.tree.status]);
    if (transitions.at(-1)?.signature !== signature && transitions.length < 240) transitions.push({ at: new Date().toISOString(), signature, shell: view.shell, footer: view.footer, scan: { busy: view.tree.busy, status: view.tree.status, cancelVisible: view.tree.cancelVisible } });
    return view;
  }
  async function wait(label, predicate, timeout = 20_000) { return until(label, async () => { const view = await observe(); return predicate(view) ? view : false; }, { timeout: Math.max(1, Math.min(timeout, deadline - Date.now())), interval: 80, signal: controller.signal }); }
  async function profileWhen(label, predicate) {
    return until(label, async () => { check(); const state = await readJson(join(run.profileDirectory, 'state.json')); return predicate(state) ? state : false; }, { timeout: Math.max(1, Math.min(8000, deadline - Date.now())), interval: 100, signal: controller.signal });
  }
  async function step(label, work, { requiredForBaseline = true, continueOnBlocked = false } = {}) {
    const result = { label, status: 'running', requiredForBaseline, startedAt: new Date().toISOString() }; run.manifest.results.push(result); await run.save();
    try { check(); result.observed = await work(); check(); result.status = 'passed'; return result.observed; }
    catch (error) { result.status = error instanceof BlockedError ? 'blocked' : 'failed'; result.error = errorInfo(error); if (!(continueOnBlocked && error instanceof BlockedError)) throw error; return null; }
    finally { result.finishedAt = new Date().toISOString(); await run.save(); }
  }
  async function capability(label, sample, reason, requiredForBaseline = false) {
    return step(label, async () => { if (!sample) throw new BlockedError(reason); return sample; }, { requiredForBaseline, continueOnBlocked: true });
  }
  async function archive(name) {
    const view = await observe(); await json(join(run.output, `evidence/${name}-observed.json`), view);
    const evidence = await archiveDesktop(run, wd, name); assert.equal(evidence.errors.length, 0, `Incomplete actual ${name} evidence.`); return view;
  }
  async function closeDialog() {
    const view = await observe();
    // After a native SELECT option click, Escape can dismiss only its popup.
    // Target the actual modal footer instead of inferring closure from a key.
    if (view.settings.open) await wd.clickText('.settings-dialog[open] > .dialog-footer button', view.locale === 'zh-CN' ? '关闭' : 'Close');
    else if (Object.keys(view.footer.facts).length) await wd.clickText('.statusbar-dialog[open] > .dialog-footer button', view.locale === 'zh-CN' ? '关闭状态详情' : 'Close status details');
    else throw new Error('No actual Settings/status modal is open to close.');
    await wait('actual modal closed', current => !current.settings.open && Object.keys(current.footer.facts).length === 0);
  }
  async function openSettings() { await wd.click(SELECTORS.settings); return wait('Settings header available', view => view.settings.open && !!view.settings.language); }
  async function appearance(position, theme) {
    let view = await openSettings();
    if (view.settings.values.detailPosition !== position) await selectOption(wd, SELECTORS.position, position);
    view = await observe(); if (view.settings.values.theme !== theme) await selectOption(wd, SELECTORS.theme, theme);
    await closeDialog(); return wait('appearance applied', view => view.view.mode === position && view.theme === theme);
  }
  async function changeLanguage(language) {
    const initial = await openSettings(); assertLanguageControl(initial, initial.locale);
    await selectOption(wd, SELECTORS.language, language);
    const changed = await wait('trusted Settings option changes the actual language', view => view.locale === language && view.settings.language?.value === language);
    assertLanguageControl(changed, language); await closeDialog();
    await profileWhen('language persisted by actual Settings UI', state => state.settings.language === language);
    return observe();
  }
  async function directory(root, depth) {
    await wd.click(SELECTORS.repositoryOptions); await wd.click(SELECTORS.openDirectoryPath);
    await wd.fill(SELECTORS.path, root); await wd.fill(SELECTORS.depth, String(depth)); await wd.click(SELECTORS.confirmDirectory);
    return wait('directory scan completes in the real application', view => samePath(view.tree.root, root) && view.tree.depth === String(depth) && view.tree.busy === 'false' && view.shell.taskState === 'idle');
  }
  async function activate(fixture) {
    await wd.click(treeLabel(fixture.key));
    const view = await wait(`actual Git activation ${fixture.name}`, view => samePath(view.shell.repoPath, fixture.path) && view.shell.head === fixture.head && view.shell.taskState === 'idle' && view.tree.rows.some(row => row.key === fixture.key && row.active && !row.opening));
    assertActive(view, fixture); return view;
  }
  async function immutableDiff(fixture) {
    await wd.click(`[id=${cssString(`commit-${fixture.head}`)}] .hash-cell`);
    await wait('immutable Git commit details', view => view.view.detailOid === fixture.head && !!view.view.selectedFile);
    await wd.click('.details-pane:not([hidden]) .file-row[data-path="summary.txt"]');
    return wait('actual selected file patch', view => view.view.detailOid === fixture.head && view.view.selectedFile === 'summary.txt' && view.view.filePath === 'summary.txt' && view.view.diffReady);
  }
  async function wheel(selector, deltaY) {
    const element = await wd.find(selector);
    try { await wd.call('POST', `${wd.prefix}/actions`, { actions: [{ type: 'wheel', id: 'navigation-owned-wheel', actions: [{ type: 'scroll', duration: 160, origin: { 'element-6066-11e4-a52e-4f735466cecf': element }, x: 0, y: 0, deltaX: 0, deltaY }] }] }); }
    catch (error) { if (unsupportedDriver(error)) throw new BlockedError(`Native WebDriver cannot perform real wheel scrolling: ${error.message}`); throw error; }
    finally { await wd.call('DELETE', `${wd.prefix}/actions`); }
  }
  async function scrolledSelection(fixture) {
    const view = await immutableDiff(fixture); assert(view.view.graphScrollable && view.view.diffScrollable, 'Fixture must actually support nonzero graph and diff scroll evidence.');
    await wheel('.details-pane:not([hidden]) .diff-scroll', 140); await wheel('.table-scroll', 84);
    return wait('real graph and diff wheel scrolling', view => view.view.graphTop > 0 && view.view.diffTop > 0 && view.view.diffReady && view.view.detailOid === fixture.head);
  }
  async function statusFacts(fixture) {
    await wd.click(SELECTORS.statusDetails);
    const view = await wait('full semantic status details', view => Object.keys(view.footer.facts).length > 0); const footer = assertWorking(view, fixture, { facts: true });
    await archive(`status-${fixture.name}`); await closeDialog(); return footer;
  }
  try {
    if (process.platform !== 'win32') throw new BlockedError('Requires an actual Windows desktop and verified Tauri/Edge WebDriver. No emulation/browser/demo fallback is allowed.');
    const source = await readVersion(PROJECT); assert.equal(source.version, REQUIRED_VERSION); run.manifest.navigation.source = source;
    run.gitBinary = gitExecutable(options.git); run.manifest.git.executable = run.gitBinary;
    const created = await createNavigationFixtures(run, check); fixtures = created.fixture; before = created.before; run.manifest.navigation.fixtures = 'navigation-fixtures.json'; await run.save();
    wd = await startDesktop(run, options, owned); monitor = monitorOwnedProcesses(owned);
    originalCall = wd.call.bind(wd);
    wd.call = (method, path, body, timeout = 15_000) => { check(); return originalCall(method, path, body, Math.max(1, Math.min(timeout, 20_000, deadline - Date.now()))); };
    await step('real-installed-candidate-version-and-empty-English-startup', async () => {
      const empty = await observe(); assert.equal(empty.locale, 'en'); assert.equal(empty.shell.repoPath, ''); assert.equal(empty.footer.workingState, 'none'); assert.equal(empty.footer.trackingState, 'unknown'); assert.equal(empty.recents.length, 0);
      await openSettings(); await wd.clickText('.settings-tabs [role="tab"]', 'About & privacy');
      const diagnostics = assertDiagnostics(await observe(), source, run.profileDirectory); await archive('installed-candidate-diagnostics'); await closeDialog(); return diagnostics;
    });
    await step('multi-directory-structural-tree-with-no-auto-open-trust-or-discovery-recents', async () => {
      const view = await directory(fixtures.root, fixtures.depth); assertTree(view, fixtures);
      const state = await profileWhen('directory scope persisted without activation', state => samePath(state.directoryScope?.root, fixtures.root));
      const privacy = assertNoDiscoveryActivation(view, state); await archive('multi-directory-no-auto-open'); return { tree: view.tree, privacy };
    });
    await step('tree-keyboard-disclosure-keeps-repository-and-child-group-distinct', async () => {
      await wd.click(treeLabel('')); let view = await observe(); assert.equal(view.tree.rows.length, 1);
      await wd.keys(['\uE014']); await wd.keys(['\uE015']); // Right expands root; Down focuses Alpha without activating it.
      view = await observe(); assert.equal(view.tree.focusedKey, fixtures.alpha.key); assert.equal(view.shell.repoPath, '');
      await wd.keys([' ']); view = await observe(); assert(!view.tree.rows.some(row => row.key === fixtures.bravo.key)); assert.equal(view.shell.repoPath, '');
      await wd.keys(['\uE014']); await wd.keys(['\uE015']); await wd.keys(['\uE007']);
      view = await observe(); assert.equal(view.tree.focusedKey, treeKey([...fixtures.alpha.components, 'nested'])); assert.equal(view.shell.repoPath, ''); assertTree(view, fixtures); return view.tree;
    });
    let savedAlpha;
    await step('candidate-text-click-loads-real-Git-and-honest-dirty-tracking-status', async () => {
      const view = await activate(fixtures.alpha); assertWorking(view, fixtures.alpha); assert.equal(view.trustVisible, true);
      const footer = await statusFacts(fixtures.alpha); const state = await profileWhen('only activated Alpha is recent', state => state.recent.length === 1); assert.deepEqual(state.trusted, []); assert(samePath(state.recent[0].path, fixtures.alpha.path));
      await appearance('bottom', 'dark'); savedAlpha = await scrolledSelection(fixtures.alpha); await archive('alpha-selected-scrolled'); return { footer, selection: savedAlpha.view };
    });
    await step('switch-A-to-B-to-A-restores-selected-OID-file-and-real-scroll', async () => {
      const bravo = await activate(fixtures.bravo); assertWorking(bravo, fixtures.bravo); await immutableDiff(fixtures.bravo); await statusFacts(fixtures.bravo);
      await activate(fixtures.alpha); const restored = await wait('Alpha immutable file selection restored', view => view.view.detailOid === fixtures.alpha.head && view.view.selectedFile === 'summary.txt' && view.view.diffReady);
      const preserved = assertPreserved(savedAlpha, restored); await archive('alpha-restored-after-bravo'); return preserved;
    });
    let rapidLoading;
    await step('rapid-real-A-B-clicks-settle-on-latest-B-not-A', async () => {
      const aLabel = await wd.find(treeLabel(fixtures.alpha.key)), bLabel = await wd.find(treeLabel(fixtures.bravo.key));
      await wd.clickElement(aLabel); const inFlight = await observe();
      rapidLoading = inFlight.shell.taskState === 'running' && inFlight.tree.rows.some(row => row.key === fixtures.alpha.key && row.opening) ? inFlight : null;
      await wd.clickElement(bLabel);
      const final = await wait('latest B activation completes', view => samePath(view.shell.repoPath, fixtures.bravo.path) && view.shell.head === fixtures.bravo.head && view.shell.taskState === 'idle'); assertWorking(final, fixtures.bravo);
      const start = Date.now(); let samples = 0;
      await until('B remains selected after possible stale A response', async () => { const view = await observe(); assertWorking(view, fixtures.bravo); samples++; return Date.now() - start >= 650; }, { timeout: 3000, interval: 100, signal: controller.signal });
      await archive('rapid-selection-final-bravo'); return { lastObservedBeforeB: inFlight.shell, loadingAlphaObserved: !!rapidLoading, stableSamples: samples, final: final.shell, scope: 'Real clicks; loading evidence is the read-only sample immediately before B, not injected timing or atomic native tracing.' };
    });
    await capability('rapid-A-observably-loading-before-B-click-latest-wins', rapidLoading && { shell: rapidLoading.shell, opening: rapidLoading.tree.rows.filter(row => row.opening) }, 'A completed before the immediately-before-B DOM sample; final-B passed separately, but a during-loading race is not claimed.', true);
    await step('bare-and-linked-git-file-candidates-validate-through-real-Git', async () => {
      await activate(fixtures.bare); const bare = await statusFacts(fixtures.bare); await activate(fixtures.linked); const linked = await statusFacts(fixtures.linked);
      return { bare, linked, commonDir: fixtures.sharedCommonDir, scope: 'Main worktree and linked worktree have distinct Git directories/HEADs, share the recorded common directory, and are separately included in integrity snapshots.' };
    });
    await step('depth-zero-empty-and-rescan-complete-remain-honest-without-auto-activation', async () => {
      const recents = (await observe()).recents.map(item => item.value);
      await selectOption(wd, SELECTORS.scanDepth, '0'); let view = await wait('depth zero scan completes', view => view.tree.depth === '0' && view.tree.busy === 'false' && view.shell.taskState === 'idle'); assertTree(view, fixtures, { empty: true });
      const state = await profileWhen('depth zero scope and inactive repository persisted', state => state.directoryScope?.depth === 0 && state.lastRepo === null); assertNoDiscoveryActivation(view, state, recents); await archive('scan-depth-zero-empty');
      await selectOption(wd, SELECTORS.scanDepth, String(fixtures.depth)); view = await wait('full depth restored without arbitrary activation', view => view.tree.depth === String(fixtures.depth) && view.tree.busy === 'false' && view.shell.taskState === 'idle'); assertTree(view, fixtures);
      assert.equal(view.shell.repoPath, ''); return { empty: state.directoryScope, restored: view.tree };
    });
    let cancellation;
    await step('rescan-controls-and-previous-results-report-only-observed-scan-states', async () => {
      await wd.click(SELECTORS.rescan); const scan = await observe();
      if (scan.tree.busy === 'true') {
        assert.equal(scan.tree.rescanDisabled, true); assert.equal(scan.tree.cancelVisible, true); assert.equal(scan.footer.cancelVisible, false, 'Discovery must not expose a write/history footer cancel.'); assert.match(scan.tree.status, /^Scanning directories/);
        if (scan.tree.cancelVisible) {
          try { await wd.click(SELECTORS.cancelScan); }
          catch (error) { const raced = await observe(); if (raced.tree.busy !== 'false' || !/element not interactable|no such element|stale element/i.test(error.message)) throw error; }
          const cancelled = await observe();
          if (/^Scan cancelled\./.test(cancelled.tree.status)) { assert.equal(cancelled.tree.busy, 'false'); assert.equal(cancelled.tree.partial, true); assert.equal(cancelled.tree.count, String(fixtures.candidates.length)); cancellation = cancelled.tree; await archive('scan-cancelled-previous-results'); }
        }
      }
      if (cancellation) await wd.click(SELECTORS.rescan);
      const complete = await wait('actual rescan completion', view => view.tree.busy === 'false' && /^Scan complete\./.test(view.tree.status)); assertTree(complete, fixtures); return { immediatelyAfterClick: scan.tree, complete: complete.tree };
    });
    await capability('real-scan-cancel-and-previous-results-observed', cancellation, 'The bounded owned scan completed before a cancellable state/cancel result could be observed. No cancel success is inferred.');
    await step('single-complete-scope-auto-opens-and-sidebar-hide-restore-controls-work', async () => {
      const single = await directory(fixtures.singleRoot, 1); assertActive(single, fixtures.single); assert.equal(single.tree.count, '1'); assert.equal(single.tree.status, 'Scan complete. 1 repository found.'); assert.equal(single.tree.visible, false); assert.equal(single.tree.toggleExpanded, 'false');
      await wd.click(SELECTORS.toggle); let shown = await observe(); assert.equal(shown.tree.visible, true); assert.equal(shown.tree.toggleExpanded, 'true');
      await wd.click(SELECTORS.collapse); let hidden = await observe(); assert.equal(hidden.tree.visible, false); assertActive(hidden, fixtures.single);
      await wd.click(SELECTORS.toggle); shown = await observe(); assert.equal(shown.tree.visible, true); assertActive(shown, fixtures.single); await archive('single-scope-restored-sidebar');
      const multi = await directory(fixtures.root, fixtures.depth); assertTree(multi, fixtures); assert.equal(multi.shell.repoPath, ''); await activate(fixtures.alpha);
      await wait('Alpha details restored after scopes', view => view.view.detailOid === fixtures.alpha.head && view.view.selectedFile === 'summary.txt' && view.view.diffReady);
      await wd.click(SELECTORS.collapse); hidden = await observe(); assert.equal(hidden.tree.visible, false); assertActive(hidden, fixtures.alpha);
      await wd.click(SELECTORS.toggle); shown = await observe(); assert.equal(shown.tree.visible, true); assertActive(shown, fixtures.alpha); return { autoOpen: single.shell, restored: shown.tree };
    });
    await step('sidebar-width-resizer-is-actually-keyboard-operable-and-bounded', async () => {
      const samples = [];
      async function captureResize(label) {
        const view = await observe(), layout = await wd.script(READ_LAYOUT_DOM);
        const sample = { label, at: new Date().toISOString(), focus: view.focus, separator: view.sidebarSeparator, sidebar: layout.sidebar, viewport: layout.viewport };
        samples.push(sample);
        await json(join(run.output, 'evidence/sidebar-resize-observed.json'), { samples });
        assertSidebarFocus(view);
        assert(Math.abs(Number(view.sidebarSeparator.value) - layout.sidebar.width) <= 2, 'Actual separator ARIA width must match measured sidebar width.');
        return sample;
      }
      await wd.click('.app-content > .resize-handle[role="separator"]'); await captureResize('after-real-separator-click-before-Home');
      await wd.keys(['\uE011']); let sample = await captureResize('after-Home'); assert(Math.abs(sample.sidebar.width - 180) <= 2);
      await wd.keys(['\uE010']); sample = await captureResize('after-End'); assert(sample.sidebar.width >= 180 && sample.sidebar.width <= 422);
      await wd.keys(['\uE011', ...Array(7).fill('\uE014')]); sample = await captureResize('after-Home-and-seven-Right-keys'); assert(Math.abs(sample.sidebar.width - 236) <= 2);
      return { width: sample.sidebar.width, samples };
    });
    await step('EN-ZH-EN-real-Settings-option-clicks-preserve-Git-selection-diff-and-scroll', async () => {
      const baseline = await observe(); assert(baseline.view.graphTop > 0 && baseline.view.diffTop > 0);
      const zh = await changeLanguage('zh-CN'); const zhPreserved = assertPreserved(baseline, zh); assert.equal(zh.footer.language, '中'); assert.equal(zh.tree.heading, '仓库'); await archive('language-zh-selected-scrolled');
      const en = await changeLanguage('en'); const enPreserved = assertPreserved(baseline, en); assert.equal(en.footer.language, 'EN'); assert.equal(en.tree.heading, 'Repositories'); await archive('language-en-restored-selected-scrolled');
      return { zh: zhPreserved, en: enPreserved, taskSequences: [baseline.shell.sequence, zh.shell.sequence, en.shell.sequence], scope: 'Actual selection and scroll offsets, not a claim about complete native query counts.' };
    });
    await step('status-refresh-does-not-report-stale-counts-as-current', async () => {
      const previous = await observe(); await wd.click('button[data-action="refresh"]');
      const finished = await wait('real read-only status refresh completes', view => view.shell.taskState === 'idle' && view.shell.sequence > previous.shell.sequence); assertWorking(finished, fixtures.alpha); return finished.footer;
    });
    const unknown = transitions.find(item => ['unknown', 'loading'].includes(item.footer.workingState) && item.shell.repoPath);
    const stale = transitions.find(item => item.footer.stale === 'true' && ['clean', 'changed', 'conflict'].includes(item.footer.workingState));
    await capability('actual-loading-unknown-worktree-is-not-clean', unknown, 'All real local metadata loads finished before the first DOM sample; no unknown/loading UI success is inferred.');
    await capability('actual-stale-previous-snapshot-is-explicitly-labelled', stale, 'No stale successful snapshot was observable between real refresh click and completion. No state injection or fixture rewrite is used to manufacture it.');
    await step('native-760-and-1280-light-dark-three-detail-mode-layouts', async () => {
      try { await wd.call('GET', `${wd.prefix}/window/rect`); }
      catch (error) { if (unsupportedDriver(error)) throw new BlockedError(`Native window rectangle commands unavailable; minimum-width screenshots are not fabricated: ${error.message}`); throw error; }
      const captures = [];
      for (const width of [1280, 760]) {
        let rect;
        try { rect = await wd.call('POST', `${wd.prefix}/window/rect`, { width, height: width === 760 ? 680 : 820 }); }
        catch (error) { if (unsupportedDriver(error)) throw new BlockedError(`Native width ${width} unsupported: ${error.message}`); throw error; }
        assertNativeRect(rect, width);
        for (const theme of ['dark', 'light']) for (const mode of ['bottom', 'right', 'inline']) {
          await appearance(mode, theme); await wait('actual detail mode and immutable diff ready', view => view.view.mode === mode && view.view.detailOid === fixtures.alpha.head && view.view.diffReady);
          const layout = assertLayout(await wd.script(READ_LAYOUT_DOM), { theme, mode });
          const name = `layout-native-${width}-${theme}-${mode}`; await json(join(run.output, `evidence/${name}-geometry.json`), { nativeRect: rect, ...layout }); await archive(name);
          captures.push({ name, nativeRect: rect, viewport: layout.viewport, footer: layout.footer, tree: layout.tree, mode, theme });
        }
      }
      const rect = await wd.call('POST', `${wd.prefix}/window/rect`, { width: 1280, height: 820 }); assertNativeRect(rect, 1280); await appearance('bottom', 'dark'); return captures;
    }, { continueOnBlocked: true });
    await step('actual-close-reopen-owned-profile-persists-language-scope-width-selection-and-diff', async () => {
      await appearance('bottom', 'dark'); await scrolledSelection(fixtures.alpha);
      const key = treeKey([...fixtures.alpha.components, 'nested']); await wd.click(treeDisclosure(key));
      let baseline = await changeLanguage('zh-CN'); assert.equal(baseline.tree.rows.find(row => row.key === key)?.expanded, 'false');
      const persisted = await profileWhen('real UI view and scope flushed before restart', state => state.settings.language === 'zh-CN' && state.directoryScope?.collapsedPaths?.includes(key) && Object.values(state.views).some(view => view.selected === fixtures.alpha.head && view.detail?.path === 'summary.txt' && Number(view.filter?.diffScrollTop) > 0));
      await archive('before-owned-restart-zh'); await owned.snapshot();
      const old = { ...run.manifest.session, closedAt: null }; await wd.call('DELETE', wd.prefix, undefined, 20_000); old.closedAt = new Date().toISOString(); run.manifest.navigation.sessions.push(old); wd.sessionId = null; run.manifest.session = null; await run.save();
      let created;
      try { created = await wd.call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: run.manifest.binary.path, args: old.args, webviewOptions: old.webviewOptions } } } }, 20_000); }
      catch (error) { if (unsupportedDriver(error) || /session not created|already (?:started|running)|session.*(?:exists|active)/i.test(error.message)) throw new BlockedError(`The same run-owned driver could not restart its application session; persisted files alone are not a restart pass: ${error.message}`); throw error; }
      assert(created?.sessionId, 'Restart must create a new actual driver session.'); assert.notEqual(created.sessionId, old.id); wd.sessionId = created.sessionId;
      run.manifest.session = { id: wd.sessionId, endpoint: wd.endpoint, capabilities: created.capabilities, args: old.args, webviewOptions: old.webviewOptions, createdAt: new Date().toISOString(), restartedFrom: old.id }; await owned.snapshot(); await run.save();
      const restored = await wait('real reopened application restores owned Git view', view => view.locale === 'zh-CN' && samePath(view.shell.repoPath, fixtures.alpha.path) && view.shell.taskState === 'idle' && view.view.detailOid === fixtures.alpha.head && view.view.selectedFile === 'summary.txt' && view.view.diffReady && Math.abs(view.view.diffTop - baseline.view.diffTop) <= 1);
      assert(samePath(restored.shell.configDirectory, run.profileDirectory)); assert.equal(restored.tree.visible, baseline.tree.visible); assert.deepEqual(restored.tree.rows.map(row => [row.key, row.expanded]), baseline.tree.rows.map(row => [row.key, row.expanded]));
      const preserved = assertPreserved(baseline, restored); assert.equal(persisted.directoryScope.width, 236); await archive('after-owned-restart-zh');
      const english = await changeLanguage('en'); assertPreserved(restored, english); assert.equal(english.footer.language, 'EN');
      return { previousSession: old.id, reopenedSession: wd.sessionId, language: restored.locale, scope: persisted.directoryScope, preserved, finalLocale: english.locale };
    }, { requiredForBaseline: false, continueOnBlocked: true });
    run.manifest.status = run.manifest.results.some(result => result.status === 'blocked' && result.requiredForBaseline) ? 'blocked' : 'passed';
  } catch (error) {
    failure = error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = errorInfo(error);
  } finally {
    clearTimeout(timer);
    if (originalCall && wd) wd.call = originalCall;
    if (monitor) try { await monitor.stop(); } catch (error) { cleanupErrors.push({ phase: 'ownership-monitor', ...errorInfo(error) }); }
    wd ??= run.webDriver;
    try { await archiveDesktop(run, wd, failure ? 'failure' : 'final'); } catch (error) { cleanupErrors.push({ phase: 'final-archive', ...errorInfo(error) }); }
    if (owned.roots.length) try { await owned.snapshot(); } catch (error) { cleanupErrors.push({ phase: 'ownership-before-close', ...errorInfo(error) }); }
    if (wd?.sessionId) try { await wd.call('DELETE', wd.prefix, undefined, 20_000); if (run.manifest.session) run.manifest.session.closedAt = new Date().toISOString(); } catch (error) { cleanupErrors.push({ phase: 'webdriver-session-delete', ...errorInfo(error) }); }
    try {
      const cleanup = await owned.cleanup(); run.manifest.cleanup = { ...cleanup, errors: [...(cleanup.errors ?? []), ...cleanupErrors] };
      assert.equal(cleanup.remaining?.length ?? 0, 0, 'Run-owned exact process identities remain.'); assert.equal(run.manifest.cleanup.errors.length, 0, 'Evidence or owned-process cleanup reported errors.');
    } catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.cleanup ??= { errors: cleanupErrors }; run.manifest.cleanup.failure = errorInfo(error); }
    if (fixtures && before) {
      try {
        const after = await captureFixtureScope(run, fixtures.repositories); await json(join(run.output, 'repository-after.json'), after); const checked = assertFixtureSnapshots(before, after);
        run.manifest.repositoryIntegrity = { status: 'passed', before: 'repository-before.json', after: 'repository-after.json', repositories: checked, checked: ['identity', 'HEAD', 'HEAD-file-sha256', 'index-sha256', 'status-v2-NUL', 'tracked-working-bytes', 'untracked-bytes', 'all-refs', 'common-Git-directory'], scope: 'Exactly one complete before and one complete after fixture scope. No teardown ref/index/worktree mutations.' };
      } catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.repositoryIntegrity = { status: 'failed', ...errorInfo(error) }; }
    } else run.manifest.repositoryIntegrity = { status: 'blocked', reason: 'No complete actual owned-fixture baseline was captured; no integrity pass is inferred.' };
    if (controller.signal.aborted && !(controller.signal.reason instanceof BlockedError)) { failure ??= controller.signal.reason; run.manifest.status = 'failed'; }
    run.manifest.finishedAt = new Date().toISOString(); if (failure && !run.manifest.error) run.manifest.error = errorInfo(failure);
    run.manifest.navigation.coverage = { passed: run.manifest.results.filter(result => result.status === 'passed').length, blocked: run.manifest.results.filter(result => result.status === 'blocked').length, requiredBlocked: run.manifest.results.filter(result => result.status === 'blocked' && result.requiredForBaseline).map(result => result.label) };
    await run.save(); await json(join(run.output, 'test-report.json'), { schemaVersion: 1, kind: 'navigation-desktop', runId: run.manifest.runId, status: run.manifest.status, startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt, binary: run.manifest.binary ?? null, navigation: run.manifest.navigation, results: run.manifest.results, repositoryIntegrity: run.manifest.repositoryIntegrity, cleanup: run.manifest.cleanup, evidence: run.manifest.evidence, error: run.manifest.error, scope: SCOPE });
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  }
  console.log(JSON.stringify({ status: run.manifest.status, output: run.output, report: join(run.output, 'test-report.json'), coverage: run.manifest.navigation.coverage, error: failure?.message }, null, 2));
  process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
}
if (isMain(import.meta.url)) await main();
