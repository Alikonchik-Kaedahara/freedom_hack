// Application state shared by all views.
import { api } from './api.js';
import { summarize } from './scoring.js';

export const state = {
  datasets: [],
  group: null,
  records: [],
  byId: {},
  results: {},
  summaries: {},
  checklists: [],
  settings: null,
  job: null,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what) { for (const fn of listeners) fn(what); }

export async function boot() {
  const [datasets, checklists, settings] = await Promise.all([api.datasets(), api.checklists(), api.settings()]);
  Object.assign(state, { datasets, checklists, settings });
  const group = (datasets.find((d) => d.groupId === settings.activeGroup) || datasets[datasets.length - 1])?.groupId;
  if (group) await loadGroup(group, false);
}

export async function loadGroup(groupId, persist = true) {
  const [records, results] = await Promise.all([api.dataset(groupId), api.results(groupId)]);
  state.group = groupId;
  state.records = records;
  state.byId = Object.fromEntries(records.map((r) => [r.conversation_id, r]));
  setResults(results);
  if (persist) {
    state.settings = await api.saveSettings({ activeGroup: groupId });
  }
  emit('group');
}

export async function refreshDatasets() {
  state.datasets = await api.datasets();
  emit('datasets');
}

export async function refreshResults() {
  if (!state.group) return;
  setResults(await api.results(state.group));
  emit('results');
}

function setResults(results) {
  state.results = results;
  state.summaries = {};
  for (const [k, r] of Object.entries(results)) state.summaries[k] = summarize(r);
}

export function putResult(result) {
  state.results[result.key] = result;
  state.summaries[result.key] = summarize(result);
  emit('results');
}

export const keyOf = (cid) => `${state.group}:${cid}`;
export const resultFor = (cid) => state.results[keyOf(cid)];
export const summaryFor = (cid) => state.summaries[keyOf(cid)];

export async function refreshChecklists() {
  state.checklists = await api.checklists();
  emit('checklists');
}

export async function saveSettings(patch) {
  state.settings = await api.saveSettings(patch);
  emit('settings');
  return state.settings;
}

export function pendingAppeals() {
  const out = [];
  for (const r of Object.values(state.results)) {
    for (const a of r.appeals || []) if (a.status === 'pending') out.push({ result: r, appeal: a });
  }
  return out;
}

export function allAppeals() {
  const out = [];
  for (const r of Object.values(state.results)) for (const a of r.appeals || []) out.push({ result: r, appeal: a });
  return out.sort((x, y) => (y.appeal.createdAt || '').localeCompare(x.appeal.createdAt || ''));
}
