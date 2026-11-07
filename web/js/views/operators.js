// Операторы: evaluated dialogs grouped by the operator who handled them — average, failure
// rates per criterion, gross errors, the dialogs behind each number, and a per-dialog name override.
import { h, icon, fmtScore, scoreClass, channelLabel, channelIcon, openModal, toast, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, putResult, keyOf } from '../store.js';
import { setRibbonAction } from '../app.js';

const UNKNOWN = 'Не представился';
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

export function renderOperators(root, name) {
  const page = h('div', { class: 'page' });
  root.append(page);
  let profiles = null;
  let error = null;

  async function load() {
    try { profiles = await api.operators(state.group); error = null; } catch (e) { error = e.message; profiles = []; }
    draw();
  }

  function draw() {
    setRibbonAction(null);
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
      return h('div', { class: 'page-head' },
        h('div', { class: 'head-left' },
          h('a', { class: 'back-btn', href: '#/operators', 'aria-label': 'Ко всем операторам', title: 'Ко всем операторам' }, icon('back', 17)),
          h('div', null,
            h('h1', null, current.name === UNKNOWN ? UNKNOWN : `Оператор ${current.name}`),
            h('div', { class: 'sub' }, `${current.count} ${pluralRu(current.count, 'диалог', 'диалога', 'диалогов')} · ${Object.entries(current.languages).map(([l, n]) => `${l} ${n}`).join(' · ')} · ${Object.entries(current.channels).map(([c, n]) => `${channelLabel(c).toLowerCase()} ${n}`).join(' · ')}`))));
    }
    const evaluated = profiles ? profiles.reduce((a, p) => a + p.count, 0) : 0;
    return h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Операторы'),
        h('div', { class: 'sub' }, profiles ? `${profiles.length} ${pluralRu(profiles.length, 'оператор', 'оператора', 'операторов')} по ${evaluated} оценённым ${pluralRu(evaluated, 'диалогу', 'диалогам', 'диалогам')} · имя берётся из представления в первой реплике, его можно поправить в карточке` : 'Загрузка…')));
  }

  // ----- list -----
  function list() {
    if (!profiles.length) {
      return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('headset', 30)),
        h('h3', null, 'Оценённых диалогов пока нет'), h('p', null, 'Оцените диалоги — профили операторов соберутся автоматически.')));
    }
    const rows = profiles.map((p) => {
      const weakest = p.weakest.slice(0, 2).map((c) => h('span', { class: 'tag amber', title: `${c.name}: не выполнено ${c.failed}, частично ${c.partial} из ${c.applicable}` }, `${c.code} ${pct(c.failRate)}`));
      return h('tr', { class: 'op-row', onclick: () => { location.hash = `#/operators/${encodeURIComponent(p.name)}`; } },
        h('td', null, h('div', { class: 'op-name' }, h('span', { class: `op-avatar ${p.name === UNKNOWN ? 'unknown' : ''}` }, initials(p.name)), h('b', null, p.name)),
          p.name === UNKNOWN ? h('div', { class: 'muted small' }, 'нет представления в первой реплике или имя скрыто') : null),
        h('td', { class: 'num' }, p.count),
        h('td', { class: 'num' }, h('span', { class: `score ${scoreClass(p.average)}` }, fmtScore(p.average)),
          p.min != null && p.count > 1 ? h('div', { class: 'muted small mono' }, `${fmtScore(p.min)} – ${fmtScore(p.max)}`) : null),
        h('td', null, spark(p)),
        h('td', { class: 'num' }, p.gross ? h('span', { class: 'tag red' }, icon('shield', 12), p.gross) : h('span', { class: 'muted' }, '0')),
        h('td', { class: 'num' }, p.appeals ? `${p.appeals}${p.pending ? ` (${p.pending} ждут)` : ''}` : h('span', { class: 'muted' }, '0')),
        h('td', null, weakest.length ? h('div', { class: 'tags' }, weakest) : h('span', { class: 'muted' }, 'нет провалов')),
        h('td', null, icon('right', 16)));
    });
    return h('div', { class: 'card', style: { overflow: 'hidden' } },
      h('table', { class: 'table op-table' },
        h('thead', null, h('tr', null, h('th', null, 'Оператор'), h('th', { class: 'right' }, 'Диалогов'), h('th', { class: 'right' }, 'Средний балл'),
          h('th', null, 'Разброс'), h('th', { class: 'right' }, 'Грубых'), h('th', { class: 'right' }, 'Апелляций'), h('th', null, 'Слабые критерии'), h('th', null, ''))),
        h('tbody', null, rows)));
  }

  function spark(p) {
    const totals = p.dialogs.map((d) => d.total).filter((t) => t != null).sort((a, b) => a - b);
    if (totals.length < 2) return h('span', { class: 'muted' }, totals.length ? 'один диалог' : '—');
    const bars = totals.map((t, i) => svg('rect', { x: i * (100 / totals.length), y: 24 - t / 100 * 24, width: Math.max(1, 100 / totals.length - 1), height: t / 100 * 24, class: scoreClass(t) }));
    return svg('svg', { class: 'op-spark', viewBox: '0 0 100 24', preserveAspectRatio: 'none', role: 'img', 'aria-label': `баллы диалогов от ${totals[0]} до ${totals[totals.length - 1]}` }, bars);
  }

  // ----- profile -----
  function profile(p) {
    const strip = h('div', { class: 'card tstrip tstrip-4' },
      cell('Средний балл', h('span', { class: 'val' }, h('span', { class: `score ${scoreClass(p.average)}` }, fmtScore(p.average)), h('small', null, '/ 100')), p.count > 1 ? `от ${fmtScore(p.min)} до ${fmtScore(p.max)}` : 'один диалог'),
      cell('Диалогов', h('span', { class: 'val' }, p.count), `${Object.entries(p.channels).map(([c, n]) => `${n} ${channelLabel(c).toLowerCase()}`).join(' · ')}`),
      cell('Грубые ошибки', h('span', { class: `val ${p.gross ? 'q-fail' : ''}` }, p.gross), p.gross ? 'нулевая терпимость — см. диалоги ниже' : 'не выявлено'),
      cell('Апелляции', h('span', { class: 'val' }, p.appeals), p.pending ? `${p.pending} на рассмотрении` : (p.appeals ? 'все решены' : 'не подавались')));

    const crit = h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Критерии', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'доля невыполнения среди применимых; частично = ½')),
      h('div', { class: 'qtable-wrap' }, h('table', { class: 'qtable' }, h('tbody', null, p.criteria.map((c) => h('tr', null,
        h('td', { class: 'mono' }, c.code), h('td', null, c.name),
        c.type === 'flag'
          ? [h('td', { colspan: 2 }, c.flag ? h('span', { class: 'tag red' }, `${c.flag} ${pluralRu(c.flag, 'диалог', 'диалога', 'диалогов')}`) : h('span', { class: 'muted' }, 'не выявлено'))]
          : [h('td', { class: 'num muted' }, c.applicable ? `${c.failed} / ${c.partial} / ${c.applicable}` : `N/A ×${c.na}`),
            h('td', null, c.failRate == null ? h('span', { class: 'muted' }, 'не применимо') : bar(c.failRate))]))))),
      h('div', { class: 'muted small', style: { marginTop: '8px' } }, 'Числа: не выполнено / частично / применимо.'));

    const dialogs = h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Диалоги', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'от слабых к сильным')),
      h('div', { class: 'qtable-wrap' }, h('table', { class: 'triage op-dialogs' }, h('tbody', null, p.dialogs.map((d) => h('tr', null,
        h('td', { class: 'id' }, h('a', { href: `#/dialog/${encodeURIComponent(d.conversationId)}` }, d.conversationId)),
        h('td', null, h('span', { class: 'tag outline' }, icon(channelIcon(d.channel), 12), d.language)),
        h('td', null, h('span', { class: `score ${scoreClass(d.total)}` }, fmtScore(d.total))),
        h('td', { class: 'why' }, d.gross ? h('span', { class: 'tag red' }, icon('shield', 12), 'грубая') : (d.failed.length ? `не выполнено: ${d.failed.join(', ')}` : h('span', { class: 'muted' }, 'без провалов'))),
        h('td', null,
          h('a', { class: 'btn btn-ghost btn-xs', href: api.reportUrl(state.group, d.conversationId), target: '_blank', rel: 'noopener', title: 'Печатный отчёт' }, icon('download', 13)),
          h('button', { class: 'btn btn-ghost btn-xs', type: 'button', title: 'Указать оператора вручную', 'aria-label': 'Указать оператора', onclick: () => rename(d.conversationId, p.name) }, icon('pencil', 13)))))))));
    return h('div', null, strip, h('div', { class: 'grid two-one', style: { marginTop: '12px' } }, dialogs, crit));
  }

  function rename(cid, currentName) {
    const input = h('input', { class: 'input', value: currentName === UNKNOWN ? '' : currentName, placeholder: 'Имя оператора', maxlength: 60 });
    const { close } = openModal({
      title: 'Оператор диалога', sub: `${cid} · пустое поле вернёт автоматическое определение по первой реплике`,
      body: h('div', { class: 'field' }, h('label', null, 'Имя'), input),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => close() }, 'Отмена'),
        h('button', { class: 'btn btn-primary', onclick: save }, 'Сохранить')],
    });
    setTimeout(() => input.focus(), 30);
    async function save() {
      try {
        const res = await api.setOperator(keyOf(cid), input.value.trim());
        putResult(res);
        close();
        toast('Оператор обновлён');
        const next = input.value.trim();
        if (next && next !== name) location.hash = `#/operators/${encodeURIComponent(next)}`; else load();
      } catch (e) { toast(e.message, { type: 'error' }); }
    }
  }

  function cell(label, val, foot) {
    return h('div', { class: 'tcell' }, h('div', { class: 'lbl' }, label), val, h('div', { class: 'foot' }, foot));
  }

  function bar(v) {
    const w = Math.max(0, Math.min(100, v || 0));
    const t = v >= 50 ? 'fail' : v >= 20 ? 'part' : 'ok';
    return h('div', { class: 'qbar-wrap' }, svg('svg', { class: 'qbar', viewBox: '0 0 100 8', preserveAspectRatio: 'none', role: 'img', 'aria-label': pct(v) },
      svg('rect', { class: 'trk', x: 0, y: 0, width: 100, height: 8, rx: 2 }), svg('rect', { class: t, x: 0, y: 0, width: w, height: 8, rx: 2 })), h('span', { class: 'mono small' }, pct(v)));
  }

  load();
  return subscribe((w) => { if (w === 'results' || (w === 'job' && !state.job)) load(); }); // results change; job finished
}

function initials(name) {
  if (name === UNKNOWN) return '?';
  return name.replace(/[[\]]/g, '').trim().slice(0, 1).toUpperCase() || '?';
}
