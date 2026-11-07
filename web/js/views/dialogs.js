// Диалоги: the registry. Search and one-click filters, sorting by score or operator,
// a selection bar for batch actions, statuses in words.
import { h, icon, fmtScore, scoreClass, channelIcon, channelLabel, pluralRu, hashQuery, clearHashQuery, moreMenu } from '../ui.js';
import { state, subscribe, summaryFor, resultFor } from '../store.js';
import { startEvaluation, confirmSecondOpinion, isRunning } from '../jobs.js';
import { finalAnswers, score } from '../scoring.js';
import { openExportModal } from './export.js';

const filters = { lang: new Set(), channel: new Set(), gross: false, appeal: false, disputed: false, q: '' };
const selected = new Set();
const sort = { key: null, dir: 1 }; // key: 'score' | 'operator' | null (set order)
const UNNAMED = new Set(['', 'Не представился', '[Имя скрыто]']);

const anyFilter = () => filters.lang.size || filters.channel.size || filters.gross || filters.appeal || filters.disputed || filters.q.trim();
function resetFilters() {
  filters.lang.clear(); filters.channel.clear();
  filters.gross = false; filters.appeal = false; filters.disputed = false; filters.q = '';
}

export function renderDialogs(root) {
  // Links from Home open the registry already filtered: #/dialogs?f=gross | disputed | appeal
  const preset = hashQuery().get('f');
  if (['gross', 'disputed', 'appeal'].includes(preset)) {
    resetFilters();
    filters[preset] = true;
    clearHashQuery();
  }

  const page = h('div', { class: 'page' });
  root.append(page);
  const headHost = h('div'), chipsHost = h('div'), selHost = h('div'), tbodyHost = h('div'), footHost = h('div');

  const visible = () => {
    const rows = state.records.filter((r) => {
      const s = summaryFor(r.conversation_id);
      if (filters.lang.size && !filters.lang.has(r.language)) return false;
      if (filters.channel.size && !filters.channel.has(r.channel)) return false;
      if (filters.gross && !s?.gross) return false;
      if (filters.appeal && !s?.pending) return false;
      if (filters.disputed && !s?.disputed?.length) return false;
      if (filters.q && !matchOf(r)) return false;
      return true;
    });
    if (sort.key === 'score') {
      // Not yet evaluated rows always go last.
      rows.sort((a, b) => {
        const x = summaryFor(a.conversation_id)?.total, y = summaryFor(b.conversation_id)?.total;
        if (x == null || y == null) return (x == null) - (y == null);
        return (x - y) * sort.dir;
      });
    } else if (sort.key === 'operator') {
      rows.sort((a, b) => {
        const x = operatorOf(a.conversation_id), y = operatorOf(b.conversation_id);
        if (!x || !y) return (!x) - (!y);
        return x.localeCompare(y, 'ru') * sort.dir;
      });
    }
    return rows;
  };

  // Search matches the conversation id, the operator or any message text; a text match shows a snippet.
  const matchOf = (r) => {
    const q = filters.q.trim().toLowerCase();
    if (!q) return null;
    if (r.conversation_id.toLowerCase().includes(q)) return { id: true };
    if ((resultFor(r.conversation_id)?.operator || '').toLowerCase().includes(q)) return { op: true };
    for (const m of r.transcript) {
      const t = m.text || '';
      const i = t.toLowerCase().indexOf(q);
      if (i >= 0) return { text: t, i, len: q.length };
    }
    return null;
  };

  const drawHead = () => {
    const running = state.job?.status === 'running';
    const evaluated = state.records.filter((r) => summaryFor(r.conversation_id)).length;
    const pending = state.records.filter((r) => !summaryFor(r.conversation_id)).map((r) => r.conversation_id);
    const action = running
      ? h('span', { class: 'muted' }, 'Идёт оценка…')
      : pending.length
        ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => startEvaluation(pending) },
          `Оценить ${pending.length} ${pluralRu(pending.length, 'новый', 'новых', 'новых')}`)
        : null;
    const menu = evaluated ? moreMenu([{ label: 'Скачать результаты', onClick: openExportModal }]) : null;
    headHost.replaceChildren(h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Диалоги'),
        h('div', { class: 'sub' }, state.records.length ? `Оценено ${evaluated} из ${state.records.length}` : 'Набор не загружен')),
      h('div', { class: 'head-actions' }, action, menu)));
  };

  const chip = (label, on, toggle, danger) =>
    h('button', { class: `chip ${on ? 'on' : ''} ${danger ? 'danger' : ''}`, type: 'button', 'aria-pressed': String(on), onclick: () => { toggle(); drawChips(); drawRows(); } }, label);
  const toggleSet = (set, v) => () => (set.has(v) ? set.delete(v) : set.add(v));

  const drawChips = () => {
    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'ID, оператор или текст реплики', value: filters.q, 'aria-label': 'Поиск',
      oninput: (e) => { filters.q = e.target.value; drawRows(); },
    });
    chipsHost.replaceChildren(h('div', { class: 'toolbar reg-toolbar' },
      h('div', { class: 'search' }, icon('search', 16), search),
      h('div', { class: 'chips' },
        ['RU', 'KZ', 'EN'].map((l) => chip(l, filters.lang.has(l), toggleSet(filters.lang, l))),
        h('span', { class: 'chip-sep' }),
        chip('Чат', filters.channel.has('agent chat'), toggleSet(filters.channel, 'agent chat')),
        chip('Звонок', filters.channel.has('voice call'), toggleSet(filters.channel, 'voice call')),
        h('span', { class: 'chip-sep' }),
        chip('Грубая ошибка', filters.gross, () => (filters.gross = !filters.gross), true),
        chip('Апелляция', filters.appeal, () => (filters.appeal = !filters.appeal)),
        chip('Спорные', filters.disputed, () => (filters.disputed = !filters.disputed)))));
  };

  // Batch actions for the checked rows, right above the table where the checkboxes are.
  const drawSelection = () => {
    const sel = [...selected].filter((id) => state.byId[id]);
    if (!sel.length) { selHost.replaceChildren(); return; }
    const running = state.job?.status === 'running';
    const evaluated = sel.filter((id) => summaryFor(id));
    selHost.replaceChildren(h('div', { class: 'sel-bar', role: 'region', 'aria-label': 'Действия с выбранными' },
      h('b', null, `Выбрано ${sel.length}`),
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: running, onclick: () => { startEvaluation(sel); selected.clear(); drawAll(); } }, 'Оценить'),
      h('button', {
        class: 'btn btn-secondary btn-sm', type: 'button', disabled: running || !evaluated.length,
        title: evaluated.length ? null : 'Второе мнение доступно для оценённых диалогов',
        onclick: () => confirmSecondOpinion(evaluated),
      }, evaluated.length && evaluated.length < sel.length ? `Второе мнение (${evaluated.length})` : 'Второе мнение'),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { selected.clear(); drawAll(); } }, 'Снять выделение')));
  };

  const sortTh = (key, label, cls) => {
    const on = sort.key === key;
    const next = () => {
      if (!on) { sort.key = key; sort.dir = 1; } else if (sort.dir === 1) sort.dir = -1; else sort.key = null;
      drawRows();
    };
    return h('th', { class: cls || null, 'aria-sort': on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
      h('button', { class: `th-sort ${on ? 'on' : ''}`, type: 'button', onclick: next },
        label, h('span', { class: 'arr', 'aria-hidden': 'true' }, on ? (sort.dir === 1 ? '↑' : '↓') : '↕')));
  };

  const drawRows = () => {
    if (!state.records.length) {
      tbodyHost.replaceChildren(h('div', { class: 'empty' },
        h('h3', null, 'Загрузите набор'),
        h('p', null, 'Диалоги появятся здесь, когда будет выбран набор диалогов.')));
      footHost.replaceChildren();
      return;
    }
    const rows = visible();
    if (!rows.length) {
      tbodyHost.replaceChildren(h('div', { class: 'empty' },
        h('h3', null, 'По этим условиям диалогов нет'),
        anyFilter() ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => { resetFilters(); drawChips(); drawRows(); } }, 'Сбросить фильтры') : null));
      footHost.replaceChildren();
      return;
    }
    const allSel = rows.every((r) => selected.has(r.conversation_id));
    const headCb = h('input', {
      type: 'checkbox', class: 'cb', checked: allSel, 'aria-label': 'Выбрать все',
      onclick: (e) => { e.stopPropagation(); rows.forEach((r) => (allSel ? selected.delete(r.conversation_id) : selected.add(r.conversation_id))); drawRows(); drawSelection(); },
    });
    tbodyHost.replaceChildren(h('table', { class: 'table registry' },
      h('thead', null, h('tr', null,
        h('th', { style: { width: '44px' } }, headCb),
        h('th', null, 'ID'), sortTh('operator', 'Оператор'), h('th', null, 'Канал'), h('th', null, 'Язык'),
        h('th', null, 'Критерии 01–08'),
        sortTh('score', 'Балл', 'right'), h('th', null, 'Статус'), h('th', null, ''))),
      h('tbody', null, rows.map(row))));
    footHost.replaceChildren(h('div', { class: 'table-foot' },
      h('span', null, rows.length === state.records.length ? `${rows.length} ${pluralRu(rows.length, 'диалог', 'диалога', 'диалогов')}` : `Показано ${rows.length} из ${state.records.length}`),
      h('span', { class: 'mx-legend' },
        h('span', null, h('i', { class: 'ok' }), 'выполнен'),
        h('span', null, h('i', { class: 'part' }), 'частично'),
        h('span', null, h('i', { class: 'fail' }), 'не выполнен'),
        h('span', null, h('i', { class: 'na' }), 'не применим'))));
  };

  const row = (r) => {
    const cid = r.conversation_id;
    const s = summaryFor(cid);
    const running = isRunning(cid);
    const tags = [];
    if (running) tags.push(h('span', { class: 'tag' }, h('span', { class: 'spinner' }), 'Оценивается'));
    else if (!s) tags.push(h('span', { class: 'tag' }, 'Не оценён'));
    if (s?.gross) tags.push(h('span', { class: 'tag red' }, 'Грубая ошибка'));
    if (s?.pending) tags.push(h('span', { class: 'tag amber' }, 'Апелляция'));
    else if (s?.changed) tags.push(h('span', { class: 'tag green' }, 'Пересмотрен'));
    if (s?.disputed?.length) tags.push(h('span', { class: 'tag amber', title: 'Критерии, где оценка неуверенна или второе мнение разошлось с первым' }, `Спорно: ${s.disputed.length}`));
    const cb = h('input', {
      type: 'checkbox', class: 'cb', checked: selected.has(cid), 'aria-label': `Выбрать ${cid}`,
      onclick: (e) => {
        e.stopPropagation();
        if (e.target.checked) selected.add(cid); else selected.delete(cid);
        e.target.closest('tr').classList.toggle('selected', e.target.checked);
        drawSelection();
      },
    });
    const open = () => (location.hash = `#/dialog/${encodeURIComponent(cid)}`);
    const m = matchOf(r);
    const act = s
      ? h('button', { class: 'btn btn-secondary btn-xs', type: 'button', onclick: (e) => { e.stopPropagation(); open(); } }, 'Открыть')
      : h('button', { class: 'btn btn-secondary btn-xs', type: 'button', disabled: running || state.job?.status === 'running', onclick: (e) => { e.stopPropagation(); startEvaluation([cid]); } }, 'Оценить');
    return h('tr', { class: `${s?.gross ? 'critical' : ''} ${selected.has(cid) ? 'selected' : ''}`, onclick: open },
      h('td', null, cb),
      h('td', null, h('span', { class: 'id' }, cid), m?.text ? h('div', { class: 'match-hint' }, snippet(m)) : null),
      h('td', null, operatorCell(cid)),
      h('td', null, h('span', { class: 'chan' }, icon(channelIcon(r.channel), 14), channelLabel(r.channel))),
      h('td', null, h('span', { class: 'lang' }, r.language)),
      h('td', null, matrix(cid)),
      h('td', { class: 'right' }, h('span', { class: `score ${scoreClass(s?.total)}` }, fmtScore(s?.total))),
      h('td', null, h('div', { class: 'tags' }, tags)),
      h('td', { class: 'row-act' }, act));
  };

  const snippet = (m) => {
    const from = Math.max(0, m.i - 24);
    return [from ? '…' : '', m.text.slice(from, m.i), h('mark', null, m.text.slice(m.i, m.i + m.len)), m.text.slice(m.i + m.len, m.i + m.len + 40), '…'];
  };

  const drawAll = () => { drawHead(); drawChips(); drawSelection(); drawRows(); };

  page.append(headHost, h('div', { class: 'card', style: { overflow: 'hidden' } }, chipsHost, selHost, tbodyHost, footHost));
  drawAll();

  return subscribe((w) => {
    if (w === 'results' || w === 'job') { drawHead(); drawSelection(); drawRows(); }
  });
}

const operatorOf = (cid) => {
  const name = (resultFor(cid)?.operator || '').trim();
  return UNNAMED.has(name) ? '' : name;
};

// Eight squares, one per checklist criterion; the last one is the gross-error check.
const MX_TITLE = { ok: 'выполнен', part: 'частично', fail: 'не выполнен', na: 'не применим', flag: 'грубая ошибка', clean: 'грубых ошибок нет' };
function matrix(cid) {
  const res = resultFor(cid);
  if (!res) return h('span', { class: 'mx' }, Array.from({ length: 8 }, () => h('i', { class: 'empty' })));
  const sc = score(res.checklist, finalAnswers(res));
  const cells = res.checklist.criteria.map((c) => {
    const st = sc.per[c.id]?.status || 'na';
    const cls = st === 'flag' ? 'fail' : st === 'clean' ? 'ok' : st;
    return h('i', { class: cls, title: `${c.code} ${c.name}: ${MX_TITLE[st] || st}` }, st === 'na' ? '–' : '');
  });
  return h('span', { class: 'mx' }, cells);
}

/** Operator of an evaluated dialog (from the first reply, or set by hand); unknown until evaluated. */
function operatorCell(cid) {
  const name = (resultFor(cid)?.operator || '').trim();
  if (!name) return h('span', { class: 'muted' }, '—');
  if (UNNAMED.has(name)) return h('span', { class: 'muted', title: 'Оператор не назвал себя в первой реплике; имя можно указать в карточке диалога' }, name);
  return h('a', { class: 'op-link', href: `#/operators/${encodeURIComponent(name)}`, onclick: (e) => e.stopPropagation() }, name);
}
