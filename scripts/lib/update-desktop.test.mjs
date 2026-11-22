import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertIdleUpdate, assertTerminalUpdate, EXPECTED_VERSION, READ_UPDATE_DOM } from '../test-updates-desktop.mjs';
import { BlockedError } from './desktop.mjs';

// Pure assertion/compile tests only: no desktop, network, process launch or DOM execution.
const idle = () => ({
  dialogs: 1, sections: 1, statusElements: 1, selectedTab: 'About & privacy',
  appVersion: '0.2.2', platform: 'windows x86_64', installed: 'Installed version: 0.2.2',
  status: 'idle', statusText: 'Updates are checked only when you choose Check for updates.',
  checkButtons: 1, checkLabel: 'Check for updates', checkDisabled: false, releaseButtons: 0,
  latestVersion: null, published: null, repoPath: '', taskState: 'idle',
});
const noRelease = () => ({ ...idle(), status: 'no-release', statusText: 'No publicly published stable release was found. You can check again later.' });
const current = () => ({ ...idle(), status: 'current', statusText: 'Your installed version is at least as recent as the latest stable release.', latestVersion: '0.2.2', published: '2026-11-22T06:00:00.000Z' });

test('default idle evidence pins actual version, Windows diagnostics, controls and empty repository', () => {
  assert.equal(EXPECTED_VERSION, '0.2.2'); assert.deepEqual(assertIdleUpdate(idle()), idle());
  for (const patch of [
    { appVersion: '0.2.1' }, { installed: 'Installed version: Unknown' }, { platform: 'browser preview' },
    { repoPath: 'unexpected-repository' }, { taskState: 'running' }, { selectedTab: 'Appearance' },
    { dialogs: 0 }, { sections: 2 }, { statusElements: 0 }, { checkButtons: 2 },
    { checkLabel: 'Check' }, { checkDisabled: true }, { releaseButtons: 1 },
    { status: 'checking' }, { statusText: 'Checking…' }, { latestVersion: '0.2.2' }, { published: 'old' },
  ]) assert.throws(() => assertIdleUpdate({ ...idle(), ...patch }), `Accepted invalid idle evidence: ${JSON.stringify(patch)}`);
});
test('no-release/current expectations are distinct and current must report latest stable 0.2.2', () => {
  assert.deepEqual(assertTerminalUpdate(noRelease(), 'no-release'), noRelease());
  assert.deepEqual(assertTerminalUpdate(current(), 'current'), current());
  assert.throws(() => assertTerminalUpdate(current(), 'no-release'));
  assert.throws(() => assertTerminalUpdate(noRelease(), 'current'));
  assert.throws(() => assertTerminalUpdate(current(), 'available'));
  for (const patch of [{ latestVersion: '0.2.1' }, { latestVersion: '0.2.3' }, { latestVersion: null }, { published: null }, { published: 'Not provided' }]) assert.throws(() => assertTerminalUpdate({ ...current(), ...patch }, 'current'));
  for (const patch of [{ latestVersion: '0.2.2' }, { published: '2026-11-22T06:00:00.000Z' }]) assert.throws(() => assertTerminalUpdate({ ...noRelease(), ...patch }, 'no-release'));
});
test('recognized live GitHub network/TLS/rate/auth/HTTP errors block rather than pass', () => {
  const messages = [
    'The update check timed out. Try again later.',
    'GitHub or your proxy requires authentication. This check does not send credentials.',
    'GitHub has temporarily limited update checks. Try again later.',
    'A secure connection to GitHub could not be verified.',
    'Could not reach GitHub. Check your network connection and try again.',
    'GitHub returned an unexpected response. Try again later.',
  ];
  for (const message of messages) for (const expected of ['no-release', 'current']) {
    const view = { ...idle(), status: 'error', statusText: `Could not check for updates: ${message} Retry using Check for updates.` };
    assert.throws(() => assertTerminalUpdate(view, expected), error => error instanceof BlockedError && error.message.includes(message));
  }
});
test('bad product state, invalid metadata, unsupported and available are failures, not network blocks', () => {
  for (const status of ['idle', 'checking', 'unsupported', 'available', 'unknown']) assert.throws(() => assertTerminalUpdate({ ...current(), status }, 'current'), error => !(error instanceof BlockedError));
  for (const message of ['Invalid release information from the update service.', 'GitHub returned invalid release information.', 'GitHub returned release information that exceeds the size limit.', 'The update check could not be completed.']) {
    const view = { ...idle(), status: 'error', statusText: `Could not check for updates: ${message} Retry using Check for updates.` };
    assert.throws(() => assertTerminalUpdate(view, 'no-release'), error => !(error instanceof BlockedError));
  }
  for (const patch of [{ appVersion: '0.2.1' }, { checkDisabled: true }, { releaseButtons: 1 }, { repoPath: 'unexpected-repository' }]) {
    const view = { ...idle(), status: 'error', statusText: 'Could not check for updates: Could not reach GitHub. Check your network connection and try again. Retry using Check for updates.', ...patch };
    assert.throws(() => assertTerminalUpdate(view, 'no-release'), error => !(error instanceof BlockedError));
  }
  for (const view of [noRelease(), current()]) for (const patch of [{ releaseButtons: 1 }, { checkDisabled: true }]) assert.throws(() => assertTerminalUpdate({ ...view, ...patch }, view.status));
});
test('every embedded browser script compiles without executing desktop or DOM code', async () => {
  assert.doesNotThrow(() => Function(READ_UPDATE_DOM));
  const source = await readFile(new URL('../test-updates-desktop.mjs', import.meta.url), 'utf8');
  let count = 0;
  for (const match of source.matchAll(/\.wait\(\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'/g)) {
    const script = Function(`return '${match[2]}';`)();
    assert.doesNotThrow(() => Function(script), `Invalid embedded wait: ${match[1]}`); count++;
  }
  assert.equal(count, 3, 'Every inline wait should be syntax-checked.');
  for (const forbidden of ['__TAURI', 'dispatchEvent', 'fetch(', 'XMLHttpRequest', '.click(', '.value =', '.innerHTML =', '.setAttribute(']) assert(!READ_UPDATE_DOM.includes(forbidden), `Observation script must remain read-only: ${forbidden}`);
  const actionClicks = [...source.matchAll(/wd\.click\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(actionClicks, ['button[data-action="settings"]', '[data-action="check-for-updates"]']);
  assert(!source.includes('createFixtures'));
});
