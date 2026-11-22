#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT, createRun, errorInfo, fingerprint, json, parseArgs, powershell, required } from './lib/run.mjs';
import { readVersion, verifyNotices } from './lib/release.mjs';
import { archiveFileList } from './lib/source-archive.mjs';

const options = parseArgs(process.argv.slice(2), { values: ['source', 'output'], flags: ['help'] });
if (options.help) { console.log('node scripts/archive-source.mjs --source <project> --output <new-empty-run>\nWhitelist-only offline source ZIP, includes generated full notices and locked MPL source archives. No downloads, dependencies, build output, local profiles or user paths.'); process.exit(0); }
required(options, ['source', 'output']);
const root = resolve(options.source);
const run = await createRun(options.output, 'source-archive');
try {
  const version = await readVersion(root);
  await verifyNotices(root, { verifyInputs: true });
  const staging = join(run.output, `${version.productName}-${version.version}-source`);
  const archive = `${staging}.zip`;
  assert(!existsSync(staging) && !existsSync(archive), 'Source release must not overwrite an existing directory/archive.');
  const list = join(run.output, 'source-files.json');
  await archiveFileList(root, list);
  powershell(join(PROJECT, 'scripts/lib/copy-source.ps1'), ['-SourceDirectory', root, '-FileList', list, '-OutputDirectory', staging], { timeout: 120000 });
  const archiveReport = join(run.output, 'source-archive.json');
  powershell(join(PROJECT, 'scripts/lib/zip.ps1'), ['-Directory', staging, '-FileList', list, '-Archive', archive, '-OutputFile', archiveReport], { timeout: 120000 });
  run.manifest.archive = await fingerprint(archive);
  run.manifest.status = 'passed';
} catch (error) { run.manifest.status = 'failed'; run.manifest.error = errorInfo(error); process.exitCode = 1; }
finally { run.manifest.finishedAt = new Date().toISOString(); await run.save(); await json(join(run.output, 'test-report.json'), { kind: 'source-archive', status: run.manifest.status, archive: run.manifest.archive, error: run.manifest.error }); }
console.log(JSON.stringify({ status: run.manifest.status, output: run.output, archive: run.manifest.archive }, null, 2));
