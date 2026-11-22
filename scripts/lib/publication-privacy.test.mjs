import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertPreflightOutput, parsePreflightArgs, PREFLIGHT_GIT_OPERATIONS } from '../preflight-performance.mjs';
import { PROJECT } from './run.mjs';

const repository = resolve('example-measured-repository');
const git = resolve('trusted-tools/git.exe');
const output = resolve('private-preflight-output');
const explicitArgs = ['--repository', repository, '--git', git, '--output', output];

test('preflight requires repository, Git and private output explicitly before any IO', () => {
  assert.deepEqual(parsePreflightArgs(explicitArgs), { repository, git, output });
  for (const key of ['repository', 'git', 'output']) {
    const args = [...explicitArgs]; args.splice(args.indexOf(`--${key}`), 2);
    assert.throws(() => parsePreflightArgs(args), new RegExp(`Required argument: --${key}`));
    const relative = [...explicitArgs]; relative[relative.indexOf(`--${key}`) + 1] = 'relative-path';
    assert.throws(() => parsePreflightArgs(relative), /explicit absolute path/);
  }
  for (const args of [[], ['previous-positional-output'], [...explicitArgs, '--output', output], [...explicitArgs, '--unknown'], ['--repository'], ['--git', '--output']]) assert.throws(() => parsePreflightArgs(args));
  assert.deepEqual(parsePreflightArgs(['--help']), { help: true });
});

test('preflight output cannot overlap measured repository, profiles or published source', () => {
  const root = resolve(PROJECT, '..', 'example-private-preflight');
  const repo = join(root, 'repository'); const profile = join(root, 'profile'); const privateOutput = join(root, 'output');
  assert.doesNotThrow(() => assertPreflightOutput(repo, privateOutput, [profile]));
  for (const candidate of [repo, join(repo, 'results'), root, profile, join(profile, 'results')]) assert.throws(() => assertPreflightOutput(repo, candidate, [profile]), /separate/);
  assert.throws(() => assertPreflightOutput(repo, join(PROJECT, 'docs', 'private-output')), /fresh artifacts/);
  assert.throws(() => assertPreflightOutput(repo, join(PROJECT, 'artifacts')), /fresh artifacts/);
  assert.doesNotThrow(() => assertPreflightOutput(repo, join(PROJECT, 'artifacts', 'new-private-run')));
});

test('preflight preserves the original bounded read-only Git operation vectors', () => {
  assert.deepEqual(PREFLIGHT_GIT_OPERATIONS, [
    ['git-version', ['--version']],
    ['repository-identity', ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--is-bare-repository', '--show-toplevel']],
    ['head', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']],
    ['status', ['status', '--porcelain=v2', '--branch', '--ahead-behind', '-z', '--untracked-files=all', '--ignore-submodules=none']],
    ['refs', ['for-each-ref', '--format=%(objectname)%00%(refname)%00']],
    ['reachable-commit-count', ['rev-list', '--all', '--count']],
    ['tracked-paths', ['ls-files', '-z']],
    ['history-first300', ['log', '-z', '--format=%H%x00%P%x00%at%x00%ct', '--no-show-signature', '--no-decorate', '--no-notes', '--date-order', '--max-count=300', '--all', '--']],
  ]);
  assert(Object.isFrozen(PREFLIGHT_GIT_OPERATIONS));
  assert(PREFLIGHT_GIT_OPERATIONS.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry[1])));
});

test('owned entrypoints contain no literal machine paths or implicit application-state discovery', async () => {
  const preflight = await readFile(new URL('../preflight-performance.mjs', import.meta.url), 'utf8');
  const upgrade = await readFile(new URL('../upgrade-local.ps1', import.meta.url), 'utf8');
  for (const source of [preflight, upgrade]) assert.doesNotMatch(source, /['"][A-Za-z]:[\\/][^'"\r\n]+['"]/);
  assert.doesNotMatch(preflight, /(?:lastRepo|\.recent\b)/);
  assert.doesNotMatch(preflight, /readFile\s*\([^)]*(?:APPDATA|LOCALAPPDATA|USERPROFILE)/);
  assert.match(preflight, /cwd: PROJECT/);
  assert.match(preflight, /32 \* 1024 \* 1024/);
  assert.match(preflight, /120000/);
  assert.match(preflight, /flag: 'wx'/);
  assert.match(preflight, /publicReleaseEligible: false/);
  assert.doesNotMatch(preflight, /(?:stderr\.toString|Buffer\.concat\(err\))/);
});

test('upgrade requires explicit version, path and both payload/rollback hash pins without defaults', async () => {
  const source = await readFile(new URL('../upgrade-local.ps1', import.meta.url), 'utf8');
  const parameterBlock = source.slice(0, source.indexOf("$ErrorActionPreference"));
  for (const name of ['Installer', 'OutputDirectory', 'Destination', 'ProfileState', 'RollbackInstaller', 'ExpectedCurrentVersion', 'ExpectedPriorExeSha256', 'ExpectedRollbackInstallerSha256', 'ExpectedNewVersion', 'ExpectedExeSha256', 'ExpectedInstallerSha256']) {
    const line = parameterBlock.split(/\r?\n/).find(value => value.includes(`$${name},`));
    assert(line, `Missing parameter ${name}`);
    assert.match(line, /\[Parameter\(Mandatory=\$true\)\]/);
    assert.doesNotMatch(line, new RegExp(`\\$${name}\\s*=`));
  }
  assert.doesNotMatch(source, /AllowCurrent\d+|\b0\.2\.[012]\b/);
  assert.match(source, /\$version -cne \$ExpectedCurrentVersion/);
  assert.match(source, /\$oldExeHash -ine \$ExpectedPriorExeSha256/);
  assert.match(source, /rollbackInstaller\.signature\.sha256 -ine \$ExpectedRollbackInstallerSha256/);
  assert.match(source, /\$registrationAfter\[0\]\.key -cne \$registrations\[0\]\.key/);
  assert.match(source, /displayVersion -cne \$ExpectedNewVersion/);
  assert.match(source, /VersionInfo\.ProductVersion -cne \$ExpectedNewVersion/);
  assert.match(source, /-ine \$ExpectedExeSha256/);
  assert.match(source, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(source, /\[IO\.FileMode\]::CreateNew/);
  assert.match(source, /PostMessageW\(\$handle,0x0010/);
  assert.match(source, /\$licensePath = Join-Path \$Root 'LICENSE'/);
  assert.match(source, /if \(Test-Path -LiteralPath \$licensePath -PathType Leaf\) \{\s*if \(\(Get-Item -LiteralPath \$licensePath -Force\)\.Length -le 0\) \{ throw '[^']+' \}\s*\$allowed\['LICENSE'\] = \$true\s*\}/);
  assert.match(source, /bytes=\$file\.Length; sha256=\(Get-FileHash -LiteralPath \$file\.FullName -Algorithm SHA256\)/);
  assert.doesNotMatch(source, /(?:Stop-Process|taskkill|Remove-QGOwnedInstall|Set-ItemProperty|Remove-ItemProperty|TerminateProcess)\b/i);
});

test('ignore rules protect local outputs and credentials without dropping MPL source archives', async () => {
  const patterns = (await readFile(new URL('../../.gitignore', import.meta.url), 'utf8')).split(/\r?\n/);
  for (const pattern of ['.zcode/', 'artifacts/', 'release/', 'src-tauri/gen/', '.env*', '!.env.example', '*.pem', '*.key', '*.p12', '*.pfx', '/backups/', '/tmp/', '/logs/']) assert(patterns.includes(pattern), pattern);
  assert(!patterns.some(pattern => /\.crate\b/.test(pattern)));
  assert(!patterns.some(pattern => /\*state\.json/.test(pattern)));
});
