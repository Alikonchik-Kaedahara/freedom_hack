// Screen 1: import a dataset from the organizers' API by group_id, or upload a transcript file.
import { h, icon, openModal, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, loadGroup, refreshDatasets } from '../store.js';

function importCard({ onOpen, initial = 'DEV' } = {}) {
  const input = h('input', { class: 'input input-lg', value: initial, spellcheck: 'false', autocomplete: 'off', placeholder: 'Код набора, например DEV' });
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
    h('div', { class: 'input-prefix' }, h('span', null, 'Набор'), input),
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
    h('span', null, '· для знакомства с системой есть демонстрационный набор SAMPLE'),
    file);

  setTimeout(() => input.focus(), 50);
  return h('div', null, form, uploadRow);
}

export function renderImportStage(root) {
  root.append(h('div', { class: 'import-stage' },
    h('div', { class: 'card import-card' },
      h('h2', null, 'Загрузка диалогов'),
      h('p', { class: 'muted' }, 'Укажите код набора из системы записи разговоров — чаты и звонки подтянутся автоматически — или загрузите файл с транскриптами.'),
      importCard())));
}

// Dataset switcher in the ribbon: loaded sets plus any group_id (e.g. the hour-23 control key).
let openPopover = null;
export function openDatasetPopover(anchor) {
  if (openPopover) { openPopover.close(); return; }
  const input = h('input', { class: 'input', placeholder: 'Код набора, например DEV', spellcheck: 'false', autocomplete: 'off' });
  const status = h('div', { class: 'pop-status' });
  const go = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Загрузить');
  const list = state.datasets.length ? [...state.datasets].reverse().map((d) =>
    h('button', {
      class: `pop-item ${d.groupId === state.group ? 'on' : ''}`, type: 'button',
      onclick: async () => { close(); if (d.groupId !== state.group) await loadGroup(d.groupId); },
    },
    icon('database', 16), h('b', { class: 'mono' }, d.groupId),
    h('span', { class: 'meta' }, `${d.chats} ${pluralRu(d.chats, 'чат', 'чата', 'чатов')} · ${d.calls} ${pluralRu(d.calls, 'звонок', 'звонка', 'звонков')}`),
    d.groupId === state.group ? icon('check', 16) : null)) : [h('div', { class: 'muted', style: { padding: '4px' } }, 'Наборов пока нет')];

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const g = input.value.trim();
      if (!g) { input.focus(); return; }
      go.disabled = true;
      status.replaceChildren(h('div', { class: 'bar indeterminate' }, h('i')));
      try {
        const meta = await api.importDataset(g);
        await refreshDatasets();
        close();
        await loadGroup(meta.groupId);
      } catch (err) {
        status.replaceChildren(h('div', { class: 'import-error' }, err.message));
      } finally { go.disabled = false; }
    },
  }, h('div', { class: 'pop-row' }, input, go), status);

  const el = h('div', { class: 'cqa-popover', role: 'dialog', 'aria-label': 'Набор диалогов' },
    h('div', { class: 'pop-title' }, 'Набор диалогов'), list,
    h('div', { class: 'pop-sep' }),
    h('div', { class: 'pop-title' }, 'Загрузить другой набор'), form);
  el.addEventListener('click', (e) => e.stopPropagation());
  anchor.append(el);
  const onDoc = () => close();
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey); }, 0);
  function close() {
    el.remove(); openPopover = null;
    document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey);
  }
  openPopover = { close };
  setTimeout(() => input.focus(), 30);
}
