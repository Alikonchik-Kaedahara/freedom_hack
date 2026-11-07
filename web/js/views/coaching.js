// Optional coaching for future conversations. Only reviewer-approved text is stored.
import { h, openModal, toast, fmtDate } from '../ui.js';
import { state, putResult, refreshResults } from '../store.js';
import { api } from '../api.js';
import { reviewVersion } from '../review.js';
import { evidenceOf, finalAnswers } from '../scoring.js';
import { requireUser } from '../user.js';

const SPEAKER = { operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система' };

function draftEngine(settings) {
  if (settings.engine === 'local') return 'local';
  if (settings.cloud?.hasKey) return 'cloud';
  if (settings.engine === 'replay' && settings.local?.relay) return 'local';
  return null;
}

export function coachingControl(record, result, criterion, times) {
  if (!record.transcript.length) return null;
  const note = result.coaching?.[criterion.id];
  const edit = () => openEditor(record, result, criterion, times);
  if (!note) return h('button', { class: 'link-btn', type: 'button', onclick: edit }, 'Добавить рекомендацию');
  return h('div', { class: 'coaching-note' },
    h('b', null, 'Рекомендация проверяющего'), h('p', null, note.text),
    h('small', null, `${note.by} · ${fmtDate(note.at)} · реплика №${note.turn}`),
    h('button', { class: 'link-btn', type: 'button', onclick: edit }, 'Изменить'));
}

async function openEditor(record, result, criterion, times) {
  const reviewer = await requireUser('Имя будет указано рядом с сохранённой рекомендацией.');
  if (!reviewer || result.groupId !== state.group) return;
  const old = result.coaching?.[criterion.id];
  const answer = finalAnswers(result)[criterion.id] || {};
  const turns = record.transcript;
  const ev = evidenceOf(answer, criterion, record);
  const first = ev.find((i) => turns[i]?.speaker === 'operator') ?? ev[0] ?? 0;
  const turnPicker = h('select', { class: 'select', 'aria-label': 'Исходная реплика' }, turns.map((t, i) =>
    h('option', { value: i + 1 }, `№${i + 1} · ${times[i]} · ${SPEAKER[t.speaker] || t.speaker} · ${t.text.slice(0, 55)}`)));
  turnPicker.value = String(old?.turn <= turns.length ? old.turn : first + 1);
  const quote = h('blockquote', { class: 'review-quote' });
  const input = h('textarea', { class: 'textarea', rows: 3, maxlength: 1200, value: old?.text || '',
    'aria-label': 'Рекомендация проверяющего', placeholder: 'Что оператор может улучшить в следующем разговоре?' });
  const status = h('div', { role: 'status', class: 'muted small' });
  const preview = h('div');
  const engine = draftEngine(state.settings);
  const aiButton = engine && h('button', { type: 'button', class: 'btn btn-secondary', onclick: generate },
    engine === 'cloud' ? 'Предложить с ИИ · Claude' : 'Предложить с ИИ · локальная модель');
  const save = h('button', { type: 'button', class: 'btn btn-primary', disabled: !input.value.trim(), onclick: approve }, 'Сохранить рекомендацию');
  const editor = openModal({
    title: 'Рекомендация проверяющего', sub: `${criterion.code} · ${criterion.name}`, className: 'coaching-modal',
    body: h('div', { class: 'coaching-editor' },
      h('label', { class: 'field' }, 'Исходная реплика', turnPicker), quote,
      h('label', { class: 'field' }, 'Рекомендация оператору', input),
      aiButton || h('div', { class: 'muted small' }, 'Можно написать вручную. Для черновика ИИ подключите модель в настройках.'),
      status, preview),
    footer: [h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => editor.close() }, 'Отмена'), save],
  });
  let request = 0;
  function selectTurn() {
    request++;
    quote.textContent = turns[Number(turnPicker.value) - 1].text;
    preview.replaceChildren();
    status.textContent = '';
    if (aiButton) aiButton.disabled = false;
  }
  turnPicker.addEventListener('change', selectTurn);
  selectTurn();
  input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
  function payload() {
    const turn = Number(turnPicker.value);
    return { turn, quote: turns[turn - 1].text, version: reviewVersion(result), verdict: answer.answer ?? null, by: reviewer.name };
  }
  async function generate() {
    const id = ++request;
    aiButton.disabled = true;
    preview.replaceChildren();
    status.textContent = 'Готовится черновик…';
    try {
      const draft = await api.draftCoaching(result.key, criterion.id, { ...payload(), engine });
      if (id !== request || !editor.modal.isConnected) return;
      status.textContent = '';
      preview.replaceChildren(h('div', { class: 'coaching-note' }, h('b', null, 'Черновик ИИ'), h('p', null, draft.text),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => {
          input.value = draft.text; save.disabled = false; preview.replaceChildren(); input.focus();
        } }, 'Вставить в рекомендацию')));
    } catch (e) {
      if (id === request) status.textContent = e.message;
    } finally { if (id === request) aiButton.disabled = false; }
  }
  async function approve() {
    save.disabled = true;
    try {
      const updated = await api.saveCoaching(result.key, criterion.id, { ...payload(), text: input.value.trim(), previousId: old?.id ?? null });
      if (updated.groupId === state.group) putResult(updated);
      editor.close(); toast('Рекомендация сохранена');
    } catch (e) {
      status.textContent = e.message;
      if (e.status === 409) {
        try { await refreshResults(); } catch { /* keep the typed note visible */ }
      }
      save.disabled = !input.value.trim();
    }
  }
}
