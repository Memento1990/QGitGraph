#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PROJECT, assertSameSnapshot, createRun, errorInfo, git, gitExecutable, gitText, inside, isMain, json, parseArgs, readJson, required, samePath, sha256, until } from './lib/run.mjs';
import { archiveDesktop, BlockedError, monitorOwnedProcesses, OwnedProcesses, startDesktop } from './lib/desktop.mjs';
import { repositorySnapshot } from './lib/fixtures.mjs';
import { readVersion } from './lib/release.mjs';
import { REQUIRED_VERSION, assertDiagnostics, assertNativeRect, selectOption, treeKey, unsupportedDriver } from './test-navigation-desktop.mjs';

export const RUN_BUDGET_MS = 600_000;
export const NATIVE_WIDTHS = Object.freeze([760, 1280, 1455]);
export const THEMES = Object.freeze(['dark', 'light']);
export const SCOPE = 'Actual supplied Windows binary only, never the browser demo or prototype. Fresh run-owned profile/HOME/WebView2/test-manifest, verified native driver, loopback ports and exact owned process identities. The runner accepts no repository path. Harness Git writes occur only during creation of new owned fixtures, including a local-only bare remote; subsequent Git commands are read-only. Product stage/unstage/commit/delete writes use real WebDriver controls after explicit UI trust, with exact file/index/HEAD/ref assertions and an accepted-mutation ledger. All page actions are actual clicks, keys or wheel actions; scripts only observe DOM/geometry. No private App object, business IPC, injected event, external terminal/editor, native picker, network synchronization, installation, package/version/release command, or real user profile/repository is exercised. Blocked prerequisites are never passes. Raw local-only evidence contains owned fixture/profile paths.';
export const SELECTORS = Object.freeze({
  global: '.app-shell > .toolbar', repository: '.repository-toolbar', settings: '.app-shell > .toolbar [data-action="settings"]',
  repositoryOptions: '.app-shell > .toolbar [data-action="repository-options"]', openDirectory: '[role="menuitem"][data-action="open-directory-by-path"]',
  confirmDirectory: 'dialog[open] [data-action="confirm-open-directory"]', path: 'dialog[open] input[name="path"]', depth: 'dialog[open] input[name="depth"]',
  tree: '.repository-tree-rows', collapse: '.repository-tree [data-action="collapse-repository-tree"]', toggle: '.app-shell > .toolbar [data-action="toggle-repository-tree"]',
  local: '.local-changes-pane', message: '.local-changes-message', commit: '.local-changes-composer [data-action="commit-staged"]',
  localCommit: '.repository-toolbar [data-action="show-local-commit"]', localClose: '.local-changes-pane [data-action="close-local-changes"]',
  position: '.settings-dialog[open] select[data-setting="localChangesPosition"]', detailPosition: '.settings-dialog[open] select[data-setting="detailPosition"]', theme: '.settings-dialog[open] select[data-setting="theme"]',
  details: '.details-pane.history-details:not([hidden])', widthResizer: '.details-pane.history-details .history-detail-width-resizer', heightResizer: '.details-pane.history-details .history-detail-height-resizer',
  graph: '.table-scroll', files: '.details-pane.history-details .file-list', fileFilter: '.details-pane.history-details .file-filter',
  graphTab: '.history-document-tabs [role="tab"][data-document-id="graph"]', document: '.history-document-surface:not([hidden])',
  documentDiff: '.history-document-surface:not([hidden]) .diff-scroll', showUnchanged: '.history-document-tools [data-action="show-unchanged"]',
});
const css = value => JSON.stringify(String(value));
const row = key => `.repository-tree-row[data-repository-key=${css(key)}]`;
const label = key => `${row(key)} > .repository-tree-label`;
const commitCell = oid => `[id=${css(`commit-${oid}`)}] .hash-cell`;
const localFile = (group, path) => `.local-changes-file[data-group=${css(group)}][data-path=${css(path)}]`;
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const KEY = Object.freeze({ tab: '\uE004', enter: '\uE007', shift: '\uE008', alt: '\uE00A', escape: '\uE00C', pageUp: '\uE00E', pageDown: '\uE00F', end: '\uE010', home: '\uE011', left: '\uE012', up: '\uE013', right: '\uE014', down: '\uE015', f5: '\uE035' });

// Every execute/sync payload is an exported, observation-only script. No product state is injected.
export const READ_WORKSPACE_DOM = `
const visible=e=>!!e&&!e.hidden&&e.getClientRects().length>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
const text=e=>e?.textContent.trim()??null;
const box=e=>{if(!visible(e))return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight};};
const clipBox=e=>{if(!visible(e))return null;const r=e.getBoundingClientRect(),left=r.left+e.clientLeft,top=r.top+e.clientTop;return {left,top,right:left+e.clientWidth,bottom:top+e.clientHeight,width:e.clientWidth,height:e.clientHeight};};
const scroll=e=>e?{top:e.scrollTop,left:e.scrollLeft,height:e.clientHeight,width:e.clientWidth,totalHeight:e.scrollHeight,totalWidth:e.scrollWidth}:null;
const control=e=>({action:e.dataset.action??null,label:e.getAttribute('aria-label'),disabled:e.disabled,visible:visible(e),opacity:getComputedStyle(e).opacity,box:box(e)});
const shell=document.querySelector('.app-shell'), global=shell?.querySelector(':scope > .toolbar'), repository=document.querySelector('.repository-toolbar');
const tree=document.querySelector('.repository-tree-rows'), local=document.querySelector('.local-changes-pane'), list=document.querySelector('.local-changes-list-surface'), preview=document.querySelector('.local-changes-preview');
const pane=document.querySelector('.details-pane.history-details:not([hidden])'), graph=document.querySelector('.table-scroll'), files=pane?.querySelector('.file-list'), metadata=pane?.querySelector('.commit-metadata');
const doc=document.querySelector('.history-document-surface:not([hidden])'), diff=doc?.querySelector('.diff-scroll'), counter=text(document.querySelector('.history-document-tools .diff-change-counter'));
const active=document.activeElement, activeFile=files?.querySelector('[id="'+files?.getAttribute('aria-activedescendant')+'"]');
const message=list?.querySelector('.local-changes-message'), settings=document.querySelector('.settings-dialog[open]'), footer=document.querySelector('footer.statusbar');
const fullOid=[...pane?.querySelectorAll('.history-detail-facts dd .mono')??[]].map(text).find(s=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(s))??null;
const groups=new Map();for(const e of diff?.querySelectorAll('[data-change-id]')??[]){const b=box(e),top=Number.parseFloat(e.style.top);if(!b||!Number.isFinite(top))continue;const id=e.dataset.changeId,g=groups.get(id)??{id,top:Infinity,bottom:-Infinity,rows:0};g.top=Math.min(g.top,top);g.bottom=Math.max(g.bottom,top+b.height);g.rows++;groups.set(id,g);}
return {locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
 documentBounds:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth},
 shell:shell?{repoPath:shell.dataset.repoPath,head:shell.dataset.repoHead,taskState:shell.dataset.taskState,sequence:Number(shell.dataset.taskSequence),configDirectory:shell.dataset.configDirectory}:null,
 errors:[...document.querySelectorAll('.errorbar:not([hidden]),.startup-error,.inline-error')].filter(visible).map(text),
 global:{box:box(global),actions:[...global?.querySelectorAll('button[data-action]')??[]].map(e=>e.dataset.action)},
 repository:{box:box(repository),path:repository?.dataset.repoPath,title:text(repository?.querySelector('.repository-toolbar-name')),branch:text(repository?.querySelector('.repository-toolbar-branch > span')),actions:[...repository?.querySelectorAll('button[data-action]')??[]].map(control)},
 sidebar:box(document.querySelector('#repository-navigation')),
 tree:{visible:visible(document.querySelector('#repository-navigation')),root:document.querySelector('.repository-tree-root-name')?.title??null,busy:tree?.getAttribute('aria-busy'),scroll:scroll(tree),box:box(tree),
 rows:[...tree?.querySelectorAll(':scope > .repository-tree-row')??[]].map(e=>({key:e.dataset.repositoryKey,candidate:e.classList.contains('is-repository'),active:e.getAttribute('aria-selected')==='true',expanded:e.getAttribute('aria-expanded'),box:box(e),branch:text(e.querySelector('.repository-tree-branch-label')),controls:[...e.querySelectorAll('button[data-action]')].map(control),actionsBox:box(e.querySelector('.repository-tree-actions'))})),
 localRegion:box(document.querySelector('.repository-tree-local')),localPath:document.querySelector('.repository-tree-local:not([hidden])')?.dataset.repositoryPath??null},
 workspace:{position:document.querySelector('.workspace-panels')?.dataset.localPosition,activeTab:document.querySelector('.workspace-panels')?.dataset.activeTab,localOpen:!!document.querySelector('.workspace-panels.has-local-changes'),box:box(document.querySelector('.workspace-panels'))},
 local:{visible:visible(local),box:box(local),placement:local?.dataset.placement,busy:local?.dataset.busy,listBox:box(list),inTree:!!list?.closest('.repository-tree-local'),inTreeItem:!!list?.closest('[role="treeitem"]'),previewBox:box(preview),previewPath:preview?.dataset.path??null,previewGroup:preview?.dataset.group??null,
 message:message?{value:message.value,start:message.selectionStart,end:message.selectionEnd,direction:message.selectionDirection,scrollTop:message.scrollTop,disabled:message.disabled}:null,
 composerError:visible(list?.querySelector('.local-changes-composer-error'))?text(list.querySelector('.local-changes-composer-error')):null,tip:text(list?.querySelector('.local-changes-composer-tip')),
 groups:[...list?.querySelectorAll('.local-changes-group')??[]].map(e=>({id:e.dataset.group,count:Number(text(e.querySelector('.count-badge'))),expanded:e.getAttribute('aria-expanded')})),
 files:[...list?.querySelectorAll('.local-changes-file')??[]].map(e=>({path:e.dataset.path,group:e.dataset.group,selected:e.getAttribute('aria-selected')==='true',box:box(e)}))},
 graph:{visible:visible(document.querySelector('.graph-surface')),box:box(graph),clipBox:clipBox(graph),scroll:scroll(graph),activeDescendant:document.querySelector('.history-pane')?.getAttribute('aria-activedescendant')??null,
 selected:[...document.querySelectorAll('.commit-row.selected')].map(e=>e.id.slice(7)),rows:[...document.querySelectorAll('.commit-row')].map(e=>({oid:e.id.slice(7),box:box(e)}))},
 details:{open:!!pane,box:box(pane),oid:fullOid,subject:text(pane?.querySelector('.detail-subject')),side:pane?.dataset.inlineSide,inline:!!pane?.closest('.inline-detail-slot'),
 widthResizer:box(pane?.querySelector('.history-detail-width-resizer')),heightResizer:box(pane?.querySelector('.history-detail-height-resizer')),metadataBox:box(metadata),metadataScroll:scroll(metadata),metadataOverflow:metadata?getComputedStyle(metadata).overflowY:null,
 messageExpanded:pane?.querySelector('[data-action="toggle-full-message"]')?.getAttribute('aria-expanded')??null,messageBox:box(pane?.querySelector('.history-detail-message')),
 filesPaneBox:box(pane?.querySelector('.files-pane')),filesBox:box(files),filesScroll:scroll(files),fileRole:files?.getAttribute('role'),activeFile:activeFile?.dataset.nodeKey??null,selectedFile:pane?.querySelector('.file-row.selected')?.dataset.path??null,
 folders:[...files?.querySelectorAll('.file-folder')??[]].map(e=>({path:e.dataset.folder,expanded:e.getAttribute('aria-expanded'),box:box(e)})),fileRows:[...files?.querySelectorAll('.file-row')??[]].map(e=>({path:e.dataset.path,box:box(e)})),embeddedDiff:!!pane?.querySelector('.diff-view,.diff-scroll')},
 history:{visible:!!doc,box:box(doc),path:text(doc?.querySelector('.history-document-path')),context:text(doc?.querySelector('.history-document-context')),footer:text(doc?.querySelector('.history-document-footer')),counter,
 tabs:[...document.querySelectorAll('.history-document-tabs [role="tab"]')].map(e=>({id:e.dataset.documentId,label:text(e),selected:e.getAttribute('aria-selected')==='true'})),
 ready:!!diff&&diff.getAttribute('aria-busy')!=='true'&&!!diff.querySelector('.diff-line'),diffBox:box(diff),scroll:scroll(diff),lineHeight:diff?Number.parseFloat(getComputedStyle(diff).getPropertyValue('--diff-line-height')):null,
 activeId:diff?.querySelector('.is-active-change')?.dataset.changeId??null,blocks:[...groups.values()].sort((a,b)=>a.top-b.top),showUnchanged:document.querySelector('.history-document-tools [data-action="show-unchanged"]')?.getAttribute('aria-checked')??null},
 footer:footer?{box:box(footer),workingState:footer.dataset.workingState,stale:footer.dataset.stale,summary:text(footer.querySelector('.statusbar-summary'))}:null,
 settings:{open:!!settings,values:Object.fromEntries([...settings?.querySelectorAll('select[data-setting]')??[]].map(e=>[e.dataset.setting,e.value])),about:Object.fromEntries([...settings?.querySelectorAll('.settings-panel > .about-details dt')??[]].map(e=>[text(e),text(e.nextElementSibling)])),installed:text(settings?.querySelector('[data-update-current-version]'))},
 dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>({title:text(e.querySelector('h2')),description:text(e.querySelector('.dialog-description')),paths:text(e.querySelector('.local-changes-confirm-paths')),error:[...e.querySelectorAll('.form-error')].filter(visible).map(text)})),
 trustVisible:visible(document.querySelector('.trustbar:not(.diagnosticsbar)')),toast:visible(document.querySelector('.toast'))?text(document.querySelector('.toast')):null,
 focus:{tag:active?.tagName,role:active?.getAttribute('role'),action:active?.dataset.action??null,classes:[...active?.classList??[]],fileList:active===files,separator:active?.getAttribute('role')==='separator',value:active?.getAttribute('aria-valuenow')}};`;
export const READ_TARGET_BOX = `
const e=document.querySelector(arguments[0]);if(!e||e.hidden||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};`;
export const READ_TARGET_SCROLL = `
const e=document.querySelector(arguments[0]);if(!e)return null;return {top:e.scrollTop,left:e.scrollLeft,height:e.clientHeight,width:e.clientWidth,totalHeight:e.scrollHeight,totalWidth:e.scrollWidth};`;
export const OBSERVATIONS = Object.freeze({ workspace: READ_WORKSPACE_DOM, target: READ_TARGET_BOX, targetScroll: READ_TARGET_SCROLL });

export function parseChangeCounter(value) {
  const match = /^Change\s+([\d,]+)\s+of\s+([\d,]+)$/.exec(value ?? '');
  assert(match, `Actual English change counter missing: ${value}`);
  const active = Number(match[1].replaceAll(',', '')), count = Number(match[2].replaceAll(',', ''));
  assert(Number.isSafeInteger(active) && Number.isSafeInteger(count) && active >= 0 && active <= count);
  return { active, count };
}
export function expectedMinimalScroll(before, block, lineHeight = 20) {
  const { top, height, totalHeight } = before;
  assert([top, height, totalHeight, block.top, block.bottom, lineHeight].every(Number.isFinite));
  let expected = top;
  if (block.top < top) expected = block.top;
  else if (block.bottom > top + height) expected = (block.bottom - block.top > height ? Math.min(block.bottom, block.top + Math.min(height, lineHeight * 4)) : block.bottom) - height;
  return Math.min(Math.max(0, totalHeight - height), Math.max(0, expected));
}
export function assertMinimalNavigation(before, after, { noScroll = false } = {}) {
  const counter = parseChangeCounter(after.history.counter), block = after.history.blocks.find(block => block.id === after.history.activeId);
  assert(block, 'Navigation must expose actual mounted rows for the active semantic change.');
  assert.equal(after.history.path, before.history.path, 'This assertion is within one immutable file.');
  assert.equal(counter.count, parseChangeCounter(before.history.counter).count);
  const expected = expectedMinimalScroll(before.history.scroll, block, after.history.lineHeight || 20);
  assert(Math.abs(after.history.scroll.top - expected) <= 2, `Navigation moved beyond minimum: ${before.history.scroll.top} -> ${after.history.scroll.top}; expected ${expected}.`);
  if (noScroll) assert(Math.abs(after.history.scroll.top - before.history.scroll.top) <= 1, 'An already viewport-visible (including flush-edge) block must not scroll.');
  const visibleBottom = block.bottom - block.top > after.history.scroll.height ? Math.min(block.bottom, block.top + (after.history.lineHeight || 20) * 4) : block.bottom;
  assert(block.top >= after.history.scroll.top - 2 && visibleBottom <= after.history.scroll.top + after.history.scroll.height + 2, 'Active block was not actually revealed.');
  return { counter, block, before: before.history.scroll, after: after.history.scroll, expected };
}
export function assertToolbars(view) {
  for (const action of ['open-repository', 'open-directory', 'repository-options', 'toggle-repository-tree', 'settings']) assert(view.global.actions.includes(action), `Global toolbar missing ${action}.`);
  for (const action of ['sync', 'show-local-commit', 'refresh', 'more-git-actions', 'checkout-branch']) {
    assert(!view.global.actions.includes(action), `Repository action ${action} leaked into global toolbar.`);
    assert.equal(view.repository.actions.filter(item => item.action === action).length, 1);
  }
  assert(view.global.box && view.repository.box && view.global.box.bottom <= view.repository.box.top + 2);
  assert(samePath(view.repository.path, view.shell.repoPath));
}
export function assertRowControls(item) {
  assert(item?.candidate && item.box, 'A real repository row is required.');
  assert.deepEqual(item.controls.map(control => control.action), ['repository-branch', 'repository-sync', 'repository-commit', 'repository-refresh', 'repository-more']);
  for (const control of item.controls) {
    assert(control.visible && control.box && Number(control.opacity) === 1, `Fixed repository control disappeared: ${control.action}`);
    assert(control.box.left >= item.box.left - 2 && control.box.right <= item.box.right + 2, 'Repository controls escape their row.');
  }
  const widths = item.controls.slice(1).map(control => control.box.width);
  assert(widths.every(width => Math.abs(width - widths[0]) <= 1) && widths[0] >= 20);
  assert(item.branch && item.branch !== '—', 'Branch must come from a completed actual repository summary.');
  return item.controls;
}
export function assertLocalGroups(view, facts) {
  assert(view.workspace.localOpen && view.local.visible && view.local.listBox && view.local.previewBox);
  assert.equal(view.local.inTreeItem, false, 'Inline local controls must be a sibling region, not children of a treeitem.');
  assert.deepEqual(view.local.groups.map(group => group.id), ['staged', 'unstaged', 'untracked'].filter(group => facts[group].length > 0), 'Empty groups are omitted, never fabricated from sample counts.');
  for (const group of view.local.groups) assert.equal(group.count, facts[group.id].length, `${group.id}: UI count must match actual Git, not fixed sample counts.`);
  // This owned fixture is below the product's virtualization threshold; compare every path as well as counts.
  for (const group of view.local.groups) if (group.expanded === 'true') assert.deepEqual(view.local.files.filter(file => file.group === group.id).map(file => file.path).sort(), [...facts[group.id]].sort());
}
export function assertDraft(before, after) {
  assert(before.local.message && after.local.message);
  for (const name of ['value', 'start', 'end', 'direction', 'scrollTop']) assert.deepEqual(after.local.message[name], before.local.message[name], `Moving the exact local composer lost draft ${name}.`);
  assert.equal(after.shell.repoPath, before.shell.repoPath); assert.equal(after.shell.head, before.shell.head);
}
export function assertGraphRestored(before, after) {
  assert(before.graph.scroll.top > 0 && before.tree.scroll.top > 0, 'Restoration evidence needs nonzero graph AND repository-tree scroll.');
  assert.equal(after.graph.visible, true); assert.equal(after.history.visible, false);
  assert.deepEqual(after.graph.selected, before.graph.selected); assert.equal(after.graph.activeDescendant, before.graph.activeDescendant);
  assert.equal(after.details.oid, before.details.oid); assert.equal(after.details.selectedFile, before.details.selectedFile);
  for (const [name, a, b] of [['graph', before.graph.scroll, after.graph.scroll], ['repository tree', before.tree.scroll, after.tree.scroll], ['changed files', before.details.filesScroll, after.details.filesScroll]]) {
    for (const key of ['top', 'left']) assert(Math.abs(a[key] - b[key]) <= 1, `${name} ${key} lost on returning from a history tab.`);
  }
}
const workingBytes = snapshot => [...snapshot.tracked.map(item => ({ path: item.path, working: item.working })), ...snapshot.untracked.map(item => ({ path: item.path, working: item.working }))].sort((a, b) => a.path.localeCompare(b.path));
export function assertIndexOnly(before, after) {
  for (const name of ['identity', 'head', 'headFile', 'refs', 'untracked']) assert.deepEqual(after[name], before[name], `Index action changed ${name}.`);
  assert.deepEqual(workingBytes(after), workingBytes(before), 'Stage/unstage changed real file bytes.');
  assert.notDeepEqual(after.index, before.index, 'Actual index bytes did not change.');
}
export function assertCommitOnly(before, after, { branch, path, stagedOid, message, actual }) {
  assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.headFile, before.headFile);
  assert.notEqual(after.head, before.head); assert.equal(actual.parent, before.head); assert.equal(actual.message, message);
  assert.deepEqual(actual.paths, [path]); assert.equal(actual.blob, stagedOid);
  assert.deepEqual(workingBytes(after), workingBytes(before)); assert.deepEqual(after.untracked, before.untracked);
  assert.deepEqual(after.refs, before.refs.map(ref => ref === `refs/heads/${branch} ${before.head} commit` ? `refs/heads/${branch} ${after.head} commit` : ref).sort(), 'Commit changed more than its one expected local branch.');
}
export function assertDeleteOnly(before, after, path) {
  assert(before.untracked.some(file => file.path === path), 'Delete requires an actually untracked fixture file.');
  for (const name of ['identity', 'head', 'headFile', 'index', 'refs', 'tracked']) assert.deepEqual(after[name], before[name], `Untracked deletion changed ${name}.`);
  assert.deepEqual(after.untracked, before.untracked.filter(file => file.path !== path), 'Deletion changed a second untracked path.');
}
export function assertLayout(view, { theme, position, surface }) {
  assert.equal(view.theme, theme); assert.equal(view.workspace.position, position);
  const epsilon = 2, contained = (child, parent, name) => { assert(child && parent, `${name} is not visible.`); assert(child.left >= parent.left - epsilon && child.right <= parent.right + epsilon, `${name} escapes horizontal bounds.`); };
  assert(view.viewport.width >= 660 && view.viewport.height >= 400);
  assert(view.documentBounds.scrollWidth <= view.documentBounds.clientWidth + epsilon && view.documentBounds.bodyScrollWidth <= view.viewport.width + epsilon, 'Root document horizontally overflows.');
  contained(view.global.box, { left: 0, right: view.viewport.width }, 'Global toolbar'); contained(view.repository.box, { left: 0, right: view.viewport.width }, 'Repository toolbar');
  assert(view.footer?.box && Math.abs(view.footer.box.bottom - view.viewport.height) <= epsilon, 'Status footer must remain at the actual viewport bottom.');
  if (view.sidebar) { assert(view.sidebar.width >= 178); contained(view.tree.box, view.sidebar, 'Repository tree'); assert(view.tree.box.scrollWidth <= view.tree.box.clientWidth + epsilon, 'Repository tree horizontally overflows.'); }
  if (surface === 'local') { assert(view.local.visible && view.local.listBox && view.local.previewBox); assert.equal(view.local.inTree, position === 'inline'); }
  else if (surface === 'details') {
    assert(view.graph.visible && view.details.open && view.details.inline); assert.equal(view.details.embeddedDiff, false, 'History details are information + file list, not the old embedded diff.');
    const { box: detail, metadataBox, filesPaneBox, filesBox, widthResizer } = view.details;
    const graphClip = view.graph.clipBox, viewport = { left: 0, right: view.viewport.width };
    contained(view.graph.box, viewport, 'Commit graph viewport'); contained(detail, view.graph.box, 'Inline details'); contained(detail, viewport, 'Inline details native viewport');
    contained(graphClip, view.graph.box, 'Commit graph client clip'); contained(detail, graphClip, 'Inline details client clip');
    for (const [name, bounds] of [['History metadata column', metadataBox], ['History files column', filesPaneBox], ['Changed-file list viewport', filesBox], ['History width resizer', widthResizer]]) {
      contained(bounds, detail, name); contained(bounds, graphClip, `${name} graph clip`); contained(bounds, viewport, `${name} native viewport`);
      assert(bounds.width > 0 && bounds.height > 0, `${name} has no rendered area.`);
      assert(Math.min(bounds.bottom, graphClip.bottom) - Math.max(bounds.top, graphClip.top) > 0, `${name} is outside the visible screenshot vertically.`);
    }
    assert(metadataBox.width >= 189.5 && filesPaneBox.width >= 189.5, 'Both history detail columns must remain at least 190px wide, including at native width 760.');
    contained(filesBox, filesPaneBox, 'Changed-file list within its own pane');
    assert(Math.abs(metadataBox.right - widthResizer.left) <= epsilon && Math.abs(widthResizer.right - filesPaneBox.left) <= epsilon, 'History width resizer must remain between the two visible columns.');
    // Long paths may overflow individual file rows inside this bounded, independently
    // scrollable list. Their scrollWidth/scrollLeft are not root/detail overflow.
  }
  else if (surface === 'document') assert(view.history.visible && view.history.ready && view.history.diffBox);
  else assert.fail(`Unknown evidence surface: ${surface}`);
  return { nativeViewport: view.viewport, sidebar: view.sidebar, global: view.global.box, repository: view.repository.box, footer: view.footer.box, local: view.local.box, details: view.details.box, detailColumns: surface === 'details' ? { graphViewport: view.graph.box, graphClip: view.graph.clipBox, graphScroll: view.graph.scroll, metadata: view.details.metadataBox, filesPane: view.details.filesPaneBox, fileList: view.details.filesBox, fileScroll: view.details.filesScroll, widthResizer: view.details.widthResizer } : null, document: view.history.box };
}
export async function realChord(wd, keys) {
  try { await wd.call('POST', `${wd.prefix}/actions`, { actions: [{ type: 'key', id: 'workspace-owned-keyboard', actions: [...keys.map(value => ({ type: 'keyDown', value })), ...[...keys].reverse().map(value => ({ type: 'keyUp', value }))] }] }); }
  finally { await wd.call('DELETE', `${wd.prefix}/actions`); }
}

export function navigationText(revision, count = 240) {
  const changed = new Set([20, 100, 180]);
  return Array.from({ length: count }, (_, index) => { const line = index + 1; return `Line ${String(line).padStart(3, '0')} · ${revision && changed.has(line) ? `review replacement ${revision}` : 'immutable owned fixture context'} · no application sample data`; }).join('\n') + '\n';
}
function ownedRead(run, path, args) {
  assert(run.workspaceRepositories?.some(repository => samePath(repository, path)), 'Read request is outside this runner\'s exact owned repositories.');
  assert(['rev-parse', 'show', 'diff', 'diff-tree', 'ls-files', 'status', 'for-each-ref', 'log'].includes(args[0]), 'Only explicit read-only Git commands are allowed after fixture sealing.');
  return git(run, path, args).stdout;
}
async function snapshotScope(run, repositories) {
  const result = {};
  for (const [name, path] of Object.entries(repositories)) {
    const snapshot = await repositorySnapshot(run, path), commonDir = await realpath(resolve(path, ownedRead(run, path, ['rev-parse', '--git-common-dir']).toString('utf8').trim()));
    for (const identity of [snapshot.identity.path, snapshot.identity.gitDir, commonDir]) assert(inside(join(run.output, 'workspace'), identity), 'Actual fixture identity escaped this run-owned workspace.');
    result[name] = { ...snapshot, commonDir };
  }
  return result;
}
function gitFacts(run, path) {
  const names = args => ownedRead(run, path, args).toString('utf8').split('\0').filter(Boolean).sort();
  return { staged: names(['diff', '--cached', '--name-only', '-z']), unstaged: names(['diff', '--name-only', '-z']), untracked: names(['ls-files', '--others', '--exclude-standard', '-z']) };
}
async function createWorkspaceFixtures(run, check) {
  const workspace = join(run.output, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, '.workspace-owner.json'), JSON.stringify({ runId: run.manifest.runId, scope: 'Only newly created local workspace acceptance repositories.' }), { flag: 'wx' });
  const root = join(workspace, 'Workspace scope 中文'), alphaName = 'Alpha workspace 中文', bravoName = 'Bravo clean repository';
  const alpha = join(root, alphaName), bravo = join(root, bravoName), remote = join(workspace, 'local-only-origin.git');
  await mkdir(root); const repositories = { alpha, bravo, remote }; let sealed = false, clock = 0;
  const setup = (path, args, options) => { check(); assert(!sealed && (samePath(workspace, path) || inside(workspace, path))); return git(run, path, args, options); };
  const write = async (path, file, bytes) => { assert(!sealed && inside(workspace, path)); await mkdir(dirname(join(path, file)), { recursive: true }); await writeFile(join(path, file), bytes); };
  const configure = path => { for (const [key, value] of [['user.name', 'Workspace acceptance fixture'], ['user.email', 'workspace@example.invalid'], ['core.hooksPath', run.manifest.git.hooksDirectory], ['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['credential.helper', ''], ['protocol.allow', 'never'], ['protocol.file.allow', 'always']]) setup(path, ['config', '--local', key, value]); };
  const init = async (path, branch) => { await mkdir(path, { recursive: true }); setup(path, ['init', '-b', branch, `--template=${run.manifest.git.templateDirectory}`]); configure(path); };
  const commit = (path, subject, { empty = false, body = '' } = {}) => {
    if (!empty) setup(path, ['add', '--all']); const date = new Date(Date.UTC(2026, 0, 3, 8, clock++)).toISOString();
    setup(path, ['commit', '--quiet', ...(empty ? ['--allow-empty'] : []), '-m', subject, ...(body ? ['-m', body] : [])], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return gitText(run, path, ['rev-parse', 'HEAD']);
  };
  const navPaths = ['review/zz-navigation-00.txt', 'review/zz-navigation-01.txt'];
  const reviewPaths = [...Array.from({ length: 38 }, (_, index) => `review/groups/group-${String(Math.floor(index / 5) + 1).padStart(2, '0')}/file-${String(index + 1).padStart(2, '0')} with spaces 中文.txt`), ...navPaths];
  const overlap = 'local/overlap 中文.txt', keptTracked = 'local/keep tracked.txt', deletion = 'untracked/delete me 中文.txt', keptUntracked = 'untracked/keep me.txt';
  await init(alpha, 'alpha-main');
  for (const path of reviewPaths) await write(alpha, path, navigationText(''));
  await write(alpha, overlap, 'Owned overlap HEAD bytes.\n'); await write(alpha, keptTracked, 'Owned kept HEAD bytes.\n');
  commit(alpha, 'Workspace initial actual Git files');
  for (let index = 0; index < 28; index++) commit(alpha, `Workspace older immutable history ${String(index + 1).padStart(2, '0')}`, { empty: true });
  for (const path of reviewPaths) await write(alpha, path, navigationText('v3'));
  const longMessage = Array.from({ length: 24 }, (_, index) => `Acceptance paragraph ${String(index + 1).padStart(2, '0')}. This deliberately long real commit message must grow the inline detail, never a nested metadata scrollbar. Only owned local Git objects are displayed.`).join('\n\n');
  const review = commit(alpha, 'Workspace review of forty real files and long message', { body: longMessage });
  for (let index = 0; index < 28; index++) commit(alpha, `Workspace newer immutable history ${String(index + 1).padStart(2, '0')}`, { empty: true });
  const head = gitText(run, alpha, ['rev-parse', 'HEAD']);
  await init(bravo, 'bravo-main'); await write(bravo, 'clean.txt', 'A genuinely clean independently committed repository.\n'); const bravoHead = commit(bravo, 'Bravo clean actual history');
  setup(workspace, ['-c', 'protocol.file.allow=always', 'clone', '--bare', '--no-hardlinks', '--', bravo, remote]); configure(remote);
  const scrollCandidates = [];
  for (let index = 1; index <= 7; index++) {
    const components = [`Collection ${String(index).padStart(2, '0')}`, 'level one', 'level two', 'level three', `Readonly ${String(index).padStart(2, '0')}`], path = join(root, ...components);
    await mkdir(dirname(path), { recursive: true });
    setup(root, ['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', '--config', `core.hooksPath=${run.manifest.git.hooksDirectory}`, '--config', 'protocol.allow=never', '--config', 'protocol.file.allow=always', '--', remote, path]);
    repositories[`scroll${index}`] = path; scrollCandidates.push({ path, key: treeKey(components), components });
  }
  setup(alpha, ['remote', 'add', 'origin', remote]); // Never sync this deliberately unrelated local remote.
  const baseOid = gitText(run, alpha, ['rev-parse', `HEAD:${overlap}`]);
  await write(alpha, overlap, 'Owned overlap independently STAGED bytes.\n'); setup(alpha, ['add', '--', overlap]);
  await write(alpha, overlap, 'Owned overlap current WORKTREE bytes.\n'); await write(alpha, keptTracked, 'Owned kept tracked unstaged bytes must survive commit and delete.\n');
  await write(alpha, deletion, 'Owned deletion target; native UI must require the full exact relative path.\n'); await write(alpha, keptUntracked, 'Owned second untracked path must never be deleted or committed.\n');
  sealed = true; run.workspaceRepositories = Object.values(repositories);
  const before = await snapshotScope(run, repositories); await json(join(run.output, 'repository-before.json'), before);
  const facts = gitFacts(run, alpha), reviewCounts = Object.fromEntries(navPaths.map(path => [path, (ownedRead(run, alpha, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', `${review}^`, review, '--', path]).toString('utf8').match(/^@@ /gm) ?? []).length]));
  assert.equal(reviewPaths.length, 40); assert(reviewCounts[navPaths[0]] >= 3 && reviewCounts[navPaths[0]] === reviewCounts[navPaths[1]]);
  const fixture = { schemaVersion: 1, runId: run.manifest.runId, workspace, root: await realpath(root), depth: 5, repositories,
    alpha: { path: before.alpha.identity.path, key: treeKey([alphaName]), name: alphaName, branch: 'alpha-main', head, review, order: ownedRead(run, alpha, ['log', '--format=%H', '--date-order']).toString('utf8').trim().split('\n') },
    bravo: { path: before.bravo.identity.path, key: treeKey([bravoName]), branch: 'bravo-main', head: bravoHead }, scrollCandidates,
    navPaths, reviewPaths, reviewCounts, longMessage, overlap, keptTracked, deletion, keptUntracked, baseOid, facts,
    workingOverlap: sha256(await readFile(join(alpha, overlap))), deletionBytes: sha256(await readFile(join(alpha, deletion))),
    scope: 'All fixture objects, refs, worktrees, administration directories and remotes are inside this new workspace; no real user repository is accepted.' };
  await json(join(run.output, 'workspace-fixtures.json'), fixture); return { fixture, before };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { values: ['binary', 'driver', 'output', 'git', 'tauri-driver'], flags: ['help'] });
  if (options.help) {
    console.log('node scripts/test-workspace-desktop.mjs --binary <isolated-candidate.exe> --driver <verified-msedgedriver.exe> --output <new-empty-run> [--git <exe>] [--tauri-driver <exe>]\nReal Windows workspace-v3 acceptance only; creates owned local Git fixtures and an isolated profile. No build/install/package/version/release, no demo, no real-repository argument. Native 760/1280/1455 dark/light PNG+DOM evidence. Exit 0 passed, 1 failed, 2 blocked; never reuse output.'); return;
  }
  required(options, ['binary', 'driver', 'output']);
  const run = await createRun(resolve(options.output), 'workspace-desktop'), owned = new OwnedProcesses(run), controller = new AbortController();
  const deadline = Date.now() + RUN_BUDGET_MS, cleanupErrors = [], mutations = [], transitions = [];
  const timer = setTimeout(() => controller.abort(new BlockedError('Workspace desktop exceeded its ten-minute work budget; remaining acceptance is not passed.')), RUN_BUDGET_MS); timer.unref();
  const sigint = () => controller.abort(new Error('SIGINT: interrupted')), sigterm = () => controller.abort(new Error('SIGTERM: interrupted'));
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  let wd, monitor, originalCall, fixture, before, accepted, failure;
  run.manifest.workspace = { requiredVersion: REQUIRED_VERSION, workBudgetMs: RUN_BUDGET_MS, scope: SCOPE, nativeWidths: NATIVE_WIDTHS, themes: THEMES, fixtures: 'workspace-fixtures.json', mutations, transitions };
  function check() { controller.signal.throwIfAborted(); monitor?.check(); if (Date.now() >= deadline) throw new BlockedError('Workspace acceptance work budget expired.'); }
  async function observe({ allowDialogError = false } = {}) {
    check(); const view = await wd.script(READ_WORKSPACE_DOM); assert(view.shell && view.footer, 'Actual native application diagnostics/status are required.');
    assert.deepEqual(view.errors, [], 'Actual application reported an error.');
    if (!allowDialogError) for (const dialog of view.dialogs) assert.deepEqual(dialog.error, []);
    const signature = JSON.stringify([view.shell.repoPath, view.shell.head, view.shell.taskState, view.shell.sequence, view.workspace, view.local.busy, view.history.path, view.history.counter, view.footer.workingState]);
    if (transitions.length < 300 && transitions.at(-1)?.signature !== signature) transitions.push({ at: new Date().toISOString(), signature, shell: view.shell, workspace: view.workspace, localBusy: view.local.busy, history: { path: view.history.path, counter: view.history.counter }, footer: view.footer });
    return view;
  }
  async function wait(name, predicate, timeout = 20_000, observationOptions) { return until(name, async () => { const view = await observe(observationOptions); return predicate(view) ? view : false; }, { timeout: Math.max(1, Math.min(timeout, deadline - Date.now())), interval: 80, signal: controller.signal }); }
  async function step(name, work, { continueOnBlocked = false } = {}) {
    const result = { label: name, status: 'running', requiredForBaseline: true, startedAt: new Date().toISOString() }; run.manifest.results.push(result); await run.save();
    try { check(); result.observed = await work(); check(); result.status = 'passed'; return result.observed; }
    catch (error) { result.status = error instanceof BlockedError ? 'blocked' : 'failed'; result.error = errorInfo(error); if (!(continueOnBlocked && error instanceof BlockedError)) throw error; return null; }
    finally { result.finishedAt = new Date().toISOString(); await run.save(); }
  }
  async function archive(name, observationOptions) {
    const view = await observe(observationOptions); await json(join(run.output, `evidence/${name}-observed.json`), view);
    const evidence = await archiveDesktop(run, wd, name); assert.equal(evidence.errors.length, 0, `Incomplete actual desktop evidence: ${name}`); return view;
  }
  async function resize(width, height = 900) {
    let rect; try { rect = await wd.call('POST', `${wd.prefix}/window/rect`, { width, height }); }
    catch (error) { if (unsupportedDriver(error)) throw new BlockedError(`Native window rectangle unavailable, no CSS/screenshot substitute: ${error.message}`); throw error; }
    assertNativeRect(rect, width); return rect;
  }
  async function wheel(selector, deltaY, { edge = false } = {}) {
    const element = await wd.find(selector), box = await wd.script(READ_TARGET_BOX, [selector]); assert(box && box.width > 5 && box.height > 5, `No real wheel target: ${selector}`);
    try { await wd.call('POST', `${wd.prefix}/actions`, { actions: [{ type: 'wheel', id: 'workspace-owned-wheel', actions: [{ type: 'scroll', duration: 0, origin: { [ELEMENT]: element }, x: edge ? -Math.floor(box.width / 2) + 8 : 0, y: edge ? -Math.floor(box.height / 2) + 8 : 0, deltaX: 0, deltaY: Math.round(deltaY) }] }] }); }
    catch (error) { if (unsupportedDriver(error)) throw new BlockedError(`Actual wheel scrolling unsupported: ${error.message}`); throw error; }
    finally { await wd.call('DELETE', `${wd.prefix}/actions`); }
    // Native wheel delivery may finish after /actions returns. Observe only: do not
    // manufacture scroll or compare independent surfaces against an in-flight baseline.
    let previous, stableSince = 0, samples = 0; const started = Date.now();
    return until('actual wheel scroll and viewport settle', async () => {
      check(); const current = await wd.script(READ_TARGET_SCROLL, [selector]); assert(current, `Wheel target disappeared: ${selector}`);
      const signature = JSON.stringify(current); samples++;
      if (signature !== previous) { previous = signature; stableSince = Date.now(); }
      return Date.now() - started >= 300 && Date.now() - stableSince >= 240 && samples >= 4 ? current : false;
    }, { timeout: Math.min(4000, Math.max(1, deadline - Date.now())), interval: 80, signal: controller.signal });
  }
  async function wheelTo(selector, top, current) {
    await wheel(selector, top - current);
    return wait('actual wheel reaches requested local diff offset', view => Math.abs(view.history.scroll.top - top) <= 2);
  }
  async function settings(patch) {
    await wd.click(SELECTORS.settings); await wait('actual Settings modal', view => view.settings.open);
    for (const [name, value] of Object.entries(patch)) {
      const selector = `.settings-dialog[open] select[data-setting=${css(name)}]`;
      if ((await observe()).settings.values[name] !== value) await selectOption(wd, selector, value);
    }
    await wd.clickText('.settings-dialog[open] > .dialog-footer button', 'Close');
    return wait('Settings saved and closed', view => !view.settings.open && (!patch.theme || view.theme === patch.theme) && (!patch.localChangesPosition || view.workspace.position === patch.localChangesPosition));
  }
  async function activate(candidate) {
    await wd.click(label(candidate.key));
    return wait('owned repository actually activated', view => samePath(view.shell.repoPath, candidate.path) && view.shell.head === candidate.head && view.shell.taskState === 'idle' && view.tree.rows.some(item => item.key === candidate.key && item.active));
  }
  async function historyTab() {
    let view = await observe();
    if (view.viewport.width < 1280 && view.workspace.localOpen && view.workspace.activeTab !== 'history') await wd.clickText('.workspace-tabs button', 'Commit graph');
    view = await observe(); if (view.history.visible) await wd.click(SELECTORS.graphTab);
    return wait('actual commit graph surface visible', view => view.graph.visible);
  }
  async function localTab() {
    await wd.click(SELECTORS.localCommit);
    return wait('actual local composer visible', view => view.workspace.localOpen && view.local.visible && !!view.local.listBox);
  }
  async function closeLocal() { const view = await observe(); if (view.workspace.localOpen) { await localTab(); await wd.click(SELECTORS.localClose); } return historyTab(); }
  async function closeDetails() {
    const view = await historyTab();
    if (view.details.open) { await revealDetailHeader(); await wd.click('.details-pane.history-details:not([hidden]) button[aria-label="Close details (Escape)"]'); }
    return wait('history details actually close', view => !view.details.open);
  }
  async function revealCommit(oid) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const view = await observe(), item = view.graph.rows.find(item => item.oid === oid), viewport = view.graph.box;
      if (item?.box && item.box.top >= viewport.top + 2 && item.box.bottom <= viewport.bottom - 2) return view;
      const forward = !item?.box || item.box.top >= viewport.bottom;
      await wheel(SELECTORS.graph, forward ? 320 : -320, { edge: true });
    }
    throw new Error(`Owned immutable commit did not become viewport-visible through real wheel input: ${oid}`);
  }
  async function reviewDetails() {
    await historyTab(); let view = await observe();
    if (view.details.open && view.details.oid === fixture.alpha.review) return view;
    if (view.details.open) await closeDetails();
    await revealCommit(fixture.alpha.review); await wd.click(commitCell(fixture.alpha.review));
    return wait('actual forty-file review information', view => view.details.oid === fixture.alpha.review && view.details.fileRows.length > 0 && !view.details.embeddedDiff);
  }
  async function revealDetailHeader() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const view = await observe(); assert(view.details.open && view.details.box && view.graph.box);
      if (view.details.box.top >= view.graph.box.top - 1 && view.details.box.top <= view.graph.box.bottom - 70) return view;
      await wheel(SELECTORS.graph, Math.max(-1400, Math.min(1400, view.details.box.top - view.graph.box.top - 12)), { edge: true });
    }
    throw new Error('Actual inline detail heading never became viewport-visible through real wheel input.');
  }
  async function focusFiles() {
    await wd.click(SELECTORS.fileFilter);
    for (let attempt = 0; attempt < 5; attempt++) { await wd.keys([KEY.tab]); const view = await observe(); if (view.focus.fileList) return view; }
    throw new Error('Real Tab navigation did not reach the changed-file list.');
  }
  async function openNavigationDocument() {
    await reviewDetails(); const current = await observe();
    if (current.details.messageExpanded === 'true') await wd.click(`${SELECTORS.details} [data-action="toggle-full-message"]`);
    await focusFiles(); await wd.keys([KEY.end]);
    await wait('real changed-file list reaches its last items', view => view.details.filesScroll.top > 0 && view.details.fileRows.some(item => item.path === fixture.navPaths[0]));
    // Repository tree is an independent scroll container; its nonzero offset must survive document tabs.
    await wheel(SELECTORS.tree, 180);
    await wait('nonzero actual repository-tree scroll', view => view.tree.scroll.top > 0);
    await wd.click(`${SELECTORS.files} .file-row[data-path=${css(fixture.navPaths[0])}]`);
    return wait('history file click activates an immutable document tab', view => view.history.visible && view.history.path === fixture.navPaths[0] && view.history.ready);
  }
  async function currentSnapshot() { return { ...(await repositorySnapshot(run, fixture.alpha.path)), commonDir: before.alpha.commonDir }; }
  async function mutation(name, action, verify) {
    const previous = await currentSnapshot(); assertSameSnapshot(accepted.alpha, previous, `Before ${name}`);
    const initial = await observe(); await action();
    await wait(`${name} native task and refresh finish`, view => view.shell.taskState === 'idle' && view.shell.sequence > initial.shell.sequence && view.local.busy === 'false');
    const next = await currentSnapshot(), facts = gitFacts(run, fixture.alpha.path); const verified = await verify(previous, next, facts);
    accepted.alpha = next; const result = { name, at: new Date().toISOString(), taskSequence: [initial.shell.sequence, (await observe()).shell.sequence], before: previous, after: next, facts, verified };
    mutations.push(result); await json(join(run.output, 'accepted-mutations.json'), mutations); await run.save(); return result;
  }
  try {
    if (process.platform !== 'win32') throw new BlockedError('Requires the actual Windows desktop, supplied native binary and verified driver. No browser/demo fallback.');
    const source = await readVersion(PROJECT); assert.equal(source.version, REQUIRED_VERSION); run.manifest.workspace.source = source;
    run.gitBinary = gitExecutable(options.git); run.manifest.git.executable = run.gitBinary;
    const created = await createWorkspaceFixtures(run, check); fixture = created.fixture; before = created.before; accepted = structuredClone(before); await run.save();
    wd = await startDesktop(run, options, owned); monitor = monitorOwnedProcesses(owned); originalCall = wd.call.bind(wd);
    wd.call = (method, path, body, timeout = 15_000) => { check(); return originalCall(method, path, body, Math.max(1, Math.min(timeout, 20_000, deadline - Date.now()))); };
    await step('actual-native-candidate-version-and-isolated-empty-profile', async () => {
      const view = await observe(); assert.equal(view.locale, 'en'); assert.equal(view.shell.repoPath, ''); assert(samePath(view.shell.configDirectory, run.profileDirectory));
      const state = await readJson(join(run.profileDirectory, 'state.json')); assert.deepEqual(state.trusted, []); assert.deepEqual(state.recent, []); assert.equal(state.lastRepo, null);
      await wd.click(SELECTORS.settings); await wd.clickText('.settings-tabs [role="tab"]', 'About & privacy');
      const diagnostics = assertDiagnostics(await observe(), source, run.profileDirectory); await archive('native-candidate-about-isolated-profile');
      await wd.clickText('.settings-dialog[open] > .dialog-footer button', 'Close'); await resize(1455); return diagnostics;
    });
    await step('global-vs-repository-toolbars-and-tree-branch-four-fixed-actions', async () => {
      await wd.click(SELECTORS.repositoryOptions); await wd.click(SELECTORS.openDirectory); await wd.fill(SELECTORS.path, fixture.root); await wd.fill(SELECTORS.depth, String(fixture.depth)); await wd.click(SELECTORS.confirmDirectory);
      await wait('actual multi-repository directory discovery', view => samePath(view.tree.root, fixture.root) && view.tree.busy === 'false' && view.shell.taskState === 'idle');
      assert.equal((await observe()).shell.repoPath, '', 'A multi-repository scope cannot silently activate the first candidate.');
      // Normalize the actual separator from its own current minimum, not from a
      // presumed fresh width (the approved responsive defaults may change).
      await wd.click('.app-content > .resize-handle[role="separator"]'); await wd.keys([KEY.home]);
      const minimum = Number((await observe()).focus.value); assert(Number.isFinite(minimum));
      const widthSteps = Math.max(0, Math.round((380 - minimum) / 8));
      if (widthSteps) await wd.keys(Array(widthSteps).fill(KEY.right));
      await wait('actual repository sidebar grows for fixed-row controls', view => view.sidebar?.width >= 374 && view.sidebar?.width <= 386);
      const view = await activate(fixture.alpha); assertToolbars(view);
      const ready = await wait('actual visible Alpha and Bravo branch summaries', view => [fixture.alpha.key, fixture.bravo.key].every(key => { const item = view.tree.rows.find(item => item.key === key); return item?.branch && item.branch !== '—'; }));
      assertLocalGroups(ready, fixture.facts); assert.equal(ready.workspace.position, 'middle'); assert.equal(ready.local.inTree, false);
      const controls = [fixture.alpha.key, fixture.bravo.key].map(key => assertRowControls(ready.tree.rows.find(item => item.key === key)));
      await archive('workspace-native-default-middle-fixed-row-actions'); return { controls, actualGitGroups: fixture.facts };
    });
    await step('same-repository-click-only-toggles-local-clean-stays-closed-and-switch-restores-draft', async () => {
      await wd.fill(SELECTORS.message, `Owned draft ${run.manifest.runId}\nDo not discard on repository switches.`); let view = await observe(), draft = view.local.message.value;
      const baseline = { graph: view.graph.selected, details: view.details.oid, head: view.shell.head, sequence: view.shell.sequence };
      await wd.click(label(fixture.alpha.key)); view = await wait('same row hides only local changes', view => !view.workspace.localOpen);
      assert.deepEqual(view.graph.selected, baseline.graph); assert.equal(view.details.oid, baseline.details); assert.equal(view.shell.head, baseline.head); assert.equal(view.shell.sequence, baseline.sequence);
      await wd.click(label(fixture.alpha.key)); view = await wait('same row reopens local changes', view => view.workspace.localOpen && view.local.visible); assert.equal(view.local.message.value, draft);
      await activate(fixture.bravo); view = await observe(); assert.equal(view.footer.workingState, 'clean'); assert.equal(view.workspace.localOpen, false);
      await wd.click(label(fixture.bravo.key)); assert.equal((await observe()).workspace.localOpen, false);
      await wd.click(SELECTORS.localCommit); view = await observe(); assert.equal(view.workspace.localOpen, false); assert.match(view.toast ?? '', /No local changes/);
      await activate(fixture.alpha); view = await wait('Alpha local draft restored', view => view.local.visible); assert.equal(view.local.message.value, draft);
      await archive('workspace-repository-switch-draft-restored'); return { draft, cleanHead: fixture.bravo.head, alphaHead: view.shell.head };
    });
    await step('history-same-click-closes-arrow-up-down-and-pure-list-above-below-placement', async () => {
      await closeLocal(); await settings({ detailPosition: 'inline' });
      await revealCommit(fixture.alpha.head); await wd.click(commitCell(fixture.alpha.head)); let view = await wait('HEAD history details', view => view.details.oid === fixture.alpha.head);
      assert.equal(view.details.embeddedDiff, false); await wd.click(commitCell(fixture.alpha.head)); await wait('same immutable row click closes detail', view => !view.details.open);
      await wd.keys([KEY.down]); view = await wait('Down opens next actual commit without toggling', view => view.details.oid === fixture.alpha.order[1]);
      await wd.keys([KEY.up]); view = await wait('Up returns to actual HEAD', view => view.details.oid === fixture.alpha.head); await closeDetails();
      const placements = [];
      for (const side of ['below', 'above']) {
        const plain = await observe(), candidates = plain.graph.rows.filter(item => item.oid !== 'WORKTREE' && item.box && item.box.top >= plain.graph.box.top + 2 && item.box.bottom <= plain.graph.box.bottom - 2);
        const midpoint = plain.graph.box.top + plain.graph.box.height / 2;
        const eligible = candidates.filter(item => side === 'below' ? (item.box.top + item.box.bottom) / 2 < midpoint - 20 : (item.box.top + item.box.bottom) / 2 > midpoint + 20);
        assert(eligible.length, `Actual pure list has no ${side} placement candidate.`);
        const target = eligible[Math.floor(eligible.length / 2)]; await wd.click(commitCell(target.oid));
        const opened = await wait('inline details use unexpanded pure-list direction', view => view.details.oid === target.oid); assert.equal(opened.details.side, side); assert(opened.details.inline);
        placements.push({ oid: target.oid, pureListRow: target.box, pureListViewport: plain.graph.box, side: opened.details.side }); await archive(`history-pure-list-${side}`); await closeDetails();
      }
      return placements;
    });
    await step('history-information-file-list-resizers-long-message-and-independent-tree-scroll', async () => {
      let view = await reviewDetails(); assert(view.details.inline && !view.details.embeddedDiff); assert.equal(view.details.fileRole, 'tree');
      await wd.click(SELECTORS.widthResizer); const widthBefore = await observe(); assert(widthBefore.focus.separator);
      await wd.keys([KEY.right]); const wider = await observe(); assert(wider.details.metadataBox.width > widthBefore.details.metadataBox.width + 5);
      await wd.keys([KEY.left]); const widthRestored = await observe(); assert(Math.abs(widthRestored.details.metadataBox.width - widthBefore.details.metadataBox.width) <= 2);
      await wd.click(SELECTORS.heightResizer); const heightBefore = await observe(); assert(heightBefore.focus.separator);
      await wd.keys([KEY.down]); const taller = await observe(); assert(taller.details.box.height >= heightBefore.details.box.height + 6);
      await wd.keys([KEY.up]); const collapsed = await observe();
      await wd.click(`${SELECTORS.details} [data-action="toggle-full-message"]`); const expanded = await wait('real full commit body grows inline height', view => view.details.messageExpanded === 'true' && view.details.box.height > collapsed.details.box.height + 100);
      assert.equal(expanded.details.metadataScroll.top, 0); assert.equal(expanded.details.metadataOverflow, 'visible'); assert(expanded.details.messageBox);
      await archive('history-long-message-native-height-not-metadata-scroll'); await revealDetailHeader(); await wd.click(`${SELECTORS.details} [data-action="toggle-full-message"]`); await revealDetailHeader();
      await focusFiles(); await wd.keys([KEY.end]); view = await wait('forty-file tree independently scrolls to End', view => view.details.filesScroll.top > 0); assert.equal(view.history.visible, false, 'Arrow/End navigation must not open a historical file until click/Enter.');
      const graphBefore = view.graph.scroll.top; await wheel(SELECTORS.files, -96); const fileWheel = await observe(); assert.equal(fileWheel.graph.scroll.top, graphBefore);
      const fileTop = fileWheel.details.filesScroll.top; await wheel(SELECTORS.graph, 56, { edge: true }); const graphWheel = await observe(); assert.equal(graphWheel.details.filesScroll.top, fileTop);
      await focusFiles(); await wd.keys([KEY.home]); const folderBefore = await observe();
      const reviewFolder = folderBefore.details.folders.find(folder => folder.path === 'review'); assert(reviewFolder);
      await wd.keys([KEY.left]); view = await observe(); assert.equal(view.details.folders.find(folder => folder.path === 'review')?.expanded, 'false'); assert.equal(view.graph.scroll.top, folderBefore.graph.scroll.top);
      await wd.keys([KEY.right]); view = await observe(); assert.equal(view.details.folders.find(folder => folder.path === 'review')?.expanded, 'true');
      await wd.click(`${row(treeKey(['Collection 01']))} > .repository-tree-disclosure`); const treeCollapsed = await observe(); assert.equal(treeCollapsed.tree.rows.find(item => item.key === treeKey(['Collection 01']))?.expanded, 'false'); assert.equal(treeCollapsed.details.oid, fixture.alpha.review);
      await wd.click(`${row(treeKey(['Collection 01']))} > .repository-tree-disclosure`);
      await revealDetailHeader(); await wd.click('.details-pane.history-details .file-toolbar button[aria-label="Show file list"]');
      await wait('actual flat changed-file list', view => view.details.fileRole === 'listbox'); await focusFiles(); await wd.keys([KEY.home]); let flat = await observe(); assert.equal(flat.details.folders.length, 0); assert.equal(flat.history.visible, false);
      await wd.keys([KEY.down]); const flatDown = await observe(); assert.notEqual(flatDown.details.activeFile, flat.details.activeFile); assert.equal(flatDown.history.visible, false);
      await wd.keys([KEY.up]); assert.equal((await observe()).details.activeFile, flat.details.activeFile);
      await wd.click('.details-pane.history-details .file-toolbar button[aria-label="Show file tree"]'); await wait('actual file tree restored', view => view.details.fileRole === 'tree');
      await archive('history-information-and-independent-forty-file-tree');
      return { width: [widthBefore.details.metadataBox, wider.details.metadataBox], height: [heightBefore.details.box, taller.details.box], longMessage: [collapsed.details.box.height, expanded.details.box.height], fileWheel: fileWheel.details.filesScroll, graphWheel: graphWheel.graph.scroll };
    });
    let graphReturn;
    await step('history-file-click-opens-real-tab-with-immutable-oid-and-nonzero-return-anchor', async () => {
      await reviewDetails(); await focusFiles(); await wd.keys([KEY.end]); await wheel(SELECTORS.tree, 180);
      let view = await wait('both actual graph and repository tree scroll are nonzero', view => view.graph.scroll.top > 0 && view.tree.scroll.top > 0 && view.details.filesScroll.top > 0);
      graphReturn = view;
      await wd.click(`${SELECTORS.files} .file-row[data-path=${css(fixture.navPaths[0])}]`);
      view = await wait('real history document tab loaded', view => view.history.visible && view.history.path === fixture.navPaths[0] && view.history.ready);
      assert.equal(view.graph.visible, false); assert(view.history.tabs.some(tab => tab.selected && tab.id !== 'graph')); assert(view.history.context.includes(fixture.alpha.review.slice(0, 8)));
      assert.equal(parseChangeCounter(view.history.counter).count, fixture.reviewCounts[fixture.navPaths[0]]);
      // A file click changes selection before saving the graph surface; preserve that exact expected path.
      graphReturn.details.selectedFile = fixture.navPaths[0]; await archive('history-native-immutable-file-document'); return view.history;
    });
    await step('Alt-F5-visible-block-does-not-scroll-overflow-reveals-minimum-and-crosses-files', async () => {
      const observations = []; let view = await observe();
      assert.equal(parseChangeCounter(view.history.counter).active, 1);
      const firstId = view.history.activeId, second = view.history.blocks.find(block => block.top > view.history.blocks.find(block => block.id === firstId).top);
      assert(second && second.top >= view.history.scroll.top && second.bottom <= view.history.scroll.top + view.history.scroll.height, 'Owned compact patch must actually expose an already-visible next block.');
      // A real click on the non-editable document heading focuses its focusable native tabpanel.
      // Do not click Previous change merely to focus: its boundary intentionally changes files.
      await wd.click('.history-document-path'); const baseline = await observe();
      await realChord(wd, [KEY.alt, KEY.f5]); view = await wait('trusted Alt+F5 advances actual semantic block', view => parseChangeCounter(view.history.counter).active === 2);
      observations.push(assertMinimalNavigation(baseline, view, { noScroll: true }));
      await realChord(wd, [KEY.shift, KEY.alt, KEY.f5]); await wait('trusted reverse change shortcut', view => parseChangeCounter(view.history.counter).active === 1);
      await wd.click(SELECTORS.showUnchanged); view = await wait('explicit unchanged-context load finishes', view => view.history.showUnchanged === 'true' && view.history.ready && view.history.scroll.totalHeight > view.history.scroll.height + 100);
      await wd.click('.history-document-path'); let previous = await observe(); await realChord(wd, [KEY.alt, KEY.f5]);
      view = await wait('offscreen second block revealed', view => parseChangeCounter(view.history.counter).active === 2); observations.push(assertMinimalNavigation(previous, view)); assert(view.history.scroll.top > previous.history.scroll.top + 10);
      const secondBlock = view.history.blocks.find(block => block.id === view.history.activeId);
      assert(secondBlock && secondBlock.bottom - secondBlock.top < view.history.scroll.height, 'Owned navigation block must fit the actual viewport for flush-edge assertions.');
      previous = view; await realChord(wd, [KEY.shift, KEY.alt, KEY.f5]); view = await wait('offscreen first block revealed upward', view => parseChangeCounter(view.history.counter).active === 1); observations.push(assertMinimalNavigation(previous, view));
      const nearEdge = Math.max(0, Math.round(secondBlock.bottom - view.history.scroll.height - 11)); view = await wheelTo(SELECTORS.documentDiff, nearEdge, view.history.scroll.top);
      previous = view; await realChord(wd, [KEY.alt, KEY.f5]); view = await wait('eleven-pixel overflow advances block', view => parseChangeCounter(view.history.counter).active === 2); observations.push(assertMinimalNavigation(previous, view)); assert(view.history.scroll.top - previous.history.scroll.top <= 13);
      await realChord(wd, [KEY.shift, KEY.alt, KEY.f5]); view = await wait('first block active before flush-edge check', view => parseChangeCounter(view.history.counter).active === 1);
      const flush = Math.max(0, Math.round(secondBlock.bottom - view.history.scroll.height)); view = await wheelTo(SELECTORS.documentDiff, flush, view.history.scroll.top);
      previous = view; await realChord(wd, [KEY.alt, KEY.f5]); view = await wait('flush-edge visible block selected', view => parseChangeCounter(view.history.counter).active === 2); observations.push(assertMinimalNavigation(previous, view, { noScroll: true }));
      while (parseChangeCounter(view.history.counter).active < parseChangeCounter(view.history.counter).count) { previous = view; await realChord(wd, [KEY.alt, KEY.f5]); view = await wait('next fixture block', current => parseChangeCounter(current.history.counter).active > parseChangeCounter(previous.history.counter).active); observations.push(assertMinimalNavigation(previous, view)); }
      await realChord(wd, [KEY.alt, KEY.f5]); view = await wait('last change crosses to next real file', view => view.history.path === fixture.navPaths[1] && view.history.ready && parseChangeCounter(view.history.counter).active === 1);
      assert.equal(parseChangeCounter(view.history.counter).count, fixture.reviewCounts[fixture.navPaths[1]]);
      await realChord(wd, [KEY.shift, KEY.alt, KEY.f5]); view = await wait('first change reverse-crosses to previous real file last block', view => view.history.path === fixture.navPaths[0] && view.history.ready && parseChangeCounter(view.history.counter).active === parseChangeCounter(view.history.counter).count);
      await realChord(wd, [KEY.alt, KEY.pageDown]); await wait('Alt+PageDown changes real file', view => view.history.path === fixture.navPaths[1] && view.history.ready);
      await realChord(wd, [KEY.alt, KEY.pageUp]); await wait('Alt+PageUp changes real file', view => view.history.path === fixture.navPaths[0] && view.history.ready);
      await wd.click('.history-document-tools [data-action="next-file"]'); await wait('real next-file button', view => view.history.path === fixture.navPaths[1] && view.history.ready);
      await wd.click('.history-document-tools [data-action="previous-file"]'); await wait('real previous-file button', view => view.history.path === fixture.navPaths[0] && view.history.ready);
      await json(join(run.output, 'evidence/minimal-diff-navigation.json'), observations); await archive('history-native-keyboard-minimal-navigation'); return observations;
    });
    await step('return-from-history-tab-preserves-nonzero-graph-file-and-repository-tree-scroll', async () => {
      await wd.click(SELECTORS.graphTab); const view = await wait('graph returns with saved nonzero scroll', view => view.graph.visible && Math.abs(view.graph.scroll.top - graphReturn.graph.scroll.top) <= 1);
      assertGraphRestored(graphReturn, view); await archive('history-native-return-nonzero-scroll'); return { graph: view.graph.scroll, tree: view.tree.scroll, files: view.details.filesScroll };
    });
    await step('read-only-workspace-navigation-preserves-every-owned-repository-before-writes', async () => {
      const now = await snapshotScope(run, fixture.repositories); for (const name of Object.keys(before)) assertSameSnapshot(before[name], now[name], `Read-only workspace ${name}`);
      await json(join(run.output, 'repository-after-navigation.json'), now); return Object.keys(now);
    });
    await step('explicit-UI-trust-only-for-owned-Alpha-and-real-unstage-zero-commit-stage-unstage', async () => {
      await localTab(); await wheel(SELECTORS.tree, -20_000); await wait('repository tree returns to top', view => view.tree.scroll.top === 0);
      await wd.click('.trustbar:not(.diagnosticsbar) button'); let view = await wait('actual trust modal', view => view.dialogs.some(dialog => /Trust this repository/.test(dialog.title)));
      await wd.clickText('dialog[open] button[type="submit"]', 'Trust repository'); await wait('actual native repository trusted', view => !view.trustVisible);
      const trusted = await until('only owned Alpha trust persisted', async () => { const state = await readJson(join(run.profileDirectory, 'state.json')); return state.trusted.length === 1 && samePath(state.trusted[0], fixture.alpha.path) ? state.trusted : false; }, { timeout: 8000, signal: controller.signal });
      await mutation('unstage-listed-initial-index', () => wd.click('.local-changes-group[data-group="staged"] [data-action="unstage-group"]'), (previous, next, facts) => { assertIndexOnly(previous, next); assert.deepEqual(facts.staged, []); assert.equal(next.tracked.find(item => item.path === fixture.overlap).oid, fixture.baseOid); return facts; });
      await wd.fill(SELECTORS.message, `No staged write must occur ${run.manifest.runId}`); const zeroBefore = await currentSnapshot(), sequence = (await observe()).shell.sequence;
      await wd.click(SELECTORS.commit); view = await wait('zero-staged explicit no-auto-stage hint', view => /No staged changes/.test(view.local.composerError ?? ''));
      assert.equal(view.shell.sequence, sequence); assertSameSnapshot(zeroBefore, await currentSnapshot(), 'Zero-staged commit must not mutate Git'); await archive('local-native-zero-staged-no-auto-stage');
      await mutation('stage-only-overlap-file', () => wd.click(`${localFile('unstaged', fixture.overlap)} [data-action="stage-file"]`), (previous, next, facts) => { assertIndexOnly(previous, next); assert.deepEqual(facts.staged, [fixture.overlap]); assert(!facts.unstaged.includes(fixture.overlap)); assert.equal(sha256(ownedRead(run, fixture.alpha.path, ['show', `:${fixture.overlap}`])), fixture.workingOverlap); return facts; });
      await mutation('unstage-only-overlap-file', () => wd.click(`${localFile('staged', fixture.overlap)} [data-action="unstage-file"]`), (previous, next, facts) => { assertIndexOnly(previous, next); assert.deepEqual(facts.staged, []); assert(facts.unstaged.includes(fixture.overlap)); return facts; });
      assertLocalGroups(await observe(), gitFacts(run, fixture.alpha.path)); return { trusted, zeroStagedSequence: sequence };
    });
    await step('default-middle-and-real-Settings-inline-move-the-same-composer-without-losing-draft', async () => {
      const message = `Draft survives middle and inline ${run.manifest.runId}\nSecond line remains local.`;
      await wd.fill(SELECTORS.message, message); await wd.keys([KEY.left, KEY.left]); const baseline = await observe(); assert.equal(baseline.workspace.position, 'middle');
      let inline = await settings({ localChangesPosition: 'inline' }); assertDraft(baseline, inline); assert.equal(inline.local.inTree, true); assert(samePath(inline.tree.localPath, fixture.alpha.path)); assert.equal(inline.local.inTreeItem, false);
      await archive('local-native-settings-inline-draft-preserved'); let middle = await settings({ localChangesPosition: 'middle' }); assertDraft(baseline, middle); assert.equal(middle.local.inTree, false);
      await archive('local-native-default-middle-draft-preserved');
      await historyTab(); await activate(fixture.bravo); const clean = await observe(); assert.equal(clean.workspace.localOpen, false);
      await activate(fixture.alpha); const restored = await localTab(); assert.equal(restored.local.message.value, message, 'Repository switch must retain its own draft even after mounting inline.');
      return { message, selection: baseline.local.message, inlineRegion: inline.tree.localRegion, middle: middle.local.listBox };
    });
    await step('real-commit-writes-only-staged-index-and-clears-only-successful-repository-draft', async () => {
      await mutation('stage-overlap-for-commit', () => wd.click(`${localFile('unstaged', fixture.overlap)} [data-action="stage-file"]`), (previous, next, facts) => { assertIndexOnly(previous, next); assert.deepEqual(facts.staged, [fixture.overlap]); return facts; });
      const stagedOid = accepted.alpha.tracked.find(item => item.path === fixture.overlap).oid, message = `Workspace desktop owned commit ${run.manifest.runId}`;
      await wd.fill(SELECTORS.message, message);
      const committed = await mutation('commit-exact-staged-index-through-native-UI', () => wd.click(SELECTORS.commit), (previous, next, facts) => {
        const actual = { parent: ownedRead(run, fixture.alpha.path, ['rev-parse', 'HEAD^']).toString('utf8').trim(), message: ownedRead(run, fixture.alpha.path, ['log', '-1', '--format=%B']).toString('utf8').trim(), paths: ownedRead(run, fixture.alpha.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD']).toString('utf8').split('\0').filter(Boolean), blob: ownedRead(run, fixture.alpha.path, ['rev-parse', `HEAD:${fixture.overlap}`]).toString('utf8').trim() };
        assertCommitOnly(previous, next, { branch: fixture.alpha.branch, path: fixture.overlap, stagedOid, message, actual }); assert.deepEqual(facts.staged, []); assert(facts.unstaged.includes(fixture.keptTracked)); assert(facts.untracked.includes(fixture.keptUntracked)); return actual;
      });
      fixture.alpha.head = committed.after.head; const view = await wait('successful native commit clears composer', view => view.local.message.value === '' && view.shell.head === committed.after.head); await archive('local-native-real-staged-only-commit'); return { head: view.shell.head, actual: committed.verified };
    });
    await step('typed-untracked-delete-rejects-blank-and-mismatch-cancel-keeps-bytes-then-deletes-one-file', async () => {
      const selector = `${localFile('untracked', fixture.deletion)} [data-action="delete-untracked-file"]`;
      const unchanged = await currentSnapshot(); await wd.click(selector); let view = await wait('actual permanent-delete confirmation', view => view.dialogs.some(dialog => dialog.paths === fixture.deletion));
      assert.match(view.dialogs[0].title, /Delete this untracked file/); await wd.click('dialog[open] [data-action="confirm-delete-untracked"]');
      view = await wait('blank confirmation rejected', view => view.dialogs.some(dialog => dialog.error.some(error => /does not match/.test(error))), 8000, { allowDialogError: true });
      assertSameSnapshot(unchanged, await currentSnapshot(), 'Blank delete confirmation');
      await wd.fill('dialog[open] input[name="confirmation"]', 'delete'); await wd.click('dialog[open] [data-action="confirm-delete-untracked"]');
      await wait('short token cannot replace exact full path', view => view.dialogs.some(dialog => dialog.error.some(error => /does not match/.test(error))), 8000, { allowDialogError: true });
      assert.equal(sha256(await readFile(join(fixture.alpha.path, fixture.deletion))), fixture.deletionBytes); assertSameSnapshot(unchanged, await currentSnapshot(), 'Mismatched delete confirmation'); await archive('local-native-typed-delete-mismatch', { allowDialogError: true });
      await wd.clickText('dialog[open] .dialog-footer button', 'Cancel'); await wait('cancelled deletion closes actual modal', view => view.dialogs.length === 0 && view.local.busy === 'false'); assertSameSnapshot(unchanged, await currentSnapshot(), 'Cancelled delete confirmation');
      const deleted = await mutation('delete-exact-owned-untracked-file', async () => { await wd.click(selector); await wait('second actual delete confirmation', view => view.dialogs.some(dialog => dialog.paths === fixture.deletion)); await wd.fill('dialog[open] input[name="confirmation"]', fixture.deletion); await wd.click('dialog[open] [data-action="confirm-delete-untracked"]'); }, async (previous, next, facts) => {
        assertDeleteOnly(previous, next, fixture.deletion); await assert.rejects(readFile(join(fixture.alpha.path, fixture.deletion)), error => error.code === 'ENOENT'); assert(facts.untracked.includes(fixture.keptUntracked)); return { removed: fixture.deletion, kept: fixture.keptUntracked };
      });
      await archive('local-native-exact-untracked-delete-complete'); return deleted.verified;
    });
    await step('native-760-1280-1455-dark-light-middle-inline-details-and-document-PNG-matrix', async () => {
      const captures = [];
      for (const width of NATIVE_WIDTHS) {
        const rect = await resize(width, width === 760 ? 760 : 900);
        for (const theme of THEMES) {
          await settings({ theme, localChangesPosition: 'middle', detailPosition: 'inline' }); await localTab();
          for (const position of ['middle', 'inline']) {
            if (position === 'inline') await settings({ localChangesPosition: 'inline' });
            await localTab(); const view = await observe(), geometry = assertLayout(view, { theme, position, surface: 'local' }); assertLocalGroups(view, gitFacts(run, fixture.alpha.path));
            const name = `prototype-v3-native-${width}-${theme}-local-${position}`; await json(join(run.output, `evidence/${name}-geometry.json`), { nativeRect: rect, ...geometry }); await archive(name); captures.push({ name, width, theme, position, surface: 'local', nativeRect: rect, viewport: view.viewport });
          }
          await settings({ localChangesPosition: 'middle' }); await closeLocal(); await reviewDetails();
          let view = await observe(), geometry = assertLayout(view, { theme, position: 'middle', surface: 'details' });
          let name = `prototype-v3-native-${width}-${theme}-history-details`; await json(join(run.output, `evidence/${name}-geometry.json`), { nativeRect: rect, ...geometry }); await archive(name); captures.push({ name, width, theme, surface: 'details', nativeRect: rect, viewport: view.viewport });
          await openNavigationDocument(); view = await observe(); geometry = assertLayout(view, { theme, position: 'middle', surface: 'document' });
          name = `prototype-v3-native-${width}-${theme}-history-document`; await json(join(run.output, `evidence/${name}-geometry.json`), { nativeRect: rect, ...geometry }); await archive(name); captures.push({ name, width, theme, surface: 'document', nativeRect: rect, viewport: view.viewport });
          await historyTab(); await wheel(SELECTORS.tree, -20_000);
        }
      }
      await resize(1455); await settings({ theme: 'dark', localChangesPosition: 'middle' }); await localTab();
      await json(join(run.output, 'evidence/prototype-v3-native-capture-index.json'), { scope: 'Actual native binary evidence for comparison with the approved prototype; the prototype itself is never native evidence.', captures }); return captures;
    }, { continueOnBlocked: true });
    run.manifest.status = run.manifest.results.some(result => result.status === 'blocked') ? 'blocked' : 'passed';
  } catch (error) { failure = error; run.manifest.status = error instanceof BlockedError ? 'blocked' : 'failed'; run.manifest.error = errorInfo(error); }
  finally {
    clearTimeout(timer); if (originalCall && wd) wd.call = originalCall;
    if (monitor) try { await monitor.stop(); } catch (error) { cleanupErrors.push({ phase: 'ownership-monitor', ...errorInfo(error) }); }
    wd ??= run.webDriver;
    try { await archiveDesktop(run, wd, failure ? 'failure' : 'final'); } catch (error) { cleanupErrors.push({ phase: 'final-archive', ...errorInfo(error) }); }
    if (owned.roots.length) try { await owned.snapshot(); } catch (error) { cleanupErrors.push({ phase: 'ownership-before-close', ...errorInfo(error) }); }
    if (wd?.sessionId) try { await wd.call('DELETE', wd.prefix, undefined, 20_000); if (run.manifest.session) run.manifest.session.closedAt = new Date().toISOString(); } catch (error) { cleanupErrors.push({ phase: 'webdriver-session-delete', ...errorInfo(error) }); }
    try {
      const cleanup = await owned.cleanup(); run.manifest.cleanup = { ...cleanup, errors: [...(cleanup.errors ?? []), ...cleanupErrors] };
      assert.equal(cleanup.remaining?.length ?? 0, 0, 'Exact run-owned process identities remain.'); assert.equal(run.manifest.cleanup.errors.length, 0, 'Evidence or owned-process cleanup failed.');
    } catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.cleanup ??= { errors: cleanupErrors }; run.manifest.cleanup.failure = errorInfo(error); }
    if (fixture && before && accepted) {
      try {
        const after = await snapshotScope(run, fixture.repositories); await json(join(run.output, 'repository-after.json'), after);
        for (const name of Object.keys(before)) { assertSameSnapshot(accepted[name], after[name], `Final accepted workspace ${name}`); assert.equal(after[name].commonDir, before[name].commonDir); }
        run.manifest.repositoryIntegrity = { status: 'passed', before: 'repository-before.json', navigation: 'repository-after-navigation.json', after: 'repository-after.json', acceptedMutations: 'accepted-mutations.json', mutationCount: mutations.length, repositories: Object.keys(after), checked: ['actual-path-and-Git/common-identity', 'HEAD-and-HEAD-file', 'index-sha256', 'status-v2-NUL', 'all-tracked-and-untracked-file-bytes', 'all-refs', 'exact-UI-action-mutation-ledger'], scope: 'All non-Alpha repositories remain exactly unchanged. Alpha must match the last independently verified real UI mutation; no Git teardown writes or rollback.' };
      } catch (error) { failure ??= error; run.manifest.status = 'failed'; run.manifest.repositoryIntegrity = { status: 'failed', ...errorInfo(error) }; }
    } else run.manifest.repositoryIntegrity = { status: 'blocked', reason: 'No complete actual owned-fixture baseline was captured; no integrity pass is inferred.' };
    if (controller.signal.aborted && !(controller.signal.reason instanceof BlockedError)) { failure ??= controller.signal.reason; run.manifest.status = 'failed'; }
    run.manifest.finishedAt = new Date().toISOString(); if (failure && !run.manifest.error) run.manifest.error = errorInfo(failure);
    run.manifest.workspace.coverage = { passed: run.manifest.results.filter(result => result.status === 'passed').length, failed: run.manifest.results.filter(result => result.status === 'failed').length, blocked: run.manifest.results.filter(result => result.status === 'blocked').map(result => result.label), actualNativeCaptures: run.manifest.evidence.filter(item => item.name.startsWith('prototype-v3-native-') && item.screenshot && !item.errors.length).length };
    await run.save(); await json(join(run.output, 'test-report.json'), { schemaVersion: 1, kind: 'workspace-desktop', runId: run.manifest.runId, status: run.manifest.status, startedAt: run.manifest.startedAt, finishedAt: run.manifest.finishedAt, binary: run.manifest.binary ?? null, driver: run.manifest.driver ?? null, workspace: run.manifest.workspace, results: run.manifest.results, repositoryIntegrity: run.manifest.repositoryIntegrity, cleanup: run.manifest.cleanup, evidence: run.manifest.evidence, error: run.manifest.error, scope: SCOPE });
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  }
  console.log(JSON.stringify({ status: run.manifest.status, output: run.output, report: join(run.output, 'test-report.json'), coverage: run.manifest.workspace.coverage, error: failure?.message }, null, 2));
  process.exitCode = run.manifest.status === 'passed' ? 0 : run.manifest.status === 'blocked' ? 2 : 1;
}
if (isMain(import.meta.url)) await main();
