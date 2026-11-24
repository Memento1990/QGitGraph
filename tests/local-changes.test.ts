import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ChangedFile, type Repository } from '../src/shared/protocol';
import {
  groupLocalChanges, localChangeKey, localChangesLayout, localChangesWindow, localDiffQuery, localFileStatus, localFileTargets,
  LocalChangeDrafts, LOCAL_DRAFT_LIMIT,
} from '../src/lib/local-changes';

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, oldPath: null, status: '.M', additions: null, deletions: null, staged: false, unstaged: true, ...extra });
const repo: Repository = { id: 'repo', path: 'D:/repo', name: 'repo', head: 'a'.repeat(40), branch: 'main', trusted: true, bare: false, gitDir: '.git', commonDir: '.git' };

describe('local changes model', () => {
  it('splits actual XY status into three groups without deduplicating a partially staged path or mutating the snapshot', () => {
    const both = Object.freeze(file('both.ts', { status: 'MM', staged: true }));
    const tracked = Object.freeze(file('only.ts'));
    const untracked = Object.freeze(file('new.ts', { status: '??' }));
    const source = Object.freeze([both, tracked, untracked]) as unknown as ChangedFile[];
    const groups = groupLocalChanges({ files: source });
    expect(groups.map(group => group.entries.map(entry => entry.file.path))).toEqual([['both.ts'], ['both.ts', 'only.ts'], ['new.ts']]);
    expect(groups[0].entries[0].file).toBe(both); expect(groups[1].entries[0].file).toBe(both);
    expect(groups[0].entries[0].key).not.toBe(groups[1].entries[0].key);
    expect(groups[0].entries[0].key).toBe(localChangeKey('staged', 'both.ts'));
    expect(source).toEqual([both, tracked, untracked]); expect(groupLocalChanges(null).every(group => !group.entries.length)).toBe(true);
  });

  it('uses exact staged, unstaged and new-file comparison sides, including unborn HEAD and side-specific rename paths', () => {
    const renamed = file('new/name.ts', { status: 'RM', oldPath: 'old/name.ts', staged: true });
    const groups = groupLocalChanges({ files: [renamed, file('untracked.txt', { status: '??' })] });
    expect(localDiffQuery(repo, groups[0].entries[0], DEFAULT_SETTINGS, 'staged')).toEqual({ repoId: 'repo', requestId: 'staged', path: 'new/name.ts', oldPath: 'old/name.ts', base: repo.head, target: 'INDEX', staged: true, context: 3, encoding: 'utf-8' });
    expect(localDiffQuery(repo, groups[1].entries[0], DEFAULT_SETTINGS)).toMatchObject({ base: 'INDEX', target: 'WORKTREE', staged: false, path: 'new/name.ts' });
    expect(localDiffQuery(repo, groups[1].entries[0], DEFAULT_SETTINGS)).not.toHaveProperty('oldPath');
    expect(localDiffQuery({ ...repo, head: null }, groups[0].entries[0], DEFAULT_SETTINGS).base).toBeNull();
    expect(localDiffQuery(repo, groups[2].entries[0], DEFAULT_SETTINGS)).toMatchObject({ base: 'ROOT', target: 'WORKTREE', staged: false });
    const worktreeRename = groupLocalChanges({ files: [file('after.ts', { status: '.R', oldPath: 'before.ts' })] })[1].entries[0];
    expect(localDiffQuery(repo, worktreeRename, DEFAULT_SETTINGS).oldPath).toBe('before.ts');
    expect(localFileStatus(groups[0].entries[0])).toBe('R'); expect(localFileStatus(groups[1].entries[0])).toBe('M'); expect(localFileStatus(groups[2].entries[0])).toBe('?');
  });

  it('materializes explicit literal file targets for group actions, preserving rename source and raw XY status', () => {
    const renamed = file('new/--all[1].txt', { status: 'RM', oldPath: 'old/name.txt', staged: true });
    const groups = groupLocalChanges({ files: [renamed, file('a\nfile.txt')] });
    const targets = localFileTargets([...groups[0].entries, ...groups[1].entries]);
    expect(targets).toEqual([{ path: renamed.path, oldPath: renamed.oldPath, status: 'RM' }, { path: 'a\nfile.txt', status: '.M' }]);
    targets[0].path = 'changed'; expect(renamed.path).toBe('new/--all[1].txt'); expect(localFileTargets([])).toEqual([]);
  });

  it('prepares mixed-height groups once, collapses without changing counts, and windows tens of thousands of files', () => {
    const groups = groupLocalChanges({ files: Array.from({ length: 50_000 }, (_, index) => file(`src/${index}.ts`)) });
    const layout = localChangesLayout(groups);
    expect(layout.rows).toHaveLength(50_001); expect(layout.height).toBe(28 + 50_000 * 27); expect(layout.files).toBe(50_000);
    const window = localChangesWindow(layout.rows, 28 + 20_000 * 27, 270);
    expect(window).toEqual({ first: 19_995, last: 20_018 }); expect(window.last - window.first).toBeLessThan(30);
    const collapsed = localChangesLayout(groups, new Set(['unstaged']));
    expect(collapsed.rows).toHaveLength(1); expect(collapsed.files).toBe(50_000); expect(collapsed.rows[0]).toMatchObject({ count: 50_000, height: 28, end: 28 });
    expect(localChangesWindow([], 0, 0)).toEqual({ first: 0, last: 0 });
  });

  it('bounds per-repository drafts by entries and characters, returns copies, and never treats prototype keys specially', () => {
    const drafts = new LocalChangeDrafts(2, 20);
    const draft = (message: string) => ({ message, start: 1, end: 3, direction: 'backward' as const, scrollTop: 4 });
    drafts.set('__proto__', draft('one')); drafts.set('two', draft('two'));
    const first = drafts.get('__proto__')!; first.message = 'not saved'; expect(drafts.get('__proto__')?.message).toBe('one');
    drafts.set('three', draft('three')); expect(drafts.size).toBe(2); expect(drafts.get('two')).toBeUndefined();
    drafts.set('large', draft('x'.repeat(25))); expect(drafts.length).toBe(20); expect(drafts.size).toBe(1);
    expect(drafts.get('large')?.message).toHaveLength(20);
    drafts.set('large', draft('')); expect(drafts.size).toBe(0); expect(drafts.length).toBe(0);
    const bounded = new LocalChangeDrafts(); bounded.set('r', draft('x'.repeat(LOCAL_DRAFT_LIMIT + 10))); expect(bounded.get('r')?.message).toHaveLength(LOCAL_DRAFT_LIMIT);
    bounded.clear(); expect(bounded.size).toBe(0);
  });
});
