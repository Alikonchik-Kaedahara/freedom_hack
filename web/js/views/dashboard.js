// Главная: the work desk — what to do today (three queues), then how things are overall.
import { h, fmtScore, scoreClass, pluralRu } from '../ui.js';
import { state, subscribe, summaryFor, resultFor, allAppeals } from '../store.js';
import { finalAnswers, score, round2 } from '../scoring.js';
import { startEvaluation } from '../jobs.js';

import { reviewCriteria, reviewLink, rememberReviewList } from '../review.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function renderDashboard(root) {
  const draw = () => root.replaceChildren(build());
  draw();
  return subscribe((w) => { if (w === 'results' || w === 'job') draw(); });
}

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

function build() {
  const recs = state.records;
  const evaluated = recs.filter((r) => summaryFor(r.conversation_id));
  const pendingIds = recs.filter((r) => !summaryFor(r.conversation_id)).map((r) => r.conversation_id);
  const totals = evaluated.map((r) => summaryFor(r.conversation_id).total).filter((t) => t != null);
  const avg = totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
  const running = state.job?.status === 'running';

  const sub = [`Набор ${state.group} · ${recs.length} ${pluralRu(recs.length, 'диалог', 'диалога', 'диалогов')}`];
  if (evaluated.length) sub.push(`оценено ${evaluated.length}`);
  if (avg != null) sub.push(`средний балл ${fmtScore(avg)}`);
  const action = running
    ? h('span', { class: 'muted' }, 'Идёт оценка…')
    : pendingIds.length && evaluated.length
      ? h('button', { class: 'btn btn-primary', onclick: () => startEvaluation(pendingIds) }, `Оценить ${pendingIds.length} ${pluralRu(pendingIds.length, 'новый', 'новых', 'новых')}`)
      : null;
  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Главная'), h('div', { class: 'sub' }, sub.join(' · '))),
    h('div', { class: 'head-actions' }, action));

  if (!evaluated.length) {
    const first5 = pendingIds.slice(0, 5);
    return h('div', { class: 'page' }, head,
      h('div', { class: 'card start-card' },
        h('h3', { class: 'card-title' }, running ? 'Идёт оценка' : 'Начните с оценки'),
        h('p', { class: 'muted' }, running
          ? 'Оценки появятся здесь по мере готовности.'
          : 'Система проверит диалоги по чек-листу: выставит баллы, объяснит каждое решение и отметит грубые ошибки.'),
        running ? null : h('div', { class: 'start-actions' },
          h('button', { class: 'btn btn-secondary', onclick: () => startEvaluation(first5) }, `Оценить первые ${first5.length}`),
          h('button', { class: 'btn btn-primary', onclick: () => startEvaluation(pendingIds) }, `Оценить все ${pendingIds.length}`))));
  }

  return h('div', { class: 'page dashboard-page' }, head, queueCards(evaluated),
    h('div', { class: 'v3-split' }, criteriaCard(evaluated), triageCard(evaluated)));
}

const LOW = 65; // Individual dialog scores below this threshold need attention.
const UNNAMED = new Set(['Не представился', '[Имя скрыто]', '']);
const isToday = (iso) => { if (!iso) return false; const d = new Date(iso); const n = new Date(); return d.toDateString() === n.toDateString(); };

/** «Что мне сделать сегодня»: three work queues, each opening an already filtered list. */
function queueCards(evaluated) {
  const gross = evaluated.filter((r) => reviewCriteria(r.conversation_id, 'gross').length).length;
  const disputed = evaluated.filter((r) => reviewCriteria(r.conversation_id, 'disputed').length).length;
  const appeals = allAppeals();
  const waiting = appeals.filter((x) => x.appeal.status === 'pending').length;
  const decidedToday = appeals.filter((x) => x.appeal.status !== 'pending' && isToday(x.appeal.decision?.decidedAt)).length;
  const ops = operatorStats(evaluated);

  const line = (n, text, href) => h('a', { class: `q-line ${n ? '' : 'zero'}`, href }, h('b', null, n), ` ${text}`);
  const card = (title, lines, btn, cls = '') => h('div', { class: `card q-card ${cls}` }, h('h3', { class: 'card-title' }, title), h('div', { class: 'q-lines' }, lines), h('div', { class: 'q-foot' }, btn));
  return h('div', { class: 'queue-cards' },
    card('Требуют разбора', [
      line(gross, pluralRu(gross, 'грубая ошибка', 'грубые ошибки', 'грубых ошибок'), '#/dialogs?f=gross'),
      line(disputed, pluralRu(disputed, 'спорная оценка', 'спорные оценки', 'спорных оценок'), '#/dialogs?f=disputed'),
    ], gross || disputed || waiting
      ? h('a', { class: 'btn btn-secondary btn-sm', href: '#/dialogs?f=review' }, 'Открыть очередь')
      : h('span', { class: 'muted' }, 'Всё разобрано')),
    card('Апелляции', [
      line(waiting, waiting === 1 ? 'ждёт решения' : 'ждут решения', '#/appeals'),
      line(decidedToday, `${pluralRu(decidedToday, 'решена', 'решены', 'решено')} сегодня`, '#/appeals'),
    ], h('a', { class: 'btn btn-secondary btn-sm', href: '#/appeals' }, waiting ? 'Рассмотреть' : decidedToday ? 'Открыть апелляции' : 'Нет открытых'), waiting || decidedToday ? 'appeals-card' : 'appeals-card quiet'),
    card('Операторы', ops.total ? [
      h('div', { class: 'q-line' }, h('b', null, ops.repeat), ` ${pluralRu(ops.repeat, 'оператор повторяет', 'оператора повторяют', 'операторов повторяют')} низкие оценки (2+ диалога ниже 65)`),
      h('div', { class: 'q-line plain' }, `Один низкий диалог: ${ops.single} ${pluralRu(ops.single, 'оператор', 'оператора', 'операторов')} — пока не вывод`),
      ops.weakest ? h('a', { class: 'q-line plain', href: `#/operators/${encodeURIComponent(ops.weakest.name)}` },
        `Минимум: ${ops.weakest.name} · ${fmtScore(ops.weakest.avg)} · ${ops.weakest.n} ${pluralRu(ops.weakest.n, 'диалог', 'диалога', 'диалогов')}`) : null,
    ] : [h('div', { class: 'q-line plain' }, 'Имена операторов появятся после оценки')],
    h('a', { class: 'btn btn-secondary btn-sm', href: '#/operators' }, 'К операторам')));
}

/** Operators of the evaluated dialogs: how many, how many average below LOW, who is lowest. */
function operatorStats(evaluated) {
  const per = new Map();
  for (const r of evaluated) {
    const name = (resultFor(r.conversation_id)?.operator || '').trim();
    const total = summaryFor(r.conversation_id)?.total;
    if (UNNAMED.has(name) || total == null) continue;
    const p = per.get(name) || { sum: 0, n: 0, low: 0 };
    p.sum += total; p.n += 1;
    if (total < LOW) p.low += 1;
    per.set(name, p);
  }
  let weakest = null, single = 0, repeat = 0;
  for (const [name, p] of per) {
    const avg = p.sum / p.n;
    if (p.low === 1) single += 1;
    if (p.low >= 2) repeat += 1;
    if (!weakest || avg < weakest.avg) weakest = { name, avg, n: p.n };
  }
  return { total: per.size, single, repeat, weakest };
}

function criteriaCard(evaluated) {
  // Average share of the criterion's weight earned, plus how often it was N/A (chats and calls together).
  const agg = new Map();
  for (const r of evaluated) {
    const res = resultFor(r.conversation_id);
    const sc = score(res.checklist, finalAnswers(res));
    for (const c of res.checklist.criteria) {
      if (c.type === 'flag') continue;
      const p = sc.per[c.id] || {};
      const a = agg.get(c.id) || { code: c.code, name: c.name, sum: 0, n: 0, na: 0 };
      if (r.channel !== 'voice call') { a.name = c.name; a.code = c.code; }
      if (p.ratio != null) { a.sum += p.ratio; a.n += 1; } else a.na += 1;
      agg.set(c.id, a);
    }
  }
  const rows = [...agg.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  // Phones get a narrower viewBox so the text stays readable instead of shrinking with the SVG.
  const narrow = window.matchMedia('(max-width: 820px)').matches;
  const W = narrow ? 340 : 640, rowH = 32, labelW = narrow ? 168 : 240, barW = narrow ? 120 : 210, maxName = narrow ? 18 : 30;
  const H = rows.length * rowH + 4;
  const chart = svg('svg', { class: 'cchart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Выполнение критериев' },
    rows.map((a, i) => {
      const y = i * rowH + 4;
      const pct = a.n ? a.sum / a.n : null;
      const tone = pct == null ? 'none' : pct >= 0.85 ? 'ok' : pct >= 0.6 ? 'part' : 'fail';
      const name = a.name.length > maxName ? `${a.name.slice(0, maxName - 1)}…` : a.name;
      return svg('g', null,
        svg('text', { class: 'code', x: 0, y: y + 15 }, a.code),
        svg('text', { x: 28, y: y + 15 }, svg('title', null, a.name), name),
        svg('rect', { class: 'trk', x: labelW, y: y + 5, width: barW, height: 12, rx: 2 }),
        pct != null ? svg('rect', { class: tone, x: labelW, y: y + 5, width: Math.max(2, barW * pct), height: 12, rx: 2 }) : null,
        svg('text', { class: 'pct', x: labelW + barW + 10, y: y + 15 }, pct == null ? '—' : `${Math.round(pct * 100)}%`, !narrow && a.na ? svg('tspan', { class: 'na' }, ` · не применим в ${a.na}`) : null),
        null);
    }));
  return h('div', { class: 'card card-pad' },
    h('h3', { class: 'card-title' }, `Выполнение критериев (${evaluated.length} ${pluralRu(evaluated.length, 'диалог', 'диалога', 'диалогов')})`),
    chart,
    h('div', { class: 'legend-inline' },
      h('span', null, h('i', { class: 'ok' }), 'от 85%'),
      h('span', null, h('i', { class: 'part' }), '60–84%'),
      h('span', null, h('i', { class: 'fail' }), 'ниже 60%')),
    segments(evaluated));
}

function segments(evaluated) {
  const groups = [['RU', (r) => r.channel !== 'voice call' && r.language === 'RU'], ['KZ', (r) => r.channel !== 'voice call' && r.language === 'KZ'],
    ['EN', (r) => r.channel !== 'voice call' && r.language === 'EN'], ['Звонки', (r) => r.channel === 'voice call']];
  return h('div', { class: 'seg-mini' }, groups.map(([label, test]) => {
    const list = evaluated.filter(test).map((r) => summaryFor(r.conversation_id).total).filter((t) => t != null);
    if (!list.length) return null;
    const avg = round2(list.reduce((a, b) => a + b, 0) / list.length);
    return h('span', { class: 'seg-item' }, `${label} ${Math.round(avg)}`);
  }));
}

function triageCard(evaluated) {
  const items = evaluated.flatMap((r) => {
    const cid = r.conversation_id;
    const id = reviewCriteria(cid)[0];
    if (!id) return [];
    const s = summaryFor(cid), res = resultFor(cid);
    const c = res.checklist.criteria.find((criterion) => criterion.id === id);
    const isGross = s.final.grossIds.includes(id);
    const pending = (res.appeals || []).some((a) => a.status === 'pending' && a.criterionId === id);
    const why = isGross ? `Грубая ошибка · ${finalAnswers(res)[id]?.explanation || c.name}`
      : pending ? `Апелляция · ${c.name}` : `Проверить: ${c.name}`;
    const rank = (isGross ? 0 : pending ? 1 : 2) * 1000 + (s.total ?? 0);
    return [{ r, s, res, why, rank }];
  }).sort((a, b) => a.rank - b.rank);
  return h('div', { class: 'card card-pad triage-card' },
    h('h3', { class: 'card-title' }, 'Очередь на разбор'),
    !items.length ? h('p', { class: 'muted' }, 'Нет диалогов, ожидающих разбора.') : null,
    h('div', { class: 'tri-list' }, items.slice(0, 8).map(({ r, s, res, why }) => {
      const op = (res?.operator || '').trim();
      return h('div', { class: 'tri-row' },
        h('div', { class: 'main' },
          h('div', { class: 'line' }, h('span', { class: 'id' }, r.conversation_id),
            op && !UNNAMED.has(op) ? [h('span', { class: 'sep' }, '·'), h('span', { class: 'meta' }, op)] : null,
            h('span', { class: 'sep' }, '·'), h('span', { class: 'meta' }, r.language)),
          h('div', { class: 'why', title: why }, why)),
        h('span', { class: `score ${scoreClass(s.total)}` }, fmtScore(s.total)),
        h('a', { class: 'btn btn-secondary btn-xs', href: reviewLink(r.conversation_id), onclick: () => rememberReviewList(items.map(({ r }) => r.conversation_id)) }, 'Разобрать'));
    })), items.length > 3 ? h('a', {
      class: `link-btn ${items.length <= 8 ? 'mobile-queue-link' : ''}`, href: '#/dialogs?f=review',
    }, `Все диалоги на разбор · ${items.length}`) : null);
}
