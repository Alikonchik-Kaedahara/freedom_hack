// Апелляции: the queue and the decision. Who filed and who decided is recorded (Settings → Пользователь).
import { h, icon, fmtScore, openModal, toast, fmtDate, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, allAppeals, putResult } from '../store.js';
import { finalAnswers, score, verdictOf, answerOptions, disputeLabel, CONFIDENCE_LABEL } from '../scoring.js';
import { requireUser, shortName } from '../user.js';
import { displayTimes } from './dialog.js';

let tab = 'pending';
let viewRoot = null;
const UNNAMED = new Set(['', 'Не представился', '[Имя скрыто]']);

export function renderAppeals(root) {
  viewRoot = root;
  const draw = () => root.replaceChildren(build());
  draw();
  return subscribe((w) => { if (w === 'results') draw(); });
}

function rerender() { viewRoot?.replaceChildren(build()); }

/** «Томирис А., 8 нояб., 01:12» — or just the date when the name was not recorded. */
export function byLine(name, iso) {
  return [name ? shortName(name) : null, fmtDate(iso)].filter(Boolean).join(', ');
}

const verdictText = (c, answer) => {
  const v = verdictOf(c, answer);
  return c.type === 'scale' && v.max != null && answer !== 'na' ? `${v.text} из ${v.max}` : v.text;
};

function build() {
  const items = allAppeals();
  const pending = items.filter((x) => x.appeal.status === 'pending');
  const done = items.filter((x) => x.appeal.status !== 'pending')
    .sort((a, b) => (b.appeal.decision?.decidedAt || '').localeCompare(a.appeal.decision?.decidedAt || ''));
  const list = tab === 'pending' ? pending : done;

  const seg = h('div', { class: 'segmented' },
    h('button', { type: 'button', class: tab === 'pending' ? 'on' : '', onclick: () => { tab = 'pending'; rerender(); } }, 'Ждут решения', h('span', { class: 'count' }, pending.length)),
    h('button', { type: 'button', class: tab === 'done' ? 'on' : '', onclick: () => { tab = 'done'; rerender(); } }, 'Решённые', h('span', { class: 'count' }, done.length)));

  const sub = items.length
    ? `${pending.length} ${pluralRu(pending.length, 'ждёт', 'ждут', 'ждут')} решения · ${done.length} ${pluralRu(done.length, 'решена', 'решены', 'решено')}`
    : 'Проверяющий решает, оставить оценку или изменить её';

  let content;
  if (!items.length) {
    content = h('div', { class: 'empty' },
      h('h3', null, 'Апелляций нет'),
      h('p', null, 'Их подают из карточки диалога, кнопкой «Подать апелляцию» у критерия.'));
  } else if (!list.length) {
    content = h('div', { class: 'empty' },
      h('h3', null, tab === 'pending' ? 'Все апелляции решены' : 'Решённых апелляций пока нет'),
      tab === 'pending' ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => { tab = 'done'; rerender(); } }, 'Показать решённые') : null);
  } else {
    content = h('table', { class: 'table appeals-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Критерий'), h('th', null, 'Диалог'), h('th', null, 'Оператор'),
        h('th', null, 'Подал'), h('th', null, 'Когда'), h('th', null, 'Статус'))),
      h('tbody', null, list.map(row)));
  }

  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Апелляции'), h('div', { class: 'sub' }, sub)), items.length ? seg : null),
    h('div', { class: 'card', style: { overflow: 'hidden' } }, content));
}

function row({ result, appeal }) {
  const c = result.checklist.criteria.find((x) => x.id === appeal.criterionId);
  const op = (result.operator || '').trim();
  const dec = appeal.decision;
  const status = appeal.status === 'pending'
    ? h('span', { class: 'tag amber' }, 'Ждёт решения')
    : h('div', { class: 'ap-status' },
      appeal.status === 'accepted'
        ? h('span', { class: 'tag green' }, `Изменена на «${verdictText(c, dec?.answer)}»`)
        : h('span', { class: 'tag' }, 'Оценка оставлена'),
      dec?.by ? h('small', null, `Решил: ${shortName(dec.by)}`) : null);
  return h('tr', { class: 'ap-row', tabindex: 0, onclick: () => openReview(result, appeal), onkeydown: (e) => { if (e.key === 'Enter') openReview(result, appeal); } },
    h('td', null, h('div', { class: 'ap-crit' }, h('b', null, c.code), ' ', c.name), h('div', { class: 'ap-comment' }, `«${appeal.comment}»`),
      h('div', { class: 'ap-meta' }, [result.conversationId, appeal.author ? `подал ${shortName(appeal.author)}` : null, fmtDate(appeal.createdAt)].filter(Boolean).join(' · '))),
    h('td', null, h('span', { class: 'id' }, result.conversationId)),
    h('td', null, op && !UNNAMED.has(op) ? op : h('span', { class: 'muted' }, '—')),
    h('td', null, appeal.author ? shortName(appeal.author) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'nowrap' }, fmtDate(appeal.createdAt)),
    h('td', null, status));
}

export function openReview(result, appeal) {
  const c = result.checklist.criteria.find((x) => x.id === appeal.criterionId);
  const rec = state.byId[result.conversationId];
  const times = rec ? displayTimes(rec.transcript) : [];
  const ai = result.answers[c.id] || {};
  const decided = appeal.status !== 'pending';
  const others = { ...result, appeals: (result.appeals || []).filter((x) => x.id !== appeal.id) };
  const base = score(result.checklist, finalAnswers(others)).total;

  let choice = decided ? (appeal.status === 'accepted' ? appeal.decision?.answer : 'keep') : null;
  const reason = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Почему оценку оставляете или меняете', value: appeal.decision?.reason || '', 'aria-label': 'Основание решения' });
  if (decided) reason.disabled = true;

  // Evidence lines with one line of context around them.
  const ev = ai.evidence || [];
  const idx = new Set();
  for (const i of ev) for (const j of [i - 1, i, i + 1]) if (rec && j >= 0 && j < rec.transcript.length) idx.add(j);
  const fragment = h('div', { class: 'fragment' }, [...idx].sort((a, b) => a - b).map((i) => {
    const m = rec.transcript[i];
    return h('div', { class: `msg ${m.speaker} ${ev.includes(i) ? 'hl-amber' : ''}` },
      h('div', { class: 'meta' }, h('span', { class: 'who' }, { client: 'Клиент', operator: 'Оператор', bot: 'Бот' }[m.speaker] || ''), '·', h('span', { class: 't' }, times[i])),
      h('div', { class: 'bubble' }, m.text));
  }));

  const recalcHost = h('div');
  const optsHost = h('div', { class: 'options' });
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Принять решение');

  const drawOptions = () => {
    const opts = answerOptions(c).filter((o) => String(o.value) !== String(ai.answer));
    optsHost.replaceChildren(
      h('button', { type: 'button', class: `option keep ${choice === 'keep' ? 'on' : ''}`, disabled: decided, onclick: () => { choice = 'keep'; drawOptions(); drawRecalc(); } }, 'Оставить'),
      ...opts.map((o) => h('button', {
        type: 'button', class: `option ${String(choice) === String(o.value) ? 'on' : ''}`, disabled: decided,
        onclick: () => { choice = o.value; drawOptions(); drawRecalc(); },
      }, `Изменить на «${verdictText(c, o.value)}»`)));
  };
  const drawRecalc = () => {
    if (choice == null) {
      recalcHost.replaceChildren(h('div', { class: 'recalc neutral' }, `Сейчас итог ${fmtScore(base)} из 100`));
      return;
    }
    const answers = finalAnswers(others);
    if (choice !== 'keep') answers[c.id] = { ...answers[c.id], answer: choice };
    const after = score(result.checklist, answers).total;
    recalcHost.replaceChildren(h('div', { class: `recalc ${after === base ? 'neutral' : ''}` },
      'Итог:', h('span', null, fmtScore(base)), h('span', { class: 'arrow' }, '→'), h('b', null, `${fmtScore(after)} из 100`)));
  };
  drawOptions();
  drawRecalc();

  const dispute = disputeLabel(ai);
  const head = h('div', { class: 'rm-head' },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
      h('div', { style: { flex: 1 } },
        h('h2', null, `Апелляция по критерию ${c.code} · ${c.name}`),
        h('div', { class: 'sub' }, `Диалог ${result.conversationId}`)),
      h('button', { class: 'modal-close light', type: 'button', onclick: () => m.close(), 'aria-label': 'Закрыть' }, icon('x', 18))));

  const body = h('div', null,
    h('div', { class: 'rm-grid' },
      h('div', { class: 'rm-box' },
        h('h4', null, 'Апелляция'),
        h('div', { class: 'quote' }, appeal.comment),
        h('div', { class: 'who-line' }, `Подал: ${byLine(appeal.author, appeal.createdAt) || '—'}`),
        h('h4', null, 'Оценка системы'),
        h('div', { class: 'rm-ai' }, h('b', null, verdictText(c, ai.answer)), h('span', null, ai.explanation || '')),
        ai.confidence || dispute ? h('div', { class: 'who-line' },
          ai.confidence ? `Уверенность оценки: ${CONFIDENCE_LABEL[ai.confidence] || ai.confidence}` : '',
          dispute ? `${ai.confidence ? ' · ' : ''}${dispute.text}` : '') : null,
        idx.size ? fragment : null),
      h('div', { class: 'rm-box' },
        h('h4', null, 'Решение'),
        optsHost,
        h('label', { class: 'field-label' }, 'Основание решения'),
        reason,
        decided ? h('div', { class: 'who-line' }, `Решил: ${byLine(appeal.decision?.by, appeal.decision?.decidedAt) || '—'}`) : null,
        h('a', { class: 'link-btn', href: `#/dialog/${encodeURIComponent(result.conversationId)}`, onclick: () => m.close() }, 'Открыть диалог', icon('right', 15)))),
    recalcHost);

  const m = openModal({
    wide: true, className: 'review-modal', head,
    footer: decided ? null : [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Отмена'), save],
  });
  m.modal.insertBefore(body, m.modal.querySelector('.modal-foot'));

  save.addEventListener('click', async () => {
    if (choice == null) { toast('Выберите: оставить оценку или изменить', { type: 'error' }); return; }
    if (!reason.value.trim()) { reason.focus(); toast('Напишите основание решения', { type: 'error' }); return; }
    const user = await requireUser('Имя проверяющего попадёт в решение по апелляции.');
    if (!user) return;
    save.disabled = true;
    try {
      const updated = await api.decide(result.key, appeal.id, {
        status: choice === 'keep' ? 'rejected' : 'accepted',
        answer: choice === 'keep' ? null : choice,
        reason: reason.value.trim(),
        by: user.name,
      });
      putResult(updated);
      m.close();
      toast(`Решение принято · итог ${fmtScore(score(updated.checklist, finalAnswers(updated)).total)}`);
    } catch (e) {
      toast(e.message, { type: 'error' });
      save.disabled = false;
    }
  });
}
