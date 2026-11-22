#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { inside, isMain, parseArgs, PROJECT, regularFile, required, samePath, sha256 } from './lib/run.mjs';

const help = 'node scripts/preflight-performance.mjs --repository <absolute existing repository> --git <absolute trusted Git executable> --output <absent private output directory>\nRead-only Git preflight. Never discovers repositories from user application state. Output must be outside the measured repository and application profile trees. Reports are private/local only, not public release assets. Inherits normal user Git configuration unchanged; no trust grant, safe.directory override, network or repository scripts.';
export function parsePreflightArgs(argv) {
  const options = parseArgs(argv, { values: ['repository', 'git', 'output'], flags: ['help'] });
  if (options.help) return options;
  required(options, ['repository', 'git', 'output']);
  for (const key of ['repository', 'git', 'output']) {
    if (!isAbsolute(options[key]) || /[\x00-\x1f]/.test(options[key])) throw new Error(`--${key} must be an explicit absolute path.`);
    options[key] = resolve(options[key]);
  }
  return options;
}
export function assertPreflightOutput(repository, output, profiles = []) {
  if (!isAbsolute(repository) || !isAbsolute(output)) throw new Error('Repository and output must be explicit absolute paths.');
  const within = (parent, child) => samePath(parent, child) || inside(parent, child);
  if (within(repository, output) || within(output, repository)) throw new Error('Private output must be separate from the measured repository.');
  for (const profile of profiles) {
    if (within(profile, output) || within(output, profile)) throw new Error('Private output must be separate from application profile trees.');
  }
  if (within(PROJECT, output) && (!inside(join(PROJECT, 'artifacts'), output))) throw new Error('Private output in the source project must use a fresh artifacts subdirectory.');
}
// These are the original bounded read-only operations, not a general Git runner.
export const PREFLIGHT_GIT_OPERATIONS = Object.freeze([
  ['git-version', ['--version']],
  ['repository-identity', ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--is-bare-repository', '--show-toplevel']],
  ['head', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']],
  ['status', ['status', '--porcelain=v2', '--branch', '--ahead-behind', '-z', '--untracked-files=all', '--ignore-submodules=none']],
  ['refs', ['for-each-ref', '--format=%(objectname)%00%(refname)%00']],
  ['reachable-commit-count', ['rev-list', '--all', '--count']],
  ['tracked-paths', ['ls-files', '-z']],
  ['history-first300', ['log', '-z', '--format=%H%x00%P%x00%at%x00%ct', '--no-show-signature', '--no-decorate', '--no-notes', '--date-order', '--max-count=300', '--all', '--']],
].map(([label, args]) => Object.freeze([label, Object.freeze(args)])));

export async function main(argv = process.argv.slice(2)) {
  const options = parsePreflightArgs(argv);
  if (options.help) { console.log(help); return; }
  const { repository, git: executable, output } = options;
  // Use environment paths only to reject output overlap, never to read state.
  const profiles = [
    ...[process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map(path => join(path, 'app.qgitgraph.desktop')),
    process.env.QGITGRAPH_TEST_HOME,
  ].filter(Boolean);
  assertPreflightOutput(repository, output, profiles);
  assert((await stat(repository)).isDirectory(), 'The explicit repository must be an existing directory.');
  await regularFile(executable);
  // Check the existing parent before creating any output, including junctions.
  const actualRepository = await realpath(repository);
  const actualOutput = join(await realpath(dirname(output)), basename(output));
  assert(samePath(actualOutput, output), 'Private output must not be redirected through links.');
  assertPreflightOutput(actualRepository, actualOutput, profiles);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '0' });
  const prefix = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-C', repository];
  const calls = [];
  async function git(label, args, budget = 32 * 1024 * 1024) {
    const start = performance.now();
    const child = spawn(executable, [...prefix, ...args], { env, cwd: PROJECT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let size = 0; let stderrBytes = 0; let bounded = false; let spawnFailed = false;
    const timer = setTimeout(() => { bounded = true; child.kill(); }, 120000);
    child.stdout.on('data', data => { size += data.length; if (size > budget) { bounded = true; child.kill(); } else out.push(data); });
    // Stderr may contain private paths, credentials or contents. Count only.
    child.stderr.on('data', data => { stderrBytes += data.length; });
    child.once('error', () => { spawnFailed = true; });
    const code = await new Promise(resolveCode => child.once('close', resolveCode));
    clearTimeout(timer);
    const bytes = Buffer.concat(out);
    calls.push({ label, milliseconds: performance.now() - start, bytes: bytes.length, stderrBytes, exitCode: code });
    if (spawnFailed || bounded || code !== 0) throw new Error(`${label} ${spawnFailed ? 'could not start' : bounded ? 'exceeded the time/output bound' : `exited ${code}`}. No stderr or repository contents were archived.`);
    assert(size <= budget, 'Read-only preflight exceeded output budget.');
    return bytes;
  }
  const privacy = { localOnly: true, publicReleaseEligible: false, sourceContents: false, rawStderr: false };
  let report; let claimed = false;
  try {
    const results = new Map();
    for (const [label, args] of PREFLIGHT_GIT_OPERATIONS) {
      const bytes = await git(label, args); results.set(label, bytes);
      if (label === 'repository-identity') {
        const identity = bytes.toString('utf8').trim().split(/\r?\n/);
        // An explicit subdirectory must not let output land elsewhere in the same repo.
        for (const protectedPath of [identity[0], identity[1], identity[3]].filter(Boolean)) assertPreflightOutput(protectedPath, output, profiles);
        await mkdir(output, { recursive: false }); claimed = true;
      }
    }
    const version = results.get('git-version').toString('utf8').trim();
    const identity = results.get('repository-identity').toString('utf8').trim().split(/\r?\n/);
    const head = results.get('head').toString('utf8').trim();
    const status = results.get('status'); const refs = results.get('refs');
    const count = Number(results.get('reachable-commit-count').toString('utf8').trim());
    const tracked = results.get('tracked-paths'); const log = results.get('history-first300');
    const trackedCount = tracked.toString('utf8').split('\0').filter(Boolean).length;
    const refCount = refs.toString('utf8').split('\n').filter(Boolean).length;
    const gitDirectory = identity[0];
    const index = await readFile(join(gitDirectory, 'index')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    const localConfig = await readFile(join(gitDirectory, 'config'));
    report = { schemaVersion: 1, kind: 'readonly-preflight', status: 'passed', privacy, repository, gitExecutable: executable, gitVersion: version, head, bare: identity[2] === 'true', totalReachableCommits: count, trackedCount, refCount, facts: { statusSha256: sha256(status), statusBytes: status.length, refsSha256: sha256(refs), indexSha256: sha256(index), localConfigSha256: sha256(localConfig), initialLogBytes: log.length }, calls, scope: 'Single read-only preflight, not an application benchmark or before/after integrity proof. No fetch, configuration change, trust grant, safe.directory exception, index refresh, write test or script execution.' };
  } catch (error) {
    if (!claimed) throw error;
    report = { schemaVersion: 1, kind: 'readonly-preflight', status: 'failed', privacy, repository, calls, error: 'Read-only preflight failed or exceeded a bound. No private error payload was archived; inspect locally without bypassing trust checks.' };
    process.exitCode = 1;
  }
  await writeFile(join(output, 'test-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  return report;
}
if (isMain(import.meta.url)) await main().catch(() => { console.error('Preflight blocked: provide explicit absolute inputs and an absent private output outside protected trees. Use --help for usage. No user application state was read.'); process.exitCode = 1; });
