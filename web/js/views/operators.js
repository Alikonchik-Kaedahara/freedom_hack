// Операторы: evaluated dialogs grouped by the operator who handled them — average, failure
// rates per criterion, gross errors, the dialogs behind each number, and a per-dialog name override.
import { h, icon, fmtScore, scoreClass, channelIcon, pluralRu, hashQuery, LOW_SCORE_THRESHOLD } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe } from '../store.js';
import { violationPanel } from './insights.js';

const UNKNOWN = 'Не представился';
const UNNAMED = new Set([UNKNOWN, '[Имя скрыто]']);
// Score filter: quick bands are half-open («40–60» is 40 ≤ балл < 60), typed limits are inclusive.
const list_state = { q: '', key: 'average', dir: 1, min: null, max: null, inclusive: false };
const SCORE_BANDS = [
  { label: 'ниже 40', min: null, max: 40 },
  { label: '40–60', min: 40, max: 60 },
  { label: '60–80', min: 60, max: 80 },
  { label: '80 и выше', min: 80, max: null },
];
const hasRange = () => list_state.min != null || list_state.max != null;
const inRange = (v) => {
  if (v == null) return !hasRange();
  if (list_state.min != null && v < list_state.min) return false;
  if (list_state.max != null && (list_state.inclusive ? v > list_state.max : v >= list_state.max)) return false;
  return true;
};
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

export function renderOperators(root, name) {
  const filter = hashQuery().get('low');
  const band = !name && ['single', 'repeat'].includes(filter) ? filter : null;
  if (!name && list_state.band !== band) { list_state.q = ''; list_state.band = band; }
  const page = h('div', { class: 'page' });
  root.append(page);
  let profiles = null;
  let error = null;
  const violations = name ? violationPanel(name) : null;

  async function load() {
    violations?.refresh();
    try { profiles = await api.operators(state.group); error = null; } catch (e) { error = e.message; profiles = []; }
    draw();
  }

  function draw() {
    if (!profiles) { page.replaceChildren(head(null), h('div', { class: 'skeleton', style: { height: '160px' } })); return; }
    if (error) { page.replaceChildren(head(null), h('div', { class: 'card card-pad import-error' }, error)); return; }
    const current = name ? profiles.find((p) => p.name === name) : null;
    if (name && !current) {
      page.replaceChildren(head(null), h('div', { class: 'card card-pad' }, h('p', { class: 'muted' }, `Оператор «${name}» не найден среди оценённых диалогов.`),
        h('a', { class: 'btn btn-secondary btn-sm', href: '#/operators' }, icon('back', 14), 'Ко всем операторам')));
      return;
    }
    page.replaceChildren(head(current), current ? profile(current) : list());
  }

  function head(current) {
    if (current) {
      const facts = [
        `${current.count} ${pluralRu(current.count, 'диалог', 'диалога', 'диалогов')}`,
        `средний балл ${fmtScore(current.average)}`,
        current.gross ? `${current.gross} ${pluralRu(current.gross, 'грубая ошибка', 'грубые ошибки', 'грубых ошибок')}` : null,
        current.appeals ? `${current.appeals} ${pluralRu(current.appeals, 'апелляция', 'апелляции', 'апелляций')}${current.pending ? `, ждут решения ${current.pending}` : ''}` : null,
      ].filter(Boolean).join(' · ');
      return h('div', { class: 'page-head' },
        h('div', { class: 'head-left' },
          h('a', { class: 'back-btn', href: '#/operators', 'aria-label': 'Ко всем операторам', title: 'Ко всем операторам' }, icon('back', 17)),
          h('div', null,
            h('h1', null, UNNAMED.has(current.name) ? current.name : `Оператор ${current.name}`),
            h('div', { class: 'sub' }, facts))));
    }
    const evaluated = profiles ? profiles.reduce((a, p) => a + p.count, 0) : 0;
    const named = profiles ? profiles.filter((p) => !UNNAMED.has(p.name)).length : 0;
    return h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Операторы'),
        h('div', { class: 'sub' }, profiles
          ? `${named} ${pluralRu(named, 'оператор', 'оператора', 'операторов')} · ${evaluated} ${pluralRu(evaluated, 'оценённый диалог', 'оценённых диалога', 'оценённых диалогов')}`
          : 'Загрузка…')));
  }

  // ----- list -----
  function list() {
    if (!profiles.length) {
      return h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('h3', null, 'Оценённых диалогов пока нет'), h('p', null, 'Оцените диалоги — профили операторов соберутся автоматически.'),
        h('a', { class: 'btn btn-secondary btn-sm', href: '#/dialogs' }, 'К диалогам')));
    }
    const host = h('div');
    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'Имя оператора', value: list_state.q, 'aria-label': 'Поиск оператора',
      oninput: (e) => { list_state.q = e.target.value; drawTable(); },
    });
    const sortTh = (key, label, cls) => {
      const on = list_state.key === key;
      return h('th', { class: cls || null, 'aria-sort': on ? (list_state.dir === 1 ? 'ascending' : 'descending') : 'none' },
        h('button', { class: `th-sort ${on ? 'on' : ''}`, type: 'button', onclick: () => {
          if (on) list_state.dir = -list_state.dir; else { list_state.key = key; list_state.dir = key === 'name' || key === 'average' ? 1 : -1; }
          drawTable();
        } }, label, h('span', { class: 'arr', 'aria-hidden': 'true' }, on ? (list_state.dir === 1 ? '↑' : '↓') : '↕')));
    };
    // Score range: quick bands plus two inputs for any limits («больше 20», «между 60 и 80»).
    const minInput = h('input', { class: 'input', type: 'number', min: 0, max: 100, step: 1, placeholder: 'от', 'aria-label': 'Средний балл от', value: list_state.min ?? '' });
    const maxInput = h('input', { class: 'input', type: 'number', min: 0, max: 100, step: 1, placeholder: 'до', 'aria-label': 'Средний балл до', value: list_state.max ?? '' });
    const bandsHost = h('div', { class: 'chips' });
    const countEl = h('span', { class: 'muted small range-count' });
    const num = (el) => { const v = el.value.trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null; };
    const onTyped = () => { list_state.min = num(minInput); list_state.max = num(maxInput); list_state.inclusive = true; drawBands(); drawTable(); };
    minInput.addEventListener('input', onTyped);
    maxInput.addEventListener('input', onTyped);
    const setRange = (min, max, inclusive) => {
      list_state.min = min; list_state.max = max; list_state.inclusive = inclusive;
      minInput.value = min ?? ''; maxInput.value = max ?? '';
      drawBands(); drawTable();
    };
    function drawBands() {
      const chips = SCORE_BANDS.map((b) => {
        const on = !list_state.inclusive && list_state.min === b.min && list_state.max === b.max;
        return h('button', { class: `chip ${on ? 'on' : ''}`, type: 'button', 'aria-pressed': String(on),
          onclick: () => (on ? setRange(null, null, false) : setRange(b.min, b.max, false)) }, b.label);
      });
      if (hasRange()) chips.push(h('button', { class: 'link-btn', type: 'button', onclick: () => setRange(null, null, false) }, 'Сбросить'));
      bandsHost.replaceChildren(...chips);
    }
    function drawTable() {
      const q = list_state.q.trim().toLowerCase();
      const val = (p) => (list_state.key === 'name' ? p.name : p[list_state.key] ?? -1);
      const rows = profiles.filter((p) => {
        if (q && !p.name.toLowerCase().includes(q)) return false;
        if (!inRange(p.average)) return false;
        if (!band) return true;
        const low = p.dialogs.filter((d) => d.total != null && d.total < LOW_SCORE_THRESHOLD).length;
        return !UNNAMED.has(p.name) && (band === 'repeat' ? low >= 2 : low === 1);
      }).sort((a, b) => {
        // Unnamed groups always go last, whatever the sort.
        const ua = UNNAMED.has(a.name), ub = UNNAMED.has(b.name);
        if (ua !== ub) return ua - ub;
        const x = val(a), y = val(b);
        return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * list_state.dir;
      });
      countEl.textContent = hasRange() || q ? `${rows.length} из ${profiles.length}` : '';
      if (!rows.length) {
        host.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'Таких операторов нет'),
          hasRange() ? h('p', null, 'Ни у одного оператора средний балл не попадает в выбранный диапазон.') : null,
          q || hasRange() ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => { list_state.q = ''; search.value = ''; setRange(null, null, false); } }, 'Сбросить фильтры') : null));
        return;
      }
      host.replaceChildren(h('table', { class: 'table op-table' },
        h('thead', null, h('tr', null, sortTh('name', 'Оператор'), sortTh('count', 'Диалогов', 'right'), sortTh('average', 'Средний балл', 'right'),
          h('th', null, 'Разброс'), sortTh('gross', 'Грубых ошибок', 'right'), sortTh('appeals', 'Апелляций', 'right'), h('th', null, 'Слабые критерии'), h('th', null, ''))),
        h('tbody', null, rows.map(row))));
    }
    const row = (p) => {
      const unnamed = UNNAMED.has(p.name);
      const open = () => { location.hash = `#/operators/${encodeURIComponent(p.name)}`; };
      const weakest = p.weakest.slice(0, 2).map((c) => h('span', { class: 'tag amber', title: `${c.name}: не выполнено ${c.failed}, частично ${c.partial} из ${c.applicable}` }, `${c.code} · ${pct(c.failRate)}`));
      return h('tr', { class: `op-row ${unnamed ? 'unnamed' : ''}`, onclick: open },
        h('td', null, h('div', { class: 'op-name' }, h('span', { class: `op-avatar ${unnamed ? 'unknown' : ''}` }, initials(p.name)), h('b', null, p.name)),
          h('span', { class: 'op-mobile-count' }, `${p.count} ${pluralRu(p.count, 'диалог', 'диалога', 'диалогов')}`),
          unnamed ? h('div', { class: 'muted small' }, 'Имя можно указать в карточке диалога: «⋯» → «Указать оператора»') : null),
        h('td', { class: 'num' }, p.count),
        h('td', { class: 'num' }, h('span', { class: `score ${scoreClass(p.average)}` }, fmtScore(p.average))),
        h('td', null, spark(p)),
        h('td', { class: 'num' }, p.gross ? h('span', { class: 'tag red' }, p.gross) : h('span', { class: 'muted' }, '0')),
        h('td', { class: 'num' }, p.appeals ? `${p.appeals}${p.pending ? ` (ждут ${p.pending})` : ''}` : h('span', { class: 'muted' }, '0')),
        h('td', null, weakest.length ? h('div', { class: 'tags' }, weakest) : h('span', { class: 'muted' }, 'нет')),
        h('td', { class: 'row-act' }, h('button', { class: 'btn btn-secondary btn-xs', type: 'button', onclick: (e) => { e.stopPropagation(); open(); } }, 'Открыть')));
    };
    drawBands();
    drawTable();
    return h('div', { class: 'card', style: { overflow: 'hidden' } },
      h('div', { class: 'toolbar reg-toolbar' },
        h('div', { class: 'score-range', role: 'group', 'aria-label': 'Фильтр по среднему баллу' },
          h('span', { class: 'range-label' }, 'Средний балл'), bandsHost,
          h('span', { class: 'range-inputs' }, minInput, h('span', { class: 'muted' }, '—'), maxInput), countEl),
        band && h('a', { class: 'chip on', href: '#/operators', title: 'Показать всех операторов' },
          `Ниже ${LOW_SCORE_THRESHOLD} · ${band === 'single' ? 'один диалог' : 'два и более'} ×`),
        h('div', { class: 'search' }, icon('search', 16), search)),
      host);
  }

  function spark(p) {
    const totals = p.dialogs.map((d) => d.total).filter((t) => t != null).sort((a, b) => a - b);
    if (totals.length < 2) return h('span', { class: 'muted' }, '—');
    const bars = totals.map((t, i) => svg('rect', { x: i * (100 / totals.length), y: 24 - t / 100 * 24, width: Math.max(1, 100 / totals.length - 1), height: t / 100 * 24, class: scoreClass(t) }));
    return svg('svg', { class: 'op-spark', viewBox: '0 0 100 24', preserveAspectRatio: 'none', role: 'img', 'aria-label': `баллы диалогов от ${totals[0]} до ${totals[totals.length - 1]}` }, bars);
  }

  // ----- profile -----
  function profile(p) {
    const dialogs = h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Диалоги', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'сначала с низким баллом')),
      h('div', { class: 'qtable-wrap' }, h('table', { class: 'triage op-dialogs' }, h('tbody', null, p.dialogs.map((d) => h('tr', null,
        h('td', { class: 'id' }, d.conversationId),
        h('td', null, h('span', { class: 'chan' }, icon(channelIcon(d.channel), 13), d.language)),
        h('td', null, h('span', { class: `score ${scoreClass(d.total)}` }, fmtScore(d.total))),
        h('td', { class: 'why' }, d.gross ? h('span', { class: 'tag red' }, 'Грубая ошибка') : dialogFindings(d)),
        h('td', { class: 'row-act' }, h('a', { class: 'btn btn-secondary btn-xs', href: `#/dialog/${encodeURIComponent(d.conversationId)}` }, 'Открыть'))))))));
    return h('div', { class: 'profile-work' }, violations.el, dialogs);
  }

  load();
  return subscribe((w) => { if (w === 'results' || (w === 'job' && !state.job)) load(); }); // results change; job finished
}

function dialogFindings(dialog) {
  const parts = [];
  const count = (n) => `${n} ${pluralRu(n, 'критерий', 'критерия', 'критериев')}`;
  if (dialog.failed.length) parts.push('Не выполнено: ' + count(dialog.failed.length));
  if (dialog.partial?.length) parts.push('Частично: ' + count(dialog.partial.length));
  return parts.length ? parts.join(' · ') : h('span', { class: 'muted' }, dialog.total == null ? 'Нет оценки' : 'Без нарушений');
}

function initials(name) {
  if (UNNAMED.has(name)) return '?';
  return name.replace(/[[\]]/g, '').trim().slice(0, 1).toUpperCase() || '?';
}
