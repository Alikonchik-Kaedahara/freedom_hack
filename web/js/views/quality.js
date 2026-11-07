// Качество оценки: how the automatic evaluation agrees with people (calibration), with itself (second opinions),
// how often reviewers overturn it (appeals), and the violation patterns of the set.
import { h, icon, toast, fmtDate, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe } from '../store.js';
import { confirmSecondOpinion } from '../jobs.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};

const VALUE = (v) => (v == null ? '—' : v === 'na' ? 'не применим' : v === 'yes' ? 'Да' : v === 'no' ? 'Нет' : String(v));
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
    const head = (sub) => h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Качество оценки'), h('div', { class: 'sub' }, sub)),
      h('div', { class: 'head-actions' }, secondAllButton()));
    if (loading && !data) { page.replaceChildren(head('Загрузка…'), h('div', { class: 'skeleton', style: { height: '180px' } })); return; }
    if (!data) {
      page.replaceChildren(head('Не удалось загрузить данные'), h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('h3', null, 'Данные не загрузились'), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: load }, 'Повторить'))));
      return;
    }
    const c = data.calibration, r = data.reproducibility, a = data.appeals;
    // One line instead of four tiles: the three numbers that say whether the evaluation can be trusted.
    const sub = [
      c.compared ? `совпадение с ручной разметкой ${pct(c.rate)}` : 'ручная разметка не загружена',
      r.dialogs ? `воспроизводимость ${pct(r.rate)}` : 'второе мнение не запрашивалось',
      a.total ? `пересмотрено ${pct(a.overturnRate)} апелляций` : 'апелляций не было',
      `оценено ${data.evaluated} из ${data.records}`,
    ].join(' · ');
    page.replaceChildren(head(sub[0].toUpperCase() + sub.slice(1)),
      h('div', { class: 'grid two-one' }, calibrationCard(c), h('div', { class: 'q-stack' }, reproCard(r), appealsCard(a))),
      h('div', { style: { marginTop: '12px' } }, patternsCard(data.patterns)));
  }

  function secondAllButton() {
    const evaluated = state.records.filter((rec) => state.results[`${state.group}:${rec.conversation_id}`]);
    const without = evaluated.filter((rec) => !state.results[`${state.group}:${rec.conversation_id}`].secondOpinion);
    if (!evaluated.length || state.job?.status === 'running') return null;
    const n = without.length || evaluated.length;
    const ids = (without.length ? without : evaluated).map((rec) => rec.conversation_id);
    return h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => confirmSecondOpinion(ids) },
      without.length ? `Второе мнение для ${n} ${pluralRu(n, 'диалога', 'диалогов', 'диалогов')}` : 'Повторить второе мнение');
  }

  // ----- calibration -----
  function calibrationCard(c) {
    const file = h('input', { type: 'file', accept: '.xlsx,.json', hidden: true });
    const send = async (f) => {
      if (!f) return;
      try {
        const r = await api.uploadCalibration(f);
        toast(`Разметка загружена: ${r.entries} ${pluralRu(r.entries, 'ответ', 'ответа', 'ответов')}`);
        await load();
      } catch (e) { toast(e.message, { type: 'error' }); } finally { file.value = ''; }
    };
    file.addEventListener('change', () => send(file.files?.[0]));
    const template = h('a', { class: 'link-btn', href: 'assets/calibration-template.xlsx', download: 'Калибровка_CQA.xlsx' }, 'Скачать шаблон');
    const drop = h('div', { class: 'drop-zone', role: 'button', tabindex: 0, onclick: () => file.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
      icon('upload', 18),
      h('div', null, h('b', null, c.entries ? 'Загрузить разметку заново' : 'Перетащите файл сюда или нажмите, чтобы выбрать'),
        h('div', { class: 'muted' }, 'Таблица Excel с листом «Разметка»')),
      file);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer?.files?.[0]); });
    const clearBtn = c.entries ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { await api.clearCalibration(); await load(); } }, 'Очистить') : null;

    if (!c.entries) {
      return h('div', { class: 'card card-pad' },
        h('h3', { class: 'card-title q-title' }, 'Совпадение с ручной разметкой', h('span', { class: 'spacer' }), template),
        h('div', { class: 'empty-inline' },
          h('p', null, 'Разметьте выборку диалогов вручную по тому же чек-листу (несколько проверяющих независимо, затем общий итог) и загрузите таблицу. Система сравнит ваши ответы со своими по каждому критерию и покажет, где они расходятся.')),
        drop);
    }
    const langs = h('div', { class: 'seg-mini' }, c.perLanguage.map((l) => h('span', { class: `tag outline q-tag-${tone(l.rate)}` }, `${l.language} ${pct(l.rate)} · ${l.agree}/${l.total}`)));
    const rows = c.perCriterion.map((p) => h('tr', null,
      h('td', { class: 'muted' }, p.code), h('td', null, p.name),
      h('td', { class: 'num' }, `${p.agree} / ${p.total}`),
      h('td', null, bar(p.rate)),
      h('td', { class: 'num' }, p.near ? `${p.near} рядом` : ''),
      h('td', null, p.disagreements.length ? h('details', null, h('summary', null, `${p.disagreements.length} ${pluralRu(p.disagreements.length, 'расхождение', 'расхождения', 'расхождений')}`),
        h('ul', { class: 'dis-list' }, p.disagreements.map((d) => h('li', null,
          h('a', { href: `#/dialog/${encodeURIComponent(d.conversationId)}`, class: 'mono-id' }, d.conversationId),
          ` — вручную: ${VALUE(d.human)}, система: ${VALUE(d.model)}`, d.comment ? h('span', { class: 'muted' }, ` · ${d.comment}`) : null)))) : h('span', { class: 'muted' }, 'совпадает'))));
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Совпадение с ручной разметкой', h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, `${c.source || ''}${c.updatedAt ? ' · ' + fmtDate(c.updatedAt) : ''}`), template, clearBtn),
      h('div', { class: 'q-summary' },
        h('span', { class: `score ${tone(c.rate) === 'ok' ? 'good' : tone(c.rate) === 'part' ? 'mid' : 'bad'}`, style: { fontSize: '26px' } }, pct(c.rate)),
        h('span', { class: 'muted' }, ` точное совпадение по ${c.compared} критериям · ${pct(c.lenientRate)} с учётом соседней ступени шкалы`)),
      langs,
      c.missing.length ? h('div', { class: 'muted', style: { marginTop: '8px' } }, `Есть в разметке, но не оценены системой: ${c.missing.join(', ')}`) : null,
      h('div', { class: 'qtable-wrap', style: { marginTop: '10px' } }, h('table', { class: 'qtable' },
        h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'Критерий'), h('th', null, 'Совпало'), h('th', null, ''), h('th', null, ''), h('th', null, 'Расхождения'))),
        h('tbody', null, rows))),
      h('div', { style: { marginTop: '12px' } }, drop));
  }

  // ----- reproducibility -----
  function reproCard(r) {
    if (!r.dialogs) {
      return h('div', { class: 'card card-pad' },
        h('h3', { class: 'card-title q-title' }, 'Воспроизводимость'),
        h('div', { class: 'empty-inline' },
          h('p', null, 'Второе мнение — повторная независимая оценка диалога. Совпадение ответов показывает, что оценки воспроизводимы, а расхождения уходят проверяющему как спорные критерии.'),
          h('p', { class: 'muted' }, 'Запросите его кнопкой выше или из карточки диалога.')));
    }
    const rows = r.perCriterion.map((p) => h('tr', null,
      h('td', { class: 'muted' }, p.code), h('td', null, p.name),
      h('td', { class: 'num' }, `${p.agree} / ${p.total}`), h('td', null, bar(p.rate)),
      h('td', { class: 'num muted' }, [p.near ? `${p.near} рядом` : null, p.disagree ? `${p.disagree} разошлись` : null].filter(Boolean).join(' · '))));
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Воспроизводимость', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, `${r.dialogs} ${pluralRu(r.dialogs, 'диалог', 'диалога', 'диалогов')} · ${r.criteria} ${pluralRu(r.criteria, 'критерий', 'критерия', 'критериев')}`)),
      h('div', { class: 'q-summary' },
        h('span', { class: `score ${tone(r.rate) === 'ok' ? 'good' : tone(r.rate) === 'part' ? 'mid' : 'bad'}`, style: { fontSize: '26px' } }, pct(r.rate)),
        h('span', { class: 'muted' }, ' ответов совпали при повторной оценке')),
      h('div', { class: 'seg-mini' }, Object.entries(r.perLanguage).map(([l, v]) => h('span', { class: 'tag outline' }, `${l} ${pct(v.rate)}`))),
      h('div', { class: 'qtable-wrap', style: { marginTop: '10px' } }, h('table', { class: 'qtable' }, h('tbody', null, rows))));
  }

  // ----- appeals -----
  function appealsCard(a) {
    if (!a.total) {
      return h('div', { class: 'card card-pad' }, h('h3', { class: 'card-title q-title' }, 'Апелляции по критериям'),
        h('p', { class: 'muted' }, 'Апелляций пока не было. Когда проверяющие начнут менять оценки, здесь будет видно, какие правила система читает не так, как люди.'));
    }
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Апелляции по критериям', h('span', { class: 'spacer' }), h('span', { class: 'hint' }, `${a.total} всего · пересмотрено ${pct(a.overturnRate)}`)),
      h('div', { class: 'qtable-wrap' }, h('table', { class: 'qtable' }, h('tbody', null, a.perCriterion.map((p) => h('tr', null,
        h('td', { class: 'muted' }, p.code), h('td', null, p.name),
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
          h('span', { class: 'muted' }, c.code), h('b', null, c.name),
          h('span', { class: `tag ${c.type === 'flag' ? 'red' : tone(100 - (c.share || 0)) === 'fail' ? 'red' : 'amber'}` },
            c.type === 'flag' ? `${c.flag} ${pluralRu(c.flag, 'диалог', 'диалога', 'диалогов')}` : `${c.failed} не выполнено · ${c.partial} частично · ${pct(c.share)} из применимых`)),
        h('div', { class: 'p-ex' }, c.examples.map((e) => h('div', { class: 'p-quote' },
          h('a', { href: `#/dialog/${encodeURIComponent(e.conversationId)}`, class: 'mono-id' }, e.conversationId),
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
