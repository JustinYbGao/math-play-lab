import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preparedSummary, validateAvailableData, validateDataset } from '../evaluation/validate.mjs';
import { parseArgs, runEvaluation } from '../evaluation/run.mjs';
import { buildRunReport } from '../evaluation/report.mjs';
import { readyPlan, fixturePage, fixtureRepair, fixtureRepairedHtml } from './fixtures.mjs';

const caseData = (id, expected_behavior = 'interactive', extra = {}) => ({
  id, coverage: 'E-F04', problem: `Problem ${id}`, expected_behavior,
  reference_answer: `REFERENCE ${id}`, checks: [`CHECK ${id}`], ...extra,
});
const coverageRegistry = new Map([['E-F04', '小学']]);
const passingCheck = (assessment = readyPlan.assessment) => ({ passed: true, playthrough: 'passed',
  independentChecks: { status: 'passed', testedFields: assessment.fields.map(field => field.id),
    untestedFields: [], equivalentChecks: 0 }, errors: [] });

function dataset(...cases) {
  return { status: 'prepared_not_run', purpose: 'test fixture', cases };
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'math-play-lab-evaluation-'));
}

function scriptedModel(values, seen = []) {
  let index = 0;
  return { seen, async complete(request) {
    seen.push(request);
    const value = values[index++];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(request);
    return { value, usage: { input_tokens: 2, output_tokens: 3 } };
  } };
}

function markReviewPassed(review, { correct = 'passed' } = {}) {
  for (const value of Object.values(review.dimensions)) {
    value.status = 'passed'; value.reviewer = 'Independent reviewer'; value.evidence = 'Observed against the original case.';
  }
  for (const [key, value] of Object.entries(review.checklist)) {
    value.status = key === 'correct' ? correct : key === 'multipleSolutions' ? 'not_applicable' : 'passed';
    value.reviewer = 'Independent reviewer'; value.evidence = key === 'multipleSolutions'
      ? 'This task has one requested solution path.' : 'Observed in the generated artifact.';
  }
  review.expectedBehavior.status = 'passed';
  review.expectedBehavior.reviewer = 'Independent reviewer';
  review.expectedBehavior.evidence = 'Behavior matches the case contract.';
}

const clarifyPlan = { ...readyPlan, status: 'clarify', title: '', problem: '', topics: [], constraints: [],
  referenceAnswer: '', objective: '', initialState: '', invariants: [], actions: [], hints: [],
  winCondition: '', explanation: '', clarification: 'Please provide the missing diagram.', assessment: null };

test('validation accepts the pilot and requires curriculum metadata and concrete checks', () => {
  const pilot = validateDataset(dataset(caseData('pilot-a'), caseData('pilot-stress', 'clarification', {
    coverage: 'stress-input-ambiguity',
  })), { suiteName: 'pilot' });
  assert.deepEqual(pilot.errors, []);

  const curriculumCase = caseData('E-F04-basic', 'interactive', {
    stage: '小学', variant: 'basic', split: 'development', reference_status: 'authored_unreviewed',
    checks: ['A concrete correct path.', 'A concrete wrong path.', 'A concrete reset path.'],
  });
  assert.deepEqual(validateDataset(dataset(curriculumCase), { suiteName: 'curriculum' }).errors, []);
  const audit = validateDataset(dataset(curriculumCase), { suiteName: 'curriculum',
    coverageIds: new Set(['E-F04']), coverageStages: new Map([['E-F04', '小学']]) });
  assert.equal(audit.variantCoverage[0].caseCount, 1);
  assert.deepEqual(audit.variantCoverage[0].missingVariants, ['transfer', 'edge']);
  assert.equal(audit.variantCoverage[0].meetsMinimum, false);
  const stressCase = { ...curriculumCase, id: 'S-input_ambiguity', coverage: 'stress-input_ambiguity',
    stress_group: 'input_ambiguity', stage: '跨学段', variant: 'edge' };
  assert.deepEqual(validateDataset(dataset(stressCase), { suiteName: 'curriculum' }).errors, []);
  const invalid = validateDataset(dataset({ ...curriculumCase, variant: 'advanced', coverage: 'BAD' }), {
    suiteName: 'curriculum', coverageIds: new Set(['E-F04']),
  });
  assert.ok(invalid.errors.some(error => error.includes('variant')));
  assert.ok(invalid.errors.some(error => error.includes('coverage')));
  assert.ok(invalid.absentCoverage.includes('E-F04'));
  assert.ok(validateDataset(dataset(caseData('../outside')), { suiteName: 'pilot' }).errors.some(error => error.includes('id')));
  assert.ok(validateDataset(dataset({ ...curriculumCase, stage: '高中' }), { suiteName: 'curriculum',
    coverageIds: new Set(['E-F04']), coverageStages: new Map([['E-F04', '小学']]) }).errors.some(error => error.includes('stage')));
});

test('CLI arguments default to dry run and reject missing caps, conflicts, and unsupported flags', () => {
  assert.deepEqual(parseArgs([]), { suite: 'pilot', live: false, includeHoldout: false });
  assert.deepEqual(parseArgs(['--live', '--max-calls', '24', '--suite', 'curriculum', '--include-holdout']), {
    suite: 'curriculum', live: true, includeHoldout: true, maxCalls: 24,
  });
  assert.throws(() => parseArgs(['--live']), /requires --max-calls/i);
  assert.throws(() => parseArgs(['--max-calls', '4']), /requires --live/i);
  assert.throws(() => parseArgs(['--suite', 'pilot', '--include-holdout']), /only valid with --suite curriculum/i);
  assert.throws(() => parseArgs(['--mystery']), /unsupported argument/i);
});

test('prepared summary and full validation report malformed null case rows without throwing', async () => {
  const rootDir = await tempRoot();
  try {
    await mkdir(path.join(rootDir, 'evaluation', 'cases'), { recursive: true });
    await writeFile(path.join(rootDir, 'evaluation', 'pilot.json'), JSON.stringify({ status: 'prepared_not_run',
      purpose: 'malformed fixture', cases: [null] }));
    await writeFile(path.join(rootDir, 'evaluation', 'cases', 'elementary.json'), JSON.stringify({ status: 'prepared_not_run',
      purpose: 'malformed fixture', cases: [null] }));
    const prepared = await preparedSummary({ rootDir });
    assert.ok(prepared.errors.some(error => error.includes('pilot.json: cases[0] must be an object')));
    assert.ok(prepared.errors.some(error => error.includes('elementary.json: cases[0] must be an object')));
    const audit = await validateAvailableData({ rootDir });
    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some(error => error.includes('cases[0] must be an object')));
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('dry runs make zero model or checker calls and create no run directory', async () => {
  const rootDir = await tempRoot();
  try {
    let calls = 0;
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('dry-a')), suiteName: 'pilot', live: false,
      model: { complete: async () => { calls++; } }, check: async () => { calls++; }, modelConfigured: true,
      coverageRegistry });
    assert.equal(result.kind, 'dry_run');
    assert.equal(calls, 0);
    await assert.rejects(readdir(path.join(rootDir, 'evaluation', 'runs')));
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('live mode refuses missing credentials before creating a started run', async () => {
  const rootDir = await tempRoot();
  try {
    await assert.rejects(runEvaluation({ rootDir, dataset: dataset(caseData('missing-key')), suiteName: 'pilot',
      live: true, maxCalls: 2, modelConfigured: false, model: { complete: async () => assert.fail() },
      check: async () => assert.fail(), coverageRegistry }), /model configuration is missing/i);
    await assert.rejects(readdir(path.join(rootDir, 'evaluation', 'runs')));
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('the total cap counts repair requests, allows failed requests to count, and never sends a refused call', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([readyPlan, fixturePage, fixturePage]);
    let checks = 0;
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('repair-cap')), suiteName: 'pilot',
      live: true, maxCalls: 2, modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, options) => (++checks === 1 ? { passed: false, playthrough: 'failed', errors: ['The interaction control did not change mathematical state.'] }
        : passingCheck(options.assessment)), evidenceClass: 'fixtures', coverageRegistry });
    assert.equal(model.seen.length, 2);
    assert.equal(result.manifest.providerCalls, 2);
    assert.equal(result.manifest.callLimitRefusals, 1);
    const caseRecord = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'repair-cap.json'), 'utf8'));
    assert.equal(caseRecord.failure.code, 'EVALUATION_CALL_CAP');
    assert.deepEqual(caseRecord.diagnostics.filter(item => item.type === 'runtime_check').map(item => item.attempt), [0]);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('failed provider requests count toward the cap and dataset references never reach generation', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([new Error('raw provider body and secret'), clarifyPlan]);
    const input = dataset(caseData('provider-failure', 'interactive', {
      reference_answer: 'PRIVATE REFERENCE MARKER', checks: ['PRIVATE CHECK MARKER'],
    }), caseData('clarify-next', 'clarification'));
    const result = await runEvaluation({ rootDir, dataset: input, suiteName: 'pilot', live: true, maxCalls: 2,
      modelConfigured: true, modelName: 'fixture-model', model, check: async () => assert.fail(),
      evidenceClass: 'fixtures', coverageRegistry });
    assert.equal(result.manifest.providerCalls, 2);
    assert.equal(model.seen.length, 2);
    assert.doesNotMatch(JSON.stringify(model.seen), /PRIVATE REFERENCE MARKER|PRIVATE CHECK MARKER/);
    const first = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'provider-failure.json'), 'utf8'));
    assert.equal(first.status, 'failed');
    assert.equal(first.failure.code, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(first.failure), /raw provider|secret/);
    const second = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'clarify-next.json'), 'utf8'));
    assert.equal(second.status, 'completed_clarification');
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('case artifacts retain only validated plan and page contracts by request name', async () => {
  const rootDir = await tempRoot();
  try {
    const conflictPage = { status: 'conflict', html: fixturePage.html, issue: 'The page does not match the plan.', playtest: null };
    const conflictRepair = { status: 'conflict', edits: [], issue: 'The plan changes the requested goal.' };
    const model = scriptedModel([readyPlan, fixturePage, clarifyPlan, readyPlan, conflictPage,
      readyPlan, fixturePage, conflictRepair]);
    let checkCount = 0;
    const forwardedContracts = [];
    const result = await runEvaluation({ rootDir,
      dataset: dataset(caseData('contract-ready'), caseData('contract-clarify', 'clarification'),
        caseData('contract-conflict'), caseData('contract-repair')), suiteName: 'pilot', live: true, maxCalls: 9,
      modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, options) => {
        forwardedContracts.push({ assessment: options.assessment, playtest: options.playtest, attempt: options.attempt });
        return ++checkCount === 2
          ? { passed: false, playthrough: 'failed', errors: ['The interaction control did not change mathematical state.'] }
          : passingCheck(options.assessment);
      }, evidenceClass: 'fixtures', coverageRegistry });
    const readCase = async id => JSON.parse(await readFile(path.join(result.runDir, 'cases', `${id}.json`), 'utf8'));

    const ready = await readCase('contract-ready');
    assert.deepEqual(ready.validatedContracts, [
      { requestName: 'play_plan', plan: readyPlan },
      { requestName: 'playable_exercise', status: 'ready', issue: null, playtest: fixturePage.playtest },
    ]);
    assert.equal(ready.status, 'completed_generation');
    assert.deepEqual(ready.runtimeChecks[0].independentChecks, passingCheck().independentChecks);
    assert.deepEqual(ready.result.game.verification.independentChecks, passingCheck().independentChecks);
    assert.deepEqual(forwardedContracts, [
      { assessment: readyPlan.assessment, playtest: fixturePage.playtest, attempt: 0 },
      { assessment: readyPlan.assessment, playtest: fixturePage.playtest, attempt: 0 },
    ]);

    const clarify = await readCase('contract-clarify');
    assert.deepEqual(clarify.validatedContracts, [{ requestName: 'play_plan', plan: clarifyPlan }]);
    assert.equal(clarify.status, 'completed_clarification');

    const conflict = await readCase('contract-conflict');
    assert.deepEqual(conflict.validatedContracts, [
      { requestName: 'play_plan', plan: readyPlan },
      { requestName: 'playable_exercise', status: 'conflict', issue: conflictPage.issue, playtest: null },
    ]);
    assert.equal(conflict.failure.code, 'PLAN_CONFLICT');
    assert.equal(Object.hasOwn(conflict.validatedContracts[1], 'html'), false);

    const repair = await readCase('contract-repair');
    assert.deepEqual(repair.validatedContracts, [
      { requestName: 'play_plan', plan: readyPlan },
      { requestName: 'playable_exercise', status: 'ready', issue: null, playtest: fixturePage.playtest },
      { requestName: 'repaired_exercise', status: 'conflict', issue: conflictRepair.issue, edits: [] },
    ]);
    assert.equal(repair.failure.code, 'PLAN_CONFLICT');
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('invalid contract values, unknown fields, and raw secrets are not retained', async () => {
  const rootDir = await tempRoot();
  try {
    const rawSecret = 'RAW_SECRET_SENTINEL';
    const invalidPlan = { ...readyPlan, rawSecret };
    const invalidPage = { ...fixturePage, html: `<html><body>${rawSecret}</body></html>`, rawSecret };
    const model = { async complete(request) {
      const value = request.name === 'play_plan'
        ? (request.input.originalProblem === 'Problem invalid-plan' ? invalidPlan : readyPlan)
        : invalidPage;
      return { value, usage: { input_tokens: 1, rawSecret } };
    } };
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('invalid-plan'), caseData('invalid-page')),
      suiteName: 'pilot', live: true, maxCalls: 4, modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, options) => passingCheck(options.assessment), evidenceClass: 'fixtures', coverageRegistry });
    const invalidPlanRecord = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'invalid-plan.json'), 'utf8'));
    const invalidPageRecord = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'invalid-page.json'), 'utf8'));
    assert.equal(invalidPlanRecord.failure.code, 'INVALID_MODEL_OUTPUT');
    assert.deepEqual(invalidPlanRecord.validatedContracts, []);
    assert.equal(invalidPageRecord.failure.code, 'INVALID_MODEL_OUTPUT');
    assert.deepEqual(invalidPageRecord.validatedContracts, [{ requestName: 'play_plan', plan: readyPlan }]);
    assert.deepEqual(invalidPageRecord.htmlFiles, []);
    assert.doesNotMatch(JSON.stringify([invalidPlanRecord, invalidPageRecord]), /RAW_SECRET_SENTINEL/);
    assert.deepEqual(await readdir(path.join(result.runDir, 'html')), []);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('invalid repair payloads are excluded from contracts and HTML artifacts', async () => {
  const rootDir = await tempRoot();
  try {
    const rawSecret = 'RAW_REPAIR_SECRET_SENTINEL';
    const invalidRepair = { status: 'ready', edits: [{ find: 'Try a value.', replace: 'Choose a value.' }],
      issue: null, rawSecret };
    const model = scriptedModel([readyPlan, fixturePage, invalidRepair]);
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('invalid-repair')), suiteName: 'pilot',
      live: true, maxCalls: 3, modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, { attempt }) => attempt === 0
        ? { passed: false, playthrough: 'failed', errors: ['Generated page runtime error.'] }
        : assert.fail('Invalid repair output must not reach the checker.'),
      evidenceClass: 'fixtures', coverageRegistry });
    const record = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'invalid-repair.json'), 'utf8'));
    assert.equal(record.failure.code, 'INVALID_MODEL_OUTPUT');
    assert.deepEqual(record.validatedContracts.map(entry => entry.requestName), ['play_plan', 'playable_exercise']);
    assert.deepEqual(record.htmlFiles, ['html/invalid-repair-playable_exercise.html']);
    assert.doesNotMatch(JSON.stringify(record), /RAW_REPAIR_SECRET_SENTINEL/);
    const html = await readFile(path.join(result.runDir, 'html', 'invalid-repair-playable_exercise.html'), 'utf8');
    assert.equal(html, fixturePage.html);
    assert.deepEqual((await readdir(path.join(result.runDir, 'html'))).sort(), ['invalid-repair-playable_exercise.html']);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('timeout and cancellation finalize the active artifact and preserve earlier results', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([clarifyPlan, (_request) => new Promise(() => {})]);
    const input = dataset(caseData('already-done', 'clarification'), caseData('times-out'));
    const result = await runEvaluation({ rootDir, dataset: input, suiteName: 'pilot', live: true, maxCalls: 5,
      modelConfigured: true, modelName: 'fixture-model', model, check: async () => assert.fail(), generationTimeoutMs: 15,
      evidenceClass: 'fixtures', coverageRegistry });
    const done = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'already-done.json'), 'utf8'));
    const timedOut = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'times-out.json'), 'utf8'));
    assert.equal(done.status, 'completed_clarification');
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.failure.code, 'GENERATION_TIMEOUT');
    assert.equal(result.manifest.status, 'completed');
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('late repair completion after cancellation cannot change terminal artifacts or start another case', async () => {
  const rootDir = await tempRoot();
  try {
    let completeLate;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const model = { calls: [], complete(request) {
      this.calls.push(request);
      if (request.name === 'play_plan') return Promise.resolve({ value: readyPlan });
      if (request.name === 'playable_exercise') return Promise.resolve({ value: fixturePage });
      markStarted();
      return new Promise(resolve => { completeLate = resolve; });
    } };
    const controller = new AbortController();
    const run = runEvaluation({ rootDir, dataset: dataset(caseData('cancel-current'), caseData('not-started')),
      suiteName: 'pilot', live: true, maxCalls: 4, modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, { attempt }) => attempt === 0
        ? { passed: false, playthrough: 'failed', errors: ['Generated page runtime error.'] }
        : assert.fail('The late repair must not reach a second browser check.'),
      signal: controller.signal, evidenceClass: 'fixtures', coverageRegistry });
    await started;
    controller.abort();
    const result = await run;
    const activePath = path.join(result.runDir, 'cases', 'cancel-current.json');
    const beforeLateResult = await readFile(activePath, 'utf8');
    completeLate({ value: fixtureRepair });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await readFile(activePath, 'utf8'), beforeLateResult);
    const active = JSON.parse(beforeLateResult);
    assert.deepEqual(active.validatedContracts.map(entry => entry.requestName), ['play_plan', 'playable_exercise']);
    assert.deepEqual(active.htmlFiles, ['html/cancel-current-playable_exercise.html']);
    assert.equal(active.latestGeneratedAttempt, 'playable_exercise');
    assert.equal(model.calls.length, 3);
    const pending = JSON.parse(await readFile(path.join(result.runDir, 'cases', 'not-started.json'), 'utf8'));
    assert.equal(pending.status, 'unrun');
    assert.equal(result.manifest.status, 'cancelled');
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('reports keep failed generation in the math denominator and separate runtime and clarification evidence', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([readyPlan, fixturePage, new Error('provider failure'), clarifyPlan]);
    const input = dataset(caseData('runtime-only'), caseData('failed-math'), caseData('clarification', 'clarification'));
    const result = await runEvaluation({ rootDir, dataset: input, suiteName: 'pilot', live: true, maxCalls: 5,
      modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, options) => passingCheck(options.assessment), evidenceClass: 'fixtures', coverageRegistry });
    const report = await buildRunReport(result.runDir);
    assert.equal(report.evidenceClass, 'fixtures');
    assert.deepEqual(report.counts, { planned: 3, selected: 3, attempted: 3, completedGeneration: 1, unrun: 0, errors: 1 });
    assert.equal(report.runtime.firstAttempt.passed, 1);
    assert.equal(report.runtime.firstAttempt.denominator, 1);
    assert.equal(report.tokenUsage.inputTokens.measuredCalls, 3);
    assert.equal(report.tokenUsage.totalTokens.total, null);
    assert.equal(report.tokenUsage.totalTokens.incompleteCalls, 4);
    assert.equal(report.modelCalls.unknownUsageCalls, 1);
    assert.equal(report.mathematical.fullSuccess.denominator, 2);
    assert.equal(report.mathematical.fullSuccess.passed, 0);
    assert.equal(report.mathematical.fullSuccess.unreviewed, 2);
    assert.equal(report.clarification.denominator, 1);
    assert.equal(report.clarification.passed, 0);
    assert.equal(report.mathematical.label, 'independently reviewed mathematical success');
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('a manual review pass without reviewer evidence is malformed and cannot count as success', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([readyPlan, fixturePage]);
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('review-schema')), suiteName: 'pilot',
      live: true, maxCalls: 4, modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, options) => passingCheck(options.assessment), evidenceClass: 'fixtures', coverageRegistry });
    const file = path.join(result.runDir, 'cases', 'review-schema.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    for (const item of Object.values(record.review.dimensions)) item.status = 'passed';
    for (const item of Object.values(record.review.checklist)) item.status = 'passed';
    record.review.expectedBehavior.status = 'passed';
    await writeFile(file, JSON.stringify(record, null, 2));
    const report = await buildRunReport(result.runDir);
    assert.equal(report.review.malformedRecords, 1);
    assert.equal(report.mathematical.fullSuccess.passed, 0);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('math reports distinguish first and repaired artifacts and require correct, wrong, and reset reviews', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
    let checkCount = 0;
    const forwarded = [];
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('review-repair')),
      suiteName: 'pilot', live: true, maxCalls: 4, modelConfigured: true, modelName: 'fixture-model', model,
      check: async (_html, options) => {
        forwarded.push(options);
        return ++checkCount === 1 ? { passed: false, playthrough: 'failed', errors: ['Generated page runtime error.'] }
          : passingCheck(options.assessment);
      }, evidenceClass: 'fixtures', coverageRegistry });
    assert.deepEqual(forwarded.map(({ attempt, assessment, playtest }) => ({ attempt, assessment, playtest })), [
      { attempt: 0, assessment: readyPlan.assessment, playtest: fixturePage.playtest },
      { attempt: 1, assessment: readyPlan.assessment, playtest: fixturePage.playtest },
    ]);
    const file = path.join(result.runDir, 'cases', 'review-repair.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(record.htmlFiles, ['html/review-repair-playable_exercise.html', 'html/review-repair-repaired_exercise.html']);
    assert.equal(record.latestGeneratedAttempt, 'repaired_exercise');
    assert.equal(await readFile(path.join(result.runDir, 'html', 'review-repair-repaired_exercise.html'), 'utf8'), fixtureRepairedHtml);
    assert.deepEqual(record.validatedContracts[2], { requestName: 'repaired_exercise', status: 'ready', issue: null,
      edits: fixtureRepair.edits });
    markReviewPassed(record.firstAttemptReview);
    markReviewPassed(record.review, { correct: 'not_applicable' });
    await writeFile(file, JSON.stringify(record, null, 2));
    let report = await buildRunReport(result.runDir);
    assert.equal(report.mathematical.fullSuccess.firstAttempt.denominator, 1);
    assert.equal(report.mathematical.fullSuccess.firstAttempt.passed, 0);
    assert.equal(report.mathematical.fullSuccess.afterRepair.denominator, 1);
    assert.equal(report.mathematical.fullSuccess.afterRepair.passed, 0);

    record.review.checklist.correct.status = 'passed';
    record.review.checklist.correct.evidence = 'A correct path was observed.';
    await writeFile(file, JSON.stringify(record, null, 2));
    report = await buildRunReport(result.runDir);
    assert.equal(report.mathematical.fullSuccess.afterRepair.passed, 1);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('passing manual review cannot override failed initial and repaired runtime checks', async () => {
  const rootDir = await tempRoot();
  try {
    const model = scriptedModel([readyPlan, fixturePage, fixtureRepair]);
    const result = await runEvaluation({ rootDir, dataset: dataset(caseData('runtime-fails-twice')),
      suiteName: 'pilot', live: true, maxCalls: 4, modelConfigured: true, modelName: 'fixture-model', model,
      check: async () => ({ passed: false, playthrough: 'failed', errors: ['Generated page runtime error.'] }),
      evidenceClass: 'fixtures', coverageRegistry });
    const file = path.join(result.runDir, 'cases', 'runtime-fails-twice.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.htmlFiles, ['html/runtime-fails-twice-playable_exercise.html',
      'html/runtime-fails-twice-repaired_exercise.html']);
    assert.equal(record.latestGeneratedAttempt, 'repaired_exercise');
    assert.equal(await readFile(path.join(result.runDir, 'html', 'runtime-fails-twice-repaired_exercise.html'), 'utf8'),
      fixtureRepairedHtml);
    markReviewPassed(record.firstAttemptReview);
    markReviewPassed(record.review);
    await writeFile(file, JSON.stringify(record, null, 2));
    const report = await buildRunReport(result.runDir);
    assert.equal(report.runtime.firstAttempt.passed, 0);
    assert.equal(report.runtime.afterRepair.passed, 0);
    assert.equal(report.mathematical.fullSuccess.firstAttempt.passed, 0);
    assert.equal(report.mathematical.fullSuccess.afterRepair.passed, 0);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('a pre-existing run directory is never overwritten', async () => {
  const rootDir = await tempRoot();
  try {
    const first = await runEvaluation({ rootDir, dataset: dataset(caseData('stable-run')), suiteName: 'pilot', live: true,
      maxCalls: 1, modelConfigured: true, model: scriptedModel([]), modelName: 'fixture',
      check: async () => assert.fail(), idFactory: () => 'fixed-run', evidenceClass: 'fixtures', coverageRegistry });
    const before = await readFile(path.join(first.runDir, 'manifest.json'), 'utf8');
    await assert.rejects(runEvaluation({ rootDir, dataset: dataset(caseData('stable-run')), suiteName: 'pilot', live: true,
      maxCalls: 1, modelConfigured: true, model: scriptedModel([]), modelName: 'fixture',
      check: async () => assert.fail(), idFactory: () => 'fixed-run', evidenceClass: 'fixtures', coverageRegistry }));
    assert.equal(await readFile(path.join(first.runDir, 'manifest.json'), 'utf8'), before);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});
