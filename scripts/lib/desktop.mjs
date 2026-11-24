import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT, errorInfo, executable, fingerprint, json, powershell, samePath, until } from './run.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const helper = join(PROJECT, 'scripts/lib/windows-processes.ps1');
export class BlockedError extends Error { constructor(message) { super(message); this.name = 'BlockedError'; } }
export async function reservePorts() {
  const reservations = [];
  try {
    for (let i = 0; i < 2; i++) {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
      reservations.push(server);
    }
    const ports = { webdriver: reservations[0].address().port, native: reservations[1].address().port };
    return { ports, release: () => Promise.all(reservations.map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))) };
  } catch (error) { for (const server of reservations) server.close(); throw error; }
}
export class OwnedProcesses {
  constructor(run, { execute = powershell } = {}) {
    this.run = run; this.file = join(run.output, 'process-ownership.json'); this.roots = []; this.known = [];
    this.execute = execute; this.pending = Promise.resolve();
  }
  enqueue(work) {
    const operation = this.pending.then(work);
    // Preserve each caller's rejection while allowing finally/cleanup to run.
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async saveCurrent() { await json(this.file, { schemaVersion: 1, runId: this.run.manifest.runId, roots: this.roots, known: this.known, ports: this.run.manifest.ports }); }
  save() { return this.enqueue(() => this.saveCurrent()); }
  add(pid) {
    return this.enqueue(async () => {
      const identity = JSON.parse(await this.execute(helper, ['-Action', 'Inspect', '-ProcessId', pid]));
      this.roots.push(identity); await this.saveCurrent(); return identity;
    });
  }
  async snapshotCurrent() {
    await this.saveCurrent();
    const value = JSON.parse(await this.execute(helper, ['-Action', 'Snapshot', '-InputFile', this.file]));
    const current = Array.isArray(value) ? value : value ? [value] : [];
    const identities = new Map([...this.known, ...current].map(item => [`${item.pid}:${item.creationTime}`, item]));
    this.known = [...identities.values()];
    this.run.manifest.processes = this.known;
    await this.saveCurrent();
    return current;
  }
  snapshot() { return this.enqueue(() => this.snapshotCurrent()); }
  cleanup() {
    return this.enqueue(async () => {
      if (!this.roots.length) return { stopped: [], remaining: [], errors: [], scope: 'No child processes were launched.' };
      await this.snapshotCurrent();
      return JSON.parse(await this.execute(helper, ['-Action', 'Cleanup', '-InputFile', this.file]));
    });
  }
}
export function monitorOwnedProcesses(owned, { interval = 1000 } = {}) {
  const stopSignal = new AbortController();
  const finished = (async () => {
    while (!stopSignal.signal.aborted) {
      // One iteration owns its complete save/read/merge/save operation. The
      // cadence starts only after it finishes; slow snapshots never overlap.
      await owned.snapshot();
      if (stopSignal.signal.aborted) return;
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); stopSignal.signal.removeEventListener('abort', wake); resolve(); };
        const timer = setTimeout(wake, interval);
        stopSignal.signal.addEventListener('abort', wake, { once: true });
      });
    }
  })();
  // Attach a handler immediately so a background failure is not an unhandled
  // rejection. check()/stop() still propagate it to the run report.
  let failure;
  void finished.catch(error => { failure = error; });
  return {
    check() { if (failure) throw failure; },
    async stop() { stopSignal.abort(); await finished; },
  };
}
export class WebDriver {
  constructor(endpoint) { this.endpoint = endpoint; this.sessionId = null; this.commands = []; }
  async call(method, path, body, timeout = 60000) {
    const start = Date.now();
    const entry = { method, path, startedAt: new Date().toISOString() };
    this.commands.push(entry);
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      });
      const data = await response.json();
      entry.durationMs = Date.now() - start; entry.ok = response.ok && !data.value?.error;
      if (!entry.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
      return data.value;
    } catch (error) { entry.error = String(error.message); throw error; }
  }
  get prefix() { if (!this.sessionId) throw new Error('No run-owned WebDriver session.'); return `/session/${this.sessionId}`; }
  async script(script, args = []) { return this.call('POST', `${this.prefix}/execute/sync`, { script, args }); }
  async find(selector) {
    const items = await this.call('POST', `${this.prefix}/elements`, { using: 'css selector', value: selector });
    if (items.length !== 1) throw new Error(`Selector must identify exactly one element, got ${items.length}: ${selector}`);
    return items[0][ELEMENT];
  }
  async click(selector) {
    try { return await this.clickElement(await this.find(selector)); }
    catch (error) {
      if (!String(error.message).includes('stale element reference')) throw error;
      await this.script('return {active:document.activeElement?.getAttribute("aria-label"),task:document.querySelector(".app-shell")?.dataset.taskState};');
      return this.clickElement(await this.find(selector));
    }
  }
  async clickElement(id) { await this.call('POST', `${this.prefix}/element/${id}/click`, {}); }
  async textElement(scope, exact) {
    const result = await this.script('const items=[...document.querySelectorAll(arguments[0])].filter(e=>e.getClientRects().length && e.textContent.trim()===arguments[1]); if(items.length!==1) throw new Error("Expected one visible exact-label control, got "+items.length+": "+arguments[1]); return items[0];', [scope, exact]);
    if (!result?.[ELEMENT]) throw new Error(`No unique exact-label element: ${exact}`);
    return result[ELEMENT];
  }
  async clickText(scope, exact) { await this.clickElement(await this.textElement(scope, exact)); }
  async fill(selector, text) {
    const element = await this.find(selector);
    await this.clickElement(element);
    await this.chord('\uE009', 'a');
    await this.keys(['\uE003']);
    if (text) await this.call('POST', `${this.prefix}/element/${element}/value`, { text, value: [...text] });
  }
  async select(selector, value) {
    const option = await this.script('const s=document.querySelector(arguments[0]); if(!s || s.tagName!=="SELECT") throw new Error("Select missing"); const o=[...s.options].filter(o=>o.value===arguments[1]); if(o.length!==1) throw new Error("Select option missing/ambiguous"); return o[0];', [selector, value]);
    await this.clickElement(option[ELEMENT]);
  }
  async keys(keys) {
    const actions = [];
    for (const key of keys) actions.push({ type: 'keyDown', value: key }, { type: 'keyUp', value: key });
    await this.call('POST', `${this.prefix}/actions`, { actions: [{ type: 'key', id: 'run-keyboard', actions }] });
    await this.call('DELETE', `${this.prefix}/actions`);
  }
  async chord(modifier, key) {
    await this.call('POST', `${this.prefix}/actions`, { actions: [{ type: 'key', id: 'run-keyboard', actions: [{ type: 'keyDown', value: modifier }, { type: 'keyDown', value: key }, { type: 'keyUp', value: key }, { type: 'keyUp', value: modifier }] }] });
    await this.call('DELETE', `${this.prefix}/actions`);
  }
  async state() {
    return this.script('const e=document.querySelector(".app-shell");const legacy=[...document.querySelectorAll(".errorbar:not([hidden]),dialog[open] .form-error:not([hidden])")];const vue=[...document.querySelectorAll(".notice-strip.error[role=alert],.ch-error[role=alert],.hp-error[role=alert],.ci-state[role=alert],.dp-state[role=alert],[role=dialog] [role=alert]")].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=="none"&&getComputedStyle(e).visibility!=="hidden");return e ? {repoPath:e.dataset.repoPath,repoHead:e.dataset.repoHead,taskState:e.dataset.taskState,taskSequence:e.dataset.taskSequence,configDirectory:e.dataset.configDirectory,errors:[...new Set([...legacy,...vue])].map(e=>e.innerText)} : null;');
  }
  async idle(label, afterSequence) {
    return until(label, async () => {
      const state = await this.state();
      if (!state) return false;
      if (!['idle', 'running', 'created', 'loading'].includes(state.taskState) || !Number.isFinite(Number(state.taskSequence))) throw new BlockedError('Product must expose .app-shell data-task-state and monotonically increasing data-task-sequence.');
      if (state.errors.length) throw new Error(`UI errors: ${state.errors.join('\n')}`);
      return state.taskState === 'idle' && (afterSequence === undefined || Number(state.taskSequence) > Number(afterSequence)) ? state : false;
    }, { timeout: 60000 });
  }
  async wait(label, expression, args = [], timeout = 30000) { return until(label, () => this.script(expression, args), { timeout }); }
}
export async function startDesktop(run, options, owned) {
  const binary = await fingerprint(options.binary);
  const nativeDriver = resolveDriver(options.driver);
  const verified = JSON.parse(powershell(helper, ['-Action', 'VerifyDriver', '-Executable', nativeDriver]));
  const driverBinary = executable(options['tauri-driver'] ?? 'tauri-driver');
  run.manifest.binary = binary;
  run.manifest.driver = { ...(await fingerprint(nativeDriver)), ...verified };
  run.manifest.tauriDriver = await fingerprint(driverBinary);
  const reservation = await reservePorts();
  run.manifest.ports = reservation.ports;
  await run.save();
  await reservation.release();
  const log = createWriteStream(join(run.output, 'tauri-driver.log'), { flags: 'wx' });
  const child = spawn(driverBinary, ['--port', String(reservation.ports.webdriver), '--native-host', '127.0.0.1', '--native-port', String(reservation.ports.native), '--native-driver', nativeDriver], {
    env: run.env, cwd: run.output, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.on('close', () => log.end());
  if (!child.pid) throw new Error('tauri-driver failed to spawn.');
  await owned.add(child.pid);
  const endpoint = `http://127.0.0.1:${reservation.ports.webdriver}`;
  const wd = new WebDriver(endpoint);
  run.webDriver = wd;
  // Verify listeners are children of this run before sending any WebDriver request.
  await until('run-owned loopback WebDriver listeners', async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`tauri-driver exited ${child.exitCode}; inspect tauri-driver.log`);
    await owned.snapshot();
    try { run.manifest.listeners = JSON.parse(powershell(helper, ['-Action', 'VerifyPorts', '-InputFile', owned.file])); return true; }
    catch (error) { if (String(error.message).includes('no listener yet')) return false; throw error; }
  }, { timeout: 30000, interval: 200 });
  await until('WebDriver ready', async () => { const status = await wd.call('GET', '/status'); return status?.ready; });
  const result = await wd.call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary.path, args: [`--profile-dir=${run.profileDirectory}`], webviewOptions: { userDataFolder: run.manifest.webviewDataDirectory } } } } }, 90000);
  wd.sessionId = result.sessionId;
  assert(wd.sessionId, 'Driver must return a new session id.');
  run.manifest.session = { id: wd.sessionId, endpoint, capabilities: result.capabilities, createdAt: new Date().toISOString(), args: [`--profile-dir=${run.profileDirectory}`], webviewOptions: { userDataFolder: run.manifest.webviewDataDirectory } };
  await owned.snapshot(); await run.save();
  const state = await wd.idle('real application frontend initialization');
  if (!state.configDirectory) throw new BlockedError('Product diagnostics configDirectory is not exposed as data-config-directory.');
  assert(samePath(state.configDirectory, run.profileDirectory), `Wrong application profile: ${state.configDirectory}`);
  run.manifest.profileVerified = { configDirectory: state.configDirectory, checkedAt: new Date().toISOString() };
  await run.save();
  return wd;
}
function resolveDriver(value) { if (!value) throw new Error('--driver must name an already verified Microsoft Edge WebDriver executable.'); return executable(value); }
export async function archiveDesktop(run, wd, name = 'final') {
  const evidence = { name, at: new Date().toISOString(), screenshot: null, dom: null, state: null, errors: [] };
  if (wd?.sessionId) {
    for (const [kind, work] of [
      ['screenshot', async () => { const png = await wd.call('GET', `${wd.prefix}/screenshot`); const file = join(run.output, `evidence/${name}.png`); await writeFile(file, Buffer.from(png, 'base64')); return `evidence/${name}.png`; }],
      ['dom', async () => { const source = await wd.call('GET', `${wd.prefix}/source`); await writeFile(join(run.output, `evidence/${name}.html`), source); return `evidence/${name}.html`; }],
      ['state', () => wd.state()],
    ]) { try { evidence[kind] = await work(); } catch (error) { evidence.errors.push({ kind, ...errorInfo(error) }); } }
    await json(join(run.output, 'webdriver-commands.json'), wd.commands);
  } else evidence.errors.push({ kind: 'screenshot', message: 'No usable WebDriver session was created; no screenshot is fabricated.' });
  await json(join(run.output, `evidence/${name}.json`), evidence);
  run.manifest.evidence.push(evidence);
  await run.save();
  return evidence;
}
