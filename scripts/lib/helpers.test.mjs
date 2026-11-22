import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSameSnapshot, claimEmptyDirectory, createRun, inside, isolatedEnvironment, json, parseArgs, readJson, renameJsonFile, samePath, sha256 } from './run.mjs';
import { percentile, sizeComparison } from './metrics.mjs';
import { publicMetadata, readVersion, safeRelative, summarizeReport, validateRustEvidence, verifyNotices } from './release.mjs';
import { SOURCE_ENTRIES } from './source-archive.mjs';
import { monitorOwnedProcesses, OwnedProcesses, WebDriver } from './desktop.mjs';

async function temporary(work) {
  const directory = await mkdtemp(join(tmpdir(), 'qgitgraph-helper-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
test('JSON serializes 100 concurrent writers while every concurrent reader sees a complete valid state', () => temporary(async directory => {
  const file = join(directory, 'process-ownership.json');
  const makeState = writer => ({ schemaVersion: 1, writer, runId: `writer-${writer}`, processes: [{ pid: writer + 2, creationTime: `creation-${writer}` }], payload: `${writer}:`.repeat(1024) });
  const validate = state => assert.deepEqual(state, makeState(state.writer));
  await json(file, makeState(-1));
  const completed = []; let writing = true; let reads = 0;
  const reader = (async () => {
    do { validate(JSON.parse(await readFile(file, 'utf8'))); reads++; await delay(1); } while (writing);
  })();
  const writers = Array.from({ length: 100 }, (_, writer) => {
    const state = makeState(writer);
    const promise = json(file, state);
    state.writer = -999; state.processes.length = 0; // Must not mutate the enqueued snapshot.
    return promise.then(async () => { completed.push(writer); validate(await readJson(file)); });
  });
  const settled = await Promise.allSettled(writers);
  writing = false; await reader;
  for (const result of settled) assert.equal(result.status, 'fulfilled', String(result.reason));
  assert.deepEqual(completed, Array.from({ length: 100 }, (_, i) => i));
  assert.deepEqual(await readJson(file), makeState(99)); assert(reads > 1);
}));
test('JSON replacement retries only bounded Windows reader-handle errors and propagates failures', async () => {
  const waits = []; let attempts = 0;
  await renameJsonFile('new.tmp', 'owned.json', { platform: 'win32', renameFile: async () => { if (++attempts < 4) throw Object.assign(new Error('reader handle'), { code: 'EPERM' }); }, wait: async ms => { waits.push(ms); } });
  assert.equal(attempts, 4); assert.deepEqual(waits, [25, 50, 100]);
  const permanent = Object.assign(new Error('permanent handle'), { code: 'EPERM' }); attempts = 0; waits.length = 0;
  await assert.rejects(renameJsonFile('new.tmp', 'owned.json', { platform: 'win32', renameFile: async () => { attempts++; throw permanent; }, wait: async ms => { waits.push(ms); } }), error => error === permanent);
  assert.equal(attempts, 12); assert.equal(waits.reduce((a, b) => a + b, 0), 2125);
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' }); attempts = 0;
  await assert.rejects(renameJsonFile('new.tmp', 'owned.json', { platform: 'win32', renameFile: async () => { attempts++; throw denied; }, wait: async () => assert.fail('unrelated errors must not retry') }), error => error === denied);
  assert.equal(attempts, 1);
});
test('100 concurrent ownership snapshots serialize the entire read/merge/write operation without losing identities', () => temporary(async directory => {
  let active = 0; let maximum = 0; let sequence = 0;
  const run = { output: directory, manifest: { runId: 'owned-test', ports: null } };
  const owned = new OwnedProcesses(run, { execute: async (_script, args) => {
    const ledger = await readJson(args[args.indexOf('-InputFile') + 1]);
    assert.equal(ledger.runId, run.manifest.runId); assert.equal(ledger.known.length, sequence);
    active++; maximum = Math.max(maximum, active); await delay(1);
    const identity = { pid: 1000 + sequence, creationTime: `creation-${sequence++}` };
    active--; return JSON.stringify([identity]);
  } });
  const current = await Promise.all(Array.from({ length: 100 }, () => owned.snapshot()));
  assert.equal(maximum, 1); assert.equal(sequence, 100); assert.equal(current.length, 100);
  assert.equal(owned.known.length, 100); assert.equal(run.manifest.processes.length, 100);
  assert.equal((await readJson(owned.file)).known.length, 100);
}));
test('ownership monitor awaits each snapshot and stop drains the in-flight operation', async () => {
  let active = 0; let maximum = 0; let count = 0; let completeThird;
  const third = new Promise(resolve => { completeThird = resolve; });
  const monitor = monitorOwnedProcesses({ snapshot: async () => { active++; maximum = Math.max(maximum, active); const n = ++count; await delay(8); active--; if (n === 3) completeThird(); } }, { interval: 1 });
  await third; await monitor.stop(); const stoppedCount = count;
  await delay(15); assert.equal(active, 0); assert.equal(maximum, 1); assert.equal(count, stoppedCount);
});
test('ownership monitor does not hide snapshot failures from check or finally stop', async () => {
  const failure = new Error('ownership failed'); let called;
  const entered = new Promise(resolve => { called = resolve; });
  const monitor = monitorOwnedProcesses({ snapshot: async () => { called(); throw failure; } }, { interval: 1 });
  await entered; await assert.rejects(monitor.stop(), error => error === failure); assert.throws(() => monitor.check(), error => error === failure);
});
test('WebDriver fill clears through actual keyboard actions, including an empty value', async () => {
  const wd = new WebDriver('unused'); wd.sessionId = 'owned'; const calls = [];
  wd.find = async () => 'field'; wd.call = async (method, path, body) => { calls.push({ method, path, body }); };
  await wd.fill('input', '');
  assert.deepEqual(calls.map(call => call.path), ['/session/owned/element/field/click', '/session/owned/actions', '/session/owned/actions', '/session/owned/actions', '/session/owned/actions']);
  assert.equal(calls[1].body.actions[0].actions[0].value, '\uE009'); assert.equal(calls[1].body.actions[0].actions[1].value, 'a');
  assert.equal(calls[3].body.actions[0].actions[0].value, '\uE003'); assert(calls.every(call => !call.path.endsWith('/clear') && !call.path.endsWith('/execute/sync')));
  calls.length = 0; await wd.fill('input', 'real text'); assert.equal(calls.at(-1).path, '/session/owned/element/field/value'); assert.equal(calls.at(-1).body.text, 'real text');
});
test('CLI rejects positional, repeated, unknown and missing-value arguments', () => {
  assert.deepEqual(parseArgs(['--binary', 'app.exe', '--help'], { values: ['binary'], flags: ['help'] }), { binary: 'app.exe', help: true });
  for (const args of [['old-shared-session'], ['--bad'], ['--binary'], ['--binary', '--help'], ['--help', '--help']]) assert.throws(() => parseArgs(args, { values: ['binary'], flags: ['help'] }));
});
test('every run is exclusive and refuses both previous run and nonempty output', () => temporary(async directory => {
  const output = join(directory, 'new-run');
  await claimEmptyDirectory(output);
  await assert.rejects(claimEmptyDirectory(output), /new, empty/);
  const nonempty = join(directory, 'nonempty'); await mkdir(nonempty); await writeFile(join(nonempty, 'user-file'), 'preserve');
  await assert.rejects(claimEmptyDirectory(nonempty), /new, empty/);
  assert.equal(await readFile(join(nonempty, 'user-file'), 'utf8'), 'preserve');
}));
test('run manifest creates unique refs/profile/session scope and matching Rust manifest', () => temporary(async directory => {
  const a = await createRun(join(directory, 'a'), 'helper-test'); const b = await createRun(join(directory, 'b'), 'helper-test');
  assert.notEqual(a.manifest.runId, b.manifest.runId); assert.notEqual(a.manifest.refs.branch, b.manifest.refs.branch);
  assert.equal(a.manifest.session, null); assert.equal(a.manifest.ports, null);
  const config = await readJson(join(a.profileDirectory, 'test-manifest.json'));
  assert.equal(config.runId, a.manifest.runId); assert(samePath(config.webviewDataDirectory, join(a.profileDirectory, 'webview2')));
  for (const path of Object.values(config.git)) assert(inside(a.output, path));
}));
test('isolated Git environment removes inherited executable/config injection and redirects all homes', () => {
  const paths = { homeDirectory: join(tmpdir(), 'owned-home'), xdgConfigDirectory: join(tmpdir(), 'owned-home/.config'), globalConfig: join(tmpdir(), 'owned-home/.gitconfig'), systemConfig: join(tmpdir(), 'owned-home/system.gitconfig'), templateDirectory: join(tmpdir(), 'owned-home/templates') };
  const env = isolatedEnvironment(paths, { PATH: 'keep', HOME: 'user-home', APPDATA: 'user-appdata', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'untrusted', GIT_DIR: 'user.git', SSH_AUTH_SOCK: 'user-sock', WEBVIEW2_USER_DATA_FOLDER: 'user-webview', GCM_INTERACTIVE: 'Always' });
  assert.equal(env.PATH, 'keep'); assert.equal(env.HOME, paths.homeDirectory); assert.equal(env.USERPROFILE, paths.homeDirectory);
  assert.equal(env.GIT_CONFIG_GLOBAL, paths.globalConfig); assert.equal(env.GIT_CONFIG_SYSTEM, paths.systemConfig); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR', 'SSH_AUTH_SOCK', 'WEBVIEW2_USER_DATA_FOLDER']) assert.equal(env[key], undefined);
  assert(inside(paths.homeDirectory, env.APPDATA)); assert(inside(paths.homeDirectory, env.LOCALAPPDATA));
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'file'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
test('snapshot assertion checks HEAD, raw index/status and tracked/untracked content independently', () => {
  const before = { identity: { path: 'fixture' }, head: 'a', headFile: { sha256: 'head' }, index: { sha256: 'index' }, status: 'NUL-base64', tracked: [{ path: 'tracked', working: { sha256: 'tracked' } }], untracked: [{ path: 'untracked', working: { sha256: 'untracked' } }], refs: ['refs/heads/main a'] };
  assertSameSnapshot(before, structuredClone(before));
  for (const key of Object.keys(before)) { const after = structuredClone(before); after[key] = 'changed'; assert.throws(() => assertSameSnapshot(before, after), new RegExp(key)); }
});
test('notice verification checks every ownership hash and all MPL source archives', () => temporary(async directory => {
  const files = { 'THIRD_PARTY_NOTICES.md': 'notice full text', 'notices/source-availability.md': 'source guide', 'notices/sources/covered.crate': 'locked original source archive' };
  for (const [path, bytes] of Object.entries(files)) { const { dirname } = await import('node:path'); await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), bytes); }
  const archive = { output: 'notices/sources/covered.crate', sha256: sha256(files['notices/sources/covered.crate']), bytes: Buffer.byteLength(files['notices/sources/covered.crate']) };
  const manifest = { schemaVersion: 1, ownedFiles: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)])), packages: [{ name: 'covered', version: '1.0.0', declaredLicense: 'MPL-2.0', sourceArchive: archive }], findings: [] };
  await writeFile(join(directory, 'notices/manifest.json'), JSON.stringify(manifest));
  const result = await verifyNotices(directory); assert.equal(result.checkedFileCount, 3); assert.equal(result.mplArchives.length, 1); assert.equal(result.legalClearance, false);
  await writeFile(join(directory, archive.output), 'tampered'); await assert.rejects(verifyNotices(directory), /SHA-256 mismatch/);
}));
test('notice verifier refuses a missing MPL archive even if all other files hash correctly', () => temporary(async directory => {
  await mkdir(join(directory, 'notices')); await writeFile(join(directory, 'THIRD_PARTY_NOTICES.md'), 'full');
  await writeFile(join(directory, 'notices/manifest.json'), JSON.stringify({ schemaVersion: 1, ownedFiles: { 'THIRD_PARTY_NOTICES.md': sha256('full') }, packages: [{ name: 'covered', declaredLicense: 'MIT OR MPL-2.0' }] }));
  await assert.rejects(verifyNotices(directory), /MPL source archive missing/);
}));
test('archive whitelist retains generated full notices and excludes all local/build state', () => {
  for (const entry of ['scripts', 'notices', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'src-tauri/Cargo.lock']) assert(SOURCE_ENTRIES.includes(entry));
  for (const entry of ['artifacts', 'release', 'dist', '.git', '.zcode', 'node_modules', 'src-tauri/target']) assert(!SOURCE_ENTRIES.includes(entry));
  for (const path of ['../escape', '/absolute', 'C:/absolute', 'notices/../escape', 'notices\\escape', 'notices/x:stream', 'notices//x']) assert.throws(() => safeRelative(path));
});
test('release version comes from package and must match Tauri plus Cargo', () => temporary(async directory => {
  await mkdir(join(directory, 'src-tauri'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.2.0', productName: 'QGitGraph', identifier: 'app.qgitgraph.desktop' }));
  await writeFile(join(directory, 'src-tauri/Cargo.toml'), '[package]\nname = "qgitgraph"\nversion = "0.2.0"\n[dependencies]\n');
  assert.equal((await readVersion(directory)).version, '0.2.0');
  await writeFile(join(directory, 'src-tauri/Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  await assert.rejects(readVersion(directory), /Cargo version/);
}));
const reportFixture = (kind, overrides = {}) => ({ schemaVersion: 1, kind, status: 'passed', startedAt: '2026-11-21T06:00:00.000Z', finishedAt: '2026-11-21T06:02:00.000Z', results: [{ status: 'passed' }], ...overrides });
const parityLabels = [
  'inline details use an actual virtual-list slot',
  'explicit review starts and succeeds only on immutable commit content',
  'annotated tag exposes its actual tagger and complete annotation',
  'named branch scope can restrict history and restore all',
  'settings expose new defaults and preserve trust-private separation',
];
const integrationArgs = ['test', '--offline', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', ...['integration', 'operations_extra', 'history_parity', 'action_parity', 'host_parity'].flatMap(target => ['--test', target]), '--features', 'host-tests', '--', '--nocapture'];
const rustLog = 'test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\ntest result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n';
const rustFixture = (args = integrationArgs) => reportFixture('rust-integration', { counts: { passed: 60 }, command: { program: 'cargo', args, exitCode: 0 } });
test('real report summaries never convert blocked/failed/empty fixture reports into passes', () => {
  assert.throws(() => summarizeReport({ kind: 'fixture-only', status: 'passed' }));
  assert.throws(() => summarizeReport(reportFixture('installer', { status: 'blocked' })));
  assert.throws(() => summarizeReport(reportFixture('installer', { results: [] })), /No actual passing/);
  assert.throws(() => summarizeReport(reportFixture('installer', { results: [{ status: 'passed' }, { status: 'failed' }] })), /failed result/);
  const summary = summarizeReport(reportFixture('installer', { results: [{ status: 'passed' }, { status: 'blocked', requiredForBaseline: false }], binary: { sha256: 'abc' } }));
  assert.equal(summary.passed, 1); assert.equal(summary.blocked, 1); assert.equal(summary.binarySha256, 'abc');
});
test('release evidence requires matching report kind and schema, with a raw Vitest exception', () => {
  const frontend = { success: true, testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }] }], numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 };
  assert.equal(summarizeReport(frontend, 'frontend').passed, 1);
  for (const kind of ['rust-unit', 'rust-integration', 'desktop', 'installer', 'resources']) {
    assert.throws(() => summarizeReport(frontend, kind), /schema/);
    assert.throws(() => summarizeReport(reportFixture('different-kind'), kind), /kind/);
    for (const schemaVersion of [undefined, 0, 2, '1']) assert.throws(() => summarizeReport(reportFixture(kind, { schemaVersion }), kind), /schema/);
  }
  assert.throws(() => summarizeReport(reportFixture('installer'), 'frontend'), /kind/);
  assert.throws(() => summarizeReport({ ...frontend, schemaVersion: 2 }, 'frontend'), /schema/);
  assert.throws(() => summarizeReport({ ...frontend, testResults: [] }, 'frontend'), /Vitest report shape/);
  assert.throws(() => summarizeReport({ ...frontend, numPassedTests: '1' }, 'frontend'), /Vitest count/);
});
test('only explicitly optional blocked assertions are permitted in passed evidence', () => {
  for (const optional of [{}, { requiredForBaseline: true }, { requiredForBaseline: 0 }, { required: false }, { required: true, requiredForBaseline: false }]) {
    assert.throws(() => summarizeReport(reportFixture('installer', { results: [{ status: 'passed' }, { status: 'blocked', ...optional }] }), 'installer'), /blocked results/);
  }
  assert.equal(summarizeReport(reportFixture('installer', { results: [{ status: 'passed' }, { status: 'blocked', requiredForBaseline: false, required: false }] }), 'installer').blocked, 1);
});
test('desktop gate accepts a recorded parity suite or exact successful legacy parity checks', () => {
  assert.equal(summarizeReport(reportFixture('desktop', { suite: 'parity' }), 'desktop').passed, 1);
  assert.throws(() => summarizeReport(reportFixture('desktop', { suite: 'baseline' }), 'desktop'), /parity suite/);
  const results = parityLabels.map(label => ({ label, status: 'passed' }));
  assert.equal(summarizeReport(reportFixture('desktop', { results }), 'desktop').passed, parityLabels.length);
  assert.throws(() => summarizeReport(reportFixture('desktop'), 'desktop'), /Desktop parity evidence missing/);
  for (let index = 0; index < results.length; index++) {
    assert.throws(() => summarizeReport(reportFixture('desktop', { results: results.filter((_, i) => i !== index) }), 'desktop'), /Desktop parity evidence missing/);
    const blocked = structuredClone(results); blocked[index] = { ...blocked[index], status: 'blocked', passed: true, requiredForBaseline: false };
    assert.throws(() => summarizeReport(reportFixture('desktop', { results: blocked }), 'desktop'), /Desktop parity evidence missing/);
  }
  const renamed = structuredClone(results); renamed[0].label += ' (approximate)';
  assert.throws(() => summarizeReport(reportFixture('desktop', { results: renamed }), 'desktop'), /Desktop parity evidence missing/);
});
test('resource gate requires 60 seconds idle and a finite positive bounded CPU snapshot window', () => {
  const measurement = { idleSeconds: 65, sampleCount: 3, cpuWindowSeconds: 46.2 };
  assert.equal(summarizeReport(reportFixture('resources', { measurement }), 'resources').passed, 1);
  assert.doesNotThrow(() => summarizeReport(reportFixture('resources', { measurement: { idleSeconds: 60, sampleCount: 2, cpuWindowSeconds: 60 } }), 'resources'));
  assert.throws(() => summarizeReport(reportFixture('resources'), 'resources'), /60 seconds/);
  for (const idleSeconds of [undefined, 59.99, '65', NaN, Infinity]) assert.throws(() => summarizeReport(reportFixture('resources', { measurement: { ...measurement, idleSeconds } }), 'resources'), /60 seconds/);
  for (const sampleCount of [undefined, 0, 1, 2.5, '3', Infinity]) assert.throws(() => summarizeReport(reportFixture('resources', { measurement: { ...measurement, sampleCount } }), 'resources'), /two snapshots/);
  for (const cpuWindowSeconds of [undefined, 0, -1, 65.1, '46.2', NaN, Infinity]) assert.throws(() => summarizeReport(reportFixture('resources', { measurement: { ...measurement, cpuWindowSeconds } }), 'resources'), /CPU counter window/);
});
test('Rust integration evidence requires all five explicit targets and the exact host-tests feature', () => {
  assert.equal(validateRustEvidence(rustFixture(), rustLog), 60);
  for (const target of ['integration', 'operations_extra', 'history_parity', 'action_parity', 'host_parity']) {
    const args = [...integrationArgs]; args.splice(args.indexOf(target) - 1, 2);
    assert.throws(() => validateRustEvidence(rustFixture(args), rustLog), new RegExp(`test target: ${target}`));
  }
  for (const feature of ['', 'not-host-tests', 'host-tests-extra']) {
    const args = [...integrationArgs]; args[args.indexOf('host-tests')] = feature;
    assert.throws(() => validateRustEvidence(rustFixture(args), rustLog), /explicitly enable host-tests/);
  }
  const noFeatures = integrationArgs.filter(arg => !['--features', 'host-tests'].includes(arg));
  assert.throws(() => validateRustEvidence(rustFixture([...noFeatures, '--features', 'host-tests']), rustLog), /explicitly enable host-tests/);
  const afterSeparator = integrationArgs.slice(0, integrationArgs.indexOf('--test'));
  assert.throws(() => validateRustEvidence(rustFixture([...afterSeparator, '--features', 'host-tests', '--', ...integrationArgs.slice(integrationArgs.indexOf('--test'))]), rustLog), /test target/);
  const equalsArgs = ['test', ...['integration', 'operations_extra', 'history_parity', 'action_parity', 'host_parity'].map(target => `--test=${target}`), '--features=other,host-tests', '--', '--nocapture'];
  assert.equal(validateRustEvidence(rustFixture(equalsArgs), rustLog), 60);
});
test('Rust evidence rejects SKIP markers, unsuccessful commands and missing successful summaries', () => {
  for (const marker of ['SKIP real SSH crypto: no installed ssh-keygen executable', 'skipped SSH prerequisite', 'Skip: prerequisite unavailable']) assert.throws(() => validateRustEvidence(rustFixture(), `${rustLog}${marker}\n`), /SKIP marker/);
  assert.throws(() => validateRustEvidence(rustFixture(), 'Finished compiling without tests'), /successful Rust test summaries/);
  assert.throws(() => validateRustEvidence(rustFixture(), 'test result: ok. 1 passed; 1 failed; 0 ignored;'), /successful Rust test summaries/);
  assert.throws(() => validateRustEvidence(rustFixture([...integrationArgs.slice(0, -2), '--no-run']), rustLog), /execute tests/);
  assert.throws(() => validateRustEvidence({ ...rustFixture(), command: { ...rustFixture().command, exitCode: 1 } }, rustLog), /exit successfully/);
  assert.throws(() => validateRustEvidence({ ...rustFixture(), command: { ...rustFixture().command, program: 'other' } }, rustLog), /actual cargo/);
  assert.throws(() => validateRustEvidence(rustFixture(['build']), rustLog), /cargo test arguments/);
  assert.equal(validateRustEvidence(reportFixture('rust-unit', { command: { program: 'cargo', args: ['test', '--lib'], exitCode: 0 } }), 'test result: ok. 53 passed; 0 failed; 0 ignored;'), 53);
});
test('public release metadata rejects drive/UNC/home source paths, allows official URLs', () => {
  for (const path of ['C:\\workspace\\example-project', 'C:/Users/example/profile', '\\\\server\\private', '/home/person/source']) assert.throws(() => publicMetadata({ nested: [{ path }] }));
  assert.doesNotThrow(() => publicMetadata({ source: 'https://static.crates.io/crates/example/example.crate', path: 'QGitGraph-0.2.0-source.zip' }));
});
test('percentiles and size comparisons use actual inputs and do not invent measurements', () => {
  assert.equal(percentile([], 0.5), null); assert.equal(percentile([10, 20, 30, 40], 0.5), 25); assert.equal(percentile([10, 20, 30, 40], 0.95), 38.5);
  assert.equal(sizeComparison({ executableBytes: 1 }).installerNineMiB.status, 'blocked');
  assert.equal(sizeComparison({ executableBytes: 100, installerBytes: 9 * 1024 * 1024, referenceExecutableBytes: 200 }).executableComparison.ratio, 0.5);
});
test('WebDriver selectors reject ambiguous matches instead of choosing DOM order', async () => {
  const wd = new WebDriver('unused'); wd.sessionId = 'owned'; wd.call = async () => [{ 'element-6066-11e4-a52e-4f735466cecf': 'one' }, { 'element-6066-11e4-a52e-4f735466cecf': 'two' }];
  await assert.rejects(wd.find('button'), /exactly one element/);
});
test('WebDriver operation wait requires actual task-sequence progress and idle, not git-version text', async () => {
  const wd = new WebDriver('unused'); let index = 0;
  const states = [{ taskState: 'idle', taskSequence: '10', errors: [] }, { taskState: 'running', taskSequence: '10', errors: [] }, { taskState: 'idle', taskSequence: '11', errors: [] }];
  wd.state = async () => states[Math.min(index++, states.length - 1)];
  assert.equal((await wd.idle('completion', 10)).taskSequence, '11'); assert.equal(index, 3);
});
