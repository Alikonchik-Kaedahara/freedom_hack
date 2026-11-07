// «Скачать результаты»: the results file for the current dialog set (the organizers' format, see cqa/export.py).
// Opened from the registry menu «⋯» and from Settings → Выгрузка.
import { h, icon, openModal, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state } from '../store.js';

export function openExportModal() {
  const report = h('div', { class: 'export-report' });
  const run = async (dataset) => {
    report.replaceChildren(h('div', { class: 'bar indeterminate' }, h('i')));
    try {
      const r = await api.exportResults(dataset, state.group);
      const notReal = r.replay?.length || 0;
      report.replaceChildren(
        h('div', { class: r.error ? 'export-status warn' : 'export-status ok' },
          r.error
            ? `В файле ${r.total} ${pluralRu(r.total, 'диалог', 'диалога', 'диалогов')}, из них не оценены: ${r.error}.`
            : `Готово: ${r.total} ${pluralRu(r.total, 'диалог', 'диалога', 'диалогов')}, все оценены.`),
        notReal ? h('div', { class: 'muted' }, `${notReal} ${pluralRu(notReal, 'диалог взят', 'диалога взяты', 'диалогов взяты')} из сохранённых оценок и попадут в файл как неоценённые — оцените их заново.`) : null,
        ...Object.entries(r.errors || {}).slice(0, 6).map(([cid, why]) => h('div', { class: 'muted' }, h('span', { class: 'mono-id' }, cid), ` — ${why}`)),
        r.problems?.length ? h('div', { class: 'import-error' }, `Файл не прошёл проверку формата: ${r.problems.slice(0, 3).join('; ')}`) : null,
        h('a', { class: 'btn btn-primary', href: `${window.CQA_API_BASE || ''}/api/export/${dataset}/download`, download: `results-${dataset}.json` }, icon('download', 15), 'Скачать файл'));
    } catch (err) {
      report.replaceChildren(h('div', { class: 'import-error' }, err.message));
    }
  };
  openModal({
    title: 'Скачать результаты',
    sub: `Набор ${state.group}: по одному объекту на диалог, восемь критериев и итоговый балл.`,
    body: [
      h('div', { class: 'export-choice' },
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => run('dev') }, 'Файл набора для разработки'),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => run('prod') }, 'Файл контрольного набора')),
      report,
    ],
  });
}
