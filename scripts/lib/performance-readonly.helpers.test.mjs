import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  assertReadOnlyGitArgs, compareRepositoryDigests, INSTALL_OBSERVER, loadSamplePlan, newNativeOperation, parseCommitParents,
  readOnlyEnvironment, safeFailure, sampleCount, sanitizeSpan, statusPaths, summarizeSamples, validateSamplePlan, writeSamplePlan,
} from './performance.mjs';
import { sha256 } from './run.mjs';

// These tests never access Git, a target repository, a browser or the desktop.
test('performance sample bounds are explicit and have no fractional/coercion fallback', () => {
  assert.equal(sampleCount(), 20); assert.equal(sampleCount('3'), 3); assert.equal(sampleCount('50'), 50);
  for (const value of ['0', '2', '51', '-1', '20.0', '3.5', '03', ' 20', '1e1', '']) assert.throws(() => sampleCount(value));
});
test('readonly env preserves user config lookup while removing inherited routing/auth/tracing', () => {
  const source = { HOME: 'user-home', USERPROFILE: 'real-user', APPDATA: 'user-app', LOCALAPPDATA: 'user-local', XDG_CONFIG_HOME: 'xdg', PATH: 'keep', GIT_DIR: 'wrong', GIT_CONFIG_COUNT: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE: 'trace-private', SSH_ASKPASS: 'exec', GCM_INTERACTIVE: 'Always', WEBVIEW2_USER_DATA_FOLDER: 'real-profile', QGITGRAPH_PERF: '1' };
  const env = readOnlyEnvironment(source);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'PATH']) assert.equal(env[key], source[key]);
  for (const key of ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_NOSYSTEM', 'GIT_TRACE', 'SSH_ASKPASS', 'WEBVIEW2_USER_DATA_FOLDER', 'QGITGRAPH_PERF']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(readOnlyEnvironment(source, { native: true }).QGITGRAPH_PERF, '1');
  assert.equal(source.GIT_DIR, 'wrong');
});
test('readonly Git rejects mutations, unsafe diff hooks and writable config forms', () => {
  for (const args of [['status', '--porcelain=v2', '-z'], ['diff-tree', '--no-ext-diff', '--no-textconv', '--numstat'], ['config', '--null', '--show-origin', '--show-scope', '--list']]) assert.doesNotThrow(() => assertReadOnlyGitArgs(args));
  for (const args of [['init'], ['checkout', 'HEAD'], ['fetch'], ['config', '--global', 'safe.directory', '*'], ['status', '-c', 'safe.directory=*'], ['diff-tree', '--ext-diff'], ['log', '--output=private'], ['show', 'HEAD'], ['config', '--get', 'x']]) assert.throws(() => assertReadOnlyGitArgs(args));
});
test('status-v2 NUL parser retains names in memory only and handles rename records', () => {
  const bytes = Buffer.from(['1 .M N... 100644 100644 100644 aaa bbb tracked with spaces', '? untracked name', '2 R. N... 100644 100644 100644 aaa bbb R100 new name', 'old name', ''].join('\0'));
  assert.deepEqual(statusPaths(bytes), ['tracked with spaces', 'untracked name', 'new name']);
});
test('repository changes are attributed honestly and never restored', () => {
  const before = { headSha256: 'x', statusNulSha256: 'y', worktree: [] }; assert.equal(compareRepositoryDigests(before, { ...before }).changed.length, 0);
  const changed = compareRepositoryDigests(before, { ...before, statusNulSha256: 'different' }); assert.equal(changed.status, 'changed-unattributed'); assert.equal(changed.restored, false); assert.deepEqual(changed.changed, ['statusNulSha256']);
});
test('telemetry sanitization never reports OIDs, paths, arguments, request strings or arbitrary fields', () => {
  const span = sanitizeSpan({ id: 1, operationId: 'op-1', rootOperationId: 'op-1', phase: 'diff-ready', kind: 'fileSelection', durationMs: 9, oid: 'private-oid', path: '/private', requestId: 'private', args: ['content'], count: 3, outcome: 'ok' });
  assert.equal(span.durationMs, 9); assert.equal(span.outcome, 'ok');
  for (const key of ['oid', 'path', 'requestId', 'args']) assert.equal(span[key], undefined);
  assert(!JSON.stringify(safeFailure(new Error('secret file content'))).includes('secret'));
});
test('native readiness requires new successful root, exact paint and every descendant to finish', () => {
  const before = { sequence: 5, spans: [] };
  const operation = { id: 1, sequence: 6, operationId: 'op-1', rootOperationId: 'op-1', kind: 'commitSelection', phase: 'operation', startedAt: 10, durationMs: 20, outcome: 'ok', oid: 'a' };
  const paint = { ...operation, id: 2, sequence: 7, phase: 'paint-opportunity', durationMs: 30 };
  const descendant = { id: 3, sequence: 8, operationId: 'op-3', parentOperationId: 'op-2', rootOperationId: 'op-1', kind: 'fileSelection', phase: 'operation', durationMs: 4 };
  const after = { schemaVersion: 1, enabled: true, sequence: 8, spans: [operation, paint], active: [descendant] };
  assert.equal(newNativeOperation(before, after, 'commitSelection', 'a'), null);
  after.active = []; after.spans.push(descendant); const result = newNativeOperation(before, after, 'commitSelection', 'a'); assert.equal(result.spans.length, 3); assert(!JSON.stringify(result).includes('"oid"'));
  assert.equal(newNativeOperation({ sequence: 8 }, after, 'commitSelection', 'a'), null);
  assert.equal(newNativeOperation(before, { ...after, spans: [operation] }, 'commitSelection', 'a'), null);
  assert.equal(newNativeOperation(before, { ...after, spans: [{ ...operation, outcome: 'stale' }, paint] }, 'commitSelection', 'a'), null);
});
test('metrics keep installed observation, driver wall and native clock populations separate', () => {
  const summary = summarizeSamples([{ scenario: 'open', status: 'measured', timings: { webDriverWallMs: 20, 'native.operation.fromOperationStartMs': 2 } }, { scenario: 'open', status: 'blocked', timings: { webDriverWallMs: 999 } }]);
  assert.equal(summary['open.webDriverWallMs'].count, 1); assert.equal(summary['open.webDriverWallMs'].medianMs, 20); assert.equal(summary['open.native.operation.fromOperationStartMs'].medianMs, 2);
});
test('commit clicks target the text-only hash cell, never ref badges or linked message content', async () => {
  const source = await readFile(new URL('../performance-readonly.mjs', import.meta.url), 'utf8');
  const clicks = [...source.matchAll(/\.click\(`\[id="commit-\$\{[^}]+\}"\] ([^`]+)`\)/g)];
  assert.equal(clicks.length, 3, 'Measured, unmeasured and rapid-selection setup clicks must all be checked.');
  for (const click of clicks) assert.equal(click[1], '.hash-cell');
  assert(!source.includes('.commit-description')); assert(!source.includes('.commit-subject'));
});
test('content-mode measurement begins at a real select click, then clicks an actual option', async () => {
  const source = await readFile(new URL('../performance-readonly.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("for (const mode of ['old', 'new'])");
  const end = source.indexOf("await suite.optional('diff-scroll'", start);
  const content = source.slice(start, end);
  assert(start >= 0 && end > start);
  assert(content.includes("event: 'click', selector: 'select[aria-label=\"Content view\"]'"));
  assert(content.includes("async () => { await wd.click('select[aria-label=\"Content view\"]'); await wd.select('select[aria-label=\"Content view\"]', mode); }"));
  assert(content.includes("nativeKind: 'diffMode'")); assert(content.includes('actual selected-mode DOM paint opportunity'));
  assert(!content.includes("event: 'change'")); assert(!content.includes('dispatchEvent'));
});
test('failure diagnostics allow only fixed public wait labels and preserve overlay-scoped cleanup', async () => {
  const known = Object.assign(new Error('private data'), { conditionLabel: 'trusted input and actual DOM paint opportunity' });
  assert.equal(safeFailure(known).conditionLabel, known.conditionLabel);
  known.conditionLabel = 'private repository path'; assert.equal(safeFailure(known).conditionLabel, undefined);
  const source = await readFile(new URL('../performance-readonly.mjs', import.meta.url), 'utf8');
  assert(source.includes('if (overlayOpen) await this.wd.keys'));
  assert(source.includes('sample.observationState = await this.wd.script'));
  assert(source.includes('sample.failureStage = failureStage'));
});
const planRepository = process.platform === 'win32' ? 'C:/owned-sample-repository' : '/owned-sample-repository';
function privatePlan() {
  return { schemaVersion: 1, repositoryIdentitySha256: sha256(planRepository), privacy: 'private-local-only-do-not-export', samples: ['a', 'b', 'c'].map((letter, commitIndex) => ({ oid: letter.repeat(40), parents: commitIndex ? [String(commitIndex).repeat(40)] : [], files: [`file-${commitIndex}.txt`], commitIndex, parentPolicy: 'nonmerge-default-parent' })) };
}
test('private plans strictly pin repository, count, complete unique OIDs, parents, indexes and safe file paths', () => {
  const original = privatePlan(); const valid = validateSamplePlan(original, planRepository, 3);
  assert.deepEqual(valid, original); valid.samples[0].files.push('detached'); assert.equal(original.samples[0].files.length, 1);
  const mutations = [
    p => { p.schemaVersion = 2; }, p => { p.repositoryIdentitySha256 = sha256('different'); }, p => { p.privacy = 'public'; }, p => { p.extra = 'ignored'; },
    p => { p.samples.pop(); }, p => { p.samples[1].oid = p.samples[0].oid; }, p => { p.samples[0].oid = 'a'.repeat(41); }, p => { p.samples[0].oid = 'HEAD'; },
    p => { p.samples[0].oid = ['a'.repeat(40)]; }, p => { p.samples[0].parents = ['b'.repeat(40), 'c'.repeat(40)]; }, p => { p.samples[0].parents = [p.samples[0].oid]; },
    p => { p.samples[1].parents = ['b'.repeat(64)]; }, p => { p.samples[0].commitIndex = 1; }, p => { p.samples[0].parentPolicy = 'merge'; },
    p => { p.samples[0].files = ['../outside']; }, p => { p.samples[0].files = ['.git/config']; }, p => { p.samples[0].files = ['folder\\outside']; },
    p => { p.samples[0].files = ['x\0y']; }, p => { p.samples[0].files = []; }, p => { p.samples[0].files = ['same', 'same']; }, p => { p.samples[0].files = ['x'.repeat(4097)]; },
    p => { p.samples[0].ignored = 'private source'; },
  ];
  for (const mutate of mutations) { const candidate = privatePlan(); mutate(candidate); assert.throws(() => validateSamplePlan(candidate, planRepository, 3), { code: 'PRIVATE_SAMPLE_PLAN_INVALID' }); }
  const newline = privatePlan(); newline.samples[0].files = ['folder/valid\nname.txt']; assert.doesNotThrow(() => validateSamplePlan(newline, planRepository, 3));
  const hash256 = privatePlan(); for (const sample of hash256.samples) { sample.oid += 'd'.repeat(24); sample.parents = sample.parents.map(parent => parent + 'e'.repeat(24)); } assert.doesNotThrow(() => validateSamplePlan(hash256, planRepository, 3));
});
test('commit-parent verification parses exact full OIDs and rejects missing, duplicate, merge or different objects', () => {
  const plan = privatePlan(); const expected = plan.samples.map(sample => sample.oid);
  const encode = samples => Buffer.from(samples.map(sample => `${sample.oid}\0${sample.parents.join(' ')}`).join('\n') + '\n');
  const parsed = parseCommitParents(encode(plan.samples), expected); assert.deepEqual(parsed.get(expected[0]), []); assert.deepEqual(parsed.get(expected[1]), plan.samples[1].parents);
  assert.throws(() => parseCommitParents(encode(plan.samples.slice(1)), expected));
  assert.throws(() => parseCommitParents(encode([...plan.samples, plan.samples[0]]), expected));
  const merge = structuredClone(plan.samples); merge[0].parents = ['d'.repeat(40), 'e'.repeat(40)]; assert.throws(() => parseCommitParents(encode(merge), expected));
  const other = structuredClone(plan.samples); other[0].oid = 'f'.repeat(40); assert.throws(() => parseCommitParents(encode(other), expected));
});
test('private-plan writing is exclusive, bounded, local-only and stable across reloading', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'qgg-private-plan-helper-'));
  try {
    const plan = privatePlan(); const run = { output: directory, manifest: { session: null, status: 'running' } };
    const metadata = await writeSamplePlan(run, plan); const file = join(directory, 'sample-plan.private.json'); const bytes = await readFile(file);
    assert.deepEqual(metadata, { sha256: sha256(bytes), count: 3 }); assert(bytes.length <= 128 * 1024);
    assert.deepEqual(await loadSamplePlan(file, planRepository, 3), plan);
    await assert.rejects(writeSamplePlan(run, plan), { code: 'EEXIST' }); assert.equal(sha256(await readFile(file)), metadata.sha256);
    await assert.rejects(writeSamplePlan(run, { ...plan, ignored: 'x'.repeat(128 * 1024) }), { code: 'PRIVATE_SAMPLE_PLAN_INVALID' });
    assert(!JSON.stringify(metadata).includes(plan.samples[0].oid)); assert(!JSON.stringify(metadata).includes(plan.samples[0].files[0]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('every embedded browser script compiles without executing DOM or desktop code', async () => {
  const files = [new URL('../performance-readonly.mjs', import.meta.url), new URL('./performance.mjs', import.meta.url)];
  let count = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // All inline script/wait bodies intentionally use single-quoted literals.
    const calls = /\.(?:script|wait)\(\s*'((?:\\.|[^'\\])*)'\s*(?:,\s*'((?:\\.|[^'\\])*)')?/g;
    for (const match of source.matchAll(calls)) {
      const literal = match[2] ?? match[1];
      const script = Function(`return '${literal}';`)();
      // wait has a label first, while script has code first.
      if (!/\breturn\b|\bconst\b|\bwindow\b|\blet\b/.test(script)) continue;
      assert.doesNotThrow(() => Function(script), `Invalid embedded script in ${file.pathname}: ${script}`); count++;
    }
  }
  assert(count >= 25, `Only ${count} inline scripts were checked.`);
  assert.doesNotThrow(() => Function(INSTALL_OBSERVER));
  assert(!INSTALL_OBSERVER.includes('dispatchEvent')); assert(!INSTALL_OBSERVER.includes('__TAURI'));
});
