<script lang="ts">
import { computed, createTextVNode, defineComponent, h, type PropType, type VNode } from 'vue';
import { tokenizeMessage, type MessageSettings, type MessageToken } from '../lib/message';

/** The formal bounded parser supplies text/tokens, never HTML or remote assets. */
export default defineComponent({
  name: 'MessageText',
  props: {
    text: { type: String, required: true },
    settings: { type: Object as PropType<MessageSettings>, required: true },
    inline: { type: Boolean, default: false },
  },
  emits: { openUrl: (url: string) => typeof url === 'string' },
  setup(props, { emit }) {
    const tokens = computed(() => tokenizeMessage(props.text, props.settings, props.inline));
    function renderTokens(values: readonly MessageToken[]): VNode[] {
      return values.map(token => {
        if (token.kind === 'text') return createTextVNode(token.text);
        if (token.kind === 'code') return h('code', token.text);
        if (token.kind === 'link') return h('a', {
          href: token.url, title: token.url, rel: 'noopener noreferrer', 'data-message-link': '',
          onClick: (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); emit('openUrl', token.url); },
          onAuxclick: (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); },
          onContextmenu: (event: MouseEvent) => { event.stopPropagation(); },
        }, renderTokens(token.children));
        if (token.kind === 'bolditalic') return h('strong', [h('em', renderTokens(token.children))]);
        return h(token.kind === 'italic' ? 'em' : 'strong', renderTokens(token.children));
      });
    }
    return () => h(props.inline ? 'span' : 'div', {
      class: ['linked-message', 'message-content', { 'message-inline': props.inline }],
    }, renderTokens(tokens.value));
  },
});
</script>

<style scoped>
.message-content { white-space:pre-wrap; overflow-wrap:anywhere; }
.message-inline { white-space:inherit; }
.message-content a { color:var(--brand,#b1d5be); text-decoration:underline; text-decoration-color:color-mix(in srgb,var(--brand,#b1d5be) 55%,transparent); text-underline-offset:2px; cursor:pointer; }
.message-content a:hover { text-decoration-color:currentColor; }
.message-content a:focus-visible { outline:2px solid var(--brand,#b1d5be); outline-offset:1px; border-radius:2px; }
.message-content code { padding:0 3px; border:1px solid var(--line,#2b2e32); border-radius:3px; background:var(--panel-muted,#121416); font: .95em/1.5 Consolas,"Cascadia Code",monospace; }
</style>
