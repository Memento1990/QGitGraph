import type { GithubUpdateInfo, Host } from '../shared/protocol';
import { errorMessage } from '../lib/format';
import { isRecord } from '../lib/settings-schema';
import { button, el } from './dom';

const MAX_NOTES_BYTES = 16 * 1024;
const INVALID_RELEASE = 'Invalid release information from the update service.';

function normalizedVersion(value: unknown, stable = false): string | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value || stable && match[2] || match[2]?.split('.').some(part => /^0\d+$/.test(part))) return null;
  return value.startsWith('v') ? value.slice(1) : value;
}

/** Exact official tag URL only; generic HTTP URL validation is too broad for updates. */
export function officialUpdateReleaseUrl(info: Pick<GithubUpdateInfo, 'status' | 'latestVersion' | 'releaseTag' | 'releaseUrl'>): string | null {
  if (info.status !== 'available' && info.status !== 'current') return null;
  const tag = normalizedVersion(info.releaseTag, true), latest = normalizedVersion(info.latestVersion, true);
  if (!tag || tag !== latest) return null;
  const expected = `https://github.com/Memento1990/QGitGraph/releases/tag/${info.releaseTag}`;
  return info.releaseUrl === expected ? expected : null;
}

function validateRelease(value: unknown): GithubUpdateInfo {
  if (!isRecord(value) || !normalizedVersion(value.currentVersion) || typeof value.notesTruncated !== 'boolean') throw new Error(INVALID_RELEASE);
  if (value.status === 'no-release' || value.status === 'unsupported') {
    if (['latestVersion', 'releaseTag', 'releaseUrl', 'publishedAt', 'releaseNotes'].some(key => value[key] !== null) || value.notesTruncated) throw new Error(INVALID_RELEASE);
    return { status: value.status, currentVersion: value.currentVersion as string, latestVersion: null, releaseTag: null, releaseUrl: null, publishedAt: null, releaseNotes: null, notesTruncated: false };
  }
  if (value.status !== 'available' && value.status !== 'current') throw new Error(INVALID_RELEASE);
  if (value.publishedAt !== null && (typeof value.publishedAt !== 'string' || value.publishedAt.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt)))) throw new Error(INVALID_RELEASE);
  if (value.releaseNotes !== null && typeof value.releaseNotes !== 'string') throw new Error(INVALID_RELEASE);
  const info = value as unknown as GithubUpdateInfo;
  if (!officialUpdateReleaseUrl(info)) throw new Error(INVALID_RELEASE);
  // Cap UTF-8 bytes without splitting a multibyte sequence, even if the host missed its cap.
  const notes = info.releaseNotes;
  const bytes = new TextEncoder().encode((notes ?? '').slice(0, MAX_NOTES_BYTES));
  let end = Math.min(bytes.length, MAX_NOTES_BYTES);
  if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
  const bounded = new TextDecoder().decode(bytes.subarray(0, end));
  return { ...info, releaseNotes: notes === null ? null : bounded, notesTruncated: info.notesTruncated || notes !== null && bounded !== notes };
}

/** Dialog-local, manual-only controller. It has no settings, repository or Git busy state. */
export class UpdateCheck {
  readonly element = el('section', 'update-check');
  private readonly installed = el('p', 'muted');
  private readonly checkButton = button('Check for updates', () => { void this.check(); });
  private readonly status = el('p', 'muted', 'Updates are checked only when you choose Check for updates.');
  private readonly result = el('div');
  private info: GithubUpdateInfo | null = null;
  private pending = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly host: Pick<Host, 'checkForUpdates' | 'openUrl'>, currentVersion = 'Unknown') {
    this.installed.textContent = `Installed version: ${currentVersion}`; this.installed.dataset.updateCurrentVersion = '';
    this.checkButton.dataset.action = 'check-for-updates';
    this.status.dataset.updateStatus = 'idle'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.status.setAttribute('aria-atomic', 'true');
    this.element.append(el('h4', '', 'Updates'), this.installed, el('div', 'inline-actions', this.checkButton), this.status, this.result);
  }

  dispose(): void { this.disposed = true; this.generation++; this.checkButton.disabled = true; }

  private feedback(state: string, message: string): void { this.status.dataset.updateStatus = state; this.status.textContent = message; }

  private async check(): Promise<void> {
    if (this.disposed || this.pending) return;
    const generation = ++this.generation;
    this.pending = true; this.checkButton.disabled = true; this.info = null; this.result.replaceChildren();
    this.feedback('checking', 'Checking for the latest stable release…');
    try {
      const response = await this.host.checkForUpdates();
      if (this.disposed || generation !== this.generation) return;
      const info = validateRelease(response); this.info = info;
      this.installed.textContent = `Installed version: ${info.currentVersion}`;
      if (info.status === 'unsupported') { this.feedback('unsupported', 'Update checks are unavailable in this preview. Use the desktop application.'); return; }
      if (info.status === 'no-release') { this.feedback('no-release', 'No publicly published stable release was found. You can check again later.'); return; }
      this.feedback(info.status, info.status === 'available' ? 'A newer stable release is available.' : 'Your installed version is at least as recent as the latest stable release.');
      const details = el('dl', 'about-details', el('dt', '', 'Latest stable'), el('dd', 'mono', info.latestVersion), el('dt', '', 'Published'), el('dd', '', info.publishedAt ? new Date(info.publishedAt).toISOString() : 'Not provided'));
      this.result.append(details);
      if (info.status === 'available') {
        if (info.releaseNotes) this.result.append(el('h4', '', 'Release notes'), el('pre', 'output-text', info.releaseNotes));
        if (info.notesTruncated) this.result.append(el('p', 'muted', 'Release notes are truncated. Read the full notes on the release page.'));
        const open = button('Open release page', () => { void this.openRelease(open, generation); }); open.dataset.action = 'open-update-release';
        this.result.append(el('div', 'inline-actions', open));
      }
    } catch (failure) {
      if (!this.disposed && generation === this.generation) this.feedback('error', `Could not check for updates: ${errorMessage(failure).slice(0, 2048)} Retry using Check for updates.`);
    } finally {
      if (!this.disposed && generation === this.generation) { this.pending = false; this.checkButton.disabled = false; }
    }
  }

  private async openRelease(control: HTMLButtonElement, generation: number): Promise<void> {
    if (this.disposed || this.pending || generation !== this.generation || control.disabled || this.info?.status !== 'available') return;
    const url = officialUpdateReleaseUrl(this.info);
    if (!url) { this.feedback('error', `${INVALID_RELEASE} Retry using Check for updates.`); return; }
    control.disabled = true;
    try { await this.host.openUrl(url); }
    catch (failure) { if (!this.disposed && generation === this.generation) this.feedback('error', `Could not open the release page: ${errorMessage(failure).slice(0, 2048)} Retry Open release page.`); }
    finally { if (!this.disposed && generation === this.generation) control.disabled = false; }
  }
}
