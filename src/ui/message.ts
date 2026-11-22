import type { AppSettings } from '../shared/protocol';
import { tokenizeMessage, type MessageToken } from '../lib/message';

/** Render locally without innerHTML, remote images, automatic navigation, or a Markdown HTML interpreter. */
export function renderMessage(text: string, settings: AppSettings, openUrl: (url: string) => void, inline = false): HTMLElement {
  const root = document.createElement(inline ? 'span' : 'div');
  root.className = `linked-message message-content${inline ? ' message-inline' : ''}`;
  if (!inline) root.style.whiteSpace = 'pre-wrap';
  function append(parent: HTMLElement, tokens: MessageToken[]): void {
    for (const token of tokens) {
      if (token.kind === 'text') { parent.append(document.createTextNode(token.text)); continue; }
      if (token.kind === 'code') { const code = document.createElement('code'); code.textContent = token.text; parent.append(code); continue; }
      if (token.kind === 'link') {
        const link = document.createElement('a'); link.href = token.url; link.title = token.url; link.rel = 'noopener noreferrer'; link.dataset.messageLink = '';
        append(link, token.children);
        link.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openUrl(token.url); });
        link.addEventListener('auxclick', event => { event.preventDefault(); event.stopPropagation(); });
        link.addEventListener('contextmenu', event => { event.stopPropagation(); });
        parent.append(link); continue;
      }
      const style = document.createElement(token.kind === 'italic' ? 'em' : 'strong');
      if (token.kind === 'bolditalic') { const italic = document.createElement('em'); append(italic, token.children); style.append(italic); }
      else append(style, token.children);
      parent.append(style);
    }
  }
  append(root, tokenizeMessage(text, settings, inline));
  return root;
}
