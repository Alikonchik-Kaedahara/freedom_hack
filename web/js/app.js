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
import { renderQuality } from './views/quality.js';
import { renderOperators } from './views/operators.js';
import { renderKnowledge } from './views/knowledge.js';

const NAV = [
  { path: '/', label: 'Обзор', short: 'Обзор', icon: 'grid', rail: 'home' },
  { path: '/dialogs', label: 'Диалоги', short: 'Диалоги', icon: 'list', rail: 'clockR' },
  { path: '/appeals', label: 'Апелляции', short: 'Апелляции', icon: 'scale', rail: 'bookmark', badge: () => pendingAppeals().length },
  { path: '/checklists', label: 'Чек-листы', short: 'Чек-листы', icon: 'checks', rail: 'headset' },
  { path: '/model', label: 'AI-Модель', short: 'Модель', icon: 'cpu', rail: 'gear', more: true },
  { path: '/quality', label: 'Качество', short: 'Качество', icon: 'target', more: true },
  { path: '/operators', label: 'Операторы', short: 'Операторы', icon: 'headset', more: true },
  { path: '/knowledge', label: 'Справочник', short: 'Справочник', icon: 'database', more: true },
];

const ROUTES = [
  [/^\/$/, renderDashboard],
  [/^\/dialogs$/, renderDialogs],
  [/^\/dialog\/(.+)$/, renderDialog],
  [/^\/appeals$/, renderAppeals],
  [/^\/checklists(?:\/(.+))?$/, renderChecklists],
  [/^\/model$/, renderModel],
  [/^\/quality$/, renderQuality],
  [/^\/operators(?:\/(.+))?$/, renderOperators],
  [/^\/knowledge$/, renderKnowledge],
];

const HOST_KEY = 'cqa.hostPreview';
const THEME_KEY = 'cqa.theme';
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
    icon('waffle', 15), h('span', { class: 'lbl' }, 'D365 Host'));
  ui.theme = h('button', { class: 'theme-toggle', type: 'button', title: 'Светлая / тёмная тема', 'aria-label': 'Светлая / тёмная тема' }, icon('contrast', 15));
  ui.action = h('div', { class: 'rb-action' });
  ui.bridge = h('span', { class: 'bridge-badge', hidden: true });
  ui.right = h('div', { class: 'rb-right' }, ui.bridge, ui.pill, ui.host, ui.theme, ui.action);
  ui.rail = h('nav', { class: 'cqa-d365-rail', 'aria-label': 'Разделы CQA' });
  ui.view = h('div', { class: 'cqa-view' });
  ui.tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Разделы CQA' });

  const ribbon = h('header', { class: 'ribbon' },
    h('a', { class: 'rb-brand', href: '#/' },
      h('img', { src: assetUrl('assets/logo.svg'), alt: '' }),
      h('span', { class: 'word' }, h('b', null, 'FREEDOM'), h('small', null, 'BROKER')),
      h('span', { class: 'rb-title' }, 'Conversation Quality Analytics')),
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
  setTheme(readPref(THEME_KEY) === 'dark' ? 'dark' : 'light', false);
  if (D365Bridge.ready) { ui.host.hidden = true; updateBridge(); } // already inside Dynamics 365
  else setHostPreview(readPref(HOST_KEY) !== '0', false); // the Dynamics 365 frame is the default look
}

function setTheme(theme, persist = true) {
  ui.root.dataset.theme = theme;
  ui.theme.setAttribute('aria-pressed', String(theme === 'dark'));
  if (persist) writePref(THEME_KEY, theme);
}

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
  ui.tabs.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return h('a', { href: `#${item.path}`, class: isActive(item, path) ? 'active' : '' },
      icon(item.icon, 16), item.label, badge ? h('span', { class: 'badge' }, badge) : null);
  }));
  ui.rail.replaceChildren(...NAV.map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return h('a', { href: `#${item.path}`, class: isActive(item, path) ? 'active' : '', title: item.label },
      icon(item.rail || item.icon, 20), h('span', null, item.short), badge ? h('span', { class: 'badge' }, badge) : null);
  }));
  const more = NAV.filter((item) => item.more);
  const moreActive = more.some((item) => isActive(item, path));
  ui.tabbar.replaceChildren(...NAV.filter((item) => !item.more).map((item) => {
    const badge = item.badge ? item.badge() : 0;
    return h('a', { href: `#${item.path}`, class: isActive(item, path) ? 'active' : '' },
      h('span', { class: 'tab-icon' }, icon(item.icon, 21), badge ? h('span', { class: 'dot' }, badge) : null),
      h('span', { class: 'tab-label' }, item.short));
  }), h('a', { href: '#', class: `tab-more ${moreActive ? 'active' : ''}`, onclick: (e) => { e.preventDefault(); openMoreSheet(more, path); } },
    h('span', { class: 'tab-icon' }, icon('waffle', 21)), h('span', { class: 'tab-label' }, moreActive ? more.find((item) => isActive(item, path)).short : 'Ещё')));
  const ds = state.datasets.find((d) => d.groupId === state.group);
  ui.pill.replaceChildren(icon('database', 14), h('span', { class: 'k' }, 'Набор:'), h('span', { class: 'mono' }, ds ? `${ds.groupId} · ${ds.total}` : '—'), icon('chevron', 13));
  ui.root.classList.toggle('no-data', !state.group);
}

/** Phone-only: the secondary sections behind the «Ещё» tab. */
function openMoreSheet(items, path) {
  const existing = ui.root.querySelector('.more-sheet');
  if (existing) { existing.remove(); return; }
  const sheet = h('div', { class: 'more-sheet' }, items.map((item) => h('a', { href: `#${item.path}`, class: isActive(item, path) ? 'active' : '', onclick: () => sheet.remove() },
    icon(item.icon, 18), h('span', null, item.label))));
  const dismiss = (e) => { if (!sheet.contains(e.target) && !ui.tabbar.contains(e.target)) { sheet.remove(); document.removeEventListener('mousedown', dismiss, true); } };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  ui.root.append(sheet);
}

function route() {
  const path = currentRoute();
  if (cleanup) { try { cleanup(); } catch { /* noop */ } cleanup = null; }
  const samePage = path === currentPath;
  currentPath = path;
  setRibbonAction(null);
  renderChrome();
  ui.root.querySelector('.more-sheet')?.remove();
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
window.CQA = { Config: { get apiBase() { return window.CQA_API_BASE || ''; } }, State: state, Store: state, Scoring, Api: api, D365Bridge };
