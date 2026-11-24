import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, powershell, PROJECT } from './run.mjs';

test('Windows source copy and ZIP preserve UTF-8 manifest paths and exact file bytes', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'qgitgraph-unicode-archive-'));
  try {
    const source = join(root, 'source'), target = join(root, 'copy');
    const relative = 'tools/taskboard/启动任务看板.cmd';
    await mkdir(join(source, 'tools/taskboard'), { recursive: true });
    await writeFile(join(source, relative), Buffer.from('@echo off\r\nrem 中文字符保持原始字节\r\n'));
    const item = { ...(await fingerprint(join(source, relative))), path: relative };
    const manifest = join(root, 'files.json');
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, files: [item] }));
    powershell(join(PROJECT, 'scripts/lib/copy-source.ps1'), ['-SourceDirectory', source, '-FileList', manifest, '-OutputDirectory', target]);
    assert.deepEqual(await readFile(join(target, relative)), await readFile(join(source, relative)));
    const archive = join(root, 'unicode.zip'), report = join(root, 'zip.json');
    powershell(join(PROJECT, 'scripts/lib/zip.ps1'), ['-Directory', target, '-Archive', archive, '-FileList', manifest, '-OutputFile', report]);
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })), [{ path: relative, bytes: item.bytes, sha256: item.sha256 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
