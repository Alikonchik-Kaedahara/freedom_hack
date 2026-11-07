// node --test tests/scoring.test.mjs
// The browser scorer (web/js/scoring.js) against the shared fixture. tests/test_scoring.py runs the
// Python mirror (cqa/scoring.py) on the same file, so both implementations must agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { score, summarize, finalAnswers, disputedIds, round2 } from '../web/js/scoring.js';

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

test('no applicable weighted criteria -> no total', () => {
  const checklist = { criteria: [{ id: 'x', type: 'binary', weight: 100, naAllowed: true }, { id: 'f', type: 'flag', weight: 0 }] };
  const s = score(checklist, { x: { answer: 'na' }, f: { answer: 'yes' } });
  assert.equal(s.total, null);
  assert.equal(s.gross, true);
});
