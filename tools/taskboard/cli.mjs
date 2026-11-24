#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BOARD_PATH } from './seed.mjs';
import { BOARD_ORIGIN } from './server.mjs';
import { validateBoard, STATUSES } from './core.mjs';
import { TextDecoder } from 'node:util';
export async function readNativeUsageFile(filename) {
  if (!filename) throw new Error('A local native JSONL file is required');
  const handle = await open(resolve(filename), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Native usage input must be a regular file up to 10 MiB');
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== info.size || (await handle.stat()).size !== info.size) throw new Error('Native usage input changed while reading; stop the session and retry explicitly');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new Error('Native usage file is not valid UTF-8'); }
  } finally { await handle.close(); }
}
const HELP = `Taskboard CLI (Node 22, no dependencies)
  list [--status STATUS] [--pack W0..W9] [--required] [--json]
  show ID [--json]
  validate
  update ID --json '{"owner":"assistant"}' [--expect REV]
  transition ID STATUS [--text NOTE] [--expect REV]
  log ID TEXT [--expect REV]
  retrospective ID TEXT [--expect REV]
  evidence ID --json '{"type":"test","result":"passed","build":"...","summary":"...","reference":"..."}'
  assess ID --json '{"decision":"insufficient","rationale":"...","build":"...","coverage":[],"limitations":[]}'
  command --json '{"type":"update","id":"QG-046","patch":{...}}' [--expect REV]
  import-preview FILE
  import FILE [--expect REV]
  usage-import-preview FILE
  usage-import FILE [--expect REV]

Native import reads FILE only in the CLI, sends content only, and never overrides source/build/IDs.
All writes use the fixed server ${BOARD_ORIGIN}. TASKBOARD_TOKEN can supply its in-memory token;
otherwise the CLI obtains it from /api/bootstrap without printing it. Writes always use revision CAS.
list/show/validate are offline reads of the fixed local board. No --state-path/--url option exists.
`;
function parseArgs(args) {
  const options = {}, positional = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const name = value.slice(2);
    if (['required', 'help'].includes(name)) options[name] = true;
    else if (['status', 'pack', 'text', 'expect'].includes(name) || name === 'json' && args[index + 1] && !args[index + 1].startsWith('--')) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${name} requires a value`); options[name] = args[++index];
    } else if (name === 'json') options.json = true;
    else throw new Error(`Unsupported option --${name}; alternate board/server paths are not supported`);
  }
  if (options.expect !== undefined && !/^\d+$/.test(options.expect)) throw new Error('--expect must be a nonnegative revision integer');
  return { options, positional };
}
export async function runCli(args, { readBoard = () => readFile(BOARD_PATH, 'utf8'), readUsageFile = readNativeUsageFile, fetchImpl = fetch, token: suppliedToken = process.env.TASKBOARD_TOKEN, output = (text) => process.stdout.write(text) } = {}) {
  const { options, positional } = parseArgs(args), [verb, id, ...remaining] = positional;
  const print = (value) => output(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`);
  if (!verb || verb === 'help' || options.help) { output(HELP); return; }
  async function offline() { const board = JSON.parse(await readBoard()); validateBoard(board); return board; }
  if (verb === 'validate') { const board = await offline(); print({ valid: true, revision: board.metadata.revision, tasks: board.tasks.length, baselineRows: board.baseline.rows.length }); return; }
  if (verb === 'list' || verb === 'show') {
    const board = await offline();
    if (verb === 'show') { const task = board.tasks.find((item) => item.id === id); if (!task) throw new Error(`Unknown task ${id}`); print(task); return; }
    if (options.status && !STATUSES.includes(options.status)) throw new Error(`Invalid status ${options.status}`);
    const tasks = board.tasks.filter((task) => (!options.status || task.status === options.status) && (!options.pack || task.pack === options.pack) && (!options.required || task.required));
    print(tasks); return;
  }
  const writes = ['update', 'transition', 'log', 'retrospective', 'evidence', 'assess', 'command', 'import', 'import-preview', 'usage-import', 'usage-import-preview'];
  if (!writes.includes(verb)) throw new Error(`Unknown command ${verb}`);
  let token = suppliedToken;
  async function request(path, body) {
    const response = await fetchImpl(`${BOARD_ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: BOARD_ORIGIN, ...(token ? { 'X-Board-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json(); if (!response.ok) { const error = new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? 'Request failed'}${result.error?.details ? ` ${JSON.stringify(result.error.details)}` : ''}`); error.status = response.status; throw error; } return result;
  }
  if (!token) token = (await request('/api/bootstrap')).token;
  if (verb === 'usage-import' || verb === 'usage-import-preview') {
    if (!id || remaining.length || Object.keys(options).some((key) => !['expect', 'json'].includes(key)) || typeof options.json === 'string') throw new Error('Native usage import accepts FILE, optional --expect and --json only; provenance cannot be overridden');
    const content = await readUsageFile(id);
    const preview = await request('/api/usage/import/preview', { content });
    if (verb === 'usage-import-preview') { print(preview); return; }
    if (!preview.valid) throw new Error(`Native usage preview rejected (${preview.errors?.map((item) => item.code).join(', ') ?? 'INVALID_NATIVE_USAGE'}); nothing imported`);
    const expectedRevision = options.expect === undefined ? preview.revision : Number(options.expect);
    if (!Number.isSafeInteger(expectedRevision)) throw new Error('--expect revision is too large');
    print(await request('/api/usage/import/commit', { content, contentHash: preview.contentHash, expectedRevision })); return;
  }
  const parse = () => { if (typeof options.json !== 'string') throw new Error(`${verb} requires --json '<JSON object>'`); try { return JSON.parse(options.json); } catch { throw new Error('--json must contain valid JSON'); } };
  let command;
  if (verb === 'import-preview' || verb === 'import') {
    const content = await readFile(resolve(id ?? ''), 'utf8');
    if (verb === 'import-preview') { print(await request('/api/import/preview', { content })); return; }
    command = { type: 'import', content };
  } else if (verb === 'command') command = parse();
  else if (verb === 'update') command = { type: 'update', id, patch: parse() };
  else if (verb === 'transition') command = { type: 'transition', id, status: remaining[0], ...(options.text ? { text: options.text } : {}) };
  else if (verb === 'log' || verb === 'retrospective') command = { type: verb, id, text: remaining.join(' ') };
  else command = { type: verb, id, [verb === 'assess' ? 'verdict' : 'evidence']: parse() };
  const expectedRevision = options.expect === undefined ? (await request('/api/board')).metadata.revision : Number(options.expect);
  if (!Number.isSafeInteger(expectedRevision)) throw new Error('--expect revision is too large');
  print(await request('/api/command', { expectedRevision, command }));
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try { await runCli(process.argv.slice(2)); } catch (error) { console.error(`taskboard: ${error.message}`); process.exitCode = error.status === 409 ? 3 : 2; }
}
