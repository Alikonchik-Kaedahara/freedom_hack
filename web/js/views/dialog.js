// Screens 4–7: dialog card — transcript, call player, criteria inspector,
// evidence jumps, gross error banner and appeal submission.
import { h, icon, fmtScore, scoreClass, channelLabel, openModal, toast, fmtDate, moreMenu } from '../ui.js';
import { api } from '../api.js';
import { state, subscribe, resultFor, summaryFor, putResult, keyOf } from '../store.js';
import { finalAnswers, score, verdictOf, round2, disputeLabel, CONFIDENCE_LABEL } from '../scoring.js';
import { startEvaluation, confirmSecondOpinion, isRunning } from '../jobs.js';
import { createPlayer } from '../player.js';
import { openReview, byLine } from './appeals.js';
import { requireUser } from '../user.js';

const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
const openSets = new Map(); // conversation id -> Set of open criterion ids

export function displayTimes(transcript) {
  if (!transcript.length) return [];
  const t0 = Date.parse(transcript[0].timestamp);
  if (Number.isNaN(t0)) return transcript.map((m) => m.timestamp || '');
  return transcript.map((m) => {
    const d = Math.max(0, Math.round((Date.parse(m.timestamp) - t0) / 1000));
    return `${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`;
  });
}

const EV_CLASS = { fail: 'red', flag: 'red', ok: 'green', part: 'amber', na: '', clean: 'green' };
const HL_CLASS = { fail: 'hl-red', flag: 'hl-red', ok: 'hl-green', part: 'hl-amber', na: 'hl-gray', clean: 'hl-green' };

export function renderDialog(root, cid) {
  const rec = state.byId[cid];
  if (!rec) { location.hash = '#/dialogs'; return null; }
  const isCall = rec.channel === 'voice call';
  const times = displayTimes(rec.transcript);
  if (!openSets.has(cid)) openSets.set(cid, new Set());
  const open = openSets.get(cid);

  // ----- transcript -----
  const msgEls = rec.transcript.map((m, i) => {
    const sp = m.speaker || 'system';
    const timeEl = isCall
      ? h('button', { class: 't', type: 'button', title: 'Слушать с этого места', onclick: () => player?.seekToIndex(i, true) }, times[i])
      : h('span', { class: 't' }, times[i]);
    return h('div', { class: `msg ${sp}`, id: `m-${i}`, 'data-i': i },
      h('div', { class: 'meta' }, sp === 'bot' ? icon('bot', 13) : null, h('span', { class: 'who' }, SPEAKER[sp] || sp), '·', timeEl),
      h('div', { class: 'bubble' }, m.text));
  });
  const transcriptBody = h('div', { class: 'panel-body' }, h('div', { class: 'transcript' }, msgEls));

  let player = null;
  let karaokeIdx = -1;
  if (isCall && rec.audio_url) {
    player = createPlayer({
      src: api.audioUrl(state.group, cid),
      transcript: rec.transcript,
      onIndex: (idx, playing) => {
        if (karaokeIdx >= 0) msgEls[karaokeIdx]?.classList.remove('karaoke');
        karaokeIdx = idx;
        if (idx >= 0) {
          msgEls[idx].classList.add('karaoke');
          if (playing && (!isMobile() || page.dataset.tab === 'chat')) scrollToMsg(idx, false);
        }
      },
    });
  }

  function scrollToMsg(i, flash = true) {
    const el = msgEls[i];
    if (!el) return;
    if (isMobile()) {
      if (page.dataset.tab !== 'chat') return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      const body = transcriptBody;
      const top = el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2;
      body.scrollTo({ top, behavior: 'smooth' });
    }
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  // Phones: one panel at a time, switched by tabs. Evidence jumps open the chat.
  function setTab(tab) {
    page.dataset.tab = tab;
    for (const b of tabsEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab);
  }

  let activeHl = null;
  function highlight(ids, cls) {
    if (activeHl) for (const i of activeHl.ids) msgEls[i]?.classList.remove(activeHl.cls);
    activeHl = ids.length ? { ids, cls } : null;
    for (const i of ids) msgEls[i]?.classList.add(cls);
  }
  function jump(ids, status, focus, fromUser = false) {
    highlight(ids, HL_CLASS[status] || 'hl-gray');
    const target = focus ?? ids[0];
    if (target != null) {
      if (fromUser && isMobile()) {
        setTab('chat');
        setTimeout(() => scrollToMsg(target), 60);
      } else {
        scrollToMsg(target);
      }
      if (player) player.seekToIndex(target);
    }
  }

  // ----- layout -----
  const headHost = h('div');
  const bannerHost = h('div');
  const inspector = h('div', { class: 'panel-body' });
  const scoreTabLabel = h('span');
  const tabsEl = h('div', { class: 'm-tabs' },
    h('div', { class: 'segmented' },
      h('button', { type: 'button', 'data-tab': 'score', onclick: () => { setTab('score'); window.scrollTo({ top: 0 }); } }, icon('checks', 16), scoreTabLabel),
      h('button', { type: 'button', 'data-tab': 'chat', onclick: () => setTab('chat') }, icon(isCall ? 'phone' : 'chat', 16), isCall ? 'Звонок' : 'Переписка')));
  const page = h('div', { class: 'page fill' },
    headHost, bannerHost, tabsEl,
    h('div', { class: 'review' },
      h('div', { class: 'card panel chat-panel' }, player?.el, transcriptBody),
      h('div', { class: 'card panel score-panel' }, inspector)));
  root.append(page);
  setTab(resultFor(cid) ? 'score' : 'chat');

  function drawHead() {
    const res = resultFor(cid);
    const s = summaryFor(cid);
    const running = isRunning(cid) || (state.job?.status === 'running');
    const op = (res?.operator || '').trim();
    const sub = [channelLabel(rec.channel), rec.language, op ? `Оператор ${op}` : null].filter(Boolean).join(' · ');
    const menu = res ? moreMenu([
      { label: res.secondOpinion ? 'Второе мнение ещё раз' : 'Второе мнение', onClick: () => confirmSecondOpinion([cid]) },
      { label: 'Скачать отчёт', href: `${window.CQA_API_BASE || ''}/report/${encodeURIComponent(state.group)}/${encodeURIComponent(cid)}`, target: '_blank' },
      { label: 'Указать оператора', onClick: () => renameOperator(res) },
    ]) : null;
    headHost.replaceChildren(h('div', { class: 'page-head' },
      h('div', { class: 'head-left' },
        h('button', { class: 'back-btn', type: 'button', onclick: () => (history.length > 1 ? history.back() : (location.hash = '#/dialogs')), 'aria-label': 'Назад' }, icon('back', 17)),
        h('div', null,
          h('h1', null, h('span', { class: 'h1-word' }, 'Диалог '), h('span', { class: 'mono-id' }, cid)),
          h('div', { class: 'sub' }, sub, s ? [' · ', h('b', { class: `score ${scoreClass(s.total)}` }, fmtScore(s.total))] : null))),
      h('div', { class: 'head-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: running, onclick: () => startEvaluation([cid]) }, res ? 'Переоценить' : 'Оценить'),
        menu)));
  }

  /** «Указать оператора»: fix the name taken from the first reply; an empty field returns to automatic detection. */
  function renameOperator(res) {
    const current = (res.operator || '').trim();
    const input = h('input', { class: 'input', value: ['Не представился', '[Имя скрыто]'].includes(current) ? '' : current, placeholder: 'Имя оператора', maxlength: 60 });
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
    const m = openModal({
      title: 'Указать оператора', sub: 'Пустое поле вернёт имя из первой реплики оператора.',
      body: h('div', { class: 'field' }, h('label', null, 'Имя'), input),
      footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Отмена'), save],
    });
    setTimeout(() => input.focus(), 30);
    const go = async () => {
      save.disabled = true;
      try {
        putResult(await api.setOperator(keyOf(cid), input.value.trim()));
        m.close();
        toast('Оператор сохранён');
      } catch (e) { toast(e.message, { type: 'error' }); save.disabled = false; }
    };
    save.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  function secondOpinionNote(res, c) {
    const so = res.secondOpinion;
    if (!so) return null;
    const d = so.comparison?.details?.[c.id];
    if (!d) return null;
    const second = so.answers?.[c.id];
    const v2 = verdictOf(c, d.second);
    if (d.status === 'agree') {
      return h('div', { class: 'so-note agree' }, icon('check', 13), `Второе мнение: совпало — ${v2.text}`);
    }
    return h('div', { class: `so-note ${d.status === 'near' ? 'near' : 'disagree'}` },
      icon('alert', 13),
      h('div', null,
        h('b', null, d.status === 'near' ? 'Второе мнение: на ступень рядом — ' : 'Второе мнение расходится — '), `${v2.text}`,
        second?.explanation ? h('div', { class: 'so-expl' }, second.explanation) : null));
  }

  function knowledgeNote(ans) {
    const ids = ans?.contradicts || [];
    if (!ids.length) return null;
    const facts = state.knowledge?.facts || [];
    return h('div', { class: 'kb-note' }, icon('alert', 13),
      h('div', null, h('b', null, 'Противоречие справочнику фактов'),
        ids.map((id) => {
          const f = facts.find((x) => x.id === id);
          return h('div', { class: 'kb-fact' }, h('span', { class: 'mono' }, id), ' ', f ? f.fact : '— факт не найден в текущем справочнике');
        }),
        h('a', { href: '#/settings/knowledge', class: 'link-btn', style: { fontSize: '12px', marginTop: '4px' } }, 'Открыть справочник')));
  }

  function drawBanner() {
    const res = resultFor(cid);
    const s = summaryFor(cid);
    for (const el of msgEls) el.classList.remove('gross');
    if (!res || !s?.gross) { bannerHost.replaceChildren(); return; }
    const fa = finalAnswers(res);
    const crit = res.checklist.criteria.find((c) => c.type === 'flag' && fa[c.id]?.answer === 'yes');
    const ev = fa[crit.id]?.evidence || [];
    for (const i of ev) msgEls[i]?.classList.add('gross');
    bannerHost.replaceChildren(h('div', { class: 'gross-banner', role: 'alert' },
      h('div', { class: 'gb-text' }, h('b', null, 'Грубая ошибка'), ' — ', fa[crit.id]?.explanation || crit.name),
      ev.length ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { open.add(crit.id); drawInspector(); jump(ev, 'flag', null, true); } }, 'Показать в диалоге') : null));
  }

  function drawInspector() {
    const res = resultFor(cid);
    if (isRunning(cid)) {
      scoreTabLabel.textContent = 'Оценка…';
      inspector.replaceChildren(h('div', { class: 'inspector' },
        h('div', { class: 'skeleton', style: { height: '150px', borderRadius: '16px' } }),
        [1, 2, 3, 4, 5].map(() => h('div', { class: 'skeleton', style: { height: '58px' } }))));
      return;
    }
    if (!res) {
      scoreTabLabel.textContent = 'Оценка';
      inspector.replaceChildren(h('div', { class: 'empty', style: { paddingTop: '80px' } },
        h('h3', null, 'Диалог ещё не оценён'),
        h('p', null, `Оценка по чек-листу «${activeChecklistName(rec)}»`),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: state.job?.status === 'running', onclick: () => startEvaluation([cid]) }, 'Оценить')));
      return;
    }
    const fa = finalAnswers(res);
    const sc = score(res.checklist, fa);
    const orig = score(res.checklist, res.answers);
    scoreTabLabel.textContent = `Оценка · ${fmtScore(sc.total)}`;

    const sections = Object.entries(sc.sections);
    // Technical details (checklist version, engine, cost, prompt hash) only on hover over ⓘ.
    const total = h('div', { class: 'total-card' },
      h('div', { class: 'lbl' }, 'Итоговый балл',
        h('span', { class: 'info-dot', tabindex: 0, role: 'img', 'aria-label': 'Подробности оценки', title: provenanceText(res) }, 'i')),
      h('div', { class: `val ${scoreClass(sc.total)}` }, fmtScore(sc.total), h('small', null, ' / 100')),
      orig.total !== sc.total ? h('div', { class: 'was' }, 'До апелляции ', h('s', null, fmtScore(orig.total))) : null,
      sections.length > 1 ? h('div', { class: 'sections' }, sections.map(([name, s]) =>
        h('div', { class: 'section-row' },
          h('span', { class: 'n' }, name),
          h('div', { class: 'bar' }, h('i', { style: { width: `${s.pct ?? 0}%` } })),
          h('span', { class: 'p' }, s.pct == null ? '—' : `${Math.round(s.pct)}%`)))) : null);

    const groups = [];
    let lastSec = null;
    for (const c of res.checklist.criteria) {
      if (c.section && c.section !== lastSec) { groups.push(h('div', { class: 'sec-title' }, c.section)); lastSec = c.section; }
      groups.push(critCard(res, c, fa[c.id], res.answers[c.id], sc));
    }
    const scroll = inspector.scrollTop;
    inspector.replaceChildren(h('div', { class: 'inspector' }, total, groups));
    inspector.scrollTop = scroll;
  }

  function critCard(res, c, ans, origAns, sc) {
    const p = sc.per[c.id] || {};
    const status = p.status || 'na';
    const v = verdictOf(c, ans?.answer);
    const isOpen = open.has(c.id);
    const appeals = (res.appeals || []).filter((a) => a.criterionId === c.id);
    const pending = appeals.find((a) => a.status === 'pending');
    const stIcon = { ok: 'check', fail: 'x', part: 'minus', na: 'minus', flag: 'alert', clean: 'check' }[status];
    const ev = ans?.evidence || [];

    const toggle = () => {
      if (open.has(c.id)) { open.delete(c.id); highlight([], ''); } else { open.add(c.id); if (ev.length) jump(ev, status); }
      drawInspector();
    };

    const verdict = c.type === 'scale' && ans?.answer !== 'na'
      ? h('span', { class: `verdict ${v.cls}` }, v.text, h('small', null, ` / ${v.max}`))
      : h('span', { class: `verdict ${v.cls}` }, v.text);

    const evLabel = status === 'fail' ? 'Проверенный участок' : status === 'na' ? 'Основание' : 'Доказательство';
    const dispute = disputeLabel(ans);
    const body = isOpen ? h('div', { class: 'crit-body' },
      ans?.explanation ? h('div', { class: 'expl' }, ans.explanation) : null,
      dispute ? h('div', { class: `dispute ${dispute.cls}` },
        icon('alert', 15), h('div', null, h('b', null, dispute.text), ' — ', dispute.why || '')) : null,
      ans?.confidence ? h('div', { class: 'conf-line' }, `Уверенность оценки: ${CONFIDENCE_LABEL[ans.confidence] || ans.confidence}`) : null,
      secondOpinionNote(res, c),
      knowledgeNote(ans),
      interpretationOf(res, c) ? h('details', { class: 'interp' },
        h('summary', null, icon('checks', 13), 'Как читается это правило'),
        h('div', { class: 'interp-body' }, interpretationOf(res, c))) : null,
      ev.length ? h('div', null,
        h('div', { class: 'ev-label' }, evLabel),
        h('div', { class: 'ev-list' }, ev.map((i) =>
          h('button', { class: `ev ${EV_CLASS[status] || ''}`, type: 'button', onclick: (e) => { e.stopPropagation(); jump(ev, status, i, true); } },
            icon('clock', 14), times[i] || `#${i}`)))) : null,
      appeals.map((a) => appealBox(res, c, a, origAns)),
      h('div', { class: 'crit-foot' },
        h('span', null, pointsText(c, p, sc)),
        !pending ? h('button', { class: 'link-btn', type: 'button', onclick: (e) => { e.stopPropagation(); openAppeal(res, c); } }, 'Подать апелляцию') : null)) : null;

    return h('div', { class: `crit ${isOpen ? 'open' : ''} ${status === 'flag' ? 'is-flag' : ''}` },
      h('div', { class: 'crit-head', onclick: toggle },
        h('span', { class: `st ${status}` }, icon(stIcon, 16, 2.6)),
        h('div', { class: 'nm' }, h('small', null, c.code), c.name),
        h('div', { class: 'vd' }, pending ? h('span', { class: 'tag amber', title: 'Апелляция' }, icon('scale', 13)) : null,
          dispute && !ans?.overridden ? h('span', { class: `tag ${dispute.cls}`, title: dispute.text }, icon('alert', 13), h('span', { class: 'tag-text' }, dispute.text)) : null,
          ans?.overridden ? h('span', { class: 'tag green' }, 'изменено') : null, verdict)),
      body);
  }

  function provenanceText(res) {
    const parts = [`Чек-лист «${res.checklist.name}», версия ${res.checklist.version} · ${fmtDate(res.createdAt)}`];
    if (res.engine?.type === 'replay') parts.push('replay — сохранённый ответ, без вызова модели');
    else if (res.engine?.model) parts.push(`модель ${res.engine.model}`);
    if (res.attempts > 1) parts.push(`${res.attempts} попытки: ответ исправлялся после проверки`);
    if (res.usage?.costUsd) parts.push(`$${res.usage.costUsd.toFixed(3)}`);
    if (res.promptHash) parts.push(`промпт ${res.promptHash}`);
    return parts.join('\n');
  }

  // Base weight from the checklist, the weight after N/A redistribution, and the points earned.
  function pointsText(c, p, sc) {
    if (c.type === 'flag') return h('span', { class: 'weights' }, h('span', null, 'Без баллов · отмечается отдельно'));
    if (p.points == null) return h('span', { class: 'weights' }, h('span', null, 'Базовый вес ', h('b', null, c.weight)), h('span', { class: 'shift' }, 'Не применим → вес перераспределён'));
    const redistributed = sc.possible > 0 && Math.abs(sc.possible - 100) > 0.001;
    return h('span', { class: 'weights' },
      h('span', null, 'Базовый вес ', h('b', null, c.weight)),
      redistributed ? h('span', { class: 'shift' }, 'После перераспределения ', h('b', null, p.effWeight)) : h('span', null, 'Перераспределения нет'),
      h('span', null, 'Баллы ', h('b', null, redistributed ? `${p.effPoints} / ${p.effWeight}` : `${round2(p.points)} / ${c.weight}`)));
  }

  function appealBox(res, c, a, origAns) {
    const st = { pending: ['amber', 'На рассмотрении'], accepted: ['green', 'Принята'], rejected: ['', 'Отклонена'] }[a.status];
    const from = verdictOf(c, origAns?.answer).text;
    const to = a.decision?.answer != null ? verdictOf(c, a.decision.answer).text : null;
    return h('div', { class: 'appeal-box' },
      h('div', { class: 'row' }, h('span', { class: `tag ${st[0]}` }, `Апелляция · ${st[1]}`)),
      h('q', null, a.comment),
      h('div', { class: 'who-line' }, `Подал: ${byLine(a.author, a.createdAt) || '—'}`),
      a.decision ? h('div', null,
        to ? h('div', { class: 'change' }, `Было: ${from} → стало: ${to}`) : h('div', { class: 'change' }, `Оценка «${from}» оставлена`),
        h('div', { class: 'muted' }, a.decision.reason),
        h('div', { class: 'who-line' }, `Решил: ${byLine(a.decision.by, a.decision.decidedAt) || '—'}`)) : null,
      a.status === 'pending' ? h('div', { class: 'actions' },
        h('button', { class: 'btn btn-secondary btn-xs', type: 'button', onclick: (e) => { e.stopPropagation(); openReview(res, a); } }, 'Рассмотреть')) : null);
  }

  async function openAppeal(res, c) {
    const user = await requireUser('Имя попадёт в апелляцию: проверяющий увидит, кто её подал.');
    if (!user) return;
    const fa = finalAnswers(res);
    const v = verdictOf(c, fa[c.id]?.answer);
    const ta = h('textarea', { class: 'textarea', rows: 4, placeholder: 'Почему оценка неверна? Сошлитесь на реплики, если можно.' });
    const send = h('button', { class: 'btn btn-primary', type: 'button' }, 'Отправить апелляцию');
    const m = openModal({
      title: `Подать апелляцию · ${c.code} ${c.name}`,
      sub: `Сейчас: ${v.text}${v.max != null && fa[c.id]?.answer !== 'na' ? ` из ${v.max}` : ''} · подаёт ${user.name}`,
      body: h('div', { class: 'field' }, h('label', null, 'Почему оценку нужно пересмотреть'), ta),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'), send],
    });
    setTimeout(() => ta.focus(), 50);
    send.addEventListener('click', async () => {
      if (!ta.value.trim()) { ta.focus(); return; }
      send.disabled = true;
      try {
        const updated = await api.appeal(res.key, { criterionId: c.id, comment: ta.value.trim(), author: user.name });
        putResult(updated);
        m.close();
        toast('Апелляция отправлена проверяющему');
      } catch (e) {
        toast(e.message, { type: 'error' });
        send.disabled = false;
      }
    });
  }

  function drawAll() { drawHead(); drawBanner(); drawInspector(); }
  drawAll();

  // If the dialog has a gross error, open that criterion and point to it.
  const res0 = resultFor(cid);
  if (res0 && summaryFor(cid)?.gross && !open.size) {
    const fa = finalAnswers(res0);
    const crit = res0.checklist.criteria.find((c) => c.type === 'flag' && fa[c.id]?.answer === 'yes');
    if (crit) { open.add(crit.id); drawInspector(); setTimeout(() => (fa[crit.id].evidence || []).length && scrollToMsg(fa[crit.id].evidence[0]), 200); }
  }

  const off = subscribe((w) => { if (w === 'results' || w === 'job') drawAll(); });
  return () => { off(); player?.destroy(); };
}

const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

function activeChecklistName(rec) {
  const id = state.settings?.active?.[rec.channel];
  return state.checklists.find((c) => c.id === id)?.name || '—';
}

/** The team's reading of a rule: from the checklist copy stored with the result, else from the current checklist
 *  (results evaluated before the field existed still show it). */
function interpretationOf(res, c) {
  if (c.interpretation) return c.interpretation;
  const live = state.checklists.find((x) => x.id === res.checklist?.id);
  return live?.criteria.find((x) => x.id === c.id)?.interpretation || '';
}
