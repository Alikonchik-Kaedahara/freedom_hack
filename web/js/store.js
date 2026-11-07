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
  knowledge: null,
};

const listeners = new Set();
let resultsRequest = 0;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what) { for (const fn of listeners) fn(what); }

export async function boot() {
  const [datasets, checklists, settings, knowledge] = await Promise.all([api.datasets(), api.checklists(), api.settings(), api.knowledge().catch(() => null)]);
  Object.assign(state, { datasets, checklists, settings, knowledge });
  const group = (datasets.find((d) => d.groupId === settings.activeGroup) || datasets[datasets.length - 1])?.groupId;
  if (group) await loadGroup(group, false);
}

export async function loadGroup(groupId, persist = true) {
  resultsRequest++;
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
  const group = state.group;
  const request = ++resultsRequest;
  const results = await api.results(group);
  if (group !== state.group || request !== resultsRequest) return;
  if (JSON.stringify(results) === JSON.stringify(state.results)) return;
  setResults(results);
  emit('results');
}

function setResults(results) {
  state.results = results;
  state.summaries = {};
  for (const [k, r] of Object.entries(results)) state.summaries[k] = summarize(r);
}

export function putResult(result) {
  resultsRequest++;
  // single-result responses carry no operator name; keep the one the list gave us
  if (result.operator == null && state.results[result.key]?.operator != null) result.operator = state.results[result.key].operator;
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

export async function refreshKnowledge() {
  state.knowledge = await api.knowledge(state.group);
  emit('knowledge');
  return state.knowledge;
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
