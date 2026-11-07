// Screen 1: import a dataset from the organizers' API by group_id, or upload a transcript file.
import { h, icon, openModal, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, loadGroup, refreshDatasets } from '../store.js';

function importCard({ onOpen, initial = 'DEV' } = {}) {
  const input = h('input', { class: 'input input-lg', value: initial, spellcheck: 'false', autocomplete: 'off', placeholder: 'DEV, SAMPLE…' });
  const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, icon('download', 18), 'Загрузить');
  const result = h('div');

  const showLoading = (text) => result.replaceChildren(h('div', { class: 'import-result' },
    h('div', { class: 'bar indeterminate' }, h('i')),
    h('div', { class: 'import-status' }, text)));

  const showMeta = (meta) => {
    const langs = Object.entries(meta.languages || {}).sort((a, b) => b[1] - a[1]);
    result.replaceChildren(h('div', { class: 'import-result' },
      h('div', { class: 'chips', style: { justifyContent: 'center' } },
        h('span', { class: 'tag tag-lg' }, icon('chat', 16), `${meta.chats} ${pluralRu(meta.chats, 'чат', 'чата', 'чатов')}`),
        h('span', { class: 'tag tag-lg teal' }, icon('phone', 16), `${meta.calls} ${pluralRu(meta.calls, 'звонок', 'звонка', 'звонков')}`),
        langs.map(([l, n]) => h('span', { class: 'tag tag-lg outline' }, `${l} ${n}`))),
      h('div', { class: 'bar' }, h('i', { style: { width: '100%' } })),
      h('div', { class: 'import-status' }, `100% · ${meta.total} ${pluralRu(meta.total, 'диалог', 'диалога', 'диалогов')} готовы · набор ${meta.groupId}`),
      h('button', {
        class: 'btn btn-primary btn-lg btn-block', type: 'button',
        onclick: async () => { await loadGroup(meta.groupId); onOpen?.(); location.hash = '#/dialogs'; },
      }, 'Открыть диалоги', icon('right', 18))));
  };

  const showError = (err) => result.replaceChildren(h('div', { class: 'import-error' }, err.message));

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const groupId = input.value.trim();
      if (!groupId) { input.focus(); return; }
      btn.disabled = true;
      showLoading('Загружаем диалоги…');
      try {
        const meta = await api.importDataset(groupId);
        await refreshDatasets();
        showMeta(meta);
      } catch (err) {
        showError(err);
      } finally {
        btn.disabled = false;
      }
    },
  },
  h('div', { class: 'import-row' },
    h('div', { class: 'input-prefix' }, h('span', null, 'group_id'), input),
    btn),
  result);

  // Transcript file: the organizers' JSON, a list of records or a single record (see demo/sample/dataset.json).
  const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    showLoading(`Загружаем ${f.name}…`);
    try {
      const meta = await api.uploadDataset(f, input.value.trim() && input.value.trim() !== 'DEV' ? input.value.trim() : '');
      await refreshDatasets();
      showMeta(meta);
    } catch (err) {
      showError(err);
    } finally {
      file.value = '';
    }
  });
  const uploadRow = h('div', { class: 'upload-row' },
    'или',
    h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => file.click() }, icon('upload', 16), 'Загрузить файл с транскриптами'),
    h('span', null, '· group_id SAMPLE — демо-набор'),
    file);

  setTimeout(() => input.focus(), 50);
  return h('div', null, form, uploadRow);
}

export function renderImportStage(root) {
  root.append(h('div', { class: 'import-stage' },
    h('div', { class: 'card import-card' },
      h('h2', null, 'Импорт диалогов'),
      importCard())));
}

export function openDatasetModal() {
  let modal;
  const list = state.datasets.length
    ? h('div', { class: 'ds-list' }, [...state.datasets].reverse().map((d) =>
      h('button', {
        class: `ds-item ${d.groupId === state.group ? 'on' : ''}`, type: 'button',
        onclick: async () => { modal.close(); if (d.groupId !== state.group) await loadGroup(d.groupId); },
      },
      icon('database', 20),
      h('div', null, h('b', null, d.groupId),
        h('div', { class: 'meta' }, `${d.chats} ${pluralRu(d.chats, 'чат', 'чата', 'чатов')} · ${d.calls} ${pluralRu(d.calls, 'звонок', 'звонка', 'звонков')}`)),
      d.groupId === state.group ? icon('check', 20) : null)))
    : null;

  modal = openModal({
    title: 'Наборы диалогов',
    body: [list, h('div', { class: 'field' }, h('label', null, 'Загрузить новый набор'), importCard({ initial: '', onOpen: () => modal.close() }))],
  });
}
