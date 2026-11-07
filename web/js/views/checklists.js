// Screens 9–10: checklist builder with 100% weight balance, apply to dialogs
// and before/after comparison.
import { h, icon, toast, openModal, fmtScore, pluralRu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, refreshChecklists, saveSettings, resultFor } from '../store.js';
import { finalAnswers, score, round2 } from '../scoring.js';
import { startEvaluation } from '../jobs.js';

const COLORS = ['#1E7B4F', '#1A9F4B', '#19798B', '#3CC36A', '#5FB3C2', '#7A6FD0', '#9BCB5A', '#E0A91B', '#C25B9B', '#2F6FDB'];
const CHANNELS = { 'agent chat': 'Чаты', 'voice call': 'Звонки' };
const TYPES = [['binary', 'Да / Нет'], ['scale', 'Шкала'], ['flag', 'Грубая ошибка']];
const EXPORT_IDS = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];

let draft = null;
let dirty = false;
const openRows = new Set();

const clone = (x) => JSON.parse(JSON.stringify(x));

export function renderChecklists(root, id) {
  const pick = state.checklists.find((c) => c.id === id)
    || state.checklists.find((c) => c.id === state.settings?.active?.['agent chat'])
    || state.checklists[0];
  if (!draft || draft.id !== pick?.id || !dirty) { draft = pick ? clone(pick) : null; dirty = false; }

  const page = h('div', { class: 'page' });
  root.append(page);
  let saveBtn = null;
  const isValid = () => {
    const sum = round2(draft.criteria.filter((c) => c.type !== 'flag').reduce((a, c) => a + (Number(c.weight) || 0), 0));
    return sum === 100 && draft.criteria.every((c) => c.name.trim()) && draft.criteria.every((c) => c.type !== 'scale' || (c.scale || []).length >= 2);
  };
  const syncSave = () => { if (saveBtn) saveBtn.disabled = !(dirty && isValid()); };
  const draw = () => page.replaceChildren(...build());
  draw();
  const off = subscribe((w) => { if (w === 'results' || w === 'job' || w === 'settings') draw(); });
  return off;

  function build() {
    const sum = round2(draft.criteria.filter((c) => c.type !== 'flag').reduce((a, c) => a + (Number(c.weight) || 0), 0));
    const valid = isValid();
    const markDirty = () => { dirty = true; draw(); };

    const head = h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Конструктор чек-листа'), h('div', { class: 'sub' }, 'Критерии, веса, шкалы и условия N/A. Сохранение создаёт новую версию.')),
      h('div', { class: 'head-actions' },
        dirty ? h('button', { class: 'btn btn-glass', onclick: () => { draft = clone(state.checklists.find((c) => c.id === draft.id) || draft); dirty = false; draw(); } }, 'Отменить') : null,
        (saveBtn = h('button', { class: 'btn btn-primary btn-lg', disabled: !dirty || !valid, onclick: save }, icon('check', 15), 'Сохранить версию'))));

    const tabs = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } },
      h('div', { class: 'segmented' }, state.checklists.map((c) =>
        h('button', { class: c.id === draft.id ? 'on' : '', onclick: () => switchTo(c.id) },
          icon(c.channel === 'voice call' ? 'phone' : 'chat', 15), c.name))),
      h('button', { class: 'btn btn-glass btn-sm', onclick: createNew }, icon('plus', 15), 'Новый'));

    // ----- left: criteria -----
    const isActive = state.settings?.active?.[draft.channel] === draft.id;
    const meta = h('div', { class: 'cl-meta' },
      h('input', { class: 'name-input', value: draft.name, oninput: (e) => { draft.name = e.target.value; dirty = true; syncSave(); }, onchange: draw }),
      h('select', { class: 'select', onchange: (e) => { draft.channel = e.target.value; markDirty(); } },
        Object.entries(CHANNELS).map(([v, l]) => h('option', { value: v, selected: draft.channel === v ? 'selected' : null }, l))),
      isActive ? h('span', { class: 'tag green tag-lg' }, icon('check', 14), 'Основной')
        : h('button', { class: 'btn btn-secondary btn-sm', disabled: dirty, onclick: makeActive }, 'Сделать основным'),
      h('span', { class: 'tag outline tag-lg' }, `Версия ${draft.version || 1}`),
      !isActive && !dirty ? h('button', { class: 'icon-btn', title: 'Удалить чек-лист', onclick: remove }, icon('trash', 17)) : null);

    const rows = h('div', { class: 'crit-rows' }, draft.criteria.map((c, i) => critRow(c, i, markDirty)));
    const left = h('div', { class: 'card', style: { overflow: 'hidden' } }, meta, allocBar(sum, markDirty), rows,
      h('button', { class: 'add-crit', onclick: () => addCriterion(markDirty) }, icon('plus', 16), 'Добавить критерий'));

    // ----- right: balance + apply -----
    const side = h('div', { class: 'builder-side' }, applyCard(valid));
    return [head, tabs, h('div', { class: 'builder' }, left, side), mobileSum(sum)];
  }

  function critRow(c, i, markDirty) {
    const isOpen = openRows.has(c.id);
    const set = (k, v) => { c[k] = v; dirty = true; syncSave(); };
    const typeLabel = c.type === 'scale' ? `Шкала 0–${Math.max(0, ...(c.scale || []).map((s) => +s.value))}` : c.type === 'flag' ? 'Флаг' : 'Да / Нет';

    let headEl;
    const weightEl = c.type === 'flag'
      ? h('div', { class: 'weight' }, h('span', { class: 'noweight' }, 'без баллов'))
      : (() => {
        const range = h('input', { type: 'range', min: 0, max: 50, step: 1, value: c.weight });
        const num = h('input', { class: 'input wnum', type: 'number', min: 0, max: 100, value: c.weight });
        const fill = () => range.style.setProperty('--p', `${Math.min(100, (Number(range.value) / 50) * 100)}%`);
        fill();
        range.addEventListener('input', () => { num.value = range.value; c.weight = +range.value; dirty = true; fill(); refreshSide(); syncSave(); });
        range.addEventListener('change', draw);
        num.addEventListener('input', () => { c.weight = Math.max(0, +num.value || 0); range.value = c.weight; dirty = true; fill(); refreshSide(); syncSave(); });
        num.addEventListener('change', draw);
        const wrap = h('div', { class: 'weight', onclick: (e) => e.stopPropagation() }, range, num);
        return wrap;
      })();

    headEl = h('div', { class: 'crow-head', onclick: () => { isOpen ? openRows.delete(c.id) : openRows.add(c.id); draw(); } },
      h('span', { class: 'code' }, c.code || i + 1),
      h('div', { class: 'ttl' }, c.name || 'Без названия',
        h('div', { class: 'tags' },
          h('span', { class: `tag ${c.type === 'flag' ? 'red' : ''}` }, typeLabel),
          c.naAllowed && c.type !== 'flag' ? h('span', { class: 'tag' }, 'N/A') : null)),
      weightEl,
      h('span', { class: 'chev' }, icon('chevron', 20)));

    if (!isOpen) return h('div', { class: 'crow' }, headEl);

    const sections = [...new Set(draft.criteria.map((x) => x.section).filter(Boolean))];
    const listId = `sections-${draft.id}`;
    const body = h('div', { class: 'crow-body' },
      h('div', { class: 'field' }, h('label', null, 'Название'),
        h('input', { class: 'input', value: c.name, oninput: (e) => set('name', e.target.value), onchange: draw })),
      h('div', { class: 'field-row', style: { gridTemplateColumns: '110px 1fr 1fr' } },
        h('div', { class: 'field' }, h('label', null, 'Номер'),
          h('input', { class: 'input', value: c.code || '', oninput: (e) => set('code', e.target.value), onchange: draw })),
        h('div', { class: 'field' }, h('label', null, 'Раздел'),
          h('input', { class: 'input', value: c.section || '', list: listId, oninput: (e) => set('section', e.target.value) }),
          h('datalist', { id: listId }, sections.map((s) => h('option', { value: s })))),
        // Code of the organizers' results.json (eight fixed ids). A replacement criterion keeps the code
        // of the one it replaces so the export still contains all eight.
        h('div', { class: 'field' }, h('label', null, 'Код в выгрузке'),
          h('select', { class: 'input', onchange: (e) => set('exportId', e.target.value) },
            ['', ...EXPORT_IDS].map((v) => h('option', { value: v, selected: (c.exportId || '') === v }, v || '— не выгружать'))))),
      h('div', { class: 'field' }, h('label', null, 'Тип ответа'),
        h('div', { class: 'segmented' }, TYPES.map(([v, l]) =>
          h('button', { class: c.type === v ? 'on' : '', type: 'button', onclick: () => changeType(c, v, markDirty) }, l)))),
      h('div', { class: 'field' }, h('label', null, 'Формулировка правила'),
        h('textarea', { class: 'textarea', rows: 3, value: c.description || '', placeholder: 'Когда ставить «Да», что проверять', oninput: (e) => set('description', e.target.value) })),
      c.type === 'scale' ? scaleEditor(c, markDirty) : null,
      c.type !== 'flag' ? h('div', { class: 'field' },
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: !!c.naAllowed, onchange: (e) => { c.naAllowed = e.target.checked; markDirty(); } }),
          h('span', { class: 'track' }), 'Разрешить N/A'),
        c.naAllowed ? h('textarea', { class: 'textarea', rows: 2, value: c.naRule || '', placeholder: 'Условие N/A: когда критерий неприменим', oninput: (e) => set('naRule', e.target.value) }) : null) : null,
      // Why we read an ambiguous rule this way. Shown to reviewers in the card; the model gets only the rule.
      h('div', { class: 'field interp-field' }, h('label', null, 'Наша трактовка ', h('span', { class: 'hint' }, 'почему правило читаем именно так — видно проверяющему, модели не передаётся')),
        h('textarea', { class: 'textarea', rows: 3, value: c.interpretation || '', placeholder: 'Например: приветствие бота оператору не засчитывается, потому что…', oninput: (e) => set('interpretation', e.target.value) })),
      h('div', null, h('button', { class: 'link-btn danger', type: 'button', onclick: () => {
        draft.criteria = draft.criteria.filter((x) => x !== c); openRows.delete(c.id); markDirty();
      } }, icon('trash', 15), 'Удалить критерий')));
    return h('div', { class: 'crow open' }, headEl, body);
  }

  function scaleEditor(c, markDirty) {
    const steps = c.scale || (c.scale = []);
    return h('div', { class: 'field' }, h('label', null, 'Шкала оценок'),
      h('div', { class: 'steps' },
        steps.map((s, i) => h('div', { class: 'step' },
          h('input', { class: 'input', type: 'number', value: s.value, oninput: (e) => { s.value = Number(e.target.value); dirty = true; syncSave(); }, onchange: () => { steps.sort((a, b) => b.value - a.value); draw(); } }),
          h('input', { class: 'input', value: s.label || '', placeholder: 'Когда ставить эту оценку', oninput: (e) => { s.label = e.target.value; dirty = true; syncSave(); } }),
          h('button', { class: 'icon-btn', type: 'button', disabled: steps.length <= 2, onclick: () => { steps.splice(i, 1); markDirty(); } }, icon('x', 16))))),
      h('div', null, h('button', { class: 'link-btn', type: 'button', onclick: () => {
        const min = Math.min(...steps.map((s) => s.value), 0);
        steps.push({ value: Math.max(0, min - 1), label: '' });
        steps.sort((a, b) => b.value - a.value);
        markDirty();
      } }, icon('plus', 15), 'Добавить ступень')));
  }

  function changeType(c, type, markDirty) {
    if (c.type === type) return;
    if (type === 'scale' && !(c.scale || []).length) c.scale = [{ value: 10, label: '' }, { value: 5, label: '' }, { value: 0, label: '' }];
    if (type === 'flag') { c.weight = 0; c.naAllowed = false; }
    if (c.type === 'flag' && type !== 'flag' && !c.weight) c.weight = 10;
    c.type = type;
    markDirty();
  }

  function addCriterion(markDirty) {
    const codes = draft.criteria.map((c) => parseInt(c.code, 10)).filter((n) => !Number.isNaN(n));
    const next = String((codes.length ? Math.max(...codes) : 0) + 1).padStart(2, '0');
    const weighted = draft.criteria.filter((c) => c.type !== 'flag');
    const c = {
      id: `c${Date.now().toString(36)}`, code: next, name: 'Новый критерий',
      section: weighted[weighted.length - 1]?.section || '', type: 'binary', weight: 0,
      naAllowed: false, description: '', naRule: '', interpretation: '', exportId: '',
    };
    const flagIdx = draft.criteria.findIndex((x) => x.type === 'flag');
    if (flagIdx >= 0) draft.criteria.splice(flagIdx, 0, c); else draft.criteria.push(c);
    openRows.add(c.id);
    markDirty();
    setTimeout(() => {
      const inputs = page.querySelectorAll('.crow.open .crow-body .input');
      const el = [...inputs].find((x) => x.value === 'Новый критерий');
      el?.focus(); el?.select();
      el?.closest('.crow')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }

  // 100% stacked allocation bar: one segment per weighted criterion (01–07), live while sliders move.
  function allocBar(sum, markDirty) {
    const weighted = draft.criteria.filter((c) => c.type !== 'flag' && Number(c.weight) > 0);
    const scale = Math.max(sum, 100);
    const NS = 'http://www.w3.org/2000/svg';
    const bar = document.createElementNS(NS, 'svg');
    bar.setAttribute('class', 'alloc'); bar.setAttribute('viewBox', '0 0 1000 28'); bar.setAttribute('preserveAspectRatio', 'none');
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `Сумма весов ${sum} из 100`);
    const bg = document.createElementNS(NS, 'rect');
    Object.entries({ x: 0, y: 0, width: 1000, height: 28, class: 'trk' }).forEach(([k, v]) => bg.setAttribute(k, v));
    bar.append(bg);
    let x = 0;
    weighted.forEach((c, i) => {
      const w = (Number(c.weight) / scale) * 1000;
      const r = document.createElementNS(NS, 'rect');
      Object.entries({ x, y: 0, width: Math.max(0, w - 2), height: 28, fill: COLORS[i % COLORS.length] }).forEach(([k, v]) => r.setAttribute(k, v));
      const t = document.createElementNS(NS, 'title'); t.textContent = `${c.code} ${c.name} — ${c.weight}`; r.append(t);
      bar.append(r);
      if (w > 46) {
        const tx = document.createElementNS(NS, 'text');
        tx.setAttribute('x', x + 8); tx.setAttribute('y', 18); tx.textContent = `${c.code} · ${c.weight}`;
        bar.append(tx);
      }
      x += w;
    });
    const ok = sum === 100;
    return h('div', { class: 'alloc-wrap', id: 'balance' },
      h('div', { class: 'alloc-head' },
        h('span', { class: `sum ${ok ? 'ok' : 'bad'}` }, 'Сумма базовых весов: ', h('b', null, `${sum} / 100`), ok ? ' ✓' : ''),
        !ok && sum > 0 ? h('button', { class: 'btn btn-secondary btn-xs', onclick: () => { normalize(); markDirty(); } }, 'Нормализовать до 100') : null),
      bar,
      h('div', { class: 'alloc-legend' }, weighted.map((c, i) =>
        h('span', { title: c.name }, h('i', { style: { background: COLORS[i % COLORS.length] } }), `${c.code} ${c.name.length > 22 ? c.name.slice(0, 21) + '…' : c.name}`, h('b', null, c.weight)))));
  }

  function refreshSide() {
    const sum = round2(draft.criteria.filter((c) => c.type !== 'flag').reduce((a, c) => a + (Number(c.weight) || 0), 0));
    const old = page.querySelector('#balance');
    if (old) old.replaceWith(allocBar(sum, () => { dirty = true; draw(); }));
    page.querySelector('#msum')?.replaceWith(mobileSum(sum));
  }

  // Phones: weight total stays visible above the tab bar while editing.
  function mobileSum(sum) {
    const ok = sum === 100;
    return h('div', { class: `m-sum ${ok ? 'ok' : 'bad'}`, id: 'msum' },
      h('span', { class: 'm-sum-icon' }, icon(ok ? 'check' : 'alert', 16, 2.5)),
      h('span', null, 'Сумма весов ', h('b', null, sum), ' / 100'),
      !ok && sum > 0 ? h('button', { class: 'btn btn-sm btn-secondary', onclick: () => { normalize(); dirty = true; draw(); } }, 'Выровнять') : null,
      dirty && ok ? h('button', { class: 'btn btn-sm btn-primary', onclick: save }, 'Сохранить') : null);
  }

  function normalize() {
    const weighted = draft.criteria.filter((c) => c.type !== 'flag');
    const sum = weighted.reduce((a, c) => a + (Number(c.weight) || 0), 0);
    if (!sum) return;
    let acc = 0;
    weighted.forEach((c, i) => {
      if (i === weighted.length - 1) c.weight = 100 - acc;
      else { c.weight = Math.round((Number(c.weight) / sum) * 100); acc += c.weight; }
    });
  }

  function applyCard(valid) {
    const ids = state.records.filter((r) => r.channel === draft.channel).map((r) => r.conversation_id);
    const running = state.job?.status === 'running';
    const cmp = comparison();
    return h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Применение'),
      cmp ? h('div', null,
        h('div', { style: { color: 'var(--cqa-text-muted)', fontSize: '13px' } }, `Средний балл · ${cmp.n} ${pluralRu(cmp.n, 'диалог', 'диалога', 'диалогов')}`),
        h('div', { class: 'compare' },
          h('div', { class: 'c old' }, h('small', null, `Версия ${cmp.oldVersion}`), h('b', null, fmtScore(cmp.old))),
          h('span', { class: 'arr' }, icon('right', 26, 2.5)),
          h('div', { class: 'c' }, h('small', null, `Версия ${draft.version}`), h('b', null, fmtScore(cmp.new)))),
        h('div', { style: { height: '14px' } })) : null,
      h('button', {
        class: 'btn btn-primary btn-lg btn-block', disabled: dirty || !valid || running || !ids.length,
        onclick: apply,
      }, icon('sparkles', 18), ids.length ? `Применить к ${ids.length} ${pluralRu(ids.length, 'диалогу', 'диалогам', 'диалогам')}` : 'Нет диалогов этого канала'),
      dirty ? h('div', { style: { color: 'var(--cqa-text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '10px' } }, 'Сначала сохраните изменения') : null);
  }

  // Average total for dialogs re-evaluated with the current version vs their previous evaluation.
  function comparison() {
    let n = 0, sumOld = 0, sumNew = 0, oldVersion = null;
    for (const r of state.records) {
      const res = resultFor(r.conversation_id);
      if (!res || res.checklist.id !== draft.id || res.checklist.version !== draft.version) continue;
      const prev = (res.history || []).slice(-1)[0];
      if (!prev || prev.checklist.version === res.checklist.version && prev.checklist.id === res.checklist.id) continue;
      const a = score(prev.checklist, finalAnswers(prev)).total;
      const b = score(res.checklist, finalAnswers(res)).total;
      if (a == null || b == null) continue;
      n += 1; sumOld += a; sumNew += b;
      oldVersion = prev.checklist.id === draft.id ? prev.checklist.version : `«${prev.checklist.name}»`;
    }
    return n ? { n, old: round2(sumOld / n), new: round2(sumNew / n), oldVersion } : null;
  }

  async function save() {
    try {
      const saved = await api.saveChecklist(draft);
      await refreshChecklists();
      draft = clone(saved);
      dirty = false;
      draw();
      toast(`Чек-лист сохранён · версия ${saved.version}`);
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  async function apply() {
    const ids = state.records.filter((r) => r.channel === draft.channel).map((r) => r.conversation_id);
    if (state.settings?.active?.[draft.channel] !== draft.id) await makeActive(true);
    startEvaluation(ids, { checklistId: draft.id });
  }

  async function makeActive(silent) {
    await saveSettings({ active: { ...state.settings.active, [draft.channel]: draft.id } });
    if (silent !== true) toast(`«${draft.name}» — основной чек-лист для ${CHANNELS[draft.channel].toLowerCase()}`);
    draw();
  }

  function switchTo(cid) {
    if (dirty && !confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
    dirty = false;
    location.hash = `#/settings/checklists/${encodeURIComponent(cid)}`;
  }

  async function createNew() {
    if (dirty && !confirm('Есть несохранённые изменения. Создать новый без сохранения?')) return;
    const copy = clone(draft);
    copy.id = `cl-${Date.now().toString(36)}`;
    copy.name = `${draft.name} — копия`;
    delete copy.version;
    try {
      const saved = await api.saveChecklist(copy);
      await refreshChecklists();
      dirty = false;
      location.hash = `#/settings/checklists/${encodeURIComponent(saved.id)}`;
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  function remove() {
    const m = openModal({
      title: `Удалить «${draft.name}»?`,
      sub: 'Уже выставленные оценки сохранятся.',
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', { class: 'btn btn-danger', onclick: async () => {
          try { await api.deleteChecklist(draft.id); await refreshChecklists(); m.close(); dirty = false; location.hash = '#/settings/checklists'; }
          catch (e) { toast(e.message, { type: 'error' }); }
        } }, 'Удалить'),
      ],
    });
  }
}
