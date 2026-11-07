// The registry and the evaluation panel use the same checklist codes and final verdicts.
import { h, icon } from './ui.js';
import { finalAnswers } from './scoring.js';

const outcomes = {
  any: 'Любой результат', issues: 'Не выполнен или частично выполнен',
  fail: 'Не выполнен', part: 'Частично выполнен', ok: 'Выполнен', na: 'Не применим',
};
const rank = { flag: 0, fail: 0, part: 1, clean: 2, ok: 2, na: 3, missing: 4 };
export const severityOf = ({ status }) => rank[status];
export const worstRank = (entries) => Math.min(5, ...entries.map(severityOf));
export const codeOf = (c) => String(c.code || c.id);

export function readCriteria(params) {
  const legacy = params.get('violation');
  const outcome = legacy ? 'issues' : params.get('outcome');
  return {
    codes: new Set(legacy ? [legacy] : params.getAll('c').filter(Boolean)),
    outcome: Object.hasOwn(outcomes, outcome) ? outcome : 'any',
    severity: params.get('order') === 'severity',
  };
}

export function writeCriteria(params, filter) {
  for (const key of ['violation', 'c', 'outcome', 'order']) params.delete(key);
  for (const code of filter.codes) params.append('c', code);
  if (filter.outcome !== 'any') params.set('outcome', filter.outcome);
  if (filter.severity) params.set('order', 'severity');
  return params;
}

export function hasCriteria(filter) {
  return filter.codes.size > 0 || filter.outcome !== 'any';
}

export function criterionEntries(result, finalScore) {
  if (!result) return [];
  const answers = finalAnswers(result);
  return result.checklist.criteria.map((c) => {
    const p = finalScore.per[c.id];
    const answer = answers[c.id]?.answer;
    const status = answer == null || !p || p.kind === 'zero' ? 'missing' : p.status;
    return { c, status };
  });
}

export function matchingCriteria(entries, filter) {
  const matches = entries.filter(({ c, status }) => {
    if (filter.codes.size && !filter.codes.has(codeOf(c))) return false;
    const outcome = status === 'flag' ? 'fail' : status === 'clean' ? 'ok' : status;
    if (filter.outcome === 'issues') return outcome === 'fail' || outcome === 'part';
    return filter.outcome === 'any' || outcome === filter.outcome;
  });
  if (filter.severity) matches.sort((a, b) => rank[a.status] - rank[b.status]);
  return matches;
}

export function criterionChoices(checklists) {
  const choices = new Map();
  for (const cl of checklists) {
    for (const c of cl.criteria || []) {
      const code = codeOf(c);
      if (!choices.has(code)) choices.set(code, new Set());
      choices.get(code).add(c.name || code);
    }
  }
  return [...choices].sort(([a], [b]) => a.localeCompare(b, 'ru', { numeric: true }));
}

export function criterionControls(filter, onChange, registry = false) {
  const caption = h('span', { class: 'criterion-caption' });
  const summary = h('summary', null, icon('chevron', 14), 'Критерии', caption);
  const options = h('div', { class: 'criterion-options', role: 'group', 'aria-label': 'Выберите критерии' });
  const select = h('select', { class: 'select', onchange: () => { filter.outcome = select.value; changed(); } },
    Object.entries(outcomes).map(([key, label]) => h('option', { value: key }, label)));
  const ordering = h('input', { type: 'checkbox', class: 'cb', onchange: () => { filter.severity = ordering.checked; changed(); } });
  const clear = h('button', { class: 'link-btn', type: 'button', onclick: () => { reset(); summary.focus(); } }, 'Сбросить');
  const hint = registry && h('span', { class: 'muted' }, 'Достаточно совпадения по одному критерию.');
  const el = h('details', { class: 'criterion-filter' }, summary, options,
    h('div', { class: 'criterion-settings' },
      h('label', null, 'Результат', select),
      h('label', { class: 'criterion-order' }, ordering, 'Сначала невыполненные'),
      clear), hint);
  let choices = [];
  let signature;

  function sync() {
    select.value = filter.outcome;
    ordering.checked = filter.severity;
    for (const input of options.querySelectorAll('input')) input.checked = filter.codes.has(input.value);
    const chosen = [...filter.codes];
    const description = chosen.length === 1 ? (choices.find(([code]) => code === chosen[0])?.[1][0] || chosen[0])
      : chosen.join(', ');
    caption.textContent = [description, filter.outcome !== 'any' && outcomes[filter.outcome], filter.severity && 'Сначала невыполненные'].filter(Boolean).join(' · ') || 'Все';
    clear.hidden = !hasCriteria(filter) && !filter.severity;
    if (hint) hint.hidden = chosen.length < 2;
  }
  function changed() { sync(); onChange(); }
  function reset() {
    filter.codes.clear();
    filter.outcome = 'any';
    filter.severity = false;
    changed();
  }
  function setChoices(next) {
    const list = next.map(([code, names]) => [code, [...names]]);
    // A link to an older checklist can still be cleared even if its code is absent.
    for (const code of filter.codes) if (!list.some(([key]) => key === code)) list.push([code, [code]]);
    const key = JSON.stringify(list);
    if (key !== signature) {
      choices = list;
      signature = key;
      options.replaceChildren(...list.map(([code, names]) => h('label', { title: names.join(' / ') },
        h('input', { type: 'checkbox', class: 'cb', value: code, onchange: (e) => {
          if (e.target.checked) filter.codes.add(code); else filter.codes.delete(code);
          changed();
        } }), h('small', null, code), names[0])));
    }
    sync();
  }
  return { el, setChoices, reset, sync };
}
