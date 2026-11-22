import { createHost } from './host';
import { App } from './ui/app';
import './ui/styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Application root is missing.');

void createHost().then(async host => {
  const app = new App(host, root);
  await app.init();
  if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
}).catch(error => {
  const message = document.createElement('p');
  message.className = 'startup-error';
  message.setAttribute('role', 'alert');
  message.textContent = `The application could not start. ${error instanceof Error ? error.message : String(error)}`;
  root.replaceChildren(message);
});
