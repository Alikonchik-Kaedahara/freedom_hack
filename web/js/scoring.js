// Scoring rules from the organizers' checklist ("Порядок расчёта"):
// 1. N/A only where allowed.  2. Yes = full weight, No = 0, scale = chosen step.
// 3. Scale steps are converted proportionally; the top step gives the full weight.
// 4. N/A criteria are excluded and their weight is redistributed (max stays 100).
// 5. Total is rounded to 2 decimals; no applicable weighted criteria -> no total.
//    Gross errors (flag criteria) are reported separately and give no points.

// Half-up to two decimals on the exact value: 25.5 / 80 * 100 is 31.874999999999996 in floating
// point but 31.875 in arithmetic, so the float is first settled to nine decimals (mirrors cqa/scoring.py).
export const round2 = (x) => Math.round(Math.round(x * 1e9) / 1e7) / 100;

export function scaleMax(c) {
  return Math.max(0, ...(c.scale || []).map((s) => Number(s.value)));
}

/** Answers with accepted appeal decisions applied. */
/** The checked section for «no gross error»: every operator reply (0-based indices). */
export const checkedTurns = (record) => (record?.transcript || []).map((t, i) => (t.speaker === 'operator' ? i : -1)).filter((i) => i >= 0);

/** Evidence to show for an answer; a clean flag without evidence shows the operator replies that were checked. */
export function evidenceOf(ans, c, record) {
  const ev = ans?.evidence || [];
  if (!ev.length && c?.type === 'flag' && ans?.answer === 'no') return checkedTurns(record);
  return ev;
}

export function finalAnswers(result) {
  const out = {};
  for (const [k, v] of Object.entries(result.answers || {})) out[k] = { ...v };
  for (const ap of result.appeals || []) {
    if (ap.status === 'accepted' && ap.decision && ap.decision.answer != null && out[ap.criterionId]) {
      out[ap.criterionId] = { ...out[ap.criterionId], answer: ap.decision.answer, overridden: true };
    }
  }
  return out;
}

export function score(checklist, answers) {
  const per = {};
  const sections = {};
  let earned = 0, possible = 0, gross = false, grossIds = [];

  for (const c of checklist.criteria) {
    const a = answers?.[c.id]?.answer;
    if (c.type === 'flag') {
      const hit = a === 'yes';
      if (hit) { gross = true; grossIds.push(c.id); }
      per[c.id] = { kind: 'flag', hit, status: hit ? 'flag' : 'clean' };
      continue;
    }
    if (a === undefined || a === null) { per[c.id] = { kind: 'missing', status: 'na' }; continue; }
    const weight = Number(c.weight) || 0;
    if (a === 'na') { per[c.id] = { kind: 'na', weight, status: 'na' }; continue; }
    if (weight <= 0) { per[c.id] = { kind: 'zero', weight, status: 'na' }; continue; }

    let ratio;
    if (c.type === 'scale') {
      const max = scaleMax(c);
      ratio = max > 0 ? Number(a) / max : 0;
    } else {
      ratio = a === 'yes' ? 1 : 0;
    }
    const points = ratio * weight;
    earned += points;
    possible += weight;
    per[c.id] = { kind: c.type, weight, points, ratio, status: ratio >= 1 ? 'ok' : ratio <= 0 ? 'fail' : 'part' };

    const sec = c.section || 'Без раздела';
    sections[sec] ||= { earned: 0, possible: 0 };
    sections[sec].earned += points;
    sections[sec].possible += weight;
  }

  for (const p of Object.values(per)) {
    if (p.points != null && possible > 0) {
      p.effWeight = round2((p.weight / possible) * 100);
      p.effPoints = round2((p.points / possible) * 100);
    }
  }
  for (const s of Object.values(sections)) s.pct = s.possible > 0 ? round2((s.earned / s.possible) * 100) : null;

  const total = possible > 0 ? round2((earned / possible) * 100) : null;
  return { total, gross, grossIds, per, sections, earned, possible };
}

/**
 * Criteria the reviewer should look at: the model's answer failed validation after all
 * retries (needsReview), the model itself reported low confidence, or a second opinion
 * gave a different verdict. Mirrors cqa/scoring.py.
 */
export function disputedIds(result) {
  const out = [];
  for (const source of [result, result?.secondOpinion]) {
    for (const [id, a] of Object.entries(source?.answers || {})) {
      if ((a?.needsReview || a?.confidence === 'low') && !out.includes(id)) out.push(id);
    }
  }
  const cmp = result?.secondOpinion?.comparison || {};
  for (const id of [...(cmp.disagree || []), ...(cmp.near || [])]) if (!out.includes(id)) out.push(id);
  return out;
}

export function disputeLabel(a) {
  if (a?.needsReview) return { text: 'Требует проверки', cls: 'red', why: (a.issues || []).join(' ') };
  if (a?.confidence === 'low') return { text: 'Низкая уверенность', cls: 'amber', why: 'Система не уверена в ответе — проверьте вручную.' };
  return null;
}

export const CONFIDENCE_LABEL = { high: 'высокая', medium: 'средняя', low: 'низкая' };

/** Summary of a stored result: original vs final (after appeals). */
export function summarize(result) {
  if (!result) return null;
  const original = score(result.checklist, result.answers);
  const final = score(result.checklist, finalAnswers(result));
  const pending = (result.appeals || []).filter((a) => a.status === 'pending').length;
  const disputed = disputedIds(result);
  return { original, final, total: final.total, gross: final.gross, pending, changed: original.total !== final.total, disputed };
}

/** Human verdict for one criterion answer. */
export function verdictOf(c, answer) {
  if (answer === undefined || answer === null) return { text: '—', cls: 'na' };
  if (answer === 'na') return { text: 'Не применим', cls: 'na' };
  if (c.type === 'flag') return answer === 'yes' ? { text: 'Выявлено', cls: 'fail' } : { text: 'Нет', cls: 'ok' };
  if (c.type === 'scale') {
    const max = scaleMax(c);
    const r = max ? Number(answer) / max : 0;
    return { text: `${answer}`, max, cls: r >= 1 ? 'ok' : r <= 0 ? 'fail' : 'part' };
  }
  return answer === 'yes' ? { text: 'Да', cls: 'ok' } : { text: 'Нет', cls: 'fail' };
}

export function answerOptions(c) {
  if (c.type === 'scale') {
    const opts = [...(c.scale || [])].sort((a, b) => b.value - a.value).map((s) => ({ value: Number(s.value), label: String(s.value) }));
    if (c.naAllowed) opts.push({ value: 'na', label: 'Не применим' });
    return opts;
  }
  if (c.type === 'flag') return [{ value: 'yes', label: 'Выявлено' }, { value: 'no', label: 'Нет' }];
  const opts = [{ value: 'yes', label: 'Да' }, { value: 'no', label: 'Нет' }];
  if (c.naAllowed) opts.push({ value: 'na', label: 'Не применим' });
  return opts;
}
