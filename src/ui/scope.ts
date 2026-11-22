import type { AppSettings, GitRef, HistoryScope } from '../shared/protocol';
import { scopeLabel } from '../lib/format';
import { button, checkbox, el, field, formDialog, input, select } from './dom';

export function splitGlobs(value: string): string[] { return [...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))]; }
export async function showHistoryScope(current: HistoryScope, refs: readonly GitRef[], settings: AppSettings): Promise<HistoryScope | null> {
  const selected = new Set(current.refs ?? []);
  const body = el('div', 'scope-picker');
  const group = settings.branchGroups.find(item => current.kind === 'glob' && JSON.stringify(item.include) === JSON.stringify(current.include) && JSON.stringify(item.exclude) === JSON.stringify(current.exclude));
  let kind = group ? `group:${group.name}` : current.kind;
  const options = [{ value: 'all', label: 'All branches' }, { value: 'head', label: 'Current branch · HEAD' }, { value: 'refs', label: 'Selected branches / refs' }, { value: 'glob', label: 'Include / exclude globs' }, ...settings.branchGroups.map(item => ({ value: `group:${item.name}`, label: `Group: ${item.name}` }))];
  const mode = select(options, kind, 'History scope', value => { kind = value; update(); }); mode.name = 'scope';
  const referencePanel = el('div', 'scope-refs-panel');
  const search = input('Filter available refs'); search.type = 'search'; search.placeholder = 'Filter branch, remote or tag names';
  const list = el('div', 'scope-ref-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Refs included in history');
  const available = refs.filter(ref => ref.kind === 'branch' || ref.kind === 'remote' && settings.showRemotes || ref.kind === 'tag' && settings.showTags || ref.kind === 'stash' && settings.showStashes);
  const displayRefs = [...available, ...[...selected].filter(name => !available.some(ref => ref.fullName === name)).map(name => ({ name, fullName: name, kind: 'branch' as const, current: false }))];
  const renderRefs = (): void => {
    const query = search.value.trim().toLocaleLowerCase(); list.replaceChildren();
    for (const ref of displayRefs.filter(ref => `${ref.name} ${ref.fullName}`.toLocaleLowerCase().includes(query))) {
      const choice = checkbox(`${ref.name}${ref.current ? ' · current' : ''}`, selected.has(ref.fullName), checked => { if (checked) selected.add(ref.fullName); else selected.delete(ref.fullName); });
      choice.title = ref.fullName; choice.querySelector('input')!.name = 'ref'; choice.querySelector('input')!.value = ref.fullName; choice.append(el('small', 'muted', ref.kind)); list.append(choice);
    }
    if (!list.childElementCount) list.append(el('p', 'muted', 'No matching references.'));
  };
  search.addEventListener('input', renderRefs);
  referencePanel.append(search, el('div', 'inline-actions', button('Select visible', () => { for (const ref of displayRefs) if (`${ref.name} ${ref.fullName}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())) selected.add(ref.fullName); renderRefs(); }), button('Clear selection', () => { selected.clear(); renderRefs(); })), list);
  const globPanel = el('div', 'scope-glob-panel');
  const include = el('textarea'); include.rows = 3; include.name = 'include'; include.value = current.include?.join('\n') ?? 'refs/heads/*'; include.setAttribute('aria-label', 'Included ref globs');
  const exclude = el('textarea'); exclude.rows = 2; exclude.name = 'exclude'; exclude.value = current.exclude?.join('\n') ?? ''; exclude.setAttribute('aria-label', 'Excluded ref globs');
  globPanel.append(field('Include globs', include, 'One Git ref glob per line, for example refs/heads/feature/* or refs/tags/v*.'), field('Exclude globs', exclude, 'Excluded refs are removed from the selected roots; shared ancestors remain visible.'));
  const explanation = el('p', 'muted scope-description');
  function update(): void {
    referencePanel.hidden = kind !== 'refs'; globPanel.hidden = kind !== 'glob';
    const named = settings.branchGroups.find(item => `group:${item.name}` === kind);
    explanation.textContent = named ? `Include: ${named.include.join(', ') || '(none)'}${named.exclude.length ? ` · Exclude: ${named.exclude.join(', ')}` : ''}` : kind === 'head' ? 'History reachable from the current HEAD, including detached HEAD.' : kind === 'all' ? 'History from all enabled references. Visibility options are configured in settings.' : 'The range is applied by Git, not just filtered from loaded rows.';
  }
  body.append(field('Scope', mode), explanation, referencePanel, globPanel); renderRefs(); update();
  const result = await formDialog({ title: 'History range', description: `Current: ${scopeLabel(current)}. Named groups can be edited in settings.`, body, confirm: 'Apply range', dataAction: 'apply-history-scope', validate: () => kind === 'refs' && !selected.size ? 'Select at least one reference.' : kind === 'glob' && !splitGlobs(include.value).length ? 'Enter at least one included ref glob.' : null });
  if (!result) return null;
  const named = settings.branchGroups.find(item => `group:${item.name}` === kind);
  if (named) return { kind: 'glob', include: [...named.include], exclude: [...named.exclude] };
  if (kind === 'refs') return { kind: 'refs', refs: [...selected] };
  if (kind === 'glob') return { kind: 'glob', include: splitGlobs(include.value), exclude: splitGlobs(exclude.value) };
  return { kind: kind === 'head' ? 'head' : 'all' };
}
