import { describe, expect, it } from 'vitest';
import { buildPullRequestUrl, parseRemoteUrl } from '../src/lib/providers';

describe('safe transport to remote web URLs', () => {
  it('parses HTTPS, SSH URL and SCP syntax without carrying credentials or SSH ports', () => {
    for (const remote of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com:2222/owner/repo.git']) {
      expect(parseRemoteUrl(remote)).toMatchObject({ host: 'github.com', owner: 'owner', repo: 'repo', path: 'owner/repo', webBase: 'https://github.com/owner/repo' });
    }
    expect(parseRemoteUrl('http://git.example:8080/group/sub/repo.git')).toMatchObject({ host: 'git.example:8080', owner: 'group/sub', repo: 'repo', webBase: 'http://git.example:8080/group/sub/repo' });
  });
  it('rejects local paths, unsafe schemes, controls, traversal and embedded web credentials', () => {
    for (const remote of ['C:/repos/a', 'D:\\repo\\a', '/home/user/repo', 'file:///home/repo', 'javascript:alert(1)', 'https://user:password@example.com/a/b', 'https://user@example.com/a/b', 'https://example.com/a/b?q=1', 'https://example.com/a/%2e%2e', 'git@host:a/%2fescape', 'git@host:a/b\ncommand']) expect(parseRemoteUrl(remote)).toBeNull();
  });
});

describe('user-click create pull request links', () => {
  it('prefills GitHub source and target including encoded branch slashes', () => {
    const url = buildPullRequestUrl('git@github.com:owner/repo.git', 'feature/a#b', 'main'); expect(url).toBe('https://github.com/owner/repo/compare/main...feature%2Fa%23b?expand=1');
  });
  it('prefills GitLab source and target and preserves nested namespaces', () => {
    const value = buildPullRequestUrl('ssh://git@gitlab.com/group/sub/repo.git', 'feature/change', 'release/next')!; const url = new URL(value);
    expect(url.pathname).toBe('/group/sub/repo/-/merge_requests/new');
    expect(url.searchParams.get('merge_request[source_branch]')).toBe('feature/change'); expect(url.searchParams.get('merge_request[target_branch]')).toBe('release/next');
  });
  it('prefills Bitbucket branches with the full repository qualifier', () => {
    const url = new URL(buildPullRequestUrl('https://bitbucket.org/workspace/repo.git', 'feature/new', 'main')!);
    expect(url.pathname).toBe('/workspace/repo/pull-requests/new'); expect(url.searchParams.get('source')).toBe('workspace/repo::feature/new'); expect(url.searchParams.get('dest')).toBe('workspace/repo::main');
  });
  it('supports explicitly selected self-hosted providers without guessing unknown hosts', () => {
    expect(buildPullRequestUrl('git@git.company.example:team/repo.git', 'feature/x', 'main')).toBeNull();
    expect(buildPullRequestUrl('git@git.company.example:team/repo.git', 'feature/x', 'main', 'GitLab')).toContain('https://git.company.example/team/repo/-/merge_requests/new?');
  });
  it('matches custom providers by literal host and safely substitutes every component', () => {
    const provider = { name: 'Company', host: 'git.company.example', url: '{remoteWebBase}/requests/new?source={source}&target={target}&owner={owner}&repo={repo}' };
    const value = buildPullRequestUrl('git@git.company.example:team/sub/repo.git', 'feature/a&x=y', 'release/next', undefined, [provider]);
    const url = new URL(value!);
    expect(url.origin).toBe('https://git.company.example'); expect(url.pathname).toBe('/team/sub/repo/requests/new');
    expect(url.searchParams.get('source')).toBe('feature/a&x=y'); expect(url.searchParams.get('target')).toBe('release/next'); expect(url.searchParams.get('owner')).toBe('team/sub');
    expect(buildPullRequestUrl('git@evil.company.example:team/repo.git', 'main', 'release', provider)).toBeNull();
  });
  it('rejects unsafe templates, variable authorities and invalid branch values', () => {
    for (const url of ['javascript:alert({source})', 'https://user:pass@example.com/{source}', 'https://{source}.example.com/{target}', 'https://example.com/{unknown}', '//example.com/{source}']) expect(buildPullRequestUrl('https://example.com/a/b', 'feature', 'main', { name: 'x', host: 'example.com', url })).toBeNull();
    for (const branch of ['', '-oops', 'HEAD~1', 'a..b', 'a b', 'a\nb']) expect(buildPullRequestUrl('https://github.com/a/b', branch, 'main')).toBeNull();
  });
});
