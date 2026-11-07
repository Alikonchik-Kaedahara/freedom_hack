// App shell: sidebar, dataset switcher, hash router.
import { h, icon, clear, toast } from './ui.js';
import { state, boot, subscribe, pendingAppeals } from './store.js';
import { resumeJobs } from './jobs.js';
import { renderImportStage, openDatasetModal } from './views/import.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDialogs } from './views/dialogs.js';
import { renderDialog } from './views/dialog.js';
import { renderAppeals } from './views/appeals.js';
import { renderChecklists } from './views/checklists.js';
import { renderModel } from './views/model.js';

const NAV = [
  { path: '/', label: 'Обзор', icon: 'grid' },
  { path: '/dialogs', label: 'Диалоги', icon: 'list' },
  { path: '/appeals', label: 'Апелляции', icon: 'scale', badge: () => pendingAppeals().length },
  { path: '/checklists', label: 'Чек-листы', icon: 'checks' },
  { path: '/model', label: 'Модель', icon: 'cpu' },
];

const ROUTES = [
  [/^\/$/, renderDashboard],
  [/^\/dialogs$/, renderDialogs],
  [/^\/dialog\/(.+)$/, renderDialog],
  [/^\/appeals$/, renderAppeals],
  [/^\/checklists(?:\/(.+))?$/, renderChecklists],
  [/^\/model$/, renderModel],
];

const view = document.getElementById('view');
const main = document.getElementById('main');
let cleanup = null;
let currentPath = null;

function currentRoute() {
  return decodeURI(location.hash.replace(/^#/, '') || '/');
}

function renderNav() {
  const path = currentRoute();
  const nav = clear(document.getElementById('nav'));
  for (const item of NAV) {
    const active = item.path === '/' ? path === '/' : path.startsWith(item.path) || (item.path === '/dialogs' && path.startsWith('/dialog/'));
    const badge = item.badge ? item.badge() : 0;
    nav.append(h('a', { href: `#${item.path}`, class: active ? 'active' : '' },
      icon(item.icon, 20), item.label, badge ? h('span', { class: 'badge' }, badge) : null));
  }
  const pill = clear(document.getElementById('datasetPill'));
  const ds = state.datasets.find((d) => d.groupId === state.group);
  pill.append(
    h('span', { class: 'ds-icon' }, icon('database', 18)),
    h('span', { class: 'ds-text' }, h('small', null, 'Набор диалогов'), h('b', null, ds ? `${ds.groupId} · ${ds.total}` : 'Не загружен')),
    icon('chevron', 16));
}

function route() {
  const path = currentRoute();
  if (cleanup) { try { cleanup(); } catch { /* noop */ } cleanup = null; }
  const samePage = path === currentPath;
  currentPath = path;
  renderNav();
  clear(view);
  document.querySelector('.hero').style.display = '';
  if (!state.group) {
    document.querySelector('.hero').style.display = 'none';
    cleanup = renderImportStage(view);
    return;
  }
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      cleanup = fn(view, ...m.slice(1).map((x) => (x ? decodeURIComponent(x) : x))) || null;
      if (!samePage) main.scrollTop = 0;
      return;
    }
  }
  location.hash = '#/';
}

document.getElementById('datasetPill').addEventListener('click', () => openDatasetModal());
window.addEventListener('hashchange', route);
subscribe((what) => {
  if (what === 'group') route();
  else renderNav();
});

(async function start() {
  try {
    await boot();
  } catch (e) {
    toast('Сервер недоступен. Запустите python server.py', { type: 'error', timeout: 10000 });
  }
  route();
  resumeJobs();
})();
