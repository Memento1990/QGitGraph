import { describe, expect, it, vi } from 'vitest';
import type { Host } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/shared/protocol';
import { ACTION_DATA_IDS, ACTION_GROUPS, ACTION_LABELS, GitActions, actionPreflight, signingValue, splitRemoteBranch, type ActionContext } from '../src/ui/actions';

const context = (): ActionContext => ({
  repo: { id: 'repo', name: 'repo', path: 'D:/repo', gitDir: 'D:/repo/.git', commonDir: 'D:/repo/.git', head: '1'.repeat(40), branch: 'main', bare: false, trusted: true },
  settings: structuredClone(DEFAULT_SETTINGS), selected: '1'.repeat(40),
  refs: [{ name: 'main', fullName: 'refs/heads/main', oid: '1'.repeat(40), kind: 'branch', upstream: 'origin/main', current: true, subject: '' }],
  remotes: [{ name: 'origin', fetchUrl: 'https://example.com/a/b', pushUrl: 'https://example.com/a/b' }], stashes: [],
  working: { files: [], branch: 'main', ahead: 0, behind: 0, conflicts: 0, operation: null },
});

describe('settings action dialog public contracts', () => {
  it('distinguishes follow-Git from explicit sign and no-sign instead of coercing to boolean', () => {
    expect(signingValue('git')).toBeUndefined(); expect(signingValue('sign')).toBe(true); expect(signingValue('no-sign')).toBe(false);
  });
  it('exposes every new remote action with labels and settings groups', () => {
    for (const kind of ['remote-branch-delete', 'fetch-into', 'checkout-remote'] as const) { expect(ACTION_LABELS[kind]).toBeTruthy(); expect(ACTION_GROUPS.some(group => group.kinds.includes(kind))).toBe(true); }
    expect(ACTION_DATA_IDS).toMatchObject({ 'branch-create': 'create-branch', 'branch-delete': 'delete-branch', 'tag-create': 'create-tag', 'tag-delete': 'delete-tag' });
  });
  it('splits remote branches using the longest configured remote prefix rather than the first slash', () => {
    const remotes = [ { name: 'company', fetchUrl: '', pushUrl: '' }, { name: 'company/team', fetchUrl: '', pushUrl: '' } ];
    expect(splitRemoteBranch('refs/remotes/company/team/feature/a', remotes)).toEqual({ remote: 'company/team', branch: 'feature/a' });
    expect(splitRemoteBranch('company/feature/a', remotes)).toEqual({ remote: 'company', branch: 'feature/a' });
    expect(splitRemoteBranch('unknown/main', remotes)).toBeNull();
  });
  it('surfaces clear read-only and operation preflight failures without attempting mutations', async () => {
    const value = context(); value.repo!.bare = true; const execute = vi.fn(async () => null); const error = vi.fn();
    const actions = new GitActions({} as Host, { context: () => value, execute, error, changed: vi.fn(), toast: vi.fn() });
    await actions.show('merge'); expect(error).toHaveBeenCalledOnce(); expect(String(error.mock.calls[0][0])).toContain('bare repository'); expect(execute).not.toHaveBeenCalled();
    value.repo!.bare = false; value.working!.operation = 'rebase'; expect(actionPreflight('merge', value)).toContain('already in progress');
    value.working!.conflicts = 1; expect(actionPreflight('continue', value)).toContain('Resolve every conflict');
    value.working!.operation = null; expect(actionPreflight('abort', value)).toContain('No merge');
  });
  it('keeps menu visibility as presentation only and emits stable action ids', () => {
    const value = context(); const actions = new GitActions({} as Host, { context: () => value, execute: vi.fn(async () => null), error: vi.fn(), changed: vi.fn(), toast: vi.fn() });
    const item = actions.item('branch-create') as { dataAction?: string } | null; expect(item?.dataAction).toBe('create-branch');
    value.settings.hiddenActions = ['branch-create']; expect(actions.item('branch-create')).toBeNull(); expect(actions.visible('merge')).toBe(true);
  });
});
