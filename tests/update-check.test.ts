import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubUpdateInfo, Host, Repository } from '../src/shared/protocol';
import { StateStore } from '../src/lib/state';
import { showSettings } from '../src/ui/settings';
import { officialUpdateReleaseUrl, UpdateCheck } from '../src/ui/updates';

// Minimal DOM double for the real controller and Settings; no browser/DOM dependency.
let htmlWrites: string[] = [];
class TestNode {
  parentElement: TestNode | null = null;
  children: TestNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, ((event: { target: TestNode; key: string; preventDefault(): void }) => void)[]>();
  className = ''; id = ''; disabled = false; hidden = false; value = ''; title = ''; type = ''; tabIndex = 0; text = ''; open = false;
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(' ')}`; } };
  constructor(readonly tagName: string, text = '') { this.text = text; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text: string) { this.replaceChildren(); this.text = text; }
  set innerHTML(text: string) { htmlWrites.push(text); }
  append(...children: (TestNode | string)[]): void { children.forEach(child => this.appendChild(typeof child === 'string' ? new TestNode('#text', child) : child)); }
  appendChild(child: TestNode): TestNode { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...children: TestNode[]): void { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = ''; this.append(...children); }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: { target: TestNode; key: string; preventDefault(): void }) => void): void { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
  emit(name: string): void { this.events.get(name)?.forEach(listener => listener({ target: this, key: '', preventDefault: vi.fn() })); }
  querySelectorAll(selector: string): TestNode[] { return this.children.flatMap(child => [...(selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector) ? [child] : [], ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): TestNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { dom.activeElement = this; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}
const dom = {
  body: new TestNode('body'), activeElement: null as TestNode | null,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text),
  querySelector: (selector: string) => dom.body.querySelector(selector),
};
const asNode = (node: HTMLElement): TestNode => node as unknown as TestNode;
function all(root: TestNode): TestNode[] { return [root, ...root.children.flatMap(all)]; }
function find(root: TestNode, predicate: (node: TestNode) => boolean): TestNode {
  const node = all(root).find(predicate); if (!node) throw new Error('Expected DOM node not found'); return node;
}
const action = (root: TestNode, name: string) => find(root, node => node.dataset.action === name);
const status = (root: TestNode) => find(root, node => 'updateStatus' in node.dataset);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function settle(): Promise<void> { for (let count = 0; count < 8; count++) await Promise.resolve(); }
const available = (patch: Partial<GithubUpdateInfo> = {}): GithubUpdateInfo => ({
  status: 'available', currentVersion: '0.2.2', latestVersion: '0.3.0', releaseTag: 'v0.3.0',
  releaseUrl: 'https://github.com/Memento1990/QGitGraph/releases/tag/v0.3.0', publishedAt: '2026-11-22T10:00:00Z',
  releaseNotes: 'A small release.', notesTruncated: false, ...patch,
});
const noRelease = (kind: 'no-release' | 'unsupported'): GithubUpdateInfo => ({ status: kind, currentVersion: '0.2.2', latestVersion: null, releaseTag: null, releaseUrl: null, publishedAt: null, releaseNotes: null, notesTruncated: false });
function makeController(checkForUpdates = vi.fn(async () => available())) {
  const host = { checkForUpdates, openUrl: vi.fn(async (_url: string): Promise<void> => undefined) };
  const controller = new UpdateCheck(host, '0.2.2'), root = asNode(controller.element); dom.body.append(root);
  return { host, controller, root };
}
const repo: Repository = { id: 'repo', name: 'fixture', path: 'D:/fixture', gitDir: '.git', commonDir: '.git', head: null, branch: null, bare: false, trusted: false };
async function makeSettings(repository: Repository | null, checkForUpdates = vi.fn(async () => available())) {
  const host = { checkForUpdates, openUrl: vi.fn(async () => undefined), saveState: vi.fn(async () => undefined) };
  const onError = vi.fn(), changed = vi.fn(), store = new StateStore(host.saveState, onError), before = structuredClone(store.state);
  await showSettings(host as unknown as Host, store, repository, null, changed, onError);
  const root = dom.querySelector('.settings-dialog')!;
  const tab = (label: string) => find(root, node => node.getAttribute('role') === 'tab' && node.textContent === label).emit('click');
  return { host, store, before, changed, onError, root, tab };
}
beforeEach(() => {
  htmlWrites = []; dom.body = new TestNode('body'); dom.activeElement = null;
  vi.stubGlobal('document', dom); vi.stubGlobal('Node', TestNode);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Renderer must not fetch updates'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('manual update controller', () => {
  it('does no work at construction/render and makes exactly one parameterless request on duplicate clicks', async () => {
    const request = deferred<GithubUpdateInfo>(), { root, host } = makeController(vi.fn(() => request.promise));
    expect(host.checkForUpdates).not.toHaveBeenCalled(); expect(status(root).dataset.updateStatus).toBe('idle');
    const check = action(root, 'check-for-updates'); check.emit('click'); check.emit('click');
    expect(host.checkForUpdates.mock.calls).toEqual([[]]); expect(check.disabled).toBe(true);
    expect(status(root).getAttribute('aria-live')).toBe('polite'); expect(status(root).dataset.updateStatus).toBe('checking');
    expect(all(root).some(node => node.textContent === 'Cancel')).toBe(false);
    request.resolve(available()); await settle(); expect(check.disabled).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });

  it('renders available versions, publication date and notes as bounded plain text, and opens only on a user click', async () => {
    const malicious = '<img src=x onerror=alert(1)>', notes = malicious + '🙂'.repeat(9000);
    const { root, host } = makeController(vi.fn(async () => available({ releaseNotes: notes })));
    action(root, 'check-for-updates').emit('click'); await settle();
    expect(status(root).dataset.updateStatus).toBe('available'); expect(root.textContent).toContain('Installed version: 0.2.2');
    expect(root.textContent).toContain('0.3.0'); expect(root.textContent).toContain('2026-11-22T10:00:00.000Z');
    const output = root.querySelector('pre')!; expect(output.textContent.startsWith(malicious)).toBe(true);
    expect(new TextEncoder().encode(output.textContent).length).toBeLessThanOrEqual(16 * 1024);
    expect(output.textContent).not.toContain('�'); expect(root.querySelector('img')).toBeNull(); expect(htmlWrites).toEqual([]);
    expect(root.textContent).toContain('Release notes are truncated'); expect(host.openUrl).not.toHaveBeenCalled();
    action(root, 'open-update-release').emit('click'); await settle();
    expect(host.openUrl).toHaveBeenCalledExactlyOnceWith(available().releaseUrl);
  });

  it('uses current for an installed version newer than the published stable, not exact latest equality', async () => {
    const { root } = makeController(vi.fn(async () => available({ status: 'current', currentVersion: '0.4.0' })));
    action(root, 'check-for-updates').emit('click'); await settle();
    expect(status(root).dataset.updateStatus).toBe('current'); expect(status(root).textContent).toContain('at least as recent');
    expect(root.textContent).toContain('Installed version: 0.4.0'); expect(root.textContent).toContain('0.3.0');
    expect(all(root).some(node => node.dataset.action === 'open-update-release')).toBe(false);
  });

  it('accepts lowercase RFC3339 separators and renders the publication date as ISO without extra requests', async () => {
    const { root, host } = makeController(vi.fn(async () => available({ status: 'current', publishedAt: '2026-11-22t10:00:00z' })));
    expect(host.checkForUpdates).not.toHaveBeenCalled();
    action(root, 'check-for-updates').emit('click'); await settle();
    expect(status(root).dataset.updateStatus).toBe('current'); expect(root.textContent).toContain('2026-11-22T10:00:00.000Z');
    expect(host.checkForUpdates.mock.calls).toEqual([[]]); expect(host.openUrl).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes no publicly published release and unsupported preview from current or errors', async () => {
    for (const kind of ['no-release', 'unsupported'] as const) {
      const { root } = makeController(vi.fn(async () => noRelease(kind)));
      action(root, 'check-for-updates').emit('click'); await settle();
      expect(status(root).dataset.updateStatus).toBe(kind);
      expect(status(root).textContent).toContain(kind === 'no-release' ? 'No publicly published stable release' : 'unavailable in this preview');
      expect(status(root).textContent).not.toContain('up to date'); expect(root.querySelector('pre')).toBeNull();
      expect(all(root).some(node => node.dataset.action === 'open-update-release')).toBe(false);
    }
  });

  it('surfaces offline, forbidden and rate-limited errors with retry and no fake latest fallback', async () => {
    for (const message of ['Offline', 'GitHub returned 403 Forbidden', 'GitHub returned 429 Too Many Requests']) {
      const { root } = makeController(vi.fn(async () => { throw { message }; }));
      action(root, 'check-for-updates').emit('click'); await settle();
      expect(status(root).dataset.updateStatus).toBe('error'); expect(status(root).textContent).toContain(message);
      expect(status(root).textContent).toContain('Retry'); expect(root.textContent).not.toContain('Latest stable');
      expect(action(root, 'check-for-updates').disabled).toBe(false);
    }
  });

  it('retries explicitly after failure and clears stale available metadata on a failed recheck', async () => {
    const retry = deferred<GithubUpdateInfo>();
    const check = vi.fn(async () => available()).mockRejectedValueOnce(new Error('Offline')).mockImplementationOnce(() => retry.promise);
    const { root, host } = makeController(check), control = action(root, 'check-for-updates');
    control.emit('click'); await settle(); expect(status(root).dataset.updateStatus).toBe('error');
    control.emit('click'); control.emit('click'); expect(check).toHaveBeenCalledTimes(2);
    retry.resolve(available()); await settle(); expect(status(root).dataset.updateStatus).toBe('available');
    const staleOpen = action(root, 'open-update-release');
    check.mockRejectedValueOnce(new Error('Offline again')); control.emit('click'); staleOpen.emit('click'); await settle();
    expect(status(root).dataset.updateStatus).toBe('error'); expect(root.textContent).not.toContain('Latest stable');
    expect(all(root).some(node => node.dataset.action === 'open-update-release')).toBe(false); expect(host.openUrl).not.toHaveBeenCalled();
    check.mockResolvedValueOnce(available()); control.emit('click'); await settle();
    staleOpen.emit('click'); await settle(); expect(host.openUrl).not.toHaveBeenCalled();
    action(root, 'open-update-release').emit('click'); await settle(); expect(host.openUrl).toHaveBeenCalledOnce();
  });

  it('ignores pending success or failure after disposal and refuses detached control actions', async () => {
    for (const fail of [false, true]) {
      const request = deferred<GithubUpdateInfo>(), { root, controller, host } = makeController(vi.fn(() => request.promise));
      const check = action(root, 'check-for-updates'); check.emit('click'); const before = root.textContent;
      controller.dispose(); if (fail) request.reject(new Error('Late failure')); else request.resolve(available()); await settle();
      expect(root.textContent).toBe(before); expect(status(root).dataset.updateStatus).toBe('checking');
      check.emit('click'); expect(host.checkForUpdates).toHaveBeenCalledTimes(1); expect(host.openUrl).not.toHaveBeenCalled();
    }
    const { root, controller, host } = makeController(); action(root, 'check-for-updates').emit('click'); await settle();
    controller.dispose(); action(root, 'open-update-release').emit('click'); expect(host.openUrl).not.toHaveBeenCalled();
  });

  it('rejects malformed fields, inconsistent tags and unsafe URLs without rendering latest or opening anything', async () => {
    const invalid: unknown[] = [null, {}, available({ status: 'unexpected' as 'available' }), available({ currentVersion: 'unknown' }),
      available({ latestVersion: null }), available({ releaseTag: 'v0.3.1' }), available({ publishedAt: 'not a date' }),
      available({ releaseNotes: {} as string }), available({ notesTruncated: 'yes' as unknown as boolean }),
      { ...noRelease('no-release'), releaseUrl: available().releaseUrl }, available({ releaseUrl: 'https://evil.test/release' })];
    for (const value of invalid) {
      const { root, host } = makeController(vi.fn(async () => value as GithubUpdateInfo));
      action(root, 'check-for-updates').emit('click'); await settle();
      expect(status(root).dataset.updateStatus).toBe('error'); expect(status(root).textContent).toContain('Invalid release information');
      expect(root.textContent).not.toContain('Latest stable'); expect(root.querySelector('pre')).toBeNull(); expect(host.openUrl).not.toHaveBeenCalled();
    }
  });

  it('permits only the exact official HTTPS tag URL and matching normalized stable SemVer', () => {
    const base = 'https://github.com/Memento1990/QGitGraph/releases/tag/v0.3.0';
    for (const url of ['http://github.com/Memento1990/QGitGraph/releases/tag/v0.3.0', 'javascript:alert(1)', 'file:///tmp/release',
      'https://github.com.evil.test/Memento1990/QGitGraph/releases/tag/v0.3.0', 'https://user:pass@github.com/Memento1990/QGitGraph/releases/tag/v0.3.0',
      'https://github.com/Memento1990/Other/releases/tag/v0.3.0', 'https://evil.test/redirect?url=' + base,
      base + '?next=https://evil.test', base + '#fragment', base + '/', base + '\\', base + '\n', base.replace('v0.3.0', '%760.3.0'),
      base.replace('github.com', 'github.com:443'), ' ' + base]) {
      expect(officialUpdateReleaseUrl(available({ releaseUrl: url })), url).toBeNull();
    }
    for (const tag of ['v0.3.0-rc.1', 'V0.3.0', 'v00.3.0', 'v0.3.0\n', '../latest']) {
      expect(officialUpdateReleaseUrl(available({ releaseTag: tag, latestVersion: tag, releaseUrl: `https://github.com/Memento1990/QGitGraph/releases/tag/${tag}` }))).toBeNull();
    }
    expect(officialUpdateReleaseUrl(available())).toBe(base);
    expect(officialUpdateReleaseUrl(available({ releaseTag: '0.3.0', latestVersion: 'v0.3.0', releaseUrl: base.replace('/v0.3.0', '/0.3.0') }))).toBe(base.replace('/v0.3.0', '/0.3.0'));
    const build = available({ releaseTag: 'v0.3.0+build.1', latestVersion: '0.3.0+build.1', releaseUrl: base + '+build.1' });
    expect(officialUpdateReleaseUrl(build)).toBe(base + '+build.1');
    expect(officialUpdateReleaseUrl({ ...build, latestVersion: '0.3.0+other' })).toBeNull();
    expect(officialUpdateReleaseUrl({ ...available(), status: 'no-release' })).toBeNull();
  });

  it('keeps stale release-page failures out of a newer check result and ignores late open failures after disposal', async () => {
    const { root, host, controller } = makeController(), opening = deferred<void>();
    action(root, 'check-for-updates').emit('click'); await settle();
    host.openUrl.mockImplementationOnce(() => opening.promise); action(root, 'open-update-release').emit('click');
    host.checkForUpdates.mockResolvedValueOnce(noRelease('no-release')); action(root, 'check-for-updates').emit('click'); await settle();
    opening.reject(new Error('Old browser failure')); await settle(); expect(status(root).dataset.updateStatus).toBe('no-release');
    action(root, 'check-for-updates').emit('click'); await settle();
    const late = deferred<void>(); host.openUrl.mockImplementationOnce(() => late.promise); action(root, 'open-update-release').emit('click');
    controller.dispose(); const before = root.textContent; late.reject(new Error('Closed browser failure')); await settle(); expect(root.textContent).toBe(before);
  });

  it('validates before opening, and keeps open failures local and retryable', async () => {
    const { root, host } = makeController(); action(root, 'check-for-updates').emit('click'); await settle();
    host.openUrl.mockRejectedValueOnce(new Error('Browser unavailable'));
    const open = action(root, 'open-update-release'); open.emit('click'); await settle();
    expect(status(root).dataset.updateStatus).toBe('error'); expect(status(root).textContent).toContain('Retry Open release page'); expect(open.disabled).toBe(false);
    open.emit('click'); await settle(); expect(host.openUrl).toHaveBeenCalledTimes(2);
  });
});

describe('Settings About update lifecycle', () => {
  it('never checks on opening Settings or About, with or without an untrusted repository, and never persists check state', async () => {
    for (const repository of [null, repo]) {
      const { host, store, before, root, tab, changed, onError } = await makeSettings(repository);
      expect(host.checkForUpdates).not.toHaveBeenCalled(); tab('About & privacy'); tab('Appearance'); tab('About & privacy');
      expect(host.checkForUpdates).not.toHaveBeenCalled(); expect(root.textContent).toContain('Only an explicit Check for updates');
      expect(root.textContent).toContain('External avatars are opt-in'); const saveStatus = find(root, node => 'settingStatus' in node.dataset).textContent;
      action(root, 'check-for-updates').emit('click'); await settle();
      expect(host.checkForUpdates.mock.calls).toEqual([[]]); expect(status(root).dataset.updateStatus).toBe('available');
      expect(find(root, node => 'settingStatus' in node.dataset).textContent).toBe(saveStatus);
      expect(store.state).toEqual(before); expect(store.dirty).toBe(false); expect(host.saveState).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
      find(root, node => node.tagName === 'button' && node.title === 'Close').emit('click'); await settle();
      expect(dom.querySelector('.settings-dialog')).toBeNull(); expect(host.saveState).not.toHaveBeenCalled();
    }
  });

  it('retains a pending request/result across About tabs and scope rebuilds without duplicate requests or settings-save interference', async () => {
    const request = deferred<GithubUpdateInfo>(), settings = await makeSettings(repo, vi.fn(() => request.promise));
    const { root, host, tab, store, before } = settings; tab('About & privacy');
    action(root, 'check-for-updates').emit('click'); tab('Appearance'); tab('About & privacy');
    expect(status(root).dataset.updateStatus).toBe('checking'); const pendingCheck = action(root, 'check-for-updates');
    expect(pendingCheck.disabled).toBe(true); pendingCheck.emit('click'); expect(host.checkForUpdates).toHaveBeenCalledTimes(1);
    tab('Appearance'); request.resolve(available()); await settle(); tab('About & privacy');
    expect(status(root).dataset.updateStatus).toBe('available');
    const selector = find(root, node => 'settingScope' in node.dataset); selector.value = ''; selector.emit('change'); await settle();
    expect(status(root).dataset.updateStatus).toBe('available'); expect(host.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(store.state).toEqual(before); expect(host.saveState).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a closed dialog response after reopening another Settings dialog', async () => {
    const request = deferred<GithubUpdateInfo>(), old = await makeSettings(null, vi.fn(() => request.promise));
    old.tab('About & privacy'); action(old.root, 'check-for-updates').emit('click');
    find(old.root, node => node.tagName === 'button' && node.title === 'Close').emit('click'); await settle();
    const current = await makeSettings(null); current.tab('About & privacy');
    request.resolve(available()); await settle();
    expect(status(current.root).dataset.updateStatus).toBe('idle'); expect(current.host.checkForUpdates).not.toHaveBeenCalled();
    expect(status(old.root).dataset.updateStatus).toBe('checking'); expect(current.host.saveState).not.toHaveBeenCalled();
  });
});
