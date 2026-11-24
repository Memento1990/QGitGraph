import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  LIMITS, SCOPE, analyzeNsisSource, archiveStdoutArgs, assertBoundedInventory, assertLocalPath, assertNoLinks, assertOutputPolicy, claimFreshRun, createReport,
  finishStaticReport, inspectExtractedPayload, metadataScript, parseNsisInventory, parseOptions, readPeInfo, registrationProbeScript, resolveUnknownEntrySize, safeArchivePath,
  treeInventory, validateProductMetadata, verifyExtractedPayload,
} from '../test-vue-installer.mjs';

// Unit fixtures only: no installed products, registry probes, tools, subprocesses,
// real profiles, downloads, installers, uninstallers or application launches.
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = letter => letter.repeat(64);
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'qg-vue-installer-unit-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const inventory = (entries, { type = 'Nsis', size = 100 } = {}) => `7-Zip unit fixture\nType = ${type}\nPhysical Size = ${size}\nMethod = LZMA:23\nSubType = NSIS-3 Unicode BadCmd=13\n\n----------\n${entries.map(entry => `Path = ${entry.path}\nSize = ${entry.bytes ?? 3}\nAttributes = ${entry.attributes ?? ''}${entry.extra ? `\n${entry.extra}` : ''}\n`).join('\n')}`;
function pe(machine = 0x8664, magic = 0x20b) { const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128); bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(magic, 152); return bytes; }
const metadata = () => ({ productName: 'QGitGraph', productVersion: '0.3.0', fileVersion: '0.3.0.0', fixedVersion: [0, 3, 0, 0], signatureStatus: 'NotSigned' });
async function payload(t) {
  const root = await fixture(t), exe = pe(), doc = 'Unit notice fixture only.\n', mpl = Buffer.from('Unit MPL archive bytes, not release evidence.');
  const ownedFiles = { 'THIRD_PARTY_NOTICES.md': sha256(doc), 'notices/sources/unit.crate': sha256(mpl), 'notices/source-availability.md': sha256('Unit source guide\n') };
  const manifest = { schemaVersion: 1, ownedFiles, packages: [{ name: 'unit', version: '1.0.0', declaredLicense: 'MPL-2.0', sourceArchive: { output: 'notices/sources/unit.crate', sha256: sha256(mpl), bytes: mpl.length } }] };
  const data = { 'qgitgraph.exe': exe, LICENSE: 'Unit license\n', 'THIRD_PARTY_NOTICES.md': doc, 'notices/manifest.json': JSON.stringify(manifest), 'notices/sources/unit.crate': mpl, 'notices/source-availability.md': 'Unit source guide\n', '$PLUGINSDIR/System.dll': Buffer.from('Unit inert plugin data') };
  for (const [name, bytes] of Object.entries(data)) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), bytes); }
  const archive = { entries: Object.entries(data).map(([path, data]) => ({ path, bytes: Buffer.byteLength(data), directory: false })) };
  return { root, data, exe, manifest, archive, expectedHash: sha256(exe) };
}

test('entry import is inert and accepts only explicit static pinned inputs or read-only presence probe', async t => {
  const root = await fixture(t);
  const args = ['--installer', join(root, 'candidate.exe'), '--binary', join(root, 'qgitgraph.exe'), '--expected-installer-sha256', hash('a'), '--expected-exe-sha256', hash('B'), '--version', '0.3.0', '--output', join(root, 'absent'), '--seven-zip', join(root, '7z.exe')];
  const options = parseOptions(args); assert.equal(options['expected-exe-sha256'], hash('b'));
  assert.deepEqual(parseOptions(['--help']), { help: true }); assert.deepEqual(parseOptions(['--probe-only']), { 'probe-only': true });
  for (const argv of [[], ['--probe-only', '--output', root], [...args, '--execute'], [...args, '--profile', 'real'], [...args, '--destination', 'D:/Env QGitGraph'], [...args, '--allow-existing'], [...args, '--backup-registry'], [...args, '--installer', 'duplicate'], args.map(x => x === hash('a') ? 'not-a-hash' : x), args.map(x => x === '0.3.0' ? '0.3.0-stale' : x), args.map(x => x === join(root, '7z.exe') ? join(root, 'qgitgraph.exe') : x)]) assert.throws(() => parseOptions(argv));
  assert.equal((await lstat(root)).isDirectory(), true);
  for (const phrase of ['No installer', 'NOT RUN', 'Static success never satisfies', '/D', 'shared Git or WebView2']) assert(SCOPE.includes(phrase));
});
test('Windows paths reject roots, UNC/devices, ADS, shell/path ambiguity and protected profile/install/repo trees', () => {
  assert.equal(assertLocalPath('D:/isolated/new-run', { platform: 'win32' }), 'D:\\isolated\\new-run');
  for (const value of ['D:/', '\\\\server\\share\\run', '\\\\?\\D:\\run', 'relative', 'D:/test:stream', 'D:/test.', 'D:/test ', 'D:/NUL.txt', 'D:/COM1/log', 'D:/a\nb', 'D:/a"b', 'D:/a?b', 'D:/a*']) assert.throws(() => assertLocalPath(value, { platform: 'win32' }));
  const roots = [join(tmpdir(), 'private-user'), join(tmpdir(), 'repository'), join(tmpdir(), 'installed-app')];
  for (const root of roots) { assert.throws(() => assertOutputPolicy(root, roots)); assert.throws(() => assertOutputPolicy(join(root, 'new'), roots)); assert.throws(() => assertOutputPolicy(dirname(root), roots)); }
  assert.equal(assertOutputPolicy(join(tmpdir(), 'elsewhere-new-run'), roots), join(tmpdir(), 'elsewhere-new-run'));
});
test('run claims only absent directories, never accepts empty existing outputs or ancestor redirects', async t => {
  const root = await fixture(t), output = join(root, 'fresh');
  const id = await claimFreshRun(output); assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal((await readFile(join(output, '.qgitgraph-vue-installer-inspection'), 'utf8')).trim(), id);
  await assert.rejects(claimFreshRun(output), /OUTPUT_MUST_BE_NEW_ABSENT_DIRECTORY/);
  const empty = join(root, 'existing-empty'); await mkdir(empty); await assert.rejects(claimFreshRun(empty), /OUTPUT_MUST_BE_NEW_ABSENT_DIRECTORY/);
  await assert.rejects(claimFreshRun(join(root, 'missing-parent/run')));
  const target = join(root, 'target'), link = join(root, 'redirect'); await mkdir(target);
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS denied link fixture creation; link assertion not exercised.'); return; } throw error; }
  await assert.rejects(assertNoLinks(link), /LINK_OR_REDIRECT_REJECTED/);
  await assert.rejects(claimFreshRun(join(link, 'run')), /LINK_OR_REDIRECT_REJECTED/);
});
test('registration script reuses only read-only helper, returns boolean only and never serializes discovered values', () => {
  const source = registrationProbeScript("D:/unit/a'b/install.ps1");
  assert(source.includes(". 'D:/unit/a''b/install.ps1'")); assert(source.includes("@(Get-QGProductRegistrations 'QGitGraph').Count -gt 0")); assert(source.includes('registrationPresent=[bool]$present'));
  for (const forbidden of [/Get-QGProductShortcuts/, /InstallLocation/i, /UninstallString/i, /Export-/i, /Write-QGJson/, /Set-Item/i, /Remove-Item/i, /Start-Process/i, /Invoke-QGProgram/, /Stop-Process/i, /installer-smoke/i, /upgrade-local/i]) assert(!forbidden.test(source));
  assert(source.includes('REGISTRATION_PROBE_FAILED')); assert(!source.includes('$_.Exception'));
  const versionScript = metadataScript("D:/unit/a'b/qgitgraph.exe"); assert(versionScript.includes("'D:/unit/a''b/qgitgraph.exe'")); assert(versionScript.includes('VersionInfo')); assert(versionScript.includes('Get-AuthenticodeSignature')); assert(!/Start-Process|Invoke-QGProgram|Write-/.test(versionScript));
});
test('archive entry validation rejects traversal, absolute/UNC, ADS, wildcard, reserved names and collisions before extraction', () => {
  assert.equal(safeArchivePath('$PLUGINSDIR\\System.dll'), '$PLUGINSDIR/System.dll'); assert.equal(safeArchivePath('notices/中文 space.txt'), 'notices/中文 space.txt');
  for (const path of ['', '../escape', 'a/../../escape', '/root', '\\root', '\\\\share\\file', 'C:/file', 'a:stream', 'a//b', 'a/./b', 'a/../b', 'a\\..\\b', 'a\nb', 'a"b', 'a?b', 'a*b', 'a.', 'a ', 'con.txt', 'LPT1/file', 'a'.repeat(241)]) assert.throws(() => safeArchivePath(path));
  const parsed = parseNsisInventory(inventory([{ path: '$PLUGINSDIR\\System.dll' }, { path: 'qgitgraph.exe' }, { path: 'notices\\a.txt' }])); assert.equal(parsed.type, 'Nsis'); assert.equal(parsed.entries.length, 3); assert.equal(parsed.entries[2].path, 'notices/a.txt');
  for (const entries of [[{ path: 'a' }, { path: 'A' }], [{ path: 'a' }, { path: 'a/b' }], [{ path: '../out' }], [{ path: 'link', extra: 'Symbolic Link = ../out' }], [{ path: 'data', extra: 'Hard Link = other' }], [{ path: 'qgitgraph-test-probe.exe' }], [{ path: 'b', bytes: LIMITS.fileBytes + 1 }], [{ path: 'b', extra: 'Size = 2' }]]) assert.throws(() => parseNsisInventory(inventory(entries)));
  assert.throws(() => parseNsisInventory(inventory([{ path: 'a' }], { type: '7z' })), /PACKAGE_IS_NOT_NSIS/);
  assert.throws(() => parseNsisInventory('Type = Nsis\nPath = a\nSize = 1'), /DELIMITER/);
  assert.throws(() => parseNsisInventory(inventory([{ path: 'a' }], { size: 0 })), /PHYSICAL_SIZE/);
  assert.doesNotThrow(() => parseNsisInventory(inventory([{ path: 'a', attributes: 'D', bytes: 0 }, { path: 'a/b' }])));
});
test('unknown final NSIS stream size stays unresolved until a bounded nonexecuting byte read succeeds', () => {
  const archive = parseNsisInventory(inventory([{ path: 'notices/sources/last.crate', bytes: '' }]));
  assert.equal(archive.entries[0].bytes, null); assert.throws(() => assertBoundedInventory(archive), /UNRESOLVED/);
  const bytes = Buffer.from('Inert unit archive bytes'); archive.entries[0] = resolveUnknownEntrySize(archive.entries[0], bytes);
  assert.equal(archive.entries[0].bytes, bytes.length); assert.equal(archive.entries[0].resolvedSha256, sha256(bytes)); assertBoundedInventory(archive);
  assert.throws(() => resolveUnknownEntrySize({ bytes: 0, directory: false }, bytes));
  assert.throws(() => resolveUnknownEntrySize({ bytes: null, directory: true }, bytes));
  assert.throws(() => assertBoundedInventory({ entries: [{ bytes: LIMITS.fileBytes + 1 }] }));
});
test('bounded archive stdout options preserve data stream and select one literal prevalidated entry', () => {
  const args = archiveStdoutArgs('D:/unit/archive.exe', '$PLUGINSDIR/StartMenu.dll');
  assert.deepEqual(args, ['x', '-so', '-spd', '-bsp0', '--', 'D:/unit/archive.exe', '$PLUGINSDIR\\StartMenu.dll']);
  assert(!args.includes('-bso0'), 'Never suppress extracted stdout.');
  assert.throws(() => archiveStdoutArgs('D:/unit/archive.exe', '../escape'));
});
test('reader size discrepancy remains failed and preserves independent binary/notice checks without rewriting declared bytes', async t => {
  const f = await payload(t), archive = structuredClone(f.archive), entry = archive.entries.find(file => file.path === '$PLUGINSDIR/System.dll');
  entry.bytes += 100;
  const result = await inspectExtractedPayload(f.root, archive, f.expectedHash);
  assert.equal(result.inventoryComparison.status, 'failed'); assert.equal(result.inventoryComparison.sizeMismatches.length, 1);
  assert.equal(result.inventoryComparison.sizeMismatches[0].declaredBytes, entry.bytes);
  assert.equal(result.inventoryComparison.sizeMismatches[0].actualBytes, Buffer.byteLength(f.data['$PLUGINSDIR/System.dll']));
  assert.equal(result.binary.sha256, f.expectedHash); assert.equal(result.notices.status, 'passed');
  assert.equal(archive.entries.find(file => file.path === entry.path).bytes, entry.bytes, 'Declared metadata was not replaced with extracted bytes.');
  await assert.rejects(verifyExtractedPayload(f.root, archive, f.expectedHash), /EXTRACTION_INVENTORY_BYTES_MISMATCH/);
  const report = createReport({ runId: 'unit-discrepancy', registrationPresent: true }); report.inventoryComparison = result.inventoryComparison;
  finishStaticReport(report, new Error('reader mismatch')); assert.equal(report.status, 'failed'); assert(report.blockers.some(code => code.includes('SIZE_DISCREPANCY')));
});
test('PE validation checks real header magic and architecture, not filename/size or a legacy 9MiB assumption', () => {
  assert.equal(readPeInfo(pe()).architecture, 'x64'); assert.equal(readPeInfo(pe(0x14c, 0x10b)).architecture, 'x86');
  for (const bytes of [Buffer.from('not executable'), pe(0x8664, 0x10b), pe(0x14c, 0x20b), pe(0xaa64)]) assert.throws(() => readPeInfo(bytes));
  const outOfBounds = pe(); outOfBounds.writeUInt32LE(10000, 0x3c); assert.throws(() => readPeInfo(outOfBounds));
  const badPe = pe(); badPe.write('BAD!', 128); assert.throws(() => readPeInfo(badPe));
  assert.equal(validateProductMetadata(metadata(), '0.3.0').signatureStatus, 'NotSigned', 'Unsigned is reported, never called a valid signature.');
  for (const [key, value] of [['productName', 'FakeProduct'], ['productVersion', '0.2.2'], ['fileVersion', '0.3.1'], ['fixedVersion', [0, 3, 0, 1]], ['signatureStatus', null]]) assert.throws(() => validateProductMetadata({ ...metadata(), [key]: value }, '0.3.0'));
});
test('actual temporary extraction tree hashes match inventory, pinned binary and notice/MPL resources without running content', async t => {
  const f = await payload(t), result = await verifyExtractedPayload(f.root, f.archive, f.expectedHash);
  assert.equal(result.binary.sha256, f.expectedHash); assert.equal(result.notices.status, 'passed'); assert.equal(result.notices.checkedFileCount, 3); assert.equal(result.notices.mplArchives.length, 1);
  assert.equal(result.uninstaller.status, 'blocked'); assert.equal(result.uninstaller.executionTested, false);
  assert.equal((await treeInventory(f.root)).length, f.archive.entries.length);
  await assert.rejects(verifyExtractedPayload(f.root, f.archive, hash('f')), /BINARY_SHA256_MISMATCH/);
  await assert.rejects(verifyExtractedPayload(f.root, { entries: f.archive.entries.slice(1) }, f.expectedHash), /COUNT_MISMATCH/);
  const changed = structuredClone(f.archive); changed.entries[0].bytes++; await assert.rejects(verifyExtractedPayload(f.root, changed, f.expectedHash), /BYTES_MISMATCH/);
});
test('extraction refuses extra/probe payload, corrupt notices and unowned manifest resources', async t => {
  const f = await payload(t); await writeFile(join(f.root, 'unexpected.exe'), 'inert');
  const extra = { entries: [...f.archive.entries, { path: 'unexpected.exe', bytes: 5, directory: false }] };
  await assert.rejects(verifyExtractedPayload(f.root, extra, f.expectedHash), /UNEXPECTED_NSIS_PAYLOAD_FILE/); await rm(join(f.root, 'unexpected.exe'));
  await writeFile(join(f.root, 'THIRD_PARTY_NOTICES.md'), 'changed'); const changed = structuredClone(f.archive); changed.entries.find(e => e.path === 'THIRD_PARTY_NOTICES.md').bytes = 7;
  await assert.rejects(verifyExtractedPayload(f.root, changed, f.expectedHash), /SHA-256 mismatch/);
});
test('a materialized uninstaller receives its own content hash, never installer or binary hash, and no execution claim', async t => {
  const f = await payload(t), bytes = pe(0x14c, 0x10b); await writeFile(join(f.root, 'uninstall.exe'), bytes);
  f.archive.entries.push({ path: 'uninstall.exe', bytes: bytes.length, directory: false });
  const result = await verifyExtractedPayload(f.root, f.archive, f.expectedHash);
  assert.equal(result.uninstaller.status, 'passed'); assert.equal(result.uninstaller.sha256, sha256(bytes)); assert.notEqual(result.uninstaller.sha256, result.binary.sha256); assert.equal(result.uninstaller.executionTested, false);
});
test('supplied NSIS source scan is explicitly unbound and reports uninstaller content hash without pretending to decompile package', () => {
  const source = 'WriteUninstaller "$INSTDIR\\uninstall.exe"\nSection "Uninstall"\nDelete "$INSTDIR\\qgitgraph.exe"\nDeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\app.qgitgraph.desktop"\nRMDir "$APPDATA"\nSectionEnd\n';
  const result = analyzeNsisSource(source); assert.equal(result.sha256, sha256(source)); assert.equal(result.uninstallSections.length, 1); assert.equal(result.writesUninstaller, true); assert.equal(result.uninstallSections[0].writesRegistry, true); assert.equal(result.uninstallSections[0].deletesFiles, true); assert.equal(result.uninstallSections[0].mentionsProfileDeletion, true); assert.equal(result.supportsRegistrationIsolation, 'not-proven'); assert(result.binding.includes('not decompiled/bound'));
});
test('static success cannot turn into schema-1 installer lifecycle pass or fabricate profile/cleanup coverage', () => {
  const report = createReport({ runId: 'unit', registrationPresent: true, startedAt: '2026-11-24T00:00:00.000Z' }); report.results.push({ status: 'passed', label: 'unit-static' });
  finishStaticReport(report); assert.equal(report.kind, 'installer'); assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'blocked'); assert.equal(report.staticInspection.status, 'passed'); assert(report.blockers.some(code => code.includes('EXISTING_SAME_PRODUCT')));
  for (const status of Object.values(report.lifecycle)) assert.equal(status, 'not-run');
  assert.equal(report.profileByteIntegrity.status, 'not-run'); assert.equal(report.profileByteIntegrity.exactByteComparison, false); assert.equal(report.profileByteIntegrity.realProfileWritten, false);
  assert.equal(report.cleanup.exactOwnedProcesses.packageProcessesStarted, 0); assert.equal(report.cleanup.exactOwnedProcesses.terminatedProductProcesses, 0); assert.equal(report.cleanup.userDataDeleted, false);
  assert(Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  const clean = finishStaticReport(createReport({ runId: 'unit-clean', registrationPresent: false })); assert.equal(clean.status, 'blocked'); assert(clean.blockers.some(code => code.includes('CLEAN_AUTHORIZED')));
  const failure = finishStaticReport(createReport({ runId: 'unit-fail' }), new Error('D:/private/secret registration')); assert.equal(failure.status, 'failed'); assert(!JSON.stringify(failure).includes('private/secret')); assert.equal(failure.staticInspection.status, 'failed');
});
