import { createApp } from 'vue';
import { createHost } from './host';
import Workbench from './App.vue';
import { initI18n } from './lib/i18n';
import { errorText } from './lib/format';
import { resolveText } from './lib/i18n';
import './styles/workbench.css';

initI18n();
const root = document.getElementById('app');
if (!root) throw new Error('Application root is missing.');

void createHost().then(host => {
  const app = createApp(Workbench, { host });
  app.mount(root);
  if (import.meta.hot) import.meta.hot.dispose(() => app.unmount());
}).catch(error => {
  const message = document.createElement('p');
  message.className = 'startup-error'; message.setAttribute('role', 'alert');
  message.textContent = resolveText(errorText(error));
  root.replaceChildren(message);
});
