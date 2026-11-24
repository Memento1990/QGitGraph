import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { applyCommand, assert, BoardError, exactKeys, isObject, parseNativeUsage, NATIVE_HEADER_FIELDS, NATIVE_RECORD_FIELDS, validateBoard, validateUsageEvent, validateUsageSession, VERSION } from './core.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const DEFAULT_LIMITS = { boardBytes: 4 * 1024 * 1024, sessionBytes: 10 * 1024 * 1024, globalBytes: 50 * 1024 * 1024, sessionCount: 1000, backupCount: 20, backupBytes: 20 * 1024 * 1024 };
const SESSION_RE = /^s-[a-f0-9-]{36}$/;
const sessionName = (id) => `${id}.jsonl`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
function capabilityMatches(actual, supplied) { if (typeof supplied !== 'string') return false; const a = Buffer.from(actual), b = Buffer.from(supplied); return a.length === b.length && timingSafeEqual(a, b); }
async function maybeRead(path) { try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EACCES', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}
async function atomicReplace(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await rename(temporary, path); await syncDirectory(dirname(path)); }
  finally { await handle?.close(); await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
function sessionMetadata(session) {
  const { sessionId, source, build, taskIds, createdAt, receivedAt, version, lastSequence, eventCount, bytes, partialTail, paused, origin, runtime, importedAt, contentHash } = session;
  return { sessionId, source, build, taskIds, createdAt, receivedAt, version, lastSequence, eventCount, bytes, partialTail, paused, ...(origin ? { origin, runtime, importedAt, contentHash } : {}) };
}
const stable = (value) => JSON.stringify(value, (_, item) => isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

// Internal path injection is for unit tests; HTTP and CLI expose no state-path option.
export async function createStore(boardPath, { initialBoard, limits: overrides = {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  boardPath = resolve(boardPath);
  const parent = dirname(boardPath);
  const localDir = basename(parent) === 'data' ? resolve(parent, '../.local') : join(parent, '.local');
  const backupsDir = join(localDir, 'backups'), usageDir = join(localDir, 'usage'), lockPath = join(localDir, 'exclusive.lock');
  await mkdir(parent, { recursive: true }); await mkdir(backupsDir, { recursive: true }); await mkdir(usageDir, { recursive: true });
  let lock;
  const lockBytes = jsonBytes({ pid: process.pid, createdAt: new Date().toISOString(), nonce: randomUUID() });
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new BoardError('STORE_LOCKED', 'Another server holds exclusive.lock. Stop it first; a stale lock must be reviewed and removed manually.', 423); throw error; }
  let current, expectedHash, closed = false, poisoned = null, usageError = null, usageBytes = 0;
  const sessions = new Map(), eventsById = new Map();
  let queue = Promise.resolve();
  const serial = (operation) => {
    const pending = queue.then(() => { assert(!closed, 'STORE_CLOSED', 'Store is closed', 503); return operation(); });
    queue = pending.catch(() => {}); return pending;
  };
  async function releaseLock() {
    await lock?.close(); lock = null;
    const actual = await maybeRead(lockPath); if (actual && actual.equals(lockBytes)) await unlink(lockPath);
  }
  async function readChecked() {
    if (poisoned) throw poisoned;
    try {
      const bytes = await readFile(boardPath);
      assert(bytes.length <= limits.boardBytes, 'BOARD_TOO_LARGE', 'Board exceeds configured size limit', 507);
      let board; try { board = JSON.parse(bytes.toString('utf8')); } catch { throw new BoardError('CORRUPT_BOARD', 'Board JSON is corrupt; refusing writes. Restore a reviewed backup offline.', 503); }
      try { validateBoard(board); } catch (error) { throw new BoardError('CORRUPT_BOARD', `Board schema is invalid: ${error.message}; refusing writes.`, 503); }
      assert(sha(bytes) === expectedHash, 'EXTERNAL_MODIFICATION', 'Board changed outside this process; refusing overwrite. Stop the server and review the file.', 409);
      return { bytes, board };
    } catch (error) { poisoned = error instanceof BoardError ? error : new BoardError('BOARD_READ_FAILED', `Cannot read board: ${error.code ?? error.message}; refusing writes.`, 503); throw poisoned; }
  }
  async function backup(bytes, revision) {
    const path = join(backupsDir, `board-r${String(revision).padStart(10, '0')}-${randomUUID()}.json`);
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const entries = [];
    for (const name of await readdir(backupsDir)) if (/^board-r\d+-[a-f0-9-]+\.json$/.test(name)) { const file = join(backupsDir, name); const info = await stat(file); entries.push({ file, size: info.size, mtime: info.mtimeMs }); }
    entries.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
    let total = 0;
    for (const [index, entry] of entries.entries()) { total += entry.size; if (index >= limits.backupCount || total > limits.backupBytes) await unlink(entry.file); }
  }
  function verifyStoredEvent(record, session) {
    exactKeys(record, ['eventId', 'sequence', 'timestamp', 'taskIds', 'scenarioId', 'actionId', 'resultCode', 'durationMs', 'repoId', 'counts', 'state', 'errorCode', 'sessionId', 'source', 'build', 'receivedAt', 'version'], 'stored event');
    const clientEvent = Object.fromEntries(Object.entries(record).filter(([key]) => !['sessionId', 'source', 'build', 'receivedAt', 'version'].includes(key)));
    validateUsageEvent(clientEvent, new Set(current.tasks.map((task) => task.id)));
    assert(record.sessionId === session.sessionId && record.source === session.source && record.build === session.build && record.version === VERSION && Number.isFinite(Date.parse(record.receivedAt)), 'CORRUPT_USAGE', 'Stored event metadata differs from session', 503);
    assert(record.sequence === session.lastSequence + 1 && !eventsById.has(record.eventId), 'CORRUPT_USAGE', 'Stored sequence/ID duplicated or skipped', 503);
    if (session.taskIds.length > 0) assert(record.taskIds.every((id) => session.taskIds.includes(id)), 'CORRUPT_USAGE', 'Stored event is outside session task scope', 503);
  }
  async function loadUsage() {
    const names = await readdir(usageDir);
    assert(names.length <= limits.sessionCount, 'USAGE_FULL', 'Usage session count limit reached or exceeded', 507);
    for (const name of names) {
      assert(/^s-[a-f0-9-]{36}\.jsonl$/.test(name), 'CORRUPT_USAGE', 'Unexpected usage file; review offline', 503);
      const file = join(usageDir, name), info = await stat(file);
      assert(info.isFile() && info.size <= limits.sessionBytes && usageBytes + info.size <= limits.globalBytes, 'USAGE_FULL', 'Usage storage exceeds configured limits; review offline', 507);
      const bytes = await readFile(file); usageBytes += bytes.length;
      assert(bytes.length <= limits.sessionBytes, 'USAGE_FULL', 'A usage session exceeds the byte limit', 507);
      const text = bytes.toString('utf8'), completeText = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      const lines = completeText.split('\n').filter(Boolean);
      assert(lines.length > 0, 'CORRUPT_USAGE', 'Missing complete session header', 503);
      let header; try { header = JSON.parse(lines.shift()); } catch { throw new BoardError('CORRUPT_USAGE', 'Invalid session header', 503); }
      if (header.kind === 'native-session') {
        assert(text.endsWith('\n'), 'CORRUPT_USAGE', 'Imported native session has a partial tail; evidence unavailable', 503);
        exactKeys(header, [...NATIVE_HEADER_FIELDS, 'origin', 'importedAt', 'contentHash'], 'native stored header');
        const nativeHeader = Object.fromEntries(NATIVE_HEADER_FIELDS.map((key) => [key, header[key]]));
        let nativeRecords; try { nativeRecords = lines.map((line) => JSON.parse(line)); } catch { throw new BoardError('CORRUPT_USAGE', 'Invalid imported native JSONL; evidence unavailable', 503); }
        for (const record of nativeRecords) {
          exactKeys(record, [...NATIVE_RECORD_FIELDS, 'origin', 'importedAt', 'receivedAt', 'timestamp', 'version'], 'native stored record');
          assert(record.origin === 'native' && record.importedAt === header.importedAt && record.version === VERSION && record.timestamp === record.occurredAt && record.receivedAt === record.collectedAt, 'CORRUPT_USAGE', 'Native stored provenance/time was changed', 503);
        }
        const originalRecords = nativeRecords.map((record) => Object.fromEntries(NATIVE_RECORD_FIELDS.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]])));
        const parsed = parseNativeUsage([nativeHeader, ...originalRecords].map((record) => JSON.stringify(record)).join('\n') + '\n', new Set(current.tasks.map((task) => task.id)));
        assert(header.origin === 'native' && sessionName(header.sessionId) === name && /^[a-f0-9]{64}$/.test(header.contentHash) && header.contentHash === sha(stable(parsed)) && Number.isFinite(Date.parse(header.importedAt)) && Date.parse(header.importedAt) >= Date.parse(originalRecords.at(-1).collectedAt), 'CORRUPT_USAGE', 'Invalid native import audit metadata', 503);
        const session = { ...header, receivedAt: header.createdAt, version: VERSION, storageHash: sha(bytes), bytes: bytes.length, token: null, lastSequence: originalRecords.at(-1).sequence, eventCount: nativeRecords.length, events: nativeRecords, partialTail: false, paused: true };
        for (const record of nativeRecords) { assert(!eventsById.has(record.eventId), 'CORRUPT_USAGE', 'Duplicate imported native event ID', 503); eventsById.set(record.eventId, { ...record, complete: true }); }
        sessions.set(session.sessionId, session); continue;
      }
      exactKeys(header, ['kind', 'sessionId', 'source', 'build', 'taskIds', 'createdAt', 'receivedAt', 'version'], 'session header');
      assert(header.kind === 'session' && sessionName(header.sessionId) === name && SESSION_RE.test(header.sessionId) && header.version === VERSION && Number.isFinite(Date.parse(header.createdAt)) && header.receivedAt === header.createdAt, 'CORRUPT_USAGE', 'Invalid session metadata', 503);
      validateUsageSession({ source: header.source, build: header.build, taskIds: header.taskIds }, new Set(current.tasks.map((task) => task.id)));
      const session = { ...header, bytes: bytes.length, token: null, lastSequence: 0, eventCount: 0, events: [], partialTail: !text.endsWith('\n'), paused: !text.endsWith('\n') };
      for (const line of lines) {
        let record; try { record = JSON.parse(line); } catch { throw new BoardError('CORRUPT_USAGE', 'Invalid complete JSONL event; evidence unavailable until reviewed', 503); }
        verifyStoredEvent(record, session); session.lastSequence = record.sequence; session.eventCount++; session.events.push(record); eventsById.set(record.eventId, { ...record, complete: true });
      }
      sessions.set(session.sessionId, session);
    }
    assert(usageBytes <= limits.globalBytes, 'USAGE_FULL', 'Global usage byte limit exceeded; collection paused, no logs deleted', 507);
  }
  try {
    await lock.writeFile(lockBytes); await lock.sync();
    let bytes = await maybeRead(boardPath);
    if (!bytes) {
      assert(initialBoard, 'BOARD_MISSING', 'Board is missing; generate the seed before starting', 503); validateBoard(initialBoard);
      bytes = jsonBytes(initialBoard); assert(bytes.length <= limits.boardBytes, 'BOARD_TOO_LARGE', 'Initial board is too large', 507); await atomicReplace(boardPath, bytes);
    }
    assert(bytes.length <= limits.boardBytes, 'BOARD_TOO_LARGE', 'Board exceeds size limit', 507);
    try { current = validateBoard(JSON.parse(bytes.toString('utf8'))); }
    catch (error) { throw new BoardError('CORRUPT_BOARD', `Invalid board; refusing to replace it: ${error.message}`, 503); }
    expectedHash = sha(bytes);
    try { await loadUsage(); } catch (error) { usageError = new BoardError(error instanceof BoardError ? error.code : 'CORRUPT_USAGE', 'Usage storage validation failed; evidence unavailable pending offline review', error instanceof BoardError ? error.status : 503); }
  } catch (error) { await releaseLock(); throw error; }

  async function verifyNativeFiles() {
    if (usageError) throw usageError;
    for (const session of sessions.values()) if (session.origin === 'native') {
      let bytes;
      try {
        const file = join(usageDir, sessionName(session.sessionId));
        assert((await stat(file)).size === session.bytes, 'CORRUPT_USAGE', 'Imported native log changed; evidence blocked pending offline review', 503);
        bytes = await readFile(file);
      } catch { usageError = new BoardError('CORRUPT_USAGE', 'Imported native log changed or is missing; evidence blocked pending offline review', 503); throw usageError; }
      if (sha(bytes) !== session.storageHash) { usageError = new BoardError('CORRUPT_USAGE', 'Imported native log bytes changed; evidence blocked pending offline review', 503); throw usageError; }
    }
  }
  function prepareNative(input) {
    if (usageError) throw usageError;
    exactKeys(input, ['content'], 'native usage import');
    let parsed;
    try { parsed = parseNativeUsage(input.content, new Set(current.tasks.map((task) => task.id))); }
    catch (failure) { throw new BoardError(failure instanceof BoardError ? failure.code : 'INVALID_NATIVE_USAGE', 'Native usage validation failed; no records imported and no input content retained.'); }
    const { header, records } = parsed, contentHash = sha(stable(parsed));
    const existing = sessions.get(header.sessionId);
    if (existing) {
      assert(existing.origin === 'native' && existing.contentHash === contentHash, 'NATIVE_PROVENANCE_CONFLICT', 'Session ID already exists with a different payload/source/build', 409);
      return { existing, contentHash, summary: { sessionId: header.sessionId, source: header.source, build: header.build, runtime: header.runtime, records: records.length, replayed: true } };
    }
    for (const record of records) assert(!eventsById.has(record.eventId), 'DUPLICATE_EVENT', 'Native event ID already exists; IDs cannot be rewritten for import', 409);
    assert(sessions.size < limits.sessionCount, 'USAGE_FULL', 'Usage session limit reached; no logs deleted', 507);
    const importedAt = new Date().toISOString();
    const storedHeader = { ...header, origin: 'native', contentHash, importedAt };
    const storedRecords = records.map((record) => ({ ...record, origin: 'native', importedAt, timestamp: record.occurredAt, receivedAt: record.collectedAt, version: VERSION }));
    const bytes = Buffer.from([storedHeader, ...storedRecords].map((record) => `${JSON.stringify(record)}\n`).join(''));
    assert(bytes.length <= limits.sessionBytes && usageBytes + bytes.length <= limits.globalBytes, 'USAGE_FULL', 'Native import exceeds usage capacity; no logs deleted', 507);
    const session = { ...storedHeader, receivedAt: header.createdAt, version: VERSION, token: null, storageHash: sha(bytes), lastSequence: records.at(-1).sequence, eventCount: records.length, events: storedRecords, partialTail: false, paused: true, bytes: bytes.length };
    return { session, bytes, contentHash, summary: { sessionId: header.sessionId, source: header.source, build: header.build, runtime: header.runtime, records: records.length, replayed: false, bytes: bytes.length } };
  }
  return {
    getBoard: () => serial(async () => structuredClone((await readChecked()).board)),
    previewNativeUsage: (input) => serial(async () => {
      await readChecked();
      try { await verifyNativeFiles(); const preview = prepareNative(input); return { valid: true, errors: [], revision: current.metadata.revision, contentHash: preview.contentHash, summary: preview.summary }; }
      catch (error) { return { valid: false, errors: [{ code: error instanceof BoardError ? error.code : 'INVALID_NATIVE_USAGE', message: 'Native usage validation failed; no records imported and no input content retained.' }], revision: current.metadata.revision, summary: null }; }
    }),
    importNativeUsage: (input) => serial(async () => {
      exactKeys(input, ['content', 'expectedRevision', 'contentHash'], 'native import commit');
      assert(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'REVISION_REQUIRED', 'expectedRevision must be a nonnegative integer');
      const before = await readChecked();
      assert(input.expectedRevision === current.metadata.revision, 'REVISION_CONFLICT', 'Revision conflict; review and retry explicitly.', 409, { expectedRevision: input.expectedRevision, actualRevision: current.metadata.revision });
      await verifyNativeFiles();
      const prepared = prepareNative({ content: input.content });
      assert(typeof input.contentHash === 'string' && input.contentHash === prepared.contentHash, 'IMPORT_PREVIEW_REQUIRED', 'Commit requires the exact validated preview contentHash', 409);
      if (prepared.existing) return { revision: current.metadata.revision, ...prepared.summary };
      const board = structuredClone(current); board.metadata.revision++; board.metadata.updatedAt = new Date().toISOString(); validateBoard(board);
      const boardBytes = jsonBytes(board); assert(boardBytes.length <= limits.boardBytes, 'BOARD_TOO_LARGE', 'Import audit revision exceeds size limit', 507);
      await backup(before.bytes, current.metadata.revision); await readChecked();
      const handle = await open(join(usageDir, sessionName(prepared.session.sessionId)), 'wx', 0o600);
      try { await handle.writeFile(prepared.bytes); await handle.sync(); }
      catch { usageError = new BoardError('USAGE_WRITE_FAILED', 'Native import write failed; restart and review local logs before further evidence', 503); throw usageError; }
      finally { await handle.close(); }
      await syncDirectory(usageDir);
      // The usage file is durable first. A crash before the board revision is recoverable by an exact replay.
      sessions.set(prepared.session.sessionId, prepared.session); usageBytes += prepared.bytes.length;
      for (const record of prepared.session.events) eventsById.set(record.eventId, { ...record, complete: true });
      try { await readChecked(); await atomicReplace(boardPath, boardBytes); }
      catch (error) { poisoned = new BoardError('IMPORT_AUDIT_FAILED', 'Native logs saved but board revision was not confirmed; restart and review before retrying', 503); throw poisoned; }
      current = board; expectedHash = sha(boardBytes);
      return { revision: board.metadata.revision, importedAt: prepared.session.importedAt, ...prepared.summary };
    }),
    transact: (expectedRevision, command) => serial(async () => {
      assert(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'REVISION_REQUIRED', 'expectedRevision must be a nonnegative integer');
      const before = await readChecked();
      assert(expectedRevision === current.metadata.revision, 'REVISION_CONFLICT', 'Revision conflict; reload the board and retry explicitly.', 409, { expectedRevision, actualRevision: current.metadata.revision });
      let usageChecked = false;
      const outcome = await applyCommand(current, command, { resolveUsageEvent: async (id) => { if (!usageChecked) { await verifyNativeFiles(); usageChecked = true; } return eventsById.get(id) ?? null; } });
      const bytes = jsonBytes(outcome.board); assert(bytes.length <= limits.boardBytes, 'BOARD_TOO_LARGE', 'Board transaction exceeds size limit', 507);
      await backup(before.bytes, current.metadata.revision);
      await readChecked(); // Detect edits during backup/validation rather than overwriting them.
      await atomicReplace(boardPath, bytes); current = outcome.board; expectedHash = sha(bytes);
      return structuredClone(outcome);
    }),
    createUsageSession: (input) => serial(async () => {
      if (usageError) throw usageError;
      const { board } = await readChecked(); validateUsageSession(input, new Set(board.tasks.map((task) => task.id)));
      assert(sessions.size < limits.sessionCount, 'USAGE_FULL', 'Usage session count limit reached; collection paused, no logs deleted', 507);
      const sessionId = `s-${randomUUID()}`, token = randomBytes(32).toString('hex'), now = new Date().toISOString();
      const header = { kind: 'session', sessionId, source: input.source, build: input.build, taskIds: input.taskIds ?? [], createdAt: now, receivedAt: now, version: VERSION };
      const bytes = Buffer.from(`${JSON.stringify(header)}\n`);
      assert(bytes.length <= limits.sessionBytes && usageBytes + bytes.length <= limits.globalBytes, 'USAGE_FULL', 'Usage byte limit reached; collection paused, no logs deleted', 507);
      const handle = await open(join(usageDir, sessionName(sessionId)), 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } catch (error) { usageError = new BoardError('USAGE_WRITE_FAILED', `Session write failed (${error.code ?? 'I/O'}); collection paused`, 503); throw usageError; } finally { await handle.close(); }
      sessions.set(sessionId, { ...header, token, bytes: bytes.length, lastSequence: 0, eventCount: 0, events: [], partialTail: false, paused: false }); usageBytes += bytes.length;
      return { sessionId, sessionToken: token, source: header.source, build: header.build };
    }),
    appendUsageEvents: (input) => serial(async () => {
      if (usageError) throw usageError;
      exactKeys(input, ['sessionId', 'sessionToken', 'events'], 'usage batch');
      assert(typeof input.sessionId === 'string' && SESSION_RE.test(input.sessionId), 'INVALID_SESSION', 'Invalid session ID');
      const session = sessions.get(input.sessionId);
      assert(session?.token && capabilityMatches(session.token, input.sessionToken), 'INVALID_SESSION_TOKEN', 'Unknown, expired or invalid in-memory session capability', 403);
      assert(!session.paused && !session.partialTail, 'USAGE_PAUSED', 'Session is paused; partial tails are read-only and cannot be appended', 507);
      assert(Array.isArray(input.events) && input.events.length >= 1 && input.events.length <= 100, 'INVALID_INPUT', 'events must contain 1..100 items');
      const { board } = await readChecked(), knownIds = new Set(board.tasks.map((task) => task.id));
      const receivedAt = new Date().toISOString(), ids = new Set(); let next = session.lastSequence + 1;
      const replay = input.events.map((event) => eventsById.get(event.eventId));
      if (replay.every(Boolean)) {
        for (let index = 0; index < input.events.length; index++) {
          const event = input.events[index], existing = replay[index];
          validateUsageEvent(event, knownIds);
          assert(existing.sessionId === session.sessionId && existing.complete, 'DUPLICATE_EVENT', 'eventId belongs to another or incomplete session', 409);
          const original = Object.fromEntries(Object.keys(event).map((key) => [key, existing[key]]));
          assert(JSON.stringify(original) === JSON.stringify(event), 'DUPLICATE_EVENT', 'Replay event payload differs from the stored event', 409);
        }
        return { accepted: input.events.length, eventIds: input.events.map((event) => event.eventId), lastSequence: session.lastSequence, replayed: true };
      }
      for (const event of input.events) {
        validateUsageEvent(event, knownIds);
        assert(event.sequence === next++, 'SEQUENCE_CONFLICT', 'Sequences must be contiguous and strictly increasing', 409, { lastSequence: session.lastSequence });
        assert(!eventsById.has(event.eventId) && !ids.has(event.eventId), 'DUPLICATE_EVENT', 'eventId already exists', 409); ids.add(event.eventId);
        if (session.taskIds.length > 0) assert(event.taskIds.every((id) => session.taskIds.includes(id)), 'INVALID_INPUT', 'Event task is outside session scope');
      }
      const records = input.events.map((event) => ({ ...structuredClone(event), sessionId: session.sessionId, source: session.source, build: session.build, receivedAt, version: VERSION }));
      const bytes = Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(''));
      if (session.bytes + bytes.length > limits.sessionBytes || usageBytes + bytes.length > limits.globalBytes) { session.paused = true; throw new BoardError('USAGE_FULL', 'Usage byte limit reached; collection paused, no logs deleted', 507); }
      const file = join(usageDir, sessionName(session.sessionId));
      assert((await stat(file)).size === session.bytes, 'EXTERNAL_MODIFICATION', 'Usage file size changed externally; refusing append', 409);
      const handle = await open(file, 'a');
      try { await handle.writeFile(bytes); await handle.sync(); }
      catch (error) { session.paused = true; usageError = new BoardError('USAGE_WRITE_FAILED', `Usage append failed (${error.code ?? 'I/O'}); collection paused`, 503); throw usageError; }
      finally { await handle.close(); }
      session.bytes += bytes.length; usageBytes += bytes.length; session.lastSequence = records.at(-1).sequence; session.eventCount += records.length; session.events.push(...records);
      for (const record of records) eventsById.set(record.eventId, { ...record, complete: true });
      return { accepted: records.length, eventIds: records.map((event) => event.eventId), lastSequence: session.lastSequence };
    }),
    getUsage: ({ sessionId, offset = 0, limit = 200 } = {}) => serial(async () => {
      try { await verifyNativeFiles(); } catch { /* Return an explicit warning; never present corrupt native bytes as complete evidence. */ }
      assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'INVALID_INPUT', 'Usage pagination requires offset>=0 and limit 1..1000');
      if (sessionId !== undefined) {
        assert(typeof sessionId === 'string' && SESSION_RE.test(sessionId), 'INVALID_SESSION', 'Invalid session ID'); const session = sessions.get(sessionId); assert(session, 'NOT_FOUND', 'Unknown usage session', 404);
        return structuredClone({ sessions: [sessionMetadata(session)], events: session.events.slice(offset, offset + limit).map((event) => ({ ...event, complete: !usageError })), total: session.eventCount, offset, limit, ...(usageError ? { warning: { code: usageError.code, message: usageError.message } } : {}) });
      }
      return structuredClone({ sessions: [...sessions.values()].slice(offset, offset + limit).map(sessionMetadata), total: sessions.size, offset, limit, bytes: usageBytes, limits: { sessionBytes: limits.sessionBytes, globalBytes: limits.globalBytes }, ...(usageError ? { warning: { code: usageError.code, message: usageError.message } } : {}) });
    }),
    close: async () => { await queue; if (closed) return; closed = true; for (const session of sessions.values()) session.token = null; await releaseLock(); },
  };
}
