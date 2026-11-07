// Settings: which model scores dialogs (cloud or on-premises), the name in result exports, Dynamics 365 integration.
import { h, icon, toast } from '../ui.js';
import { api } from '../api.js';
import { state, saveSettings } from '../store.js';
import { hostFrame } from '../app.js';
import { D365Bridge } from '../bridge.js';
import { openExportModal } from './export.js';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', price: [4, 20] },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', price: [2, 10] },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', price: [0.1, 0.5] },
];
// Typical size of one evaluation: checklist + transcript in, verdicts out (with thinking).
const TYPICAL = { input: 4500, output: 2500 };

// part: 'model' (which model scores), 'export' (results file), 'integration' (Dynamics 365)
export function renderModel(root, part = 'model') {
  const page = h('div', { class: 'page' });
  root.append(page);
  let status = null;

  const draw = () => {
    const s = state.settings;
    const engine = s.engine || 'cloud';
    const model = MODELS.find((m) => m.id === s.cloud.model) || MODELS[0];
    const cost = costPerDialog(model);

    const keyInput = h('input', { class: 'input', type: 'password', placeholder: s.cloud.hasKey ? 'Ключ сохранён' : 'Ключ доступа к API', autocomplete: 'off' });
    keyInput.addEventListener('change', async () => {
      if (!keyInput.value.trim()) return;
      await save({ cloud: { apiKey: keyInput.value.trim() } });
      keyInput.value = '';
    });

    const cloud = h('div', { class: `card engine ${engine === 'cloud' ? 'on' : ''}`, onclick: () => engine !== 'cloud' && save({ engine: 'cloud' }) },
      h('div', { class: 'engine-top' },
        h('div', { class: 'engine-icon' }, icon('cloud', 20)),
        h('div', null, h('h3', null, 'Облачная модель'), h('div', { class: 'desc' }, `Claude (Anthropic) · ${model.label}`),
          engine === 'cloud' ? h('span', { class: 'active-badge' }, 'Активна') : null),
        h('span', { class: 'radio', role: 'radio', 'aria-checked': String(engine === 'cloud') })),
      h('div', { class: 'price' }, h('b', null, `$${cost.value.toFixed(3)}`), h('span', null, cost.actual ? 'за диалог по факту' : 'за диалог, предварительно')),
      h('div', { class: 'field', onclick: (e) => e.stopPropagation() }, h('label', null, 'Модель'),
        h('select', { class: 'select', onchange: (e) => save({ cloud: { model: e.target.value } }) },
          MODELS.map((m) => h('option', { value: m.id, selected: m.id === model.id ? 'selected' : null }, `${m.label} (${m.id})`)))),
      s.cloud.hasKey
        ? h('span', { class: 'status ok' }, h('i'), 'Ключ API подключён')
        : h('div', { class: 'field', onclick: (e) => e.stopPropagation() }, h('label', null, 'Ключ API'), keyInput),
      engine === 'cloud' && !s.cloud.hasKey ? statusEl() : null);

    const urlInput = h('input', { class: 'input', value: s.local.url, onchange: (e) => save({ local: { url: e.target.value.trim() } }) });
    const modelInput = h('input', { class: 'input', value: s.local.model, list: 'ollama-models', onchange: (e) => save({ local: { model: e.target.value.trim() } }) });
    const local = h('div', { class: `card engine ${engine === 'local' ? 'on' : ''}`, onclick: () => engine !== 'local' && save({ engine: 'local' }) },
      h('div', { class: 'engine-top' },
        h('div', { class: 'engine-icon' }, icon('server', 20)),
        h('div', null, h('h3', null, 'Модель на своём сервере'), h('div', { class: 'desc' }, 'Ollama или vLLM внутри компании'),
          engine === 'local' ? h('span', { class: 'active-badge' }, 'Активна') : null),
        h('span', { class: 'radio', role: 'radio', 'aria-checked': String(engine === 'local') })),
      h('div', { class: 'price' }, h('b', null, '$0'), h('span', null, 'диалоги не покидают контур компании')),
      h('div', { class: 'field', onclick: (e) => e.stopPropagation() }, h('label', null, 'Адрес сервера'), urlInput),
      h('div', { class: 'field', onclick: (e) => e.stopPropagation() }, h('label', null, 'Модель'), modelInput,
        h('datalist', { id: 'ollama-models' }, (status?.models || []).map((m) => h('option', { value: m })))),
      engine === 'local' ? statusEl() : null);

    // Replay: answers saved earlier (demo/sample, demo/snapshot or previous results) — the demo
    // never waits for an API and never spends money. Unknown criteria are marked "требует проверки".
    const replay = h('div', { class: `card engine ${engine === 'replay' ? 'on' : ''}`, onclick: () => engine !== 'replay' && save({ engine: 'replay' }) },
      h('div', { class: 'engine-top' },
        h('div', { class: 'engine-icon' }, icon('refresh', 20)),
        h('div', null, h('h3', null, 'Без модели'), h('div', { class: 'desc' }, 'Повтор сохранённых оценок'),
          engine === 'replay' ? h('span', { class: 'active-badge' }, 'Активна') : null),
        h('span', { class: 'radio', role: 'radio', 'aria-checked': String(engine === 'replay') })),
      h('div', { class: 'price' }, h('b', null, '$0'), h('span', null, 'для показа и проверки интерфейса')),
      h('div', { class: 'desc', style: { fontSize: '12.5px', lineHeight: 1.5 } },
        'Берёт ответы из уже сделанных оценок и не обращается к модели. ',
        'Критерий без сохранённого ответа получает пометку «требует проверки», а не выдуманный вердикт.'),
      engine === 'replay' ? statusEl() : null);

    // team_name for results/<dev|prod>/results.json (the organizers' submission format)
    const teamInput = h('input', { class: 'input', value: s.teamName || '', placeholder: 'Название подразделения или команды', autocomplete: 'off' });
    const team = h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Название в файле результатов'),
      h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Подразделение или команда, от имени которой выгружаются результаты.'),
      h('div', { style: { display: 'flex', gap: '10px', maxWidth: '520px' } }, teamInput,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => save({ teamName: teamInput.value.trim() }) }, 'Сохранить название')));
    const download = h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Файл результатов'),
      h('div', { class: 'muted', style: { marginBottom: '10px' } }, `Оценки набора ${state.group}: по одному объекту на диалог, восемь критериев и итоговый балл.`),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: openExportModal }, icon('download', 15), 'Скачать результаты'));

    const linked = D365Bridge.ready;
    const integration = h('div', { class: 'card card-pad' },
      h('h3', { class: 'card-title' }, 'Dynamics 365'),
      h('div', { class: `status ${linked ? 'ok' : ''}`, style: { marginBottom: '8px' } }, h('i'),
        hostFrame.embedded ? 'Связь с Dynamics 365 активна' : linked ? 'Связь с рабочим пространством активна (показ встраивания)' : 'Приложение открыто отдельно от Dynamics 365'),
      h('div', { class: 'muted', style: { marginBottom: '12px' } }, hostFrame.status),
      hostFrame.embedded ? null : h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: hostFrame.on, onchange: (e) => { hostFrame.set(e.target.checked); draw(); } }),
        h('span', { class: 'track' }), 'Показывать рамку рабочего пространства Dynamics 365'));

    const head = (title, sub) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), h('div', { class: 'sub' }, sub)));
    if (part === 'export') {
      page.replaceChildren(head('Выгрузка', 'Файл результатов для отчётности и проверки.'), h('div', { class: 'grid two-one' }, download, team));
    } else if (part === 'integration') {
      page.replaceChildren(head('Интеграция', 'Встраивание в рабочее пространство Dynamics 365.'), integration);
    } else {
      page.replaceChildren(
        head('Модель оценки', 'Какая модель оценивает диалоги. Баллы и перераспределение N/A считает сама система по правилам чек-листа.'),
        h('div', { class: 'engines' }, cloud, local, replay));
    }
  };

  const statusEl = () => {
    if (!status) return h('span', { class: 'status' }, h('i'), 'Проверяем…');
    return h('span', { class: `status ${status.ok ? 'ok' : 'bad'}` }, h('i'), status.message);
  };

  async function save(patch) {
    try {
      await saveSettings(patch);
      status = null;
      draw();
      check();
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  async function check() {
    try { status = await api.engineStatus(); } catch { status = { ok: false, message: 'Сервер недоступен' }; }
    draw();
  }

  draw();
  check();
  return null;
}

function costPerDialog(model) {
  const costs = Object.values(state.results)
    .filter((r) => r.engine?.type === 'cloud' && r.engine.model === model.id && r.usage?.costUsd)
    .map((r) => r.usage.costUsd);
  if (costs.length) return { value: costs.reduce((a, b) => a + b, 0) / costs.length, actual: true };
  return { value: (TYPICAL.input * model.price[0] + TYPICAL.output * model.price[1]) / 1e6, actual: false };
}
