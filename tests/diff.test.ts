import { describe, expect, it } from 'vitest';
import { contentLines, fileTree, parsePatch, splitLines } from '../src/lib/diff';

const patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2,3 +2,4 @@ function test\n same\n-old\n+new\n+extra\n end\n\\ No newline at end of file\n';

describe('unified patch parsing', () => {
  it('preserves old and new numbering with independent counters', () => {
    const parsed = parsePatch(patch);
    expect(parsed.headers).toHaveLength(3);
    expect(parsed.hunks[0].header).toBe('@@ -2,3 +2,4 @@ function test');
    expect(parsed.hunks[0].lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 2, 2], ['deletion', 3, null], ['addition', null, 3], ['addition', null, 4], ['context', 4, 5], ['meta', null, null],
    ]);
  });
  it('aligns replacements and pads one-sided insertions in split view', () => {
    const lines = splitLines(parsePatch(patch).hunks[0].lines);
    expect(lines).toHaveLength(5);
    expect(lines[1].left?.text).toBe('old'); expect(lines[1].right?.text).toBe('new');
    expect(lines[2].left).toBeNull(); expect(lines[2].right?.text).toBe('extra');
    expect(lines[3].left?.oldLine).toBe(4); expect(lines[3].right?.newLine).toBe(5);
  });
  it('handles root additions, deletions, CRLF and multiple hunks', () => {
    const parsed = parsePatch('@@ -0,0 +1,1 @@\r\n+first\r\n@@ -9 +0,0 @@\r\n-last\r\n');
    expect(parsed.hunks[0].lines[0]).toEqual({ kind: 'addition', text: 'first', oldLine: null, newLine: 1 });
    expect(parsed.hunks[1].lines[0]).toEqual({ kind: 'deletion', text: 'last', oldLine: 9, newLine: null });
  });
  it('treats binary and empty diffs as header-only output', () => {
    expect(parsePatch('Binary files a/image and b/image differ\n').hunks).toEqual([]);
    expect(parsePatch('').hunks).toEqual([]);
    expect(contentLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(contentLines(null)).toEqual([]);
    expect(contentLines('\n')).toEqual(['']);
  });
  it('keeps content that begins with patch metacharacters', () => {
    const lines = parsePatch('@@ -1 +1 @@\n----old\n++++new\n').hunks[0].lines;
    expect(lines[0].text).toBe('---old'); expect(lines[1].text).toBe('+++new');
  });
});

describe('file tree', () => {
  it('sorts directories first and compacts only directory chains', () => {
    const tree = fileTree([{ path: 'z.ts' }, { path: 'src/ui/deep/view.ts' }, { path: 'src/ui/deep/style.css' }]);
    expect(tree[0].name).toBe('src/ui/deep');
    expect(tree[0].children.map(node => node.name)).toEqual(['style.css', 'view.ts']);
    expect(tree[1].name).toBe('z.ts');
  });
  it('can preserve explicit folders and Unicode file names', () => {
    const tree = fileTree([{ path: '目录/子目录/文件.ts' }], false);
    expect(tree[0].name).toBe('目录'); expect(tree[0].children[0].name).toBe('子目录');
    expect(tree[0].children[0].children[0].file?.path).toBe('目录/子目录/文件.ts');
  });
});
