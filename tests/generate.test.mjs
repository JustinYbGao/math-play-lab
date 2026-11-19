import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGame } from '../server/generate.mjs';
import { readyPlan, fixturePage, fixtureRepair, fixtureRepairedHtml, scriptedModel } from './fixtures.mjs';

const passedIndependentChecks = { status: 'passed', testedFields: ['removed', 'solution'], untestedFields: [],
  equivalentChecks: 2 };
const successfulCheck = (coverage = passedIndependentChecks) => ({ passed: true, playthrough: 'passed',
  independentChecks: structuredClone(coverage), errors: [] });

test('a clarification does not generate or execute code', async () => {
  const plan = { ...readyPlan, status: 'clarify', title: '', problem: '', topics: [], constraints: [],
    referenceAnswer: '', objective: '', initialState: '', invariants: [], actions: [], hints: [],
    winCondition: '', explanation: '', clarification: 'Please provide the diagram.', assessment: null };
  const model = scriptedModel([plan]);
  const result = await generateGame({ problem: 'Find the angle in the diagram.', model,
    check: () => assert.fail('No browser check is appropriate before clarification.') });
  assert.deepEqual(result, { type: 'clarification', question: 'Please provide the diagram.' });
  assert.equal(model.calls.length, 1);
});

test('a new input is preserved and runtime success does not claim mathematical verification', async () => {
  const model = scriptedModel([readyPlan, fixturePage]);
  const stages = [];
  const result = await generateGame({ problem: 'Solve 2x + 3 = 11, showing equivalent operations.',
    model, check: async (html, options) => {
      assert.deepEqual(options.assessment, readyPlan.assessment);
      assert.deepEqual(options.playtest, fixturePage.playtest);
      return { ...successfulCheck(), passed: html === fixturePage.html };
    }, onStage: value => stages.push(value) });
  assert.equal(result.type, 'result');
  assert.equal(result.game.problem, 'Solve 2x + 3 = 11, showing equivalent operations.');
  assert.equal(result.game.objective, readyPlan.objective);
  assert.equal(result.game.activityType, 'solve');
  assert.equal(result.game.requiresReview, false);
  assert.equal(result.game.verification.mathematics, 'not_independently_verified');
  assert.equal(result.game.verification.playthrough, 'passed');
  assert.deepEqual(result.game.verification.independentChecks, passedIndependentChecks);
  assert.deepEqual(result.game.assessment, readyPlan.assessment);
  assert.equal(result.game.repairCount, 0);
  assert.deepEqual(stages, ['understanding', 'building', 'checking']);
  assert.equal(model.calls.length, 2);
});

test('partial field coverage is accepted and cloned into game verification', async () => {
  const coverage = { status: 'partial', testedFields: ['removed'], untestedFields: ['solution'], equivalentChecks: 0 };
  const model = scriptedModel([readyPlan, fixturePage]);
  const result = await generateGame({ problem: readyPlan.problem, model,
    check: async () => ({ passed: true, playthrough: 'passed', independentChecks: coverage, errors: [] }) });
  assert.deepEqual(result.game.verification.independentChecks, coverage);
  assert.notEqual(result.game.verification.independentChecks, coverage);
  assert.notEqual(result.game.verification.independentChecks.testedFields, coverage.testedFields);
});

test('relation-bearing plans reach generation checks with immutable rules and references', async () => {
  const plan = { ...readyPlan, assessment: { version: 1, requiresReview: false,
    fields: [{ id: 'a', initial: '' }, { id: 'b', initial: '' }],
    checkpoints: [{ id: 'sum', field: 'a', dependsOn: [], watchFields: [], rule: { kind: 'relation', integerFields: [],
      conditions: [{ left: '[a] + [b]', operator: 'eq', right: '10' }] }, feedback: 'Check the total.' }] } };
  const coverage = { status: 'passed', testedFields: ['a', 'b'], untestedFields: [], equivalentChecks: 2 };
  const model = scriptedModel([plan, fixturePage]);
  const result = await generateGame({ problem: plan.problem, model, check: async (_html, options) => {
    assert.deepEqual(options.assessment, plan.assessment);
    assert.notEqual(options.assessment, plan.assessment);
    assert.deepEqual(options.playtest, fixturePage.playtest);
    return { passed: true, playthrough: 'passed', independentChecks: coverage, errors: [] };
  } });
  assert.equal(result.type, 'result');
  assert.deepEqual(result.game.assessment, plan.assessment);
  assert.deepEqual(result.game.verification.independentChecks, coverage);
});

test('missing or malformed independent coverage cannot approve a new generation', async () => {
  for (const report of [
    { passed: true, playthrough: 'passed', errors: [] },
    { passed: true, playthrough: 'passed', independentChecks: { status: 'passed', testedFields: ['removed'],
      untestedFields: [], equivalentChecks: 0 }, errors: [] },
  ]) {
    const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
    await assert.rejects(generateGame({ problem: readyPlan.problem, model, check: async () => report }),
      error => error.code === 'RUNTIME_CHECK_FAILED');
    assert.equal(model.calls.length, 3);
  }
});

test('host probe details reach the bounded repair but are generic in saved diagnostics', async () => {
  const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
  const diagnostics = [];
  const error = 'Independent assessment probe failed for field solution during raw-preservation: requested="9" observed="4".';
  let checks = 0;
  await generateGame({ problem: readyPlan.problem, model, onDiagnostic: value => diagnostics.push(value),
    check: async () => ++checks === 1 ? { passed: false, playthrough: 'failed',
      independentChecks: structuredClone(passedIndependentChecks), errors: [error] } : successfulCheck() });
  assert.ok(model.calls[2].input.runtimeErrors.includes(error));
  const failure = diagnostics.find(item => item.type === 'runtime_check' && !item.passed);
  assert.deepEqual(failure.errors, ['An independent assessment field probe failed.']);
  assert.doesNotMatch(JSON.stringify(failure.errors), /solution|requested|observed|"9"/);
});

test('a semantic page conflict stops before browser checks and hides the model issue', async () => {
  const issue = 'The generated page changed the original domain to make the solution easier.';
  const model = scriptedModel([readyPlan, { status: 'conflict', html: '<html>mismatched page</html>', issue, playtest: null }]);
  await assert.rejects(generateGame({ problem: readyPlan.problem, model,
    check: () => assert.fail('A conflicted page must never execute.') }), error => {
    assert.equal(error.code, 'PLAN_CONFLICT');
    assert.ok(!error.message.includes(issue));
    assert.ok(!error.message.includes('mismatched page'));
    return true;
  });
  assert.equal(model.calls.length, 2);
});

test('one failed runtime check can be repaired exactly once and reports both attempts', async () => {
  const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
  const diagnostics = [];
  let checks = 0;
  const checkedHtml = [];
  const checkContracts = [];
  const result = await generateGame({ problem: readyPlan.problem, model, onDiagnostic: value => diagnostics.push(value),
    check: async (html, options) => {
      checkedHtml.push(html);
      checkContracts.push(options);
      return ++checks === 1 ? { passed: false, playthrough: 'failed', independentChecks: structuredClone(passedIndependentChecks),
        errors: ['Reset did not restore initial mathematical state.'] } : successfulCheck();
    } });
  assert.equal(result.game.repairCount, 1);
  assert.equal(checks, 2);
  assert.equal(model.calls.length, 3);
  assert.deepEqual(checkedHtml, [fixturePage.html, fixtureRepairedHtml]);
  assert.equal(result.game.html, fixtureRepairedHtml);
  assert.match(JSON.stringify(model.calls[2].input), /Reset did not restore/);
  assert.equal(model.calls[2].schema.properties.edits.maxItems, 6);
  assert.deepEqual(model.calls[2].input.assessment, readyPlan.assessment);
  assert.deepEqual(model.calls[2].input.playtest, fixturePage.playtest);
  assert.deepEqual(checkContracts.map(({ assessment, playtest, attempt }) => ({ assessment, playtest, attempt })), [
    { assessment: readyPlan.assessment, playtest: fixturePage.playtest, attempt: 0 },
    { assessment: readyPlan.assessment, playtest: fixturePage.playtest, attempt: 1 },
  ]);
  assert.deepEqual(diagnostics.filter(item => item.type === 'runtime_check').map(({ attempt, passed }) => ({ attempt, passed })), [
    { attempt: 0, passed: false }, { attempt: 1, passed: true },
  ]);
  assert.deepEqual(diagnostics.filter(item => item.type === 'model_call').map(({ name, outcome }) => ({ name, outcome })), [
    { name: 'play_plan', outcome: 'completed' },
    { name: 'playable_exercise', outcome: 'completed' },
    { name: 'repaired_exercise', outcome: 'completed' },
  ]);
  assert.equal(diagnostics[0].usage.input_tokens, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-key|Solve 2x|Balance the equation|Subtract 3/);
});

test('legacy checker success without a playthrough marker triggers the single bounded repair', async () => {
  const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
  const outcomes = [{ passed: true, errors: [], independentChecks: structuredClone(passedIndependentChecks) }, successfulCheck()];
  const result = await generateGame({ problem: readyPlan.problem, model, check: async () => outcomes.shift() });
  assert.equal(result.type, 'result');
  assert.equal(result.game.repairCount, 1);
  assert.equal(model.calls.filter(call => call.name === 'repaired_exercise').length, 1);
});

test('runtime diagnostics genericize errors with trusted prefixes plus generated text', async () => {
  const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
  const diagnostics = [];
  let checks = 0;
  await generateGame({ problem: readyPlan.problem, model, onDiagnostic: value => diagnostics.push(value),
    check: async () => ++checks === 1
      ? { passed: false, playthrough: 'failed', independentChecks: structuredClone(passedIndependentChecks),
        errors: ['Hint controls changed mathematical state. Private generated output follows.'] }
      : successfulCheck() });
  const runtimeFailure = diagnostics.find(item => item.type === 'runtime_check' && !item.passed);
  assert.deepEqual(runtimeFailure.errors, ['Generated page runtime error.']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /Private generated output/);
});

test('diagnostic-triggered cancellation records a completed call or check only once', async () => {
  const modelController = new AbortController();
  const modelDiagnostics = [];
  const model = scriptedModel([readyPlan, fixturePage]);
  await assert.rejects(generateGame({ problem: readyPlan.problem, model, signal: modelController.signal,
    onDiagnostic: value => {
      modelDiagnostics.push(value);
      if (value.type === 'model_call' && value.name === 'play_plan') modelController.abort();
    }, check: () => assert.fail('Cancellation after the plan call must stop before checks.') }), error => error.name === 'AbortError');
  assert.deepEqual(modelDiagnostics.map(({ type, name, outcome }) => ({ type, name, outcome })), [
    { type: 'model_call', name: 'play_plan', outcome: 'completed' },
  ]);
  assert.equal(model.calls.length, 1);

  const checkController = new AbortController();
  const checkDiagnostics = [];
  const checkModel = scriptedModel([readyPlan, fixturePage]);
  await assert.rejects(generateGame({ problem: readyPlan.problem, model: checkModel, signal: checkController.signal,
    onDiagnostic: value => {
      checkDiagnostics.push(value);
      if (value.type === 'runtime_check') checkController.abort();
    }, check: async () => successfulCheck() }), error => error.name === 'AbortError');
  assert.equal(checkDiagnostics.filter(item => item.type === 'runtime_check').length, 1);
  assert.equal(checkDiagnostics.filter(item => item.type === 'model_call').length, 2);
});

test('two failed checks stop without an unbounded repair loop', async () => {
  const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
  await assert.rejects(generateGame({ problem: readyPlan.problem, model,
    check: async () => ({ passed: false, playthrough: 'failed', independentChecks: structuredClone(passedIndependentChecks),
      errors: ['Generated page runtime error.'] }) }), error => error.code === 'RUNTIME_CHECK_FAILED');
  assert.equal(model.calls.length, 3);
});

test('malformed planner output never reaches code generation', async () => {
  const model = scriptedModel([{ status: 'ready' }]);
  await assert.rejects(generateGame({ problem: 'x + 1 = 2', model,
    check: () => assert.fail('Malformed output must not run.') }), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.equal(model.calls.length, 1);
});

test('a short total deadline aborts a slow planner and prevents page generation', async () => {
  let plannerSignal;
  const calls = [];
  const model = { complete({ name, signal }) {
    calls.push(name);
    plannerSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  await assert.rejects(generateGame({ problem: readyPlan.problem, model, timeoutMs: 20,
    check: () => assert.fail('Timed out generation must not reach browser checks.') }), error => error.code === 'GENERATION_TIMEOUT');
  assert.deepEqual(calls, ['play_plan']);
  assert.equal(plannerSignal.aborted, true);
});

test('client cancellation is forwarded downstream and remains an abort', async () => {
  const controller = new AbortController();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let receivedSignal;
  const calls = [];
  const model = { complete({ name, signal }) {
    calls.push(name);
    receivedSignal = signal;
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  const run = generateGame({ problem: readyPlan.problem, model, signal: controller.signal,
    check: () => assert.fail('Cancelled generation must not reach checks.') });
  await pending;
  controller.abort();
  await assert.rejects(run, error => error.name === 'AbortError');
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(calls, ['play_plan']);
});

test('failed model calls emit a bounded failure diagnostic with no provider details', async () => {
  const diagnostics = [];
  const model = scriptedModel([new Error('api-key=secret raw upstream body')]);
  await assert.rejects(generateGame({ problem: 'private prompt', model, onDiagnostic: value => diagnostics.push(value) }));
  assert.deepEqual(diagnostics.map(({ type, name, outcome, usage }) => ({ type, name, outcome, usage })), [
    { type: 'model_call', name: 'play_plan', outcome: 'failed', usage: null },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|private prompt|raw upstream body/);
});

test('failed model diagnostics preserve sanitized usage and only the allowlisted incomplete reason', async () => {
  const knownDiagnostics = [];
  const knownError = new Error('generic incomplete failure');
  knownError.usage = { input_tokens: 15, output_tokens: 15532, total_tokens: 15547, cost: 0.01,
    provider_payload: 'provider secret' };
  knownError.incompleteReason = 'max_output_tokens';
  await assert.rejects(generateGame({ problem: 'private prompt', model: scriptedModel([knownError]),
    onDiagnostic: value => knownDiagnostics.push(value) }));
  assert.deepEqual(knownDiagnostics[0].usage, {
    input_tokens: 15, output_tokens: 15532, total_tokens: 15547, cost: 0.01,
  });
  assert.equal(knownDiagnostics[0].incompleteReason, 'max_output_tokens');

  const unknownDiagnostics = [];
  const unknownError = new Error('generic incomplete failure');
  unknownError.usage = { input_tokens: 5, cost: -1, output_tokens: 'secret-count', provider_payload: 'provider secret' };
  unknownError.incompleteReason = { reason: 'provider-secret-reason' };
  await assert.rejects(generateGame({ problem: 'private prompt', model: scriptedModel([unknownError]),
    onDiagnostic: value => unknownDiagnostics.push(value) }));
  assert.deepEqual(unknownDiagnostics[0].usage, { input_tokens: 5 });
  assert.equal(Object.hasOwn(unknownDiagnostics[0], 'incompleteReason'), false);
  assert.doesNotMatch(JSON.stringify([...knownDiagnostics, ...unknownDiagnostics]), /provider secret|secret-count|provider-secret-reason|private prompt/);
});

test('a pre-aborted request does not call the model', async () => {
  const controller = new AbortController();
  controller.abort();
  const model = scriptedModel([]);
  await assert.rejects(generateGame({ problem: readyPlan.problem, model, signal: controller.signal,
    check: () => assert.fail('Aborted request must not run.') }), error => error.name === 'AbortError');
  assert.equal(model.calls.length, 0);
});
