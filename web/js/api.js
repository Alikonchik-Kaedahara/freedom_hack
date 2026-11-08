// Thin client for the CQA server API. All paths are relative so the UI can be
// hosted under any base path (e.g. as a Dynamics 365 web resource behind a proxy).

let BASE = window.CQA_API_BASE || '';

/** Point the widget at a CQA server on another origin (e.g. when embedded in Dynamics 365). */
export function setApiBase(base) {
  BASE = (base || '').replace(/\/$/, '');
  window.CQA_API_BASE = BASE;
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка сервера (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const e = encodeURIComponent;

async function upload(url, file, fields = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  const res = await fetch(BASE + url, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка сервера (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  datasets: () => req('GET', '/api/datasets'),
  importDataset: (groupId) => req('POST', '/api/datasets/import', { groupId }),
  uploadDataset: (file, groupId) => upload('/api/datasets/upload', file, { groupId }),
  dataset: (g) => req('GET', `/api/datasets/${e(g)}`),
  exportResults: (dataset, g) => req('GET', `/api/export/${e(dataset)}?group=${e(g)}`),

  checklists: () => req('GET', '/api/checklists'),
  saveChecklist: (c) => req('PUT', `/api/checklists/${e(c.id)}`, c),
  deleteChecklist: (id) => req('DELETE', `/api/checklists/${e(id)}`),

  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  engineStatus: () => req('GET', '/api/engine/status'),

  results: (g) => req('GET', `/api/results?group=${e(g)}`),
  confirmReview: (key, body) => req('POST', `/api/results/${e(key)}/confirm`, body),
  draftCoaching: (key, id, body) => req('POST', `/api/results/${e(key)}/coaching/${e(id)}`, body),
  saveCoaching: (key, id, body) => req('PUT', `/api/results/${e(key)}/coaching/${e(id)}`, body),
  appeal: (key, body) => req('POST', `/api/results/${e(key)}/appeals`, body),
  decide: (key, id, body) => req('POST', `/api/results/${e(key)}/appeals/${e(id)}/decision`, body),

  evaluate: (body) => req('POST', '/api/evaluate', body),
  secondOpinion: (body) => req('POST', '/api/second-opinion', body),
  quality: (g, section, operator) => {
    const params = new URLSearchParams({ group: g });
    if (section) params.set('section', section);
    if (operator != null) params.set('operator', operator);
    return req('GET', `/api/quality?${params}`);
  },
  uploadCalibration: (group, file) => upload(`/api/quality/calibration?group=${e(group)}`, file),
  clearCalibration: (group) => req('DELETE', `/api/quality/calibration?group=${e(group)}`),
  calibrationInfo: (group) => req('GET', `/api/quality/calibration?group=${e(group)}`),
  annotationUrl: (group, who) => `${BASE}/api/quality/calibration?group=${e(group)}&who=${e(who)}`,
  operators: (g) => req('GET', `/api/operators?group=${e(g)}`),
  setOperator: (key, name) => req('PUT', `/api/results/${e(key)}/operator`, { name }),
  knowledge: (g) => req('GET', `/api/knowledge${g ? `?group=${e(g)}` : ''}`),
  saveKnowledge: (doc) => req('PUT', '/api/knowledge', doc),
  resetKnowledge: () => req('POST', '/api/knowledge/reset'),
  reportUrl: (g, cid, format = 'html') => `${BASE}/report/${e(g)}/${e(cid)}${format === 'pdf' ? '?format=pdf' : ''}`,
  job: (id) => req('GET', `/api/jobs/${e(id)}`),
  jobs: () => req('GET', '/api/jobs'),

  audioUrl: (g, cid) => `${BASE}/api/audio/${e(g)}/${e(cid)}`,
};
