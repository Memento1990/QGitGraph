import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeed, SOURCE_PATH } from '../seed.mjs';
import { runCli, readNativeUsageFile } from '../cli.mjs';
const board = createSeed(await readFile(SOURCE_PATH, 'utf8'));
test('CLI offline list/show/validate never calls the server', async () => {
  const output = [], deps = { readBoard: async () => JSON.stringify(board), fetchImpl: () => { throw new Error('unexpected network'); }, output: (value) => output.push(value) };
  await runCli(['list', '--required', '--pack', 'W2', '--json'], deps); assert.equal(JSON.parse(output.pop()).length, 7);
  await runCli(['show', 'QG-046'], deps); assert.equal(JSON.parse(output.pop()).id, 'QG-046');
  await runCli(['validate'], deps); assert.equal(JSON.parse(output.pop()).valid, true);
  await assert.rejects(runCli(['list', '--state-path', '/tmp/other.json'], deps), /Unsupported option/);
});
test('CLI JSON command honors explicit CAS and does not print the bootstrap token', async () => {
  const calls = [], output = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/api/bootstrap') ? { token: 'never-print-this' } : { board: { metadata: { revision: 8 } }, result: { type: 'log' } };
    return { ok: true, json: async () => data };
  };
  await runCli(['command', '--json', '{"type":"log","id":"QG-BOARD","text":"CLI unit fixture"}', '--expect', '7'], { fetchImpl, token: '', output: (value) => output.push(value) });
  assert.equal(calls.length, 2); assert.equal(calls[1].options.headers.Origin, 'http://127.0.0.1:14732'); assert.equal(calls[1].options.headers['X-Board-Token'], 'never-print-this');
  assert.equal(JSON.parse(calls[1].options.body).expectedRevision, 7); assert.ok(!output.join('').includes('never-print-this'));
});
test('CLI native usage reads only the chosen local file and sends contents/hash/CAS, never its path or source overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-native-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'private-location.jsonl'), content = '{"kind":"synthetic-cli-fixture-only"}\n'; await writeFile(path, content);
  const calls = [], output = [], fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/preview') ? { valid: true, revision: 12, contentHash: 'a'.repeat(64), summary: { source: 'automated-test' } } : { revision: 13, replayed: false };
    return { ok: true, json: async () => data };
  };
  const deps = { token: 'test-only', fetchImpl, output: (value) => output.push(value) };
  await runCli(['usage-import-preview', path, '--json'], deps); assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].options.body).content, content); assert.equal(JSON.parse(output.pop()).valid, true);
  calls.length = 0; await runCli(['usage-import', path, '--expect', '11'], deps); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), { content, contentHash: 'a'.repeat(64), expectedRevision: 11 });
  assert.ok(!JSON.stringify(calls).includes(path)); assert.ok(!JSON.stringify(calls).includes('private-location')); assert.equal(calls[1].options.headers['X-Board-Token'], 'test-only');
  calls.length = 0; await runCli(['usage-import', path], deps); assert.equal(JSON.parse(calls[1].options.body).expectedRevision, 12);
  for (const args of [['usage-import', path, '--source', 'userusage'], ['usage-import', path, '--build', 'forged'], ['usage-import', path, '--json', '{"source":"userusage"}'], ['usage-import']]) await assert.rejects(runCli(args, deps));
});
test('CLI native import rejects invalid previews and does not retry 409 or print private content', async () => {
  const calls = [], content = 'synthetic-private-input';
  const base = { token: 'test', readUsageFile: async () => content, output: () => {} };
  await assert.rejects(runCli(['usage-import', 'chosen-local.jsonl'], { ...base, fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ valid: false, errors: [{ code: 'INCOMPLETE_NATIVE_USAGE', message: content }], revision: 0 }) }; } }), (error) => /INCOMPLETE_NATIVE_USAGE/.test(error.message) && !error.message.includes(content));
  assert.equal(calls.length, 1); calls.length = 0;
  await assert.rejects(runCli(['usage-import', 'chosen-local.jsonl'], { ...base, fetchImpl: async (url) => { calls.push(url); return url.endsWith('/preview') ? { ok: true, json: async () => ({ valid: true, revision: 0, contentHash: 'a'.repeat(64) }) } : { ok: false, status: 409, json: async () => ({ error: { code: 'REVISION_CONFLICT', message: 'reload' } }) }; } }), (error) => error.status === 409);
  assert.equal(calls.length, 2);
});
test('CLI native input rejects malformed UTF-8, directories and oversized files before upload', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qg-native-file-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'input.jsonl'); await writeFile(path, Buffer.from([0xc3, 0x28])); await assert.rejects(readNativeUsageFile(path), /UTF-8/);
  await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1)); await assert.rejects(readNativeUsageFile(path), /10 MiB/);
  await assert.rejects(readNativeUsageFile(dir)); await assert.rejects(readNativeUsageFile(undefined), /required/);
});

test('CLI surfaces revision conflict without automatic retry', async () => {
  let count = 0;
  await assert.rejects(runCli(['transition', 'QG-BOARD', 'inprogress', '--expect', '0'], { token: 'unit-token', output: () => {}, fetchImpl: async () => { count++; return { ok: false, status: 409, json: async () => ({ error: { code: 'REVISION_CONFLICT', message: 'reload', details: { expectedRevision: 0, actualRevision: 2 } } }) }; } }), (error) => error.status === 409 && /actualRevision/.test(error.message));
  assert.equal(count, 1);
});
