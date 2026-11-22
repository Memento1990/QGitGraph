import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorInfo = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack });
export const slash = value => value.replaceAll('\\', '/');
export const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && normalizePath(a) === normalizePath(b);
const normalizePath = value => {
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
export function inside(parent, child) {
  const part = relative(resolve(parent), resolve(child));
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export function parseArgs(argv, { values = [], flags = [] } = {}) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--') || Object.hasOwn(result, key.slice(2))) throw new Error(`Unexpected or repeated argument: ${key}`);
    if (flags.includes(key.slice(2))) result[key.slice(2)] = true;
    else if (values.includes(key.slice(2))) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      result[key.slice(2)] = argv[++i];
    } else throw new Error(`Unsupported argument: ${key}`);
  }
  return result;
}
export function required(options, keys) {
  for (const key of keys) if (!options[key]) throw new Error(`Required argument: --${key}`);
  return options;
}
export function isMain(url) { return !!process.argv[1] && samePath(fileURLToPath(url), process.argv[1]); }
const jsonWriteQueues = new Map();
const jsonRenameRetryDelays = [25, 50, 100, 200, 250, 250, 250, 250, 250, 250, 250];
export async function renameJsonFile(temporary, file, { platform = process.platform, renameFile = rename, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(temporary, file); return; }
    catch (error) {
      // Windows readers can briefly hold a handle without delete sharing. Retry
      // only that replacement, in the same file queue, for at most 12 attempts
      // and 2,125ms of backoff. Never delete the current ownership file.
      if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= jsonRenameRetryDelays.length) throw error;
      await wait(jsonRenameRetryDelays[attempt]);
    }
  }
}
export async function json(file, value) {
  file = resolve(file);
  const key = normalizePath(file);
  // Capture this writer's complete state at enqueue time, not a mutable object
  // after other async operations have updated it.
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const previous = jsonWriteQueues.get(key) ?? Promise.resolve();
  const operation = previous.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx' });
    // A failed replacement leaves the old file and the new temporary evidence
    // intact. The original rejection is returned to this writer.
    await renameJsonFile(temporary, file);
  });
  // Keep the queue usable for finally/cleanup after a failed caller. This tail
  // only sequences work; it does not replace the rejecting operation returned.
  const tail = operation.then(() => undefined, () => undefined);
  jsonWriteQueues.set(key, tail);
  void tail.then(() => { if (jsonWriteQueues.get(key) === tail) jsonWriteQueues.delete(key); });
  await operation;
}
export async function readJson(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
export async function regularFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular, non-link file: ${file}`);
  return stat;
}
export async function fingerprint(file) {
  await regularFile(file);
  const bytes = await readFile(file);
  return { path: resolve(file), bytes: bytes.length, sha256: sha256(bytes) };
}
export async function claimEmptyDirectory(directory) {
  directory = resolve(directory);
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(directory)).length !== 0) throw new Error('Each run requires a new, empty, non-link output directory. Never reuse a run.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
  }
  // An exclusive marker also prevents two runners from claiming the same empty directory.
  await writeFile(join(directory, '.qgitgraph-run'), `${randomUUID()}\n`, { flag: 'wx' });
  if (!samePath(await realpath(directory), directory)) throw new Error('The run directory must not be redirected through a link.');
  return directory;
}
export function executable(value, fallback) {
  const candidate = value ?? fallback;
  if (!candidate) throw new Error('An executable path is required.');
  if (isAbsolute(candidate) || /[\\/]/.test(candidate)) {
    const full = resolve(candidate);
    if (!existsSync(full)) throw new Error(`Executable not found: ${full}`);
    return full;
  }
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';')] : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const full = resolve(directory.replace(/^"|"$/g, ''), `${candidate}${extension}`);
      if (existsSync(full)) return full;
    }
  }
  throw new Error(`Executable not found on PATH: ${candidate}`);
}
export function gitExecutable(value) {
  if (value) return executable(value);
  for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, 'C:/Program Files']) {
    const full = base && join(base, 'Git/cmd/git.exe');
    if (full && existsSync(full)) return full;
  }
  return executable('git');
}
export function isolatedEnvironment(paths, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|GCM_|SSH_|WEBVIEW2_|EDGE_)/i.test(key) || /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|APPDATA|LOCALAPPDATA)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: paths.homeDirectory, USERPROFILE: paths.homeDirectory,
    APPDATA: join(paths.homeDirectory, 'AppData/Roaming'), LOCALAPPDATA: join(paths.homeDirectory, 'AppData/Local'),
    TEMP: join(paths.homeDirectory, 'tmp'), TMP: join(paths.homeDirectory, 'tmp'),
    XDG_CONFIG_HOME: paths.xdgConfigDirectory, XDG_CACHE_HOME: join(paths.homeDirectory, '.cache'), XDG_DATA_HOME: join(paths.homeDirectory, '.local/share'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: paths.systemConfig, GIT_CONFIG_GLOBAL: paths.globalConfig,
    GIT_TEMPLATE_DIR: paths.templateDirectory, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: '', GIT_EDITOR: '', GIT_SEQUENCE_EDITOR: '',
    // Only fixture creation opts into the local file transport, command-by-command.
    GIT_ALLOW_PROTOCOL: 'file',
  });
  return env;
}
export async function createRun(directory, kind) {
  const output = await claimEmptyDirectory(directory);
  const runId = randomUUID();
  const profileDirectory = join(output, 'profile');
  const git = {
    homeDirectory: join(output, 'home'), xdgConfigDirectory: join(output, 'home/.config'),
    globalConfig: join(output, 'home/.gitconfig'), systemConfig: join(output, 'home/system.gitconfig'),
    templateDirectory: join(output, 'home/git-template'), hooksDirectory: join(output, 'home/no-hooks'),
  };
  const webviewDataDirectory = join(profileDirectory, 'webview2');
  for (const directory of [profileDirectory, webviewDataDirectory, git.homeDirectory, git.xdgConfigDirectory, git.templateDirectory, git.hooksDirectory, join(git.homeDirectory, 'AppData/Roaming'), join(git.homeDirectory, 'AppData/Local'), join(git.homeDirectory, 'tmp'), ...['Desktop','Documents','Downloads','Music','Pictures','Videos'].map(name=>join(git.homeDirectory,name)), join(output, 'evidence')]) await mkdir(directory, { recursive: true });
  await writeFile(git.globalConfig, '[credential]\n\thelper =\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n', { flag: 'wx' });
  await writeFile(git.systemConfig, '', { flag: 'wx' });
  const manifest = {
    schemaVersion: 1, kind, runId, startedAt: new Date().toISOString(), status: 'running',
    outputDirectory: output, profileDirectory, webviewDataDirectory, git,
    refs: { branch: `qgitgraph-test/${runId}`, annotatedTag: `qgitgraph-test-${runId}-annotated`, lightweightTag: `qgitgraph-test-${runId}-lightweight` },
    ports: null, session: null, processes: [], evidence: [], results: [], cleanup: null,
  };
  const testManifest = { schemaVersion: 1, runId, profileDirectory, webviewDataDirectory, git };
  await json(join(profileDirectory, 'test-manifest.json'), testManifest);
  await json(join(output, 'run-manifest.json'), manifest);
  return { output, profileDirectory, manifest, env: isolatedEnvironment(git), save: () => json(join(output, 'run-manifest.json'), manifest) };
}
export function git(run, repository, args, { allowFailure = false, env = {}, binary = run.gitBinary } = {}) {
  assert(binary, 'Git executable must be selected explicitly before using a fixture.');
  const result = spawnSync(binary, ['--no-pager', '-C', repository, ...args], {
    env: { ...run.env, ...env }, windowsHide: true, shell: false, encoding: null, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr?.toString('utf8')}`);
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}
export function gitText(run, repository, args, options) { return git(run, repository, args, options).stdout.toString('utf8').trim(); }
export function powershell(script, args = [], { timeout = 90000 } = {}) {
  if (process.platform !== 'win32') throw new Error('This operation requires Windows; no desktop emulation or cross-platform pass is reported.');
  return execFileSync(executable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(script), ...args.map(String)], {
    cwd: PROJECT, windowsHide: true, shell: false, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
  }).replace(/^\uFEFF/, '').trim();
}
export async function signInfo(file) {
  return JSON.parse(powershell(join(PROJECT, 'scripts/lib/windows-processes.ps1'), ['-Action', 'Signature', '-Executable', resolve(file)]));
}
export async function until(label, probe, { timeout = 30000, interval = 125, signal } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    signal?.throwIfAborted();
    last = await probe();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${label} after ${Date.now() - start}ms`);
}
export function assertSameSnapshot(before, after, label = 'repository') {
  for (const key of ['identity', 'head', 'headFile', 'index', 'status', 'tracked', 'untracked', 'refs']) assert.deepEqual(after[key], before[key], `${label}: ${key} changed`);
}
