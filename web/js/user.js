// The person working in the app: name and role, kept in this browser (localStorage "cqa.user").
// Shown in the header and written into appeals ("Подал") and decisions ("Решил").
import { h, openModal } from './ui.js';

const KEY = 'cqa.user';
export const ROLES = ['Супервайзер', 'Аналитик качества', 'Руководитель'];
const listeners = new Set();

export function getUser() {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) || 'null');
    return u && typeof u.name === 'string' && u.name.trim() ? { name: u.name.trim(), role: u.role || ROLES[0] } : null;
  } catch { return null; }
}

export function setUser(user) {
  try {
    if (user && user.name?.trim()) localStorage.setItem(KEY, JSON.stringify({ name: user.name.trim(), role: user.role || ROLES[0] }));
    else localStorage.removeItem(KEY);
  } catch { /* storage blocked: the name lives until reload */ }
  for (const fn of listeners) fn(getUser());
}

export function onUserChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

/** "Томирис Алимова" → "Томирис А." for compact lines such as «Подал: …». */
export function shortName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : (parts[0] || '');
}

/** Ask for name and role; resolves with the saved user or null if the dialog was closed. */
export function askUser({ title = 'Представьтесь', sub = 'Имя и роль показываются в шапке и в апелляциях.' } = {}) {
  return new Promise((resolve) => {
    const current = getUser();
    const name = h('input', { class: 'input', value: current?.name || '', placeholder: 'Имя и фамилия', autocomplete: 'name' });
    const role = h('select', { class: 'select' }, ROLES.map((r) => h('option', { value: r, selected: (current?.role || ROLES[0]) === r ? 'selected' : null }, r)));
    let done = false;
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
    const m = openModal({
      title, sub,
      body: [h('div', { class: 'field' }, h('label', null, 'Имя'), name), h('div', { class: 'field' }, h('label', null, 'Роль'), role)],
      footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Отмена'), save],
    });
    const finish = () => {
      if (!name.value.trim()) { name.focus(); return; }
      setUser({ name: name.value, role: role.value });
      done = true;
      m.close();
      resolve(getUser());
    };
    save.addEventListener('click', finish);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
    const observer = new MutationObserver(() => { if (!m.modal.isConnected) { observer.disconnect(); if (!done) resolve(null); } });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => name.focus(), 50);
  });
}

export async function requireUser(reason) {
  return getUser() || askUser({ title: 'Как вас зовут?', sub: reason || 'Имя попадёт в апелляцию и в отчёт.' });
}
