// Справочник фактов: the reference the model checks the operator's advice against (criterion 04).
// Facts are edited here and stored on the server; each shows the dialogs where it was contradicted.
import { h, icon, toast, openModal, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, refreshKnowledge } from '../store.js';
import { setRibbonAction } from '../app.js';

export function renderKnowledge(root) {
  const page = h('div', { class: 'page' });
  root.append(page);
  let doc = null;     // working copy
  let usage = {};
  let edited = false; // server has an edited copy (reset makes sense)
  let dirty = false;

  async function load() {
    try {
      const kb = await api.knowledge(state.group);
      doc = { title: kb.title || 'Справочник фактов', note: kb.note || '', facts: (kb.facts || []).map((f) => ({ ...f })) };
      usage = kb.usage || {};
      edited = !!kb.edited;
      dirty = false;
    } catch (e) {
      toast(e.message, { type: 'error' });
      doc = { title: 'Справочник фактов', note: '', facts: [] };
    }
    draw();
  }

  function draw() {
    setRibbonAction(null);
    if (!doc) { page.replaceChildren(h('div', { class: 'skeleton', style: { height: '160px' } })); return; }
    const hits = Object.values(usage).reduce((a, u) => a + u.dialogs.length, 0);
    const head = h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Справочник фактов'),
        h('div', { class: 'sub' }, `${doc.facts.length} ${pluralRu(doc.facts.length, 'факт', 'факта', 'фактов')} о продуктах и сервисах · при оценке консультации ответы оператора сверяются с ними · ${hits ? `${hits} ${pluralRu(hits, 'противоречие', 'противоречия', 'противоречий')} в наборе ${state.group}` : 'противоречий в наборе не найдено'}`)),
      h('div', { class: 'head-actions' },
        edited ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: reset }, 'Вернуть исходный') : null,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: addFact }, icon('plus', 15), 'Добавить факт'),
        h('button', { class: `btn btn-primary ${dirty ? '' : 'is-quiet'}`, type: 'button', disabled: !dirty, onclick: save }, icon('check', 15), 'Сохранить')));

    const how = h('div', { class: 'card card-pad kb-how' },
      h('div', { class: 'kb-how-grid' },
        step('1', 'Факт', 'Короткое утверждение о продукте: где лежит отчёт брокера, что такое D-счёт, когда нужна идентификация. Только то, что можно проверить, — без сценариев разговора.'),
        step('2', 'Проверка', 'При оценке критерия «Корректность консультации» ответы оператора сверяются со справочником. Если оператор сказал иное, расхождение фиксируется с указанием факта.'),
        step('3', 'Карточка', 'У критерия в карточке диалога появляется пометка «Противоречит справочнику» с текстом факта. Балл при этом ставится по правилу и шкале чек-листа — справочник объясняет, а не оценивает.')),
      h('div', { class: 'muted small', style: { marginTop: '10px' } }, doc.note || 'Справочник ведёт отдел качества: источник факта — регламент, инструкция или база знаний компании.'));

    const meta = h('div', { class: 'card card-pad' },
      h('div', { class: 'field-row' },
        h('div', { class: 'field', style: { flex: 1 } }, h('label', null, 'Название'), h('input', { class: 'input', value: doc.title, oninput: (e) => { doc.title = e.target.value; markDirty(); } })),
        h('div', { class: 'field', style: { flex: 2 } }, h('label', null, 'Примечание'), h('input', { class: 'input', value: doc.note, placeholder: 'Откуда факты и для чего', oninput: (e) => { doc.note = e.target.value; markDirty(); } }))));

    const list = doc.facts.length
      ? h('div', { class: 'kb-list' }, doc.facts.map((f, i) => factRow(f, i)))
      : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('database', 30)), h('h3', null, 'Справочник пуст'), h('p', null, 'Добавьте факты — или верните исходный набор из DEV.')));

    page.replaceChildren(head, how, h('div', { style: { height: '12px' } }), meta, h('div', { style: { height: '12px' } }), list);
  }

  function step(n, title, text) {
    return h('div', { class: 'kb-step' }, h('span', { class: 'kb-n' }, n), h('div', null, h('b', null, title), h('p', null, text)));
  }

  function factRow(f, i) {
    const u = usage[f.id];
    const used = u ? u.dialogs : [];
    return h('div', { class: 'card card-pad kb-fact-row' },
      h('div', { class: 'kb-fact-head' },
        h('span', { class: 'mono kb-id' }, f.id),
        h('input', { class: 'input input-sm kb-topic', value: f.topic || '', placeholder: 'Тема', oninput: (e) => { f.topic = e.target.value; markDirty(); } }),
        h('span', { class: 'spacer' }),
        used.length ? h('details', { class: 'kb-usage' }, h('summary', { class: 'tag amber' }, icon('alert', 12), `${used.length} ${pluralRu(used.length, 'противоречие', 'противоречия', 'противоречий')}`),
          h('ul', null, used.map((d) => h('li', null, h('a', { href: `#/dialog/${encodeURIComponent(d.conversationId)}`, class: 'mono' }, d.conversationId), h('span', { class: 'muted' }, ` — ${d.explanation || ''}`)))))
          : h('span', { class: 'tag outline', title: 'Ни один оценённый диалог набора не противоречит этому факту' }, 'без противоречий'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Удалить факт', 'aria-label': 'Удалить факт', onclick: () => { doc.facts.splice(i, 1); markDirty(); draw(); } }, icon('trash', 15))),
      h('textarea', { class: 'textarea kb-text', rows: 2, value: f.fact || '', placeholder: 'Утверждение, которое можно проверить', oninput: (e) => { f.fact = e.target.value; markDirty(); autosize(e.target); } }),
      h('div', { class: 'kb-src' }, h('span', { class: 'muted' }, 'Источник:'), h('input', { class: 'input input-sm', value: f.source || '', placeholder: 'диалоги DEV, документ, регламент', oninput: (e) => { f.source = e.target.value; markDirty(); } })));
  }

  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; }

  function markDirty() {
    if (dirty) return;
    dirty = true;
    const btn = page.querySelector('.head-actions .btn-primary');
    if (btn) { btn.disabled = false; btn.classList.remove('is-quiet'); }
  }

  function addFact() {
    const n = doc.facts.length + 1;
    let id = `kb-${String(n).padStart(2, '0')}`;
    while (doc.facts.some((f) => f.id === id)) id = `${id}a`;
    doc.facts.push({ id, topic: '', fact: '', source: '' });
    markDirty();
    draw();
    const last = page.querySelector('.kb-fact-row:last-child .kb-text');
    if (last) { last.scrollIntoView({ block: 'center', behavior: 'smooth' }); last.focus(); }
  }

  async function save() {
    const facts = doc.facts.filter((f) => (f.fact || '').trim());
    try {
      await api.saveKnowledge({ title: doc.title, note: doc.note, facts });
      await refreshKnowledge();
      toast(`Справочник сохранён: ${facts.length} ${pluralRu(facts.length, 'факт', 'факта', 'фактов')}. Новые оценки будут сверяться с ним.`);
      await load();
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  function reset() {
    const { close } = openModal({
      title: 'Вернуть исходный справочник?',
      body: h('p', null, 'Ваши правки будут удалены, вернётся исходный список фактов.'),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => close() }, 'Отмена'),
        h('button', { class: 'btn btn-danger', onclick: async () => { try { await api.resetKnowledge(); await refreshKnowledge(); close(); await load(); toast('Справочник восстановлен'); } catch (e) { toast(e.message, { type: 'error' }); } } }, 'Вернуть')],
    });
  }

  load();
  return subscribe((w) => { if (w === 'results' && !dirty) load(); });
}
