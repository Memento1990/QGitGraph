import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fingerprint, gitExecutable, inside, json, readJson, samePath, sha256, slash } from './run.mjs';
import { safeRelative } from './release.mjs';

// These are path boundaries, not permission to recursively package a worktree.
// In particular, only the one seed input is public under designs/.
export const BASELINE_SOURCE = 'designs/repository-interactions-vue/FEATURE-COMPARISON.md';
export const SOURCE_ENTRIES = Object.freeze([
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'index.html',
  'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'AGENTS.md', '.gitignore', '.gitattributes', 'src', 'tests', 'scripts', 'docs', 'notices',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json',
  'src-tauri/src', 'src-tauri/tests', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/permissions',
  'tools/taskboard/README.md', 'tools/taskboard/cli.mjs', 'tools/taskboard/core.mjs', 'tools/taskboard/seed.mjs',
  'tools/taskboard/server.mjs', 'tools/taskboard/store.mjs', 'tools/taskboard/启动任务看板.cmd',
  'tools/taskboard/public', 'tools/taskboard/tests', BASELINE_SOURCE,
]);
const sourceDirectories = new Set(['src', 'tests', 'scripts', 'docs', 'notices', 'src-tauri/src', 'src-tauri/tests', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/permissions']);
const taskboardPublic = new Set(['index.html', 'styles.css', 'app.js', 'protocol.js', 'protocol.mjs', 'protocol.json']);
const forbiddenDirectories = new Set(['node_modules', 'target', '.git', 'artifacts', 'release', 'dist', '.zcode', '.local', '.cache', '.env', 'gen', 'backup', 'backups', 'tmp', 'temp', 'logs', 'test-evidence', 'usage', 'userusage', 'screenshots', 'screenshot']);
export const CANDIDATE_MANIFEST = '.qgitgraph-source-candidate.json';
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function isSourcePath(path) {
  return SOURCE_ENTRIES.includes(path) && !sourceDirectories.has(path) && !['tools/taskboard/public', 'tools/taskboard/tests'].includes(path)
    || [...sourceDirectories].some(entry => path.startsWith(`${entry}/`))
    || path.startsWith('tools/taskboard/tests/') && /\.mjs$/.test(path)
    || path.startsWith('tools/taskboard/public/') && taskboardPublic.has(path.slice('tools/taskboard/public/'.length));
}
export function assertPublicSourcePath(path) {
  safeRelative(path);
  assert(!path.split('/').some(part => forbiddenDirectories.has(part.toLowerCase())) && !/(?:^|\/)screenshot[^/]*(?:\/|$)/i.test(path), `Excluded output in public source: ${path}`);
  assert(!/^tools\/taskboard\/data(?:\/|$)/i.test(path), `Private taskboard state in public source: ${path}`);
  assert(!/(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.[^/]*)?|state(?:-unreadable[^/]*)?\.json|sample-plan\.private\.json)$|\.(?:pfx|p12|pem|key|bak|log|jsonl)$/i.test(path), `Private filename in public source: ${path}`);
  assert(isSourcePath(path), `Path outside public source allowlist: ${path}`);
  return path;
}
const sorted = files => files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
const treeHash = files => sha256(JSON.stringify(files));
function validateManifest(manifest) {
  assert.equal(manifest?.schemaVersion, 1, 'Unsupported reviewed source manifest schema.');
  assert.equal(manifest.kind, 'reviewed-source-manifest', 'Expected an explicit reviewed-source-manifest.');
  assert(Array.isArray(manifest.files) && manifest.files.length, 'Reviewed source manifest needs exact files, byte lengths and SHA-256 hashes.');
  const seen = new Set();
  return sorted(manifest.files.map(file => {
    assertPublicSourcePath(file.path);
    assert(!seen.has(file.path.toLowerCase()), `Duplicate/case-colliding source path: ${file.path}`); seen.add(file.path.toLowerCase());
    assert(Number.isInteger(file.bytes) && file.bytes >= 0 && file.bytes <= MAX_SOURCE_BYTES, `Invalid source byte length: ${file.path}`);
    assert(/^[a-f0-9]{64}$/.test(file.sha256), `Invalid reviewed source SHA-256: ${file.path}`);
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  }));
}
async function regularDirectory(directory) {
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && samePath(await realpath(directory), directory), 'Source directory must not be a link.');
}
async function diskBytes(root, path) {
  assertPublicSourcePath(path);
  let full = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    full = join(full, part);
    const stat = await lstat(full);
    assert(!stat.isSymbolicLink(), `Source archive refuses links: ${path}`);
    if (index < parts.length - 1) assert(stat.isDirectory(), `Source parent is not a directory: ${path}`);
    else assert(stat.isFile() && stat.size <= MAX_SOURCE_BYTES, `Unexpectedly large/non-regular source file: ${path}`);
  }
  assert(inside(root, full));
  const bytes = await readFile(full);
  assert(bytes.length <= MAX_SOURCE_BYTES, `Unexpectedly large source file: ${path}`);
  return bytes;
}
function snapshot(contents, source, stagedPaths = []) {
  const files = validateManifest({ schemaVersion: 1, kind: 'reviewed-source-manifest', files: [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) });
  return { files, contents, source: { ...source, treeSha256: treeHash(files) }, stagedPaths };
}
async function reviewedSnapshot(root, reviewedManifest) {
  await regularDirectory(root);
  const manifest = typeof reviewedManifest === 'string' ? await readJson(resolve(reviewedManifest)) : reviewedManifest;
  const files = validateManifest(manifest); const contents = new Map();
  for (const file of files) {
    const bytes = await diskBytes(root, file.path);
    assert.equal(bytes.length, file.bytes, `Reviewed source length changed: ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `Reviewed source SHA-256 changed: ${file.path}`);
    contents.set(file.path, bytes);
  }
  return snapshot(contents, { kind: 'reviewed-manifest', manifestSha256: treeHash(files) });
}
function gitReader(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GCM_)/i.test(key)) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' });
  const binary = gitExecutable();
  return (args, input) => execFileSync(binary, ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env, input, windowsHide: true, shell: false, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function indexSnapshot(root) {
  await regularDirectory(root);
  const git = gitReader(root);
  assert(samePath(git(['rev-parse', '--show-toplevel']).toString('utf8').trim(), root), 'Source root must be the repository top level.');
  const index = git(['ls-files', '--stage', '--full-name', '-z']);
  const stagedPaths = git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv']).toString('utf8').split('\0').filter(Boolean);
  const contents = new Map(); const entries = [];
  for (const record of index.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    assert(match, 'Invalid Git index entry.');
    const [, mode, oid, stage, path] = match;
    if (!isSourcePath(path)) continue;
    assertPublicSourcePath(path);
    assert.equal(stage, '0', `Unmerged public source index entry: ${path}`);
    assert(['100644', '100755'].includes(mode), `Source archive refuses links/gitlinks: ${path}`);
    entries.push({ path, oid });
  }
  if (entries.length) {
    const input = Buffer.from(`${entries.map(file => file.oid).join('\n')}\n`);
    // Two bounded batch reads avoid a subprocess per source file, while checking
    // sizes before reading bodies. Neither cat-file mode consults the worktree.
    const metadata = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], input).toString('utf8').trim().split('\n');
    assert.equal(metadata.length, entries.length, 'Incomplete source blob metadata.');
    let total = 0;
    for (const [index, line] of metadata.entries()) {
      const [oid, type, size] = line.trim().split(' ');
      assert.equal(oid, entries[index].oid, 'Source blob identity changed.'); assert.equal(type, 'blob', 'Public source must be a Git blob.');
      assert(/^\d+$/.test(size) && Number(size) <= MAX_SOURCE_BYTES, `Unexpectedly large source file: ${entries[index].path}`);
      total += Number(size);
    }
    assert(total <= 48 * 1024 * 1024, 'Unexpectedly large public source snapshot.');
    const batch = git(['cat-file', '--batch'], input); let offset = 0;
    for (const { path, oid } of entries) {
      const end = batch.indexOf(10, offset); assert(end >= offset, 'Incomplete source blob header.');
      const header = batch.subarray(offset, end).toString('utf8').split(' ');
      assert.equal(header[0], oid, 'Source blob identity changed.'); assert.equal(header[1], 'blob', 'Public source must be a Git blob.');
      const size = Number(header[2]); assert(Number.isInteger(size) && size >= 0 && size <= MAX_SOURCE_BYTES, 'Invalid source blob size.');
      offset = end + 1; const bytes = Buffer.from(batch.subarray(offset, offset + size)); offset += size;
      assert.equal(bytes.length, size, 'Incomplete source blob body.'); assert.equal(batch[offset++], 10, 'Incomplete source blob delimiter.');
      assert(!contents.has(path), `Duplicate source index path: ${path}`); contents.set(path, bytes);
    }
    assert.equal(offset, batch.length, 'Unexpected source blob batch output.');
  }
  assert(index.equals(git(['ls-files', '--stage', '--full-name', '-z'])), 'Git index changed during source snapshot.');
  return snapshot(contents, { kind: 'git-index', indexSha256: sha256(index) }, stagedPaths);
}
async function assertIsolatedCandidate(root) {
  await regularDirectory(root);
  for (let current = root; ; current = dirname(current)) {
    try { await lstat(join(current, '.git')); assert.fail('Candidate root must be isolated outside a Git worktree.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
async function candidateSnapshot(candidateRoot) {
  const root = resolve(candidateRoot); await assertIsolatedCandidate(root);
  const contents = new Map(); let manifest;
  const visit = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name); const stat = await lstat(full);
      assert(!stat.isSymbolicLink(), `Source archive refuses links: ${path}`);
      if (path === CANDIDATE_MANIFEST) {
        assert(stat.isFile(), 'Candidate manifest must be a regular file.'); manifest = await readJson(full); continue;
      }
      if (stat.isDirectory()) {
        safeRelative(path);
        assert(!path.split('/').some(part => forbiddenDirectories.has(part.toLowerCase())) && !/(?:^|\/)screenshot[^/]*(?:\/|$)/i.test(path), `Excluded output in public source: ${path}`);
        assert(SOURCE_ENTRIES.some(allowed => allowed.startsWith(`${path}/`) || allowed === path || sourceDirectories.has(allowed) && path.startsWith(`${allowed}/`)), `Directory outside public source allowlist: ${path}`);
        await visit(full, path);
      } else contents.set(path, await diskBytes(root, path));
    }
  };
  await visit(root);
  const result = snapshot(contents, { kind: 'isolated-candidate' });
  if (manifest) assert.deepEqual(result.files, validateManifest(manifest), 'Candidate source tree differs from its reviewed manifest.');
  return result;
}

export async function readSourceSnapshot(root, { reviewedManifest, candidateRoot } = {}) {
  assert(!(reviewedManifest && candidateRoot), 'Choose either a reviewed manifest or an isolated candidate root.');
  if (candidateRoot) return candidateSnapshot(candidateRoot);
  root = resolve(root);
  return reviewedManifest ? reviewedSnapshot(root, reviewedManifest) : indexSnapshot(root);
}
export async function sourceFiles(root, options = {}) { return (await readSourceSnapshot(root, options)).files; }

// Output must not contaminate public sources or a sealed candidate. Reports in
// the repository may only go to the existing private artifact/release boundaries.
export function assertSourceOutput(root, output, candidateRoot) {
  const target = resolve(output); root = resolve(root);
  assert(!samePath(root, target) && !inside(target, root), 'Output must be separate from source inputs.');
  if (inside(root, target)) assert(/^(?:artifacts|release)\//.test(slash(relative(root, target))), 'Output must not be inside public source.');
  if (candidateRoot) assert(!samePath(candidateRoot, target) && !inside(candidateRoot, target) && !inside(target, candidateRoot), 'Output must be separate from the candidate source tree.');
  return target;
}
export async function assertSourceOutputParents(output) {
  for (let current = dirname(resolve(output)); ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Output parent must be a non-link directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
export async function materializeSourceCandidate(root, output, captured) {
  root = resolve(root); output = resolve(output);
  assert(!samePath(root, output) && !inside(root, output) && !inside(output, root), 'Candidate output must be isolated from the source worktree.');
  await assertSourceOutputParents(output);
  // Check existing ancestors before creating anything, including redirected paths.
  let parent = dirname(output);
  while (true) {
    try { await assertIsolatedCandidate(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  await mkdir(dirname(output), { recursive: true }); await mkdir(output); // EEXIST is intentional, even for an empty directory.
  for (const file of captured.files) {
    assertPublicSourcePath(file.path);
    const bytes = captured.contents.get(file.path);
    assert(bytes && bytes.length === file.bytes && sha256(bytes) === file.sha256, `Source snapshot changed: ${file.path}`);
    const target = join(output, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
  }
  await writeFile(join(output, CANDIDATE_MANIFEST), JSON.stringify({ schemaVersion: 1, kind: 'reviewed-source-manifest', files: captured.files }, null, 2), { flag: 'wx' });
  const actual = await candidateSnapshot(output);
  assert.deepEqual(actual.files, captured.files, 'Candidate source tree differs from the captured source.');
  return actual;
}
export async function archiveFileList(root, output, options = {}) {
  root = resolve(root);
  let candidateRoot = options.candidateRoot;
  if (!candidateRoot && !options.reviewedManifest) {
    try { await lstat(join(root, CANDIDATE_MANIFEST)); candidateRoot = root; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assertSourceOutput(root, output, candidateRoot);
  await assertSourceOutputParents(output);
  const source = candidateRoot ? resolve(candidateRoot) : root;
  const captured = await readSourceSnapshot(root, { ...options, candidateRoot });
  if (candidateRoot) assert(samePath(source, root), 'Archive candidateRoot must match the source root used by disk-copy callers.');
  // Existing PowerShell copy callers read files from disk. Refuse rather than
  // silently substituting dirty worktree bytes for the captured Git blobs.
  for (const file of captured.files) {
    const bytes = await diskBytes(source, file.path);
    assert.equal(sha256(bytes), file.sha256, `Archive disk source differs from captured source: ${file.path}`);
  }
  await json(output, { schemaVersion: 1, kind: 'source-archive-list', entries: SOURCE_ENTRIES, source: captured.source, files: captured.files });
  return captured.files;
}
export async function assertZipInventory(archive, report, prefix = '') {
  const actual = await readJson(report);
  const file = await fingerprint(archive);
  assert.equal(actual.sha256, file.sha256, 'Archive inspection hash mismatch.');
  for (const entry of actual.files ?? []) {
    if (prefix) assert(entry.path.startsWith(`${prefix}/`), 'Archive entry is outside the source prefix.');
    assertPublicSourcePath(prefix ? entry.path.slice(prefix.length + 1) : entry.path);
  }
  return actual;
}
