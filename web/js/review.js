import { state, resultFor, summaryFor } from './store.js';

export const reviewVersion = (result) => result.reviewVersion || result.createdAt || 'legacy';

export function currentReview(result, id) {
  const log = result?.reviewLog || [];
  const entry = log.findLast((e) => e.criterionId === id && e.version === reviewVersion(result));
  if (entry || !result || result.reviewVersion) return entry;
  // Decisions recorded before explicit review tracking also complete the criterion.
  const appeal = result.appeals?.findLast((a) => a.criterionId === id && a.decision);
  return appeal && { by: appeal.decision.by, at: appeal.decision.decidedAt, source: 'appeal' };
}

export function reviewCriteria(cid, queue = 'all') {
  const res = resultFor(cid), s = summaryFor(cid);
  if (!res || !s) return [];
  const pending = (res.appeals || []).filter((a) => a.status === 'pending').map((a) => a.criterionId);
  const groups = { gross: s.final.grossIds, disputed: s.disputed, appeal: pending };
  const ids = groups[queue] || [...groups.gross, ...pending, ...groups.disputed];
  return [...new Set(ids)].filter((id) => (pending.includes(id) || !currentReview(res, id))
    && res.checklist.criteria.some((c) => c.id === id));
}

export function reviewLink(cid, queue = 'all') {
  const criterion = reviewCriteria(cid, queue)[0];
  const path = `#/dialog/${encodeURIComponent(cid)}`;
  return criterion ? path + '?' + new URLSearchParams({ criterion, queue }) : path;
}

// Continue through the same filtered, sorted registry that the reviewer opened.
let selection;
export function rememberReviewList(ids) {
  selection = { group: state.group, ids };
}

export function nextReviewLink(cid, queue) {
  if (reviewCriteria(cid, queue).length) return reviewLink(cid, queue);
  const ids = selection?.group === state.group && selection.ids.includes(cid)
    ? selection.ids : state.records.map((r) => r.conversation_id);
  const i = ids.indexOf(cid);
  const next = [...ids.slice(i + 1), ...ids.slice(0, i)].find((id) => reviewCriteria(id, queue).length);
  return next ? reviewLink(next, queue) : null;
}
