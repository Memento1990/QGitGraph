import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { WebDriver } from './desktop.mjs';
import { PROJECT } from './run.mjs';
import { percentile } from './metrics.mjs';
import {
  VUE_RESOURCE_SELECTORS as selectors, READ_RESOURCE_VUE_DOM, parseResourceOptions,
  assertResourceVueState, createResourceFrontend, assertResourceReadOnlyProfile,
  assertSameResourceBinary, resourceProcessGroups,
} from '../measure-resources.mjs';

// Unit-only fake WebDriver wire protocol, in a fresh OS temp directory. No Git,
// native application, real driver, browser or private repository is accessed.
// Its invented DOM/metrics are never written as native resource evidence.
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const oid = 'a'.repeat(40);
async function temporary(work) {
  const directory = await mkdtemp(join(tmpdir(), 'qgitgraph-resource-unit-'));
  try { return await work(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function fakeDesktop(work) {
  return temporary(async directory => {
    const output = join(directory, 'run'), profileDirectory = join(output, 'profile'), repository = join(output, 'fixtures', 'lighthouse 中文');
    await mkdir(profileDirectory, { recursive: true }); await mkdir(repository, { recursive: true });
    const expected = { identity: { path: repository, gitDir: join(repository, '.git'), bare: false }, head: oid };
    const fixtures = { repositories: { base: repository }, head: oid, snapshots: { base: expected } };
    const run = { output, profileDirectory, manifest: { results: [] }, save: async () => { fake.saves++; } };
    const boot = { rootCount: 1, repoPath: '', repoHead: '', taskState: 'idle', taskSequence: '0', configDirectory: profileDirectory, hostMode: 'desktop', actionBusy: 'false', locale: 'en', errors: [], dialogCount: 0, openForm: false, openMode: null, openPath: null, trustVisible: false, trusted: null, commitDisabled: null, refreshReady: false, historyReady: false, headRendered: false };
    const fake = { state: boot, pending: [], calls: [], clicks: [], fills: [], scripts: [], observations: [], saves: 0 };
    const allowed = Object.values(selectors);
    const server = createServer(async (request, response) => {
      try {
        let bytes = ''; for await (const chunk of request) bytes += chunk;
        const body = bytes ? JSON.parse(bytes) : undefined, path = request.url;
        fake.calls.push({ method: request.method, path, body });
        let value = null;
        if (request.method === 'POST' && path === '/session/unit/execute/sync') {
          assert.equal(body.script, READ_RESOURCE_VUE_DOM, 'Only the observation-only resource reader is allowed.');
          assert.deepEqual(body.args, []); fake.scripts.push(body.script);
          value = structuredClone(fake.pending.length ? fake.pending.shift() : fake.state); fake.observations.push(value);
        } else if (request.method === 'POST' && path === '/session/unit/elements') {
          assert.equal(body.using, 'css selector');
          const selector = body.value;
          assert(allowed.includes(selector), `Unexpected/unsafe resource selector: ${selector}`);
          assert.equal(selector !== selectors.open && selector !== selectors.refresh ? fake.state.openForm : true, true);
          value = [{ [ELEMENT]: String(allowed.indexOf(selector)) }];
        } else if (request.method === 'POST' && /^\/session\/unit\/element\/\d+\/click$/.test(path)) {
          const selector = allowed[Number(path.split('/')[4])]; fake.clicks.push(selector);
          if (selector === selectors.open) Object.assign(fake.state, { openForm: true, dialogCount: 1, openMode: 'directory', openPath: '' });
          else if (selector === selectors.repositoryOption) fake.state.openMode = 'repository';
          else if (selector === selectors.submit) {
            assert.equal(fake.state.openMode, 'repository'); assert.equal(fake.state.openPath, repository);
            const before = structuredClone(fake.state);
            Object.assign(fake.state, { repoPath: repository, repoHead: oid, taskSequence: '3', openForm: false, dialogCount: 0, trustVisible: true, trusted: false, commitDisabled: true, refreshReady: true, historyReady: true, headRendered: true });
            fake.pending = [before, { ...structuredClone(fake.state), taskState: 'running', taskSequence: '1', historyReady: false }, { ...structuredClone(fake.state), taskSequence: '2', historyReady: false }];
            fake.onSubmit?.();
          } else if (selector === selectors.refresh) {
            const before = structuredClone(fake.state);
            fake.state.taskSequence = String(Number(fake.state.taskSequence) + 2);
            fake.pending = [before, { ...structuredClone(fake.state), taskState: 'running', refreshReady: false }];
            fake.onRefresh?.(before);
          }
        } else if (request.method === 'POST' && /^\/session\/unit\/element\/\d+\/value$/.test(path)) {
          assert.equal(allowed[Number(path.split('/')[4])], selectors.path);
          assert.equal(body.text, repository); assert.deepEqual(body.value, [...repository]);
          fake.state.openPath = body.text; fake.fills.push(body.text);
        } else if (path === '/session/unit/actions' && ['POST', 'DELETE'].includes(request.method)) {
          // Native WebDriver key actions used by WebDriver.fill, never script mutation.
          if (body?.actions?.some(action => action.actions?.some(key => key.value === '\uE003'))) fake.state.openPath = '';
        } else assert.fail(`Unexpected WebDriver call: ${request.method} ${path}`);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value: { error: 'unit contract violation', message: error.message } }));
      }
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const wd = new WebDriver(`http://127.0.0.1:${server.address().port}`); wd.sessionId = 'unit';
    const ui = createResourceFrontend(run, wd, fixtures, 'vue', { timeout: 150, interval: 1 });
    try { return await work({ directory, run, fixtures, wd, ui, fake }); }
    finally { server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); }
  });
}
const argumentsFor = (output = resolve(PROJECT, 'artifacts/resource-unit-unused')) => ['--binary', 'supplied.exe', '--output', output];
const source = () => readFile(new URL('../measure-resources.mjs', import.meta.url), 'utf8');

test('resource entry imports safely; CLI keeps default legacy and strictly selects vue', () => {
  assert.equal(parseResourceOptions(argumentsFor()).frontend, 'legacy');
  assert.equal(parseResourceOptions([...argumentsFor(), '--frontend', 'vue']).frontend, 'vue');
  assert.equal(parseResourceOptions([...argumentsFor(), '--frontend', 'legacy']).frontend, 'legacy');
  assert.equal(parseResourceOptions([...argumentsFor(), '--interactive-samples', '0'])['interactive-samples'], '0');
  assert.deepEqual(parseResourceOptions(['--help']), { help: true });
  for (const extra of [['--frontend', 'browser'], ['--frontend', 'Vue'], ['--frontend', ''], ['--frontend'], ['--frontend', 'vue', '--frontend', 'legacy'], ['--repository', 'not-allowed'], ['--trust'], ['--install'], ['--seconds', '59'], ['--seconds', '3601'], ['--seconds', 'Infinity'], ['--interactive-samples', '-1'], ['--interactive-samples', '1.5'], ['--interactive-samples', '51']]) assert.throws(() => parseResourceOptions([...argumentsFor(), ...extra]));
  assert.throws(() => parseResourceOptions([]));
  for (const output of [PROJECT, join(PROJECT, 'artifacts'), join(PROJECT, 'docs/unit-evidence')]) assert.throws(() => parseResourceOptions([...argumentsFor(output), '--frontend', 'vue']));
  // Legacy callers retain their existing output-path behavior.
  assert.equal(parseResourceOptions(argumentsFor(join(PROJECT, 'old-output'))).frontend, 'legacy');
});

test('Vue startup uses actual repository option/path submit, not legacy DOM, discovery or trust', async () => fakeDesktop(async ({ run, fixtures, ui, fake }) => {
  const state = await ui.open();
  assert.equal(state.repoPath, fixtures.repositories.base); assert.equal(state.repoHead, oid); assert.equal(state.trusted, false);
  assert.deepEqual(fake.clicks, [selectors.open, selectors.mode, selectors.repositoryOption, selectors.path, selectors.submit]);
  assert.deepEqual(fake.fills, [fixtures.repositories.base]); assert(fake.observations.some(state => state.taskState === 'running'));
  assert(fake.observations.some(state => state.taskState === 'idle' && state.repoPath && !state.historyReady));
  assert.equal(run.manifest.results[0].observed.taskSequenceBefore, 0); assert.equal(run.manifest.results[0].observed.taskSequenceAfter, 3);
  assert.equal(run.manifest.results[0].source, 'automated-test'); assert.equal(fake.saves, 1);
  assert(fake.calls.some(call => call.path.endsWith('/value'))); assert(fake.calls.some(call => call.path.endsWith('/actions')));
  assert(fake.scripts.every(script => script === READ_RESOURCE_VUE_DOM));
}));

test('Vue refresh waits for real sequence advancement AND idle with exact identity', async () => fakeDesktop(async ({ wd, ui, fake }) => {
  await ui.open(); const before = await ui.idle('ready'); const start = fake.observations.length;
  await wd.click(ui.refreshSelector); const complete = await ui.idle('completed actual refresh', before.taskSequence);
  assert.equal(ui.refreshSelector, '.repository-commandbar button[aria-label="Refresh current repository"]');
  assert.equal(complete.taskSequence, '5'); assert.equal(complete.repoHead, oid);
  const seen = fake.observations.slice(start);
  assert(seen.some(state => state.taskState === 'idle' && state.taskSequence === '3'), 'Old idle is not completion.');
  assert(seen.some(state => state.taskState === 'running' && state.taskSequence === '5'), 'Advancement while running is not completion.');
  assert.equal(seen.at(-1).taskState, 'idle');
}));

test('Vue unchanged idle or permanently running sequence never passes refresh', async t => {
  for (const kind of ['unchanged', 'running']) await t.test(kind, async () => fakeDesktop(async ({ wd, ui, fake }) => {
    await ui.open(); const before = await ui.idle('ready');
    fake.onRefresh = previous => { fake.pending = []; if (kind === 'unchanged') fake.state = previous; else fake.state.taskState = 'running'; };
    await wd.click(ui.refreshSelector);
    await assert.rejects(ui.idle('must not invent completion', before.taskSequence), /Timed out/);
  }));
});

test('Vue boot rejects wrong mode/profile or prior repository before any UI input', async t => {
  for (const [key, value] of [['hostMode', 'demo'], ['hostMode', 'browser'], ['hostMode', null], ['configDirectory', resolve('different-profile')], ['repoPath', resolve('not-the-fixture')], ['repoHead', oid]]) await t.test(`${key} ${value}`, async () => fakeDesktop(async ({ ui, fake }) => {
    fake.state[key] = value; await assert.rejects(ui.open()); assert.deepEqual(fake.clicks, []); assert.deepEqual(fake.fills, []);
  }));
});

test('Vue open and refresh reject identity drift, hidden trust or write-capable mode', async t => {
  for (const phase of ['open', 'refresh']) for (const [key, value] of [['hostMode', 'demo'], ['configDirectory', resolve('other-profile')], ['repoPath', resolve('other-fixture')], ['repoHead', 'b'.repeat(40)], ['trusted', true], ['trustVisible', false], ['commitDisabled', false], ['actionBusy', 'true'], ['errors', ['Actual UI failure']]]) await t.test(`${phase} ${key}`, async () => fakeDesktop(async ({ ui, wd, fake }) => {
    const change = () => { fake.pending = []; fake.state[key] = value; };
    if (phase === 'open') { fake.onSubmit = change; await assert.rejects(ui.open()); }
    else { await ui.open(); const before = await ui.idle('ready'); fake.onRefresh = change; await wd.click(ui.refreshSelector); await assert.rejects(ui.idle('actual refresh', before.taskSequence)); }
  }));
});

test('Vue diagnostics fail closed on missing, unsafe or regressing task contract', async () => fakeDesktop(async ({ run, fixtures, ui, fake }) => {
  await ui.open(); const valid = structuredClone(fake.state);
  assert.equal(assertResourceVueState(valid, run.profileDirectory, 3, fixtures.snapshots.base), 3);
  assert.throws(() => assertResourceVueState(null, run.profileDirectory));
  assert.throws(() => assertResourceVueState(valid, run.profileDirectory, 4, fixtures.snapshots.base), /regressed/);
  for (const sequence of [undefined, '', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) assert.throws(() => assertResourceVueState({ ...valid, taskSequence: sequence }, run.profileDirectory, undefined, fixtures.snapshots.base));
  for (const changed of [{ rootCount: 2 }, { locale: 'zh-CN' }, { taskState: 'pretend-success' }, { taskState: undefined }, { configDirectory: '' }]) assert.throws(() => assertResourceVueState({ ...valid, ...changed }, run.profileDirectory, undefined, fixtures.snapshots.base));
}));

test('Vue helper never opens a non-run-owned fixture or mismatched independent Git identity', async () => fakeDesktop(async ({ run, fixtures, wd }) => {
  for (const change of [value => { value.repositories.base = resolve('different-repository'); }, value => { value.snapshots.base.identity.path = resolve('different-repository'); }, value => { value.snapshots.base.identity.gitDir = resolve('external-gitdir'); }, value => { value.snapshots.base.identity.bare = true; }, value => { value.head = 'b'.repeat(40); }]) {
    const invalid = structuredClone(fixtures); change(invalid); assert.throws(() => createResourceFrontend(run, wd, invalid, 'vue'));
  }
  assert.throws(() => createResourceFrontend(run, wd, fixtures, 'browser'));
}));

test('legacy default helper delegates unchanged openFixture and data-action refresh', () => {
  const calls = [], wd = { idle: async (...args) => { calls.push(args); return { taskSequence: '9' }; } };
  const ui = createResourceFrontend({}, wd, {});
  assert.equal(ui.refreshSelector, 'button[data-action="refresh"]');
  return ui.idle('legacy actual refresh', '8').then(value => { assert.equal(value.taskSequence, '9'); assert.deepEqual(calls, [['legacy actual refresh', '8']]); });
});

test('embedded Vue reader compiles and only observes DOM; refresh and open selectors track product', async () => {
  new vm.Script(`(function(){${READ_RESOURCE_VUE_DOM}})()`);
  assert.doesNotMatch(READ_RESOURCE_VUE_DOM, /__TAURI|__QGITGRAPH|__vue|\binvoke\s*\(|\bfetch\s*\(|dispatchEvent|new\s+(?:Event|MouseEvent)|\.click\s*\(|\.focus\s*\(|scrollIntoView|\.value\s*=(?!=)|textContent\s*=(?!=)|innerHTML|outerHTML|appendChild|removeChild|localStorage|sessionStorage|\beval\s*\(/);
  const app = await readFile(new URL('../../src/App.vue', import.meta.url), 'utf8'), dialog = await readFile(new URL('../../src/components/RepositoryOpenDialog.vue', import.meta.url), 'utf8');
  for (const word of ['data-config-directory', 'data-host-mode', 'data-task-sequence', 'data-task-state', 'data-repo-path', 'data-repo-head', 'Refresh current repository', 'trust-chip']) assert(app.includes(word));
  for (const word of ['open-form', 'path-input', 'value="repository"', 'type="submit"']) assert(dialog.includes(word));
  assert(!Object.values(selectors).some(selector => /data-action|trust|sync|commit|nth-child/.test(selector)));
});

test('DOM reader observes actual full HEAD row, busy history, form values and read-only controls', async () => fakeDesktop(async ({ run, fixtures }) => {
  const visible = value => ({ hidden: false, getClientRects: () => [{}], ...value });
  const shell = { dataset: { repoPath: fixtures.repositories.base, repoHead: oid, taskState: 'idle', taskSequence: '7', configDirectory: run.profileDirectory, hostMode: 'desktop', actionBusy: 'false' } };
  const select = { value: 'repository' }, input = { value: fixtures.repositories.base }, trust = visible({ classList: { contains: () => false } }), refresh = visible({ disabled: false }), commit = { disabled: true };
  const history = visible({ getAttribute: () => 'false', querySelector: selector => selector === `[id="history-row-${oid}"]` ? {} : null });
  const form = visible({ querySelector: selector => selector === 'select' ? select : selector === '.path-input input' ? input : null });
  const document = { documentElement: { lang: 'en' }, querySelectorAll: selector => selector === '.app-shell' ? [shell] : selector === '[role="dialog"] .open-form' || selector === '[role="dialog"]' ? [form] : [],
    querySelector: selector => selector === '.repository-commandbar .trust-chip' ? trust : selector === selectors.refresh ? refresh : selector === '.repository-commandbar > button.primary' ? commit : selector === '.hp-list' ? history : null };
  const read = () => vm.runInNewContext(`(function(){${READ_RESOURCE_VUE_DOM}})()`, { document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const result = read(); assert.equal(result.hostMode, 'desktop'); assert.equal(result.configDirectory, run.profileDirectory); assert.equal(result.headRendered, true); assert.equal(result.historyReady, true); assert.equal(result.trusted, false); assert.equal(result.commitDisabled, true); assert.equal(result.openMode, 'repository'); assert.equal(result.openPath, fixtures.repositories.base);
  shell.dataset.repoHead = 'b'.repeat(40); assert.equal(read().headRendered, false);
  history.getAttribute = () => 'true'; assert.equal(read().historyReady, false);
  trust.getClientRects = () => []; assert.equal(read().trustVisible, false);
}));

test('profile verification is a pure read and rejects every legacy/native trust write', async () => temporary(async profileDirectory => {
  const run = { profileDirectory };
  await writeFile(join(profileDirectory, 'state.json'), JSON.stringify({ trusted: [] }));
  assert.deepEqual(await assertResourceReadOnlyProfile(run), { status: 'passed', trusted: 0, nativeTrustFileWritten: false });
  assert.deepEqual(await readdir(profileDirectory), ['state.json']);
  await writeFile(join(profileDirectory, 'state.json'), JSON.stringify({ trusted: ['fake-owned-fixture'] }));
  await assert.rejects(assertResourceReadOnlyProfile(run), /never persist/);
  await writeFile(join(profileDirectory, 'state.json'), JSON.stringify({ trusted: [] }));
  await writeFile(join(profileDirectory, 'native-trust.json'), JSON.stringify({ version: 1, rules: [] }));
  await assert.rejects(assertResourceReadOnlyProfile(run), /must not write native trust/);
}));

test('binary integrity requires same absolute path, size and SHA-256 before and after', () => {
  const before = { path: resolve('unit-owned.exe'), bytes: 123, sha256: '1'.repeat(64) };
  assert.doesNotThrow(() => assertSameResourceBinary(before, { ...before }));
  for (const changed of [{ path: resolve('other.exe') }, { bytes: 124 }, { sha256: '2'.repeat(64) }]) assert.throws(() => assertSameResourceBinary(before, { ...before, ...changed }));
});

test('process grouping pins exact application identity and separates WebView/Git from instrumentation/brokers', () => {
  const binary = { path: resolve('unit-owned.exe') };
  const process = (pid, parentPid, executable, second = pid) => ({ pid, parentPid, executable, creationTime: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(), workingSetBytes: 100, privateBytes: 50, cpuSeconds: 1 });
  const app = process(10, 1, binary.path), webview = process(11, 10, resolve('msedgewebview2.exe')), git = process(12, 10, resolve('git.exe')), child = process(13, 11, resolve('msedgewebview2.exe'));
  const driver = process(1, 99, resolve('tauri-driver.exe')), nativeDriver = process(2, 1, resolve('msedgedriver.exe')), broker = process(14, 10, resolve('ctfmon.exe')), staleParent = process(15, 10, resolve('instrumentation.exe'), 5);
  const sample = { processes: [child, nativeDriver, git, webview, app, driver, broker, staleParent] };
  const grouped = resourceProcessGroups(sample, binary, app);
  assert.deepEqual(grouped.appProcesses.map(item => item.pid).sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.deepEqual(grouped.instrumentation.map(item => item.pid).sort((a, b) => a - b), [1, 2, 15]); assert.deepEqual(grouped.systemBrokers.map(item => item.pid), [14]);
  assert.throws(() => resourceProcessGroups(sample, binary, { ...app, creationTime: process(10, 1, binary.path, 9).creationTime }), /identity changed/);
  assert.throws(() => resourceProcessGroups({ processes: sample.processes.filter(item => item !== app) }, binary, app), /Exactly one/);
  assert.throws(() => resourceProcessGroups({ processes: [...sample.processes, { ...app, pid: 20 }] }, binary, app), /Exactly one/);
  for (const changed of [{ creationTime: '' }, { cpuSeconds: NaN }, { privateBytes: -1 }, { workingSetBytes: undefined }]) assert.throws(() => resourceProcessGroups({ processes: [{ ...app, ...changed }] }, binary, app));
});

test('zero latency never bypasses startup/driver gate; real idle loop and percentile mathematics remain intact', async () => {
  const text = await source();
  assert(text.includes("createRun(options.output, 'resources')")); assert(text.includes('run.manifest.frontend = options.frontend'));
  assert(text.includes("run.manifest.actualMeasurements = { startup: false, interactive: false, idle: false }"));
  assert(text.indexOf('if (!options.driver)') < text.indexOf('await createFixtures(run)'));
  assert(text.indexOf('await ui.open()') < text.indexOf('for (let i = 0; i < sampleCount; i++)'));
  assert(text.includes("run.env.GIT_ALLOW_PROTOCOL = ''")); assert(text.includes('seconds >= 60'));
  assert(text.includes('while ((performance.now() - idleBegan) / 1000 < seconds)'));
  assert(text.includes('Math.max(0, value - firstCpu.get(key))')); assert(text.includes('cpuDelta / cpuWindowSeconds * 100'));
  assert(text.includes('`${process.pid}:${process.creationTime}`')); assert(text.includes('await owned.cleanup()'));
  assert(text.includes("'binary-before.json'")); assert(text.includes("'binary-after.json'")); assert(text.includes("'repository-after.json'"));
  assert(text.includes('assertSameSnapshot(fixtures.snapshots[name], after[name], name)'));
  assert(text.indexOf('await owned.cleanup()') < text.indexOf('after[name] = await repositorySnapshot'));
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25); assert.equal(percentile([10, 20, 30, 40], 0.95), 38.5);
});
