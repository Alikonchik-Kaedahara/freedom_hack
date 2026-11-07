// node --test tests/scoring.test.mjs
// The browser scorer (web/js/scoring.js) against the shared fixture. tests/test_scoring.py runs the
// Python mirror (cqa/scoring.py) on the same file, so both implementations must agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { score, summarize, finalAnswers, disputedIds, round2 } from '../web/js/scoring.js';

import { criterionChoices, criterionEntries, matchingCriteria, readCriteria, worstRank, writeCriteria } from '../web/js/criterion-filter.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'scoring_cases.json'), 'utf8'));

for (const c of fixture.cases) {
  test(`score: ${c.name}`, () => {
    const s = score(fixture.checklist, c.answers);
    const e = c.expected;
    assert.equal(s.total, e.total, 'total');
    if ('gross' in e) assert.equal(s.gross, e.gross, 'gross');
    if ('grossIds' in e) assert.deepEqual(s.grossIds, e.grossIds);
    if ('possible' in e) assert.equal(s.possible, e.possible, 'possible');
    if ('earned' in e) assert.equal(round2(s.earned), e.earned, 'earned');
    if (e.sections) for (const [name, pct] of Object.entries(e.sections)) assert.equal(s.sections[name].pct, pct, `section ${name}`);
  });
}

test('weights sum to 100 after N/A redistribution (pdf example)', () => {
  const c = fixture.cases.find((x) => x.name === 'pdf_example_na_on_03');
  const s = score(fixture.checklist, c.answers);
  const eff = Object.values(s.per).filter((p) => p.effWeight != null).reduce((a, p) => a + p.effWeight, 0);
  assert.equal(round2(eff), 100);
  assert.equal(s.per.c3.kind, 'na');
  assert.equal(s.per.c1.effWeight, 12.5);
  assert.equal(s.per.c4.effWeight, 25);
});

test('summarize: appeal decisions change the final total but not the original', () => {
  const a = fixture.appeal;
  const result = { checklist: fixture.checklist, answers: a.answers, appeals: a.appeals };
  const s = summarize(result);
  assert.equal(s.original.total, a.expected.originalTotal);
  assert.equal(s.total, a.expected.total);
  assert.equal(s.pending, a.expected.pending);
  assert.equal(s.changed, a.expected.changed);
  assert.equal(finalAnswers(result).c5.overridden, true);
  assert.equal(result.answers.c5.answer, 'no', 'original answers are never mutated');
});

test('disputedIds: needsReview or low confidence', () => {
  const result = { answers: { c1: { answer: 'yes', confidence: 'high' }, c2: { answer: 'no', confidence: 'low' }, c3: { answer: null, needsReview: true } } };
  assert.deepEqual(disputedIds(result), ['c2', 'c3']);
  assert.equal(summarize({ ...result, checklist: fixture.checklist }).disputed.length, 2);
});

test('disputedIds: a second opinion that disagrees (or lands one step away) is disputed too', () => {
  const result = {
    answers: { c1: { answer: 'yes', confidence: 'high' }, c2: { answer: 'no', confidence: 'low' } },
    secondOpinion: { comparison: { agree: ['c1'], disagree: ['c7'], near: ['c4', 'c2'] } },
  };
  assert.deepEqual(disputedIds(result), ['c2', 'c7', 'c4']);
});

test('no applicable weighted criteria -> no total', () => {
  const checklist = { criteria: [{ id: 'x', type: 'binary', weight: 100, naAllowed: true }, { id: 'f', type: 'flag', weight: 0 }] };
  const s = score(checklist, { x: { answer: 'na' }, f: { answer: 'yes' } });
  assert.equal(s.total, null);
  assert.equal(s.gross, true);
});

test('filter dialogs by any selected criterion and only its final verdict', () => {
  const entries = sampleEntries({ c1: 'no', c3: 'no', c4: 10, c7: 'yes' });
  const filter = readCriteria(new URLSearchParams('c=03&c=04&outcome=issues&order=severity'));
  assert.deepEqual(matchingCriteria(entries, filter).map(({ c, status }) => [c.code, status]), [['03', 'fail'], ['04', 'part']]);
  filter.outcome = 'part';
  assert.deepEqual(matchingCriteria(entries, filter).map(({ c }) => c.code), ['04']);
  filter.outcome = 'fail';
  assert.deepEqual(matchingCriteria(entries, filter).map(({ c }) => c.code), ['03']);
  const appealed = sampleEntries({ c3: 'no', c4: 10 }, [{ status: 'accepted', criterionId: 'c3', decision: { answer: 'yes' } }]);
  assert.deepEqual(matchingCriteria(appealed, filter), []);
});

test('order dialogues by the selected criterion, with missing and unevaluated records last', () => {
  const f = readCriteria(new URLSearchParams('c=04&order=severity'));
  const answers = [null, { c4: 10 }, { c4: 20, c7: 'no' }, {}, { c4: 0 }, { c4: 'na' }];
  const ordered = answers.map((data, i) => [i, worstRank(matchingCriteria(data ? sampleEntries(data) : [], f))])
    .sort((a, b) => a[1] - b[1]).map(([i]) => i);
  assert.deepEqual(ordered, [4, 1, 2, 5, 3, 0]);
  assert.deepEqual(matchingCriteria(sampleEntries({}), { ...f, outcome: 'na' }), []);
});

test('gross error counts as failure while a missing flag is unassessed', () => {
  const f = readCriteria(new URLSearchParams('c=08&outcome=fail'));
  assert.deepEqual(matchingCriteria(sampleEntries({ c8: 'yes' }), f).map((e) => e.status), ['flag']);
  assert.deepEqual(matchingCriteria(sampleEntries({ c8: 'no' }), f), []);
  f.outcome = 'ok';
  assert.deepEqual(matchingCriteria(sampleEntries({ c8: 'no' }), f).map((e) => e.status), ['clean']);
  assert.deepEqual(matchingCriteria(sampleEntries({}), f), []);
});

test('old violation links and multiple checklist codes round trip with operator scope', () => {
  const params = new URLSearchParams({ violation: '07', operator: 'Саша' });
  const f = readCriteria(params);
  assert.deepEqual([...f.codes], ['07']);
  assert.equal(f.outcome, 'issues');
  f.codes.add('спец,1');
  f.severity = true;
  writeCriteria(params, f);
  assert.equal(params.get('operator'), 'Саша');
  assert.equal(params.has('violation'), false);
  assert.deepEqual(readCriteria(new URLSearchParams(params.toString())), f);
  const choices = criterionChoices([{ criteria: [{ code: '07', name: 'Контакт' }, { id: 'спец,1', name: 'Бонус' }] },
    { criteria: [{ code: '07', name: 'Приветствие' }] }]);
  assert.deepEqual(choices.map(([code, names]) => [code, [...names]]), [['07', ['Контакт', 'Приветствие']], ['спец,1', ['Бонус']]]);
});

function sampleEntries(values, appeals = []) {
  const answers = Object.fromEntries(Object.entries(values).map(([id, answer]) => [id, { answer }]));
  const result = { checklist: fixture.checklist, answers, appeals };
  return criterionEntries(result, summarize(result).final);
}
