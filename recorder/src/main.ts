import './style.css';
import { App } from './ui';

const root = document.getElementById('app')!;
App.create(root).catch((e) => {
  root.textContent = 'The recorder failed to start: ' + String(e);
  console.error(e);
});
