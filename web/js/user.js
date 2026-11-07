// The reviewer’s display name, kept in this browser (localStorage "cqa.user").
// Shown in the header and written into appeals ("Подал") and decisions ("Решил").
import { h, openModal } from './ui.js';

const KEY = 'cqa.user';
let sessionUser = null;
const listeners = new Set();

export function getUser() {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) || 'null');
    return u && typeof u.name === 'string' && u.name.trim() ? { name: u.name.trim() } : null;
  } catch { return sessionUser; }
}

export function setUser(user) {
  sessionUser = user?.name?.trim() ? { name: user.name.trim() } : null;
  try {
    if (sessionUser) localStorage.setItem(KEY, JSON.stringify(sessionUser));
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

/** Ask for the reviewer’s name; resolves with the saved user or null if the dialog was closed. */
export function askUser({ title = 'Представьтесь', sub = 'Это имя будет указано рядом с вашими решениями и рекомендациями.' } = {}) {
  return new Promise((resolve) => {
    const current = getUser();
    const name = h('input', { class: 'input', value: current?.name || '', placeholder: 'Имя и фамилия', 'aria-label': 'Имя и фамилия', maxlength: 80, autocomplete: 'name' });
    let done = false;
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
    const m = openModal({
      title, sub,
      body: h('label', { class: 'field' }, 'Имя', name),
      footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Отмена'), save],
    });
    const finish = () => {
      if (!name.value.trim()) { name.focus(); return; }
      setUser({ name: name.value });
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
