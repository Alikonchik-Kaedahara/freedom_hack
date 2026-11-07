// Screen 3: dialog registry with one-click filters.
import { h, icon, fmtScore, scoreClass, channelIcon, channelLabel, pluralRu, openModal, toast, hashQuery, clearHashQuery } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, summaryFor, resultFor } from '../store.js';
import { startEvaluation, isRunning } from '../jobs.js';
import { finalAnswers, score } from '../scoring.js';
import { setRibbonAction } from '../app.js';

const filters = { lang: new Set(), channel: new Set(), gross: false, appeal: false, disputed: false, q: '' };
const selected = new Set();

export function renderDialogs(root) {
  // Links from the Home cards open the registry already filtered: #/dialogs?f=gross | disputed | appeal
  const preset = hashQuery().get('f');
  if (['gross', 'disputed', 'appeal'].includes(preset)) {
    filters.lang.clear(); filters.channel.clear(); filters.q = '';
    filters.gross = preset === 'gross'; filters.disputed = preset === 'disputed'; filters.appeal = preset === 'appeal';
    clearHashQuery();
  }
  const page = h('div', { class: 'page' });
  root.append(page);
  let tbodyHost, headHost, footHost, chipsHost;

  const visible = () => state.records.filter((r) => {
    const s = summaryFor(r.conversation_id);
    if (filters.lang.size && !filters.lang.has(r.language)) return false;
    if (filters.channel.size && !filters.channel.has(r.channel)) return false;
    if (filters.gross && !s?.gross) return false;
    if (filters.appeal && !s?.pending) return false;
    if (filters.disputed && !s?.disputed?.length) return false;
    if (filters.q && !matchOf(r)) return false;
    return true;
  });

  // Search matches the conversation id or any message text; the matched snippet is shown under the id.
  const matchOf = (r) => {
    const q = filters.q.trim().toLowerCase();
    if (!q) return null;
    if (r.conversation_id.toLowerCase().includes(q)) return { id: true };
    for (const m of r.transcript) {
      const t = m.text || '';
      const i = t.toLowerCase().indexOf(q);
      if (i >= 0) return { text: t, i, len: q.length };
    }
    return null;
  };

  const drawHead = () => {
    const running = state.job?.status === 'running';
    const sel = [...selected].filter((id) => state.byId[id]);
    const pending = state.records.filter((r) => !summaryFor(r.conversation_id)).map((r) => r.conversation_id);
    // Checked rows win over "evaluate everything", so a click never runs all 65 by accident.
    const mkAction = () => {
      if (running) return null;
      if (sel.length) {
        return h('button', { class: 'btn btn-primary btn-lg eval-main', onclick: () => { startEvaluation(sel); selected.clear(); drawAll(); } },
          icon('sparkles', 15), `Оценить выбранные (${sel.length})`);
      }
      if (pending.length) {
        return h('button', { class: 'btn btn-primary btn-lg eval-main', onclick: () => startEvaluation(pending) },
          icon('sparkles', 15), `Оценить диалоги (${pending.length})`);
      }
      return null;
    };
    const action = mkAction();
    setRibbonAction(mkAction());
    const evaluated = state.records.filter((r) => summaryFor(r.conversation_id)).length;
    const exportBtn = evaluated && !running
      ? h('button', { class: 'btn btn-secondary btn-lg', title: 'results.json в формате организаторов', onclick: openExportModal }, icon('download', 15), 'Выгрузить')
      : null;
    headHost.replaceChildren(h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Реестр диалогов'), h('div', { class: 'sub' }, `${evaluated} из ${state.records.length} оценено · отметьте строки галочками, чтобы оценить выборочно`)),
      h('div', { class: 'head-actions' }, exportBtn, action)));
  };

  // results/<dev|prod>/results.json in the organizers' JSON 1.0 format (see cqa/export.py)
  function openExportModal() {
    let modal;
    const report = h('div');
    const run = async (dataset) => {
      report.replaceChildren(h('div', { class: 'muted' }, 'Формируем файл…'));
      try {
        const r = await api.exportResults(dataset, state.group);
        const lines = [
          h('div', null, h('b', null, r.path), ` — записей ${r.total}: ok ${r.ok}, error ${r.error} · model.mode ${r.mode} (${r.modelName})`),
          r.replay?.length ? h('div', { class: 'import-error' }, `${r.replay.length} ${pluralRu(r.replay.length, 'результат получен', 'результата получены', 'результатов получены')} движком replay и выгружены как error — для сдачи оцените их реальной моделью`) : null,
          ...Object.entries(r.errors || {}).slice(0, 8).map(([cid, why]) => h('div', { class: 'muted' }, `error ${cid}: ${why}`)),
          r.problems?.length ? h('div', { class: 'import-error' }, 'Проблемы формата: ' + r.problems.slice(0, 5).join('; ')) : h('div', { style: { color: 'var(--cqa-brand-primary)' } }, 'Формат проверен: проблем нет'),
          h('a', { class: 'btn btn-secondary', href: `${window.CQA_API_BASE || ''}/api/export/${dataset}/download`, download: `results-${dataset}.json` }, icon('download', 16), 'Скачать файл'),
          h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Файл уже записан в папку results/ репозитория — осталось git add, commit и push.'),
        ];
        report.replaceChildren(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, lines));
      } catch (err) {
        report.replaceChildren(h('div', { class: 'import-error' }, err.message));
      }
    };
    modal = openModal({
      title: `Выгрузка results.json — набор ${state.group}`,
      body: [
        h('div', { class: 'muted', style: { marginBottom: '12px' } }, 'Один объект на диалог, восемь критериев формата организаторов, нумерация реплик с 1, итог с перераспределением N/A. Неоценённые диалоги попадают в файл со status = error.'),
        h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px' } },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run('dev') }, 'results/dev'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run('prod') }, 'results/prod')),
        report,
      ],
    });
  }

  const chip = (label, on, toggle, opts = {}) =>
    h('button', { class: `chip ${on ? 'on' : ''} ${opts.danger ? 'danger' : ''}`, type: 'button', onclick: () => { toggle(); drawAll(); } },
      opts.icon ? icon(opts.icon, 16) : null, label);
  const toggleSet = (set, v) => () => (set.has(v) ? set.delete(v) : set.add(v));

  const drawChips = () => {
    const search = h('input', {
      class: 'input', placeholder: 'Поиск по ID или тексту реплик', value: filters.q,
      oninput: (e) => { filters.q = e.target.value; drawRows(); },
    });
    chipsHost.replaceChildren(h('div', { class: 'toolbar' },
      h('div', { class: 'chips' },
        ['RU', 'KZ', 'EN'].map((l) => chip(l, filters.lang.has(l), toggleSet(filters.lang, l))),
        h('span', { class: 'chip-sep' }),
        chip('Чат', filters.channel.has('agent chat'), toggleSet(filters.channel, 'agent chat'), { icon: 'chat' }),
        chip('Звонок', filters.channel.has('voice call'), toggleSet(filters.channel, 'voice call'), { icon: 'phone' }),
        h('span', { class: 'chip-sep' }),
        chip('Грубая ошибка', filters.gross, () => (filters.gross = !filters.gross), { icon: 'flag', danger: true }),
        chip('Апелляция', filters.appeal, () => (filters.appeal = !filters.appeal), { icon: 'scale' }),
        chip('Спорные', filters.disputed, () => (filters.disputed = !filters.disputed), { icon: 'alert' })),
      h('div', { class: 'search' }, icon('search', 16), search)));
  };

  const drawRows = () => {
    const rows = visible();
    const allSel = rows.length > 0 && rows.every((r) => selected.has(r.conversation_id));
    const headCb = h('input', {
      type: 'checkbox', class: 'cb', checked: allSel, 'aria-label': 'Выбрать все',
      onclick: (e) => { e.stopPropagation(); rows.forEach((r) => (allSel ? selected.delete(r.conversation_id) : selected.add(r.conversation_id))); drawRows(); drawHead(); },
    });
    tbodyHost.replaceChildren(h('table', { class: 'table registry' },
      h('thead', null, h('tr', null,
        h('th', { style: { width: '44px' } }, headCb),
        h('th', null, 'ID'), h('th', null, 'Оператор'), h('th', null, 'Канал'), h('th', null, 'Язык'),
        h('th', null, 'Критерии 01–08'),
        h('th', { class: 'right' }, 'Балл'), h('th', null, 'Статус'), h('th', null, ''))),
      h('tbody', null, rows.map(row))));
    footHost.replaceChildren(h('div', { class: 'table-foot' },
      h('span', null, rows.length === state.records.length ? `${rows.length} ${pluralRu(rows.length, 'диалог', 'диалога', 'диалогов')}` : `Показано ${rows.length} из ${state.records.length}`),
      h('span', { class: 'mx-legend' },
        h('span', null, h('i', { class: 'ok' }), 'Да / максимум'),
        h('span', null, h('i', { class: 'part' }), 'Частично'),
        h('span', null, h('i', { class: 'fail' }), 'Нет / 0'),
        h('span', null, h('i', { class: 'na' }), 'N/A'))));
  };

  const row = (r) => {
    const cid = r.conversation_id;
    const s = summaryFor(cid);
    const running = isRunning(cid);
    const tags = [];
    if (running) tags.push(h('span', { class: 'tag' }, h('span', { class: 'spinner' }), 'Оценивается'));
    else if (!s) tags.push(h('span', { class: 'tag' }, 'Не оценён'));
    if (s?.gross) tags.push(h('span', { class: 'tag red' }, icon('shield', 12), 'Критично'));
    if (s?.pending) tags.push(h('span', { class: 'tag amber' }, icon('scale', 14), 'Апелляция'));
    else if (s?.changed) tags.push(h('span', { class: 'tag green' }, 'Пересмотрен'));
    if (s?.disputed?.length) tags.push(h('span', { class: 'tag amber', title: 'Критерии с низкой уверенностью, непройденной проверкой или расхождением второго мнения' }, icon('alert', 14), `Спорно · ${s.disputed.length}`));
    const cb = h('input', {
      type: 'checkbox', class: 'cb', checked: selected.has(cid), 'aria-label': `Выбрать ${cid}`,
      onclick: (e) => { e.stopPropagation(); e.target.checked ? selected.add(cid) : selected.delete(cid); drawHead(); },
    });
    const open = () => (location.hash = `#/dialog/${encodeURIComponent(cid)}`);
    const m = matchOf(r);
    const act = s
      ? h('button', { class: 'btn btn-secondary btn-xs', onclick: (e) => { e.stopPropagation(); open(); } }, 'Открыть')
      : h('button', { class: 'btn btn-secondary btn-xs', disabled: running || state.job?.status === 'running', onclick: (e) => { e.stopPropagation(); startEvaluation([cid]); } }, 'Оценить');
    return h('tr', { class: `${s?.gross ? 'critical' : ''} ${selected.has(cid) ? 'selected' : ''}`, onclick: open },
      h('td', null, cb),
      h('td', null, h('span', { class: 'id' }, cid), m?.text ? h('div', { class: 'match-hint' }, snippet(m)) : null),
      h('td', null, operatorCell(cid)),
      h('td', null, h('span', { class: 'chan' }, icon(channelIcon(r.channel), 14), channelLabel(r.channel))),
      h('td', null, h('span', { class: 'tag outline' }, r.language)),
      h('td', null, matrix(cid)),
      h('td', { class: 'right' }, h('span', { class: `score ${scoreClass(s?.total)}` }, fmtScore(s?.total))),
      h('td', null, h('div', { class: 'tags' }, tags)),
      h('td', { class: 'row-act' }, act));
  };

  const snippet = (m) => {
    const from = Math.max(0, m.i - 24);
    return [from ? '…' : '', m.text.slice(from, m.i), h('mark', null, m.text.slice(m.i, m.i + m.len)), m.text.slice(m.i + m.len, m.i + m.len + 40), '…'];
  };

  const drawAll = () => { drawHead(); drawChips(); drawRows(); };

  headHost = h('div'); chipsHost = h('div'); tbodyHost = h('div'); footHost = h('div');
  page.append(headHost, h('div', { class: 'card', style: { overflow: 'hidden' } }, chipsHost, tbodyHost, footHost));
  drawAll();

  return subscribe((w) => {
    if (w === 'results' || w === 'job') { drawHead(); drawRows(); }
  });
}

// Eight 18×18 squares, one per checklist criterion, plus a red shield for a gross error (criterion 08).
const MX_TITLE = { ok: 'Да / максимум', part: 'Частично', fail: 'Нет / 0', na: 'N/A', flag: 'Грубая ошибка', clean: 'Нет грубых ошибок' };
function matrix(cid) {
  const res = resultFor(cid);
  if (!res) return h('span', { class: 'mx' }, Array.from({ length: 8 }, () => h('i', { class: 'empty' })));
  const sc = score(res.checklist, finalAnswers(res));
  const cells = res.checklist.criteria.map((c) => {
    const st = sc.per[c.id]?.status || 'na';
    const cls = st === 'flag' ? 'fail' : st === 'clean' ? 'ok' : st;
    return h('i', { class: cls, title: `${c.code} ${c.name}: ${MX_TITLE[st] || st}` }, st === 'na' ? '–' : '');
  });
  return h('span', { class: 'mx' }, cells, sc.gross ? h('span', { class: 'shield', title: 'Грубая ошибка (08)' }, icon('shield', 15)) : null);
}

/** Operator of an evaluated dialog (from the first reply, or set by the supervisor); unknown until evaluated. */
function operatorCell(cid) {
  const name = resultFor(cid)?.operator;
  if (!name) return h('span', { class: 'muted' }, '—');
  if (name === 'Не представился') return h('span', { class: 'muted', title: 'В первой реплике оператор не назвал себя' }, 'Не представился');
  return h('a', { class: 'op-link', href: `#/operators/${encodeURIComponent(name)}`, onclick: (e) => e.stopPropagation() }, name);
}
