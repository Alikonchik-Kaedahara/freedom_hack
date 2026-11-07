// Screen 3: dialog registry with one-click filters.
import { h, icon, fmtScore, scoreClass, channelIcon, channelLabel, pluralRu } from '../ui.js';
import { state, subscribe, summaryFor } from '../store.js';
import { startEvaluation, isRunning } from '../jobs.js';

const filters = { lang: new Set(), channel: new Set(), gross: false, appeal: false, q: '' };
const selected = new Set();

export function renderDialogs(root) {
  const page = h('div', { class: 'page' });
  root.append(page);
  let tbodyHost, headHost, footHost, chipsHost;

  const visible = () => state.records.filter((r) => {
    const s = summaryFor(r.conversation_id);
    if (filters.lang.size && !filters.lang.has(r.language)) return false;
    if (filters.channel.size && !filters.channel.has(r.channel)) return false;
    if (filters.gross && !s?.gross) return false;
    if (filters.appeal && !s?.pending) return false;
    if (filters.q && !r.conversation_id.toLowerCase().includes(filters.q.toLowerCase())) return false;
    return true;
  });

  const drawHead = () => {
    const running = state.job?.status === 'running';
    const sel = [...selected].filter((id) => state.byId[id]);
    const pending = state.records.filter((r) => !summaryFor(r.conversation_id)).map((r) => r.conversation_id);
    let action = null;
    if (!running && sel.length) {
      action = h('button', { class: 'btn btn-primary btn-lg', onclick: () => { startEvaluation(sel); selected.clear(); drawAll(); } },
        icon('sparkles', 18), `Оценить выбранные · ${sel.length}`);
    } else if (!running && pending.length) {
      action = h('button', { class: 'btn btn-primary btn-lg', onclick: () => startEvaluation(pending) },
        icon('sparkles', 18), `Оценить ${pending.length} ${pluralRu(pending.length, 'диалог', 'диалога', 'диалогов')}`);
    }
    headHost.replaceChildren(h('div', { class: 'page-head' }, h('h1', null, 'Диалоги'), h('div', { class: 'head-actions' }, action)));
  };

  const chip = (label, on, toggle, opts = {}) =>
    h('button', { class: `chip ${on ? 'on' : ''} ${opts.danger ? 'danger' : ''}`, type: 'button', onclick: () => { toggle(); drawAll(); } },
      opts.icon ? icon(opts.icon, 16) : null, label);
  const toggleSet = (set, v) => () => (set.has(v) ? set.delete(v) : set.add(v));

  const drawChips = () => {
    const search = h('input', {
      class: 'input', placeholder: 'Поиск по ID', value: filters.q,
      oninput: (e) => { filters.q = e.target.value; drawRows(); },
    });
    chipsHost.replaceChildren(h('div', { class: 'toolbar' },
      h('div', { class: 'chips' },
        ['RU', 'KZ', 'EN'].map((l) => chip(l, filters.lang.has(l), toggleSet(filters.lang, l))),
        h('span', { class: 'chip-sep' }),
        chip('Чат', filters.channel.has('agent chat'), toggleSet(filters.channel, 'agent chat'), { icon: 'chat' }),
        chip('Звонок', filters.channel.has('voice call'), toggleSet(filters.channel, 'voice call'), { icon: 'phone' }),
        h('span', { class: 'chip-sep' }),
        chip('Грубая ошибка', filters.gross, () => (filters.gross = !filters.gross), { icon: 'flag', danger: true }),
        chip('Апелляция', filters.appeal, () => (filters.appeal = !filters.appeal), { icon: 'scale' })),
      h('div', { class: 'search' }, icon('search', 16), search)));
  };

  const drawRows = () => {
    const rows = visible();
    const allSel = rows.length > 0 && rows.every((r) => selected.has(r.conversation_id));
    const headCb = h('input', {
      type: 'checkbox', class: 'cb', checked: allSel, 'aria-label': 'Выбрать все',
      onclick: (e) => { e.stopPropagation(); rows.forEach((r) => (allSel ? selected.delete(r.conversation_id) : selected.add(r.conversation_id))); drawRows(); drawHead(); },
    });
    tbodyHost.replaceChildren(h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', { style: { width: '44px' } }, headCb),
        h('th', null, 'ID'), h('th', null, 'Канал'), h('th', null, 'Язык'),
        h('th', { class: 'right' }, 'Балл'), h('th', null, 'Статус'))),
      h('tbody', null, rows.map(row))));
    footHost.replaceChildren(h('div', { class: 'table-foot' },
      rows.length === state.records.length ? `${rows.length} ${pluralRu(rows.length, 'диалог', 'диалога', 'диалогов')}` : `Показано ${rows.length} из ${state.records.length}`));
  };

  const row = (r) => {
    const cid = r.conversation_id;
    const s = summaryFor(cid);
    const running = isRunning(cid);
    const tags = [];
    if (running) tags.push(h('span', { class: 'tag' }, h('span', { class: 'spinner' }), 'Оценивается'));
    else if (!s) tags.push(h('span', { class: 'tag outline' }, 'Не оценён'));
    if (s?.gross) tags.push(h('span', { class: 'tag red' }, icon('flag', 14), 'Критично'));
    if (s?.pending) tags.push(h('span', { class: 'tag amber' }, icon('scale', 14), 'Апелляция'));
    else if (s?.changed) tags.push(h('span', { class: 'tag green' }, 'Пересмотрен'));
    const cb = h('input', {
      type: 'checkbox', class: 'cb', checked: selected.has(cid), 'aria-label': `Выбрать ${cid}`,
      onclick: (e) => { e.stopPropagation(); e.target.checked ? selected.add(cid) : selected.delete(cid); drawHead(); },
    });
    return h('tr', { class: s?.gross ? 'critical' : '', onclick: () => (location.hash = `#/dialog/${encodeURIComponent(cid)}`) },
      h('td', null, cb),
      h('td', null, h('span', { class: 'id' }, cid)),
      h('td', null, h('span', { class: 'chan' }, icon(channelIcon(r.channel), 16), channelLabel(r.channel))),
      h('td', null, h('span', { class: 'tag outline' }, r.language)),
      h('td', { class: 'right' }, h('span', { class: `score ${scoreClass(s?.total)}` }, fmtScore(s?.total))),
      h('td', null, h('div', { class: 'tags' }, tags)));
  };

  const drawAll = () => { drawHead(); drawChips(); drawRows(); };

  headHost = h('div'); chipsHost = h('div'); tbodyHost = h('div'); footHost = h('div');
  page.append(headHost, h('div', { class: 'card', style: { overflow: 'hidden' } }, chipsHost, tbodyHost, footHost));
  drawAll();

  return subscribe((w) => {
    if (w === 'results' || w === 'job') { drawHead(); drawRows(); }
  });
}
