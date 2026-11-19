import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRepairPatch, planSchema, validatePlan, validatePage, validateRepairPatch } from '../server/contracts.mjs';
import { readyPlan, fixtureHtml, fixtureRepair, fixtureRepairedHtml, legacyFixtureRepair,
  legacyFixtureRepairedHtml, fixturePage, fixturePlaytest } from './fixtures.mjs';

test('ready and clarification plans satisfy the structured contract', () => {
  assert.equal(validatePlan(readyPlan), readyPlan);
  const clarification = { ...readyPlan, status: 'clarify', title: '', problem: '', topics: [], constraints: [],
    referenceAnswer: '', objective: '', initialState: '', invariants: [], actions: [], hints: [],
    winCondition: '', explanation: '', clarification: 'Which diagram is intended?', assessment: null };
  assert.equal(validatePlan(clarification), clarification);
});

test('ready plans reject blank or repeated hints, blank actions, malformed values and unknown properties', () => {
  const invalidPlans = [
    { ...readyPlan, hints: ['Think about balance.', '   '] },
    { ...readyPlan, hints: ['Think about balance.', 'think about balance.'] },
    { ...readyPlan, actions: ['  '] },
    { ...readyPlan, requiresReview: 'false' },
    { ...readyPlan, activityType: 'quiz' },
    { ...readyPlan, invariants: [''] },
    { ...readyPlan, extra: 'not allowed' },
  ];
  for (const plan of invalidPlans) assert.throws(() => validatePlan(plan), error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('page output requires a bounded ready document or a nonblank conflict issue', () => {
  const ready = { status: 'ready', html: '<!doctype html><html><body>Exercise</body></html>', issue: null };
  assert.equal(validatePage(ready), ready);
  const conflict = { status: 'conflict', html: '', issue: 'The plan changes the original domain.' };
  assert.equal(validatePage(conflict), conflict);
  for (const value of [
    { ...ready, issue: '' },
    { ...ready, unknown: true },
    { ...ready, html: '<p>Incomplete</p>' },
    { ...conflict, issue: '   ' },
    { ...conflict, issue: null },
  ]) assert.throws(() => validatePage(value), error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('assessment contracts validate in strict mode while saved legacy plans and pages remain readable', () => {
  const legacyPlan = { ...readyPlan }; delete legacyPlan.assessment;
  const legacyPage = { status: 'ready', html: '<!doctype html><html><body>Exercise</body></html>', issue: null };
  assert.equal(validatePlan(legacyPlan), legacyPlan);
  assert.throws(() => validatePlan(legacyPlan, { requireAssessment: true }), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.equal(validatePage(legacyPage), legacyPage);
  assert.throws(() => validatePage(legacyPage, { requirePlaytest: true }), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.equal(validatePlan(readyPlan, { requireAssessment: true }), readyPlan);
  assert.equal(validatePage(fixturePage, { requirePlaytest: true }), fixturePage);
  assert.equal(validatePage({ status: 'conflict', html: '', issue: 'The task and plan differ.', playtest: null },
    { requirePlaytest: true }).playtest, null);
});

test('assessment rules, targets, dependency graphs, and review mode are checked before page generation', () => {
  const cases = [
    { ...readyPlan, assessment: null },
    { ...readyPlan, assessment: { ...readyPlan.assessment, requiresReview: true } },
    { ...readyPlan, assessment: { ...readyPlan.assessment, fields: [{ id: 'bad id', initial: '' }] } },
    { ...readyPlan, assessment: { ...readyPlan.assessment, checkpoints: [{ ...readyPlan.assessment.checkpoints[0],
      field: 'missing' }, readyPlan.assessment.checkpoints[1]] } },
    { ...readyPlan, assessment: { ...readyPlan.assessment, checkpoints: [
      { ...readyPlan.assessment.checkpoints[0], dependsOn: ['solve'] }, readyPlan.assessment.checkpoints[1]] } },
    { ...readyPlan, assessment: { ...readyPlan.assessment, checkpoints: [
      { ...readyPlan.assessment.checkpoints[0], rule: { kind: 'exact', expected: 'not numeric' } },
      readyPlan.assessment.checkpoints[1]] } },
    { ...readyPlan, assessment: { ...readyPlan.assessment, checkpoints: [
      { ...readyPlan.assessment.checkpoints[0], rule: { kind: 'review' } }, readyPlan.assessment.checkpoints[1]] } },
    { ...readyPlan, assessment: { ...readyPlan.assessment, extra: true } },
  ];
  for (const plan of cases) assert.throws(() => validatePlan(plan, { requireAssessment: true }),
    error => error.code === 'INVALID_MODEL_OUTPUT');
  const clarifyWithAssessment = { ...readyPlan, status: 'clarify', title: '', problem: '', topics: [], constraints: [],
    referenceAnswer: '', objective: '', initialState: '', invariants: [], actions: [], hints: [],
    winCondition: '', explanation: '', clarification: 'Which interval is intended?', assessment: readyPlan.assessment };
  assert.throws(() => validatePlan(clarifyWithAssessment), error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('relation assessment rules are represented in the strict plan schema and validated with their references', () => {
  const relationPlan = { ...readyPlan, assessment: { version: 1, requiresReview: false,
    fields: [{ id: 'a', initial: '' }, { id: 'b', initial: '' }],
    checkpoints: [{ id: 'total', field: 'a', dependsOn: [], watchFields: [], rule: { kind: 'relation',
      integerFields: [], conditions: [{ left: '[a] + [b]', operator: 'eq', right: '10' }] },
      feedback: 'Check the total.' }] } };
  assert.equal(validatePlan(relationPlan, { requireAssessment: true }), relationPlan);
  const rules = planSchema.properties.assessment.anyOf[0].properties.checkpoints.items.properties.rule.anyOf;
  const relation = rules.find(rule => rule.properties.kind.enum.includes('relation'));
  assert.ok(relation);
  assert.deepEqual(relation.required, ['kind', 'integerFields', 'conditions']);
  assert.equal(relation.properties.conditions.minItems, 1);
  assert.equal(relation.properties.conditions.maxItems, 12);

  const unknownField = structuredClone(relationPlan);
  unknownField.assessment.checkpoints[0].rule.conditions[0].left = '[a] + [missing]';
  assert.throws(() => validatePlan(unknownField, { requireAssessment: true }),
    error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('playtest traces are bounded, literal, strict actions and immutable schema objects', () => {
  assert.equal(validatePage(fixturePage, { requirePlaytest: true }), fixturePage);
  const invalidPlaytests = [
    { ...fixturePlaytest, other: [] },
    { ...fixturePlaytest, solve: [] },
    { ...fixturePlaytest, solve: Array.from({ length: 65 }, () => fixturePlaytest.solve[0]) },
    { ...fixturePlaytest, solve: [{ ...fixturePlaytest.solve[0], selector: 'text=answer' }] },
    { ...fixturePlaytest, solve: [{ ...fixturePlaytest.solve[0], selector: '#a\n' }] },
    { ...fixturePlaytest, solve: [{ ...fixturePlaytest.solve[0], action: 'evaluate' }] },
    { ...fixturePlaytest, solve: [{ action: 'click', selector: '#check', value: 'yes' }] },
    { ...fixturePlaytest, solve: [{ action: 'fill', selector: '#answer', value: null }] },
    { ...fixturePlaytest, solve: [{ action: 'press', selector: '#answer', value: 'Delete' }] },
    { ...fixturePlaytest, solve: [{ ...fixturePlaytest.solve[0], extra: true }] },
    { ...fixturePlaytest, invalidate: [{ action: 'fill', selector: '#answer', value: 'x'.repeat(4097) }] },
    { solve: Array(51).fill(fixturePlaytest.solve[0]), wrong: Array(51).fill(fixturePlaytest.wrong[0]),
      recover: Array(51).fill(fixturePlaytest.recover[0]), invalidate: Array(51).fill(fixturePlaytest.invalidate[0]) },
  ];
  for (const playtest of invalidPlaytests) {
    assert.throws(() => validatePage({ ...fixturePage, playtest }), error => error.code === 'INVALID_MODEL_OUTPUT');
  }
  assert.throws(() => validatePage({ ...fixturePage, playtest: null }), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.throws(() => validatePage({ status: 'conflict', html: '', issue: 'Mismatch.', playtest: fixturePlaytest }),
    error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('repair patches are strict, bounded, and applied as unique exact strings', () => {
  assert.equal(validateRepairPatch(fixtureRepair), fixtureRepair);
  assert.equal(applyRepairPatch(fixtureHtml, legacyFixtureRepair), legacyFixtureRepairedHtml);
  assert.equal(validateRepairPatch({ status: 'conflict', edits: [], issue: 'The plan contradicts the task.' }).status, 'conflict');
  assert.equal(applyRepairPatch('<html><body>a.b</body></html>', {
    status: 'ready', edits: [{ find: '.', replace: '!' }], issue: null,
  }), '<html><body>a!b</body></html>');

  const invalidPatches = [
    { status: 'ready', edits: [], issue: null },
    { status: 'ready', edits: [{ find: '', replace: 'x' }], issue: null },
    { status: 'ready', edits: [{ find: 'x', replace: 'x' }], issue: null },
    { status: 'ready', edits: [{ find: 'x', replace: 'y', extra: true }], issue: null },
    { status: 'ready', edits: [{ find: 'x', replace: 'y' }], issue: 'unexpected' },
    { status: 'ready', edits: [{ find: 'x', replace: 1 }], issue: null },
    { status: 'ready', edits: [{ find: 'x'.repeat(12001), replace: 'y' }], issue: null },
    { status: 'ready', edits: Array.from({ length: 7 }, () => ({ find: 'x', replace: 'y' })), issue: null },
    { status: 'ready', edits: [
      { find: 'a'.repeat(4000), replace: 'b'.repeat(4001) },
      { find: 'c'.repeat(4000), replace: 'd'.repeat(4001) },
      { find: 'e'.repeat(4000), replace: 'f'.repeat(4001) },
    ], issue: null },
    { status: 'conflict', edits: [{ find: 'x', replace: 'y' }], issue: 'Conflicting.' },
    { status: 'conflict', edits: [], issue: '   ' },
    { status: 'ready', edits: [{ find: 'x', replace: 'y' }], issue: null, raw: 'not allowed' },
  ];
  for (const patch of invalidPatches) {
    assert.throws(() => validateRepairPatch(patch), error => error.code === 'INVALID_MODEL_OUTPUT');
  }

  for (const [html, find] of [
    ['<html><body>present</body></html>', 'missing'],
    ['<html><body>x</body><p>x</p></html>', 'x'],
    ['<html><body>aaa</body></html>', 'aa'],
  ]) {
    assert.throws(() => applyRepairPatch(html, { status: 'ready', edits: [{ find, replace: 'y' }], issue: null }),
      error => error.code === 'INVALID_MODEL_OUTPUT');
  }
  assert.throws(() => applyRepairPatch('<html><body>keep</body></html>', {
    status: 'ready', edits: [{ find: '</html>', replace: '</body>' }], issue: null,
  }), error => error.code === 'INVALID_MODEL_OUTPUT');
});
