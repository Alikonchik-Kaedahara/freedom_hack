// FreedomCQA widget: shell (embedded command ribbon, optional Dynamics 365 host preview), router
// and the public mount() entry point. Everything renders inside #cqa-d365-root.
import { h, icon, clear, toast, setLayers } from './ui.js';
import { api, setApiBase } from './api.js';
import { state, boot, subscribe, pendingAppeals, loadGroup } from './store.js';
import * as Scoring from './scoring.js';
import { resumeJobs } from './jobs.js';
import { D365Bridge } from './bridge.js';
import { renderImportStage, openDatasetPopover } from './views/import.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDialogs } from './views/dialogs.js';
import { renderDialog } from './views/dialog.js';
import { renderAppeals } from './views/appeals.js';
import { renderChecklists } from './views/checklists.js';
import { renderModel } from './views/model.js';

const NAV = [
  { path: '/', label: 'Обзор', short: 'Обзор', icon: 'grid' },
  { path: '/dialogs', label: 'Реестр диалогов', short: 'Диалоги', icon: 'list' },
  { path: '/appeals', label: 'Апелляции', short: 'Апелляции', icon: 'scale', badge: () => pendingAppeals().length },
  { path: '/checklists', label: 'Конструктор чек-листа', short: 'Чек-листы', icon: 'checks' },
  { path: '/model', label: 'AI-Модель', short: 'Модель', icon: 'cpu' },
];

const ROUTES = [
  [/^\/$/, renderDashboard],
  [/^\/dialogs$/, renderDialogs],
  [/^\/dialog\/(.+)$/, renderDialog],
  [/^\/appeals$/, renderAppeals],
  [/^\/checklists(?:\/(.+))?$/, renderChecklists],
  [/^\/model$/, renderModel],
];

const HOST_KEY = 'cqa.hostPreview';
const ui = {};
let cleanup = null;
let currentPath = null;
let mounted = false;

const currentRoute = () => decodeURI(location.hash.replace(/^#/, '') || '/');
const isActive = (item, path) => (item.path === '/' ? path === '/' : path.startsWith(item.path) || (item.path === '/dialogs' && path.startsWith('/dialog/')));

/** Views put their main evaluation button into the ribbon (desktop); phones keep it in the page head. */
export function setRibbonAction(node) {
  if (ui.action) ui.action.replaceChildren(...(node ? [node] : []));
}

function buildShell(root) {
  ui.root = root;
  ui.tabs = h('nav', { class: 'rb-tabs', 'aria-label': 'Разделы CQA' });
  ui.pill = h('button', { class: 'ds-pill', type: 'button', 'aria-haspopup': 'dialog' });
  ui.host = h('button', { class: 'host-toggle', type: 'button', title: 'Показать, как компонент выглядит внутри Dynamics 365' },
    icon('waffle', 15), h('span', { class: 'lbl' }, 'D365 Host Preview'));
  ui.action = h('div', { class: 'rb-action' });
  ui.right = h('div', { class: 'rb-right' }, ui.pill, ui.host, ui.action);
  ui.bridge = h('span', { class: 'bridge' });
  ui.view = h('div', { class: 'cqa-view' });
  ui.tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Разделы CQA' });

  const ribbon = h('header', { class: 'ribbon' },
    h('a', { class: 'rb-brand', href: '#/' },
      h('img', { src: assetUrl('assets/logo.svg'), alt: '' }),
      h('span', { class: 'word' }, h('b', null, 'FREEDOM'), h('small', null, 'BROKER')),
      h('span', { class: 'rb-badge' }, 'CQA Web Resource')),
    ui.tabs, ui.right);

  const d365Top = h('div', { class: 'cqa-d365-top' },
    h('span', { class: 'waffle' }, Array.from({ length: 9 }, () => h('i'))),
    h('span', { class: 'prod' }, 'Dynamics 365'), h('span', { class: 'sep' }),
    h('span', { class: 'app' }, 'Freedom Broker — Омниканальный контроль качества'),
    ui.bridge, h('span', { class: 'avatar' }, 'FB'));
  const d365Rail = h('div', { class: 'cqa-d365-rail' },
    h('span', null, icon('home', 18)), h('span', null, icon('clockR', 18)), h('span', null, icon('pin', 18)),
    h('span', null, icon('headset', 18)), h('span', { class: 'on' }, icon('checks', 18)));

  const layer = h('div', { class: 'cqa-layer' });
  const modal = h('div'); const toasts = h('div', { class: 'cqa-toasts' }); const dock = h('div', { class: 'cqa-dock' });
  layer.append(modal, toasts, dock);
  setLayers({ modal, toasts, dock });

  root.replaceChildren(h('div', { class: 'cqa-frame' }, d365Top, d365Rail, h('div', { class: 'cqa-app' }, ribbon, ui.view)), ui.tabbar, layer);

  ui.pill.addEventListener('click', (e) => { e.stopPropagation(); openDatasetPopover(ui.right); });
  ui.host.addEventListener('click', () => setHostPreview(!root.classList.contains('cqa-host-on')));
  if (D365Bridge.ready) ui.host.hidden = true; // already inside Dynamics 365
  else setHostPreview(readPref(HOST_KEY) === '1', false);
}

function setHostPreview(on, persist = true) {
  ui.root.classList.toggle('cqa-host-on', on);
  ui.host.classList.toggle('on', on);
  ui.host.setAttribute('aria-pressed', String(on));
  if (persist) writePref(HOST_KEY, on ? '1' : '0');
  const ready = D365Bridge.ready;
  ui.bridge.className = `bridge ${ready ? 'ok' : 'wait'}`;
  ui.bridge.replaceChildren(h('i'), ready ? 'Xrm.WebApi Bridge: Ready' : 'Предпросмотр · Xrm не обнаружен');
}

function renderChrome() {
  const path = currentRoute();
  ui.tabs.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return h('a', { href: `#${item.path}`, class: isActive(item, path) ? 'active' : '' },
      icon(item.icon, 16), item.label, badge ? h('span', { class: 'badge' }, badge) : null);
  }));
  ui.tabbar.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return h('a', { href: `#${item.path}`, class: isActive(item, path) ? 'active' : '' },
      h('span', { class: 'tab-icon' }, icon(item.icon, 21), badge ? h('span', { class: 'dot' }, badge) : null),
      h('span', { class: 'tab-label' }, item.short));
  }));
  const ds = state.datasets.find((d) => d.groupId === state.group);
  ui.pill.replaceChildren(icon('database', 14), 'Набор:', h('span', { class: 'mono' }, ds ? `${ds.groupId} · ${ds.total}` : '—'), icon('chevron', 13));
  ui.root.classList.toggle('no-data', !state.group);
}

function route() {
  const path = currentRoute();
  if (cleanup) { try { cleanup(); } catch { /* noop */ } cleanup = null; }
  const samePage = path === currentPath;
  currentPath = path;
  setRibbonAction(null);
  renderChrome();
  clear(ui.view);
  D365Bridge.post('route', { path });
  if (!state.group) { cleanup = renderImportStage(ui.view) || null; return; }
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

  window.addEventListener('hashchange', route);
  subscribe((what) => { if (what === 'group') route(); else renderChrome(); });
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
window.CQA = { Config: { get apiBase() { return window.CQA_API_BASE || ''; } }, Store: state, Scoring, Api: api, D365Bridge };
