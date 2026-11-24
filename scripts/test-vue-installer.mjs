#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNotices } from './lib/release.mjs';
import { isMain, parseArgs, required } from './lib/run.mjs';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^[a-fA-F0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = path => resolve(path).replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a, b) => normalized(a) === normalized(b);
const within = (parent, child) => { const part = relative(resolve(parent), resolve(child)); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
export const LIMITS = Object.freeze({ entries: 20_000, fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 });
export const SCOPE = 'Static inspection of explicitly hash-pinned final NSIS and Vue PE bytes only. No installer, uninstaller or application is executed. No registration, shortcuts, existing application, user profile, shared Git or WebView2 is modified or backed up/restored. /D and --profile-dir do not isolate currentUser NSIS registration. Actual fresh install, upgrade, uninstall and profile byte integrity remain NOT RUN, requiring an authorized clean VM/dedicated Windows account. Static success never satisfies required installer lifecycle release evidence.';
export class InspectionError extends Error { constructor(code) { super(code); this.code = code; } }
function check(condition, code) { if (!condition) throw new InspectionError(code); }

export function parseOptions(argv) {
  const options = parseArgs(argv, { values: ['installer', 'binary', 'expected-installer-sha256', 'expected-exe-sha256', 'version', 'output', 'seven-zip', 'nsis-script'], flags: ['help', 'probe-only'] });
  if (options.help || options['probe-only']) {
    check(Object.keys(options).length === 1, 'PROBE_OR_HELP_ACCEPTS_NO_PACKAGE_OR_WRITE_ARGUMENTS');
    return options;
  }
  required(options, ['installer', 'binary', 'expected-installer-sha256', 'expected-exe-sha256', 'version', 'output', 'seven-zip']);
  for (const key of ['expected-installer-sha256', 'expected-exe-sha256']) { check(HASH.test(options[key]), 'INDEPENDENT_SHA256_REQUIRED'); options[key] = options[key].toLowerCase(); }
  check(/^\d+\.\d+\.\d+$/.test(options.version), 'EXACT_PRODUCT_VERSION_REQUIRED');
  for (const key of ['installer', 'binary', 'output', 'seven-zip', 'nsis-script']) if (options[key]) assertLocalPath(options[key]);
  check(/^7z(?:z)?\.exe$/i.test(basename(options['seven-zip'])), 'EXPLICIT_INSTALLED_7ZIP_REQUIRED');
  return options;
}
export function assertLocalPath(path, { platform = process.platform } = {}) {
  check(typeof path === 'string' && path.length > 0 && !/[\x00-\x1f\x7f"*?<>|]/.test(path), 'UNSAFE_LOCAL_PATH');
  if (platform === 'win32') {
    check(/^[A-Za-z]:[\\/]/.test(path) && !path.slice(2).includes(':'), 'LOCAL_DRIVE_PATH_REQUIRED');
    const full = win32.resolve(path);
    check(full !== win32.parse(full).root && full.split(/[\\/]/).slice(1).every(part => part && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)), 'UNSAFE_LOCAL_PATH');
    return full;
  }
  check(isAbsolute(path) && resolve(path) !== parse(path).root, 'ABSOLUTE_NONROOT_PATH_REQUIRED');
  return resolve(path);
}
export function assertOutputPolicy(output, protectedRoots = [PROJECT, process.env.USERPROFILE, homedir(), process.env.APPDATA, process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'D:/Env QGitGraph'].filter(Boolean)) {
  const full = assertLocalPath(output);
  for (const root of protectedRoots) check(!within(root, full) && !within(full, root), 'OUTPUT_MUST_BE_OUTSIDE_PROTECTED_TREES');
  return full;
}
export async function assertNoLinks(path) {
  const full = assertLocalPath(path);
  for (let current = full; ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      check(!stat.isSymbolicLink() && samePath(await realpath(current), current), 'LINK_OR_REDIRECT_REJECTED');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === dirname(current)) break;
  }
  return full;
}
export async function claimFreshRun(output) {
  await assertNoLinks(output);
  check((await lstat(dirname(output))).isDirectory(), 'OUTPUT_PARENT_MUST_EXIST');
  try { await mkdir(output); } catch (error) { if (error.code === 'EEXIST') throw new InspectionError('OUTPUT_MUST_BE_NEW_ABSENT_DIRECTORY'); throw error; }
  const runId = randomUUID();
  await writeFile(join(output, '.qgitgraph-vue-installer-inspection'), `${runId}\n`, { flag: 'wx', mode: 0o600 });
  return runId;
}

// This is the only registration probe. Dot-sourcing loads existing read-only
// discovery/helpers, never installer-smoke/upgrade/recovery scripts. Raw values
// stay in PowerShell memory and are neither returned, printed, copied nor logged.
export function registrationProbeScript(helper = join(PROJECT, 'scripts/lib/install.ps1')) {
  return `$ErrorActionPreference='Stop';try{. ${psQuote(helper)};$present=@(Get-QGProductRegistrations 'QGitGraph').Count -gt 0;[Console]::Out.Write((@{registrationPresent=[bool]$present}|ConvertTo-Json -Compress))}catch{[Console]::Error.Write('REGISTRATION_PROBE_FAILED');exit 1}`;
}
export function metadataScript(path) {
  return `$ErrorActionPreference='Stop';try{$f=Get-Item -LiteralPath ${psQuote(path)} -Force;$v=$f.VersionInfo;$s=Get-AuthenticodeSignature -LiteralPath $f.FullName;[Console]::Out.Write((@{productName=$v.ProductName;productVersion=$v.ProductVersion;fileVersion=$v.FileVersion;fileDescription=$v.FileDescription;fixedVersion=@($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart);signatureStatus=$s.Status.ToString()}|ConvertTo-Json -Compress -Depth 4))}catch{[Console]::Error.Write('PE_METADATA_PROBE_FAILED');exit 1}`;
}
function tool(file, args, label, { cwd, audit, timeout = 120_000, encoding = 'utf8', maxBuffer = 32 * 1024 * 1024 } = {}) {
  const startedAt = new Date().toISOString();
  // No shell, no archive-supplied code or cwd. spawnSync waits on its retained
  // child handle; timeout acts only on that tool child, never on a process name.
  const result = spawnSync(file, args, { cwd, windowsHide: true, shell: false, encoding, timeout, maxBuffer });
  audit?.push({ label, pid: result.pid ?? null, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, completed: !result.error && result.status === 0 });
  check(!result.error && result.status === 0, `${label}_FAILED`);
  return encoding === null ? result.stdout : result.stdout.replace(/^\uFEFF/, '');
}
function ps(script, label, options) {
  check(process.platform === 'win32', 'WINDOWS_REQUIRED_NO_EMULATED_PASS');
  const file = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return tool(file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], label, options).trim();
}
export function readRegistrationPresence(options) {
  const result = JSON.parse(ps(registrationProbeScript(), 'REGISTRATION_PROBE', options));
  check(typeof result.registrationPresent === 'boolean' && Object.keys(result).length === 1, 'REGISTRATION_PROBE_CONTRACT_FAILED');
  return result;
}
function restrictRunAcl(output, options) {
  const script = `$ErrorActionPreference='Stop';try{$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};Set-Acl -LiteralPath ${psQuote(output)} -AclObject $acl}catch{[Console]::Error.Write('RUN_ACL_FAILED');exit 1}`;
  ps(script, 'PRIVATE_RUN_ACL', options);
}

export function safeArchivePath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f:<>"|?*]/.test(value) && !/^[\\/]/.test(value), 'UNSAFE_ARCHIVE_ENTRY');
  const path = value.replaceAll('\\', '/');
  check(path.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)), 'UNSAFE_ARCHIVE_ENTRY');
  return path;
}
export function parseNsisInventory(text) {
  const normalized = text.replaceAll('\r\n', '\n');
  const divider = normalized.indexOf('\n----------\n');
  check(divider >= 0, 'NSIS_INVENTORY_DELIMITER_MISSING');
  const header = normalized.slice(0, divider), body = normalized.slice(divider + '\n----------\n'.length).replace(/^\n+|\n+$/g, '');
  check(/^Type = Nsis$/m.test(header), 'PACKAGE_IS_NOT_NSIS');
  const physicalSize = Number(/^Physical Size = (\d+)$/m.exec(header)?.[1]);
  check(Number.isSafeInteger(physicalSize) && physicalSize > 0, 'NSIS_PHYSICAL_SIZE_MISSING');
  const entries = [], seen = new Map();
  for (const block of body.split(/\n\n+/)) {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = /^([^=\n]+) = (.*)$/.exec(line);
      check(match && !Object.hasOwn(fields, match[1]), 'AMBIGUOUS_ARCHIVE_INVENTORY');
      fields[match[1]] = match[2];
    }
    const path = safeArchivePath(fields.Path);
    check(!Object.keys(fields).some(key => /link|stream/i.test(key) && fields[key]), 'ARCHIVE_LINK_OR_STREAM_REJECTED');
    const directory = fields.Folder === '+' || /D/.test(fields.Attributes ?? '');
    // 7-Zip's NSIS reader leaves the last solid stream's unpacked size blank.
    // Retain unknown rather than invent zero/next-offset size; the orchestrator
    // must resolve it through bounded stdout before any bulk extraction.
    check(fields.Size === '' || /^\d+$/.test(fields.Size ?? ''), 'ARCHIVE_SIZE_MISSING');
    const bytes = fields.Size === '' ? null : Number(fields.Size);
    check(bytes === null || (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= LIMITS.fileBytes), 'ARCHIVE_SIZE_LIMIT_EXCEEDED');
    const key = path.toLowerCase();
    check(!seen.has(key), 'DUPLICATE_ARCHIVE_ENTRY'); seen.set(key, directory);
    check(!/qgitgraph-test-probe/i.test(path), 'BUILD_ONLY_PROBE_IN_PACKAGE');
    entries.push({ path, bytes, directory });
  }
  check(entries.length > 0 && entries.length <= LIMITS.entries && entries.reduce((total, entry) => total + entry.bytes, 0) <= LIMITS.totalBytes, 'ARCHIVE_SIZE_LIMIT_EXCEEDED');
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) check(!seen.has(parts.slice(0, i).join('/')) || seen.get(parts.slice(0, i).join('/')), 'ARCHIVE_FILE_DIRECTORY_COLLISION');
  }
  return { type: 'Nsis', physicalSize, method: /^Method = (.*)$/m.exec(header)?.[1] ?? null, subtype: /^SubType = (.*)$/m.exec(header)?.[1] ?? null, entries };
}
export function resolveUnknownEntrySize(entry, bytes) {
  check(entry?.bytes === null && !entry.directory && Buffer.isBuffer(bytes) && bytes.length <= LIMITS.fileBytes, 'UNKNOWN_ARCHIVE_SIZE_RESOLUTION_FAILED');
  return { ...entry, bytes: bytes.length, resolvedSha256: sha256(bytes), sizeSource: 'bounded nonexecuting archive stdout' };
}
export function assertBoundedInventory(archive) {
  check(archive.entries.every(entry => Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= LIMITS.fileBytes) && archive.entries.reduce((total, entry) => total + entry.bytes, 0) <= LIMITS.totalBytes, 'UNRESOLVED_OR_OVERSIZED_ARCHIVE_INVENTORY');
}
export function readPeInfo(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'PE_DOS_HEADER_REQUIRED');
  const offset = bytes.readUInt32LE(0x3c);
  check(offset >= 64 && offset + 26 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', 'PE_HEADER_REQUIRED');
  const machine = bytes.readUInt16LE(offset + 4), magic = bytes.readUInt16LE(offset + 24);
  check((machine === 0x8664 && magic === 0x20b) || (machine === 0x14c && magic === 0x10b), 'UNSUPPORTED_PE_ARCHITECTURE');
  return { architecture: machine === 0x8664 ? 'x64' : 'x86', machine, optionalHeaderMagic: magic };
}
export function validateProductMetadata(metadata, version) {
  check(metadata?.productName === 'QGitGraph', 'PE_PRODUCT_NAME_MISMATCH');
  check(metadata.productVersion === version || metadata.productVersion === `${version}.0`, 'PE_PRODUCT_VERSION_MISMATCH');
  check(metadata.fileVersion === version || metadata.fileVersion === `${version}.0`, 'PE_FILE_VERSION_MISMATCH');
  check(Array.isArray(metadata.fixedVersion) && metadata.fixedVersion.join('.') === `${version}.0`, 'PE_FIXED_VERSION_MISMATCH');
  check(typeof metadata.signatureStatus === 'string' && metadata.signatureStatus.length > 0, 'PE_SIGNATURE_STATUS_MISSING');
  return metadata;
}
export async function treeInventory(root) {
  await assertNoLinks(root);
  const files = [];
  const walk = async (directory, prefix = '') => {
    for (const name of (await readdir(directory)).sort()) {
      const path = safeArchivePath(prefix ? `${prefix}/${name}` : name), full = join(root, ...path.split('/'));
      const stat = await lstat(full);
      check(!stat.isSymbolicLink(), 'EXTRACTED_LINK_REJECTED');
      if (stat.isDirectory()) await walk(full, path);
      else {
        check(stat.isFile() && stat.size <= LIMITS.fileBytes && stat.nlink === 1, 'NONREGULAR_OR_HARDLINK_EXTRACTED_ENTRY');
        const data = await readFile(full); files.push({ path, bytes: data.length, sha256: sha256(data) });
        check(files.length <= LIMITS.entries && files.reduce((total, file) => total + file.bytes, 0) <= LIMITS.totalBytes, 'EXTRACTED_SIZE_LIMIT_EXCEEDED');
      }
    }
  };
  await walk(root); return files;
}
export async function inspectExtractedPayload(root, archive, expectedExeSha256) {
  assertBoundedInventory(archive);
  const files = await treeInventory(root), listedFiles = archive.entries.filter(entry => !entry.directory);
  check(files.length === listedFiles.length, 'EXTRACTION_INVENTORY_COUNT_MISMATCH');
  const listed = new Map(listedFiles.map(entry => [entry.path, entry])), sizeMismatches = [];
  for (const file of files) {
    check(listed.has(file.path), 'EXTRACTION_INVENTORY_PATH_MISMATCH');
    if (listed.get(file.path).bytes !== file.bytes) sizeMismatches.push({ path: file.path, declaredBytes: listed.get(file.path).bytes, actualBytes: file.bytes, actualSha256: file.sha256 });
    if (listed.get(file.path).resolvedSha256) check(file.sha256 === listed.get(file.path).resolvedSha256, 'RESOLVED_ARCHIVE_ENTRY_CONTENT_CHANGED');
  }
  // Retain reader discrepancies separately from independently verified payload
  // hashes. Never replace declared sizes with actual lengths or call this pass.
  const inventoryComparison = { status: sizeMismatches.length ? 'failed' : 'passed', sizeMismatches, actualFileCount: files.length, actualBytes: files.reduce((total, file) => total + file.bytes, 0) };
  const exe = files.find(file => file.path === 'qgitgraph.exe');
  check(exe?.sha256 === expectedExeSha256, 'NSIS_PAYLOAD_BINARY_SHA256_MISMATCH');
  check(files.find(file => file.path === 'LICENSE')?.bytes > 0, 'APPLICATION_LICENSE_MISSING');
  const manifest = JSON.parse(await readFile(join(root, 'notices/manifest.json'), 'utf8'));
  check(manifest.ownedFiles && !Array.isArray(manifest.ownedFiles) && Object.keys(manifest.ownedFiles).length > 0 && HASH.test(manifest.ownedFiles['THIRD_PARTY_NOTICES.md'] ?? ''), 'NOTICE_OWNERSHIP_MAP_REQUIRED');
  const allowed = new Set(['qgitgraph.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'notices/manifest.json', ...Object.keys(manifest.ownedFiles)]);
  for (const file of files) check(allowed.has(file.path) || /^\$PLUGINSDIR\/[^/]+\.(?:dll|bmp)$/i.test(file.path) || file.path === 'uninstall.exe', 'UNEXPECTED_NSIS_PAYLOAD_FILE');
  const notices = await verifyNotices(root);
  // NSIS normally synthesizes WriteUninstaller output at installation time; 7z
  // cannot attest those resulting bytes from a resource inventory. Never run the
  // package just to obtain them and never substitute the installer hash.
  const uninstaller = files.find(file => file.path === 'uninstall.exe');
  return { files, binary: exe, notices, inventoryComparison, uninstaller: uninstaller ? { status: 'passed', source: 'nonexecuted archive extraction only', ...uninstaller, executionTested: false } : { status: 'blocked', reason: 'NSIS generated uninstaller is not materialized by this archive reader; resulting PE/hash/behavior unverified. Obtain it only from a witnessed authorized isolated installation.', executionTested: false } };
}
export async function verifyExtractedPayload(root, archive, expectedExeSha256) {
  const result = await inspectExtractedPayload(root, archive, expectedExeSha256);
  check(result.inventoryComparison.status === 'passed', 'EXTRACTION_INVENTORY_BYTES_MISMATCH');
  return result;
}
export function archiveStdoutArgs(installer, entryPath) {
  return ['x', '-so', '-spd', '-bsp0', '--', installer, safeArchivePath(entryPath).replaceAll('/', '\\')];
}
export function analyzeNsisSource(text) {
  const sections = [...text.matchAll(/^Section\s+["']?Uninstall["']?[^\r\n]*\r?\n([\s\S]*?)^SectionEnd\b/gmi)].map(match => match[0]);
  return { sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), binding: 'Supplied source only, not decompiled/bound to installer bytes; no embedded behavior claim.', uninstallSections: sections.map(section => ({ sha256: sha256(Buffer.from(section)), bytes: Buffer.byteLength(section), writesRegistry: /\b(?:WriteReg\w*|DeleteReg\w*)\b/i.test(section), deletesFiles: /\b(?:Delete|RMDir)\b/i.test(section), mentionsProfileDeletion: /\b(?:APPDATA|LOCALAPPDATA)\b|DeleteAppData/i.test(section) })), writesUninstaller: /\bWriteUninstaller\b/i.test(text), mentionsSharedRegistration: /(?:app\.qgitgraph\.desktop|CurrentVersion[\\/]Uninstall)/i.test(text), supportsRegistrationIsolation: 'not-proven' };
}
export function createReport({ runId, registrationPresent = null, startedAt = new Date().toISOString() }) {
  return { schemaVersion: 1, kind: 'installer', source: 'automated-test', runId, status: 'running', startedAt, finishedAt: null, scope: SCOPE, testedScope: 'static-package-inspection-only', registrationPresent, binary: null, installer: null, results: [], lifecycle: { freshInstall: 'not-run', upgrade: 'not-run', uninstall: 'not-run', applicationStartup: 'not-run' }, profileByteIntegrity: { status: 'not-run', exactByteComparison: false, realProfileRead: false, realProfileWritten: false, reason: 'No profile touched; absence of execution is not a profile preservation test.' }, cleanup: { status: 'not-required', exactOwnedProcesses: { method: 'Only retained read-only tool child handles; no name-based discovery/termination and no installer/application/shared-runtime process launched.', packageProcessesStarted: 0, applicationProcessesStarted: 0, terminatedProductProcesses: 0 }, runArtifactsRetained: true, userDataDeleted: false }, toolInvocations: [], blockers: [] };
}
export function finishStaticReport(report, error) {
  report.blockers = [report.registrationPresent ? 'EXISTING_SAME_PRODUCT_REGISTRATION_MUST_NOT_BE_OVERWRITTEN_OR_TEMPORARILY_REPLACED' : 'CLEAN_AUTHORIZED_WINDOWS_ACCOUNT_OR_VM_STILL_REQUIRED_FOR_LIFECYCLE', 'FRESH_INSTALL_UPGRADE_UNINSTALL_NOT_EXECUTED', 'PROFILE_BYTE_INTEGRITY_NOT_TESTED'];
  if (report.uninstaller?.status !== 'passed') report.blockers.push('GENERATED_UNINSTALLER_BYTES_AND_BEHAVIOR_NOT_VERIFIED');
  if (report.archive?.subtype?.includes('BadCmd=')) report.blockers.push('ARCHIVE_READER_REPORTS_UNKNOWN_NSIS_COMMANDS_CANNOT_ATTEST_SCRIPT_BEHAVIOR');
  if (report.inventoryComparison?.status === 'failed') report.blockers.push('ARCHIVE_READER_SIZE_DISCREPANCY_REQUIRES_SEPARATE_ATTESTATION');
  report.status = error ? 'failed' : 'blocked';
  if (error) report.error = error instanceof InspectionError ? error.code : 'INSPECTION_FAILED_NO_PRIVATE_DETAILS_LOGGED';
  report.finishedAt = new Date().toISOString();
  report.staticInspection = { status: error ? 'failed' : 'passed', actualPassedChecks: report.results.filter(result => result.status === 'passed').length, doesNotProveInstallerLifecycle: true };
  return report;
}
async function pinnedCopy(source, target, expected) {
  await assertNoLinks(source);
  check((await lstat(source)).isFile(), 'INPUT_MUST_BE_REGULAR_FILE');
  const bytes = await readFile(source), hash = sha256(bytes);
  check(hash === expected, 'SUPPLIED_FINAL_ARTIFACT_SHA256_MISMATCH');
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  return { bytes: bytes.length, sha256: hash, pe: readPeInfo(bytes) };
}
export async function inspectPackage(options) {
  check(process.platform === 'win32', 'WINDOWS_REQUIRED_NO_EMULATED_PASS');
  const output = assertOutputPolicy(options.output);
  for (const input of [options.installer, options.binary, options['seven-zip'], options['nsis-script']].filter(Boolean)) check(!within(output, input) && !within(input, output), 'RUN_AND_INPUTS_MUST_BE_SEPARATE');
  const sevenZip = await assertNoLinks(options['seven-zip']);
  check(!within(PROJECT, sevenZip), 'ARCHIVE_TOOL_MUST_NOT_BE_WORKSPACE_CONTROLLED');
  const runId = await claimFreshRun(output), report = createReport({ runId });
  const toolOptions = { cwd: output, audit: report.toolInvocations };
  let failure;
  try {
    restrictRunAcl(output, toolOptions);
    // Archive, extraction and tool cwd each have their own newly created empty
    // directory. No interpreter/build tool ever runs inside an archive tree.
    for (const name of ['archive-input', 'binary-input', 'extracted', 'tool-cwd']) await mkdir(join(output, name));
    toolOptions.cwd = join(output, 'tool-cwd');
    report.registrationPresent = readRegistrationPresence(toolOptions).registrationPresent;
    const installer = join(output, 'archive-input/candidate-setup.exe'), binary = join(output, 'binary-input/qgitgraph.exe');
    report.binary = await pinnedCopy(options.binary, binary, options['expected-exe-sha256']);
    report.installer = await pinnedCopy(options.installer, installer, options['expected-installer-sha256']);
    check(report.binary.pe.architecture === 'x64', 'FINAL_VUE_BINARY_MUST_BE_X64');
    for (const [path, artifact] of [[binary, report.binary], [installer, report.installer]]) artifact.metadata = validateProductMetadata(JSON.parse(ps(metadataScript(path), 'PE_METADATA_PROBE', toolOptions)), options.version);
    report.results.push({ label: 'independently pinned final binary and installer SHA-256, PE architecture and actual product/version metadata', status: 'passed' });
    report.archive = parseNsisInventory(tool(sevenZip, ['l', '-slt', '-sccUTF-8', '--', installer], 'NSIS_INVENTORY', toolOptions));
    check(report.archive.physicalSize === report.installer.bytes, 'NSIS_PHYSICAL_SIZE_MISMATCH');
    for (let i = 0; i < report.archive.entries.length; i++) {
      const entry = report.archive.entries[i];
      if (entry.bytes !== null) continue;
      const bytes = tool(sevenZip, archiveStdoutArgs(installer, entry.path), 'NSIS_BOUNDED_ENTRY_READ', { ...toolOptions, encoding: null, maxBuffer: LIMITS.fileBytes + 1 });
      report.archive.entries[i] = resolveUnknownEntrySize(entry, bytes);
    }
    assertBoundedInventory(report.archive);
    report.results.push({ label: 'actual NSIS inventory preflight, safe distinct entry paths and bounded extraction sizes', status: 'passed', entries: report.archive.entries.length });
    tool(sevenZip, ['x', '-y', '-aoa', '-bb0', '-bsp0', '-sccUTF-8', `-o${join(output, 'extracted')}`, '--', installer], 'NSIS_EXTRACT', toolOptions);
    const payload = await inspectExtractedPayload(join(output, 'extracted'), report.archive, report.binary.sha256);
    report.extractedFiles = payload.files; report.notices = payload.notices; report.uninstaller = payload.uninstaller; report.inventoryComparison = payload.inventoryComparison;
    check(sha256(await readFile(installer)) === report.installer.sha256 && sha256(await readFile(binary)) === report.binary.sha256, 'PINNED_INPUT_COPY_CHANGED');
    report.results.push({ label: 'actual bounded extracted tree has exact final Vue binary hash, all manifest notice/MPL resources verified and no build-only probe or unexpected payload; does not attest archive size metadata', status: 'passed', fileCount: payload.files.length, actualBytes: payload.inventoryComparison.actualBytes, checkedNotices: payload.notices.checkedFileCount });
    report.results.push({ label: 'every extracted file size matches archive reader inventory', status: payload.inventoryComparison.status, mismatchCount: payload.inventoryComparison.sizeMismatches.length });
    if (options['nsis-script']) { await assertNoLinks(options['nsis-script']); report.suppliedNsisSource = analyzeNsisSource(await readFile(options['nsis-script'], 'utf8')); }
    check(payload.inventoryComparison.status === 'passed', 'EXTRACTION_INVENTORY_BYTES_MISMATCH');
  } catch (error) { failure = error; }
  finishStaticReport(report, failure);
  await writeFile(join(output, 'test-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return report;
}
if (isMain(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('node scripts/test-vue-installer.mjs --probe-only\nnode scripts/test-vue-installer.mjs --installer <final-setup.exe> --binary <final-qgitgraph.exe> --expected-installer-sha256 <sha256> --expected-exe-sha256 <sha256> --version <x.y.z> --seven-zip <installed-7z.exe> --output <absent-local-run-outside-user-and-project> [--nsis-script <generated-installer.nsi>]\nRead-only registry probe returns presence boolean only. Static inspection never executes package/product code, never changes identifier or registration, and always leaves installer lifecycle status blocked (exit 2). Inspection failure exits 1. No lifecycle permission switch exists.');
    else if (options['probe-only']) console.log(JSON.stringify(readRegistrationPresence({ cwd: PROJECT })));
    else { const report = await inspectPackage(options); console.log(JSON.stringify({ status: report.status, testedScope: report.testedScope, registrationPresent: report.registrationPresent, binarySha256: report.binary?.sha256 ?? null, installerSha256: report.installer?.sha256 ?? null, staticInspection: report.staticInspection, blockers: report.blockers })); process.exitCode = report.status === 'blocked' ? 2 : 1; }
  } catch (error) { console.error(error instanceof InspectionError ? error.code : 'INSTALLER_INSPECTION_REFUSED_NO_PRIVATE_DETAILS_LOGGED'); process.exitCode = 1; }
}
