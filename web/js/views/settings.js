// Настройки: one section with tabs. Configuration lives here, daily work in the other sections.
// Routes: #/settings, #/settings/<tab>[/<sub>] — old #/checklists, #/knowledge, #/model redirect here (app.js).
import { h, icon, toast } from '../ui.js';
import { renderChecklists } from './checklists.js';
import { renderKnowledge } from './knowledge.js';
import { renderModel } from './model.js';
import { getUser, setUser, ROLES, initials } from '../user.js';

const TABS = [
  { id: 'user', label: 'Пользователь', icon: 'user' },
  { id: 'checklists', label: 'Чек-листы', icon: 'checks' },
  { id: 'knowledge', label: 'Справочник фактов', icon: 'database' },
  { id: 'model', label: 'Модель оценки', icon: 'cpu' },
  { id: 'export', label: 'Выгрузка', icon: 'download' },
  { id: 'integration', label: 'Интеграция', icon: 'waffle' },
];

export function renderSettings(root, tab, sub) {
  const active = TABS.some((t) => t.id === tab) ? tab : 'user';
  const body = h('div', { class: 'settings-body' });
  const page = h('div', { class: 'page settings-page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Настройки'), h('div', { class: 'sub' }, 'Пользователь, правила оценки и подключения'))),
    h('div', { class: 'settings' },
      h('nav', { class: 'settings-tabs card', 'aria-label': 'Вкладки настроек' }, TABS.map((t) =>
        h('a', { href: `#/settings/${t.id}`, class: t.id === active ? 'active' : '' }, icon(t.icon, 16), h('span', null, t.label)))),
      body));
  root.append(page);

  if (active === 'user') return renderUser(body);
  if (active === 'checklists') return renderChecklists(body, sub);
  if (active === 'knowledge') return renderKnowledge(body);
  return renderModel(body, active);
}

function renderUser(root) {
  const u = getUser();
  const name = h('input', { class: 'input', value: u?.name || '', placeholder: 'Имя и фамилия', autocomplete: 'name' });
  const role = h('select', { class: 'select' }, ROLES.map((r) => h('option', { value: r, selected: (u?.role || ROLES[0]) === r ? 'selected' : null }, r)));
  const preview = h('span', { class: 'uc-avatar big' }, u ? initials(u.name) : icon('user', 18));
  name.addEventListener('input', () => { preview.replaceChildren(name.value.trim() ? initials(name.value) : icon('user', 18)); });
  const save = () => {
    if (!name.value.trim()) { name.focus(); toast('Укажите имя', { type: 'error' }); return; }
    setUser({ name: name.value, role: role.value });
    toast('Пользователь сохранён');
  };
  root.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Пользователь'), h('div', { class: 'sub' }, 'Имя показывается в шапке и записывается в апелляции и решения по ним.'))),
    h('div', { class: 'card card-pad user-form' },
      preview,
      h('div', { class: 'field' }, h('label', null, 'Имя'), name),
      h('div', { class: 'field' }, h('label', null, 'Роль'), role),
      h('div', null, h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, 'Сохранить')))));
  return null;
}
