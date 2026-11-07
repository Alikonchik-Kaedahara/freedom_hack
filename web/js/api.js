// Thin client for the CQA server API. All paths are relative so the UI can be
// hosted under any base path (e.g. as a Dynamics 365 web resource behind a proxy).

const BASE = window.CQA_API_BASE || '';

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

export const api = {
  datasets: () => req('GET', '/api/datasets'),
  importDataset: (groupId) => req('POST', '/api/datasets/import', { groupId }),
  dataset: (g) => req('GET', `/api/datasets/${e(g)}`),

  checklists: () => req('GET', '/api/checklists'),
  saveChecklist: (c) => req('PUT', `/api/checklists/${e(c.id)}`, c),
  deleteChecklist: (id) => req('DELETE', `/api/checklists/${e(id)}`),

  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  engineStatus: () => req('GET', '/api/engine/status'),

  results: (g) => req('GET', `/api/results?group=${e(g)}`),
  appeal: (key, body) => req('POST', `/api/results/${e(key)}/appeals`, body),
  decide: (key, id, body) => req('POST', `/api/results/${e(key)}/appeals/${e(id)}/decision`, body),

  evaluate: (body) => req('POST', '/api/evaluate', body),
  job: (id) => req('GET', `/api/jobs/${e(id)}`),
  jobs: () => req('GET', '/api/jobs'),

  audioUrl: (g, cid) => `${BASE}/api/audio/${e(g)}/${e(cid)}`,
};
