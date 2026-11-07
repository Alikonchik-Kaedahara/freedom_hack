// Screen 2: quality overview.
import { h, icon, fmtScore, scoreClass, channelIcon, channelLabel, pluralRu } from '../ui.js';
import { state, subscribe, summaryFor, resultFor, pendingAppeals } from '../store.js';
import { finalAnswers, score, round2 } from '../scoring.js';
import { startEvaluation } from '../jobs.js';

export function renderDashboard(root) {
  const draw = () => {
    root.replaceChildren(build());
  };
  draw();
  const off = subscribe((w) => { if (w === 'results' || w === 'job') draw(); });
  return off;
}

function build() {
  const recs = state.records;
  const evaluated = recs.filter((r) => summaryFor(r.conversation_id));
  const pendingIds = recs.filter((r) => !summaryFor(r.conversation_id)).map((r) => r.conversation_id);
  const totals = evaluated.map((r) => summaryFor(r.conversation_id).total).filter((t) => t != null);
  const avg = totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
  const gross = evaluated.filter((r) => summaryFor(r.conversation_id).gross).length;
  const appeals = pendingAppeals().length;
  const disputed = evaluated.reduce((n, r) => n + (summaryFor(r.conversation_id).disputed?.length || 0), 0);
  const running = state.job?.status === 'running';

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Обзор качества')),
    h('div', { class: 'head-actions' },
      pendingIds.length && !running
        ? h('button', { class: 'btn btn-primary btn-lg', onclick: () => startEvaluation(pendingIds) },
          icon('sparkles', 18), `Оценить ${pendingIds.length} ${pluralRu(pendingIds.length, 'диалог', 'диалога', 'диалогов')}`)
        : null));

  const pct = recs.length ? Math.round((evaluated.length / recs.length) * 100) : 0;
  const kpis = h('div', { class: 'grid kpis' },
    kpi('Средний балл', h('span', { class: `score ${avg == null ? 'none' : ''}` }, fmtScore(avg), avg != null ? h('small', null, '/ 100') : null)),
    kpi('Проверено', h('span', null, evaluated.length, h('small', null, `из ${recs.length}`)),
      h('div', { class: 'bar thin' }, h('i', { style: { width: `${pct}%` } })),
      pct === 100 ? h('span', { class: 'corner', style: { color: 'var(--green)' } }, icon('check', 22, 2.5)) : null),
    kpi('Грубые ошибки', gross, null, gross ? h('span', { class: 'corner', style: { color: 'var(--red)' } }, icon('alert', 22)) : null, gross ? 'danger' : ''),
    kpi('Апелляции', appeals, h('span', { class: 'kpi-label', style: { fontSize: '13px' } },
      [appeals ? 'ждут решения' : 'нет новых', disputed ? `спорных критериев: ${disputed}` : null].filter(Boolean).join(' · ')),
    disputed ? h('span', { class: 'corner', style: { color: 'var(--amber)' } }, icon('alert', 22)) : null));

  if (!evaluated.length) {
    return h('div', { class: 'page' }, head, kpis,
      h('div', { class: 'card', style: { marginTop: '20px' } },
        h('div', { class: 'empty' },
          h('div', { class: 'empty-icon' }, icon('sparkles', 30)),
          h('h3', null, running ? 'Идёт оценка диалогов' : 'Диалоги загружены'),
          h('p', null, running ? 'Результаты появятся здесь по мере готовности.' : 'Запустите оценку, чтобы увидеть средний балл, ошибки и слабые места.'),
          !running && h('button', { class: 'btn btn-primary btn-lg', onclick: () => startEvaluation(pendingIds) }, icon('sparkles', 18), 'Оценить все диалоги'))));
  }

  return h('div', { class: 'page' }, head, kpis,
    h('div', { class: 'grid two-one', style: { marginTop: '20px' } },
      criteriaCard(evaluated), segmentsCard(evaluated)),
    attentionCard(evaluated));
}

function kpi(label, value, foot, corner, cls = '') {
  return h('div', { class: `card kpi ${cls}` },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value),
    foot ? h('div', { class: 'kpi-foot' }, foot) : null,
    corner);
}

function criteriaCard(evaluated) {
  // Aggregate by criterion id across all evaluated dialogs (chats and calls).
  const agg = new Map();
  for (const r of evaluated) {
    const res = resultFor(r.conversation_id);
    const sc = score(res.checklist, finalAnswers(res));
    for (const c of res.checklist.criteria) {
      if (c.type === 'flag') continue;
      const p = sc.per[c.id];
      const a = agg.get(c.id) || { code: c.code, name: c.name, sum: 0, n: 0, na: 0, channel: r.channel };
      if (r.channel !== 'voice call') { a.name = c.name; a.code = c.code; }
      if (p.ratio != null) { a.sum += p.ratio; a.n += 1; } else a.na += 1;
      agg.set(c.id, a);
    }
  }
  const rows = [...agg.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return h('div', { class: 'card card-pad' },
    h('h3', { class: 'card-title' }, 'Выполнение критериев'),
    h('div', { class: 'crit-bars' }, rows.map((a) => {
      const pct = a.n ? Math.round((a.sum / a.n) * 100) : null;
      const cls = pct == null ? '' : pct >= 85 ? '' : pct >= 65 ? 'amber' : 'red';
      return h('div', { class: 'crit-bar' },
        h('span', { class: 'code' }, a.code),
        h('div', null,
          h('div', { class: 'name' }, a.name, a.na ? h('small', null, `N/A: ${a.na}`) : null),
          h('div', { class: `bar ${cls}` }, h('i', { style: { width: `${pct ?? 0}%` } }))),
        h('span', { class: 'pct' }, pct == null ? '—' : `${pct}%`));
    })));
}

function segmentsCard(evaluated) {
  const groups = [
    { key: 'RU', label: 'RU', test: (r) => r.channel !== 'voice call' && r.language === 'RU' },
    { key: 'KZ', label: 'KZ', test: (r) => r.channel !== 'voice call' && r.language === 'KZ' },
    { key: 'EN', label: 'EN', test: (r) => r.channel !== 'voice call' && r.language === 'EN' },
    { key: 'calls', label: null, icon: 'phone', test: (r) => r.channel === 'voice call' },
  ];
  return h('div', { class: 'card card-pad' },
    h('h3', { class: 'card-title' }, 'По языкам и каналам'),
    h('div', { class: 'seg-rows' }, groups.map((g) => {
      const list = evaluated.filter(g.test).map((r) => summaryFor(r.conversation_id).total).filter((t) => t != null);
      const avg = list.length ? round2(list.reduce((a, b) => a + b, 0) / list.length) : null;
      return h('div', { class: 'seg-row' },
        h('span', { class: 'lbl' }, g.icon ? icon(g.icon, 18) : g.label),
        h('div', null,
          h('div', { style: { fontWeight: 600 } }, g.icon ? 'Звонки' : 'Чаты'),
          h('div', { class: 'count' }, `${list.length} ${pluralRu(list.length, 'диалог', 'диалога', 'диалогов')}`)),
        h('span', { class: `score val ${scoreClass(avg)}` }, fmtScore(avg)));
    })));
}

// Dialogs the reviewer should open first: gross errors, pending appeals, disputed criteria
// (the model's answer failed validation or has low confidence — see cqa/evaluator.py), low totals.
function attentionCard(evaluated) {
  const items = evaluated.map((r) => {
    const s = summaryFor(r.conversation_id);
    const res = resultFor(r.conversation_id);
    const flagCrit = res.checklist.criteria.find((c) => c.type === 'flag' && finalAnswers(res)[c.id]?.answer === 'yes');
    const disputed = (s.disputed || []).map((id) => res.checklist.criteria.find((c) => c.id === id)).filter(Boolean);
    const kind = s.gross ? 'gross' : s.pending ? 'appeal' : disputed.length ? 'disputed' : 'low';
    return { r, s, flagCrit, disputed, kind, rank: { gross: 0, appeal: 1, disputed: 2, low: 3 }[kind] * 1000 + (s.total ?? 0) };
  }).filter((x) => x.s.gross || x.s.pending || x.disputed.length || (x.s.total != null && x.s.total < 65))
    .sort((a, b) => a.rank - b.rank).slice(0, 8);

  if (!items.length) return null;
  return h('div', { class: 'card card-pad', style: { marginTop: '20px' } },
    h('h3', { class: 'card-title' }, 'Требуют внимания'),
    h('div', { class: 'attention' }, items.map(({ r, s, flagCrit, disputed, kind }) => {
      const res = resultFor(r.conversation_id);
      const sub = kind === 'gross' ? (finalAnswers(res)[flagCrit.id]?.explanation || 'Грубая ошибка')
        : kind === 'appeal' ? 'Апелляция ждёт решения'
          : kind === 'disputed' ? `Спорные критерии: ${disputed.map((c) => c.code || c.name).join(', ')} — проверьте вручную`
            : 'Низкий итоговый балл';
      const tag = kind === 'gross' ? h('span', { class: 'tag red' }, icon('flag', 14), 'Критично')
        : kind === 'appeal' ? h('span', { class: 'tag amber' }, 'Апелляция')
          : kind === 'disputed' ? h('span', { class: 'tag amber' }, icon('alert', 14), 'Спорно') : h('span');
      return h('div', { class: 'att-row', onclick: () => (location.hash = `#/dialog/${encodeURIComponent(r.conversation_id)}`) },
        h('div', { class: `att-icon ${s.gross ? 'red' : ''}` }, icon(kind === 'gross' ? 'shield' : kind === 'appeal' ? 'scale' : kind === 'disputed' ? 'alert' : channelIcon(r.channel), 20)),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'title' }, r.conversation_id, h('span', { style: { color: 'var(--muted)', fontWeight: 500 } }, ` · ${channelLabel(r.channel)} · ${r.language}`)),
          h('div', { class: 'sub' }, sub)),
        tag,
        h('span', { class: `score ${scoreClass(s.total)}` }, fmtScore(s.total)));
    })));
}
