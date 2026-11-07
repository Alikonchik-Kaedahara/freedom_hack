// Screen 8: appeal queue and reviewer decision with live recalculation.
import { h, icon, fmtScore, openModal, toast, fmtDate, channelLabel } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, allAppeals, putResult } from '../store.js';
import { finalAnswers, score, verdictOf, answerOptions } from '../scoring.js';
import { displayTimes } from './dialog.js';

let tab = 'pending';

export function renderAppeals(root) {
  const draw = () => root.replaceChildren(build());
  draw();
  return subscribe((w) => { if (w === 'results') draw(); });
}

function build() {
  const items = allAppeals();
  const pending = items.filter((x) => x.appeal.status === 'pending');
  const done = items.filter((x) => x.appeal.status !== 'pending');
  const list = tab === 'pending' ? pending : done;

  const seg = h('div', { class: 'segmented on-dark' },
    h('button', { class: tab === 'pending' ? 'on' : '', onclick: () => { tab = 'pending'; rerender(); } }, 'На рассмотрении', h('span', { class: 'count' }, pending.length)),
    h('button', { class: tab === 'done' ? 'on' : '', onclick: () => { tab = 'done'; rerender(); } }, 'Решённые', h('span', { class: 'count' }, done.length)));

  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Апелляции'), seg),
    h('div', { class: 'card', style: { overflow: 'hidden' } },
      list.length ? h('div', { class: 'appeal-list' }, list.map(row))
        : h('div', { class: 'empty' },
          h('div', { class: 'empty-icon' }, icon('inbox', 30)),
          h('h3', null, tab === 'pending' ? 'Новых апелляций нет' : 'Решённых апелляций пока нет'),
          h('p', null, 'Апелляцию можно подать из карточки диалога: откройте критерий и нажмите «Оспорить».'))));
}

function rerender() { document.getElementById('view').replaceChildren(build()); }

function row({ result, appeal }) {
  const c = result.checklist.criteria.find((x) => x.id === appeal.criterionId);
  const rec = state.byId[result.conversationId];
  const v = verdictOf(c, result.answers[c.id]?.answer);
  const st = { pending: ['amber', 'Ждёт решения'], accepted: ['green', 'Принята'], rejected: ['', 'Отклонена'] }[appeal.status];
  return h('div', { class: 'appeal-row', onclick: () => openReview(result, appeal) },
    h('div', { class: 'code-badge' }, c.code || '•'),
    h('div', null,
      h('div', { class: 't' }, c.name),
      h('div', { class: 's' }, [result.conversationId, rec ? `${channelLabel(rec.channel)} ${rec.language}` : null,
        `ИИ: ${v.text}${c.type === 'scale' && v.max != null && v.text !== 'N/A' ? ` / ${v.max}` : ''}`].filter(Boolean).join('  ·  '))),
    h('div', { class: 'comment' }, `«${appeal.comment}»`),
    h('div', { class: 'right' },
      h('span', { class: `tag ${st[0]}` }, st[1]),
      h('span', { style: { color: 'var(--muted)', fontSize: '12.5px' } }, fmtDate(appeal.createdAt))));
}

export function openReview(result, appeal) {
  const c = result.checklist.criteria.find((x) => x.id === appeal.criterionId);
  const rec = state.byId[result.conversationId];
  const times = rec ? displayTimes(rec.transcript) : [];
  const ai = result.answers[c.id] || {};
  const aiV = verdictOf(c, ai.answer);
  const before = score(result.checklist, finalAnswers(result)).total;
  const decided = appeal.status !== 'pending';

  let choice = decided ? (appeal.status === 'accepted' ? appeal.decision?.answer : 'keep') : null;
  const reason = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Причина решения', value: appeal.decision?.reason || '' });
  if (decided) reason.disabled = true;

  // fragment: evidence lines with one line of context around them
  const ev = ai.evidence || [];
  const idx = new Set();
  for (const i of ev) for (const j of [i - 1, i, i + 1]) if (rec && j >= 0 && j < rec.transcript.length) idx.add(j);
  const fragment = h('div', { class: 'fragment' }, [...idx].sort((a, b) => a - b).map((i) => {
    const m = rec.transcript[i];
    return h('div', { class: `msg ${m.speaker} ${ev.includes(i) ? 'hl-amber' : ''}` },
      h('div', { class: 'meta' }, h('span', { class: 'who' }, { client: 'Клиент', operator: 'Оператор', bot: 'Бот' }[m.speaker] || ''), '·', times[i]),
      h('div', { class: 'bubble' }, m.text));
  }));

  const recalcHost = h('div');
  const optsHost = h('div', { class: 'options' });
  const save = h('button', { class: 'btn btn-primary btn-lg' }, 'Сохранить решение');

  const answerFor = (ch) => (ch === 'keep' || ch == null ? null : ch);
  const drawOptions = () => {
    const opts = answerOptions(c).filter((o) => String(o.value) !== String(ai.answer));
    optsHost.replaceChildren(
      h('button', { class: `option keep ${choice === 'keep' ? 'on' : ''}`, disabled: decided, onclick: () => { choice = 'keep'; drawOptions(); drawRecalc(); } }, 'Отклонить'),
      ...opts.map((o) => h('button', {
        class: `option ${String(choice) === String(o.value) ? 'on' : ''}`, disabled: decided,
        onclick: () => { choice = o.value; drawOptions(); drawRecalc(); },
      }, `Принять: ${o.label}`)));
  };
  const drawRecalc = () => {
    const a = answerFor(choice);
    if (choice == null) {
      recalcHost.replaceChildren(h('div', { class: 'recalc neutral' }, `Текущий итог: ${fmtScore(before)} / 100`));
      return;
    }
    const answers = finalAnswers({ ...result, appeals: (result.appeals || []).filter((x) => x.id !== appeal.id) });
    if (a != null) answers[c.id] = { ...answers[c.id], answer: a };
    const base = score(result.checklist, finalAnswers({ ...result, appeals: (result.appeals || []).filter((x) => x.id !== appeal.id) })).total;
    const after = score(result.checklist, answers).total;
    recalcHost.replaceChildren(h('div', { class: `recalc ${after === base ? 'neutral' : ''}` },
      'Пересчёт итога:', h('span', null, fmtScore(base)), h('span', { class: 'arrow' }, '→'), h('b', null, `${fmtScore(after)} / 100`)));
  };
  drawOptions();
  drawRecalc();

  const head = h('div', { class: 'rm-head' },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
      h('div', { style: { flex: 1 } },
        h('h2', null, `Рассмотрение апелляции: Критерий ${c.code}`),
        h('div', { class: 'sub' }, `${c.name} · диалог ${result.conversationId}`)),
      h('button', { class: 'modal-close light', onclick: () => m.close(), 'aria-label': 'Закрыть' }, icon('x', 18))));

  const body = h('div', null,
    h('div', { class: 'rm-grid' },
      h('div', { class: 'rm-box' },
        h('h4', null, 'Комментарий оператора'),
        h('div', { class: 'quote' }, appeal.comment),
        h('div', { class: 'rm-ai' }, h('span', { class: `tag ${aiV.cls === 'ok' ? 'green' : aiV.cls === 'fail' ? 'red' : aiV.cls === 'part' ? 'amber' : ''}` },
          `ИИ: ${aiV.text}${c.type === 'scale' && aiV.text !== 'N/A' ? ` / ${aiV.max}` : ''}`), h('span', null, ai.explanation || '')),
        idx.size ? fragment : null),
      h('div', { class: 'rm-box' },
        h('h4', null, 'Решение проверяющего'),
        optsHost,
        reason,
        h('a', { class: 'link-btn', href: `#/dialog/${encodeURIComponent(result.conversationId)}`, onclick: () => m.close() }, 'Открыть диалог', icon('right', 15)))),
    recalcHost);

  const m = openModal({
    wide: true, className: 'review-modal', head,
    footer: decided ? null : [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'), save],
  });
  m.modal.insertBefore(body, m.modal.querySelector('.modal-foot'));

  save.addEventListener('click', async () => {
    if (choice == null) { toast('Выберите решение', { type: 'error' }); return; }
    if (!reason.value.trim()) { reason.focus(); toast('Укажите причину решения', { type: 'error' }); return; }
    save.disabled = true;
    try {
      const updated = await api.decide(result.key, appeal.id, {
        status: choice === 'keep' ? 'rejected' : 'accepted',
        answer: answerFor(choice),
        reason: reason.value.trim(),
      });
      putResult(updated);
      m.close();
      const total = score(updated.checklist, finalAnswers(updated)).total;
      toast(`Решение сохранено · итог ${fmtScore(total)}`);
    } catch (e) {
      toast(e.message, { type: 'error' });
      save.disabled = false;
    }
  });
}
