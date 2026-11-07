// FreedomCQA widget: shell (embedded command ribbon, optional Dynamics 365 host preview), router
// and the public mount() entry point. Everything renders inside #cqa-d365-root.
import { h, icon, clear, toast, setLayers } from './ui.js';
import { api, setApiBase } from './api.js';
import { state, boot, subscribe, pendingAppeals, loadGroup, refreshResults } from './store.js';
import * as Scoring from './scoring.js';
import { resumeJobs } from './jobs.js';
import { D365Bridge } from './bridge.js';
import { renderImportStage, openDatasetPopover } from './views/import.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDialogs } from './views/dialogs.js';
import { renderDialog } from './views/dialog.js';
import { renderAppeals } from './views/appeals.js';
import { renderOperators } from './views/operators.js';
import { renderSettings } from './views/settings.js';
import { getUser, onUserChange, askUser, setUser, initials } from './user.js';

// Daily work is in the four main sections; settings have a separate control.
const NAV = [
  { path: '/', label: 'Главная', short: 'Главная', icon: 'home' },
  { path: '/dialogs', label: 'Диалоги', short: 'Диалоги', icon: 'list' },
  { path: '/operators', label: 'Операторы', short: 'Операторы', icon: 'headset' },
  { path: '/appeals', label: 'Апелляции', short: 'Апелляции', icon: 'scale', badge: () => pendingAppeals().length },
];

const ROUTES = [
  [/^\/$/, renderDashboard],
  [/^\/dialogs$/, renderDialogs],
  [/^\/dialog\/(.+)$/, renderDialog],
  [/^\/appeals$/, renderAppeals],
  [/^\/operators(?:\/(.+))?$/, renderOperators],
  [/^\/settings(?:\/([^/]+))?(?:\/(.+))?$/, renderSettings],
];
// Old links (from cards, bookmarks) keep working.
const REDIRECTS = [
  [/^\/quality$/, () => '/settings/verification'],
  [/^\/checklists(\/.*)?$/, (m) => `/settings/checklists${m[1] || ''}`],
  [/^\/knowledge$/, () => '/settings/knowledge'],
  [/^\/model$/, () => '/settings/model'],
];

const HOST_KEY = 'cqa.hostPreview';
const THEME_KEY = 'cqa.theme';
const ui = {};
let cleanup = null;
let currentPath = null;
let mounted = false;

const currentRoute = () => decodeURI(location.hash.replace(/^#/, '').split('?')[0] || '/');
const isActive = (item, path) => (item.path === '/' ? path === '/' : path.startsWith(item.path) || (item.path === '/dialogs' && path.startsWith('/dialog/')));

/** The main action of a screen lives in the page head now; kept as a no-op for older view code. */
export function setRibbonAction() {}

function buildShell(root) {
  ui.root = root;
  ui.tabs = h('nav', { class: 'rb-tabs', 'aria-label': 'Разделы CQA' });
  ui.pill = h('button', { class: 'ds-pill', type: 'button', 'aria-haspopup': 'dialog' });
  ui.host = h('button', { class: 'host-toggle', type: 'button', title: 'Показать, как компонент выглядит внутри Dynamics 365' },
    icon('waffle', 15), h('span', { class: 'lbl' }, 'D365 Host'));
  ui.theme = h('button', { class: 'theme-toggle', type: 'button', title: 'Светлая / тёмная тема', 'aria-label': 'Светлая / тёмная тема' }, icon('contrast', 15));
  ui.settings = h('a', { class: 'settings-gear', href: '#/settings', title: 'Настройки', 'aria-label': 'Настройки' }, icon('gear', 18));
  ui.user = h('button', { class: 'user-card', type: 'button', 'aria-haspopup': 'menu' });
  ui.bridge = h('span', { class: 'bridge-badge', hidden: true });
  ui.right = h('div', { class: 'rb-right' }, ui.pill, ui.theme, ui.settings, ui.user);
  ui.rail = h('nav', { class: 'cqa-d365-rail', 'aria-label': 'Разделы CQA' });
  ui.view = h('div', { class: 'cqa-view' });
  ui.tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Разделы CQA' });

  const ribbon = h('header', { class: 'ribbon' },
    h('a', { class: 'rb-brand', href: '#/', 'aria-label': 'Freedom Broker · Главная' },
      h('img', { src: assetUrl('assets/logo.svg'), alt: '' }),
      h('span', { class: 'rb-name' }, 'Freedom Broker'),
      h('span', { class: 'rb-title' }, 'Контроль качества')),
    ui.tabs, ui.right);

  const d365Top = h('div', { class: 'cqa-d365-top' },
    h('span', { class: 'waffle' }, Array.from({ length: 9 }, () => h('i'))),
    h('span', { class: 'prod' }, 'Dynamics 365'), h('span', { class: 'sep' }),
    h('span', { class: 'app' }, 'Freedom Broker — Омниканальный контроль качества'),
    h('span', { class: 'avatar', style: { marginLeft: 'auto' } }, 'FB'));

  const layer = h('div', { class: 'cqa-layer' });
  const modal = h('div'); const toasts = h('div', { class: 'cqa-toasts' }); const dock = h('div', { class: 'cqa-dock' });
  layer.append(modal, toasts, dock);
  setLayers({ modal, toasts, dock });

  root.replaceChildren(h('div', { class: 'cqa-frame' }, d365Top, ui.rail, h('div', { class: 'cqa-app' }, ribbon, ui.view)), ui.tabbar, layer);

  ui.pill.addEventListener('click', (e) => { e.stopPropagation(); openDatasetPopover(ui.right); });
  ui.host.addEventListener('click', () => setHostPreview(!root.classList.contains('cqa-host-on')));
  ui.theme.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  ui.user.addEventListener('click', (e) => { e.stopPropagation(); openUserMenu(); });
  onUserChange(renderUser);
  renderUser();
  setTheme(readPref(THEME_KEY) === 'dark' ? 'dark' : 'light', false);
  // The Dynamics 365 workspace frame is off by default; Settings → Интеграция turns it on for a demo.
  // Inside the real CRM the bridge talks to Xrm and no imitation frame is drawn.
  if (D365Bridge.ready) { ui.host.hidden = true; updateBridge(); }
  else setHostPreview(readPref(HOST_KEY) === '1', false);
}

function renderUser() {
  const u = getUser();
  ui.user.replaceChildren(
    h('span', { class: 'uc-avatar' }, u ? initials(u.name) : icon('user', 14)),
    h('span', { class: 'uc-text' }, h('b', null, u ? u.name : 'Представиться'), u ? h('small', null, u.role) : null));
  ui.user.title = u ? `${u.name} · ${u.role}` : 'Укажите имя: оно попадёт в апелляции';
}

function openUserMenu() {
  const existing = ui.root.querySelector('.user-menu');
  if (existing) { existing.remove(); return; }
  const u = getUser();
  if (!u) { askUser(); return; }
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  const menu = h('div', { class: 'user-menu', role: 'menu' },
    h('div', { class: 'um-head' }, h('b', null, u.name), h('small', null, u.role)),
    h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); askUser({ title: 'Сменить пользователя' }); } }, 'Сменить пользователя'),
    h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); setUser(null); } }, 'Выйти'));
  menu.addEventListener('click', (e) => e.stopPropagation());
  ui.right.append(menu);
  setTimeout(() => document.addEventListener('click', close), 0);
}

function setTheme(theme, persist = true) {
  ui.root.dataset.theme = theme;
  ui.theme.setAttribute('aria-pressed', String(theme === 'dark'));
  if (persist) writePref(THEME_KEY, theme);
}

/** Settings page: the Dynamics 365 frame on/off and the integration status line. */
export const hostFrame = {
  get on() { return ui.root?.classList.contains('cqa-host-on') ?? false; },
  set(on) { setHostPreview(on); },
  get embedded() { return D365Bridge.ready && !D365Bridge.simulated; },
  get status() {
    if (D365Bridge.ready && !D365Bridge.simulated) return 'Приложение запущено внутри Dynamics 365.';
    return 'Приложение запущено отдельно от Dynamics 365. Рамка рабочего пространства показывает, как оно выглядит встроенным в CRM.';
  },
};

function setHostPreview(on, persist = true) {
  ui.root.classList.toggle('cqa-host-on', on);
  ui.host.classList.toggle('on', on);
  ui.host.setAttribute('aria-pressed', String(on));
  if (persist) writePref(HOST_KEY, on ? '1' : '0');
  if (on) D365Bridge.connectEmulatedHost(); else D365Bridge.disconnectEmulatedHost();
  updateBridge();
}

function updateBridge() {
  ui.bridge.hidden = !D365Bridge.ready;
  ui.bridge.title = D365Bridge.simulated
    ? 'Предпросмотр: страница эмулирует хост Dynamics 365 (Xrm), мост подключён к нему. Внутри CRM подключается к настоящему Xrm.'
    : 'Подключено к Xrm Dynamics 365';
  ui.bridge.replaceChildren(h('i'), 'Xrm Bridge: Активен (Dynamics 365 Host)');
}

function renderChrome() {
  const path = currentRoute();
  const link = (item, cls, ...kids) => h('a', { href: `#${item.path}`, class: `${cls || ''} ${isActive(item, path) ? 'active' : ''}`, title: item.label }, ...kids);
  ui.tabs.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return link(item, '', item.label, badge ? h('span', { class: 'badge' }, badge) : null);
  }));
  ui.rail.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return link(item, '', icon(item.icon, 20), h('span', null, item.short), badge ? h('span', { class: 'badge' }, badge) : null);
  }));
  if (path.startsWith('/settings')) ui.settings.setAttribute('aria-current', 'page');
  else ui.settings.removeAttribute('aria-current');
  ui.tabbar.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return link(item, '', h('span', { class: 'tab-icon' }, icon(item.icon, 21), badge ? h('span', { class: 'dot' }, badge) : null),
      h('span', { class: 'tab-label' }, item.short));
  }));
  const ds = state.datasets.find((d) => d.groupId === state.group);
  ui.pill.replaceChildren(icon('database', 14), h('span', { class: 'k' }, 'Набор:'), h('span', null, ds ? `${ds.groupId} · ${ds.total}` : '—'), icon('chevron', 13));
  ui.root.classList.toggle('no-data', !state.group);
}

/** Browser tab and history show where the person is: «Диалог p1-ru-005 · Контроль качества». */
function setTitle(path) {
  const dialog = path.match(/^\/dialog\/(.+)$/);
  const settingsTitle = path === '/settings/verification' ? 'Проверка модели' : 'Настройки';
  const section = path.startsWith('/settings') ? settingsTitle : dialog ? `Диалог ${decodeURIComponent(dialog[1])}` : (NAV.find((item) => isActive(item, path))?.label || 'Контроль качества');
  document.title = section === 'Главная' ? 'Контроль качества диалогов · Freedom Broker' : `${section} · Контроль качества`;
}

function route() {
  const path = currentRoute();
  for (const [re, to] of REDIRECTS) {
    const m = path.match(re);
    if (m) { location.replace(`#${to(m)}`); return; }
  }
  if (cleanup) { try { cleanup(); } catch { /* noop */ } cleanup = null; }
  const samePage = path === currentPath;
  currentPath = path;
  renderChrome();
  setTitle(path);
  ui.root.querySelector('.user-menu')?.remove();
  clear(ui.view);
  D365Bridge.post('route', { path });
  if (!state.group && !path.startsWith('/settings')) { cleanup = renderImportStage(ui.view) || null; return; }
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      cleanup = fn(ui.view, ...m.slice(1).map((x) => (x ? decodeURIComponent(x) : x))) || null;
      if (!samePage) { scrollTop(); }
      return;
    }
  }
  location.hash = '#/';
}

function scrollTop() {
  window.scrollTo(0, 0);
  const app = ui.root.querySelector('.cqa-app');
  if (app) app.scrollTop = 0;
}

/**
 * Mount the widget into any container.
 * context: { apiBase?, groupId?, conversationId? } — values from Dynamics 365 (web resource "data")
 * override nothing that the caller passes explicitly.
 */
export async function mount(container, context = {}) {
  if (mounted) return;
  mounted = true;
  let root = container;
  if (root.id !== 'cqa-d365-root') {
    root = h('div', { id: 'cqa-d365-root' });
    container.append(root);
  }
  const ctx = { ...D365Bridge.detect(), ...context };
  if (ctx.apiBase) setApiBase(ctx.apiBase);
  buildShell(root);

  const syncReviews = () => refreshResults().catch((e) => toast(e.message, { type: 'error' }));
  window.addEventListener('hashchange', () => {
    route();
    if (['/', '/dialogs', '/appeals'].includes(currentRoute())) syncReviews();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncReviews();
  });
  D365Bridge.listen({
    openDialog: (cid) => { location.hash = `#/dialog/${encodeURIComponent(cid)}`; },
    setGroup: (g) => loadGroup(g).catch((e) => toast(e.message, { type: 'error' })),
  });

  try {
    await boot();
    if (ctx.groupId && ctx.groupId !== state.group && state.datasets.some((d) => d.groupId === ctx.groupId)) await loadGroup(ctx.groupId, false);
    if (ctx.conversationId && !location.hash) location.hash = `#/dialog/${encodeURIComponent(ctx.conversationId)}`;
  } catch {
    toast('Сервер CQA недоступен', { type: 'error', timeout: 10000 });
  }
  subscribe((what) => { if (what === 'group') route(); else renderChrome(); });
  route();
  resumeJobs();
  D365Bridge.post('ready', { groupId: state.group });
}

// Asset paths are relative to this module, so the widget works from any base URL.
function assetUrl(p) { return new URL(`../${p}`, import.meta.url).href; }
function readPref(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }

// Public namespace for Dynamics 365 engineers and the host page.
window.FreedomCQA = { mount, version: '1.0' };
window.CQA = { Config: { get apiBase() { return window.CQA_API_BASE || ''; } }, State: state, Store: state, Scoring, Api: api, D365Bridge };
