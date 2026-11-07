// Read-only summaries shown alongside the work they describe.
import { h, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state } from '../store.js';

function panel(title, fetchData, render) {
  const body = h('div', { 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Загрузка…'));
  const el = h('section', { class: 'card card-pad insight-panel' }, h('h3', { class: 'card-title' }, title), body);
  let sequence = 0;
  async function refresh() {
    const request = ++sequence;
    try {
      const data = await fetchData();
      if (request === sequence) body.replaceChildren(render(data));
    } catch {
      if (request === sequence) body.replaceChildren(h('p', { class: 'muted' }, 'Не удалось загрузить статистику.'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: refresh }, 'Повторить'));
    }
  }
  return { el, refresh };
}

export function violationPanel(operator = null) {
  const profile = operator != null;
  return panel(profile ? 'Нарушения' : 'Частые нарушения', () => api.quality(state.group, 'patterns', operator), (data) => {
    const rows = data.criteria.filter((c) => c.flag || c.failed || c.partial);
    if (!rows.length) return h('p', { class: 'muted' }, data.dialogs ? 'По оценённым диалогам нарушений нет.' : 'Пока нет оценённых диалогов.');
    const row = (c) => {
      const count = c.type === 'flag' ? c.flag : c.failed + c.partial;
      const base = c.type === 'flag' ? data.dialogs : c.applicable;
      const params = new URLSearchParams({ violation: c.code });
      if (profile) params.set('operator', operator);
      const one = profile && base === 1;
      const first = c.examples[0];
      const href = profile && data.dialogs === 1 && first
        ? `#/dialog/${encodeURIComponent(first.conversationId)}?criterion=${encodeURIComponent(first.criterionId)}`
        : '#/dialogs?' + params;
      let rate = `${Math.round(c.share)}%`;
      let description = `${count} из ${base} · ${c.type === 'flag' ? 'обнаружена грубая ошибка' : 'не выполнено или выполнено частично'}`;
      if (one) {
        rate = c.flag ? 'Выявлено' : c.failed ? 'Не выполнен' : 'Частично выполнен';
        description = data.dialogs > 1 ? 'Критерий применим в одном диалоге.' : '';
      } else if (profile) {
        rate = `${count} из ${base} ${pluralRu(base, 'диалога', 'диалогов', 'диалогов')}`;
        description = c.flag ? 'Выявлена грубая ошибка' : `Не выполнен: ${c.failed} · Частично выполнен: ${c.partial}`;
      }
      return h('div', { class: 'insight-row' },
        h('a', { class: 'insight-name', href }, h('span', { class: 'muted' }, c.code), c.name),
        h('span', { class: 'insight-rate' }, rate),
        description && h('div', { class: 'muted insight-count' }, description),
        c.examples.length ? h('details', { class: 'insight-examples' }, h('summary', null, 'Примеры из диалогов'),
          c.examples.map((e) => h('div', { class: 'p-quote' },
            h('a', { href: `#/dialog/${encodeURIComponent(e.conversationId)}?criterion=${encodeURIComponent(e.criterionId)}` },
              e.conversationId, e.turn ? ` · реплика ${e.turn}` : ''),
            e.quote ? h('q', null, e.quote) : null, h('div', { class: 'muted' }, e.explanation)))) : null);
    };
    const rest = rows.slice(3);
    return h('div', null, !profile && h('p', { class: 'muted insight-scope' },
      `${data.dialogs} ${pluralRu(data.dialogs, 'оценённый диалог', 'оценённых диалога', 'оценённых диалогов')}`),
      rows.slice(0, 3).map(row),
      rest.length ? h('details', { class: 'insight-more' }, h('summary', null, `Остальные критерии · ${rest.length}`), rest.map(row)) : null);
  });
}

export function appealsPanel() {
  return panel('Статистика пересмотров', () => api.quality(state.group, 'appeals'), (a) => {
    const decided = a.accepted + a.rejected;
    if (!decided) return h('p', { class: 'muted' }, a.pending
      ? `Ждут решения: ${a.pending}. Доля пересмотров появится после первого решения.`
      : 'Рассмотренных апелляций пока нет.');
    return h('div', null,
      h('p', { class: 'insight-summary' }, h('strong', null, `${a.changeRate}%`),
        ` решений изменили оценку критерия (${a.changed} из ${decided}).`),
      h('p', { class: 'muted' }, `Принято: ${a.accepted} · Отклонено: ${a.rejected} · Ждут решения: ${a.pending}`),
      h('details', { class: 'insight-more' }, h('summary', null, 'По критериям'),
        a.perCriterion.map((c) => h('p', null, h('b', null, `${c.code} · ${c.name}`),
          ` — изменено ${c.changed} из ${c.accepted + c.rejected} решений · ждут ${c.pending}`))));
  });
}
