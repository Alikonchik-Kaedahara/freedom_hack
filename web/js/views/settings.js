// Настройки: one section with tabs. Configuration lives here, daily work in the other sections.
// Routes: #/settings, #/settings/<tab>[/<sub>] — old #/checklists, #/knowledge, #/model redirect here (app.js).
import { h, icon } from '../ui.js';
import { renderChecklists } from './checklists.js';
import { renderKnowledge } from './knowledge.js';
import { renderVerification } from './quality.js';
import { renderModel } from './model.js';

const TABS = [
  { id: 'checklists', label: 'Чек-листы', icon: 'checks' },
  { id: 'knowledge', label: 'Справочник фактов', icon: 'database' },
  { id: 'model', label: 'Модель оценки', icon: 'cpu' },
  { id: 'verification', label: 'Проверка модели', icon: 'target' },
  { id: 'export', label: 'Выгрузка', icon: 'download' },
  { id: 'integration', label: 'Интеграция', icon: 'waffle' },
];

export function renderSettings(root, tab, sub) {
  const active = TABS.some((t) => t.id === tab) ? tab : TABS[0].id;
  const body = h('div', { class: 'settings-body' });
  const page = h('div', { class: 'page settings-page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Настройки'), h('div', { class: 'sub' }, 'Правила оценки и подключения'))),
    h('div', { class: 'settings' },
      h('select', { class: 'select settings-jump', 'aria-label': 'Раздел настроек',
        onchange: (e) => { location.hash = '#/settings/' + e.target.value; } },
        TABS.map((t) => h('option', { value: t.id, selected: t.id === active }, t.label))),
      h('nav', { class: 'settings-tabs card', 'aria-label': 'Вкладки настроек' }, TABS.map((t) =>
        h('a', { href: `#/settings/${t.id}`, class: t.id === active ? 'active' : '' }, icon(t.icon, 16), h('span', null, t.label)))),
      body));
  root.append(page);

  if (active === 'checklists') return renderChecklists(body, sub);
  if (active === 'knowledge') return renderKnowledge(body);
  if (active === 'verification') return renderVerification(body);
  return renderModel(body, active);
}
