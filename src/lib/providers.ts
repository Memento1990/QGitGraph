import type { PullRequestProvider } from '../shared/protocol';
import { PR_TEMPLATE_PLACEHOLDERS, safeHttpUrl, validateUrlTemplate } from './settings-schema';

export interface ParsedRemote {
  host: string; hostname: string; owner: string; repo: string; path: string; webBase: string;
}
/** Parse a transport URL without contacting the server. SSH credentials are never copied into a web URL. */
export function parseRemoteUrl(remoteUrl: string): ParsedRemote | null {
  if (!remoteUrl || remoteUrl.length > 8192 || /[\s\u0000-\u001f\u007f\\]/.test(remoteUrl)) return null;
  let host: string; let hostname: string; let path: string; let protocol = 'https:';
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(remoteUrl)) {
      const url = new URL(remoteUrl);
      const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/]*(\/[^?#]*)?/i.exec(remoteUrl)?.[1] ?? '';
      if (rawPath.split('/').some(segment => { const decoded = decodeURIComponent(segment); return decoded === '.' || decoded === '..'; })) return null;
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.search || url.hash || url.password || !url.hostname) return null;
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.username) return null;
      host = url.protocol === 'ssh:' || url.protocol === 'git:' ? url.hostname : url.host;
      hostname = url.hostname; path = url.pathname;
      if (url.protocol === 'https:' || url.protocol === 'http:') protocol = url.protocol;
    } else {
      // SCP notation accepts an optional SSH username, a literal hostname (or bracketed IPv6), and an absolute repo path.
      const match = /^(?:[a-z\d._-]+@)?(\[[a-f\d:]+\]|[a-z\d][a-z\d.-]*):\/?(.+)$/i.exec(remoteUrl);
      if (!match || /^[a-z]:/i.test(remoteUrl)) return null;
      host = match[1]; hostname = match[1]; path = match[2];
    }
    path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    const segments = path.split('/').map(segment => decodeURIComponent(segment));
    if (segments.length < 2 || segments.length > 64 || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f\\/?#]/.test(segment))) return null;
    const repo = segments[segments.length - 1]; const owner = segments.slice(0, -1).join('/');
    const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/');
    const webBase = safeHttpUrl(`${protocol}//${host}/${encodedPath}`);
    if (!webBase) return null;
    return { host: host.toLowerCase(), hostname: hostname.toLowerCase(), owner, repo, path: segments.join('/'), webBase: webBase.replace(/\/$/, '') };
  } catch { return null; }
}
export const parseGitRemote = parseRemoteUrl;

/** Template values are encoded as individual components; the verified web base is the only URL-valued substitution. */
export function expandPullRequestTemplate(template: string, remote: ParsedRemote, source: string, target: string): string | null {
  if (validateUrlTemplate(template, PR_TEMPLATE_PLACEHOLDERS, false)) return null;
  const values: Record<string, string> = {
    id: '', commit: '', branch: source, source, target, owner: remote.owner, repo: remote.repo,
    host: remote.host, baseUrl: remote.webBase, remoteWebBase: remote.webBase, remote: remote.webBase,
  };
  const url = template.replace(/\{([^{}]+)\}/g, (_match, name: string) => ['baseUrl', 'remoteWebBase', 'remote'].includes(name) ? remote.webBase : encodeURIComponent(values[name] ?? ''));
  return safeHttpUrl(url);
}
function branch(value: string): boolean { return Boolean(value) && value.length <= 1024 && !/[\s\u0000-\u001f\u007f\\~^:?*\[\]]|\.\.|@\{|^[-/]|[/.]$/.test(value); }

/** Build a user-activated create-PR link. This module makes NO network or account API requests.
 * provider can name a built-in provider, select a custom template by name, or provide {name,host,url} directly.
 * Templates match literal remote hosts (optionally with a web port); no wildcard host matching is performed.
 */
export function buildPullRequestUrl(remoteUrl: string, source: string, target: string, provider?: string | PullRequestProvider, templates: PullRequestProvider[] = []): string | null {
  if (!branch(source) || !branch(target)) return null;
  const remote = parseRemoteUrl(remoteUrl); if (!remote) return null;
  const matchesHost = (entry: PullRequestProvider): boolean => entry.host.toLowerCase() === remote.host || entry.host.toLowerCase() === remote.hostname;
  let custom: PullRequestProvider | undefined;
  let kind = typeof provider === 'string' ? provider.toLowerCase() : '';
  if (typeof provider === 'object') { if (!matchesHost(provider)) return null; custom = provider; }
  else if (provider) custom = templates.find(entry => entry.name.toLowerCase() === kind && matchesHost(entry));
  else custom = templates.find(matchesHost);
  if (custom) return expandPullRequestTemplate(custom.url, remote, source, target);
  if (!kind) {
    if (remote.hostname === 'github.com' || remote.hostname === 'www.github.com') kind = 'github';
    else if (remote.hostname === 'gitlab.com' || remote.hostname === 'www.gitlab.com') kind = 'gitlab';
    else if (remote.hostname === 'bitbucket.org' || remote.hostname === 'www.bitbucket.org') kind = 'bitbucket';
    else return null;
  }
  const encodedSource = encodeURIComponent(source); const encodedTarget = encodeURIComponent(target);
  if (kind === 'github') return safeHttpUrl(`${remote.webBase}/compare/${encodedTarget}...${encodedSource}?expand=1`);
  if (kind === 'gitlab') return safeHttpUrl(`${remote.webBase}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodedSource}&merge_request%5Btarget_branch%5D=${encodedTarget}`);
  if (kind === 'bitbucket') {
    // Bitbucket's documented repository::branch form pre-fills both branches without needing an API lookup of a repository UUID.
    const sourceSpec = `${remote.path}::${source}`; const targetSpec = `${remote.path}::${target}`;
    return safeHttpUrl(`${remote.webBase}/pull-requests/new?source=${encodeURIComponent(sourceSpec)}&dest=${encodeURIComponent(targetSpec)}`);
  }
  return null;
}
