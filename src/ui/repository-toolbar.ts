import type { AppSettings, Repository, WorkingState } from '../shared/protocol';
import type { Localizable } from '../lib/i18n';
import { m } from '../i18n/workspace';
import { button, el, setAttribute } from './dom';
import { icon } from './icons';

export interface RepositoryToolbarContext {
  repository: Repository | null; working: WorkingState | null; busy: boolean;
  loading: boolean; refreshLabel: Localizable; settings: AppSettings;
}
export interface RepositoryToolbarCallbacks {
  branch(anchor: HTMLElement): void; sync(): void; commit(): void;
  refresh(): void; more(anchor: HTMLElement): void;
}
export class RepositoryToolbar {
  readonly element = el('header', 'repository-toolbar');
  readonly refreshButton: HTMLButtonElement;
  private title = el('strong', 'repository-toolbar-name');
  private branch: HTMLButtonElement;
  private tracking = el('span', 'repository-toolbar-tracking mono');
  private sync: HTMLButtonElement;
  private commit: HTMLButtonElement;
  private count = el('span', 'repository-toolbar-count');
  private more: HTMLButtonElement;
  constructor(callbacks: RepositoryToolbarCallbacks) {
    setAttribute(this.element, 'aria-label', m('repository'));
    this.branch = button(m('branch'), () => callbacks.branch(this.branch), 'branch', 'repository-toolbar-branch');
    this.branch.dataset.action = 'checkout-branch'; this.branch.setAttribute('aria-haspopup', 'dialog');
    this.sync = button(m('sync'), () => callbacks.sync(), 'refresh', 'repository-toolbar-sync'); this.sync.dataset.action = 'sync';
    this.commit = button(m('commit'), () => callbacks.commit(), 'check', 'repository-toolbar-commit'); this.commit.dataset.action = 'show-local-commit';
    this.commit.append(this.count);
    this.refreshButton = button(m('refresh'), () => callbacks.refresh(), 'refresh', '', true); this.refreshButton.dataset.action = 'refresh';
    this.more = button(m('more'), () => callbacks.more(this.more), 'more', '', true); this.more.dataset.action = 'more-git-actions';
    this.element.append(icon('branch'), this.title, this.branch, this.tracking, el('span', 'spacer'), this.sync, this.commit, this.refreshButton, this.more);
  }
  update(context: RepositoryToolbarContext): void {
    const { repository: repo, working } = context;
    this.title.textContent = repo?.name ?? ''; setAttribute(this.title, 'title', repo?.path ?? m('noRepository'));
    const label = this.branch.querySelector('span');
    if (label) label.textContent = working?.branch ?? repo?.branch ?? (repo?.head ? 'HEAD' : '—');
    setAttribute(this.branch, 'title', repo?.branch ?? m(repo?.head ? 'detached' : 'unborn'));
    setAttribute(this.branch, 'aria-label', m('branch'));
    this.tracking.textContent = working?.trackingKnown && working.upstream ? `↑${working.ahead} ↓${working.behind}` : '';
    setAttribute(this.tracking, 'title', working?.upstream ?? '');
    this.count.textContent = working ? String(working.files.filter(file => file.staged).length || '') : '';
    this.sync.disabled = !repo || repo.bare || context.busy || context.loading;
    this.commit.disabled = !repo || repo.bare || context.busy;
    this.branch.disabled = !repo || context.busy || context.loading;
    this.more.disabled = !repo || context.busy;
    this.refreshButton.disabled = !repo;
    setAttribute(this.refreshButton, 'title', context.refreshLabel);
    this.refreshButton.classList.toggle('is-loading', context.loading);
    this.element.dataset.repoPath = repo?.path ?? '';
    this.element.setAttribute('aria-busy', String(context.busy || context.loading));
  }
}
