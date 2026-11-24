import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createStore } from './store.mjs';
import { BOARD_PATH, SOURCE_PATH, createSeed } from './seed.mjs';
import { BoardError, exactKeys, VERSION, previewImport } from './core.mjs';

export const HOST = '127.0.0.1';
export const PORT = 14732;
export const BOARD_ORIGIN = `http://${HOST}:${PORT}`;
export const USAGE_ORIGINS = new Set([`http://${HOST}:14731`, BOARD_ORIGIN]);
const MAX_BODY = 6 * 1024 * 1024;
const MAX_NATIVE_BODY = 16 * 1024 * 1024; // 10 MiB JSONL plus JSON string escaping; native parser enforces its own raw limit.
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC_FILES = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.js', 'app.js'], ['/protocol.js', 'protocol.js'], ['/protocol.mjs', 'protocol.mjs'], ['/protocol.json', 'protocol.json']]);
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const problem = (code, message, status = 400, details) => new BoardError(code, message, status, details);
export function validateRequest(req) {
  if (req.headers.host !== `${HOST}:${PORT}`) throw problem('HOST_REJECTED', 'Host must be exactly 127.0.0.1:14732', 403);
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || /[\\#]/.test(req.url)) throw problem('INVALID_PATH', 'Only fixed local request targets are accepted');
}
function json(res, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...headers }); res.end(body);
}
function fail(res, error) {
  const known = error instanceof BoardError;
  json(res, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Internal server error; request was not confirmed', ...(known && error.details !== undefined ? { details: error.details } : {}) } });
}
function requireOrigin(req, allowed, optional = false) {
  const value = req.headers.origin;
  if (!(optional && value === undefined) && !allowed.has(value)) throw problem('ORIGIN_REJECTED', 'Origin is not an allowed loopback application origin', 403);
}
function requireToken(req, expected) {
  const supplied = req.headers['x-board-token'];
  if (typeof supplied !== 'string') throw problem('BOARD_TOKEN_REQUIRED', 'X-Board-Token is required', 401);
  const actual = Buffer.from(expected), candidate = Buffer.from(supplied);
  if (actual.length !== candidate.length || !timingSafeEqual(actual, candidate)) throw problem('BOARD_TOKEN_INVALID', 'X-Board-Token is invalid', 403);
}
async function body(req, max = MAX_BODY) {
  if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw problem('CONTENT_TYPE_REQUIRED', 'JSON routes require Content-Type: application/json', 415);
  if (Number(req.headers['content-length']) > max) throw problem('BODY_TOO_LARGE', 'Request body is too large', 413);
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > max) throw problem('BODY_TOO_LARGE', 'Request body is too large', 413); chunks.push(chunk); }
  if (total === 0) throw problem('INVALID_JSON', 'JSON request body is required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('INVALID_JSON', 'Request body must be valid JSON'); }
}
function numberParam(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw problem('INVALID_INPUT', 'Pagination values must be bounded nonnegative integers');
  return Number(value);
}
async function staticResponse(res, path) {
  if (path === '/protocol') { json(res, 200, { version: VERSION, tokenHeader: 'X-Board-Token', origin: BOARD_ORIGIN }); return true; }
  const filename = STATIC_FILES.get(path); if (!filename) return false;
  let content;
  try { content = await readFile(resolve(PUBLIC, filename)); } catch (error) { if (error.code === 'ENOENT') throw problem('NOT_FOUND', 'Static resource not found', 404); throw error; }
  const type = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.json') ? 'application/json' : 'text/javascript';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Content-Length': content.length }); res.end(content); return true;
}

// Handler injection supports isolated tests without binding the production port or exposing alternate state paths.
export function createRequestHandler({ store, token, sourcePath = SOURCE_PATH }) {
  const build = Promise.all(['core.mjs', 'store.mjs', 'server.mjs', 'seed.mjs', 'public/index.html', 'public/app.js', 'public/styles.css'].map(file => readFile(new URL(file, import.meta.url)))).then(parts => {
    const hash = createHash('sha256'); for (const part of parts) hash.update(part); return `taskboard-${hash.digest('hex').slice(0, 16)}`;
  });
  return async (req, res) => {
    const timeout = setTimeout(() => req.destroy(), 20_000); timeout.unref();
    const clear = () => clearTimeout(timeout); res.once('close', clear); res.once('finish', clear);
    try {
      validateRequest(req);
      const method = req.method ?? 'GET', path = req.url.split('?', 1)[0], params = new URL(req.url, BOARD_ORIGIN).searchParams;
      res.setHeader('X-Taskboard-Version', VERSION);
      const usageWrite = method === 'POST' && ['/api/usage/session', '/api/usage/events'].includes(path);
      requireOrigin(req, usageWrite ? USAGE_ORIGINS : new Set([BOARD_ORIGIN]), !usageWrite);
      if (method === 'GET' && await staticResponse(res, path)) return;
      if (path === '/api/bootstrap' && method === 'GET') return json(res, 200, { token, version: VERSION, build: await build });
      if (usageWrite) {
        const input = await body(req);
        return json(res, 200, await (path.endsWith('/session') ? store.createUsageSession(input) : store.appendUsageEvents(input)));
      }
      if (!path.startsWith('/api/')) throw problem('NOT_FOUND', 'Route not found', 404);
      requireToken(req, token);
      if (path === '/api/board' && method === 'GET') return json(res, 200, await store.getBoard());
      if (path === '/api/export' && method === 'GET') return json(res, 200, await store.getBoard(), { 'Content-Disposition': 'attachment; filename="board.json"' });
      if (path === '/api/baseline-source' && method === 'GET') {
        const source = await readFile(sourcePath); res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': source.length }); return res.end(source);
      }
      if (path === '/api/command' && method === 'POST') {
        const input = await body(req); exactKeys(input, ['expectedRevision', 'command'], 'command request');
        return json(res, 200, await store.transact(input.expectedRevision, input.command));
      }
      if (path === '/api/import/preview' && method === 'POST') {
        const input = await body(req); exactKeys(input, ['content'], 'import preview');
        const result = previewImport(await store.getBoard(), input.content); return json(res, 200, { valid: result.valid, errors: result.errors, summary: result.summary });
      }
      if (path === '/api/usage/import/preview' && method === 'POST') {
        const input = await body(req, MAX_NATIVE_BODY); exactKeys(input, ['content'], 'native usage preview');
        return json(res, 200, await store.previewNativeUsage(input));
      }
      if (path === '/api/usage/import/commit' && method === 'POST') {
        const input = await body(req, MAX_NATIVE_BODY); exactKeys(input, ['content', 'expectedRevision', 'contentHash'], 'native usage commit');
        return json(res, 200, await store.importNativeUsage(input));
      }
      if (['/api/usage', '/api/usage/sessions'].includes(path) && method === 'GET') {
        const options = { offset: numberParam(params.get('offset'), 0), limit: numberParam(params.get('limit'), 200, 1000) };
        if (path === '/api/usage' && params.has('sessionId')) options.sessionId = params.get('sessionId');
        return json(res, 200, await store.getUsage(options));
      }
      throw problem('NOT_FOUND', 'Route not found', 404);
    } catch (error) { if (!res.destroyed && !res.headersSent) fail(res, error); }
  };
}
export async function startServer({ boardPath = BOARD_PATH, sourcePath = SOURCE_PATH, port = PORT, host = HOST, store, token = randomBytes(32).toString('hex') } = {}) {
  if (host !== HOST || port !== PORT) throw new Error(`Taskboard is fixed to ${HOST}:${PORT}`);
  const actualStore = store ?? await createStore(boardPath, { initialBoard: createSeed(await readFile(sourcePath, 'utf8')) });
  const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 }, createRequestHandler({ store: actualStore, token, sourcePath }));
  try { await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); }); }
  catch (error) { if (!store) await actualStore.close(); throw error; }
  let closing;
  return { server, store: actualStore, token, version: VERSION, close: () => closing ??= (async () => {
    await new Promise((accept, reject) => { server.close((error) => error ? reject(error) : accept()); server.closeIdleConnections(); });
    if (!store) await actualStore.close();
  })() };
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const running = await startServer();
    console.log(`Taskboard listening on ${BOARD_ORIGIN} (${VERSION})`);
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; running.close().catch((error) => { console.error(`Taskboard shutdown failed: ${error.code ?? 'I/O'}`); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(`Taskboard failed: ${error.code ?? 'START_FAILED'} ${error.message}`); process.exitCode = 1; }
}
