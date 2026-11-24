import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertRepositoryReadonlyOutput, assertRepositoryUiHealth, BROWSER_SCRIPTS, cleanupCounts, parseRepositoryReadonlyArgs, READ_REPOSITORY_UI, SCOPE } from '../test-repository-readonly.mjs';
import { assertReadOnlyGitArgs, readOnlyEnvironment } from './performance.mjs';
import { PROJECT } from './run.mjs';

// Pure checks only: never launch Git, a driver/application, browser or fixture.
const root = resolve(PROJECT, '..', 'example-private-smoke');
const inputs = { repository: join(root, 'repository'), binary: join(root, 'tools', 'app.exe'), driver: join(root, 'tools', 'msedgedriver.exe'), output: join(root, 'output') };
const args = Object.entries(inputs).flatMap(([key, value]) => [`--${key}`, value]);
const source = () => readFile(new URL('../test-repository-readonly.mjs', import.meta.url), 'utf8');

test('CLI requires explicit absolute repository, frozen binary, driver and fresh output', () => {
  assert.deepEqual(parseRepositoryReadonlyArgs(args), inputs);
  assert.deepEqual(parseRepositoryReadonlyArgs(['--help']), { help: true });
  for (const key of Object.keys(inputs)) {
    const missing = [...args]; missing.splice(missing.indexOf(`--${key}`), 2); assert.throws(() => parseRepositoryReadonlyArgs(missing));
    for (const value of ['relative-path', 'with\0nul', 'with\nnewline']) {
      const invalid = [...args]; invalid[invalid.indexOf(`--${key}`) + 1] = value; assert.throws(() => parseRepositoryReadonlyArgs(invalid));
    }
  }
});

test('CLI excludes arbitrary options, positional paths, overrides, duplicates and unsafe executables without leaking values', () => {
  for (const extra of [['private-positional'], ['--kind', 'installed'], ['--samples', '50'], ['--sample-plan', 'private'], ['--trust'], ['--output', inputs.output], ['--unknown-private-option'], ['--git'], ['--git', '--help'], ['--git', '../relative-tool'], ['--tauri-driver', '-private-tool'], ['--git', 'tool\0private']]) {
    assert.throws(() => parseRepositoryReadonlyArgs([...args, ...extra]), error => /private details omitted/.test(error.message) && !/private-positional|unknown-private-option|private-tool/.test(error.message));
  }
  assert.deepEqual(parseRepositoryReadonlyArgs([...args, '--git', 'git', '--tauri-driver', 'tauri-driver', '--screenshot']), { ...inputs, git: 'git', 'tauri-driver': 'tauri-driver', screenshot: true });
});

test('private output cannot overlap repository, executable or existing profile and source output uses ignored artifacts', () => {
  assert.doesNotThrow(() => assertRepositoryReadonlyOutput(inputs.repository, inputs.output));
  for (const output of [inputs.repository, join(inputs.repository, 'results'), root]) assert.throws(() => assertRepositoryReadonlyOutput(inputs.repository, output));
  const profile = join(root, 'profile');
  for (const output of [profile, join(profile, 'nested')]) assert.throws(() => assertRepositoryReadonlyOutput(inputs.repository, output, [profile]));
  assert.throws(() => parseRepositoryReadonlyArgs([...args.slice(0, -2), '--output', join(root, 'tools')]));
  assert.throws(() => assertRepositoryReadonlyOutput(inputs.repository, join(PROJECT, 'docs', 'evidence')));
  assert.throws(() => assertRepositoryReadonlyOutput(inputs.repository, join(PROJECT, 'artifacts')));
  assert.doesNotThrow(() => assertRepositoryReadonlyOutput(inputs.repository, join(PROJECT, 'artifacts', 'fresh-smoke-run')));
  assert.doesNotThrow(() => assertRepositoryReadonlyOutput(inputs.repository, `${inputs.repository}-sibling`));
});

test('native shared environment keeps real HOME/config lookup and removes inherited test overrides', () => {
  const base = { HOME: 'real-home', USERPROFILE: 'real-user', APPDATA: 'real-app', LOCALAPPDATA: 'real-local', XDG_CONFIG_HOME: 'real-xdg', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'wrong', GIT_DIR: 'wrong', QGITGRAPH_TEST_HOME: 'wrong', WEBVIEW2_USER_DATA_FOLDER: 'wrong', EDGE_EXTRA: 'wrong' };
  const env = readOnlyEnvironment(base, { native: true });
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) assert.equal(env[key], base[key]);
  for (const key of ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_DIR', 'QGITGRAPH_TEST_HOME', 'WEBVIEW2_USER_DATA_FOLDER', 'EDGE_EXTRA']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(env.QGITGRAPH_PERF, '1');
});

test('fast idle completion never conceals UI/status errors or silently trusted state', () => {
  const healthy = { idle: true, repoOpen: true, untrustedVisible: true, errorCount: 0, statusWorkingError: false, statusHistoryError: false };
  assert.doesNotThrow(() => assertRepositoryUiHealth(healthy));
  for (const changed of [{ errorCount: 1 }, { statusWorkingError: true }, { statusHistoryError: true }, { untrustedVisible: false }]) {
    assert.throws(() => assertRepositoryUiHealth({ ...healthy, ...changed }));
  }
});

test('cleanup counts discard private process payloads and require confirmed zero remainder/errors', () => {
  const result = cleanupCounts({ stopped: [{ commandLine: 'secret-command', executable: 'secret-path' }], remaining: [], errors: [] });
  assert.equal(result.status, 'verified-zero'); assert.equal(result.remaining, 0); assert.equal(result.errors, 0); assert.equal(result.stopped, 1);
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(cleanupCounts({ stopped: [], remaining: [{ pid: 1 }], errors: [] }).status, 'incomplete');
  assert.equal(cleanupCounts({ stopped: [], remaining: [], errors: [{ message: 'secret' }] }).status, 'incomplete');
  assert.equal(cleanupCounts(null).remaining, null); assert.equal(cleanupCounts({}).status, 'incomplete');
});

test('every embedded script compiles and uses only readonly DOM observation, not business IPC or scripted input', () => {
  assert.equal(BROWSER_SCRIPTS.length, 2);
  for (const script of BROWSER_SCRIPTS) {
    assert.doesNotThrow(() => Function(script));
    assert.doesNotMatch(script, /__TAURI|__QGITGRAPH|\binvoke\s*\(|\bHost\b|fetch\s*\(|dispatchEvent|new\s+(?:Event|MouseEvent)|\.click\s*\(|\.focus\s*\(|scrollIntoView|\.value\s*=(?!=)|textContent\s*=(?!=)|innerHTML|outerHTML|addEventListener|localStorage/);
  }
  assert.match(READ_REPOSITORY_UI, /statusWorkingError/); assert.match(READ_REPOSITORY_UI, /statusHistoryError/);
});

test('DOM identity comparison supports extended UNC syntax and returns booleans without paths, OIDs or content', () => {
  const privatePath = ['\\\\wsl.localhost', 'ExampleDistribution', 'home', 'example-user', 'example-repository'].join('\\');
  const privateHead = 'a'.repeat(40);
  const shell = { dataset: { repoPath: privatePath, repoHead: privateHead, taskState: 'idle', taskSequence: '2' } };
  const status = { dataset: { workingState: 'clean', historyState: 'ready', stale: 'false', historyStale: 'false' } };
  const grid = { getAttribute: key => key === 'aria-busy' ? 'false' : '301' };
  const trust = { hidden: false, getClientRects: () => [{}] };
  const document = {
    querySelector: selector => selector === '.app-shell' ? shell : selector === '.statusbar' ? status : selector === '.history-pane' ? grid : null,
    querySelectorAll: selector => selector === '.trustbar:not(.diagnosticsbar)' ? [trust] : [],
    getElementById: () => null,
  };
  const run = Function('document', 'args', `return (function(){${READ_REPOSITORY_UI}}).apply(null,args);`);
  const extended = '\\\\?\\UNC\\' + privatePath.slice(2);
  const result = run(document, [extended, privateHead]);
  assert.equal(result.repositoryMatches, true); assert.equal(result.headMatches, true); assert.equal(result.untrustedVisible, true);
  for (const privateValue of [privatePath, privateHead, 'example-user', 'ExampleDistribution']) assert(!JSON.stringify(result).includes(privateValue));
  shell.dataset.repoHead = 'b'.repeat(40); assert.equal(run(document, [privatePath, privateHead]).headMatches, false);
});

test('runner reuses readonly helpers with fixed native three-sample mode and no arbitrary Git execution', async () => {
  const text = await source();
  assert.match(text, /createPerformanceRun\(options\.output, options\.repository, 'native', 3\)/);
  for (const name of ['readOnlyGit', 'repositoryDigest', 'chooseCommitSamples', 'privateOwnedProcesses', 'startPerformanceDesktop']) assert.match(text, new RegExp(`\\b${name}\\(`));
  assert.match(text, /chooseCommitSamples\(run, options\.repository, 3,/);
  assert.match(text, /plan\.samples\[0\]/); assert.match(text, /sample\.files\[0\]/);
  assert.doesNotMatch(text, /node:child_process|spawn\s*\(|execFile|createFixtures|archiveDesktop|\.state\s*\(|\.idle\s*\(|gitText\s*\(|writeSamplePlan|sample-plan\.private/);
  for (const vector of [['rev-parse', '--path-format=absolute', '--show-toplevel'], ['rev-parse', '--verify', 'HEAD']]) assert.doesNotThrow(() => assertReadOnlyGitArgs(vector));
  assert.doesNotMatch(text, /['"](?:fetch|pull|rev-list|checkout|trust-repository)['"]/);
});

test('actual menu path fill, hash-cell click and canonical file element click have no private invocation/search fallback', async () => {
  const text = await source();
  for (const selector of ['repository-options', 'open-repository-by-path', 'confirm-open-repository']) assert(text.includes(`data-action="${selector}"`));
  assert(text.includes("await wd.fill('dialog[open] input[name=\"path\"]', repository)"));
  assert(text.includes('await wd.click(`[id="commit-${sample.oid}"] .hash-cell`)'));
  assert(text.includes('await wd.script(FIND_SAMPLE_FILE, [sample.files[0]])'));
  assert(text.includes('await wd.clickElement(file[ELEMENT])'));
  assert.doesNotMatch(text, /commit-subject|commit-description|\.hash-cell[^\n]*ref-badges/);
  assert.doesNotMatch(text, /wd\.select\([^\n]*'search'|data-action="load-more"|dispatchEvent|__TAURI|\binvoke\s*\(/);
  assert.match(text, /diffKind='binary'/); assert.match(text, /diffKind='empty'/); assert.match(text, /diffKind='truncated'/);
  assert(SCOPE.includes('not a performance benchmark')); assert(SCOPE.includes('Old/new full-content modes'));
});

test('integrity and owned cleanup are finally-bound and no raw evidence or machine path literals enter runner source', async () => {
  const text = await source();
  assert.match(text, /finally\s*\{\s*clearTimeout\(timer\)/);
  assert.match(text, /owned\.snapshot\(\)/); assert.match(text, /wd\.call\('DELETE', wd\.prefix/); assert.match(text, /await owned\.cleanup\(\)/);
  assert.match(text, /repositoryDigest\(run, options\.repository, before\.plan, AbortSignal\.timeout\(120000\)\)/);
  assert.match(text, /if \(run\.manifest\.repoIntegrity\.changed\.length && !teardownFailed\) run\.manifest\.status = 'blocked'/);
  assert.match(text, /publicEligible: false/); assert.match(text, /actualBinary:.*sha256/);
  assert.match(text, /if \(options\.screenshot && wd\?\.sessionId\)/);
  assert.doesNotMatch(text, /['"][A-Za-z]:[\\/][^'"\r\n]+['"]|\\\\wsl\.localhost|[\\/]Users[\\/][^'"\s]+/);
  assert.doesNotMatch(text, /\/source['"`]|wd\.commands|errorInfo|\.stack\b|stderr\.toString|innerText/);
  assert.doesNotMatch(text, /readFile\([^\n]*(?:APPDATA|LOCALAPPDATA|USERPROFILE)|(?:copyFile|cp)\s*\(/);
});
