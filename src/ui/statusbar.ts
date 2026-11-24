import { m } from '../i18n/status';
import { numberText, shortOid } from '../lib/format';
import { getLanguage, localized, onLocaleChange, resolveText, type Localizable } from '../lib/i18n';
import { countWorkingFiles, deriveStatus, type StatusActivity, type StatusCancelScope, type StatusCounts, type StatusInput, type StatusModel, type StatusResult, type StatusTask } from '../lib/status';
import type { ChangedFile, ExternalSession } from '../shared/protocol';
import { button, disposeBindings, el, setAttribute, setText } from './dom';
import { icon, type IconName } from './icons';
import './statusbar.css';

export interface StatusBarCallbacks {
  copyPath?: (fullPath: string) => void;
  changeLanguage?: () => void;
  trust?: () => void;
  /** The history channel only, never cancelAll(). */
  cancelHistory?: () => void;
  /** Must use the existing warning that cancellation does not roll back Git changes. */
  cancelWrite?: () => void;
  openWorking?: () => void;
}
interface StatusSlot { element: HTMLElement; label: HTMLElement }
interface StatusFact { element: HTMLElement; value: HTMLElement }
type FactName = 'repository' | 'path' | 'branch' | 'trust' | 'location' | 'working' | 'counts' | 'operation' | 'tracking' | 'history' | 'activity' | 'refresh' | 'result' | 'compare' | 'sessions' | 'git' | 'workingError' | 'historyError' | 'language';
let nextDetailsId = 0;

function number(value: number): Localizable { return numberText(value); }
function time(value: number, full = false): Localizable {
  return localized(locale => new Intl.DateTimeFormat(locale, full
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)));
}
function previous(value: Localizable, stale: boolean): Localizable { return stale ? m('previousSnapshot', { value }) : value; }
function branchText(model: StatusModel): Localizable {
  const context = model.context;
  if (context.headKind === 'unborn') return m('unborn', { branch: context.branch });
  if (context.headKind === 'branch') return context.branch!;
  if (context.headKind === 'detached') return m('detached', { oid: shortOid(context.head!) });
  return m('headUnknown');
}
function summaryText(model: StatusModel): Localizable {
  const working = model.working;
  switch (working.kind) {
    case 'bare': return m('bare');
    case 'loading': return m('workingLoading');
    case 'error': return m('workingError');
    case 'unknown': return m('workingUnknown');
    case 'clean': return m(working.stale ? 'previousClean' : 'clean');
    case 'changed': case 'conflict': return m(working.stale ? 'previousChanged' : 'changed', { count: number(working.counts!.changed) });
    default: return m('noRepository');
  }
}
function countsDescription(model: StatusModel): Localizable {
  const counts = model.working.counts;
  if (!counts) return summaryText(model);
  return previous(m('countsDescription', {
    changed: number(counts.changed), staged: number(counts.staged), unstaged: number(counts.unstaged),
    untracked: number(counts.untracked), conflicts: number(counts.conflicts),
  }), model.working.stale);
}
function operationText(model: StatusModel): Localizable {
  switch (model.working.operation) {
    case 'merge': return previous(m('operationMerge'), model.working.stale);
    case 'rebase': return previous(m('operationRebase'), model.working.stale);
    case 'cherry-pick': return previous(m('operationCherryPick'), model.working.stale);
    case 'revert': return previous(m('operationRevert'), model.working.stale);
    default: return m('operationNone');
  }
}
function trackingText(model: StatusModel, description = false): Localizable {
  const tracking = model.tracking;
  let text: Localizable;
  switch (tracking.kind) {
    case 'counts': text = m(description ? 'trackingDescription' : 'trackingCounts', { upstream: tracking.upstream, ahead: number(tracking.ahead!), behind: number(tracking.behind!) }); break;
    case 'upstream': text = m(description ? 'trackingUnmeasured' : 'upstreamUnknown', { upstream: tracking.upstream }); break;
    case 'no-upstream': text = m('noUpstream'); break;
    case 'not-applicable': text = m('trackingNotApplicable'); break;
    default: text = m('trackingUnknown');
  }
  return previous(text, tracking.stale);
}
function historyText(model: StatusModel, description = false): Localizable {
  const history = model.history;
  let text: Localizable;
  if (!history.loaded && history.kind !== 'ready') text = m(history.loading ? 'historyLoading' : history.error ? 'historyError' : 'historyUnknown');
  else if (description) text = m('historyDescription', { visible: number(history.visible), loaded: number(history.loaded), more: m(history.hasMore ? 'moreHistory' : 'loadedHistory') });
  else text = m('historyCounts', { visible: number(history.visible), loaded: number(history.loaded), more: history.hasMore ? m('moreMarker') : '' });
  return history.stale ? m('historyStale', { value: text }) : text;
}
function taskText(task: StatusTask): Localizable {
  if (task.label !== '') return task.label;
  switch (task.kind) {
    case 'write': return m('writeRunning');
    case 'discover': return m('discoverRunning');
    case 'open': return m('opening');
    case 'history': return m('historyLoading');
    case 'refresh': return m('refreshing');
  }
}
function sessionText(session: ExternalSession): Localizable {
  switch (session.status) {
    case 'started': return m('externalStarted', { kind: session.kind });
    case 'running': return m('externalRunning', { kind: session.kind });
    case 'paused': return m('externalPaused', { kind: session.kind });
    case 'failed': return m('externalFailed', { kind: session.kind });
    case 'completed': return m('externalCompleted', { kind: session.kind });
  }
}
function resultText(result: StatusResult): Localizable {
  switch (result.kind) {
    case 'success': return m('resultSuccess', { message: result.message });
    case 'error': return m('resultError', { message: result.message });
    case 'cancelled': return m('resultCancelled', { message: result.message });
    case 'info': return m('resultInfo', { message: result.message });
  }
}
function activityText(model: StatusModel): Localizable {
  const activity = model.activity;
  switch (activity.kind) {
    case 'task': return taskText(activity.task);
    case 'external': return sessionText(activity.session);
    case 'result': return resultText(activity.result);
    case 'compare': return m('compare', { oid: shortOid(activity.base) });
    case 'idle': return model.state === 'initializing' ? m('initializing') : activity.gitVersion || m('localHistory');
  }
}
function activityIcon(activity: StatusActivity): IconName {
  if (activity.kind === 'external') return activity.session.status === 'paused' ? 'warning' : 'terminal';
  if (activity.kind === 'result') return activity.result.kind === 'error' ? 'warning' : activity.result.kind === 'success' ? 'check' : 'info';
  if (activity.kind === 'compare') return 'compare';
  if (activity.kind === 'task') return 'clock';
  return 'info';
}

/** Stable semantic footer. All effects belong to callbacks; this component never talks to Host. */
export class StatusBar {
  readonly element = el('footer', 'statusbar statusbar--compact');
  private readonly context = el('div', 'statusbar-group statusbar-context');
  private readonly working = el('div', 'statusbar-group statusbar-working');
  private readonly activity = el('div', 'statusbar-group statusbar-activity');
  private readonly repository = this.slot('repository', 'folder', 'secondary', () => this.showDetails());
  private readonly location = this.slot('location', 'folder', 'tertiary');
  private readonly branch = this.slot('branch', 'branch', 'essential');
  private readonly trust = this.slot('trust', 'shield', 'secondary', () => this.callbacks.trust ? this.callbacks.trust() : this.showDetails());
  private readonly sync = this.slot('sync', 'remote', 'tertiary');
  private readonly summary = this.slot('summary', 'file', 'essential', () => {
    if (this.callbacks.openWorking && this.model?.repository && this.model.working.counts) this.callbacks.openWorking();
    else this.showDetails();
  });
  private readonly conflicts = this.slot('conflicts', 'warning', 'essential');
  private readonly operation = this.slot('operation', 'merge', 'essential');
  private readonly counts = this.slot('counts', undefined, 'secondary');
  private readonly history = this.slot('history', 'list', 'tertiary');
  private readonly task = this.slot('task', undefined, 'essential');
  private readonly taskGlyph = el('span', 'statusbar-task-glyph');
  private readonly cancel = button(m('cancelHistory'), () => this.cancelCurrent(), 'stop', 'statusbar-item statusbar-cancel statusbar-tier-essential', true);
  private readonly refresh = this.slot('refresh', 'clock', 'tertiary');
  private readonly language = this.slot('language', undefined, 'essential', () => this.callbacks.changeLanguage?.());
  private readonly details = button(m('details'), () => this.showDetails(), 'more', 'statusbar-item statusbar-details statusbar-tier-essential', true);
  private readonly announcer = el('span', 'statusbar-live');
  private readonly dialog = el('dialog', 'dialog statusbar-dialog');
  private readonly facts = new Map<FactName, StatusFact>();
  private readonly copyPath = button(m('copyPath'), () => { if (this.model?.repository) this.callbacks.copyPath?.(this.model.repository.path); }, 'copy');
  private readonly manageTrust = button(m('manageTrust'), () => { this.closeDetails(); this.callbacks.trust?.(); }, 'shield');
  private readonly openWorking = button(m('openWorking'), () => { this.closeDetails(); this.callbacks.openWorking?.(); }, 'file');
  private readonly changeLanguage = button(m('changeLanguage'), () => { this.closeDetails(); this.callbacks.changeLanguage?.(); });
  private readonly unlistenLocale: () => void;
  private input: StatusInput | null = null;
  private model: StatusModel | null = null;
  private taskKey = '';
  private readonly resultKeys = new Set<string>();
  private readonly sessionKeys = new Map<string, string>();
  private taskGlyphKind = '';
  private cancelScope: StatusCancelScope | null = null;
  private previousFocus: HTMLElement | null = null;
  /**
   * Production snapshots own readonly raw file arrays and entries: refreshes replace the
   * array rather than mutate it. Cache only their counts, never other status/freshness fields.
   * A single entry avoids retaining old snapshots and is invalidated across repositories.
   */
  private countsMemo?: { repoId: string; files: readonly ChangedFile[]; counts: StatusCounts };
  private destroyed = false;

  constructor(private readonly callbacks: StatusBarCallbacks = {}) {
    setAttribute(this.element, 'aria-label', m('footer'));
    for (const [node, label] of [[this.context, m('contextGroup')], [this.working, m('workingGroup')], [this.activity, m('activityGroup')]] as const) {
      node.setAttribute('role', 'group'); setAttribute(node, 'aria-label', label);
    }
    this.summary.label.classList.add('status-text'); this.task.label.classList.add('task-text');
    this.task.element.insertBefore(this.taskGlyph, this.task.label);
    this.repository.element.dataset.action = 'status-repository-details';
    this.details.dataset.action = 'status-details'; this.language.element.dataset.action = 'status-language';
    this.trust.element.dataset.action = 'status-trust'; this.cancel.dataset.action = 'status-cancel';
    this.summary.element.dataset.action = 'status-working';
    this.details.setAttribute('aria-haspopup', 'dialog'); this.details.setAttribute('aria-expanded', 'false');
    this.repository.element.setAttribute('aria-haspopup', 'dialog');
    this.context.append(this.repository.element, this.location.element, this.branch.element, this.trust.element, this.sync.element);
    this.working.append(this.summary.element, this.conflicts.element, this.operation.element, this.counts.element, this.history.element);
    this.activity.append(this.task.element, this.cancel, this.refresh.element, this.language.element, this.details);
    this.announcer.setAttribute('role', 'status'); this.announcer.setAttribute('aria-live', 'polite'); this.announcer.setAttribute('aria-atomic', 'true');
    this.element.append(this.context, this.working, this.activity, this.announcer);
    this.buildDetails();
    this.unlistenLocale = onLocaleChange(() => { if (this.input && !this.destroyed) this.update(this.input); });
  }

  private slot(name: string, glyph: IconName | undefined, tier: 'essential' | 'secondary' | 'tertiary', action?: () => void): StatusSlot {
    const node = action ? button('', action) : el('span');
    if (action) node.replaceChildren();
    node.classList.add('statusbar-item', `statusbar-${name}`, `statusbar-tier-${tier}`);
    if (action) node.setAttribute('aria-haspopup', 'dialog');
    if (glyph) node.append(icon(glyph));
    const label = el('span', 'statusbar-label'); node.append(label);
    return { element: node, label };
  }
  private text(slot: StatusSlot, value: Localizable, title: Localizable = value): void {
    setText(slot.label, value); setAttribute(slot.element, 'title', title);
    if (slot.element.tagName === 'BUTTON') setAttribute(slot.element, 'aria-label', title);
  }
  private fact(name: FactName, label: Localizable, value: Localizable, visible = true): void {
    const fact = this.facts.get(name)!;
    fact.element.hidden = !visible;
    setText(fact.element.firstElementChild!, label); setText(fact.value, value);
  }

  update(input: StatusInput): void {
    if (this.destroyed) return;
    this.input = input;
    const repository = input.repository, files = repository && !repository.bare ? input.working?.files : undefined;
    if (!files) this.countsMemo = undefined;
    else if (this.countsMemo?.repoId !== repository!.id || this.countsMemo.files !== files) {
      this.countsMemo = { repoId: repository!.id, files, counts: countWorkingFiles(files) };
    }
    const model = this.model = deriveStatus(input, this.countsMemo?.counts), repo = model.repository, counts = model.working.counts;
    this.element.dataset.state = model.state;
    this.element.dataset.workingState = model.working.kind;
    this.element.dataset.stale = String(model.working.stale);
    this.element.dataset.historyState = model.history.kind;
    this.element.dataset.historyStale = String(model.history.stale);
    this.element.dataset.taskState = model.taskState;
    this.element.dataset.trackingState = model.tracking.kind;
    this.element.dataset.hasConflicts = String(Boolean(counts?.conflicts));
    this.element.dataset.hasOperation = String(Boolean(model.working.operation));
    this.element.dataset.hasMore = String(model.history.hasMore);
    this.element.dataset.hasRepository = String(Boolean(repo));
    this.element.dataset.activity = model.activity.kind;
    const busy = model.activity.kind === 'task' || model.activity.kind === 'external';
    this.element.dataset.busy = String(busy);
    this.text(this.repository, repo?.name || m(model.state === 'initializing' ? 'initializing' : model.state === 'opening' ? 'opening' : 'noRepository'), repo ? m('repositoryDetails', { path: repo.path }) : m('details'));
    this.text(this.branch, previous(branchText(model), model.context.stale)); this.branch.element.hidden = !repo;
    this.text(this.location, model.context.wsl ? m('wsl', { distribution: model.context.wsl.distribution }) : '', model.context.wsl ? m('wslDescription', model.context.wsl) : m('otherLocation'));
    this.location.element.hidden = !model.context.wsl;
    this.text(this.trust, m(repo?.trusted ? 'trusted' : 'readOnly'), m(repo?.trusted ? 'trustedDescription' : 'trustDescription')); this.trust.element.hidden = !repo;
    this.text(this.sync, trackingText(model), trackingText(model, true)); this.sync.element.hidden = !repo;
    this.text(this.summary, summaryText(model), countsDescription(model)); this.summary.element.hidden = !repo;
    this.summary.element.dataset.stale = String(model.working.stale);
    const conflictCount = counts?.conflicts ?? 0;
    this.text(this.conflicts, m(model.working.stale ? 'previousConflicts' : 'conflicts', { count: number(conflictCount) }), countsDescription(model)); this.conflicts.element.hidden = !conflictCount;
    this.text(this.operation, operationText(model)); this.operation.element.hidden = !model.working.operation;
    this.text(this.counts, counts ? m('workingCounts', { staged: number(counts.staged), unstaged: number(counts.unstaged), untracked: number(counts.untracked) }) : '', countsDescription(model)); this.counts.element.hidden = !counts || counts.changed === 0;
    this.text(this.history, historyText(model), historyText(model, true)); this.history.element.hidden = !repo;
    const label = activityText(model), activity = model.activity;
    this.text(this.task, label, activity.kind === 'external' ? localized(locale => `${resolveText(label, locale)}. ${resolveText(m('externalDescription'), locale)}`)
      : activity.kind === 'compare' ? m('compareDescription', { base: activity.base }) : label);
    this.task.element.classList.toggle('statusbar-result', model.activity.kind === 'result');
    this.task.element.dataset.kind = model.activity.kind === 'task' ? model.activity.task.kind : model.activity.kind;
    this.task.element.dataset.tone = model.activity.kind === 'result' ? model.activity.result.kind : model.activity.kind === 'external' && model.activity.session.status === 'paused' ? 'warning' : 'neutral';
    const glyph = activityIcon(model.activity);
    if (glyph !== this.taskGlyphKind) { this.taskGlyphKind = glyph; this.taskGlyph.replaceChildren(icon(glyph)); }
    this.cancelScope = model.activity.kind === 'task' ? model.activity.cancelScope : null;
    this.element.dataset.cancelScope = this.cancelScope ?? 'none';
    this.cancel.hidden = this.cancelScope === 'history' ? !this.callbacks.cancelHistory : this.cancelScope === 'write' ? !this.callbacks.cancelWrite : true;
    if (this.cancel.hidden && document.activeElement === this.cancel) this.details.focus({ preventScroll: true });
    setAttribute(this.cancel, 'aria-label', m(this.cancelScope === 'write' ? 'cancelWrite' : 'cancelHistory'));
    setAttribute(this.cancel, 'title', m(this.cancelScope === 'write' ? 'cancelWriteDescription' : 'cancelHistory'));
    this.text(this.refresh, model.lastSuccessfulRefresh !== null ? m('refreshedAt', { time: time(model.lastSuccessfulRefresh) }) : m('neverRefreshed'), model.lastSuccessfulRefresh !== null ? m('refreshedAt', { time: time(model.lastSuccessfulRefresh, true) }) : m('neverRefreshed'));
    this.refresh.element.hidden = !repo || busy;
    this.text(this.language, m('languageShort'), m('languageControl', { language: m('languageName') }));
    this.language.element.hidden = !this.callbacks.changeLanguage;
    this.renderDetails(model);
    this.announce(model);
  }

  private cancelCurrent(): void {
    // Read the latest projection, not a callback captured from a previous operation.
    if (this.cancelScope === 'history') this.callbacks.cancelHistory?.();
    else if (this.cancelScope === 'write') this.callbacks.cancelWrite?.();
  }
  private announce(model: StatusModel): void {
    const activity = model.activity;
    let key = '', message: Localizable | null = null;
    if (activity.kind === 'task') {
      key = `${model.repository?.id ?? ''}:${activity.task.id}`;
      if (key !== this.taskKey) {
        // A success/failure with the same wording still needs its own future announcement.
        setText(this.announcer, ''); message = taskText(activity.task);
      }
    }
    this.taskKey = key;
    if (activity.kind === 'result') {
      const resultKey = `${activity.result.repoId ?? ''}:${activity.result.id}`;
      if (!this.resultKeys.has(resultKey)) {
        this.resultKeys.add(resultKey); message = resultText(activity.result);
        if (this.resultKeys.size > 100) this.resultKeys.delete(this.resultKeys.values().next().value!);
      }
    } else if (activity.kind === 'external') {
      const session = activity.session, sessionKey = `${session.repoId}:${session.id}`;
      if (this.sessionKeys.get(sessionKey) !== session.status) { this.sessionKeys.set(sessionKey, session.status); message = sessionText(session); }
      if (this.sessionKeys.size > 100) this.sessionKeys.delete(this.sessionKeys.keys().next().value!);
    }
    // A raw resolved message is intentional: changing locale must not re-announce an old completion.
    if (message !== null) setText(this.announcer, resolveText(message));
  }

  private buildDetails(): void {
    const id = `statusbar-details-${++nextDetailsId}`, title = el('h2', '', m('detailsTitle')); title.id = `${id}-title`;
    this.dialog.id = id; this.dialog.setAttribute('aria-labelledby', title.id);
    this.details.setAttribute('aria-controls', id); this.repository.element.setAttribute('aria-controls', id);
    const facts = el('dl', 'statusbar-facts');
    const names: FactName[] = ['repository', 'path', 'branch', 'trust', 'location', 'working', 'counts', 'operation', 'tracking', 'history', 'activity', 'refresh', 'result', 'compare', 'sessions', 'git', 'workingError', 'historyError', 'language'];
    for (const name of names) {
      const value = el('dd'), row = el('div', 'statusbar-fact', el('dt'), value);
      row.dataset.fact = name;
      if (['path', 'branch', 'git', 'workingError', 'historyError'].includes(name)) value.setAttribute('translate', 'no');
      if (name === 'path') value.className = 'mono';
      facts.append(row); this.facts.set(name, { element: row, value });
    }
    const controls = el('div', 'statusbar-detail-actions', this.copyPath, this.manageTrust, this.openWorking, this.changeLanguage);
    this.copyPath.dataset.action = 'status-copy-path'; this.manageTrust.dataset.action = 'status-manage-trust';
    this.openWorking.dataset.action = 'status-open-working'; this.changeLanguage.dataset.action = 'status-change-language';
    this.dialog.append(el('header', 'dialog-header', title, button(m('closeDetails'), () => this.closeDetails(), 'close', '', true)),
      el('div', 'dialog-body', el('p', 'dialog-description', m('detailsHint')), facts, controls),
      el('footer', 'dialog-footer', button(m('closeDetails'), () => this.closeDetails())));
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeDetails(); });
    this.dialog.addEventListener('close', () => { this.details.setAttribute('aria-expanded', 'false'); });
    this.dialog.addEventListener('keydown', event => { event.stopPropagation(); });
  }
  private renderDetails(model: StatusModel): void {
    const repo = model.repository;
    this.fact('repository', m('repository'), repo?.name ?? m('noRepository'));
    this.fact('path', m('repositoryPath'), repo?.path ?? '', Boolean(repo));
    this.fact('branch', m('branch'), previous(branchText(model), model.context.stale), Boolean(repo));
    this.fact('trust', m('manageTrust'), m(repo?.trusted ? 'trustedDescription' : 'trustDescription'), Boolean(repo));
    this.fact('location', m('location'), model.context.wsl ? m('wslDescription', model.context.wsl) : m('otherLocation'), Boolean(repo));
    this.fact('working', m('working'), model.working.kind === 'bare' ? m('bareDescription') : model.working.stale ? m('staleDescription') : summaryText(model), Boolean(repo));
    this.fact('counts', m('counts'), countsDescription(model), Boolean(model.working.counts));
    this.fact('operation', m('operation'), operationText(model), Boolean(repo));
    this.fact('tracking', m('tracking'), trackingText(model, true), Boolean(repo));
    this.fact('history', m('history'), historyText(model, true), Boolean(repo));
    this.fact('activity', m('activity'), model.activity.kind === 'external'
      ? localized(locale => `${resolveText(activityText(model), locale)}\n${resolveText(m('externalDescription'), locale)}`) : activityText(model));
    this.fact('refresh', m('lastRefresh'), model.lastSuccessfulRefresh === null ? m('neverRefreshed') : time(model.lastSuccessfulRefresh, true), Boolean(repo));
    const result = model.result;
    this.fact('result', m('result'), result ? typeof result.at === 'number' && Number.isFinite(result.at) && Math.abs(result.at) <= 8_640_000_000_000_000
      ? m('resultAt', { message: resultText(result), time: time(result.at, true) }) : resultText(result) : '', Boolean(result));
    this.fact('compare', m('compareBase'), model.compareBase ?? '', Boolean(model.compareBase));
    this.fact('sessions', m('externalSessions'), localized(locale => model.sessions.map(session => [resolveText(sessionText(session), locale), session.exitCode === null ? '' : resolveText(m('sessionExit', { code: number(session.exitCode) }), locale), session.message].filter(Boolean).join('\n')).join('\n\n')), model.sessions.length > 0);
    this.fact('git', m('gitVersion'), this.input?.gitVersion ?? m('unknown'), Boolean(this.input?.gitVersion));
    this.fact('workingError', m('statusError'), model.working.error ?? '', Boolean(model.working.error));
    this.fact('historyError', m('historyErrorDetails'), model.history.error ?? '', Boolean(model.history.error));
    this.fact('language', m('language'), getLanguage() === 'system' ? m('languageSystem', { language: m('languageName') }) : m('languageName'));
    this.copyPath.hidden = !repo || !this.callbacks.copyPath;
    this.manageTrust.hidden = !repo || !this.callbacks.trust;
    this.openWorking.hidden = !repo || !model.working.counts || !this.callbacks.openWorking;
    this.changeLanguage.hidden = !this.callbacks.changeLanguage;
    setAttribute(this.manageTrust, 'title', m(repo?.trusted ? 'manageTrust' : 'trustRepository'));
  }

  showDetails(): void {
    if (this.destroyed || !this.model || this.dialog.open) return;
    this.previousFocus = document.activeElement as HTMLElement | null;
    if (!this.dialog.isConnected) document.body.append(this.dialog);
    this.details.setAttribute('aria-expanded', 'true');
    this.dialog.showModal();
  }
  private closeDetails(restoreFocus = true): void {
    if (this.dialog.open) this.dialog.close();
    this.details.setAttribute('aria-expanded', 'false');
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = null;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.countsMemo = undefined; this.unlistenLocale(); this.closeDetails(false);
    disposeBindings(this.element); disposeBindings(this.dialog); this.dialog.remove();
  }
}
