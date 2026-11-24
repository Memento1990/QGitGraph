import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditPath, auditPublicSource, auditText, parseAuditArgs } from '../audit-public-source.mjs';
import { BASELINE_SOURCE, CANDIDATE_MANIFEST, archiveFileList, assertZipInventory, readSourceSnapshot, sourceFiles } from './source-archive.mjs';
import { gitExecutable, isolatedEnvironment, sha256 } from './run.mjs';

const entry = (path, text) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256(text) });
const manifest = files => ({ schemaVersion: 1, kind: 'reviewed-source-manifest', files });
async function put(root, path, bytes) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
async function temporary(work) {
  const directory = await mkdtemp(join(tmpdir(), 'qgitgraph-source-audit-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function repository(directory, files = { 'src/old.ts': 'export const unchanged = true;\n' }) {
  const root = join(directory, 'repository'); const home = join(directory, 'home'); await mkdir(root); await mkdir(home);
  const env = isolatedEnvironment({ homeDirectory: home, xdgConfigDirectory: join(home, '.config'), globalConfig: join(home, 'global'), systemConfig: join(home, 'system'), templateDirectory: join(home, 'templates') });
  const binary = gitExecutable();
  const git = (...args) => execFileSync(binary, ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Source Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  for (const [path, text] of Object.entries(files)) await put(root, path, text);
  git('add', '--all'); git('commit', '--quiet', '-m', 'fixture baseline');
  return { root, git };
}
const indexBytes = root => readFile(join(root, '.git/index'));

test('public audit retains Vue, taskboard sources and one baseline but excludes generated/private output', () => {
  for (const path of ['LICENSE', 'AGENTS.md', 'src/App.vue', 'src/components/Nested.vue', 'src/ui/updates.ts', 'notices/sources/example-1.0.0.crate', 'src-tauri/permissions/app.toml', 'tools/taskboard/core.mjs', 'tools/taskboard/public/app.js', 'tools/taskboard/tests/store.test.mjs', BASELINE_SOURCE]) assert.doesNotThrow(() => auditPath(path));
  for (const path of ['artifacts/run/state.json', 'release/old.zip', 'src-tauri/target/release/app.exe', 'src-tauri/gen/schemas.json', 'docs/backup/private.md', 'scripts/tmp/input.json', '.env', 'secrets/id_ed25519', 'certificate.pfx', 'sample-plan.private.json', 'tools/taskboard/.local/usage/session.jsonl', 'tools/taskboard/data/board.json', 'tools/taskboard/usage/events.json', 'tools/taskboard/public/board.json', 'tools/private.mjs', 'src/session.log', 'src/session.jsonl', 'src/state-unreadable-copy.json', 'src/screenshots/desktop.png', 'designs/repository-interactions-vue/src/App.vue', 'designs/repository-interactions-vue/previous-v1/index.html', 'designs/repository-interactions-vue/screenshot.png', 'designs/repository-interactions-vue/README.md']) assert.throws(() => auditPath(path), undefined, path);
});

test('public audit detects private paths and credentials without reproducing values in reports', () => {
  const privateHome = ['C:', 'Users', 'sensitive-user', 'profile.json'].join('/');
  const wsl = ['\\\\wsl.localhost', 'Ubuntu', 'home', 'sensitive-user', 'repository'].join('\\');
  assert(auditText(privateHome).includes('personal-profile-path'));
  assert(auditText(wsl).includes('private-wsl-home'));
  assert(auditText(['-----BEGIN ', 'PRIVATE KEY-----'].join('')).includes('private-key'));
  assert(auditText(['ghp_', 'x'.repeat(36)].join('')).includes('github-token'));
  assert(auditText(['AKIA', 'X'.repeat(16)].join('')).includes('cloud-access-key'));
  for (const text of ['https://github.com/Memento1990/QGitGraph/releases/latest', 'C:/Users/example/profile.json', '\\\\wsl.localhost\\<distribution>\\home\\<user>\\<repository>', 'MIT License']) assert.deepEqual(auditText(text), []);
});

test('default staged audit reads the entire index snapshot including unchanged tracked and staged added Vue', () => temporary(async directory => {
  const { root, git } = await repository(directory);
  await put(root, 'src/App.vue', '<template><main>reviewed Vue</main></template>\n'); git('add', '--', 'src/App.vue');
  const before = await indexBytes(root);
  const report = await auditPublicSource({ root });
  assert.equal(report.staged, true); assert.equal(report.source.kind, 'git-index');
  assert.deepEqual(report.files.map(file => file.path), ['src/App.vue', 'src/old.ts']);
  assert.equal(report.files.find(file => file.path === 'src/App.vue').sha256, sha256('<template><main>reviewed Vue</main></template>\n'));
  assert.deepEqual(await indexBytes(root), before);
  git('commit', '--quiet', '-m', 'fixture reviewed Vue');
  assert.equal((await auditPublicSource({ root, staged: true })).fileCount, 2, 'An empty cached diff must still audit existing index sources.');
}));

test('dirty worktree and unreviewed untracked bytes never replace index bytes or enter a source snapshot', () => temporary(async directory => {
  const original = 'export const unchanged = true;\n'; const { root } = await repository(directory);
  const secret = ['ghp_', 'x'.repeat(36)].join('');
  await put(root, 'src/old.ts', secret); await put(root, 'src/unreviewed.vue', secret);
  await put(root, 'tools/taskboard/.local/usage/events.jsonl', secret); await put(root, 'tools/taskboard/data/board.json', secret);
  const before = await indexBytes(root); const report = await auditPublicSource({ root, staged: true });
  assert.deepEqual(report.files, [entry('src/old.ts', original)]);
  assert.deepEqual(await sourceFiles(root), report.files);
  await assert.rejects(archiveFileList(root, join(directory, 'dirty-list.json')), /disk source differs/);
  assert.deepEqual(await indexBytes(root), before);
}));

test('staged and unchanged committed secrets are rejected even if the worktree is sanitized', () => temporary(async directory => {
  const secret = ['github_pat_', 'x'.repeat(48)].join(''); const { root, git } = await repository(directory);
  await put(root, 'src/App.vue', `<template>${secret}</template>`); git('add', '--', 'src/App.vue');
  await put(root, 'src/App.vue', '<template>safe working copy</template>');
  const before = await indexBytes(root);
  await assert.rejects(auditPublicSource({ root }), error => /github-token/.test(error.message) && !error.message.includes(secret));
  assert.deepEqual(await indexBytes(root), before);
  git('commit', '--quiet', '-m', 'fixture sensitive index');
  await assert.rejects(auditPublicSource({ root }), /github-token/);
}));

test('staged private/output/out-of-allowlist increments are refused, including deletion paths', () => temporary(async directory => {
  const { root, git } = await repository(directory);
  for (const path of ['tools/taskboard/data/board.json', 'tools/taskboard/.local/usage/raw.jsonl', 'docs/screenshot.png', 'designs/history.png', 'private-artifacts/data.txt']) {
    await put(root, path, 'fixture'); git('add', '--force', '--', path);
    const before = await indexBytes(root);
    await assert.rejects(auditPublicSource({ root }), /public source|allowlist/);
    assert.deepEqual(await indexBytes(root), before);
    git('reset', '--quiet', 'HEAD', '--', path);
  }
  await put(root, 'outside.txt', 'fixture'); git('add', '--', 'outside.txt'); git('commit', '--quiet', '-m', 'fixture outside');
  git('rm', '--quiet', '--', 'outside.txt'); await assert.rejects(auditPublicSource({ root }), /allowlist/);
}));

test('tracked denied outputs cannot hide in an unchanged allowlisted source subtree', () => temporary(async directory => {
  const { root } = await repository(directory, { 'src/old.ts': 'safe', 'scripts/logs/raw.txt': 'private fixture' });
  await assert.rejects(auditPublicSource({ root }), /Excluded output/);
}));

test('reviewed manifests select only hash-pinned files, including explicitly reviewed untracked sources', () => temporary(async directory => {
  const { root } = await repository(directory); const vue = '<template>reviewed untracked</template>';
  await put(root, 'src/App.vue', vue); await put(root, 'src/unreviewed.ts', ['ghp_', 'x'.repeat(36)].join(''));
  const reviewedManifest = manifest([entry('src/App.vue', vue)]); const before = await indexBytes(root);
  assert.deepEqual((await auditPublicSource({ root, reviewedManifest })).files, reviewedManifest.files);
  const file = join(directory, 'reviewed.json'); await writeFile(file, JSON.stringify(reviewedManifest));
  assert.deepEqual((await auditPublicSource({ root, reviewedManifest: file })).files, reviewedManifest.files);
  await assert.rejects(auditPublicSource({ root, staged: false }), /explicit reviewed manifest/);
  await assert.rejects(auditPublicSource({ root, staged: true, reviewedManifest }), /actual Git index/);
  await assert.rejects(auditPublicSource({ root, reviewedManifest: { files: ['src/App.vue'] } }), /manifest schema/);
  await assert.rejects(auditPublicSource({ root, reviewedManifest: manifest([...reviewedManifest.files, ...reviewedManifest.files]) }), /Duplicate/);
  await put(root, 'src/App.vue', `${vue} changed`);
  await assert.rejects(auditPublicSource({ root, reviewedManifest }), /length changed|SHA-256 changed/);
  assert.deepEqual(await indexBytes(root), before);
}));

test('reviewed manifests cannot exempt baseline documents, Vue secrets, private filenames or private paths', () => temporary(async directory => {
  const { root } = await repository(directory);
  for (const [path, text, code] of [
    ['src/App.vue', ['-----BEGIN ', 'PRIVATE KEY-----'].join(''), 'private-key'],
    [BASELINE_SOURCE, ['C:', 'Users', 'sensitive-user', 'profile.json'].join('/'), 'personal-profile-path'],
    ['tools/taskboard/README.md', ['\\\\wsl.localhost', 'Ubuntu', 'home', 'sensitive-user', 'repo'].join('\\'), 'private-wsl-home'],
  ]) {
    await put(root, path, text);
    await assert.rejects(auditPublicSource({ root, reviewedManifest: manifest([entry(path, text)]) }), error => error.message.includes(code) && !error.message.includes(text));
  }
  for (const path of ['tools/taskboard/data/board.json', 'tools/taskboard/.local/usage/raw.jsonl', 'src/secret.key', 'designs/history.md']) {
    await put(root, path, 'fixture');
    await assert.rejects(auditPublicSource({ root, reviewedManifest: manifest([entry(path, 'fixture')]) }), /public source|allowlist/);
  }
}));

test('fresh isolated candidate, audit and archive list share identical source hashes without touching the index', () => temporary(async directory => {
  const { root, git } = await repository(directory); const vue = '<template>candidate</template>\n';
  await put(root, 'src/App.vue', vue); git('add', '--', 'src/App.vue'); await put(root, 'src/App.vue', 'dirty copy');
  const before = await indexBytes(root); const candidate = join(directory, 'candidate');
  const audited = await auditPublicSource({ root, writeCandidate: candidate, output: join(directory, 'audit.json') });
  assert.equal(await readFile(join(candidate, 'src/App.vue'), 'utf8'), vue);
  assert.equal((JSON.parse(await readFile(join(candidate, CANDIDATE_MANIFEST), 'utf8'))).kind, 'reviewed-source-manifest');
  const check = await auditPublicSource({ candidateRoot: candidate }); const list = join(directory, 'archive-list.json');
  assert.deepEqual(check.files, audited.files); assert.equal(check.source.treeSha256, audited.source.treeSha256);
  assert.deepEqual(await archiveFileList(candidate, list), audited.files);
  assert.deepEqual((JSON.parse(await readFile(list, 'utf8'))).files, audited.files);
  assert.deepEqual(await indexBytes(root), before);
  const second = join(directory, 'second-candidate');
  assert.deepEqual((await auditPublicSource({ candidateRoot: candidate, writeCandidate: second })).files, audited.files);
  await assert.rejects(auditPublicSource({ candidateRoot: candidate, writeCandidate: join(candidate, 'nested') }), /isolated from the source/);
  await assert.rejects(auditPublicSource({ root, writeCandidate: candidate }), /EEXIST/);
  await put(candidate, 'src/unreviewed.ts', 'unexpected');
  await assert.rejects(auditPublicSource({ candidateRoot: candidate }), /differs from its reviewed manifest/);
  await assert.rejects(archiveFileList(candidate, join(directory, 'changed-list.json')), /differs from its reviewed manifest/);
}));

test('explicit isolated candidates scan all files and reject worktree recursion or hidden local data', () => temporary(async directory => {
  const { root } = await repository(directory);
  await assert.rejects(auditPublicSource({ candidateRoot: root }), /isolated outside/);
  const nested = join(root, 'candidate'); await mkdir(nested);
  await assert.rejects(auditPublicSource({ candidateRoot: nested }), /isolated outside/);
  const candidate = join(directory, 'isolated'); await mkdir(candidate); await put(candidate, 'src/App.vue', '<template>safe</template>');
  assert.equal((await auditPublicSource({ candidateRoot: candidate })).fileCount, 1);
  await put(candidate, 'tools/taskboard/.local/usage/raw.jsonl', 'fixture');
  await assert.rejects(auditPublicSource({ candidateRoot: candidate }), /Excluded output/);
  await assert.rejects(auditPublicSource({ root, writeCandidate: join(root, 'artifacts/candidate') }), /isolated from the source/);
}));

test('audit, archive and candidate outputs cannot overwrite public source or sealed candidate files', () => temporary(async directory => {
  const { root } = await repository(directory); const before = await readFile(join(root, 'src/old.ts'));
  for (const output of [join(root, 'docs/audit.json'), join(root, 'src/old.ts'), join(root, '.git/index')]) {
    await assert.rejects(auditPublicSource({ root, output }), /inside public source/);
    await assert.rejects(archiveFileList(root, output), /inside public source/);
  }
  const output = join(directory, 'audit.json'); await auditPublicSource({ root, output });
  await assert.rejects(auditPublicSource({ root, output }), /EEXIST/);
  const candidate = join(directory, 'candidate'); await auditPublicSource({ root, writeCandidate: candidate });
  await assert.rejects(auditPublicSource({ candidateRoot: candidate, output: join(candidate, 'src/report.json') }), /separate from the candidate/);
  await assert.rejects(archiveFileList(candidate, join(candidate, 'docs/list.json')), /public source|candidate/);
  assert.deepEqual(await readFile(join(root, 'src/old.ts')), before);
}));

test('output parent links cannot redirect reports or candidates into public source', () => temporary(async directory => {
  const { root } = await repository(directory); await mkdir(join(root, 'docs'));
  const redirected = join(directory, 'redirected-output');
  await symlink(join(root, 'docs'), redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(auditPublicSource({ root, output: join(redirected, 'report.json') }), /Output parent/);
  await assert.rejects(archiveFileList(root, join(redirected, 'list.json')), /Output parent/);
  await assert.rejects(auditPublicSource({ root, writeCandidate: join(redirected, 'candidate') }), /Output parent/);
}));

test('source snapshots reject index links and reviewed file parent links', () => temporary(async directory => {
  const { root, git } = await repository(directory);
  const oid = git('hash-object', '-w', '--stdin').toString('utf8').trim();
  git('update-index', '--add', '--cacheinfo', `120000,${oid},src/link.ts`);
  await assert.rejects(readSourceSnapshot(root), /refuses links/);
  const outside = join(directory, 'outside'); await mkdir(outside); await put(outside, 'file.ts', 'fixture');
  await symlink(outside, join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(auditPublicSource({ root, reviewedManifest: manifest([entry('src/linked/file.ts', 'fixture')]) }), /refuses links/);
}));

test('ZIP inspection validates allowlisted paths and the full archive prefix', () => temporary(async directory => {
  const archive = join(directory, 'source.zip'); await writeFile(archive, 'fixture'); const report = join(directory, 'inspection.json');
  await writeFile(report, JSON.stringify({ sha256: sha256('fixture'), files: [{ path: 'source/src/App.vue' }] }));
  await assertZipInventory(archive, report, 'source');
  for (const path of ['elsewhere/src/App.vue', 'source/../escape', 'source/tools/taskboard/data/board.json']) {
    await writeFile(report, JSON.stringify({ sha256: sha256('fixture'), files: [{ path }] }));
    await assert.rejects(assertZipInventory(archive, report, 'source'));
  }
}));

test('audit CLI is strict and defaults to index unless an explicit source alternative is selected', () => {
  assert.deepEqual(parseAuditArgs([]), {}); assert.deepEqual(parseAuditArgs(['--staged']), { staged: true });
  for (const args of [['--staged', '--candidate-root', 'candidate'], ['--candidate-root', 'candidate', '--reviewed-manifest', 'files.json'], ['--output'], ['--root', '--staged'], ['--unknown'], ['--staged', '--staged']]) assert.throws(() => parseAuditArgs(args));
});
