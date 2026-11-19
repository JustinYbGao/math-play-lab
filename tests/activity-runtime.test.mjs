import test from 'node:test';
import assert from 'node:assert/strict';
import { createExactMath } from '../public/sandbox.js';
import { bindActivityRuntime, createActivityRuntime } from '../public/activity-runtime.js';

function makeAssessment(overrides = {}) {
  return { version: 1, requiresReview: false,
    fields: [{ id: 'parent', initial: '' }, { id: 'child', initial: '' }, { id: 'branch', initial: '' },
      { id: 'reason', initial: '' }],
    checkpoints: [
      { id: 'dependent', field: 'child', dependsOn: ['parent_proof'], watchFields: [],
        rule: { kind: 'exact', expected: '24' }, feedback: 'Combine all four equal layers.' },
      { id: 'branch_proof', field: 'branch', dependsOn: [], watchFields: [],
        rule: { kind: 'exact', expected: '2' }, feedback: 'Count one pair at a time.' },
      { id: 'parent_proof', field: 'parent', dependsOn: [], watchFields: [],
        rule: { kind: 'exact', expected: '6' }, feedback: 'Use length times width to count one layer.' },
    ], ...overrides };
}

test('prerequisites block early submissions and dependency order need not match array order', () => {
  const activity = createActivityRuntime(makeAssessment(), createExactMath());
  activity.set('child', '24');
  assert.equal(activity.submit('dependent'), 'blocked');
  assert.equal(activity.getState().checkpoints.dependent, 'blocked');
  activity.set('parent', '6');
  assert.equal(activity.submit('parent_proof'), 'correct');
  assert.equal(activity.submit('dependent'), 'correct');
  assert.equal(activity.getState().complete, false);
  activity.set('branch', '2');
  assert.equal(activity.submit('branch_proof'), 'correct');
  assert.equal(activity.getState().complete, true);
});

test('an explicit self-watch target is valid and changing it invalidates the checkpoint and descendants', () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'answer', initial: '' }, { id: 'followup', initial: '' }],
    checkpoints: [
      { id: 'answer_check', field: 'answer', dependsOn: [], watchFields: ['answer'],
        rule: { kind: 'exact', expected: '4' }, feedback: 'Check the answer.' },
      { id: 'followup_check', field: 'followup', dependsOn: ['answer_check'], watchFields: [],
        rule: { kind: 'exact', expected: '8' }, feedback: 'Check the follow-up.' },
    ] };
  const activity = createActivityRuntime(assessment, createExactMath());
  activity.set('answer', '4');
  assert.equal(activity.submit('answer_check'), 'correct');
  activity.set('followup', '8');
  assert.equal(activity.submit('followup_check'), 'correct');
  assert.equal(activity.getState().complete, true);

  activity.set('answer', '5');
  assert.equal(activity.getState().checkpoints.answer_check, 'unanswered');
  assert.equal(activity.getState().checkpoints.followup_check, 'unanswered');
  assert.equal(activity.getState().complete, false);

  for (const watchFields of [['answer', 'answer'], ['unknown']]) {
    const invalid = { ...assessment, checkpoints: [
      { ...assessment.checkpoints[0], watchFields }, assessment.checkpoints[1],
    ] };
    assert.throws(() => createActivityRuntime(invalid, createExactMath()), TypeError);
  }
});

test('editing a watched parent invalidates its dependent but preserves an independent branch', () => {
  const activity = createActivityRuntime(makeAssessment(), createExactMath());
  activity.set('parent', '6'); activity.submit('parent_proof');
  activity.set('child', '24'); activity.submit('dependent');
  activity.set('branch', '2'); activity.submit('branch_proof');
  activity.set('branch', '3');
  assert.equal(activity.getState().checkpoints.parent_proof, 'correct');
  assert.equal(activity.getState().checkpoints.dependent, 'correct');
  assert.equal(activity.getState().checkpoints.branch_proof, 'unanswered');
  activity.set('branch', '2');
  assert.equal(activity.getState().checkpoints.branch_proof, 'unanswered');
  activity.submit('branch_proof');
  activity.set('parent', '7');
  assert.equal(activity.getState().checkpoints.parent_proof, 'unanswered');
  assert.equal(activity.getState().checkpoints.dependent, 'unanswered');
  assert.equal(activity.getState().checkpoints.branch_proof, 'correct');
  assert.equal(activity.getState().values.child, '24');
  activity.set('parent', '6');
  assert.equal(activity.getState().checkpoints.parent_proof, 'unanswered');
  assert.equal(activity.submit('dependent'), 'blocked');
  activity.submit('parent_proof');
  assert.equal(activity.submit('dependent'), 'correct');
});

test('no-op edits preserve confirmations and changed failed answers invalidate dependents', () => {
  const activity = createActivityRuntime(makeAssessment(), createExactMath());
  activity.set('parent', '5');
  assert.equal(activity.submit('parent_proof'), 'incorrect');
  assert.equal(activity.submit('dependent'), 'blocked');
  activity.set('parent', '5');
  assert.equal(activity.getState().checkpoints.parent_proof, 'incorrect');
  activity.set('parent', '6');
  assert.equal(activity.getState().checkpoints.parent_proof, 'unanswered');
  assert.equal(activity.getState().checkpoints.dependent, 'unanswered');
  activity.set('parent', '5');
  assert.equal(activity.getState().checkpoints.parent_proof, 'unanswered');
  assert.throws(() => activity.set('parent', 'x'.repeat(4097)), RangeError);
});

test('oversized known-field edits clear drafts and revoke successful dependent confirmations', () => {
  const activity = createActivityRuntime(makeAssessment(), createExactMath());
  activity.set('parent', '6'); activity.submit('parent_proof');
  activity.set('child', '24'); activity.submit('dependent');
  activity.set('branch', '2'); activity.submit('branch_proof');
  assert.equal(activity.getState().complete, true);

  assert.throws(() => activity.set('parent', '9'.repeat(4097)), RangeError);
  assert.equal(activity.getState().values.parent, '');
  assert.equal(activity.getState().checkpoints.parent_proof, 'unanswered');
  assert.equal(activity.getState().checkpoints.dependent, 'unanswered');
  assert.equal(activity.getState().checkpoints.branch_proof, 'correct');
  assert.equal(activity.getState().complete, false);

  activity.set('parent', '6'); activity.submit('parent_proof'); activity.submit('dependent');
  assert.equal(activity.getState().complete, true);
  activity.reset();
  assert.equal(activity.getState().values.parent, '');
  assert.equal(activity.getState().complete, false);
});

test('an oversized draft in an already-empty watched field still invalidates confirmations', () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'answer', initial: '4' }, { id: 'watch', initial: '' }],
    checkpoints: [{ id: 'check', field: 'answer', dependsOn: [], watchFields: ['watch'],
      rule: { kind: 'exact', expected: '4' }, feedback: 'Check the answer.' }] };
  const activity = createActivityRuntime(assessment, createExactMath());
  assert.equal(activity.submit('check'), 'correct');
  assert.equal(activity.getState().complete, true);
  assert.throws(() => activity.set('watch', '9'.repeat(4097)), error =>
    error instanceof RangeError && error.code === 'ACTIVITY_VALUE_TOO_LONG');
  assert.equal(activity.getState().values.watch, '');
  assert.equal(activity.getState().checkpoints.check, 'unanswered');
  assert.equal(activity.getState().complete, false);
});

test('review checkpoints become pending and never complete the activity', () => {
  const assessment = { version: 1, requiresReview: true, fields: [{ id: 'answer', initial: '' }, { id: 'reason', initial: '' }],
    checkpoints: [
      { id: 'answer_proof', field: 'answer', dependsOn: [], watchFields: [], rule: { kind: 'exact', expected: '4' }, feedback: 'Check the value.' },
      { id: 'reason_proof', field: 'reason', dependsOn: ['answer_proof'], watchFields: [], rule: { kind: 'review' }, feedback: 'Explain your reasoning.' },
    ] };
  const activity = createActivityRuntime(assessment, createExactMath());
  assessment.requiresReview = false;
  activity.set('reason', 'I counted the four equal groups.');
  assert.equal(activity.submit('reason_proof'), 'blocked');
  activity.set('answer', '4'); activity.submit('answer_proof');
  assert.equal(activity.submit('reason_proof'), 'pending');
  assert.deepEqual(activity.getState(), { values: { answer: '4', reason: 'I counted the four equal groups.' },
    checkpoints: { answer_proof: 'correct', reason_proof: 'pending' }, complete: false, pendingReview: true });
  assert.throws(() => createActivityRuntime({ ...assessment, requiresReview: false }, createExactMath()), TypeError);
});

test('pending review prerequisites may allow dependent work while keeping the activity review-only', () => {
  const assessment = { version: 1, requiresReview: true,
    fields: [{ id: 'reason', initial: '' }, { id: 'answer', initial: '' }],
    checkpoints: [
      { id: 'reason_check', field: 'reason', dependsOn: [], watchFields: [], rule: { kind: 'review' }, feedback: 'Add reasoning.' },
      { id: 'answer_check', field: 'answer', dependsOn: ['reason_check'], watchFields: [],
        rule: { kind: 'exact', expected: '8' }, feedback: 'Check the product.' },
    ] };
  const activity = createActivityRuntime(assessment, createExactMath());
  activity.set('reason', 'I multiplied the side lengths.');
  assert.equal(activity.submit('reason_check'), 'pending');
  activity.set('answer', '8');
  assert.equal(activity.submit('answer_check'), 'correct');
  assert.equal(activity.getState().pendingReview, true);
  assert.equal(activity.getState().complete, false);
});

test('state snapshots and source assessment mutations cannot change runtime state; reset restores all initials', () => {
  const assessment = makeAssessment();
  const activity = createActivityRuntime(assessment, createExactMath());
  const seen = [];
  const unsubscribe = activity.subscribe(snapshot => seen.push(snapshot));
  activity.set('parent', '6');
  activity.submit('parent_proof');
  const snapshot = activity.getState();
  snapshot.values.parent = 'wrong'; snapshot.checkpoints.parent_proof = 'incorrect';
  assessment.fields[0].initial = 'mutated';
  assessment.checkpoints[2].rule.expected = '0';
  assert.equal(activity.getState().values.parent, '6');
  assert.equal(activity.getState().checkpoints.parent_proof, 'correct');
  assert.ok(seen.length > 0);
  seen[0].values.parent = 'listener mutation';
  assert.equal(activity.getState().values.parent, '6');
  unsubscribe();
  activity.reset();
  assert.deepEqual(activity.getState(), { values: { parent: '', child: '', branch: '', reason: '' },
    checkpoints: { dependent: 'unanswered', branch_proof: 'unanswered', parent_proof: 'unanswered' },
    complete: false, pendingReview: false });
  assert.throws(() => activity.set('missing', '1'), TypeError);
  assert.throws(() => activity.submit('missing'), TypeError);
});

test('subscriber rendering errors propagate instead of hiding a broken generated view', () => {
  const activity = createActivityRuntime(makeAssessment(), createExactMath());
  activity.subscribe(() => { throw new Error('diagram render failed'); });
  assert.throws(() => activity.set('parent', '6'), /diagram render failed/);
  assert.equal(activity.getState().values.parent, '6');
  const falsyThrow = createActivityRuntime(makeAssessment(), createExactMath());
  falsyThrow.subscribe(() => { throw 0; });
  assert.throws(() => falsyThrow.set('parent', '6'));
});

test('bound checkbox controls are rejected so raw value binding cannot misgrade them', () => {
  const activity = createActivityRuntime(makeAssessment(), createExactMath());
  const checkbox = { tagName: 'INPUT', type: 'checkbox', value: 'on',
    getAttribute: name => name === 'data-mpl-field' ? 'parent' : null };
  const documentStub = { querySelectorAll: selector => selector === '[data-mpl-field]' ? [checkbox] : [] };
  assert.throws(() => bindActivityRuntime(activity, documentStub), TypeError);
});

test('assessment validation rejects cycles, unknown keys, duplicate IDs, and oversized fields', () => {
  const valid = makeAssessment();
  assert.throws(() => createActivityRuntime({ ...valid, extra: true }, createExactMath()), TypeError);
  const cycle = makeAssessment({ checkpoints: [
    { id: 'one', field: 'parent', dependsOn: ['two'], watchFields: [], rule: { kind: 'exact', expected: '1' }, feedback: '' },
    { id: 'two', field: 'child', dependsOn: ['one'], watchFields: [], rule: { kind: 'exact', expected: '2' }, feedback: '' },
  ] });
  assert.throws(() => createActivityRuntime(cycle, createExactMath()), TypeError);
  assert.throws(() => createActivityRuntime(makeAssessment({ fields: [{ id: 'parent', initial: 'x'.repeat(4097) }] }), createExactMath()), TypeError);
  assert.throws(() => createActivityRuntime(makeAssessment({ checkpoints: [
    { id: 'dependent', field: 'child', dependsOn: ['missing'], watchFields: [],
      rule: { kind: 'exact', expected: '24' }, feedback: '' },
  ] }), createExactMath()), TypeError);
  assert.throws(() => createActivityRuntime(makeAssessment({ fields: [
    { id: 'parent', initial: '' }, { id: 'parent', initial: '' },
  ] }), createExactMath()), TypeError);
  assert.throws(() => createActivityRuntime(makeAssessment({ checkpoints: [
    { id: 'only_step', field: 'parent', dependsOn: [], watchFields: [],
      rule: { kind: 'exact', expected: '6' }, feedback: '   ' },
  ] }), createExactMath()), TypeError);
});

test('relation references auto-watch non-primary fields and invalidate descendants only', () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'a', initial: '' }, { id: 'b', initial: '' }, { id: 'followup', initial: '' }, { id: 'branch', initial: '' }],
    checkpoints: [
      { id: 'sum', field: 'a', dependsOn: [], watchFields: [], rule: { kind: 'relation', integerFields: [], conditions: [
        { left: '[a] + [b]', operator: 'eq', right: '10' },
        { left: '[a]', operator: 'gte', right: '0' },
        { left: '[b]', operator: 'gte', right: '0' },
      ] }, feedback: 'Keep both counts nonnegative and make the total ten.' },
      { id: 'follow', field: 'followup', dependsOn: ['sum'], watchFields: [],
        rule: { kind: 'exact', expected: '1' }, feedback: 'Check the follow-up.' },
      { id: 'branch_check', field: 'branch', dependsOn: [], watchFields: [],
        rule: { kind: 'exact', expected: '2' }, feedback: 'Check this independent branch.' },
    ] };
  const activity = createActivityRuntime(assessment, createExactMath());
  activity.set('a', '3'); activity.set('b', '7'); activity.set('followup', '1'); activity.set('branch', '2');
  assert.equal(activity.submit('sum'), 'correct');
  assert.equal(activity.submit('follow'), 'correct');
  assert.equal(activity.submit('branch_check'), 'correct');
  assert.equal(activity.getState().complete, true);

  activity.set('b', '6');
  assert.equal(activity.getState().checkpoints.sum, 'unanswered');
  assert.equal(activity.getState().checkpoints.follow, 'unanswered');
  assert.equal(activity.getState().checkpoints.branch_check, 'correct');
  assert.equal(activity.getState().complete, false);

  activity.set('b', '7'); activity.submit('sum'); activity.submit('follow');
  activity.set('b', '14/2');
  assert.equal(activity.getState().checkpoints.sum, 'unanswered');
  assert.equal(activity.getState().checkpoints.follow, 'unanswered');
  assert.equal(activity.getState().checkpoints.branch_check, 'correct');
});

test('relation checkpoint references must exist and include the primary field', () => {
  const relation = { kind: 'relation', integerFields: [], conditions: [
    { left: '[a] + [missing]', operator: 'eq', right: '10' },
  ] };
  const base = { version: 1, requiresReview: false,
    fields: [{ id: 'a', initial: '' }, { id: 'b', initial: '' }],
    checkpoints: [{ id: 'sum', field: 'a', dependsOn: [], watchFields: [], rule: relation, feedback: 'Check the total.' }] };
  assert.throws(() => createActivityRuntime(base, createExactMath()), TypeError);
  const noPrimaryReference = { ...base, checkpoints: [{ ...base.checkpoints[0], field: 'b',
    rule: { kind: 'relation', integerFields: [], conditions: [{ left: '[a]', operator: 'eq', right: '3' }] } }] };
  assert.throws(() => createActivityRuntime(noPrimaryReference, createExactMath()), TypeError);
});
