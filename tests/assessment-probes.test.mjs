import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyIndependentChecks, validateIndependentChecks } from '../server/assessment-probes.mjs';
import { readyPlan } from './fixtures.mjs';

const assessment = readyPlan.assessment;
const passed = { status: 'passed', testedFields: ['removed', 'solution'], untestedFields: [], equivalentChecks: 2 };

test('independent coverage accepts only an exact partition of assessment fields', () => {
  assert.equal(validateIndependentChecks(passed, assessment), true);
  assert.equal(validateIndependentChecks({ status: 'partial', testedFields: ['removed'],
    untestedFields: ['solution'], equivalentChecks: 0 }, assessment), true);
  assert.deepEqual(emptyIndependentChecks(assessment), { status: 'partial', testedFields: [],
    untestedFields: ['removed', 'solution'], equivalentChecks: 0 });
});

test('independent coverage rejects missing, duplicate, overlapping, and unassessed fields', () => {
  for (const value of [
    { ...passed, testedFields: ['removed'] },
    { ...passed, testedFields: ['removed', 'removed'], untestedFields: ['solution'] },
    { ...passed, untestedFields: ['solution'] },
    { ...passed, testedFields: ['removed', 'solution', 'extra'] },
    { ...passed, status: 'partial' },
    { ...passed, equivalentChecks: -1 },
    { ...passed, equivalentChecks: 1.5 },
    { ...passed, extra: true },
  ]) assert.equal(validateIndependentChecks(value, assessment), false, JSON.stringify(value));
  assert.equal(validateIndependentChecks(passed, { fields: [null] }), false);
  assert.deepEqual(emptyIndependentChecks({ fields: [null] }), { status: 'passed', testedFields: [],
    untestedFields: [], equivalentChecks: 0 });
});
