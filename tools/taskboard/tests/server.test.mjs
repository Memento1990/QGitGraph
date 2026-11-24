import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.mjs';
import { createSeed, SOURCE_PATH } from '../seed.mjs';
import { createRequestHandler, validateRequest, startServer } from '../server.mjs';
const source = await readFile(SOURCE_PATH, 'utf8');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qg-http-test-')), store = await createStore(join(dir, 'board.json'), { initialBoard: createSeed(source) });
  const token = 'temporary-test-token', server = createServer(createRequestHandler({ store, token }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { Host: '127.0.0.1:14732', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  }); return { send, token };
}
test('production binding stays fixed; Host/path validation is exact', async () => {
  await assert.rejects(startServer({ port: 0 }), /fixed/);
  assert.throws(() => validateRequest({ headers: { host: 'localhost:14732' }, url: '/' }), { code: 'HOST_REJECTED' });
  assert.throws(() => validateRequest({ headers: { host: '127.0.0.1:14732' }, url: 'http://evil.test/' }), { code: 'INVALID_PATH' });
});
test('HTTP static whitelist and security headers; no state file or arbitrary paths exposed', async (t) => {
  const { send } = await fixture(t);
  const index = await send('/'); assert.equal(index.status, 200); assert.match(index.headers['content-type'], /text\/html/); assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await send('/app.js')).status, 200); assert.equal((await send('/styles.css')).status, 200);
  for (const path of ['/data/board.json', '/.local/exclusive.lock', '/server.mjs', '/%2e%2e/core.mjs', '/public/index.html', '/api/../data/board.json']) assert.notEqual((await send(path)).status, 200);
  assert.equal((await send('/', { headers: { Host: 'evil.test:14732' } })).status, 403);
});
test('bootstrap/read authentication, exact origins and no CORS', async (t) => {
  const { send, token } = await fixture(t);
  assert.equal((await send('/api/bootstrap')).json.token, token);
  assert.equal((await send('/api/board')).status, 401);
  assert.equal((await send('/api/board', { headers: { 'X-Board-Token': token } })).json.tasks.length, 102);
  const rejected = await send('/api/bootstrap', { headers: { Origin: 'http://evil.test' } }); assert.equal(rejected.status, 403); assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  assert.equal((await send('/api/board', { headers: { Origin: 'http://127.0.0.1:14731', 'X-Board-Token': token } })).status, 403);
});
test('commands produce explicit 409 CAS and preview does not mutate revision', async (t) => {
  const { send, token } = await fixture(t), headers = { Origin: 'http://127.0.0.1:14732', 'X-Board-Token': token };
  const body = { expectedRevision: 0, command: { type: 'log', id: 'QG-BOARD', text: 'Temporary HTTP test' } };
  const saved = await send('/api/command', { method: 'POST', headers, body }); assert.equal(saved.status, 200); assert.equal(saved.json.board.metadata.revision, 1);
  const conflict = await send('/api/command', { method: 'POST', headers, body }); assert.equal(conflict.status, 409); assert.equal(conflict.json.error.details.actualRevision, 1);
  const preview = await send('/api/import/preview', { method: 'POST', headers, body: { content: saved.json.board } }); assert.equal(preview.json.valid, true);
  assert.equal((await send('/api/board', { headers })).json.metadata.revision, 1);
  assert.equal((await send('/api/command', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body })).status, 415);
});
test('native import endpoints require board authentication/origin and never accept server file paths or provenance overrides', async (t) => {
  const { send, token } = await fixture(t), headers = { Origin: 'http://127.0.0.1:14732', 'X-Board-Token': token };
  for (const path of ['/api/usage/import/preview', '/api/usage/import/commit']) {
    assert.equal((await send(path, { method: 'POST', body: { content: 'not JSONL' } })).status, 401);
    assert.equal((await send(path, { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:14731' }, body: { content: 'not JSONL' } })).status, 403);
    assert.equal((await send(path, { method: 'POST', headers: { ...headers, 'X-Board-Token': 'wrong' }, body: { content: 'not JSONL' } })).status, 403);
    assert.equal((await send(path, { method: 'POST', headers, body: { path: 'private-file.jsonl' } })).status, 400);
    for (const patch of [{ source: 'userusage' }, { build: 'forged' }, { sessionId: 'forged' }]) assert.equal((await send(path, { method: 'POST', headers, body: { content: 'not JSONL', ...patch } })).status, 400);
  }
  const preview = await send('/api/usage/import/preview', { method: 'POST', headers, body: { content: '{"private-input"' } });
  assert.equal(preview.status, 200); assert.equal(preview.json.valid, false); assert.ok(!preview.text.includes('private-input')); assert.equal(preview.headers['access-control-allow-origin'], undefined);
  assert.equal((await send('/api/board', { headers })).json.metadata.revision, 0);
});
test('authenticated native HTTP preview/commit uses CAS and original source/build; old prototype route remains independent', async (t) => {
  const { send, token } = await fixture(t), headers = { Origin: 'http://127.0.0.1:14732', 'X-Board-Token': token };
  const sessionId = 's-33333333-3333-4333-8333-333333333333', build = `native-${'c'.repeat(64)}`, at = '2026-01-01T00:00:00.000Z';
  const common = { sessionId, source: 'assistant', build, taskIds: ['QG-BOARD'] };
  const content = [
    { kind: 'native-session', schemaVersion: 1, ...common, createdAt: at, runtime: { appVersion: '0.3.0', sourceBuild: 'development', sourceBuildReliable: false, exeSha256: 'c'.repeat(64) } },
    ...['start', 'stop'].map((boundary, index) => ({ kind: 'boundary', boundary, ...common, sequence: index + 1, eventId: `http-native-${index}`, occurredAt: at, collectedAt: at, scenarioId: `native-usage-${boundary}`, actionId: `usage.${boundary}`, resultCode: 'OBSERVED' })),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  const preview = await send('/api/usage/import/preview', { method: 'POST', headers, body: { content } }); assert.equal(preview.json.valid, true); assert.equal(preview.json.summary.source, 'assistant');
  const commit = { content, contentHash: preview.json.contentHash, expectedRevision: preview.json.revision };
  const saved = await send('/api/usage/import/commit', { method: 'POST', headers, body: commit }); assert.equal(saved.status, 200); assert.equal(saved.json.revision, 1);
  assert.equal((await send('/api/usage/import/commit', { method: 'POST', headers, body: commit })).status, 409);
  const usage = await send(`/api/usage?sessionId=${sessionId}`, { headers }); assert.equal(usage.json.events[0].source, 'assistant'); assert.equal(usage.json.events[0].build, build); assert.equal(usage.json.events[0].receivedAt, at); assert.ok(usage.json.events[0].importedAt);
  assert.equal((await send('/api/usage/session', { method: 'POST', headers: { Origin: 'http://127.0.0.1:14731' }, body: { source: 'automated-test', build: 'prototype-test' } })).status, 200);
});
test('usage POST requires exact Origin and has no task mutation route', async (t) => {
  const { send, token } = await fixture(t), body = { source: 'automated-test', build: 'http-unit' };
  assert.equal((await send('/api/usage/session', { method: 'POST', body })).status, 403);
  assert.equal((await send('/api/usage/session', { method: 'POST', headers: { Origin: 'http://127.0.0.1:14731/' }, body })).status, 403);
  const result = await send('/api/usage/session', { method: 'POST', headers: { Origin: 'http://127.0.0.1:14731' }, body }); assert.equal(result.status, 200); assert.ok(result.json.sessionToken);
  assert.equal((await send('/api/usage/command', { method: 'POST', headers: { Origin: 'http://127.0.0.1:14731' }, body: {} })).status, 403);
  assert.equal((await send('/api/board', { headers: { 'X-Board-Token': token } })).json.metadata.revision, 0);
});
