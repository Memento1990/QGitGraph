import type { GitAction, GitRef, Repository } from '../shared/protocol';
import { m } from '../i18n/workspace';
import { button, disposeBindings, el, empty, input, setAttribute } from './dom';

export async function chooseRepositoryBranch(options: {
  repository: Repository; refs: readonly GitRef[]; current: () => boolean;
  checkout: (kind: 'checkout' | 'checkout-remote', preset: Partial<GitAction>) => Promise<void>;
  remoteBranch: (name: string) => { remote: string; branch: string } | null;
  anchor?: HTMLElement;
}): Promise<void> {
  const dialog = el('dialog', 'dialog branch-picker-dialog');
  const title = el('h2', '', m('branches')); title.id = 'repository-branch-picker-title'; dialog.setAttribute('aria-labelledby', title.id);
  const search = input(m('searchBranches')); search.type = 'search'; search.autocomplete = 'off'; search.spellcheck = false;
  setAttribute(search, 'placeholder', m('searchBranches'));
  const list = el('div', 'branch-picker-list'); list.setAttribute('role', 'list');
  const previous = options.anchor ?? document.activeElement as HTMLElement | null;
  await new Promise<void>(resolve => {
    let closed = false;
    const close = (): void => {
      if (closed) return; closed = true; disposeBindings(dialog); dialog.close(); dialog.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true }); resolve();
    };
    const render = (): void => {
      disposeBindings(list); list.replaceChildren();
      const query = search.value.toLocaleLowerCase(); let count = 0;
      for (const kind of ['branch', 'remote'] as const) {
        const refs = options.refs.filter(ref => ref.kind === kind && !(kind === 'remote' && ref.fullName.endsWith('/HEAD')) && ref.name.toLocaleLowerCase().includes(query));
        if (!refs.length) continue;
        list.append(el('div', 'branch-picker-group', m(kind === 'branch' ? 'localBranches' : 'remoteBranches')));
        for (const ref of refs) {
          const control = button(ref.name, () => {
            if (!options.current()) { close(); return; }
            if (ref.kind === 'branch' && ref.current) { close(); return; }
            const remote = ref.kind === 'remote' ? options.remoteBranch(ref.name) : null;
            if (ref.kind === 'remote' && !remote) return;
            close();
            void options.checkout(remote ? 'checkout-remote' : 'checkout', remote
              ? { remote: remote.remote, target: remote.branch, name: remote.branch }
              : { target: ref.name });
          }, 'branch', 'branch-picker-row');
          control.setAttribute('role', 'listitem'); control.dataset.branch = ref.fullName;
          if (ref.current) { control.classList.add('is-current'); control.append(el('span', 'muted', m('currentBranch'))); }
          list.append(control); count++;
        }
      }
      if (!count) list.append(empty(m('noBranches')));
    };
    search.addEventListener('input', render);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.append(el('header', 'dialog-header', title, button(m('close'), close, 'close', '', true)),
      el('div', 'dialog-body', el('div', 'branch-picker-repository', options.repository.name), search,
        el('p', 'muted', m('trackingHint')), list), el('footer', 'dialog-footer', button(m('close'), close)));
    document.body.append(dialog); render(); dialog.showModal(); search.focus();
  });
}
