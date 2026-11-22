import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertSameSnapshot, gitText, json, samePath } from './run.mjs';
import { assertRefsAbsent, repositorySnapshot } from './fixtures.mjs';
import { archiveDesktop, BlockedError } from './desktop.mjs';

async function check(run, label, work) {
  const result = { label, status: 'running', startedAt: new Date().toISOString() };
  run.manifest.results.push(result); await run.save();
  const start = Date.now();
  try { result.observed = await work(); result.status = 'passed'; }
  catch (error) { result.status = error instanceof BlockedError ? 'blocked' : 'failed'; result.error = String(error.message); throw error; }
  finally { result.durationMs = Date.now() - start; await run.save(); }
}
async function dialog(wd, title) {
  await wd.wait(`dialog ${title}`, 'return [...document.querySelectorAll("dialog[open]")].some(d=>d.querySelector("h2")?.textContent.trim()===arguments[0]);', [title]);
}
async function closeResult(wd) {
  if (await wd.script('return [...document.querySelectorAll("dialog[open] h2")].some(e=>e.textContent.endsWith("— result"));')) await wd.clickText('dialog[open] button[type="submit"]', 'Close');
  await wd.wait('all operation dialogs closed', 'return document.querySelectorAll("dialog[open]").length===0;');
}
export async function openFixture(run, wd, fixtures, name = 'base') {
  const repository = fixtures.repositories[name];
  const expected = await repositorySnapshot(run, repository);
  await wd.click('button[data-action="repository-options"]');
  await wd.click('[role="menuitem"][data-action="open-repository-by-path"]');
  await dialog(wd, 'Open repository');
  await wd.fill('dialog[open] input[name="path"]', repository);
  const before = await wd.state();
  await wd.click('dialog[open] button[data-action="confirm-open-repository"]');
  const observed = await wd.idle(`fixture ${name} opened and loaded`, before.taskSequence);
  assert(samePath(observed.repoPath, expected.identity.path), `UI opened wrong repository: ${observed.repoPath}`);
  assert.equal(observed.repoHead, expected.head, 'UI HEAD must match actual Git repository, not a sample history.');
  assert(samePath(observed.configDirectory, run.profileDirectory), 'Opening a repository must not change the isolated profile.');
  await check(run, `real repository identity (${name})`, async () => ({ path: observed.repoPath, head: observed.repoHead }));
}
export async function smoke(run, wd, fixtures) {
  await openFixture(run, wd, fixtures);
  await check(run, 'real Git graph, stash and reference labels', async () => {
    await wd.wait('fixture graph rendered', 'return [...document.querySelectorAll(".commit-row")].some(r=>r.textContent.includes("Initial project structure")) && [...document.querySelectorAll(".commit-row")].some(r=>r.textContent.includes("feature/workspace"));');
    const subjects = await wd.script('return [...document.querySelectorAll(".commit-row")].map(r=>r.textContent);');
    assert(subjects.some(text => text.includes('fixture-annotated')));
    return { visibleRows: subjects.length, head: fixtures.head };
  });
  await check(run, 'real commit detail, unified and side-by-side patch', async () => {
    await wd.clickText('.commit-row .commit-subject', 'Add keyboard navigation to the command palette').catch(async error => {
      // Current table gives each row its exact immutable commit OID as id.
      if (!await wd.script('return !!document.getElementById(arguments[0]);', [`commit-${fixtures.commits.keyboard}`])) throw error;
      await wd.click(`[id="commit-${fixtures.commits.keyboard}"]`);
    });
    await wd.wait('actual fixture commit file detail', 'return !!document.querySelector(".details-pane:not([hidden]) .file-row");');
    await wd.wait('actual patch hunk', 'return document.querySelector(".diff-scroll")?.textContent.includes("@@");');
    await archiveDesktop(run, wd, 'commit-unified');
    await wd.click('button[aria-label="Side-by-side diff"]');
    await wd.wait('side-by-side patch', 'return !!document.querySelector(".diff-scroll.is-split");');
    await archiveDesktop(run, wd, 'commit-split');
    await wd.click('button[aria-label="Close details (Escape)"]');
    return { oid: fixtures.commits.keyboard };
  });
  await check(run, 'loaded-history message filter', async () => {
    await wd.fill('input[aria-label="Search commits"]', 'keyboard');
    await wd.wait('only matching fixture commit', 'const rows=[...document.querySelectorAll(".commit-row")].filter(r=>r.id!=="commit-WORKTREE"); return rows.length===1 && rows[0].textContent.includes("Add keyboard navigation");');
    await wd.fill('input[aria-label="Search commits"]', '');
    await wd.wait('filter cleared', 'return document.querySelectorAll(".commit-row").length>5;');
  });
  await check(run, 'settings dialog and real WebDriver keyboard close', async () => {
    await wd.click('button[data-action="settings"]');
    await wd.wait('settings visible', 'return !!document.querySelector(".settings-dialog[open]");');
    await wd.keys(['\uE00C']);
    await wd.wait('settings closed using Escape', 'return !document.querySelector(".settings-dialog[open]");');
  });
  await check(run, 'context menu keyboard Escape and focus restoration', async () => {
    await wd.click('button[data-action="more-git-actions"]');
    await wd.wait('Git action menu visible', 'return !!document.querySelector("[role=menu]");');
    await wd.keys(['\uE00C']);
    await wd.wait('menu closed with focus restored', 'return !document.querySelector("[role=menu]") && document.activeElement?.getAttribute("aria-label")==="More Git actions";');
  });
}
async function grantTrust(wd) {
  if (await wd.script('return !!document.querySelector(".trustbar:not([hidden])");')) {
    await wd.clickText('.trustbar button', 'Trust repository…');
    await dialog(wd, 'Trust this repository?');
    await wd.clickText('dialog[open] button[type="submit"]', 'Trust repository');
    await wd.wait('trust granted', 'return !!document.querySelector(".trustbar[hidden]");');
  }
}
async function actionDialog(wd, label) {
  await wd.click('button[data-action="branch-tag-actions"]');
  // Exact, visible accessible label; never derive a positional/nth selector.
  await wd.clickText('[role="menuitem"]', label);
  await dialog(wd, label);
}
async function applyAction(wd, label, expected) {
  const state = await wd.state();
  await wd.clickText('dialog[open] button[type="submit"]', label);
  const completed = await wd.idle(`${label}: completed task and refresh`, state.taskSequence);
  await closeResult(wd);
  assert(expected(), `${label}: actual Git effect missing`);
  return { taskSequenceBefore: Number(state.taskSequence), taskSequenceAfter: Number(completed.taskSequence) };
}
export async function actions(run, wd, fixtures) {
  const repository = fixtures.repository;
  const { branch, annotatedTag, lightweightTag } = run.manifest.refs;
  const requiredRefs = [`refs/heads/${branch}`, `refs/tags/${annotatedTag}`, `refs/tags/${lightweightTag}`];
  // One precondition, before any mutation. Existing refs always fail the run.
  assertRefsAbsent(run, repository, requiredRefs);
  const before = await repositorySnapshot(run, repository);
  await json(join(run.output, 'action-before.json'), before);
  await grantTrust(wd);
  await check(run, 'create fresh branch via UI and verify exact ref', async () => {
    await actionDialog(wd, 'Create branch');
    await wd.fill('dialog[open] input[name="name"]', branch);
    await wd.fill('dialog[open] input[name="target"]', before.head);
    const checkout = await wd.script('return [...document.querySelectorAll("dialog[open] input[type=checkbox]")].find(e=>e.name==="checkoutAfter")?.checked ?? false;');
    assert.equal(checkout, false, 'Fresh profile must not checkout a newly created branch by default.');
    return applyAction(wd, 'Create branch', () => gitText(run, repository, ['rev-parse', `refs/heads/${branch}`]) === before.head);
  });
  await check(run, 'create fresh annotated tag and verify object, target and message', async () => {
    await actionDialog(wd, 'Create tag');
    await wd.fill('dialog[open] input[name="name"]', annotatedTag);
    await wd.fill('dialog[open] input[name="target"]', before.head);
    // New explicit tagType has a real select; previous version inferred it from message.
    if (await wd.script('return !!document.querySelector("dialog[open] select[name=tagType]");')) await wd.select('dialog[open] select[name="tagType"]', 'annotated');
    await wd.fill('dialog[open] textarea[name="message"]', `Run-owned annotation ${run.manifest.runId}`);
    const result = await applyAction(wd, 'Create tag', () => gitText(run, repository, ['cat-file', '-t', `refs/tags/${annotatedTag}`]) === 'tag');
    assert.equal(gitText(run, repository, ['rev-parse', `${annotatedTag}^{}`]), before.head);
    assert(gitText(run, repository, ['cat-file', '-p', `refs/tags/${annotatedTag}`]).includes(run.manifest.runId));
    return result;
  });
  await check(run, 'delete only run-owned annotated tag via confirmation', async () => {
    await actionDialog(wd, 'Delete tag');
    await wd.fill('dialog[open] input[name="target"]', annotatedTag);
    return applyAction(wd, 'Delete tag', () => { assertRefsAbsent(run, repository, [`refs/tags/${annotatedTag}`]); return true; });
  });
  await check(run, 'delete only run-owned branch via confirmation', async () => {
    await actionDialog(wd, 'Delete branch');
    await wd.select('dialog[open] select[name="target"]', branch);
    return applyAction(wd, 'Delete branch', () => { assertRefsAbsent(run, repository, [`refs/heads/${branch}`]); return true; });
  });
  const after = await repositorySnapshot(run, repository);
  await json(join(run.output, 'action-after.json'), after);
  assertSameSnapshot(before, after, 'UI branch/tag actions must preserve HEAD, index, status, tracked and untracked bytes');
}
export function recordPlannedCoverage(run) {
  for (const [feature, reason] of [
    ['scope-groups', 'Requires final stable scope/group selectors and independently asserted Git scope membership.'],
    ['message-rendering', 'Markdown, emoji, issue and PR rendering needs final controls; no guessed locator or network request.'],
    ['tag-detail-and-signature', 'Requires final tag detail selectors and actual unsigned/annotated metadata checks.'],
    ['review-persistence', 'Requires final begin/end review selectors and restart within the same owned profile.'],
    ['keyboard-defaults', 'Baseline Escape is exercised; configurable shortcuts and defaults require final named controls.'],
    ['native-picker', 'Owned-window UIA picker harness not scheduled; browser path opening is not claimed as native-picker coverage.'],
    ['clipboard', 'Shared clipboard requires explicit owned-window harness and save/restore; not exercised automatically.'],
    ['editor-terminal', 'Requires explicit owned-window/descendant harness; no user editor or terminal is opened.'],
  ]) run.manifest.results.push({ label: feature, status: 'blocked', reason, requiredForBaseline: false });
}
