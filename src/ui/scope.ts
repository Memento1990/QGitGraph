import type { AppSettings, GitRef, HistoryScope } from '../shared/protocol';
import { scopeText } from '../lib/format';
import { m } from '../i18n/scope';
import { button, checkbox, el, field, formDialog, input, select, setAttribute, setText } from './dom';

export function splitGlobs(value: string): string[] { return [...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))]; }
export async function showHistoryScope(current: HistoryScope, refs: readonly GitRef[], settings: AppSettings): Promise<HistoryScope | null> {
  const selected = new Set(current.refs ?? []);
  const body = el('div', 'scope-picker');
  const group = settings.branchGroups.find(item => current.kind === 'glob' && JSON.stringify(item.include) === JSON.stringify(current.include) && JSON.stringify(item.exclude) === JSON.stringify(current.exclude));
  let kind = group ? `group:${group.name}` : current.kind;
  const options = [{ value: 'all', label: m('all') }, { value: 'head', label: m('head') }, { value: 'refs', label: m('refs') }, { value: 'glob', label: m('glob') }, ...settings.branchGroups.map(item => ({ value: `group:${item.name}`, label: m('group', { name: item.name }) }))];
  const mode = select(options, kind, m('historyScope'), value => { kind = value; update(); }); mode.name = 'scope';
  const referencePanel = el('div', 'scope-refs-panel');
  const search = input(m('filter')); search.type = 'search'; setAttribute(search, 'placeholder', m('filterPlaceholder'));
  const list = el('div', 'scope-ref-list'); list.setAttribute('role', 'group'); setAttribute(list, 'aria-label', m('includedRefs'));
  const available = refs.filter(ref => ref.kind === 'branch' || ref.kind === 'remote' && settings.showRemotes || ref.kind === 'tag' && settings.showTags || ref.kind === 'stash' && settings.showStashes);
  const displayRefs = [...available, ...[...selected].filter(name => !available.some(ref => ref.fullName === name)).map(name => ({ name, fullName: name, kind: 'branch' as const, current: false }))];
  const renderRefs = (): void => {
    const query = search.value.trim().toLocaleLowerCase(); list.replaceChildren();
    for (const ref of displayRefs.filter(ref => `${ref.name} ${ref.fullName}`.toLocaleLowerCase().includes(query))) {
      const choice = checkbox(ref.current ? m('current', { name: ref.name }) : ref.name, selected.has(ref.fullName), checked => { if (checked) selected.add(ref.fullName); else selected.delete(ref.fullName); });
      choice.title = ref.fullName; choice.querySelector('input')!.name = 'ref'; choice.querySelector('input')!.value = ref.fullName; choice.append(el('small', 'muted', m(ref.kind))); list.append(choice);
    }
    if (!list.childElementCount) list.append(el('p', 'muted', m('noMatches')));
  };
  search.addEventListener('input', renderRefs);
  referencePanel.append(search, el('div', 'inline-actions', button(m('selectVisible'), () => { for (const ref of displayRefs) if (`${ref.name} ${ref.fullName}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())) selected.add(ref.fullName); renderRefs(); }), button(m('clear'), () => { selected.clear(); renderRefs(); })), list);
  const globPanel = el('div', 'scope-glob-panel');
  const include = el('textarea'); include.rows = 3; include.name = 'include'; include.value = current.include?.join('\n') ?? 'refs/heads/*'; setAttribute(include, 'aria-label', m('includedGlobs'));
  const exclude = el('textarea'); exclude.rows = 2; exclude.name = 'exclude'; exclude.value = current.exclude?.join('\n') ?? ''; setAttribute(exclude, 'aria-label', m('excludedGlobs'));
  globPanel.append(field(m('include'), include, m('includeHint')), field(m('exclude'), exclude, m('excludeHint')));
  const explanation = el('p', 'muted scope-description');
  function update(): void {
    referencePanel.hidden = kind !== 'refs'; globPanel.hidden = kind !== 'glob';
    const named = settings.branchGroups.find(item => `group:${item.name}` === kind);
    setText(explanation, named ? named.exclude.length ? m('namedBoth', { include: named.include.join(', ') || m('none'), exclude: named.exclude.join(', ') }) : m('namedInclude', { include: named.include.join(', ') || m('none') }) : m(kind === 'head' ? 'headHint' : kind === 'all' ? 'allHint' : 'rangeHint'));
  }
  body.append(field(m('scope'), mode), explanation, referencePanel, globPanel); renderRefs(); update();
  const result = await formDialog({ title: m('title'), description: m('description', { scope: scopeText(current) }), body, confirm: m('apply'), dataAction: 'apply-history-scope', validate: () => kind === 'refs' && !selected.size ? m('selectOne') : kind === 'glob' && !splitGlobs(include.value).length ? m('includeOne') : null });
  if (!result) return null;
  const named = settings.branchGroups.find(item => `group:${item.name}` === kind);
  if (named) return { kind: 'glob', include: [...named.include], exclude: [...named.exclude] };
  if (kind === 'refs') return { kind: 'refs', refs: [...selected] };
  if (kind === 'glob') return { kind: 'glob', include: splitGlobs(include.value), exclude: splitGlobs(exclude.value) };
  return { kind: kind === 'head' ? 'head' : 'all' };
}
