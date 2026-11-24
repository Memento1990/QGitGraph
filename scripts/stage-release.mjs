#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PROJECT, claimEmptyDirectory, errorInfo, fingerprint, inside, isMain, json, parseArgs, powershell, readJson, signInfo } from './lib/run.mjs';
import { copyTree, inventory, publicMetadata, readVersion, requiredReleaseKinds, validateReleaseEvidenceIndex, verifyNotices } from './lib/release.mjs';
import { archiveFileList } from './lib/source-archive.mjs';

export function parseStageArgs(argv) {
  const options = parseArgs(argv, { values: ['source', 'output', 'binary', 'installer', 'reports', 'signature-policy', 'desktop-kind'], flags: ['help'] });
  options['desktop-kind'] ??= 'desktop'; requiredReleaseKinds(options['desktop-kind']);
  return options;
}
export async function stageRelease(argv = process.argv.slice(2)) {
const options = parseStageArgs(argv);
if (options.help) {
  console.log('node scripts/stage-release.mjs --reports <evidence-index.json> [--source <project>] [--output <new-version-directory>] [--binary <exe>] [--installer <exe>] [--signature-policy report|require-valid] [--desktop-kind desktop|vue-desktop]\nEvidence index: {"schemaVersion":1,"reports":[{"kind":"desktop","path":"run/test-report.json","sha256":"..."}, ... frontend,rust-unit,rust-integration,installer,resources]}\nDefault desktop requires legacy parity; explicit vue-desktop requires full automated-test coverage with no missing/blocked/failed scenarios. Both require same-binary hash/time and repository integrity. Refuses version mismatch, stale notices, failed/blocked required evidence, wrong-binary reports and output reuse. Archives source whitelist and verifies both ZIP contents offline.');
  return;
}
assert(options.reports, '--reports must point at an actual test evidence index; no test counts are hardcoded.');
const source = resolve(options.source ?? PROJECT);
const version = await readVersion(source);
const output = resolve(options.output ?? join(source, `release/${version.productName}-${version.version}`));
const binary = resolve(options.binary ?? join(source, 'src-tauri/target/release/qgitgraph.exe'));
const installer = resolve(options.installer ?? join(source, `src-tauri/target/release/bundle/nsis/${version.productName}_${version.version}_x64-setup.exe`));
const signaturePolicy = options['signature-policy'] ?? 'report';
assert(['report', 'require-valid'].includes(signaturePolicy), 'Unknown signature policy.');
assert(!existsSync(output), 'Release version directory already exists; never overwrite an existing release.');
const binaryInfo = await fingerprint(binary);
const installerInfo = await fingerprint(installer);
const notices = await verifyNotices(source, { verifyInputs: true });
const signatures = { executable: await signInfo(binary), installer: await signInfo(installer) };
if (signaturePolicy === 'require-valid') for (const [kind, signature] of Object.entries(signatures)) assert.equal(signature.status, 'Valid', `${kind} signature is not valid.`);
const reportsIndex = resolve(options.reports);
const index = await readJson(reportsIndex);
const binaryModifiedAt = (await lstat(binary)).mtimeMs;
const artifactModified = Math.max(binaryModifiedAt, (await lstat(installer)).mtimeMs);
const summaries = await validateReleaseEvidenceIndex(index, { reportsRoot: dirname(reportsIndex), binary: binaryInfo, installer: installerInfo, binaryModifiedAt, desktopKind: options['desktop-kind'] });

await claimEmptyDirectory(output);
const packageName = `${version.productName}-${version.version}-windows-x64`;
const sourceName = `${version.productName}-${version.version}-source`;
const packageDirectory = join(output, packageName);
const work = join(output, '.stage-work');
const stageReport = { schemaVersion: 1, kind: 'release-stage', version: version.version, status: 'running', startedAt: new Date().toISOString() };
try {
  await mkdir(packageDirectory); await mkdir(work);
  await copyFile(binary, join(packageDirectory, 'qgitgraph.exe'));
  const installerName = `${version.productName}_${version.version}_x64-setup.exe`;
  await copyFile(installer, join(packageDirectory, installerName));
  for (const file of ['LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(source, file), join(packageDirectory, file));
  await copyTree(join(source, 'notices'), join(packageDirectory, 'notices'));
  await copyTree(join(source, 'docs'), join(packageDirectory, 'docs'));
  await verifyNotices(packageDirectory);
  const sourceList = join(work, 'source-files.json');
  const sourceFiles = await archiveFileList(source, sourceList);
  const sourceDirectory = join(work, sourceName);
  powershell(join(PROJECT, 'scripts/lib/copy-source.ps1'), ['-SourceDirectory', source, '-FileList', sourceList, '-OutputDirectory', sourceDirectory], { timeout: 180000 });
  const sourceZip = join(output, `${sourceName}.zip`);
  powershell(join(PROJECT, 'scripts/lib/zip.ps1'), ['-Directory', sourceDirectory, '-FileList', sourceList, '-Archive', sourceZip, '-OutputFile', join(work, 'source-zip-verification.json')], { timeout: 180000 });
  const sourceArchive = await fingerprint(sourceZip);
  const packageFiles = await inventory(packageDirectory);
  const packagedBinary = packageFiles.find(file => file.path === 'qgitgraph.exe');
  const packagedInstaller = packageFiles.find(file => file.path === installerName);
  assert.equal(packagedBinary.sha256, binaryInfo.sha256); assert.equal(packagedInstaller.sha256, installerInfo.sha256);
  const packageManifest = publicMetadata({
    schemaVersion: 2, version: version.version, product: version.productName, identifier: version.identifier, platform: 'windows-x64',
    stagedAt: new Date().toISOString(), artifactModifiedAt: new Date(artifactModified).toISOString(),
    signatures, signaturePolicy, installer: packagedInstaller, executable: packagedBinary,
    includesSystemWebView2: false, includesGit: false, includesNodeRuntime: false,
    notices, tests: summaries,
    sourceArchive: { path: basename(sourceZip), bytes: sourceArchive.bytes, sha256: sourceArchive.sha256, sourceFileCount: sourceFiles.length },
    limitations: [
      'Test scope and blocked extended features are reported in actual evidence; no unrun test is claimed as passing.',
      'Installer test uses real current-user registration; it is not a clean-VM missing-runtime or DPI matrix test.',
      'Third-party notice and covered-source integrity is not legal release clearance.',
      'The authoritative sibling release manifest records both ZIP hashes after creation; no self-referential binary ZIP hash is embedded in this package.',
      'No upload or publication is performed.',
    ], files: packageFiles,
  });
  await json(join(packageDirectory, 'manifest.json'), packageManifest);
  const binaryFiles = await inventory(packageDirectory);
  const binaryList = join(work, 'binary-files.json');
  await json(binaryList, { schemaVersion: 1, files: binaryFiles });
  const binaryZip = join(output, `${packageName}.zip`);
  powershell(join(PROJECT, 'scripts/lib/zip.ps1'), ['-Directory', packageDirectory, '-FileList', binaryList, '-Archive', binaryZip, '-OutputFile', join(work, 'binary-zip-verification.json')], { timeout: 180000 });
  const binaryArchive = await fingerprint(binaryZip);
  const releaseManifest = publicMetadata({
    schemaVersion: 2, status: 'staged-not-published', ...version, platform: 'windows-x64', stagedAt: new Date().toISOString(),
    signaturePolicy, signatures, tests: summaries, notices,
    archives: [
      { kind: 'source', path: basename(sourceZip), bytes: sourceArchive.bytes, sha256: sourceArchive.sha256 },
      { kind: 'binary', path: basename(binaryZip), bytes: binaryArchive.bytes, sha256: binaryArchive.sha256 },
    ], packageManifest: { path: `${packageName}/manifest.json`, ...(await fingerprint(join(packageDirectory, 'manifest.json'))), path: `${packageName}/manifest.json` },
    executable: { ...packagedBinary, path: `${packageName}/${packagedBinary.path}` }, installer: { ...packagedInstaller, path: `${packageName}/${packagedInstaller.path}` },
  });
  await json(join(output, 'manifest.json'), releaseManifest);
  const hashes = [...releaseManifest.archives, releaseManifest.packageManifest, releaseManifest.executable, releaseManifest.installer];
  await writeFile(join(output, 'SHA256SUMS.txt'), `${hashes.map(file => `${file.sha256}  ${file.path}`).join('\n')}\n`, { flag: 'wx' });
  stageReport.status = 'passed'; stageReport.archives = releaseManifest.archives;
  // Only this freshly claimed work directory is removed; archives are retained.
  assert(inside(output, work)); await rm(work, { recursive: true });
} catch (error) { console.error(error.stack ?? error.message); stageReport.status = 'failed'; stageReport.error = { name: error.name, message: 'Staging failed. No release is approved; inspect the command error output.' }; process.exitCode = 1; }
finally { stageReport.finishedAt = new Date().toISOString(); await json(join(output, 'stage-result.json'), stageReport); }
console.log(JSON.stringify({ status: stageReport.status, destination: output, archives: stageReport.archives, error: stageReport.error?.message }, null, 2));
return stageReport;
}
if (isMain(import.meta.url)) await stageRelease();
