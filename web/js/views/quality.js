// Model verification in Settings: compare the original answers with people and with a second evaluation.
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

export function renderVerification(root) {
  const page = h('div', { class: 'page' });
  root.append(page);
  let data = null;
  let loading = true;
  let sequence = 0;
  if (!state.group) {
    page.append(h('h2', null, 'Проверка модели'), h('p', { class: 'muted' }, 'Для проверки загрузите набор диалогов.'));
    return;
  }

  async function load() {
    const request = ++sequence;
    loading = true;
    draw();
    try {
      const latest = await api.quality(state.group, 'model');
      if (request !== sequence) return;
      data = latest;
    } catch (e) {
      if (request !== sequence) return;
      toast(e.message, { type: 'error' }); data = null;
    }
    loading = false;
    draw();
  }

  function draw() {
    const head = (sub, action) => h('div', { class: 'page-head' },
      h('div', null, h('h2', null, 'Проверка модели'), h('div', { class: 'sub' }, sub)),
      h('div', { class: 'head-actions' }, action));
    if (loading && !data) { page.replaceChildren(head('Загрузка…'), h('div', { class: 'skeleton', style: { height: '180px' } })); return; }
    if (!data) {
      page.replaceChildren(head('Не удалось загрузить данные'), h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('h3', null, 'Данные не загрузились'), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: load }, 'Повторить'))));
      return;
    }
    page.replaceChildren(
      head(`Сравнение с ручной разметкой и повторной оценкой · набор ${data.group} · ${n(data.evaluated, 'оценённый диалог', 'оценённых диалога', 'оценённых диалогов')}`, secondAllButton()),
      h('div', { class: 'q-cards verification-cards' }, peopleCard(data.calibration), repeatCard(data.reproducibility)));
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
    const group = data.group;
    const file = h('input', { type: 'file', accept: '.xlsx,.json', multiple: true, hidden: true });
    const send = async (files) => {
      const selected = Array.from(files || []);
      if (!selected.length) return;
      for (const f of selected) {
        try {
          const r = await api.uploadCalibration(group, f);
          toast(`${r.who || f.name} · сохранено ${n(r.entries, 'ответ', 'ответа', 'ответов')}`);
        } catch (err) { toast(`${f.name} · ${err.message}`, { type: 'error' }); }
      }
      file.value = '';
      await load();
    };
    file.addEventListener('change', () => send(file.files));
    const template = h('a', { class: 'link-btn', href: 'assets/calibration-template.xlsx', download: 'Калибровка_CQA.xlsx' }, 'Скачать шаблон таблицы');
    const drop = h('div', { class: 'drop-zone', role: 'button', tabindex: 0,
      onclick: (e) => { if (e.target !== file) file.click(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
      icon('upload', 18),
      h('div', null, h('b', null, 'Загрузить разметку'),
        h('div', { class: 'muted' }, 'Файлы JSON от разметчиков или Excel с итоговыми оценками')),
      file);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer?.files); });

    const otherGroups = (c.availableGroups || []).filter((g) => g !== group);
    const otherLinks = otherGroups.map((g) => {
      const url = new URL(location.href);
      const params = new URLSearchParams(url.searchParams.get('data') || '');
      params.set('groupId', g);
      params.delete('conversationId');
      url.searchParams.set('data', params.toString());
      url.hash = '/settings/verification';
      return h('a', { class: 'link-btn', href: url.toString() }, `Открыть разметку ${g}`);
    });
    if (!c.entries && !c.team) {
      return card('Совпадает ли с оценкой людей?', null, null, [
        `Для набора ${group} разметка ещё не загружена.`,
      ], otherLinks, [drop, template]);
    }
    const team = c.team;
    const votes = (title, rows) => !rows.length ? null : h('details', { class: 'q-more' },
      h('summary', null, `${title} · ${rows.length}`),
      h('ul', { class: 'q-list' }, rows.map((row) => h('li', null, dialogLink(row.conversationId),
        ` · критерий ${row.criterionCode} · `,
        Object.entries(row.votes).map(([who, value]) => `${who}: ${VALUE(value)}`).join(' · ')))));
    const people = team && h('section', { class: 'q-list', 'aria-label': 'Разметка команды' },
      h('b', null, `Разметка команды · ${n(team.total, 'ответ', 'ответа', 'ответов')}`),
      team.authors.map((a) => h('a', { class: 'link-btn', href: api.annotationUrl(group, a.name),
        download: `razmetka_${a.name}.json`, title: `Скачать разметку · ${a.name}` },
        a.name, ` · ${n(a.entries, 'ответ', 'ответа', 'ответов')} · ${n(a.dialogs, 'диалог', 'диалога', 'диалогов')}`)),
      votes('Разметчики поставили разные оценки', team.conflicts),
      votes('Неполная разметка', team.partial));
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
    return card('Совпадает ли с оценкой людей?', c.rate, verdictWord(c.rate), [
      c.compared ? `Модель совпала с ручной оценкой в ${c.agree} из ${c.compared} случаев по ${n(dialogs, 'диалогу', 'диалогам', 'диалогам')}.` : 'Для сравнения пока нет общих оценок.',
      team && !team.decisions ? `В сравнении участвуют ответы, одинаковые у всех загрузивших разметку (минимум двое).` : null,
      team?.decisions ? 'Для согласованных вручную строк используется итог команды.' : null,
      c.near ? `Ещё ${n(c.near, 'ответ отличается', 'ответа отличаются', 'ответов отличаются')} на одну ступень шкалы.` : null,
      c.perLanguage.length > 1 ? c.perLanguage.map((l) => `${langName(l.language)} · ${pct(l.rate)}`).join(' / ') : null,
      c.missing.length ? `Для сравнения ещё нужно оценить ${c.missing.join(', ')}.` : null,
    ], [people, details, otherLinks], [drop, h('span', { class: 'muted small' }, `Сохранено на сервере · ${fmtDate(c.updatedAt)}`), template,
      h('button', { class: 'link-btn', type: 'button', onclick: async () => {
        if (!window.confirm(`Удалить все файлы разметки набора ${group} для всей команды?`)) return;
        try { await api.clearCalibration(group); await load(); } catch (err) { toast(err.message, { type: 'error' }); }
      } }, 'Удалить разметку набора')]);
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

  let active = true;
  let checking = false;
  const checkUpdates = async () => {
    if (!active || loading || checking || document.hidden || !data) return;
    checking = true;
    try {
      const latest = await api.calibrationInfo(data.group);
      if (active && (latest.updatedAt !== data.calibration.updatedAt
        || (latest.availableGroups || []).join('|') !== (data.calibration.availableGroups || []).join('|'))) await load();
    } catch { /* Keep the last reading until the server is reachable again. */ }
    finally { checking = false; }
  };
  load();
  const timer = setInterval(checkUpdates, 15000);
  document.addEventListener('visibilitychange', checkUpdates);
  const off = subscribe((w) => { if (w === 'results' || (w === 'job' && !state.job)) load(); else if (w === 'job') draw(); });
  return () => { active = false; sequence++; off(); clearInterval(timer); document.removeEventListener('visibilitychange', checkUpdates); };
}

function verdictWord(rate) {
  if (rate == null) return '';
  return rate >= 85 ? 'хорошо' : rate >= 65 ? 'есть расхождения' : 'низкое совпадение';
}
