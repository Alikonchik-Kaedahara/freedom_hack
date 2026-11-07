// Качество оценки: how the model agrees with people (calibration), with itself (second opinions),
// how often reviewers overturn it (appeals), and the violation patterns of the set.
import { h, icon, toast, fmtDate, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe } from '../store.js';
import { startSecondOpinion } from '../jobs.js';
import { setRibbonAction } from '../app.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};

const VALUE = (v) => (v == null ? '—' : v === 'na' ? 'N/A' : v === 'yes' ? 'Да' : v === 'no' ? 'Нет' : String(v));
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
const tone = (v) => (v == null ? 'none' : v >= 85 ? 'ok' : v >= 65 ? 'part' : 'fail');

export function renderQuality(root) {
  const page = h('div', { class: 'page' });
  root.append(page);
  let data = null;
  let loading = true;

  async function load() {
    loading = true;
    draw();
    try { data = await api.quality(state.group); } catch (e) { toast(e.message, { type: 'error' }); data = null; }
    loading = false;
    draw();
  }

  function draw() {
    setRibbonAction(null);
    const head = h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Качество оценки'),
        h('div', { class: 'sub' }, 'Насколько автоматическая оценка совпадает с ручной, воспроизводится при повторе и как часто её пересматривают проверяющие')),
      h('div', { class: 'head-actions' }, secondAllButton()));
    if (loading && !data) { page.replaceChildren(head, h('div', { class: 'skeleton', style: { height: '180px' } })); return; }
    if (!data) { page.replaceChildren(head, h('div', { class: 'card card-pad muted' }, 'Нет данных')); return; }
    const c = data.calibration, r = data.reproducibility, a = data.appeals;
    const strip = h('div', { class: 'card tstrip tstrip-4' },
      cell('Совпадение с ручной разметкой', c.rate, c.compared ? `${c.agree} из ${c.compared} критериев · ${c.near} рядом` : 'разметка не загружена', 'checks'),
      cell('Воспроизводимость', r.rate, r.dialogs ? `${r.dialogs} ${pluralRu(r.dialogs, 'диалог', 'диалога', 'диалогов')} со вторым мнением · та же модель ${r.sameEngine}, другая ${r.otherEngine}` : 'второе мнение ещё не запрашивалось', 'refresh'),
      cell('Оценка пересмотрена', a.overturnRate, a.total ? `${a.accepted} принято · ${a.rejected} отклонено · ${a.pending} ждут` : 'апелляций не было', 'scale'),
      cell('Оценено', null, `${data.evaluated} из ${data.records} ${pluralRu(data.records, 'диалога', 'диалогов', 'диалогов')}`, 'list', data.evaluated));
    page.replaceChildren(head, strip,
      h('div', { class: 'grid two-one', style: { marginTop: '12px' } }, calibrationCard(c), h('div', { class: 'q-stack' }, reproCard(r), appealsCard(a))),
      h('div', { style: { marginTop: '12px' } }, patternsCard(data.patterns)));
  }

  function cell(label, rate, foot, ic, raw) {
    const val = raw != null ? h('span', { class: 'val' }, raw) : h('span', { class: `val q-${tone(rate)}` }, rate == null ? '—' : `${Math.round(rate)}`, rate == null ? null : h('small', null, '%'));
    return h('div', { class: 'tcell' }, h('div', { class: 'lbl' }, icon(ic, 13), label), val, h('div', { class: 'foot' }, foot));
  }

  function secondAllButton() {
    const evaluated = state.records.filter((rec) => state.results[`${state.group}:${rec.conversation_id}`]);
    const without = evaluated.filter((rec) => !state.results[`${state.group}:${rec.conversation_id}`].secondOpinion);
    if (!evaluated.length || state.job?.status === 'running') return null;
    const n = without.length || evaluated.length;
    const ids = (without.length ? without : evaluated).map((rec) => rec.conversation_id);
    return h('button', { class: 'btn btn-secondary btn-lg', title: 'Повторная оценка той же моделью для проверки воспроизводимости', onclick: () => startSecondOpinion(ids) },
      icon('refresh', 15), without.length ? `Второе мнение для ${n} ${pluralRu(n, 'диалога', 'диалогов', 'диалогов')}` : 'Повторить второе мнение');
  }

  // ----- calibration -----
  function calibrationCard(c) {
    const file = h('input', { type: 'file', accept: '.xlsx,.json', style: { display: 'none' } });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const r = await api.uploadCalibration(f);
        toast(`Разметка загружена: ${r.entries} ${pluralRu(r.entries, 'ответ', 'ответа', 'ответов')}`);
        await load();
      } catch (e) { toast(e.message, { type: 'error' }); } finally { file.value = ''; }
    });
    const upload = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => file.click() }, icon('upload', 14), c.entries ? 'Загрузить заново' : 'Загрузить разметку');
    const clearBtn = c.entries ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { await api.clearCalibration(); await load(); } }, 'Очистить') : null;

    if (!c.entries) {
      return h('div', { class: 'card card-pad' },
        h('h3', { class: 'card-title q-title' }, 'Совпадение с ручной разметкой', h('span', { class: 'spacer' }), upload, file),
        h('div', { class: 'empty-inline' },
          h('p', null, 'Разметьте выборку диалогов вручную по тому же чек-листу — несколько проверяющих независимо, затем общий итог — и загрузите таблицу. Система сравнит ваши ответы с оценкой модели по каждому критерию и покажет, где они расходятся.'),
          h('p', { class: 'muted' }, 'Принимается таблица Excel с листом «Разметка» и столбцом «Итог (консенсус)» либо JSON со списком entries: conversationId, criterionCode, value.')));
    }
    const langs = h('div', { class: 'seg-mini' }, c.perLanguage.map((l) => h('span', { class: `tag outline q-tag-${tone(l.rate)}` }, `${l.language} ${pct(l.rate)} · ${l.agree}/${l.total}`)));
    const rows = c.perCriterion.map((p) => h('tr', null,
      h('td', { class: 'mono' }, p.code), h('td', null, p.name),
      h('td', { class: 'num' }, `${p.agree} / ${p.total}`),
      h('td', null, bar(p.rate)),
      h('td', { class: 'num' }, p.near ? `${p.near} рядом` : ''),
      h('td', null, p.disagreements.length ? h('details', null, h('summary', null, `${p.disagreements.length} ${pluralRu(p.disagreements.length, 'расхождение', 'расхождения', 'расхождений')}`),
        h('ul', { class: 'dis-list' }, p.disagreements.map((d) => h('li', null,
          h('a', { href: `#/dialog/${encodeURIComponent(d.conversationId)}`, class: 'mono' }, d.conversationId),
          ` — мы: ${VALUE(d.human)}, модель: ${VALUE(d.model)}`, d.comment ? h('span', { class: 'muted' }, ` · ${d.comment}`) : null)))) : h('span', { class: 'muted' }, 'совпадает'))));
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Совпадение с ручной разметкой', h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, `${c.source || ''}${c.updatedAt ? ' · ' + fmtDate(c.updatedAt) : ''}`), upload, clearBtn, file),
      h('div', { class: 'q-summary' },
        h('span', { class: `score ${tone(c.rate) === 'ok' ? 'good' : tone(c.rate) === 'part' ? 'mid' : 'bad'}`, style: { fontSize: '26px' } }, pct(c.rate)),
        h('span', { class: 'muted' }, ` точное совпадение по ${c.compared} критериям · ${pct(c.lenientRate)} с учётом соседней ступени шкалы`)),
      langs,
      c.missing.length ? h('div', { class: 'muted', style: { marginTop: '8px' } }, `Не оценены моделью (пропущены): ${c.missing.join(', ')}`) : null,
      h('div', { class: 'qtable-wrap', style: { marginTop: '10px' } }, h('table', { class: 'qtable' },
        h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'Критерий'), h('th', null, 'Совпало'), h('th', null, ''), h('th', null, ''), h('th', null, 'Расхождения'))),
        h('tbody', null, rows))));
  }

  // ----- reproducibility -----
  function reproCard(r) {
    if (!r.dialogs) {
      return h('div', { class: 'card card-pad' },
        h('h3', { class: 'card-title q-title' }, 'Воспроизводимость'),
        h('div', { class: 'empty-inline' },
          h('p', null, 'Второе мнение — повторная оценка диалога той же или другой моделью. Совпадение вердиктов показывает, что оценки воспроизводимы, а расхождения уходят проверяющему как спорные критерии.'),
          h('p', { class: 'muted' }, 'Запросите его кнопкой выше или из карточки диалога.')));
    }
    const rows = r.perCriterion.map((p) => h('tr', null,
      h('td', { class: 'mono' }, p.code), h('td', null, p.name),
      h('td', { class: 'num' }, `${p.agree} / ${p.total}`), h('td', null, bar(p.rate)),
      h('td', { class: 'num muted' }, [p.near ? `${p.near} рядом` : null, p.disagree ? `${p.disagree} разошлись` : null].filter(Boolean).join(' · '))));
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Воспроизводимость', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, `${r.dialogs} ${pluralRu(r.dialogs, 'диалог', 'диалога', 'диалогов')} · ${r.criteria} ${pluralRu(r.criteria, 'критерий', 'критерия', 'критериев')}`)),
      h('div', { class: 'q-summary' },
        h('span', { class: `score ${tone(r.rate) === 'ok' ? 'good' : tone(r.rate) === 'part' ? 'mid' : 'bad'}`, style: { fontSize: '26px' } }, pct(r.rate)),
        h('span', { class: 'muted' }, ' вердиктов совпали при повторной оценке')),
      h('div', { class: 'seg-mini' }, Object.entries(r.perLanguage).map(([l, v]) => h('span', { class: 'tag outline' }, `${l} ${pct(v.rate)}`))),
      h('div', { class: 'qtable-wrap', style: { marginTop: '10px' } }, h('table', { class: 'qtable' }, h('tbody', null, rows))));
  }

  // ----- appeals -----
  function appealsCard(a) {
    if (!a.total) {
      return h('div', { class: 'card card-pad' }, h('h3', { class: 'card-title q-title' }, 'Апелляции по критериям'),
        h('p', { class: 'muted' }, 'Апелляций пока не было. Когда проверяющие начнут менять оценки, здесь будет видно, какие правила модель применяет не так, как люди.'));
    }
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Апелляции по критериям', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, `${a.total} всего · пересмотрено ${pct(a.overturnRate)}`)),
      h('div', { class: 'qtable-wrap' }, h('table', { class: 'qtable' }, h('tbody', null, a.perCriterion.map((p) => h('tr', null,
        h('td', { class: 'mono' }, p.code), h('td', null, p.name),
        h('td', { class: 'num' }, `${p.accepted} / ${p.total}`),
        h('td', null, p.overturnRate != null ? bar(p.overturnRate, 'warn') : h('span', { class: 'muted' }, 'ждут'))))))));
  }

  // ----- violation patterns -----
  function patternsCard(p) {
    const list = p.criteria.filter((c) => (c.type === 'flag' ? c.flag : c.failed + c.partial) > 0);
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Типичные нарушения набора', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, `по ${p.dialogs} ${pluralRu(p.dialogs, 'диалогу', 'диалогам', 'диалогам')}`)),
      !list.length ? h('p', { class: 'muted' }, 'Нарушений нет') : h('div', { class: 'patterns' }, list.map((c) => h('div', { class: 'pattern' },
        h('div', { class: 'p-head' },
          h('span', { class: 'mono' }, c.code), h('b', null, c.name),
          h('span', { class: `tag ${c.type === 'flag' ? 'red' : tone(100 - (c.share || 0)) === 'fail' ? 'red' : 'amber'}` },
            c.type === 'flag' ? `${c.flag} ${pluralRu(c.flag, 'диалог', 'диалога', 'диалогов')}` : `${c.failed} не выполнено · ${c.partial} частично · ${pct(c.share)} из применимых`)),
        h('div', { class: 'p-ex' }, c.examples.map((e) => h('div', { class: 'p-quote' },
          h('a', { href: `#/dialog/${encodeURIComponent(e.conversationId)}`, class: 'mono' }, e.conversationId),
          e.turn ? h('span', { class: 'muted' }, ` · реплика ${e.turn}`) : null,
          e.quote ? h('q', null, e.quote) : null,
          h('div', { class: 'muted' }, e.explanation))))))));
  }

  function bar(v, kind = '') {
    const w = Math.max(0, Math.min(100, v || 0));
    const t = kind === 'warn' ? 'part' : tone(v);
    return svg('svg', { class: 'qbar', viewBox: '0 0 100 8', preserveAspectRatio: 'none', role: 'img', 'aria-label': pct(v) },
      svg('rect', { class: 'trk', x: 0, y: 0, width: 100, height: 8, rx: 2 }),
      svg('rect', { class: t, x: 0, y: 0, width: w, height: 8, rx: 2 }));
  }

  load();
  return subscribe((w) => { if (w === 'results' || (w === 'job' && !state.job)) load(); else if (w === 'job') draw(); });
}
