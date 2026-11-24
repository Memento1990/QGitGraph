import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.mjs';
import { createSeed, SOURCE_PATH } from '../seed.mjs';
const source = await readFile(SOURCE_PATH, 'utf8');
const code = (value) => (error) => error.code === value;
async function fixture(t, limits) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-taskboard-test-')), path = join(dir, 'board.json');
  const store = await createStore(path, { initialBoard: createSeed(source), limits });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); }); return { store, path, dir };
}
const event = (sequence = 1) => ({ eventId: `unit-${sequence}`, sequence, timestamp: new Date().toISOString(), taskIds: ['QG-BOARD'], scenarioId: 'QG-BOARD-A1', actionId: 'task.open', resultCode: 'success' });
export function nativeFixture({ sessionId = 's-11111111-1111-4111-8111-111111111111', source: provenance = 'automated-test', at = '2026-01-01T00:00:00.000Z', eventId = 'native-unit-event' } = {}) {
  const build = `native-${'a'.repeat(64)}`, taskIds = ['QG-BOARD'];
  const header = { kind: 'native-session', schemaVersion: 1, sessionId, source: provenance, build, runtime: { appVersion: '0.3.0', sourceBuild: 'source-unit', sourceBuildReliable: true, exeSha256: 'a'.repeat(64) }, taskIds, createdAt: at };
  const record = (sequence, boundary) => ({ kind: boundary ? 'boundary' : 'event', ...(boundary ? { boundary } : {}), eventId: boundary ? `${sessionId}-${sequence}` : eventId, sequence, sessionId, source: provenance, build, occurredAt: at, collectedAt: at, taskIds, scenarioId: boundary ? `native-usage-${boundary}` : 'QG-BOARD-A1', actionId: boundary ? `usage.${boundary}` : 'task.open', resultCode: 'OBSERVED', ...(!boundary ? { repoId: `r-${'b'.repeat(32)}`, counts: { files: 1 }, state: { theme: 'dark', viewport: 'wide' } } : {}) });
  const records = [header, record(1, 'start'), record(2), record(3, 'stop')];
  return { header, records, content: records.map((value) => JSON.stringify(value)).join('\n') + '\n' };
}
const nativeContent = (records) => records.map((value) => JSON.stringify(value)).join('\n') + '\n';
test('native preview/commit preserves original provenance/times; restart supports exact replay only', async (t) => {
  const { store, dir, path } = await fixture(t), input = nativeFixture();
  const original = await store.getBoard();
  const preview = await store.previewNativeUsage({ content: input.content }); assert.equal(preview.valid, true); assert.equal(preview.revision, 0); assert.equal((await store.getUsage()).total, 0);
  await assert.rejects(store.importNativeUsage({ content: input.content, expectedRevision: 0, contentHash: 'wrong' }), code('IMPORT_PREVIEW_REQUIRED'));
  const result = await store.importNativeUsage({ content: input.content, expectedRevision: 0, contentHash: preview.contentHash }); assert.equal(result.revision, 1); assert.equal(result.replayed, false);
  const board = await store.getBoard(); assert.deepEqual(board.tasks, original.tasks);
  const usage = await store.getUsage({ sessionId: input.header.sessionId }); assert.equal(usage.total, 3); assert.equal(usage.events[1].source, 'automated-test'); assert.equal(usage.events[1].build, input.header.build);
  const imported = usage.events[1]; assert.equal(imported.eventId, 'native-unit-event'); assert.equal(imported.occurredAt, input.header.createdAt); assert.equal(imported.collectedAt, input.header.createdAt); assert.equal(imported.receivedAt, input.header.createdAt); assert.equal(imported.timestamp, input.header.createdAt); assert.ok(Date.parse(imported.importedAt) > Date.parse(imported.collectedAt)); assert.equal(imported.origin, 'native'); assert.equal(imported.complete, true);
  const file = join(dir, '.local/usage', `${input.header.sessionId}.jsonl`), bytes = await readFile(file, 'utf8');
  const reordered = nativeContent(input.records.map((value) => Object.fromEntries(Object.entries(value).reverse())));
  const replay = await store.importNativeUsage({ content: reordered, expectedRevision: 1, contentHash: preview.contentHash }); assert.equal(replay.replayed, true); assert.equal(replay.revision, 1); assert.equal(await readFile(file, 'utf8'), bytes);
  const changed = nativeFixture({ source: 'userusage' }).content;
  assert.equal((await store.previewNativeUsage({ content: changed })).valid, false);
  await assert.rejects(store.importNativeUsage({ content: changed, expectedRevision: 1, contentHash: preview.contentHash }), code('NATIVE_PROVENANCE_CONFLICT'));
  await store.close(); const reopened = await createStore(path);
  try { const after = await reopened.getUsage({ sessionId: input.header.sessionId }); assert.deepEqual(after.events, usage.events); assert.equal(after.warning, undefined); assert.equal((await reopened.previewNativeUsage({ content: input.content })).summary.replayed, true); }
  finally { await reopened.close(); }
});
test('native import has serialized CAS, same-ID payload conflicts, cross-session event dedupe and no deletion', async (t) => {
  const { store, dir } = await fixture(t), input = nativeFixture(); const preview = await store.previewNativeUsage({ content: input.content });
  const commit = { content: input.content, expectedRevision: 0, contentHash: preview.contentHash };
  const results = await Promise.allSettled([store.importNativeUsage(commit), store.importNativeUsage(commit)]); assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1); assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const second = nativeFixture({ sessionId: 's-22222222-2222-4222-8222-222222222222' });
  assert.equal((await store.previewNativeUsage({ content: second.content })).errors[0].code, 'DUPLICATE_EVENT');
  const changed = structuredClone(input.records); changed[2].resultCode = 'verified';
  assert.equal((await store.previewNativeUsage({ content: nativeContent(changed) })).errors[0].code, 'NATIVE_PROVENANCE_CONFLICT');
  assert.equal((await readdir(join(dir, '.local/usage'))).length, 1);
});
test('native partial tail, bad complete record, unknown private fields and invalid boundaries import nothing', async (t) => {
  const { store, dir } = await fixture(t), input = nativeFixture();
  const mutations = [
    input.content.slice(0, -1), input.content + '{"partial-secret', input.content + '{bad-complete}\n', nativeContent(input.records.slice(0, -1)),
    ...[
      (records) => { records[2].source = 'userusage'; }, (records) => { records[2].build = 'forged'; }, (records) => { records[2].sessionId = 's-22222222-2222-4222-8222-222222222222'; },
      (records) => { records[2].path = 'private-path'; }, (records) => { records[0].runtime.path = 'private-path'; }, (records) => { records[2].counts = { files: { content: 'private-content' } }; },
      (records) => { records[2].repoId = 'private-repo-name'; }, (records) => { records[2].errorCode = 'secret-error-message'; }, (records) => { records[2].state = { branch: 'private-branch' }; },
      (records) => { records[2].sequence = 1; }, (records) => { records[2].occurredAt = '2099-01-01T00:00:00.000Z'; }, (records) => { records[2].collectedAt = '2025-01-01T00:00:00.000Z'; },
      (records) => { records[1].boundary = 'pause'; }, (records) => { records[3].boundary = 'pause'; }, (records) => { records[0].runtime.exeSha256 = 'b'.repeat(64); },
    ].map((mutate) => { const records = structuredClone(input.records); mutate(records); return nativeContent(records); }),
  ];
  for (const content of mutations) { const preview = await store.previewNativeUsage({ content }); assert.equal(preview.valid, false); assert.ok(!JSON.stringify(preview).includes('private-')); await assert.rejects(store.importNativeUsage({ content, contentHash: 'a'.repeat(64), expectedRevision: 0 })); }
  assert.equal((await store.getUsage()).total, 0); assert.equal((await store.getBoard()).metadata.revision, 0); assert.deepEqual(await readdir(join(dir, '.local/usage')), []);
});
test('native stopped import capacity accounts for stored metadata and session count before writing', async (t) => {
  const input = nativeFixture();
  const a = await fixture(t, { sessionBytes: 1000 }), b = await fixture(t, { globalBytes: 1000 }), c = await fixture(t, { sessionCount: 0 });
  for (const { store, dir } of [a, b, c]) { const preview = await store.previewNativeUsage({ content: input.content }); assert.equal(preview.valid, false); assert.equal(preview.errors[0].code, 'USAGE_FULL'); assert.deepEqual(await readdir(join(dir, '.local/usage')), []); }
});
test('corrupt imported native tail blocks evidence resolution after restart, never salvages completion', async (t) => {
  const { store, path, dir } = await fixture(t), input = nativeFixture(); const preview = await store.previewNativeUsage({ content: input.content });
  await store.importNativeUsage({ content: input.content, contentHash: preview.contentHash, expectedRevision: 0 }); await store.close();
  await appendFile(join(dir, '.local/usage', `${input.header.sessionId}.jsonl`), '{"private-partial');
  const reopened = await createStore(path);
  try {
    assert.equal((await reopened.getUsage()).warning.code, 'CORRUPT_USAGE');
    await assert.rejects(reopened.transact(1, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'usage', result: 'passed', build: input.header.build, summary: 'Synthetic corrupt native fixture', reference: 'test:native-corrupt', eventIds: ['native-unit-event'] } }), code('CORRUPT_USAGE'));
  } finally { await reopened.close(); }
});

test('live native log tampering invalidates complete flags, replay and evidence even before restart', async (t) => {
  const { store, dir } = await fixture(t), input = nativeFixture(); const preview = await store.previewNativeUsage({ content: input.content });
  await store.importNativeUsage({ content: input.content, contentHash: preview.contentHash, expectedRevision: 0 });
  const file = join(dir, '.local/usage', `${input.header.sessionId}.jsonl`), original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('"theme":"dark"', '"theme":"lite"')); // same byte length, not just size detection
  const usage = await store.getUsage({ sessionId: input.header.sessionId }); assert.equal(usage.warning.code, 'CORRUPT_USAGE'); assert.ok(usage.events.every((event) => event.complete === false));
  assert.equal((await store.previewNativeUsage({ content: input.content })).valid, false);
  await assert.rejects(store.transact(1, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'usage', result: 'passed', build: input.header.build, summary: 'Synthetic tampered native fixture', reference: 'test:native-tamper', eventIds: ['native-unit-event'] } }), code('CORRUPT_USAGE'));
});
test('native delayed collection retains occurrence and permits ordered batched events without washing times', async (t) => {
  const { store } = await fixture(t), input = nativeFixture();
  input.records[2].collectedAt = '2026-01-01T00:00:10.000Z';
  const next = { ...structuredClone(input.records[2]), eventId: 'native-delayed-next', sequence: 3, occurredAt: '2026-01-01T00:00:01.000Z', collectedAt: '2026-01-01T00:00:11.000Z' };
  input.records[3].sequence = 4; input.records[3].occurredAt = input.records[3].collectedAt = '2026-01-01T00:00:12.000Z'; input.records.splice(3, 0, next);
  const content = nativeContent(input.records), preview = await store.previewNativeUsage({ content }); assert.equal(preview.valid, true);
  await store.importNativeUsage({ content, contentHash: preview.contentHash, expectedRevision: 0 });
  const result = await store.getUsage({ sessionId: input.header.sessionId }); assert.equal(result.events[1].occurredAt, '2026-01-01T00:00:00.000Z'); assert.equal(result.events[1].collectedAt, '2026-01-01T00:00:10.000Z');
});
test('exclusive wx lock refuses a second writer and releases on close', async (t) => {
  const { store, path } = await fixture(t); await assert.rejects(createStore(path), code('STORE_LOCKED'));
  await store.close(); const reopened = await createStore(path); await reopened.close();
});
test('serialized CAS allows exactly one concurrent revision; audit and bounded backup persist', async (t) => {
  const { store, path, dir } = await fixture(t, { backupCount: 2 });
  const command = { type: 'log', id: 'QG-BOARD', text: 'Temporary store test' };
  const outcomes = await Promise.allSettled([store.transact(0, command), store.transact(0, command)]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  await store.transact(1, command); await store.transact(2, command);
  const board = JSON.parse(await readFile(path, 'utf8')); assert.equal(board.metadata.revision, 3); assert.equal(board.tasks[0].history.length, 3);
  assert.equal((await readdir(join(dir, '.local/backups'))).length, 2);
  assert.ok(!(await readdir(dir)).some((name) => name.endsWith('.tmp')));
});
test('external edits are never overwritten and corrupt JSON refuses startup/writes', async (t) => {
  const { store, path } = await fixture(t); const bytes = await readFile(path, 'utf8'); await writeFile(path, `${bytes} `);
  await assert.rejects(store.transact(0, { type: 'log', id: 'QG-BOARD', text: 'Must not save' }), code('EXTERNAL_MODIFICATION'));
  assert.equal(await readFile(path, 'utf8'), `${bytes} `); await store.close();
  await writeFile(path, '{broken'); await assert.rejects(createStore(path, { initialBoard: createSeed(source) }), code('CORRUPT_BOARD')); assert.equal(await readFile(path, 'utf8'), '{broken');
});
test('usage persists session source, rejects duplicates and tokens are neither returned nor stored', async (t) => {
  const { store, dir } = await fixture(t);
  const session = await store.createUsageSession({ source: 'automated-test', build: 'unit-build', taskIds: ['QG-BOARD'] });
  await store.appendUsageEvents({ ...session, source: undefined }).catch(() => {}); // unknown fields never change logs
  const batch = { sessionId: session.sessionId, sessionToken: session.sessionToken, events: [event()] };
  assert.equal((await store.appendUsageEvents(batch)).accepted, 1);
  const replay = await store.appendUsageEvents(batch); assert.equal(replay.replayed, true); assert.equal(replay.accepted, 1);
  await assert.rejects(store.appendUsageEvents({ ...batch, events: [{ ...batch.events[0], resultCode: 'changed' }] }), code('DUPLICATE_EVENT'));
  await assert.rejects(store.appendUsageEvents({ ...batch, events: [{ ...event(2), eventId: 'unit-1' }] }), code('DUPLICATE_EVENT'));
  await assert.rejects(store.appendUsageEvents({ ...batch, events: [{ ...event(2), source: 'userusage' }] }), code('UNKNOWN_FIELD'));
  const result = await store.getUsage({ sessionId: session.sessionId }); assert.equal(result.events[0].source, 'automated-test'); assert.equal(result.events[0].complete, true); assert.ok(result.events[0].receivedAt); assert.ok(result.events[0].version);
  assert.equal(result.events.length, 1); assert.equal(result.sessions[0].lastSequence, 1);
  const bytes = await readFile(join(dir, '.local/usage', `${session.sessionId}.jsonl`), 'utf8'); assert.ok(!bytes.includes(session.sessionToken)); assert.ok(!JSON.stringify(result).includes(session.sessionToken));
});
test('JSONL partial tail is readable but never treated as a complete event; tokens expire on restart', async (t) => {
  const { store, path, dir } = await fixture(t), session = await store.createUsageSession({ source: 'automated-test', build: 'unit-build' });
  const batch = { sessionId: session.sessionId, sessionToken: session.sessionToken, events: [event()] }; await store.appendUsageEvents(batch); await store.close();
  await appendFile(join(dir, '.local/usage', `${session.sessionId}.jsonl`), '{"eventId":"partial');
  const reopened = await createStore(path);
  try {
    const result = await reopened.getUsage({ sessionId: session.sessionId }); assert.equal(result.events.length, 1); assert.equal(result.sessions[0].partialTail, true); assert.equal(result.sessions[0].paused, true);
    await assert.rejects(reopened.appendUsageEvents({ ...batch, events: [event(2)] }), code('INVALID_SESSION_TOKEN'));
  } finally { await reopened.close(); }
});
test('usage capacity pauses without silently deleting any session', async (t) => {
  const { store, dir } = await fixture(t, { sessionBytes: 500, globalBytes: 1000 });
  const session = await store.createUsageSession({ source: 'automated-test', build: 'unit-build' });
  await assert.rejects(store.appendUsageEvents({ sessionId: session.sessionId, sessionToken: session.sessionToken, events: [event()] }), code('USAGE_FULL'));
  assert.equal((await readdir(join(dir, '.local/usage'))).length, 1); assert.equal((await store.getUsage()).sessions[0].paused, true);
});
