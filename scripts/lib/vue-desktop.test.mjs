import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { WebDriver } from './desktop.mjs';
import { PROJECT } from './run.mjs';
import {
  ROOT_KINDS, SUITES, RUN_BUDGET_MS, SCOPE, SELECTORS, READ_VUE_DOM, NATIVE_WINDOW_PROBE, FULL_REQUIRED_SCENARIOS, requiredLabels, coverageFor,
  parseOptions, assertRootContract, assertFourRoots, assertWideLayout, assertGroups, assertIndexOnly, assertCommitOnly, assertUsageRecords,
  resultStatus, selectOption, localFile, commitRow, fileRow,
} from '../test-vue-desktop.mjs';

// Pure contracts only. No fake DTO or fake DOM in this file is native desktop evidence.
const oid = letter => letter.repeat(40);
const profile = resolve('pure-test-owned-profile');
const repo = resolve('pure-test-owned-repo');
const output = resolve(PROJECT, 'artifacts/pure-test-unused-run');
const shell = () => ({ shell: { path: '', head: '', mode: 'desktop', profile, task: 'idle', sequence: '10' } });
function snapshot() {
  return { identity: { path: repo, gitDir: resolve(repo, '.git'), bare: false }, head: oid('a'), headFile: { sha256: 'a'.repeat(64) }, index: { sha256: 'b'.repeat(64) }, status: 'nul-base64-porcelain',
    tracked: [{ path: 'overlap 中文.txt', oid: oid('b'), mode: '100644', stage: '0', working: { sha256: 'c'.repeat(64), bytes: 12 } }, { path: 'keep.txt', oid: oid('c'), mode: '100644', stage: '0', working: { sha256: 'd'.repeat(64), bytes: 10 } }],
    untracked: [{ path: 'delete me 中文.txt', working: { sha256: 'e'.repeat(64), bytes: 5 } }], refs: [`refs/heads/main ${oid('a')} commit`, `refs/tags/untouched ${oid('c')} commit`] };
}
function navigation() {
  return { roots: ROOT_KINDS.map((kind, index) => ({ kind, level: '1', context: index ? repo : null, box: { width: 300, height: 27 } })), repositories: [{ path: repo, current: 'true' }] };
}
function local() {
  const facts = { staged: ['same path'], unstaged: ['same path', 'keep'], untracked: ['other'] };
  return { facts, view: { local: { visible: true, groups: Object.entries(facts).map(([id, paths]) => ({ id, count: paths.length, expanded: 'true' })), files: Object.entries(facts).flatMap(([group, paths]) => paths.map(path => ({ group, path }))) } } };
}

test('entry is import-safe, strict and native fixture-only', () => {
  assert.equal(parseOptions(['--binary', 'b', '--driver', 'd', '--output', output]).suite, 'smoke');
  for (const suite of SUITES) assert.equal(parseOptions(['--binary', 'b', '--driver', 'd', '--output', output, '--suite', suite]).suite, suite);
  assert.equal(parseOptions(['--binary', 'b', '--driver', 'd', '--output', output, '--suite', 'full', '--only', 'faults']).only, 'faults');
  assert.throws(() => parseOptions(['--binary', 'b', '--driver', 'd', '--output', output, '--suite', 'smoke', '--only', 'faults']));
  assert.throws(() => parseOptions(['--binary', 'b', '--driver', 'd', '--output', output, '--suite', 'full', '--only', 'anything']));
  assert.deepEqual(parseOptions(['--help']), { help: true });
  for (const argv of [[], ['--binary', 'b'], ['--binary', 'b', '--driver', 'd', '--output', output, '--suite', 'legacy'], ['--repo', 'private'], ['--binary', 'b', '--driver', 'd', '--output', output, '--output', 'again']]) assert.throws(() => parseOptions(argv));
  assert.throws(() => parseOptions(['--binary', 'b', '--driver', 'd', '--output', resolve(PROJECT, 'public-native-evidence')]));
  assert.throws(() => parseOptions(['--binary', 'b', '--driver', 'd', '--output', resolve(PROJECT, 'artifacts')]));
  assert(RUN_BUDGET_MS > 0 && RUN_BUDGET_MS <= 600_000);
  for (const phrase of ['No repository argument', 'run-owned', 'read-only', 'explicit native UI trust', 'exact PID plus creation time', 'automated-test, never userusage', 'No download']) assert(SCOPE.includes(phrase));
});
test('root diagnostics require desktop mode, exact profile and monotonic integral sequence', () => {
  assert.equal(assertRootContract(shell(), profile, 9), 10);
  assert.equal(assertRootContract(shell(), profile, 10), 10, 'Unchanged observations need not advance.');
  assert.throws(() => assertRootContract(shell(), profile, 11), /regressed/);
  for (const sequence of [undefined, '', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) { const view = shell(); view.shell.sequence = sequence; assert.throws(() => assertRootContract(view, profile)); }
  for (const [key, value] of [['mode', 'demo'], ['mode', 'browser'], ['mode', undefined], ['profile', resolve('different-profile')], ['task', 'pretend-success']]) { const view = shell(); view.shell[key] = value; assert.throws(() => assertRootContract(view, profile)); }
  assert.throws(() => assertRootContract({}, profile));
});
test('all four current-repository root peers are exact, visible, non-branch siblings', () => {
  assertFourRoots(navigation(), repo);
  for (const mutate of [view => { view.roots.pop(); }, view => { view.roots.push({ ...view.roots[0], kind: 'branches-root' }); }, view => { view.roots[1].level = '2'; }, view => { view.roots[2].box = null; }, view => { view.roots[3].context = resolve('other-repository'); }, view => { view.repositories.push({ current: 'true' }); }]) { const view = navigation(); mutate(view); assert.throws(() => assertFourRoots(view, repo)); }
});
test('wide viewport needs real bounded sidebar and viable main area, not root labels alone', () => {
  const view = { viewport: { width: 1455, height: 950, scrollWidth: 1455 }, sidebar: { width: 340 }, main: { width: 1109 }, titlebar: { box: { width: 1455 } } };
  assertWideLayout(view);
  for (const mutate of [value => { value.sidebar.width = 1093; }, value => { value.main.width = 350; }, value => { value.viewport.scrollWidth = 1800; }, value => { value.viewport.width = 760; }, value => { value.titlebar.box = null; }]) { const invalid = structuredClone(view); mutate(invalid); assert.throws(() => assertWideLayout(invalid)); }
});
test('native log validation never accepts userusage, mismatched build, gaps, leaked paths or incomplete stop', () => {
  const hash = '1'.repeat(64), build = `native-${hash}`, sessionId = 'owned-session';
  const records = [{ kind: 'native-session', source: 'automated-test', runtime: { exeSha256: hash }, build, sessionId }, { kind: 'boundary', boundary: 'start', source: 'automated-test', build, sessionId, sequence: 1 }, { kind: 'boundary', boundary: 'stop', source: 'automated-test', build, sessionId, sequence: 2 }];
  assert.equal(assertUsageRecords(records, hash, [repo, 'private draft']).stopped, true);
  for (const mutate of [value => { value[0].source = 'userusage'; }, value => { value[1].sequence = 5; }, value => { value[2].boundary = 'pause'; }, value => { value[1].path = repo; }, value => { value[1].draft = 'private draft'; }, value => { value[0].runtime.exeSha256 = '2'.repeat(64); }]) { const invalid = structuredClone(records); mutate(invalid); assert.throws(() => assertUsageRecords(invalid, hash, [repo, 'private draft'])); }
});
test('group and exact path assertions use independent Git facts, not fixed old suite counts', () => {
  const { view, facts } = local(); assertGroups(view, facts);
  const empty = { local: { visible: true, groups: ['staged', 'unstaged', 'untracked'].map(id => ({ id, count: 0, expanded: 'true' })), files: [] } }; assertGroups(empty, { staged: [], unstaged: [], untracked: [] });
  for (const mutate of [value => { value.local.groups[0].count++; }, value => { value.local.files[0].group = 'unstaged'; }, value => { value.local.files.pop(); }, value => { value.local.visible = false; }, value => { value.local.groups.reverse(); }]) { const invalid = structuredClone(view); mutate(invalid); assert.throws(() => assertGroups(invalid, facts)); }
});
test('staging/unstaging must change actual index only, never HEAD refs or file bytes', () => {
  const before = snapshot(), after = structuredClone(before); after.index.sha256 = 'f'.repeat(64); after.tracked[0].oid = oid('d'); assertIndexOnly(before, after);
  for (const mutate of [value => { value.index = before.index; }, value => { value.head = oid('f'); }, value => { value.refs.pop(); }, value => { value.tracked[0].working.bytes++; }, value => { value.untracked.pop(); }, value => { value.identity.path = resolve('other-repo'); }]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertIndexOnly(before, invalid)); }
});
test('commit requires exact staged blob, sole path, parent/message, one branch, untouched worktree', () => {
  const before = snapshot(), after = structuredClone(before), expected = { message: 'Owned index-only commit', path: 'overlap 中文.txt', stagedOid: oid('b') };
  after.head = oid('d'); after.refs = after.refs.map(ref => ref.replace(`refs/heads/main ${before.head}`, `refs/heads/main ${after.head}`)).sort();
  const actual = { parent: before.head, message: expected.message, paths: [expected.path], blob: expected.stagedOid };
  assertCommitOnly(before, after, actual, expected);
  for (const mutate of [value => { value.parent = oid('c'); }, value => { value.paths.push('keep.txt'); }, value => { value.message = 'wrong'; }, value => { value.blob = oid('c'); }]) { const invalid = structuredClone(actual); mutate(invalid); assert.throws(() => assertCommitOnly(before, after, invalid, expected)); }
  for (const mutate of [value => { value.untracked.pop(); }, value => { value.tracked[0].working.sha256 = '0'.repeat(64); }, value => { value.refs[1] = `refs/tags/untouched ${oid('f')} commit`; }]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertCommitOnly(before, invalid, actual, expected)); }
});
test('blocked/unexecuted/empty coverage cannot become passed', () => {
  assert.equal(resultStatus([{ status: 'passed' }]), 'passed');
  assert.equal(resultStatus([{ status: 'passed' }, { status: 'blocked' }]), 'blocked');
  assert.equal(resultStatus([{ status: 'blocked' }, { status: 'failed' }]), 'failed');
  for (const results of [[], [{ status: 'running' }], [{}]]) assert.equal(resultStatus(results), 'failed');
});
test('coverage requires every static label exactly once, retaining missing, failures, blocks and assistance', () => {
  assert.deepEqual(requiredLabels('full'), [...FULL_REQUIRED_SCENARIOS]); assert.equal(new Set(FULL_REQUIRED_SCENARIOS).size, FULL_REQUIRED_SCENARIOS.length);
  const complete = requiredLabels('smoke').map(label => ({ label, status: 'passed' }));
  assert.deepEqual(coverageFor('smoke', complete), { required: requiredLabels('smoke'), missing: [], blocked: [], failed: [], duplicates: [] });
  assert.equal(coverageFor('smoke', complete.slice(1)).missing.length, 1);
  assert.equal(coverageFor('smoke', [...complete, complete[0]]).duplicates.length, 1);
  assert(coverageFor('smoke', complete, { assisted: true }).blocked.length > 0);
  const blocked = structuredClone(complete); blocked[0].status = 'blocked'; assert.equal(coverageFor('smoke', blocked).blocked.length, 1);
  blocked[0].status = 'failed'; assert.equal(coverageFor('smoke', blocked).failed.length, 1);
});
test('trusted option input uses actual opened select then exact option clicks', async () => {
  const calls = []; await selectOption({ click: async selector => { calls.push(selector); } }, 'select[data-setting="language"]', 'zh-CN');
  assert.deepEqual(calls, ['select[data-setting="language"]', 'select[data-setting="language"] > option[value="zh-CN"]']);
  assert(localFile('unstaged', 'a "quote" 中文.txt').includes('data-group="unstaged"'));
  assert(commitRow(oid('a')).includes(`history-row-${oid('a')}`));
  assert(fileRow('a/b 中文.txt').includes('file-tree-file%3Aa%2Fb%20%E4%B8%AD%E6%96%87.txt'));
});
test('DOM reader compiles as observation-only code without product IPC or event injection', () => {
  new vm.Script(`(function(){${READ_VUE_DOM}})()`);
  for (const prohibited of [/\.click\s*\(/, /dispatchEvent\s*\(/, /__TAURI__/, /invoke\s*\(/, /\.value\s*=(?!=)/, /scrollTop\s*=/, /localStorage/, /__vueParentComponent/]) assert(!prohibited.test(READ_VUE_DOM), `Forbidden state-changing/host mechanism ${prohibited}`);
  assert(READ_VUE_DOM.includes('getClientRects')); assert(READ_VUE_DOM.includes('data-settings-dialog'));
  assert(NATIVE_WINDOW_PROBE.includes('creationTime')); assert(NATIVE_WINDOW_PROBE.includes('GetFullPath($Binary)')); assert(!/Stop-Process|ShowWindow|SetWindow/.test(NATIVE_WINDOW_PROBE));
});
test('shared helper retains legacy alerts and adds only visible Vue errors', async () => {
  const wd = new WebDriver('http://127.0.0.1:0'); let script;
  wd.script = async value => { script = value; return {}; }; await wd.state();
  for (const selector of ['.errorbar:not([hidden])', 'dialog[open] .form-error:not([hidden])', '.notice-strip.error[role=alert]', '.ci-state[role=alert]', '.dp-state[role=alert]', '[role=dialog] [role=alert]']) assert(script.includes(selector));
  assert(script.includes('getClientRects().length')); assert(script.includes('getComputedStyle(e).visibility!=="hidden"'));
  const source = await readFile(new URL('./desktop.mjs', import.meta.url), 'utf8');
  assert(source.includes('samePath(state.configDirectory, run.profileDirectory)')); assert(source.includes('VerifyPorts')); assert(source.includes('creationTime')); assert(source.includes('VerifyDriver'));
});
