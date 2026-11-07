// Evaluation jobs: start, poll, show progress in the dock.
import { api } from './api.js';
import { state, emit, refreshResults } from './store.js';
import { h, toast, clear, pluralRu, layer } from './ui.js';

let timer = null;

export function isRunning(cid) {
  const j = state.job;
  return !!(j && j.status === 'running' && j.groupId === state.group && j.ids.includes(cid) && !j.finishedIds?.has(cid));
}

export async function startEvaluation(ids, { checklistId } = {}) {
  if (!ids.length) return;
  if (state.job && state.job.status === 'running') {
    toast('Дождитесь окончания текущей оценки', { type: 'error' });
    return;
  }
  try {
    const job = await api.evaluate({ groupId: state.group, conversationIds: ids, checklistId });
    track(job);
  } catch (e) {
    toast(e.message, {
      type: 'error',
      action: e.status === 412 ? { label: 'Настроить', onClick: () => (location.hash = '#/settings/model') } : null,
    });
  }
}

/** Second opinion for already-evaluated dialogs. engine: 'cloud' | 'local' | undefined (current). */
export async function startSecondOpinion(ids, engine) {
  if (!ids.length) return;
  if (state.job && state.job.status === 'running') {
    toast('Дождитесь окончания текущей оценки', { type: 'error' });
    return;
  }
  try {
    const job = await api.secondOpinion({ groupId: state.group, conversationIds: ids, engine });
    track(job);
  } catch (e) {
    toast(e.message, {
      type: 'error',
      action: e.status === 412 ? { label: 'Настроить', onClick: () => (location.hash = '#/settings/model') } : null,
    });
  }
}

export async function resumeJobs() {
  try {
    const running = await api.jobs();
    if (running.length) track(running[0]);
  } catch { /* ignore */ }
}

function track(job) {
  state.job = { ...job, finishedIds: new Set() };
  emit('job');
  renderDock();
  clearInterval(timer);
  let lastDone = 0;
  timer = setInterval(async () => {
    try {
      const j = await api.job(job.id);
      const finished = j.done + j.failed;
      if (finished !== lastDone) {
        lastDone = finished;
        await refreshResults();
      }
      state.job = { ...j, finishedIds: computeFinished(j) };
      renderDock();
      emit('job');
      if (j.status === 'finished') {
        clearInterval(timer);
        await refreshResults();
        finish(j);
      }
    } catch { /* keep polling */ }
  }, 1200);
}

// A conversation is finished once it is no longer queued or running.
function computeFinished(j) {
  const done = new Set();
  const results = state.results;
  for (const id of j.ids) {
    const r = results[`${j.groupId}:${id}`];
    if (r && r.createdAt >= j.startedAt) done.add(id);
  }
  for (const e of j.errors || []) done.add(e.conversationId);
  return done;
}

function finish(j) {
  state.job = null;
  emit('job');
  renderDock();
  if (j.failed && !j.done) {
    toast(j.errors[0]?.message || 'Оценка не удалась', { type: 'error', timeout: 8000 });
  } else if (j.failed) {
    toast(`Оценено ${j.done}, с ошибкой ${j.failed}: ${j.errors[0]?.message || ''}`, { type: 'error', timeout: 8000 });
  } else if (j.kind === 'second') {
    toast(j.needsReview
      ? `Второе мнение получено для ${j.done} ${pluralRu(j.done, 'диалога', 'диалогов', 'диалогов')}; расхождения в ${j.needsReview} ${pluralRu(j.needsReview, 'диалоге', 'диалогах', 'диалогах')} помечены как спорные`
      : `Второе мнение получено для ${j.done} ${pluralRu(j.done, 'диалога', 'диалогов', 'диалогов')}: вердикты совпали полностью`, { timeout: 7000 });
  } else if (j.needsReview) {
    toast(`Готово: ${j.done} ${pluralRu(j.done, 'диалог оценён', 'диалога оценено', 'диалогов оценено')}; в ${j.needsReview} ${pluralRu(j.needsReview, 'диалоге', 'диалогах', 'диалогах')} есть критерии, требующие проверки`, { timeout: 7000 });
  } else {
    toast(`Готово: ${j.done} ${pluralRu(j.done, 'диалог оценён', 'диалога оценено', 'диалогов оценено')}`);
  }
}

function renderDock() {
  const dock = clear(layer('dock'));
  const j = state.job;
  if (!j) return;
  const finished = j.done + j.failed;
  const pct = j.total ? Math.round((finished / j.total) * 100) : 0;
  dock.append(h('div', { class: 'job-dock' },
    h('div', { class: 'row' },
      h('span', { class: 'spinner' }),
      h('b', null, j.kind === 'second' ? 'Второе мнение' : 'Оценка диалогов'),
      h('span', { class: 'cnt' }, `${finished} из ${j.total}`)),
    h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(pct, 3)}%` } }))));
}
