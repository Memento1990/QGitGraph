import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BlockedError, OwnedProcesses, reservePorts, WebDriver } from './desktop.mjs';
import { createRun, executable, fingerprint, inside, json, PROJECT, powershell, readJson, samePath, sha256, until } from './run.mjs';
import { percentile } from './metrics.mjs';

// This module deliberately has no fixture, write-Git, host-invoke, trust or network API.
export function sampleCount(value = '20') {
  if (!/^(?:[3-9]|[1-4][0-9]|50)$/.test(String(value))) throw new Error('--samples must be an integer from 3 through 50.');
  return Number(value);
}
export function readOnlyEnvironment(base = process.env, { native = false } = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|GCM_|SSH_|WEBVIEW2_|EDGE_)/i.test(key) || /^(QGITGRAPH_PERF|QGITGRAPH_TEST_HOME)$/i.test(key)) delete env[key];
  }
  // Keep the real Windows HOME/USERPROFILE, XDG and system config lookup. Never
  // introduce safe.directory, copy a WSL config or use the fixture sandbox HOME.
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });
  if (native) env.QGITGRAPH_PERF = '1';
  return env;
}
export function assertOutputOutsideRepository(repository, output) {
  if (!isAbsolute(repository) || !isAbsolute(output)) throw new Error('Repository and output must be absolute paths.');
  if (samePath(repository, output) || inside(repository, output)) throw new Error('The output/profile must not be inside the measured repository.');
}
export async function createPerformanceRun(output, repository, kind, samples, base = process.env) {
  assertOutputOutsideRepository(repository, output);
  const run = await createRun(output, 'performance-readonly');
  // createRun is shared with destructive-fixture tests. Its optional Rust test
  // manifest would force an isolated Git HOME, changing safe.directory/config.
  // Remove ONLY the file just created by this run, after verifying its identity.
  const file = join(run.profileDirectory, 'test-manifest.json');
  const manifest = await readJson(file);
  assert.equal(manifest.runId, run.manifest.runId);
  assert(samePath(manifest.profileDirectory, run.profileDirectory));
  assert(inside(run.output, file)); assert.equal(run.manifest.session, null);
  await unlink(file);
  run.env = readOnlyEnvironment(base, { native: kind === 'native' });
  delete run.manifest.refs;
  run.manifest.performanceKind = kind; run.manifest.samples = samples;
  run.manifest.privacy = { localOnly: true, rawDriverOutput: false, fullDomSource: false, sourceContents: false, screenshotsMayContainPrivateData: true, privateSamplePlan: true, samplePlanContainsPrivateOidsAndPaths: true, publicMetricsContainSampleIdentities: false, publicReleaseEligible: false };
  run.manifest.environmentPolicy = {
    name: 'parent-user-git-config-readonly-v1', profileIsolated: true, gitHomeIsolated: false,
    userHomeInherited: true, systemAndGlobalGitConfig: 'Read through normal Windows Git lookup, never changed/copied/bypassed.',
    stripped: ['GIT_* inherited overrides', 'GCM_*', 'SSH_*', 'WEBVIEW2_*', 'EDGE_*'],
    gitOptionalLocks: '0', terminalPrompt: '0', fsmonitor: false, externalDiff: false, textconv: false,
    safeDirectoryOverride: false, networkCommands: false, fixtureCreation: false,
    ownedTestManifestRemoved: true,
    homeIdentitySha256: sha256(JSON.stringify(Object.fromEntries(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA'].map(key => [key, run.env[key] ?? null])))),
  };
  // Only the fresh run-owned application profile is initialized. These are the
  // source defaults used in both arms; no real user preferences are read/copied.
  await json(join(run.profileDirectory, 'state.json'), {
    version: 2, recent: [], lastRepo: null, trusted: [],
    settings: { theme: 'dark', detailPosition: 'inline', diffView: 'unified', pageSize: 300, initialLoad: 300, loadMore: 100, order: 'date', avatars: false, markdown: false, emoji: true },
    repoSettings: {}, reviews: [], layout: { detailSize: 360, fileSize: 260 }, views: {},
  });
  run.manifest.preferences = { detailPosition: 'inline', initialLoad: 300, loadMore: 100, diffView: 'unified', avatars: false, markdown: false, emoji: true, trusted: false };
  await run.save(); return run;
}

export function assertReadOnlyGitArgs(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid read-only Git argument vector.');
  const commands = new Set(['rev-parse', 'for-each-ref', 'status', 'ls-files', 'log', 'diff-tree', 'config']);
  if (!commands.has(args[0])) throw new Error('Git command is outside the read-only allowlist.');
  if (args[0] === 'config' && JSON.stringify(args) !== JSON.stringify(['config', '--null', '--show-origin', '--show-scope', '--list'])) throw new Error('Only the exact read-only config-list operation is permitted.');
  const forbidden = /^(?:--(?:output|ext-diff|textconv|exec|exec-path|git-dir|work-tree|config-env|recurse-submodules|filters|use-mailmap)(?:=|$)|-c$|--?(?:set|unset|add|replace-all|edit|global|system|local)$)/;
  if (args.slice(1).some(value => forbidden.test(value))) throw new Error('Unsafe option in read-only Git argument vector.');
}
export async function readOnlyGit(run, repository, args, { signal, timeout = 60000, maxBytes = 32 * 1024 * 1024, allowFailure = false } = {}) {
  assertReadOnlyGitArgs(args); signal?.throwIfAborted();
  const started = performance.now();
  const argv = ['--no-pager', '--no-optional-locks', '-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-C', repository, ...args];
  return new Promise((done, reject) => {
    const child = spawn(run.gitBinary, argv, { env: { ...run.env, GIT_LITERAL_PATHSPECS: '1' }, cwd: PROJECT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let stderrBytes = 0; let limitExceeded = false; let spawnFailure = false;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { limitExceeded = true; child.kill(); } else chunks.push(chunk); });
    // Never retain or report Git stderr: it can contain paths, credentials or file contents.
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { limitExceeded = true; child.kill(); }, timeout);
    child.once('error', () => { spawnFailure = true; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) { reject(signal.reason); return; }
      if (spawnFailure || limitExceeded || (code !== 0 && !allowFailure)) {
        const error = new BlockedError(`Read-only Git ${args[0]} ${spawnFailure ? 'could not start' : limitExceeded ? 'exceeded its time/output bound' : `exited ${code}`}. No stderr or repository contents were archived; safe.directory is never bypassed.`);
        error.code = 'READONLY_GIT_BLOCKED'; reject(error); return;
      }
      done({ stdout: Buffer.concat(chunks), code, stderrBytes, durationMs: performance.now() - started });
    });
  });
}
const splitNul = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
export function statusPaths(bytes) {
  const paths = []; const fields = splitNul(bytes);
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]; let path;
    if (entry.startsWith('1 ')) path = entry.split(' ').slice(8).join(' ');
    else if (entry.startsWith('2 ')) { path = entry.split(' ').slice(9).join(' '); index++; }
    else if (entry.startsWith('u ')) path = entry.split(' ').slice(10).join(' ');
    else if (entry.startsWith('? ')) path = entry.slice(2);
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}
export function safeWorktreePath(repository, path) {
  if (!path || path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.' || !part) || path.includes(':') || isAbsolute(path)) throw new BlockedError('A sampled Git path could not be read safely.');
  const full = resolve(repository, path);
  if (!inside(repository, full) || path.split('/')[0].toLowerCase() === '.git') throw new BlockedError('A sampled path escaped the working tree.');
  return full;
}
async function fileDigest(file, { maxFullBytes = 8 * 1024 * 1024 } = {}) {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return { state: 'missing' }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'not-regular', bytes: stat.size };
  const handle = await open(file, 'r');
  try {
    const hash = createHash('sha256');
    if (stat.size <= maxFullBytes) {
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      return { state: 'regular', bytes: stat.size, sha256: hash.digest('hex'), coverage: 'full' };
    }
    for (const position of [0, Math.max(0, stat.size - 65536)]) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); hash.update(buffer.subarray(0, bytesRead));
    }
    return { state: 'regular', bytes: stat.size, sha256: hash.digest('hex'), coverage: 'first-and-last-64KiB' };
  } finally { await handle.close(); }
}
export async function repositoryDigest(run, repository, plan, signal) {
  const read = async args => (await readOnlyGit(run, repository, args, { signal })).stdout;
  const head = await read(['rev-parse', '--verify', 'HEAD']);
  const gitDir = (await read(['rev-parse', '--absolute-git-dir'])).toString('utf8').trim();
  const indexPath = (await read(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).toString('utf8').trim();
  const status = await read(['status', '--porcelain=v2', '--branch', '--no-renames', '--untracked-files=all', '-z']);
  const refs = await read(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)']);
  const tracked = await read(['ls-files', '--cached', '-z']);
  const config = await read(['config', '--null', '--show-origin', '--show-scope', '--list']);
  if (!plan) {
    const dirty = statusPaths(status).slice(0, 32); const known = splitNul(tracked).slice(0, 32);
    plan = [...new Set([...dirty, ...known])].map((path, index) => ({ path, index, category: dirty.includes(path) ? 'dirty' : 'tracked' }));
  }
  const worktree = [];
  for (const item of plan) {
    signal?.throwIfAborted(); const full = safeWorktreePath(repository, item.path);
    // Refuse intermediate symlinks/junctions rather than hashing files outside the repo.
    try { const actual = await realpath(full); if (!inside(await realpath(repository), actual)) throw new BlockedError('A sampled file resolves outside the measured repository.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    worktree.push({ fileIndex: item.index, category: item.category, ...(await fileDigest(full)) });
  }
  return { plan, digest: {
    capturedAt: new Date().toISOString(), headSha256: sha256(head), headFile: await fileDigest(join(gitDir, 'HEAD')), index: await fileDigest(indexPath, { maxFullBytes: 64 * 1024 * 1024 }),
    statusNulSha256: sha256(status), refsSha256: sha256(refs), trackedListSha256: sha256(tracked), effectiveConfigSha256: sha256(config),
    trackedCount: splitNul(tracked).length, sampledFileCount: plan.length, sampledPathPlanSha256: sha256(JSON.stringify(plan.map(item => item.path))), worktree,
    coverage: 'HEAD/index/status-v2-NUL/refs/config digests; at most32 dirty plus32 known tracked worktree files, no unbounded filesystem walk; large worktree files sampled explicitly.',
  } };
}
export function compareRepositoryDigests(before, after) {
  const keys = ['headSha256', 'headFile', 'index', 'statusNulSha256', 'refsSha256', 'trackedListSha256', 'effectiveConfigSha256', 'worktree', 'sampledPathPlanSha256'];
  const changed = keys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return { status: changed.length ? 'changed-unattributed' : 'unchanged-within-stated-coverage', changed, externalConcurrency: changed.length ? 'Changes may be external/concurrent; attribution is not established. Results are blocked, not restored or silently accepted.' : 'No changes observed within stated coverage; this is not proof against unsampled concurrent writes.', restored: false };
}
const SAMPLE_PLAN_MAX_BYTES = 128 * 1024;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function invalidSamplePlan() { const error = new BlockedError('Private sample plan is invalid or does not match this repository/sample count. No private field values are reported.'); error.code = 'PRIVATE_SAMPLE_PLAN_INVALID'; return error; }
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function validateSamplePlan(value, repository, count) {
  if (!exactKeys(value, ['schemaVersion', 'repositoryIdentitySha256', 'privacy', 'samples']) || value.schemaVersion !== 1 || value.repositoryIdentitySha256 !== sha256(repository) || value.privacy !== 'private-local-only-do-not-export' || !Array.isArray(value.samples) || value.samples.length !== count || !Number.isInteger(count) || count < 3 || count > 50) throw invalidSamplePlan();
  const seen = new Set();
  const samples = value.samples.map((sample, index) => {
    if (!exactKeys(sample, ['oid', 'parents', 'files', 'commitIndex', 'parentPolicy']) || typeof sample.oid !== 'string' || !FULL_OID.test(sample.oid) || seen.has(sample.oid) || sample.commitIndex !== index || sample.parentPolicy !== 'nonmerge-default-parent' || !Array.isArray(sample.parents) || sample.parents.length > 1 || sample.parents.some(parent => typeof parent !== 'string' || !FULL_OID.test(parent) || parent === sample.oid || parent.length !== sample.oid.length) || !Array.isArray(sample.files) || sample.files.length < 1 || sample.files.length > 6 || new Set(sample.files).size !== sample.files.length) throw invalidSamplePlan();
    seen.add(sample.oid);
    for (const path of sample.files) {
      if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > 4096) throw invalidSamplePlan();
      try { safeWorktreePath(repository, path); } catch { throw invalidSamplePlan(); }
    }
    return { oid: sample.oid, parents: [...sample.parents], files: [...sample.files], commitIndex: index, parentPolicy: 'nonmerge-default-parent' };
  });
  return { schemaVersion: 1, repositoryIdentitySha256: value.repositoryIdentitySha256, privacy: 'private-local-only-do-not-export', samples };
}
export function parseCommitParents(bytes, expected) {
  const text = bytes.toString('ascii'); const parents = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\0');
    if (fields.length !== 2 || !FULL_OID.test(fields[0]) || parents.has(fields[0])) throw invalidSamplePlan();
    const values = fields[1] ? fields[1].split(' ') : [];
    if (values.length > 1 || values.some(parent => !FULL_OID.test(parent) || parent.length !== fields[0].length)) throw invalidSamplePlan();
    parents.set(fields[0], values);
  }
  if (parents.size !== expected.length || expected.some(oid => !parents.has(oid))) throw invalidSamplePlan();
  return parents;
}
const textChangeFiles = bytes => splitNul(bytes).map(entry => { const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(entry); return match ? match[3] : null; }).filter(Boolean);
const diffTreeArgs = oid => ['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', '-z', oid];
export async function verifySamplePlan(run, repository, plan, signal) {
  const expected = plan.samples.map(sample => sample.oid);
  // --no-walk confirms exact immutable commit objects and parents, never a
  // moving branch tip; full OID syntax prevents revision/option injection.
  const result = await readOnlyGit(run, repository, ['log', '--no-walk=unsorted', '--format=%H%x00%P', ...expected, '--'], { signal, maxBytes: 32 * 1024 });
  const parents = parseCommitParents(result.stdout, expected);
  for (const sample of plan.samples) {
    if (JSON.stringify(parents.get(sample.oid)) !== JSON.stringify(sample.parents)) throw invalidSamplePlan();
    const changed = await readOnlyGit(run, repository, diffTreeArgs(sample.oid), { signal });
    const files = new Set(textChangeFiles(changed.stdout));
    if (sample.files.some(path => !files.has(path))) throw invalidSamplePlan();
  }
  return plan;
}
export async function loadSamplePlan(file, repository, count) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > SAMPLE_PLAN_MAX_BYTES) throw invalidSamplePlan();
    const buffer = Buffer.alloc(SAMPLE_PLAN_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > SAMPLE_PLAN_MAX_BYTES) throw invalidSamplePlan();
    let value; try { value = JSON.parse(buffer.subarray(0, size).toString('utf8')); } catch { throw invalidSamplePlan(); }
    return validateSamplePlan(value, repository, count);
  } finally { await handle.close(); }
}
export async function writeSamplePlan(run, plan) {
  const file = join(run.output, 'sample-plan.private.json');
  if (!inside(run.output, file) || run.manifest.session !== null || run.manifest.status !== 'running') throw invalidSamplePlan();
  const contents = `${JSON.stringify(plan, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > SAMPLE_PLAN_MAX_BYTES) throw invalidSamplePlan();
  await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
  return { sha256: sha256(contents), count: plan.samples.length };
}
export async function chooseCommitSamples(run, repository, count, signal) {
  const { stdout } = await readOnlyGit(run, repository, ['log', '--branches', '--remotes', '--tags', '--date-order', '--no-merges', '--max-count=300', '--format=%H%x00%P'], { signal });
  const candidates = stdout.toString('ascii').trim().split(/\r?\n/).filter(Boolean).map(line => { const [oid, parentText] = line.split('\0'); return { oid, parents: parentText ? parentText.split(' ') : [] }; }).filter(sample => FULL_OID.test(sample.oid) && sample.parents.length <= 1 && sample.parents.every(parent => FULL_OID.test(parent)));
  const selected = [];
  for (const candidate of candidates) {
    const result = await readOnlyGit(run, repository, diffTreeArgs(candidate.oid), { signal });
    const files = textChangeFiles(result.stdout);
    if (files.length) selected.push({ ...candidate, files: files.slice(0, 6), commitIndex: selected.length, parentPolicy: 'nonmerge-default-parent' });
    if (selected.length === count) break;
  }
  if (selected.length < count) throw new BlockedError(`Only ${selected.length} suitable distinct nonmerge/text-change commits found in the bounded300-candidate selection; ${count} requested. No fixture fallback is permitted.`);
  return selected;
}

class PrivateWebDriver extends WebDriver {
  async call(method, path, body, timeout) {
    try { return await super.call(method, path, body, timeout); }
    catch (error) {
      const text = String(error?.message ?? '');
      const category = ['stale element reference', 'element click intercepted', 'no such element', 'unsupported operation', 'unknown command', 'timeout'].find(value => text.toLowerCase().includes(value)) ?? 'webdriver-command-failed';
      const last = this.commands.at(-1); if (last) last.error = category;
      const safe = new Error(`WebDriver ${method} ${path}: ${category}; private driver response was not retained.`); safe.code = category; throw safe;
    }
  }
}
export function privateOwnedProcesses(run) {
  return new OwnedProcesses(run, { execute: async (script, args) => {
    const result = JSON.parse(powershell(script, args));
    const strip = item => {
      if (Array.isArray(item)) return item.map(strip);
      if (item && typeof item === 'object') {
        delete item.commandLine;
        for (const key of Object.keys(item)) item[key] = strip(item[key]);
      }
      return item;
    };
    return JSON.stringify(strip(result));
  } });
}
export async function startPerformanceDesktop(run, options, owned, signal) {
  if (process.platform !== 'win32') throw new BlockedError('Actual Windows desktop/WebDriver is required.');
  const helper = join(PROJECT, 'scripts/lib/windows-processes.ps1');
  run.manifest.binary = await fingerprint(options.binary);
  const driver = executable(options.driver); const tauri = executable(options['tauri-driver'] ?? 'tauri-driver');
  run.manifest.driver = { ...(await fingerprint(driver)), ...JSON.parse(powershell(helper, ['-Action', 'VerifyDriver', '-Executable', driver])) };
  run.manifest.tauriDriver = await fingerprint(tauri);
  const reservation = await reservePorts(); run.manifest.ports = reservation.ports; await run.save(); await reservation.release();
  const child = spawn(tauri, ['--port', String(reservation.ports.webdriver), '--native-host', '127.0.0.1', '--native-port', String(reservation.ports.native), '--native-driver', driver], { env: run.env, cwd: run.output, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  run.manifest.discardedDriverOutputBytes = { stdout: 0, stderr: 0 };
  child.stdout.on('data', chunk => { run.manifest.discardedDriverOutputBytes.stdout += chunk.length; });
  child.stderr.on('data', chunk => { run.manifest.discardedDriverOutputBytes.stderr += chunk.length; });
  let failed = false; child.once('error', () => { failed = true; });
  if (!child.pid) throw new BlockedError('Run-owned tauri-driver could not start.');
  await owned.add(child.pid);
  const endpoint = `http://127.0.0.1:${reservation.ports.webdriver}`;
  const wd = new PrivateWebDriver(endpoint); run.webDriver = wd;
  await until('owned loopback driver listeners', async () => {
    if (failed || child.exitCode !== null) throw new BlockedError('Run-owned driver exited before becoming ready.');
    await owned.snapshot();
    try { run.manifest.listeners = JSON.parse(powershell(helper, ['-Action', 'VerifyPorts', '-InputFile', owned.file])); return true; }
    catch (error) { if (String(error.message).includes('no listener yet')) return false; throw new BlockedError('Driver listener ownership verification failed.'); }
  }, { timeout: 30000, interval: 200, signal });
  await until('owned WebDriver status', async () => (await wd.call('GET', '/status'))?.ready, { signal });
  const args = [`--profile-dir=${run.profileDirectory}`];
  const result = await wd.call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: run.manifest.binary.path, args, webviewOptions: { userDataFolder: run.manifest.webviewDataDirectory } } } } }, 90000);
  wd.sessionId = result.sessionId; if (!wd.sessionId) throw new BlockedError('The owned driver returned no new session.');
  run.manifest.session = { id: wd.sessionId, endpoint, createdAt: new Date().toISOString(), args };
  const state = await until('frontend profile initialization', () => wd.script('const e=document.querySelector(".app-shell");return e?.dataset.taskState==="idle"&&e.dataset.configDirectory ? {configDirectory:e.dataset.configDirectory} : null;'), { timeout: 60000, signal });
  if (!samePath(state.configDirectory, run.profileDirectory)) throw new BlockedError('Application profile did not match the fresh run-owned profile.');
  await owned.snapshot(); run.manifest.profileVerified = true; await run.save(); return wd;
}

// Installed0.2 has no native instrumentation. This observer only reads DOM,
// listens to trusted browser input and waits for real conditions + double-rAF.
// It never calls a host API, dispatches an event, changes DOM or fakes readiness.
export const INSTALL_OBSERVER = `
if (!window.__QGG_READONLY_PERF_OBSERVER__) {
  let current=null;
  const visible=e=>!!e&&!!e.getClientRects().length;
  const matches=(spec)=>{
    const shell=document.querySelector('.app-shell');
    const noErrors=!document.querySelector('.errorbar:not([hidden]), .inline-error, dialog[open] .form-error:not([hidden])');
    if(!noErrors)return false;
    const detail=document.querySelector('.details-pane:not([hidden])');
    const oid=detail?.querySelector('.detail-summary > .mono')?.textContent?.trim();
    const file=detail?.querySelector('.file-row.selected')?.dataset.path;
    const diff=detail?.querySelector('.diff-container > .diff-view');
    switch(spec.type){
      case 'repository-history':return !!shell?.dataset.repoPath&&document.querySelector('.history-pane')?.getAttribute('aria-busy')==='false'&&!!document.querySelector('.commit-row:not(.working-row)')&&!document.querySelector('.history-overlay:not([hidden]) .loading-state');
      case 'repository':return shell?.dataset.repoPath&&shell.dataset.taskState==='idle'&&Number(shell.dataset.taskSequence)>spec.sequence&&!!document.querySelector('.commit-row:not(.working-row)');
      case 'closed':return shell?.dataset.repoPath==='';
      case 'files':return oid===spec.oid&&!!detail?.querySelector('.file-row')&&!detail?.querySelector('.commit-metadata .loading-state');
      case 'diff':return oid===spec.oid&&(!spec.path||file===spec.path)&&visible(diff)&&!detail?.querySelector('.diff-container .loading-state')&&!!diff?.querySelector(spec.text?'.diff-line':'.diff-line,.empty-state');
      case 'content':return document.querySelector('select[aria-label="Content view"]')?.value===spec.value&&visible(diff)&&!!diff?.querySelector('.diff-line,.empty-state');
      case 'layout':return document.querySelector('.diff-scroll')?.classList.contains('is-split')===(spec.value==='split')&&document.querySelector('button[aria-label="'+(spec.value==='split'?'Side-by-side diff':'Unified diff')+'"]')?.getAttribute('aria-pressed')==='true';
      case 'history':return shell?.dataset.taskState==='idle'&&Number(shell.dataset.taskSequence)>spec.sequence&&(!spec.oid||!!document.querySelector('[id="commit-'+spec.oid+'"]'));
      case 'paging':return shell?.dataset.taskState==='idle'&&Number(shell.dataset.taskSequence)>spec.sequence&&Number(document.querySelector('.history-pane')?.getAttribute('aria-rowcount'))>spec.rowCount;
      case 'filter':return !!document.querySelector('[id="commit-'+spec.oid+'"]')&&[...document.querySelectorAll('.commit-row:not(.working-row)')].every(e=>e.dataset.oid===spec.oid);
      case 'menu':return visible(document.querySelector('[role="menu"]'));
      case 'scroll':return Math.abs((document.querySelector(spec.selector)?.scrollTop??spec.before)-spec.before)>1;
      case 'resize':return Math.abs(window.innerWidth-spec.before)>1;
      default:return false;
    }
  };
  const cancel=()=>{if(current){current.stop();current=null;}};
  const arm=spec=>{
    cancel();
    const state={spec,startedAt:null,inputTrusted:false,endpoints:{},stopped:false};current=state;
    const target=spec.event==='resize'?window:document;
    const tick=()=>{
      if(state.stopped||state.startedAt===null)return;
      for(const endpoint of spec.endpoints){
        if(state.endpoints[endpoint.name])continue;
        if(matches(endpoint)){
          const entry={readyMs:performance.now()-state.startedAt,pending:true};state.endpoints[endpoint.name]=entry;
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            if(state.stopped)return;
            if(matches(endpoint)){entry.paintOpportunityMs=performance.now()-state.startedAt;delete entry.pending;}
            else delete state.endpoints[endpoint.name];
          }));
        }
      }
      if(!spec.endpoints.every(e=>Number.isFinite(state.endpoints[e.name]?.paintOpportunityMs)))state.frame=requestAnimationFrame(tick);
      else state.stop();
    };
    const input=event=>{
      if(!event.isTrusted||state.startedAt!==null)return;
      if(spec.selector&&!(event.target instanceof Element&&event.target.closest(spec.selector)))return;
      if(spec.key&&event.key!==spec.key)return;
      state.startedAt=performance.now();state.inputTrusted=true;state.frame=requestAnimationFrame(tick);
    };
    state.stop=()=>{state.stopped=true;cancelAnimationFrame(state.frame);target.removeEventListener(spec.event,input,true);};
    target.addEventListener(spec.event,input,true);
  };
  Object.defineProperty(window,'__QGG_READONLY_PERF_OBSERVER__',{value:Object.freeze({arm,read:()=>current?{started:current.startedAt!==null,inputTrusted:current.inputTrusted,endpoints:JSON.parse(JSON.stringify(current.endpoints))}:null,cancel}),configurable:false,writable:false});
}
return true;`;
const NATIVE_KINDS = new Set(['openRepository', 'history', 'refresh', 'commitSelection', 'details', 'fileSelection', 'diffMode', 'ipc', 'cancel']);
export function sanitizeSpan(span) {
  const safe = {};
  for (const key of ['id', 'operationId', 'parentOperationId', 'rootOperationId']) if (typeof span?.[key] === 'number' || (typeof span?.[key] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(span[key]))) safe[key] = span[key];
  if (NATIVE_KINDS.has(span?.kind)) safe.kind = span.kind;
  if (typeof span?.phase === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,64}$/.test(span.phase)) safe.phase = span.phase;
  for (const key of ['startedAt', 'durationMs', 'elapsedMs', 'count', 'renderedCount', 'sequence']) if (Number.isFinite(span?.[key])) safe[key] = span[key];
  for (const key of ['cacheHit', 'cancelled', 'cancellationAcknowledged']) if (typeof span?.[key] === 'boolean') safe[key] = span[key];
  if (['ok', 'error', 'cancelled', 'stale', 'reused'].includes(span?.outcome)) safe.outcome = span.outcome;
  return safe;
}
const GIT_VERBS = new Set(['rev-parse', 'status', 'log', 'diff', 'diff-tree', 'show', 'cat-file', 'for-each-ref', 'config', 'ls-files', 'ls-tree', 'stash', 'remote', 'rev-list', 'check-mailmap', 'symbolic-ref']);
function sanitizeNativeSpan(span) {
  const safe = {};
  for (const key of ['id', 'sequence', 'startedAt', 'durationMs', 'elapsedMs', 'stdoutBytes', 'stderrBytes', 'status']) if (Number.isFinite(span?.[key])) safe[key] = span[key];
  if (typeof span?.phase === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,64}$/.test(span.phase)) safe.phase = span.phase;
  if (GIT_VERBS.has(span?.verb)) safe.verb = span.verb;
  if (['ok', 'error', 'cancelled', 'stale', 'reused'].includes(span?.outcome)) safe.outcome = span.outcome;
  return safe;
}
export function newNativeOperation(before, after, kind, oid) {
  if (!after?.enabled || after.schemaVersion !== 1 || !Array.isArray(after.spans) || !Array.isArray(after.active)) return null;
  const roots = after.spans.filter(span => span.sequence > (before?.sequence ?? 0) && span.kind === kind && span.phase === 'operation' && (!oid || !span.oid || span.oid === oid) && ['ok', 'reused'].includes(span.outcome ?? 'ok'));
  for (const root of [...roots].reverse()) {
    const related = after.spans.filter(span => span.rootOperationId === root.operationId || span.operationId === root.operationId || span.parentOperationId === root.operationId);
    const paint = related.find(span => span.operationId === root.operationId && span.kind === kind && span.phase === 'paint-opportunity');
    if (paint && !after.active.some(span => span.rootOperationId === root.operationId || span.operationId === root.operationId || span.parentOperationId === root.operationId)) {
      const requests = new Set(related.map(span => span.requestId).filter(Boolean));
      const native = after.native?.schemaVersion === 1 && after.native?.enabled ? {
        sequence: after.native.sequence, dropped: after.native.dropped,
        spans: after.native.spans.filter(span => requests.has(span.requestId)).map(sanitizeNativeSpan),
        activeCount: after.native.active.filter(span => requests.has(span.requestId)).length,
      } : null;
      return { root: sanitizeSpan(root), spans: related.map(sanitizeSpan), native, sequenceBefore: before?.sequence ?? 0, sequenceAfter: after.sequence, dropped: after.dropped };
    }
  }
  return null;
}
export function summarizeSamples(samples) {
  const groups = {};
  for (const sample of samples.filter(item => item.status === 'measured')) {
    for (const [metric, value] of Object.entries(sample.timings ?? {})) {
      if (!Number.isFinite(value)) continue;
      const key = `${sample.scenario}.${metric}`; (groups[key] ??= []).push(value);
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, { count: values.length, minMs: Math.min(...values), medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) }]));
}
export function safeFailure(error) {
  const result = { name: error instanceof BlockedError ? 'BlockedError' : 'Error', code: /^[A-Za-z0-9_-]{1,64}$/.test(error?.code ?? '') ? error.code : 'PERFORMANCE_RUN_FAILED', message: 'The operation failed or a prerequisite/condition was not met. Private response/error payloads are intentionally omitted.' };
  const publicConditionLabels = new Set(['actual history/metadata task completion', 'trusted input and actual DOM paint opportunity', 'details actually closed', 'repository menu visible', 'repository closed', 'repository path form', 'unfiltered rows visible', 'actual selected candidate row', 'real commit detail and first diff', 'search query fully settled', 'actual menu closed', 'starting rapid selection detail settled']);
  if (publicConditionLabels.has(error?.conditionLabel)) result.conditionLabel = error.conditionLabel;
  return result;
}
