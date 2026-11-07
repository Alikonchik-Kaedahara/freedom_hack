// Обзор: supervisor workbench — telemetry strip, criteria performance chart, priority triage.
import { h, icon, fmtScore, scoreClass, channelLabel, pluralRu } from '../ui.js';
import { state, subscribe, summaryFor, resultFor, pendingAppeals, allAppeals } from '../store.js';
import { finalAnswers, score, round2 } from '../scoring.js';
import { startEvaluation } from '../jobs.js';
import { setRibbonAction } from '../app.js';

const TARGET = 80; // quality target shown next to the average score
const SVGNS = 'http://www.w3.org/2000/svg';
const MODEL_LABEL = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5' };

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
  const gross = evaluated.filter((r) => summaryFor(r.conversation_id).gross).length;
  const appeals = allAppeals();
  const pending = pendingAppeals().length;
  const resolved = appeals.length - pending;
  const running = state.job?.status === 'running';
  const chats = recs.filter((r) => r.channel !== 'voice call').length;
  const calls = recs.length - chats;

  const evalBtn = () => (pendingIds.length && !running
    ? h('button', { class: 'btn btn-primary btn-lg eval-main', onclick: () => startEvaluation(pendingIds) },
      icon('sparkles', 15), `Оценить ${pendingIds.length} ${pluralRu(pendingIds.length, 'диалог', 'диалога', 'диалогов')}`)
    : null);
  setRibbonAction(evalBtn());

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Обзор качества'),
      h('div', { class: 'sub' }, `Набор ${state.group} · ${recs.length} ${pluralRu(recs.length, 'диалог', 'диалога', 'диалогов')}`)),
    h('div', { class: 'head-actions' }, evalBtn()));

  // ----- telemetry strip -----
  const pct = recs.length ? evaluated.length / recs.length : 0;
  const usage = costInfo(evaluated);
  const strip = h('div', { class: 'card tstrip' },
    cell('Средний балл', h('span', { class: `val ${avg == null ? '' : ''}` }, h('span', { class: `score ${scoreClass(avg)}` }, fmtScore(avg)), h('small', null, '/ 100')),
      avg == null ? 'нет оценок' : h('span', { class: `target ${avg >= TARGET ? 'up' : 'down'}` }, `${avg >= TARGET ? '▲' : '▼'} цель ${TARGET}`)),
    cell('Проверено диалогов', h('span', { class: 'val' }, evaluated.length, h('small', null, `из ${recs.length}`)),
      [progressSvg(pct), h('span', null, `${chats} ${pluralRu(chats, 'чат', 'чата', 'чатов')} · ${calls} ${pluralRu(calls, 'звонок', 'звонка', 'звонков')}`)], { stack: true }),
    cell(['Грубые ошибки', h('span', { class: 'mono' }, '· Крит. 08')], h('span', { class: 'val' }, gross),
      gross ? `${gross} ${pluralRu(gross, 'диалог', 'диалога', 'диалогов')} · нулевая терпимость` : 'не выявлено', { cls: gross ? 'danger' : 'ok', icon: 'shield' }),
    cell('Апелляции', h('span', { class: 'val' }, pending, h('small', null, `/ ${resolved} решено`)),
      pending ? 'ждут решения проверяющего' : 'новых нет', { icon: 'scale' }),
    cell('Расход токенов / Модель', h('span', { class: 'val' }, usage.perDialog != null ? `$${usage.perDialog.toFixed(3)}` : '—', h('small', null, 'за диалог')),
      usage.model ? `${usage.model} · всего $${usage.total.toFixed(2)} · ${fmtTokens(usage.tokens)}` : modelName(), { icon: 'cpu' }));

  if (!evaluated.length) {
    const first5 = pendingIds.slice(0, 5);
    return h('div', { class: 'page' }, head, strip,
      h('div', { class: 'card quickstart', style: { marginTop: '12px' } },
        h('div', { class: 'empty-icon' }, icon('sparkles', 20)),
        h('div', { class: 'qs-text' },
          h('b', null, running ? 'Идёт оценка диалогов' : 'Быстрый старт'),
          h('span', { class: 'muted' }, running ? 'Результаты появятся здесь по мере готовности.' : `Оцените несколько диалогов, чтобы проверить модель, или сразу весь набор. Модель: ${modelName()}.`)),
        !running && h('button', { class: 'btn btn-secondary', onclick: () => startEvaluation(first5) }, icon('sparkles', 15), `Оценить первые ${first5.length}`),
        !running && h('button', { class: 'btn btn-primary', onclick: () => startEvaluation(pendingIds) }, `Оценить все ${pendingIds.length}`)));
  }

  return h('div', { class: 'page' }, head, strip,
    h('div', { class: 'grid two-one', style: { marginTop: '12px' } }, criteriaCard(evaluated), triageCard(evaluated)));
}

function cell(label, value, foot, opts = {}) {
  return h('div', { class: `tcell ${opts.cls || ''}` },
    h('div', { class: 'lbl' }, opts.icon ? icon(opts.icon, 13) : null, label),
    value,
    opts.stack ? foot : h('div', { class: 'foot' }, foot));
}

function progressSvg(p) {
  const w = Math.max(0, Math.min(1, p)) * 100;
  return svg('svg', { class: 'spark', viewBox: '0 0 100 6', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${Math.round(w)}%` },
    svg('rect', { x: 0, y: 0, width: 100, height: 6, rx: 3, fill: '#EEF2F0' }),
    svg('rect', { x: 0, y: 0, width: w, height: 6, rx: 3, fill: '#00A859' }));
}

function modelName() {
  const s = state.settings;
  if (!s) return '—';
  if (s.engine === 'local') return `Локальная · ${s.local?.model || ''}`;
  if (s.engine === 'replay') return 'Replay · без вызова модели';
  return MODEL_LABEL[s.cloud?.model] || s.cloud?.model || 'Claude';
}

function costInfo(evaluated) {
  let total = 0, tokens = 0, n = 0; const models = new Map();
  for (const r of evaluated) {
    const res = resultFor(r.conversation_id);
    const u = res?.usage || {};
    if (res?.engine?.model) models.set(res.engine.model, (models.get(res.engine.model) || 0) + 1);
    if (u.costUsd != null) { total += u.costUsd; n += 1; }
    tokens += (u.inputTokens || 0) + (u.outputTokens || 0);
  }
  const top = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { total, tokens, perDialog: n ? total / n : null, model: top ? (MODEL_LABEL[top] || top) : null };
}

const fmtTokens = (t) => (t >= 1e6 ? `${(t / 1e6).toFixed(1)}M токенов` : t >= 1e3 ? `${Math.round(t / 1e3)}K токенов` : `${t} токенов`);

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
  const W = narrow ? 340 : 560, rowH = 30, labelW = narrow ? 168 : 230, barW = narrow ? 120 : 230, maxName = narrow ? 18 : 30;
  const H = rows.length * rowH + 4;
  const chart = svg('svg', { class: 'cchart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Выполнение критериев' },
    rows.map((a, i) => {
      const y = i * rowH + 4;
      const pct = a.n ? a.sum / a.n : null;
      const color = pct == null ? '#C9D3CD' : pct >= 0.85 ? '#00A859' : pct >= 0.65 ? '#E0A91B' : '#C4314B';
      const name = a.name.length > maxName ? `${a.name.slice(0, maxName - 1)}…` : a.name;
      return svg('g', null,
        svg('text', { class: 'code', x: 0, y: y + 15 }, a.code),
        svg('text', { x: 28, y: y + 15 }, svg('title', null, a.name), name),
        svg('rect', { x: labelW, y: y + 5, width: barW, height: 12, rx: 2, fill: '#EEF2F0' }),
        pct != null ? svg('rect', { x: labelW, y: y + 5, width: Math.max(2, barW * pct), height: 12, rx: 2, fill: color }) : null,
        svg('text', { class: 'pct', x: labelW + barW + 10, y: y + 15 }, pct == null ? '—' : `${Math.round(pct * 100)}%`),
        a.na && !narrow ? svg('text', { class: 'na', x: W - 2, y: y + 15, 'text-anchor': 'end' }, `N/A ${a.na}`) : null);
    }));
  return h('div', { class: 'card card-pad' },
    h('h3', { class: 'card-title' }, 'Выполнение критериев 01–07', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, `по ${evaluated.length} ${pluralRu(evaluated.length, 'диалогу', 'диалогам', 'диалогам')}`)),
    chart,
    h('div', { class: 'legend-inline' },
      h('span', null, h('i', { style: { background: '#00A859' } }), '≥ 85%'),
      h('span', null, h('i', { style: { background: '#E0A91B' } }), '65–84%'),
      h('span', null, h('i', { style: { background: '#C4314B' } }), '< 65%'),
      h('span', null, 'N/A — сколько раз критерий был неприменим')),
    segments(evaluated));
}

function segments(evaluated) {
  const groups = [['RU', (r) => r.channel !== 'voice call' && r.language === 'RU'], ['KZ', (r) => r.channel !== 'voice call' && r.language === 'KZ'],
    ['EN', (r) => r.channel !== 'voice call' && r.language === 'EN'], ['Звонки', (r) => r.channel === 'voice call']];
  return h('div', { class: 'seg-mini' }, groups.map(([label, test]) => {
    const list = evaluated.filter(test).map((r) => summaryFor(r.conversation_id).total).filter((t) => t != null);
    if (!list.length) return null;
    const avg = round2(list.reduce((a, b) => a + b, 0) / list.length);
    return h('span', { class: 'tag outline' }, `${label} ${fmtScore(avg)}`);
  }));
}

function triageCard(evaluated) {
  // Gross errors first, then pending appeals, disputed criteria (failed validation / low confidence), lowest totals.
  const items = evaluated.map((r) => {
    const s = summaryFor(r.conversation_id);
    const res = resultFor(r.conversation_id);
    const fa = finalAnswers(res);
    const flagCrit = res.checklist.criteria.find((c) => c.type === 'flag' && fa[c.id]?.answer === 'yes');
    const disputed = (s.disputed || []).map((id) => res.checklist.criteria.find((c) => c.id === id)).filter(Boolean);
    const kind = s.gross ? 'gross' : s.pending ? 'appeal' : disputed.length ? 'disputed' : 'low';
    const why = kind === 'gross' ? (fa[flagCrit.id]?.explanation || 'Грубая ошибка')
      : kind === 'appeal' ? 'Апелляция ждёт решения'
        : kind === 'disputed' ? `Спорно: ${disputed.map((c) => c.code || c.name).join(', ')}` : 'Низкий итоговый балл';
    return { r, s, kind, why, rank: { gross: 0, appeal: 1, disputed: 2, low: 3 }[kind] * 1000 + (s.total ?? 0) };
  }).sort((a, b) => a.rank - b.rank).slice(0, 8);

  const tagFor = (k) => (k === 'gross' ? h('span', { class: 'tag red' }, icon('shield', 12), '08')
    : k === 'appeal' ? h('span', { class: 'tag amber' }, icon('scale', 12)) : k === 'disputed' ? h('span', { class: 'tag amber' }, icon('alert', 12)) : h('span', { class: 'tag' }, '↓'));

  return h('div', { class: 'card card-pad' },
    h('h3', { class: 'card-title' }, 'Приоритетный разбор', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'грубые ошибки и низкие баллы')),
    h('table', { class: 'triage' }, h('tbody', null, items.map(({ r, s, kind, why }) =>
      h('tr', null,
        h('td', null, tagFor(kind)),
        h('td', null, h('div', { class: 'id' }, r.conversation_id), h('div', { class: 'why', title: why }, why)),
        h('td', null, h('span', { class: 'muted' }, `${channelLabel(r.channel)} · ${r.language}`)),
        h('td', null, h('span', { class: `score ${scoreClass(s.total)}` }, fmtScore(s.total))),
        h('td', null, h('a', { class: 'btn btn-secondary btn-xs', href: `#/dialog/${encodeURIComponent(r.conversation_id)}` }, 'Разбор →')))))));
}
