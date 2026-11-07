// Качество оценки: can the automatic evaluation be trusted? Three plain questions, one number each —
// does it agree with people (manual markup), does it repeat itself (second opinions), how often do
// reviewers overturn it (appeals) — and a ranked list of what operators get wrong most often.
import { h, icon, toast, fmtDate, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe } from '../store.js';
import { confirmSecondOpinion } from '../jobs.js';

const LANG = { RU: 'русский', KZ: 'казахский', EN: 'английский' };
const VALUE = (v) => (v == null ? 'нет ответа' : v === 'na' ? 'не применим' : v === 'yes' ? 'Да' : v === 'no' ? 'Нет' : String(v));
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
const tone = (v) => (v == null ? 'none' : v >= 85 ? 'good' : v >= 65 ? 'mid' : 'bad');
const langName = (code) => LANG[code] || code;
const dialogLink = (cid) => h('a', { href: `#/dialog/${encodeURIComponent(cid)}`, class: 'mono-id' }, cid);
const n = (count, one, few, many) => `${count} ${pluralRu(count, one, few, many)}`;

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
    const head = (sub, action) => h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Качество оценки'), h('div', { class: 'sub' }, sub)),
      h('div', { class: 'head-actions' }, action));
    if (loading && !data) { page.replaceChildren(head('Загрузка…'), h('div', { class: 'skeleton', style: { height: '180px' } })); return; }
    if (!data) {
      page.replaceChildren(head('Не удалось загрузить данные'), h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('h3', null, 'Данные не загрузились'), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: load }, 'Повторить'))));
      return;
    }
    page.replaceChildren(
      head(`Можно ли доверять автоматической оценке: три проверки по ${n(data.evaluated, 'оценённому диалогу', 'оценённым диалогам', 'оценённым диалогам')} набора ${data.group}`, secondAllButton()),
      h('div', { class: 'q-cards' }, peopleCard(data.calibration), repeatCard(data.reproducibility), appealsCard(data.appeals)),
      h('div', { style: { marginTop: '12px' } }, patternsCard(data.patterns)));
  }

  function secondAllButton() {
    const evaluated = state.records.filter((rec) => state.results[`${state.group}:${rec.conversation_id}`]);
    const without = evaluated.filter((rec) => !state.results[`${state.group}:${rec.conversation_id}`].secondOpinion);
    if (!evaluated.length || state.job?.status === 'running') return null;
    const ids = (without.length ? without : evaluated).map((rec) => rec.conversation_id);
    return h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => confirmSecondOpinion(ids) },
      without.length ? `Проверить повтором ${n(without.length, 'диалог', 'диалога', 'диалогов')}` : 'Повторить проверку');
  }

  // A card = question, big number with a verdict word, two or three plain sentences, details on demand.
  function card(question, big, verdict, sentences, more, footer, cls) {
    const t = cls || tone(big);
    return h('div', { class: 'card card-pad q-card' },
      h('h3', { class: 'q-question' }, question),
      big == null ? null : h('div', { class: 'q-big' }, h('span', { class: `score ${t}` }, pct(big)), verdict ? h('span', { class: `q-verdict ${t}` }, verdict) : null),
      h('div', { class: 'q-text' }, sentences.filter(Boolean).map((s) => h('p', null, s))),
      more,
      footer ? h('div', { class: 'q-foot' }, footer) : null);
  }

  // ----- 1. agreement with people -----
  function peopleCard(c) {
    const file = h('input', { type: 'file', accept: '.xlsx,.json', hidden: true });
    const send = async (f) => {
      if (!f) return;
      try {
        const r = await api.uploadCalibration(f);
        toast(`Разметка загружена: ${n(r.entries, 'ответ', 'ответа', 'ответов')}`);
        await load();
      } catch (e) { toast(e.message, { type: 'error' }); } finally { file.value = ''; }
    };
    file.addEventListener('change', () => send(file.files?.[0]));
    const template = h('a', { class: 'link-btn', href: 'assets/calibration-template.xlsx', download: 'Калибровка_CQA.xlsx' }, 'Скачать шаблон таблицы');
    const drop = h('div', { class: 'drop-zone', role: 'button', tabindex: 0, onclick: () => file.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
      icon('upload', 18),
      h('div', null, h('b', null, c.entries ? 'Загрузить другую разметку' : 'Загрузить заполненную таблицу'),
        h('div', { class: 'muted' }, 'Excel с листом «Разметка» — перетащите сюда или нажмите')),
      file);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer?.files?.[0]); });

    if (!c.entries) {
      return card('Совпадает ли с оценкой людей?', null, null, [
        'Пока неизвестно: ручной разметки ещё нет.',
        'Как проверить: двое-трое проверяющих независимо оценивают 10–12 диалогов по тому же чек-листу, сводят общий ответ по каждому критерию и загружают таблицу. Система сравнит их ответы со своими.',
      ], null, [drop, template]);
    }
    const dialogs = new Set(c.rows.map((r) => r.conversationId)).size;
    const mism = c.compared - c.agree;
    const problem = c.perCriterion.filter((p) => p.disagreements.length).sort((a, b) => b.disagreements.length - a.disagreements.length);
    const details = mism ? h('details', { class: 'q-more' },
      h('summary', null, `Где разошлись — ${n(mism, 'ответ', 'ответа', 'ответов')}`),
      h('div', { class: 'q-list' }, problem.map((p) => h('div', { class: 'q-item' },
        h('div', { class: 'q-item-head' }, h('b', null, `${p.code} ${p.name}`), h('span', { class: 'muted' }, ` — ${n(p.disagreements.length, 'расхождение', 'расхождения', 'расхождений')} из ${p.total}`)),
        h('ul', null, p.disagreements.map((d) => h('li', null,
          dialogLink(d.conversationId), `: проверяющие — ${VALUE(d.human)}, система — ${VALUE(d.model)}`,
          d.comment ? h('span', { class: 'muted' }, ` · ${d.comment}`) : null))))))) : null;
    const worst = problem[0];
    return card('Совпадает ли с оценкой людей?', c.rate, verdictWord(c.rate), [
      `Проверяющие вручную оценили ${n(dialogs, 'диалог', 'диалога', 'диалогов')} — это ${n(c.compared, 'ответ', 'ответа', 'ответов')} по критериям. Система ответила так же в ${c.agree} из них.`,
      c.near ? `Ещё ${n(c.near, 'ответ отличается', 'ответа отличаются', 'ответов отличаются')} на одну ступень шкалы (например, 15 вместо 20) — это считается расхождением.` : null,
      c.perLanguage.length > 1 ? `По языкам: ${c.perLanguage.map((l) => `${langName(l.language)} ${pct(l.rate)}`).join(', ')}.` : null,
      worst && worst.disagreements.length >= 2 ? `Чаще всего расходится критерий ${worst.code} «${worst.name}» — значит, его правило люди и система читают по-разному: уточните формулировку в чек-листе.` : null,
      c.missing.length ? `В разметке есть диалоги, которые система ещё не оценила: ${c.missing.join(', ')}.` : null,
    ], details, [drop, h('span', { class: 'muted small' }, `Разметка загружена ${fmtDate(c.updatedAt)}`), template,
      h('button', { class: 'link-btn', type: 'button', onclick: async () => { await api.clearCalibration(); await load(); } }, 'Удалить разметку')]);
  }

  // ----- 2. repeatability -----
  function repeatCard(r) {
    if (!r.dialogs) {
      return card('Повторяется ли оценка?', null, null, [
        'Пока неизвестно: повторных проверок ещё не было.',
        'Как проверить: нажмите «Проверить повтором» — система оценит те же диалоги второй раз и сравнит ответы. Расхождения попадут к проверяющему как спорные.',
      ]);
    }
    const mism = r.criteria - Math.round(r.rate / 100 * r.criteria);
    const byCode = disagreementsByCriterion();
    const problem = r.perCriterion.filter((p) => p.disagree + p.near > 0).sort((a, b) => (b.disagree + b.near) - (a.disagree + a.near));
    const details = problem.length ? h('details', { class: 'q-more' },
      h('summary', null, `Где ответы разошлись — ${n(mism, 'ответ', 'ответа', 'ответов')}`),
      h('div', { class: 'q-list' }, problem.map((p) => h('div', { class: 'q-item' },
        h('div', { class: 'q-item-head' }, h('b', null, `${p.code} ${p.name}`), h('span', { class: 'muted' }, ` — ${n(p.disagree + p.near, 'диалог', 'диалога', 'диалогов')} из ${p.total}`)),
        (byCode[p.code] || []).length ? h('div', { class: 'q-links' }, (byCode[p.code] || []).map((cid) => dialogLink(cid))) : null)))) : null;
    const worst = problem[0];
    return card('Повторяется ли оценка?', r.rate, verdictWord(r.rate), [
      `${n(r.dialogs, 'диалог оценён', 'диалога оценены', 'диалогов оценены')} дважды — это ${n(r.criteria, 'ответ', 'ответа', 'ответов')}. Совпали ${r.criteria - mism}.`,
      r.otherEngine ? `В ${n(r.otherEngine, 'диалоге', 'диалогах', 'диалогах')} вторую оценку давала другая модель, в ${r.sameEngine} — та же.` : null,
      mism ? 'Разошедшиеся ответы помечены в карточках диалогов как спорные — их смотрит проверяющий.' : 'Все повторные ответы совпали с первыми.',
      worst && worst.disagree + worst.near >= 2 ? `Нестабильнее всего критерий ${worst.code} «${worst.name}».` : null,
    ], details);
  }

  // Which dialogs disagree on which criterion — from the results in memory (the server gives only counts).
  function disagreementsByCriterion() {
    const out = {};
    for (const rec of state.records) {
      const res = state.results[`${state.group}:${rec.conversation_id}`];
      const details = res?.secondOpinion?.comparison?.details;
      if (!details) continue;
      for (const c of res.checklist.criteria) {
        const d = details[c.id];
        if (d && d.status !== 'agree') (out[c.code || c.id] ||= []).push(rec.conversation_id);
      }
    }
    return out;
  }

  // ----- 3. appeals -----
  function appealsCard(a) {
    if (!a.total) {
      return card('Как часто оценку пересматривают?', null, null, [
        'Пока неизвестно: апелляций ещё не было.',
        'Апелляцию подают из карточки диалога, у критерия. Когда проверяющие начнут менять оценки, здесь будет видно, по каким правилам система ошибается чаще.',
      ]);
    }
    const decided = a.accepted + a.rejected;
    const problem = a.perCriterion.filter((p) => p.accepted).sort((x, y) => y.accepted - x.accepted);
    const details = h('details', { class: 'q-more' },
      h('summary', null, 'По критериям'),
      h('div', { class: 'q-list' }, a.perCriterion.map((p) => h('div', { class: 'q-item' },
        h('div', { class: 'q-item-head' }, h('b', null, `${p.code} ${p.name}`),
          h('span', { class: 'muted' }, ` — ${n(p.total, 'апелляция', 'апелляции', 'апелляций')}: принято ${p.accepted}, отклонено ${p.rejected}${p.pending ? `, ждут ${p.pending}` : ''}`))))));
    return card('Как часто оценку пересматривают?', decided ? a.overturnRate : null, decided ? overturnWord(a.overturnRate) : null, [
      `Подано ${n(a.total, 'апелляция', 'апелляции', 'апелляций')}: ${n(a.accepted, 'принята', 'приняты', 'принято')} — оценка изменена, ${n(a.rejected, 'отклонена', 'отклонены', 'отклонено')}${a.pending ? `, ${n(a.pending, 'ждёт', 'ждут', 'ждут')} решения` : ''}.`,
      decided ? `Из рассмотренных пересмотрено ${pct(a.overturnRate)}.` : 'Решений пока нет — процент появится после первого.',
      problem.length && problem[0].accepted >= 2 ? `Чаще всего меняют оценку по критерию ${problem[0].code} «${problem[0].name}» — стоит уточнить его правило.` : null,
    ], details, null, decided ? (a.overturnRate <= 15 ? 'good' : a.overturnRate <= 40 ? 'mid' : 'bad') : 'none');
  }

  // ----- what operators get wrong -----
  function patternsCard(p) {
    const list = p.criteria.filter((c) => (c.type === 'flag' ? c.flag : c.failed + c.partial) > 0);
    const rows = list.map((c) => {
      const [first, ...rest] = c.examples;
      const count = c.type === 'flag' ? c.flag : c.failed + c.partial;
      const text = c.type === 'flag'
        ? `грубая ошибка в ${n(c.flag, 'диалоге', 'диалогах', 'диалогах')} из ${p.dialogs}`
        : `${c.failed ? `не выполнено в ${c.failed}` : ''}${c.failed && c.partial ? ', ' : ''}${c.partial ? `частично в ${c.partial}` : ''} из ${n(c.applicable, 'диалога', 'диалогов', 'диалогов')}, где критерий применим`;
      const more = rest.length ? h('details', { class: 'q-more inline' }, h('summary', null, `ещё ${n(rest.length, 'пример', 'примера', 'примеров')}`),
        rest.map((e) => example(e))) : null;
      return h('div', { class: 'q-rank-row' },
        h('div', { class: 'q-rank-main' },
          h('div', { class: 'q-rank-title' }, h('span', { class: 'muted' }, c.code), h('b', null, c.name),
            h('span', { class: `tag ${c.type === 'flag' || (c.share || 0) >= 50 ? 'red' : 'amber'}` }, c.type === 'flag' ? pct(c.share) : `${pct(c.share)}`)),
          h('div', { class: 'muted' }, text[0].toUpperCase() + text.slice(1) + '.')),
        h('div', { class: 'q-rank-ex' }, first ? example(first) : h('span', { class: 'muted' }, 'без примеров'), more));
    });
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title q-title' }, 'Что операторы нарушают чаще всего', h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, `по ${n(p.dialogs, 'оценённому диалогу', 'оценённым диалогам', 'оценённым диалогам')} · от частого к редкому`)),
      !list.length ? h('p', { class: 'muted' }, 'Нарушений нет.') : h('div', { class: 'q-rank' }, rows));
  }

  function example(e) {
    return h('div', { class: 'p-quote' },
      dialogLink(e.conversationId), e.turn ? h('span', { class: 'muted' }, ` · реплика ${e.turn}`) : null,
      e.quote ? h('q', null, e.quote) : null,
      h('div', { class: 'muted' }, e.explanation));
  }

  load();
  return subscribe((w) => { if (w === 'results' || (w === 'job' && !state.job)) load(); else if (w === 'job') draw(); });
}

function verdictWord(rate) {
  if (rate == null) return '';
  return rate >= 85 ? 'хорошо' : rate >= 65 ? 'есть расхождения' : 'низкое совпадение';
}

function overturnWord(rate) {
  if (rate == null) return '';
  return rate <= 15 ? 'редко' : rate <= 40 ? 'иногда' : 'часто';
}
