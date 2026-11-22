import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { errorInfo, git, gitText, json, sha256 } from './run.mjs';

const zeroNames = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
async function fileDigest(file) {
  try { const bytes = await readFile(file); return { bytes: bytes.length, sha256: sha256(bytes) }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function repositorySnapshot(run, repository) {
  const bare = gitText(run, repository, ['rev-parse', '--is-bare-repository']) === 'true';
  const gitDir = await realpath(gitText(run, repository, ['rev-parse', '--absolute-git-dir']));
  const root = bare ? gitDir : await realpath(gitText(run, repository, ['rev-parse', '--show-toplevel']));
  const indexPath = resolve(repository, gitText(run, repository, ['rev-parse', '--git-path', 'index']));
  const headPath = resolve(repository, gitText(run, repository, ['rev-parse', '--git-path', 'HEAD']));
  const head = gitText(run, repository, ['rev-parse', '--verify', 'HEAD']);
  const refs = gitText(run, repository, ['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)']).split('\n').filter(Boolean).sort();
  const tracked = [];
  const untracked = [];
  if (!bare) {
    for (const entry of zeroNames(git(run, repository, ['ls-files', '--stage', '-z']).stdout)) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
      assert(match, `Unexpected ls-files record: ${entry}`);
      const [, mode, oid, stage, path] = match;
      tracked.push({ path, mode, oid, stage, working: mode === '160000' ? { gitlink: true } : await fileDigest(join(root, path)) });
    }
    for (const path of zeroNames(git(run, repository, ['ls-files', '--others', '--exclude-standard', '-z']).stdout)) untracked.push({ path, working: await fileDigest(join(root, path)) });
  }
  return {
    identity: { path: root, gitDir, bare }, head, headFile: await fileDigest(headPath), index: await fileDigest(indexPath),
    status: bare ? '' : git(run, repository, ['status', '--porcelain=v2', '--untracked-files=all', '-z']).stdout.toString('base64'),
    tracked, untracked, refs,
  };
}
export function assertRefsAbsent(run, repository, refs) {
  for (const ref of refs) {
    const result = git(run, repository, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true });
    assert.equal(result.status, 1, `Test requires initially absent ref ${ref}; never skip an existing ref. Use a new run.`);
  }
}
export async function createFixtures(run) {
  const root = join(run.output, 'fixtures');
  if (existsSync(root)) throw new Error('Fixtures already exist; use a new run.');
  await mkdir(root);
  const repository = join(root, 'lighthouse 中文');
  const submoduleSource = join(root, 'local submodule source');
  const bareRemote = join(root, 'local-origin.git');
  let dateIndex = 0;
  const write = async (repo, path, text) => { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), text); };
  const configure = repo => {
    for (const [key, value] of [['user.name', 'QGitGraph fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['core.hooksPath', run.manifest.git.hooksDirectory], ['credential.helper', ''], ['protocol.allow', 'never'], ['protocol.file.allow', 'always']]) git(run, repo, ['config', '--local', key, value]);
  };
  const init = async repo => { await mkdir(repo, { recursive: true }); git(run, repo, ['-c', 'core.longpaths=true', 'init', '-b', 'main', `--template=${run.manifest.git.templateDirectory}`]); configure(repo); };
  const commit = (repo, subject, body = '') => {
    git(run, repo, ['add', '--all']);
    const date = new Date(Date.UTC(2026, 0, 2, 8, dateIndex++)).toISOString();
    git(run, repo, ['commit', '--quiet', '-m', subject, ...(body ? ['-m', body] : [])], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return gitText(run, repo, ['rev-parse', 'HEAD']);
  };
  await init(submoduleSource);
  await write(submoduleSource, 'module.txt', 'Local-only submodule fixture.\n');
  commit(submoduleSource, 'Initial local submodule');
  await init(repository);
  await write(repository, 'README.md', '# Lighthouse\n\nA local Git fixture, never application sample data.\n');
  await write(repository, 'src/commands/palette.ts', 'export const commands = ["Open repository"];\n');
  await write(repository, 'docs/使用说明.md', '# 使用说明\n\n支持中文和空格路径。\n');
  const initial = commit(repository, 'Initial project structure');
  const subjects = ['Add split view for text comparisons', 'Reduce background work while inactive', 'Expose a read-only diagnostics view', 'Update contribution guidelines', 'Handle Unicode paths in the file watcher', 'Simplify the build pipeline'];
  for (const subject of subjects) { await write(repository, 'CHANGELOG.md', `${subject}\n`); commit(repository, subject); }
  git(run, repository, ['checkout', '-b', 'feature/workspace']);
  await write(repository, 'src/workspace.ts', 'export const layout = { details: "bottom", size: 340 };\n');
  commit(repository, 'Persist workspace layout between sessions');
  git(run, repository, ['checkout', 'main']);
  await write(repository, 'docs/architecture.md', '# Architecture\n\nOne window. No server.\n');
  commit(repository, 'Document the process boundary');
  git(run, repository, ['merge', '--no-ff', 'feature/workspace', '-m', "Merge branch 'feature/workspace'"]);
  git(run, repository, ['checkout', '-b', 'feature/command-palette']);
  await write(repository, 'src/commands/palette.ts', 'export const commands = ["Open repository", "Search history"];\n');
  commit(repository, 'Keep search results stable while loading');
  await write(repository, 'src/commands/keyboard.ts', 'export const nextIndex = (index: number, length: number) => (index + 1) % length;\n');
  const keyboard = commit(repository, 'Add keyboard navigation to the command palette', 'Review #123 :sparkles:\n\n**Markdown fixture** with an https://example.invalid/review link.\nNo remote URL is opened automatically.');
  git(run, repository, ['checkout', 'main']);
  await write(repository, 'tests/focus.txt', 'Fixture content, not an executable test.\n');
  commit(repository, 'Fix focus restoration after closing a dialog');
  git(run, repository, ['merge', '--no-ff', 'feature/command-palette', '-m', "Merge branch 'feature/command-palette'"]);
  git(run, repository, ['tag', '-a', 'fixture-annotated', '-m', 'Fixture annotated tag\n\nTag detail and review metadata.']);
  git(run, repository, ['tag', 'fixture-lightweight']);
  // A disconnected, tag-only commit tests scope without polluting main's graph.
  git(run, repository, ['checkout', '--orphan', 'fixture-tag-only-build']);
  git(run, repository, ['rm', '-r', '--cached', '.']);
  await write(repository, 'tag-only.txt', 'Only reachable through a tag after branch removal.\n');
  const tagOnly = commit(repository, 'Tag-only history fixture');
  git(run, repository, ['tag', 'fixture-tag-only']);
  git(run, repository, ['checkout', 'main']);
  git(run, repository, ['branch', '-D', 'fixture-tag-only-build']);
  git(run, repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', submoduleSource, 'modules/local module']);
  const submodule = join(repository, 'modules/local module');
  configure(submodule);
  commit(repository, 'Add local submodule without network');
  await mkdir(bareRemote);
  git(run, bareRemote, ['init', '--bare', '-b', 'main', `--template=${run.manifest.git.templateDirectory}`]);
  git(run, repository, ['remote', 'add', 'origin', bareRemote]);
  git(run, repository, ['-c', 'protocol.file.allow=always', 'push', '--set-upstream', 'origin', 'main']);
  await write(repository, 'docs/stash-note.md', 'Work in progress for a real stash.\n');
  git(run, repository, ['add', 'docs/stash-note.md']);
  git(run, repository, ['stash', 'push', '-m', 'WIP: document review shortcuts']);
  // Preserve independently staged, unstaged, untracked and dirty-submodule states.
  await write(repository, 'src/commands/palette.ts', 'export const commands = ["Open repository", "Search history", "Staged fixture"];\n');
  git(run, repository, ['add', 'src/commands/palette.ts']);
  await write(repository, 'src/commands/palette.ts', 'export const commands = ["Open repository", "Search history", "Staged fixture", "Unstaged fixture"];\n');
  await write(repository, 'docs/notes with spaces.md', '# Untracked review notes\n');
  await write(submodule, 'module.txt', 'Local-only submodule fixture, dirty working tree.\n');
  await write(submodule, 'untracked module note.txt', 'Keep this untracked submodule file.\n');
  const repositories = { base: repository, submodule, bare: bareRemote, submoduleSource };
  // Windows long-path behavior depends on the host and Git build. Keep it an
  // explicit independent capability, never a reason to skip the real baseline.
  // Initialize from a short root, then exercise a long tracked *relative file*;
  // -C itself cannot reliably enter an over-MAX_PATH repository on every host.
  const longPath = join(root, 'long-path');
  const longRelative = join(...Array.from({ length: 7 }, (_, i) => `${i}-long-path-component-for-local-fixture`), 'long path 中文.txt');
  const longPathCase = { label: 'long-path fixture', requiredForBaseline: false, path: join(longPath, longRelative), status: 'running' };
  try {
    await init(longPath);
    await write(longPath, longRelative, 'Long relative path support; core.longpaths is repository-local.\n');
    commit(longPath, 'Initial long-path repository');
    repositories.longPath = longPath;
    longPathCase.status = 'passed';
  } catch (error) {
    longPathCase.status = 'blocked';
    longPathCase.reason = 'Host/Git cannot create the independent long-path fixture; no global Windows policy was changed.';
    longPathCase.error = errorInfo(error);
  }
  run.manifest.results.push(longPathCase);
  await json(join(run.output, 'long-path-case.json'), longPathCase);
  await run.save();
  const refs = [`refs/heads/${run.manifest.refs.branch}`, `refs/tags/${run.manifest.refs.annotatedTag}`, `refs/tags/${run.manifest.refs.lightweightTag}`];
  assertRefsAbsent(run, repository, refs);
  const snapshots = {};
  for (const [name, path] of Object.entries(repositories)) snapshots[name] = await repositorySnapshot(run, path);
  const result = {
    schemaVersion: 1, runId: run.manifest.runId, repository: snapshots.base.identity.path, head: snapshots.base.head,
    repositories,
    commits: { initial, keyboard, tagOnly }, testRefs: refs,
    capabilities: ['base-graph', 'merge', 'unicode-spaces', 'stash', 'annotated-tag', 'lightweight-tag', 'tag-only', 'local-bare-remote', ...(longPathCase.status === 'passed' ? ['long-path'] : []), 'local-submodule', 'staged-unstaged-untracked'],
    independentCases: [longPathCase],
    snapshots,
  };
  await json(join(run.output, 'fixture-manifest.json'), result);
  return result;
}
