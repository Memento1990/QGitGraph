import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fingerprint, inside, readJson, regularFile, sha256, slash } from './run.mjs';

export function safeRelative(value) {
  assert.equal(typeof value, 'string');
  assert(value && !value.includes('\\') && !value.includes('\0') && !posix.isAbsolute(value), `Unsafe relative path: ${value}`);
  assert(value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f:<>"|?*]/.test(part) && !/[. ]$/.test(part)), `Unsafe relative path: ${value}`);
  return value;
}
export async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelative(relative);
    const full = join(directory, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Links are not allowed in release inputs: ${relative}`);
    if (stat.isDirectory()) files.push(...await inventory(full, relative));
    else {
      assert(stat.isFile(), `Non-regular release input: ${relative}`);
      const bytes = await readFile(full);
      files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return files;
}
export async function copyTree(source, target) {
  const files = await inventory(source);
  await mkdir(target, { recursive: true });
  for (const file of files) { const out = join(target, ...file.path.split('/')); await mkdir(dirname(out), { recursive: true }); await copyFile(join(source, ...file.path.split('/')), out); }
  return files;
}
export async function verifyNotices(directory, { verifyInputs = false } = {}) {
  const manifest = await readJson(join(directory, 'notices/manifest.json'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported notices manifest schema.');
  assert(manifest.ownedFiles && typeof manifest.ownedFiles === 'object', 'Notice manifest must provide SHA-256 ownership map.');
  const checked = [];
  for (const [path, expected] of Object.entries(manifest.ownedFiles)) {
    safeRelative(path);
    assert(path === 'THIRD_PARTY_NOTICES.md' || path.startsWith('notices/'), `Notice path outside resource tree: ${path}`);
    assert(/^[a-f0-9]{64}$/.test(expected), `Invalid SHA-256 for ${path}`);
    const full = resolve(directory, ...path.split('/'));
    assert(inside(directory, full), `Notice path escapes package: ${path}`);
    const actual = await fingerprint(full);
    assert.equal(actual.sha256, expected, `Notice SHA-256 mismatch: ${path}`);
    checked.push({ path, bytes: actual.bytes, sha256: actual.sha256 });
  }
  const mpl = (manifest.packages ?? []).filter(item => /\bMPL-2\.0\b/.test(item.declaredLicense ?? ''));
  for (const item of mpl) {
    assert(item.sourceArchive?.output && item.sourceArchive?.sha256, `MPL source archive missing: ${item.name}@${item.version}`);
    assert.equal(manifest.ownedFiles[item.sourceArchive.output], item.sourceArchive.sha256, `MPL source is not covered by notice SHA map: ${item.name}`);
    const actual = checked.find(file => file.path === item.sourceArchive.output);
    assert(actual && actual.bytes === item.sourceArchive.bytes, `MPL source length mismatch: ${item.name}`);
  }
  if (mpl.length) assert(manifest.ownedFiles['notices/source-availability.md'], 'MPL source-availability guide missing.');
  if (verifyInputs) {
    for (const [path, expected] of Object.entries(manifest.inputs ?? {})) {
      safeRelative(path);
      assert.equal((await fingerprint(join(directory, ...path.split('/')))).sha256, expected, `Stale notice generation input: ${path}`);
    }
  }
  const actualTree = await inventory(join(directory, 'notices'));
  for (const file of actualTree) assert(file.path === 'manifest.json' || Object.hasOwn(manifest.ownedFiles, `notices/${file.path}`), `Unmanifested notice resource: notices/${file.path}`);
  return { status: 'passed', checkedFileCount: checked.length, checkedBytes: checked.reduce((n, file) => n + file.bytes, 0), manifestSha256: (await fingerprint(join(directory, 'notices/manifest.json'))).sha256, mplArchives: mpl.map(item => ({ package: `${item.name}@${item.version}`, ...item.sourceArchive })), legalClearance: false, findings: manifest.findings ?? [] };
}
export async function readVersion(root) {
  const packageJson = await readJson(join(root, 'package.json'));
  const tauri = await readJson(join(root, 'src-tauri/tauri.conf.json'));
  const cargo = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const block = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(block ?? '')?.[1];
  assert(packageJson.version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version), 'Invalid package version.');
  assert.equal(tauri.version, packageJson.version, 'Tauri version does not match package.json.');
  assert.equal(cargoVersion, packageJson.version, 'Cargo version does not match package.json.');
  return { version: packageJson.version, productName: tauri.productName, identifier: tauri.identifier };
}
const desktopParityChecks = [
  'inline details use an actual virtual-list slot',
  'explicit review starts and succeeds only on immutable commit content',
  'annotated tag exposes its actual tagger and complete annotation',
  'named branch scope can restrict history and restore all',
  'settings expose new defaults and preserve trust-private separation',
];
export const DESKTOP_EVIDENCE_KINDS = Object.freeze(['desktop', 'vue-desktop']);
export function requiredReleaseKinds(desktopKind = 'desktop') {
  assert(DESKTOP_EVIDENCE_KINDS.includes(desktopKind), '--desktop-kind must be desktop or vue-desktop.');
  return ['frontend', 'rust-unit', 'rust-integration', desktopKind, 'installer', 'resources'];
}
export const VUE_DESKTOP_FULL_REQUIRED = Object.freeze([
  'actual-native-startup-and-profile-gate',
  'vue-native-boot-isolated-profile',
  'native-usage-explicit-automated-source',
  'repository-open-dialog-real-path-and-read-only',
  'trust-dialog-explicit-repository-confirmation',
  'history-commit-parent-diff-old-new-unified-split',
  'local-staged-unstaged-path-identity-and-draft',
  'directory-four-root-current-repository-navigation',
  'settings-deep-global-repository-language-theme-state',
  'sidebar-real-separator-keyboard-and-collapse',
  'stage-unstage-exact-file-and-group-review-cancel',
  'commit-expected-index-only-not-unstaged-or-untracked',
  'sync-real-local-bare-pull-merge-push',
  'binary-diff-explicit-no-text',
  'repository-open-error-explicit-and-cancel-no-write',
  'in-flight-diff-cancel-observed-not-inferred',
  'native-diff-read-error-and-retry',
  'native-working-stale-expected-index-rejection',
  'native-gitlink-snapshot-rejection',
  'native-sync-conflict-no-push',
  'native-sync-push-error-no-false-success',
  'native-sync-inflight-cancel-no-push',
  'native-review-only-successfully-loaded-files',
  'native-titlebar-actual-maximize-restore-minimize',
  'native-profile-reopen-restores-settings-trust-sidebar',
  'native-titlebar-close-actual-window-exit',
]);
function runTimes(value, label) {
  assert(typeof value.startedAt === 'string' && typeof value.finishedAt === 'string', `${label} must record actual run times.`);
  const start = Date.parse(value.startedAt), finish = Date.parse(value.finishedAt);
  assert(Number.isFinite(start) && Number.isFinite(finish) && start <= finish, `${label} has invalid run times.`);
  return { start, finish };
}
function validateVueDesktopReport(report) {
  assert.equal(report.suite, 'full', 'Vue desktop release evidence must run the full suite.');
  assert.equal(report.source, 'automated-test', 'Vue desktop automation must declare automated-test, never userusage.');
  assert(report.scenarioFilter === undefined || report.scenarioFilter === null, 'Filtered Vue desktop diagnostics are not full release evidence.');
  const run = runTimes(report, 'Vue desktop report');
  assert(/^[a-f0-9]{64}$/.test(report.binary?.sha256) && Number.isInteger(report.binary.bytes) && report.binary.bytes > 0, 'Vue desktop evidence requires an actual binary fingerprint.');
  assert(!report.error && !report.usageValidationError && !report.failureUsageStop, 'Vue desktop evidence contains an execution/usage failure.');
  assert(report.assisted === false && !report.assistedLocalResize && !report.vue?.assistedLocalResize, 'Assisted or unqualified Vue desktop investigation is not final release evidence.');
  const labels = new Set();
  for (const result of report.results) {
    assert(typeof result.label === 'string' && result.label && !labels.has(result.label), 'Vue desktop results require unique scenario labels.'); labels.add(result.label);
    assert.equal(result.source, 'automated-test', 'Vue desktop scenario source must be automated-test.');
    assert.equal(result.status, 'passed', `Vue desktop scenario was not passed: ${result.label}`);
    assert(!result.error, `Vue desktop scenario contains an error: ${result.label}`);
    const step = runTimes(result, `Vue desktop scenario ${result.label}`);
    assert(step.start >= run.start && step.finish <= run.finish, 'Vue desktop scenario times escape the report run.');
  }
  const coverage = report.coverage;
  assert(coverage && typeof coverage === 'object' && !Array.isArray(coverage), 'Vue desktop full evidence requires explicit coverage.');
  for (const key of ['required', 'missing', 'blocked', 'failed', 'duplicates']) assert(Array.isArray(coverage[key]) && coverage[key].every(label => typeof label === 'string'), `Invalid Vue desktop coverage: ${key}`);
  assert.deepEqual([...coverage.required].sort(), [...VUE_DESKTOP_FULL_REQUIRED].sort(), 'Vue desktop coverage does not match the static full release requirements.');
  for (const key of ['missing', 'blocked', 'failed', 'duplicates']) assert.equal(coverage[key].length, 0, `Vue desktop full coverage contains ${key} scenarios.`);
  for (const label of VUE_DESKTOP_FULL_REQUIRED) assert(labels.has(label), `Vue desktop full evidence missing scenario: ${label}`);
  if (report.counts?.passed !== undefined) assert.equal(report.counts.passed, report.results.length, 'Vue desktop counts differ from actual scenario results.');
  assert.equal(report.integrity?.status, 'passed', 'Vue desktop lacks repository integrity evidence.');
  assert(!report.integrity.error && Array.isArray(report.integrity.repositories) && report.integrity.repositories.length > 0, 'Vue desktop integrity must cover actual fixture repositories.');
  for (const errors of [report.cleanupErrors, report.cleanup?.errors, report.cleanup?.remaining]) assert(Array.isArray(errors) && errors.length === 0, 'Vue desktop cleanup is incomplete or missing.');
  assert(Array.isArray(report.usageLogs) && report.usageLogs.length > 0, 'Vue desktop native usage validation is missing.');
  for (const usage of report.usageLogs) {
    assert(usage.source === 'automated-test' && usage.stopped === true && usage.build === `native-${report.binary.sha256}`, 'Vue desktop usage must be stopped automated evidence for the same binary.');
    assert(/^[a-f0-9]{64}$/.test(usage.sha256), 'Vue desktop usage requires the actual local log hash.');
  }
}
const resultPassed = result => result.status === 'passed' || (result.status === undefined && result.passed === true);
export function summarizeReport(report, expectedKind = report?.kind ?? 'frontend') {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'Test report must be JSON object.');
  assert(!['fixture-only'].includes(report.kind), 'Fixture creation is not a test report.');
  if (expectedKind === 'frontend') {
    // Vitest's raw JSON has neither our schemaVersion nor kind fields.
    assert(report.kind === undefined || report.kind === expectedKind, 'Frontend report kind does not match evidence index.');
    assert(report.schemaVersion === undefined || report.schemaVersion === 1, 'Unsupported frontend report schema.');
    assert(Array.isArray(report.testResults) && report.testResults.length > 0 && typeof report.success === 'boolean', 'Frontend evidence must have the raw Vitest report shape.');
    for (const key of ['numTotalTests', 'numPassedTests', 'numFailedTests']) assert(Number.isInteger(report[key]) && report[key] >= 0, `Invalid Vitest count: ${key}`);
    assert(report.numPendingTests === undefined || (Number.isInteger(report.numPendingTests) && report.numPendingTests >= 0), 'Invalid Vitest pending count.');
    assert(report.success && report.numFailedTests === 0 && report.numPassedTests > 0 && report.numTotalTests >= report.numPassedTests, 'Frontend report has failures or no tests.');
    return { kind: 'frontend', status: 'passed', passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests ?? 0, total: report.numTotalTests };
  }
  assert.equal(report.schemaVersion, 1, 'Unsupported test report schema.');
  assert.equal(report.kind, expectedKind, 'Report kind does not match evidence index.');
  assert.equal(report.status, 'passed', 'Release evidence must be a passed actual test report.');
  assert(report.startedAt && report.finishedAt, 'Test report must record actual run times.');
  const results = report.results ?? [];
  assert(Array.isArray(results) && results.every(result => result && typeof result === 'object'), 'Test results must be an array of result objects.');
  const failed = results.filter(result => result.status === 'failed' || result.passed === false).length;
  assert.equal(failed, 0, 'Test report contains a failed result.');
  const blockedResults = results.filter(result => result.status === 'blocked');
  assert(blockedResults.every(result => result.requiredForBaseline === false && result.required !== true), 'Required or unqualified blocked results cannot pass the release gate.');
  const passed = results.filter(resultPassed).length;
  if (report.counts?.passed !== undefined) assert(Number.isInteger(report.counts.passed) && report.counts.passed >= 0, 'Invalid passing assertion count.');
  assert(passed > 0 || (report.counts?.passed > 0), 'No actual passing assertions in report.');
  if (expectedKind === 'desktop') {
    if (report.suite !== undefined) assert.equal(report.suite, 'parity', 'Desktop release evidence must run the parity suite.');
    else {
      // Existing genuine reports predate an explicit suite field; require the
      // exact successful checks from desktop-parity-suite, not a generic pass.
      const labels = new Set(results.filter(resultPassed).map(result => result.label));
      for (const label of desktopParityChecks) assert(labels.has(label), `Desktop parity evidence missing: ${label}`);
    }
  }
  if (expectedKind === 'vue-desktop') validateVueDesktopReport(report);
  if (expectedKind === 'resources') {
    const measurement = report.measurement;
    assert(Number.isFinite(measurement?.idleSeconds) && measurement.idleSeconds >= 60, 'Resource evidence must measure at least 60 seconds idle.');
    assert(Number.isInteger(measurement.sampleCount) && measurement.sampleCount >= 2, 'Resource CPU evidence needs at least two snapshots.');
    assert(Number.isFinite(measurement.cpuWindowSeconds) && measurement.cpuWindowSeconds > 0 && measurement.cpuWindowSeconds <= measurement.idleSeconds, 'Resource evidence has an invalid CPU counter window.');
  }
  return { kind: report.kind, status: report.status, passed: report.counts?.passed ?? passed, blocked: blockedResults.length, startedAt: report.startedAt, finishedAt: report.finishedAt, binarySha256: report.binary?.sha256 ?? null,
    ...(expectedKind === 'vue-desktop' ? { suite: report.suite, source: report.source, requiredScenarios: VUE_DESKTOP_FULL_REQUIRED.length } : {}) };
}
export function validateReleaseReport(report, kind, { binary, installer, binaryModifiedAt } = {}) {
  const summary = summarizeReport(report, kind);
  if (['desktop', 'vue-desktop', 'installer', 'resources'].includes(kind)) {
    assert(binary?.sha256, 'Actual release binary SHA-256 is required.');
    assert.equal(report.binary?.sha256, binary.sha256, `${kind} report is for another application build.`);
    assert(Number.isFinite(binaryModifiedAt), 'Actual release binary modification time is required.');
    assert(Date.parse(report.startedAt) >= binaryModifiedAt - 1000, `${kind} report predates the supplied binary.`);
    const integrity = kind === 'vue-desktop' ? report.integrity?.status : report.repositoryIntegrity?.status ?? (kind === 'installer' ? 'passed' : undefined);
    assert.equal(integrity, 'passed', `${kind} lacks repository integrity evidence.`);
  }
  if (kind === 'installer') {
    assert(installer?.sha256, 'Actual release installer SHA-256 is required.');
    assert.equal(report.installer?.sha256, installer.sha256, 'Installer report is for another installer artifact.');
  }
  return summary;
}
export async function validateReleaseEvidenceIndex(index, { reportsRoot, binary, installer, binaryModifiedAt, desktopKind = 'desktop' } = {}) {
  assert.equal(index.schemaVersion, 1, 'Unsupported test evidence index schema.');
  assert(Array.isArray(index.reports), 'Evidence index must contain reports[].');
  const requiredKinds = new Set(requiredReleaseKinds(desktopKind)); const summaries = [];
  for (const entry of index.reports) {
    assert(requiredKinds.has(entry.kind), `Unknown or duplicate evidence kind: ${entry.kind}`); requiredKinds.delete(entry.kind);
    assert(typeof entry.path === 'string' && entry.path && /^[a-f0-9]{64}$/.test(entry.sha256), 'Every evidence report requires a recorded SHA-256.');
    const file = resolve(reportsRoot, entry.path); await regularFile(file); const bytes = await readFile(file);
    assert.equal(sha256(bytes), entry.sha256, `Evidence report changed: ${entry.kind}`);
    const report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const summary = validateReleaseReport(report, entry.kind, { binary, installer, binaryModifiedAt });
    if (['rust-unit', 'rust-integration'].includes(entry.kind)) {
      assert(report.log?.path && /^[a-f0-9]{64}$/.test(report.log.sha256), `${entry.kind} requires the actual command log hash, not only a count.`);
      const logFile = resolve(dirname(file), report.log.path); await regularFile(logFile); const log = await readFile(logFile);
      assert.equal(sha256(log), report.log.sha256, `${entry.kind} log hash mismatch.`);
      assert.equal(summary.passed, validateRustEvidence(report, log.toString('utf8')), `${entry.kind} count differs from actual log.`);
    }
    summaries.push({ reportSha256: entry.sha256, reportBytes: bytes.length, ...summary });
  }
  assert.equal(requiredKinds.size, 0, `Required actual reports missing: ${[...requiredKinds].join(', ')}`);
  return summaries;
}
export const RUST_INTEGRATION_TARGETS = Object.freeze([
  'integration', 'operations_extra', 'history_parity', 'action_parity', 'host_parity',
  'working_actions', 'untrusted_filters', 'history_performance', 'read_performance',
  'runner_performance', 'windows_process_performance', 'clean_preview',
]);
export function validateRustEvidence(report, log) {
  const kind = report.kind;
  assert(['rust-unit', 'rust-integration'].includes(kind), 'Expected Rust test evidence.');
  assert.equal(report.command?.program, 'cargo', `${kind} must record an actual cargo command.`);
  assert.equal(report.command?.exitCode, 0, `${kind} command did not exit successfully.`);
  const args = report.command?.args;
  assert(Array.isArray(args) && args.every(arg => typeof arg === 'string') && args[0] === 'test', `${kind} must record cargo test arguments.`);
  const separator = args.indexOf('--');
  const cargoArgs = separator < 0 ? args : args.slice(0, separator);
  assert(!cargoArgs.includes('--no-run'), `${kind} must execute tests, not only compile them.`);
  assert(!args.includes('--list'), `${kind} must execute tests, not only list them.`);
  const values = flag => cargoArgs.flatMap((arg, index) => arg === flag ? [cargoArgs[index + 1]] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []);
  if (kind === 'rust-unit') assert(cargoArgs.includes('--lib'), 'Rust unit command must execute library tests.');
  if (kind === 'rust-integration') {
    const targets = values('--test');
    for (const target of RUST_INTEGRATION_TARGETS) assert(targets.includes(target), `Rust integration command missing test target: ${target}`);
    const features = values('--features').filter(value => typeof value === 'string').flatMap(value => value.split(/[\s,]+/));
    assert(features.includes('host-tests'), 'Rust integration command must explicitly enable host-tests.');
  }
  assert.equal(typeof log, 'string', 'Rust evidence requires the actual command log.');
  assert(!/\bSKIP(?:PED)?\b/i.test(log), `${kind} log contains a SKIP marker.`);
  assert(!/test result: (?:FAILED|ignored)/i.test(log), `${kind} log contains unsuccessful Rust tests.`);
  const counts = [...log.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;[^\r\n]*?(\d+) filtered out;/g)];
  assert(counts.length && counts.every(match => Number(match[2]) === 0 && Number(match[4]) === 0), `${kind} log lacks successful unfiltered Rust test summaries.`);
  if (kind === 'rust-integration') {
    // An updated command vector cannot turn a legacy log into new evidence.
    // Cargo --nocapture logs identify each executed harness and its summary.
    const runs = [...log.matchAll(/^\s*Running\s+[^\r\n]*\((?:[^\r\n]*[\\/])?([A-Za-z0-9_]+)-[a-f0-9]+(?:\.exe)?\)\s*$/gm)];
    for (const target of RUST_INTEGRATION_TARGETS) {
      const matching = runs.filter(run => run[1] === target);
      assert.equal(matching.length, 1, `Rust integration log missing/duplicate test target: ${target}`);
      const start = matching[0].index + matching[0][0].length;
      const end = runs.find(run => run.index >= start)?.index ?? log.length;
      const summary = counts.filter(match => match.index >= start && match.index < end);
      assert(summary.length === 1 && Number(summary[0][1]) > 0, `Rust integration target lacks executed assertions: ${target}`);
    }
  }
  return counts.reduce((total, match) => total + Number(match[1]), 0);
}
export function publicMetadata(value) {
  // Public release evidence is summarized, never copied with local source/profile paths.
  const visit = item => {
    if (typeof item === 'string') assert(!/^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|projects)\/)/.test(item), 'Public metadata contains an absolute local path.');
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return value;
}
