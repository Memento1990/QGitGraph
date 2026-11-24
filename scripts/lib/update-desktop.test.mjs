import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertIdleUpdate, assertTerminalUpdate, EXPECTED_VERSION, parseUpdateArgs, READ_UPDATE_DOM } from '../test-updates-desktop.mjs';
import { BlockedError } from './desktop.mjs';

// Pure assertion/compile tests only: no desktop, network, process launch or DOM execution.
const idle = (version = EXPECTED_VERSION) => ({
  dialogs: 1, sections: 1, statusElements: 1, selectedTab: 'About & privacy',
  appVersion: version, platform: 'windows x86_64', installed: `Installed version: ${version}`,
  status: 'idle', statusText: 'Updates are checked only when you choose Check for updates.',
  checkButtons: 1, checkLabel: 'Check for updates', checkDisabled: false, releaseButtons: 0,
  latestVersion: null, published: null, repoPath: '', taskState: 'idle',
});
const noRelease = (version = EXPECTED_VERSION) => ({ ...idle(version), status: 'no-release', statusText: 'No publicly published stable release was found. You can check again later.' });
const current = (currentVersion = '0.3.0', latestVersion = '0.2.2') => ({ ...idle(currentVersion), status: 'current', statusText: 'Your installed version is at least as recent as the latest stable release.', latestVersion, published: '2026-11-22T06:00:00.000Z' });
const versions = { currentVersion: '0.3.0', latestVersion: '0.2.2' };
const isAssertionFailure = error => error?.code === 'ERR_ASSERTION';
const errorStatus = detail => `Could not check for updates: ${detail} Retry using Check for updates.`;

const nativeNetworkErrors = [
  ['The update check timed out.', 'The update check timed out. Try again later.'],
  ['GitHub requires authentication for this update request.', 'GitHub or your proxy requires authentication. This check does not send credentials.'],
  ['GitHub has rate-limited update checks. Try again later.', 'GitHub has temporarily limited update checks. Try again later.'],
  ['The update service could not be reached securely.', 'A secure connection to GitHub could not be verified.'],
  ['The update service could not be reached.', 'Could not reach GitHub. Check your network connection and try again.'],
  ['', 'GitHub returned an unexpected response. Try again later.'],
];
const nativeNetworkText = ([summary, message]) => errorStatus(summary ? `${summary}\n${message}` : message);

test('idle evidence uses the package version by default and pins Windows diagnostics, controls and empty repository', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(EXPECTED_VERSION, packageJson.version);
  assert.deepEqual(assertIdleUpdate(idle()), idle());
  assert.deepEqual(assertIdleUpdate(idle('0.3.0'), '0.3.0'), idle('0.3.0'));
  for (const patch of [
    { appVersion: '0.2.2' }, { installed: 'Installed version: 0.2.2' }, { installed: 'Installed version: Unknown' }, { platform: 'browser preview' },
    { repoPath: 'unexpected-repository' }, { taskState: 'running' }, { selectedTab: 'Appearance' },
    { dialogs: 0 }, { sections: 2 }, { statusElements: 0 }, { checkButtons: 2 },
    { checkLabel: 'Check' }, { checkDisabled: true }, { releaseButtons: 1 },
    { status: 'checking' }, { statusText: 'Checking…' }, { latestVersion: '0.2.2' }, { published: 'old' },
  ]) assert.throws(() => assertIdleUpdate({ ...idle('0.3.0'), ...patch }, '0.3.0'), isAssertionFailure, `Accepted invalid idle evidence: ${JSON.stringify(patch)}`);
});

test('current accepts installed >= the explicit published stable, keeps no-release distinct and rejects downgrade labels', () => {
  assert.deepEqual(assertTerminalUpdate(noRelease(), 'no-release'), noRelease());
  for (const [currentVersion, latestVersion] of [
    ['0.3.0', '0.2.2'], ['0.2.2', '0.2.2'], ['0.10.0', '0.9.9'], ['1.0.0', '0.99.99'], ['1.0.10', '1.0.9'],
    ['0.3.0-rc.1', '0.2.2'], ['0.3.0+local.1', '0.3.0+published.2'],
  ]) {
    const view = current(currentVersion, latestVersion);
    assert.deepEqual(assertTerminalUpdate(view, 'current', { currentVersion, latestVersion }), view);
  }
  assert.deepEqual(assertTerminalUpdate(noRelease('0.3.0'), 'no-release', { currentVersion: '0.3.0' }), noRelease('0.3.0'));
  assert.throws(() => assertTerminalUpdate(current(), 'no-release', { currentVersion: '0.3.0' }), isAssertionFailure);
  assert.throws(() => assertTerminalUpdate(noRelease('0.3.0'), 'current', versions), isAssertionFailure);
  assert.throws(() => assertTerminalUpdate(current(), 'available', versions), isAssertionFailure);
  assert.throws(() => assertTerminalUpdate(current(), 'current', { currentVersion: '0.3.0' }), /explicit latestVersion/);
  for (const patch of [
    { appVersion: '0.2.2' }, { installed: 'Installed version: 0.2.2' },
    { latestVersion: '0.2.1' }, { latestVersion: '0.3.0' }, { latestVersion: '0.3.1' }, { latestVersion: 'v0.2.2' }, { latestVersion: null },
    { statusText: 'Your installed version is the latest stable release.' },
    { statusText: 'A newer stable release is available.' }, { statusText: noRelease().statusText },
    { published: null }, { published: 'Not provided' }, { published: '11/22/2026, 6:00:00 AM' },
    { published: '2026-11-22T06:00:00Z' }, { published: '2026-02-30T06:00:00.000Z' }, { published: '2026-13-22T06:00:00.000Z' },
  ]) assert.throws(() => assertTerminalUpdate({ ...current(), ...patch }, 'current', versions), isAssertionFailure, `Accepted invalid current evidence: ${JSON.stringify(patch)}`);
  for (const patch of [{ latestVersion: '0.2.2' }, { published: current().published }]) assert.throws(() => assertTerminalUpdate({ ...noRelease('0.3.0'), ...patch }, 'no-release', { currentVersion: '0.3.0' }), isAssertionFailure);
  for (const [currentVersion, latestVersion] of [
    ['0.3.0', '0.3.1'], ['0.9.9', '0.10.0'], ['1.0.9', '1.0.10'], ['0.3.0-rc.1', '0.3.0'],
  ]) assert.throws(() => assertTerminalUpdate(current(currentVersion, latestVersion), 'current', { currentVersion, latestVersion }), /cannot have a latest stable version newer/);
});

test('CLI requires an explicit latest stable only for current and versions must be canonical and finite', () => {
  const base = ['--binary', 'app.exe', '--driver', 'msedgedriver.exe', '--output', 'new-empty-run'];
  assert.equal(parseUpdateArgs(base).expect, 'no-release');
  assert.equal(parseUpdateArgs(base)['latest-version'], undefined);
  assert.equal(parseUpdateArgs([...base, '--expect', 'current', '--latest-version', '0.0.0'])['latest-version'], '0.0.0');
  assert.equal(parseUpdateArgs(['--help']).help, true);
  assert.throws(() => parseUpdateArgs([...base, '--expect', 'current']), /explicit latestVersion/);
  assert.throws(() => parseUpdateArgs([...base, '--latest-version', '0.0.0']), /no-release must not specify/);
  assert.throws(() => parseUpdateArgs([...base, '--expect', 'no-release', '--latest-version', '0.0.0']), /no-release must not specify/);
  assert.throws(() => parseUpdateArgs([...base, '--expect', 'available']), /Expectation/);
  assert.throws(() => parseUpdateArgs([...base, '--expect', 'current', '--latest-version']), /Missing value/);
  assert.throws(() => parseUpdateArgs([...base, '--expect', 'current', '--latest-version', '0.0.0', '--latest-version', '0.0.0']), /repeated argument/);
  assert.throws(() => parseUpdateArgs(['--expect', 'current', '--latest-version', '0.0.0']), /Required argument/);
  const futureLatest = `${BigInt(EXPECTED_VERSION.split('.')[0]) + 1n}.0.0`;
  assert.throws(() => parseUpdateArgs([...base, '--expect', 'current', '--latest-version', futureLatest]), isAssertionFailure);
  for (const version of [
    '', '0.02.2', '00.2.2', '0.2', 'v0.2.2', '0.2.2\n', ' 0.2.2', '0.2.2 ', '0.2.2.0',
    '0.2.2-', '0.2.2+', '0.2.2-rc.01', '9007199254740992.0.0', `${'9'.repeat(310)}.0.0`,
    'Infinity.0.0', '0.0.NaN', null, NaN, Infinity,
  ]) {
    assert.throws(() => assertIdleUpdate(idle(version), version), isAssertionFailure, `Accepted invalid installed version: ${version}`);
    assert.throws(() => assertTerminalUpdate(current('0.3.0', version), 'current', { currentVersion: '0.3.0', latestVersion: version }), isAssertionFailure, `Accepted invalid latest version: ${version}`);
  }
  for (const version of ['0.2.2-rc.1', '0.2.2-alpha', '0.2.2-0']) {
    assert.throws(() => assertTerminalUpdate(current('0.3.0', version), 'current', { currentVersion: '0.3.0', latestVersion: version }), /stable release, not a prerelease/);
    assert.throws(() => parseUpdateArgs([...base, '--expect', 'current', '--latest-version', version]), /stable release, not a prerelease/);
  }
});

test('exact localized-English native network/TLS/rate/auth/HTTP diagnostics block rather than pass', () => {
  for (const entry of nativeNetworkErrors) for (const expected of ['no-release', 'current']) {
    const view = { ...idle('0.3.0'), status: 'error', statusText: nativeNetworkText(entry) };
    const expectation = expected === 'current' ? versions : { currentVersion: '0.3.0' };
    assert.throws(() => assertTerminalUpdate(view, expected, expectation), error => error instanceof BlockedError && error.message.includes(entry[1]));
  }
});

test('bad product state, stale metadata and unknown or invalid-release errors fail instead of blocking', () => {
  for (const status of ['idle', 'checking', 'unsupported', 'available', 'unknown']) assert.throws(() => assertTerminalUpdate({ ...current(), status }, 'current', versions), isAssertionFailure);
  for (const detail of [
    'Invalid release information from the update service.',
    'The update service returned invalid release information.\nInvalid release information from the update service.',
    'The update service returned invalid release information.\nGitHub returned invalid release information.',
    'The update service response exceeded the size limit.\nGitHub returned release information that exceeds the size limit.',
    'The update check could not be completed.', 'GitHub returned 403 Forbidden',
    'The update service could not be reached.\nGitHub returned invalid release information.',
    'The update service could not be reached.\nAn unknown native diagnostic.',
    'The update service could not be reached.',
    'The update service could not be reached.\nCould not reach GitHub. Check your network connection and try again.\nUnexpected extra detail.',
    // Uncoded legacy prose alone is not the current machine-code-selected output.
    ...nativeNetworkErrors.filter(([summary]) => summary).map(([, message]) => message),
  ]) {
    const view = { ...idle('0.3.0'), status: 'error', statusText: errorStatus(detail) };
    for (const expected of ['no-release', 'current']) assert.throws(() => assertTerminalUpdate(view, expected, expected === 'current' ? versions : { currentVersion: '0.3.0' }), isAssertionFailure);
  }
  for (const patch of [
    { appVersion: '0.2.2' }, { installed: 'Installed version: 0.2.2' }, { platform: 'browser preview' },
    { checkDisabled: true }, { releaseButtons: 1 }, { repoPath: 'unexpected-repository' }, { taskState: 'running' },
    { dialogs: 2 }, { statusElements: 2 }, { latestVersion: '0.2.2' }, { published: current().published },
  ]) {
    const view = { ...idle('0.3.0'), status: 'error', statusText: nativeNetworkText(nativeNetworkErrors[4]), ...patch };
    assert.throws(() => assertTerminalUpdate(view, 'no-release', { currentVersion: '0.3.0' }), isAssertionFailure);
  }
  assert.throws(() => assertTerminalUpdate({ ...current(), statusText: nativeNetworkText(nativeNetworkErrors[4]) }, 'current', versions), isAssertionFailure);
  for (const view of [noRelease('0.3.0'), current()]) for (const patch of [{ releaseButtons: 1 }, { checkDisabled: true }]) assert.throws(() => assertTerminalUpdate({ ...view, ...patch }, view.status, view.status === 'current' ? versions : { currentVersion: '0.3.0' }), isAssertionFailure);
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
