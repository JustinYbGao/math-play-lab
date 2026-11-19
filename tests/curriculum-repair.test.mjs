import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRunReport } from '../evaluation/report.mjs';
import { runCurriculumRepair } from '../evaluation/curriculum-repair.mjs';

const modelConfig = { provider: 'openrouter', apiKey: 'mock', model: 'anthropic/claude-sonnet-5.5',
  baseUrl: 'https://openrouter.ai/api/v1' };
const problem = 'Factor x² − 1 over the real numbers.';
const html = '<!doctype html><html><body>old</body></html>';

function reviewRecord(mode = 'failed') {
  const cell = status => ({ status, reviewer: 'root', evidence: status === 'failed' ? 'The submitted reasoning is incorrect.' : 'Checked.' });
  const math = mode === 'failed' ? cell('failed') : mode === 'unreviewed'
    ? { status: 'unreviewed', reviewer: '', evidence: '' } : cell('passed');
  return { schemaVersion: 1,
    dimensions: { fidelity: cell('passed'), mathematics: math, playability: cell('passed'), explanation: cell('passed') },
    checklist: { correct: cell('passed'), wrong: cell('passed'), reset: cell('passed'), multipleSolutions: cell('passed') },
    expectedBehavior: cell('passed') };
}

function plan() {
  return { status: 'ready', title: 'Factor the difference of squares', problem, topics: ['factoring'],
    constraints: [], referenceAnswer: '(x − 1)(x + 1)', objective: 'Construct equivalent factors.', activityType: 'solve',
    initialState: 'The expression x² − 1 is shown.', invariants: ['The factors multiply to x² − 1.'],
    actions: ['Choose a factor pair.'], hints: ['Look for a difference of squares.', 'Use a² − b² = (a − b)(a + b).'],
    requiresReview: false, winCondition: 'The product matches the original expression.',
    explanation: 'Apply a² − b² = (a − b)(a + b).', clarification: null };
}

const assessmentContract = { version: 1, requiresReview: false, fields: [{ id: 'answer', initial: '' }],
  checkpoints: [{ id: 'factor', field: 'answer', dependsOn: [], watchFields: [],
    rule: { kind: 'exact', expected: '1' }, feedback: 'Check the factors.' }] };
const assessmentCoverage = { status: 'passed', testedFields: ['answer'], untestedFields: [], equivalentChecks: 0 };
const playtestContract = {
  solve: [{ action: 'fill', selector: '#answer', value: '1' }, { action: 'click', selector: '#check', value: null }],
  wrong: [{ action: 'fill', selector: '#answer', value: '2' }, { action: 'click', selector: '#check', value: null }],
  recover: [{ action: 'fill', selector: '#answer', value: '1' }, { action: 'click', selector: '#check', value: null }],
  invalidate: [{ action: 'fill', selector: '#answer', value: '2' }],
};

async function addAssessmentContract(f, { includeTrace = true } = {}) {
  const record = JSON.parse(await readFile(f.parentCasePath, 'utf8'));
  record.validatedContracts[0].plan.assessment = structuredClone(assessmentContract);
  if (includeTrace) record.validatedContracts[1].playtest = structuredClone(playtestContract);
  await writeFile(f.parentCasePath, `${JSON.stringify(record, null, 2)}\n`);
}

function authorization(ids) {
  return { userApproved: true, provider: 'openrouter', model: modelConfig.model, maxProviderCalls: 423,
    maxCostUSD: 20, reserveUSDPerCall: 0.65, maxRequestBytes: 90000, maxOutputTokens: 16000,
    providerMaxPricePerMillion: { prompt: 2.2, completion: 11 }, allowedCaseIds: ids };
}

async function fixture({ complete = true, parentKind = 'completed_generation', calls = [], reviewMode = 'failed' } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'mpl-curriculum-repair-'));
  const firstCaseId = parentKind === 'automatic_repair_invalid_output' ? 'H-T04-basic' : 'case-000';
  const ids = Array.from({ length: 141 }, (_, i) => i === 0 ? firstCaseId : `case-${String(i).padStart(3, '0')}`);
  const queueCases = ids.map((caseId, i) => {
    const caseProblem = i === 0 ? problem : `Problem ${i}`;
    const source = { id: caseId, problem: caseProblem, reference_answer: 'local only', checks: ['local check'],
      stage: 'Middle School', coverage: 'M-A01', expected_behavior: 'interactive_reasoning', split: 'development',
      variant: 'basic', reference_status: 'authored_unreviewed' };
    return { caseId, problem: caseProblem, reference_answer: 'local only', checks: ['local check'],
      stage: 'Middle School', coverage: 'M-A01', variant: 'basic', reference_status: 'authored_unreviewed', source };
  });
  const parentFailed = ['runtime_failure', 'automatic_repair_invalid_output'].includes(parentKind);
  const runRecords = ids.slice(0, complete ? 141 : 140).map((caseId, i) => ({ runId: `parent-${i}`,
    caseId, status: i === 0 && parentFailed ? 'failed' : 'completed',
    startedAt: '2026-11-17T12:00:00.000Z', finishedAt: '2026-11-17T12:01:00.000Z',
    runDirectory: path.join('evaluation', 'runs', `parent-${i}`), runEvaluationModelInvocations: 2,
    outgoingProviderRequests: 2 }));
  const ledgerPath = path.join(rootDir, '.work', 'curriculum-live-budget.json');
  const ledger = { schemaVersion: 1, authorization: authorization(ids), calls, runs: runRecords,
    activeRun: null, budgetHalt: null };
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const readBundle = async () => ({ rootDir, ledgerPath, ledger: JSON.parse(await readFile(ledgerPath, 'utf8')),
    queueCases, sourceDataset: { cases: queueCases } });

  const parentDir = path.join(rootDir, 'evaluation', 'runs', 'parent-0');
  const planData = plan();
  const generatedName = parentKind === 'runtime_failure' ? 'repaired_exercise' : 'playable_exercise';
  const generatedHtml = `${firstCaseId}-${generatedName}.html`;
  await mkdir(path.join(parentDir, 'cases'), { recursive: true });
  await mkdir(path.join(parentDir, 'html'), { recursive: true });
  await writeFile(path.join(parentDir, 'html', generatedHtml), html);
  const originalCase = queueCases[0].source;
  const record = { schemaVersion: 1, id: firstCaseId, status: parentFailed ? 'failed' : 'completed_generation',
    attempted: true, suite: 'curriculum', coverage: originalCase.coverage, stage: originalCase.stage,
    split: originalCase.split, expectedBehavior: originalCase.expected_behavior, modelIdentifier: modelConfig.model,
    originalCase, originalInput: { problem }, reference: { answer: 'local only', checks: ['local check'], status: 'authored_unreviewed' },
    diagnostics: parentKind === 'automatic_repair_invalid_output'
      ? [{ type: 'model_call', name: 'play_plan', outcome: 'completed' },
        { type: 'model_call', name: 'playable_exercise', outcome: 'completed' },
        { type: 'runtime_check', attempt: 0, passed: false, errors: ['Saved runtime failure.'] },
        { type: 'model_call', name: 'repaired_exercise', outcome: 'completed' }] : [],
    runtimeChecks: parentKind === 'runtime_failure'
      ? [{ type: 'runtime_check', attempt: 0, passed: false, errors: ['Saved runtime failure.'] },
        { type: 'runtime_check', attempt: 1, passed: false, errors: ['Saved runtime failure.'] }]
      : parentKind === 'automatic_repair_invalid_output'
        ? [{ type: 'runtime_check', attempt: 0, passed: false, errors: ['Saved runtime failure.'] }]
        : [{ type: 'runtime_check', attempt: 0, passed: true, errors: [] }],
    providerCalls: parentFailed ? 3 : 2, callLimitRefusals: 0, repairCount: parentFailed ? 1 : 0,
    htmlFiles: [`html/${generatedHtml}`], latestGeneratedAttempt: generatedName,
    validatedContracts: [{ requestName: 'play_plan', plan: planData },
      { requestName: 'playable_exercise', status: 'ready', issue: null },
      ...(parentKind === 'automatic_repair_invalid_output'
        ? [{ requestName: 'repaired_exercise', status: 'ready', issue: null,
          edits: [{ find: '<body>old</body>', replace: '<body>repaired</body>' }] }] : [])],
    review: reviewRecord(reviewMode) };
  if (parentKind === 'runtime_failure') record.failure = { code: 'RUNTIME_CHECK_FAILED', message: 'Runtime checks failed.' };
  else if (parentKind === 'automatic_repair_invalid_output') {
    record.failure = { code: 'INVALID_MODEL_OUTPUT', message: 'The model returned output that did not meet the generation contract.' };
  }
  else record.result = { type: 'result', game: { id: 'parent-game', problem, title: planData.title } };
  await writeFile(path.join(parentDir, 'cases', `${firstCaseId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const manifest = { schemaVersion: 1, runId: 'parent-0', status: 'completed', evidenceClass: 'live',
    suite: 'curriculum', modelIdentifier: modelConfig.model, plannedCount: 1, selectedCount: 1,
    attemptedCount: 1, completedGenerationCount: parentFailed ? 0 : 1, unrunCount: 0,
    providerCalls: record.providerCalls, callLimitRefusals: 0, repairAttempts: record.repairCount,
    caseArtifactFiles: [`cases/${firstCaseId}.json`] };
  await writeFile(path.join(parentDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { rootDir, ledgerPath, readBundle, parentCasePath: path.join(parentDir, 'cases', `${firstCaseId}.json`),
    parentHtmlPath: path.join(parentDir, 'html', generatedHtml), record, firstCaseId };
}

async function addSecondRuntimeFailure(f) {
  const bundle = await f.readBundle();
  const queued = bundle.queueCases[1];
  const caseId = queued.caseId;
  const source = queued.source;
  const parentRunId = 'parent-1';
  const parentRun = bundle.ledger.runs.find(item => item.runId === parentRunId);
  parentRun.status = 'failed';
  await writeFile(f.ledgerPath, `${JSON.stringify(bundle.ledger, null, 2)}\n`);

  const runDir = path.join(f.rootDir, 'evaluation', 'runs', parentRunId);
  const record = structuredClone(f.record);
  record.id = caseId;
  record.status = 'failed';
  record.coverage = source.coverage;
  record.stage = source.stage;
  record.split = source.split;
  record.expectedBehavior = source.expected_behavior;
  record.originalCase = source;
  record.originalInput.problem = source.problem;
  record.reference = { answer: source.reference_answer, checks: source.checks, status: source.reference_status };
  record.validatedContracts[0].plan.problem = source.problem;
  record.failure = { code: 'RUNTIME_CHECK_FAILED', message: 'Runtime checks failed.' };
  record.runtimeChecks = [{ type: 'runtime_check', attempt: 0, passed: false, errors: ['Saved runtime failure.'] }];
  record.htmlFiles = [`html/${caseId}-playable_exercise.html`];
  record.latestGeneratedAttempt = 'playable_exercise';
  delete record.result;

  await mkdir(path.join(runDir, 'cases'), { recursive: true });
  await mkdir(path.join(runDir, 'html'), { recursive: true });
  await writeFile(path.join(runDir, 'cases', `${caseId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(runDir, record.htmlFiles[0]), html);
  const manifest = { schemaVersion: 1, runId: parentRunId, status: 'completed', evidenceClass: 'live',
    suite: 'curriculum', modelIdentifier: modelConfig.model, plannedCount: 1, selectedCount: 1,
    attemptedCount: 1, completedGenerationCount: 0, unrunCount: 0, providerCalls: record.providerCalls,
    callLimitRefusals: 0, repairAttempts: record.repairCount, caseArtifactFiles: [`cases/${caseId}.json`] };
  await writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function makeFetch(fixtureValue, { patch = { status: 'ready', issue: null,
  edits: [{ find: 'old', replace: 'new' }] }, cost = 0.2, onRequest } = {}) {
  return async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.model, modelConfig.model);
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.deepEqual(body.provider, { require_parameters: true,
      max_price: { prompt: 2.2, completion: 11 } });
    const input = JSON.parse(body.input);
    assert.deepEqual(Object.keys(input).sort(), input.playtest
      ? ['assessment', 'html', 'originalProblem', 'plan', 'playtest', 'runtimeErrors']
      : ['html', 'originalProblem', 'plan', 'runtimeErrors']);
    assert.equal(input.originalProblem, problem);
    assert.equal(input.html, html);
    assert.equal(Object.hasOwn(input, 'diagnosticOrigin'), false);
    assert.equal(input.plan.explanation, undefined);
    if (input.playtest) assert.deepEqual(input.assessment, input.plan.assessment);
    assert.match(input.runtimeErrors[0], /Independent reviewer findings/);
    assert.match(input.runtimeErrors.join('\n'), /submitted reasoning is incorrect/);
    await onRequest?.(body, input);
    const payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(patch) }] }],
      usage: { cost } };
    return { ok: true, json: async () => payload, clone: () => ({ json: async () => payload }) };
  };
}

test('dry run is read-only and live mode refuses before first-pass completion', async () => {
  const f = await fixture({ complete: false });
  try {
    const before = await readFile(f.ledgerPath, 'utf8');
    const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
    assert.equal(dry.status, 'blocked');
    assert.equal(dry.firstPass.terminal, 140);
    assert.deepEqual(dry.selected, []);
    await assert.rejects(runCurriculumRepair({ rootDir: f.rootDir, live: true, readBundle: f.readBundle }),
      /first-pass breadth is incomplete \(140\/141 terminal\)/);
    assert.equal(await readFile(f.ledgerPath, 'utf8'), before);
    await assert.rejects(readFile(path.join(f.rootDir, '.work', 'curriculum-live-budget.lock')));
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('one eligible reviewed failure reserves one request and creates an unreviewed immutable child', async () => {
  const f = await fixture();
  try {
    const parentCaseBytes = await readFile(f.parentCasePath);
    const parentHtmlBytes = await readFile(f.parentHtmlPath);
    let requests = 0;
    const fetchImpl = makeFetch(f, { onRequest: async (_body, input) => {
      requests += 1;
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      assert.equal(ledger.calls.at(-1).status, 'pending');
      assert.equal(ledger.calls.at(-1).reservedCostUSD, 0.65);
      assert.equal(ledger.calls.at(-1).requestName, 'repaired_exercise');
      assert.equal(input.referenceAnswer, undefined);
    } });
    const ids = ['batch-000', 'repair-000', 'call-000', 'game-000'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, limit: 1, config: modelConfig,
      readBundle: f.readBundle, fetchImpl, checkFn: async () => ({ passed: true, errors: [] }),
      idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary.outgoingProviderRequests, 1);
    assert.equal(requests, 1);
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    assert.equal(ledger.runs.length, 141);
    assert.equal(ledger.repairRuns.length, 1);
    assert.equal(ledger.repairRuns[0].status, 'completed');
    assert.equal(ledger.repairRuns[0].modelInvocations, 1);
    assert.equal(ledger.repairRuns[0].outgoingProviderRequests, 1);
    assert.equal(ledger.activeRun, null);
    assert.equal(ledger.calls[0].status, 'settled');
    assert.equal(ledger.calls[0].actualCostUSD, 0.2);
    assert.deepEqual(await readFile(f.parentCasePath), parentCaseBytes);
    assert.deepEqual(await readFile(f.parentHtmlPath), parentHtmlBytes);
    const childDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const report = await buildRunReport(childDir);
    assert.equal(report.counts.completedGeneration, 1);
    assert.equal(report.mathematical.fullSuccess.passed, 0);
    assert.equal(report.mathematical.fullSuccess.unreviewed, 1);
    const child = JSON.parse(await readFile(path.join(childDir, 'cases', 'case-000.json'), 'utf8'));
    assert.equal(child.review.dimensions.mathematics.status, 'unreviewed');
    assert.equal(child.result.game.problem, problem);
    assert.equal(child.result.game.referenceAnswer, plan().referenceAnswer);
    assert.equal(child.result.game.verification.mathematics, 'not_independently_verified');
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('runtime-failed parent with saved plan, HTML, and explicit review failure is repaired from original plan metadata', async () => {
  const f = await fixture({ parentKind: 'runtime_failure' });
  try {
    const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
    assert.equal(dry.selected[0].parentStatus, 'failed');
    const ids = ['batch-001', 'repair-001', 'call-001', 'game-001'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: makeFetch(f), checkFn: async () => ({ passed: true, errors: [] }),
      idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.status, 'completed');
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    const runDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const child = JSON.parse(await readFile(path.join(runDir, 'cases', 'case-000.json'), 'utf8'));
    assert.deepEqual(child.result.game.topics, plan().topics);
    assert.equal(child.result.game.title, plan().title);
    assert.equal(child.result.game.problem, problem);
    assert.equal(child.result.game.referenceAnswer, plan().referenceAnswer);
    assert.equal(child.firstAttemptReviewProvenance.parentRunId, 'parent-0');
    assert.equal((await buildRunReport(runDir)).mathematical.fullSuccess.passed, 0);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('assessment-bearing parents reuse the immutable playtest through repair and child verification', async () => {
  const f = await fixture({ parentKind: 'runtime_failure' });
  try {
    await addAssessmentContract(f);
    const checked = [];
    let sentInput;
    const ids = ['batch-assessment', 'repair-assessment', 'call-assessment', 'game-assessment'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: makeFetch(f, { onRequest: async (_body, input) => { sentInput = input; } }),
      checkFn: async (_html, options) => {
        checked.push(options);
        return { passed: true, playthrough: 'passed', independentChecks: structuredClone(assessmentCoverage), errors: [] };
      }, idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.status, 'completed');
    assert.deepEqual(sentInput.assessment, assessmentContract);
    assert.deepEqual(sentInput.playtest, playtestContract);
    assert.deepEqual(checked.map(({ attempt, assessment, playtest }) => ({ attempt, assessment, playtest })), [
      { attempt: 1, assessment: assessmentContract, playtest: playtestContract },
    ]);
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    const childDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const child = JSON.parse(await readFile(path.join(childDir, 'cases', `${f.firstCaseId}.json`), 'utf8'));
    assert.deepEqual(child.inheritedPlaytest, playtestContract);
    assert.deepEqual(child.result.game.assessment, assessmentContract);
    assert.equal(child.result.game.verification.playthrough, 'passed');
    assert.equal(child.result.game.verification.mathematics, 'not_independently_verified');
    assert.deepEqual(child.result.game.verification.independentChecks, assessmentCoverage);
    assert.equal(child.runtimeChecks[0].playthrough, 'passed');
    assert.deepEqual(child.runtimeChecks[0].independentChecks, assessmentCoverage);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('assessment repair requires valid field coverage and preserves valid partial coverage', async t => {
  for (const [name, coverage, shouldPass] of [
    ['missing', undefined, false],
    ['malformed', { status: 'passed', testedFields: ['unknown'], untestedFields: [], equivalentChecks: 0 }, false],
    ['partial', { status: 'partial', testedFields: ['answer'], untestedFields: ['extra'], equivalentChecks: 1 }, true],
  ]) await t.test(name, async () => {
    const f = await fixture({ parentKind: 'runtime_failure' });
    try {
      await addAssessmentContract(f);
      if (name === 'partial') {
        const record = JSON.parse(await readFile(f.parentCasePath, 'utf8'));
        record.validatedContracts[0].plan.assessment.fields.push({ id: 'extra', initial: '' });
        await writeFile(f.parentCasePath, `${JSON.stringify(record, null, 2)}\n`);
      }
      const ids = [`batch-${name}`, `repair-${name}`, `call-${name}`, `game-${name}`];
      const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
        readBundle: f.readBundle, fetchImpl: makeFetch(f),
        checkFn: async () => ({ passed: true, playthrough: 'passed',
          ...(coverage ? { independentChecks: structuredClone(coverage) } : {}), errors: [] }),
        idFactory: () => ids.shift(), onProgress: () => {} });
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      const childDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
      const child = JSON.parse(await readFile(path.join(childDir, 'cases', `${f.firstCaseId}.json`), 'utf8'));
      assert.equal(child.runtimeChecks[0].passed, shouldPass);
      if (shouldPass) {
        assert.equal(child.status, 'completed_generation');
        assert.deepEqual(child.runtimeChecks[0].independentChecks, coverage);
        assert.deepEqual(child.result.game.verification.independentChecks, coverage);
      } else {
        assert.equal(child.failure.code, 'RUNTIME_CHECK_FAILED');
        assert.equal(child.status, 'failed');
        assert.ok(child.runtimeChecks[0].errors.includes('The independent assessment field checks did not report valid coverage.'));
      }
      assert.equal(result.status, 'completed');
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});

test('a new parent without a saved valid playtest is excluded before any provider request', async () => {
  const f = await fixture({ parentKind: 'runtime_failure' });
  try {
    await addAssessmentContract(f, { includeTrace: false });
    const before = await readFile(f.ledgerPath, 'utf8');
    let requests = 0;
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: async () => { requests++; }, onProgress: () => {} });
    assert.equal(result.status, 'nothing_to_repair');
    assert.equal(result.stopReason, 'no_eligible_cases');
    assert.equal(requests, 0);
    assert.equal(await readFile(f.ledgerPath, 'utf8'), before);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('H-T04-shaped automatic INVALID_MODEL_OUTPUT repair remains eligible only with saved page, failed runtime, and review', async t => {
  const accepted = await fixture({ parentKind: 'automatic_repair_invalid_output' });
  try {
    const dry = await runCurriculumRepair({ rootDir: accepted.rootDir, readBundle: accepted.readBundle });
    assert.equal(accepted.firstCaseId, 'H-T04-basic');
    assert.equal(dry.eligibleCount, 1);
    assert.equal(dry.selected[0].id, 'H-T04-basic');
    assert.equal(dry.selected[0].parentStatus, 'failed');
  } finally { await rm(accepted.rootDir, { recursive: true, force: true }); }

  const exclusions = [
    ['malformed plan', record => { record.validatedContracts[0].plan.title = ''; }],
    ['missing saved page', record => { record.htmlFiles = []; record.latestGeneratedAttempt = null; }],
    ['provider-only failure', record => { record.failure.code = 'MODEL_REQUEST_FAILED'; }],
  ];
  for (const [name, edit] of exclusions) await t.test(name, async () => {
    const f = await fixture({ parentKind: 'automatic_repair_invalid_output' });
    try {
      const record = JSON.parse(await readFile(f.parentCasePath, 'utf8'));
      edit(record);
      await writeFile(f.parentCasePath, `${JSON.stringify(record, null, 2)}\n`);
      const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
      assert.equal(dry.eligibleCount, 0);
      assert.deepEqual(dry.selected, []);
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
  await t.test('unreviewed failure', async () => {
    const f = await fixture({ parentKind: 'automatic_repair_invalid_output', reviewMode: 'unreviewed' });
    try {
      const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
      assert.equal(dry.eligibleCount, 0);
      assert.deepEqual(dry.selected, []);
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});

test('unknown provider cost remains reserved and over-reservation halt stops the batch', async t => {
  await t.test('network failure keeps unknown cost and no retry occurs', async () => {
    const f = await fixture();
    try {
      const ids = ['batch-002', 'repair-002', 'call-002'];
      const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
        readBundle: f.readBundle, fetchImpl: async () => { throw new Error('mock offline'); },
        checkFn: async () => ({ passed: true, errors: [] }), idFactory: () => ids.shift(), onProgress: () => {} });
      assert.equal(result.summary.outgoingProviderRequests, 1);
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      assert.equal(ledger.calls[0].status, 'unknown');
      assert.equal(ledger.calls[0].reservedCostUSD, 0.65);
      assert.equal(ledger.repairRuns[0].status, 'failed');
      assert.equal(ledger.activeRun, null);
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
  await t.test('durable cost halt remains after adapter wraps it', async () => {
    const f = await fixture();
    try {
      const ids = ['batch-003', 'repair-003', 'call-003'];
      const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
        readBundle: f.readBundle, fetchImpl: makeFetch(f, { cost: 0.8 }),
        checkFn: async () => ({ passed: true, errors: [] }), idFactory: () => ids.shift(), onProgress: () => {} });
      assert.equal(result.stopReason, 'budget_halt');
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      assert.equal(ledger.budgetHalt.reason, 'cost_exceeded_reservation');
      assert.equal(ledger.calls[0].status, 'settled');
      assert.equal(ledger.calls[0].actualCostUSD, 0.8);
      assert.equal(ledger.activeRun, null);
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});

test('repair provider failure stops before a second eligible reviewed case', async () => {
  const f = await fixture();
  try {
    await addSecondRuntimeFailure(f);
    const ids = ['batch-provider-stop', 'repair-provider-stop', 'call-provider-stop'];
    let fetched = 0;
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, limit: 2, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: async () => { fetched += 1; throw new Error('mock provider unavailable'); },
      checkFn: async () => ({ passed: true, errors: [] }), idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.stopReason, 'infrastructure_error');
    assert.equal(result.status, 'stopped_after_infrastructure_error');
    assert.equal(result.selectedCount, 1);
    assert.equal(result.summary.repairRuns.length, 1);
    assert.equal(result.summary.repairRuns[0].caseId, 'case-000');
    assert.equal(result.summary.outgoingProviderRequests, 1);
    assert.equal(fetched, 1);
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    assert.equal(ledger.repairRuns.length, 1);
    assert.equal(ledger.repairRuns[0].status, 'failed');
    assert.equal(ledger.calls[0].status, 'unknown');
    assert.equal(ledger.calls[0].reservedCostUSD, 0.65);
    assert.equal(ledger.activeRun, null);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('normalized MODEL_UNAVAILABLE from an unknown model-phase error stops the repair batch', async () => {
  const f = await fixture();
  try {
    await addSecondRuntimeFailure(f);
    const ids = ['batch-normalized-stop', 'repair-normalized-stop', 'call-normalized-stop'];
    let fetched = 0;
    const fetchImpl = async () => {
      fetched += 1;
      const response = new Response(JSON.stringify({ status: 'completed', usage: { cost: 0.2 } }));
      let okReads = 0;
      Object.defineProperty(response, 'ok', { get() {
        okReads += 1;
        if (okReads === 2) throw new Error('unclassified model-phase failure');
        return true;
      } });
      return response;
    };
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, limit: 2, config: modelConfig,
      readBundle: f.readBundle, fetchImpl, checkFn: async () => ({ passed: true, errors: [] }),
      idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.stopReason, 'infrastructure_error');
    assert.equal(result.status, 'stopped_after_infrastructure_error');
    assert.equal(result.selectedCount, 1);
    assert.equal(result.summary.repairRuns.length, 1);
    assert.equal(result.summary.repairRuns[0].caseId, 'case-000');
    assert.equal(fetched, 1);
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    assert.equal(ledger.repairRuns.length, 1);
    assert.equal(ledger.calls.length, 1);
    const childDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const child = JSON.parse(await readFile(path.join(childDir, 'cases', 'case-000.json'), 'utf8'));
    assert.equal(child.failure.code, 'MODEL_UNAVAILABLE');
    assert.equal(ledger.activeRun, null);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('failed repair is retained and never selected a second time', async () => {
  const f = await fixture();
  try {
    const ids = ['batch-004', 'repair-004', 'call-004'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: makeFetch(f, { patch: { status: 'conflict', issue: 'Cannot preserve the planned task.', edits: [] } }),
      checkFn: async () => ({ passed: true, errors: [] }), idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.summary.repairRuns[0].status, 'failed');
    const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
    assert.equal(dry.eligibleCount, 0);
    assert.equal(dry.skippedPriorRepairs, 1);
    assert.equal(dry.status, 'nothing_to_repair');
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('capacity and an existing shared lock prevent a repair request', async t => {
  await t.test('call cap refuses before config, lock, or request', async () => {
    const fullCalls = Array.from({ length: 423 }, (_, i) => ({ callId: `old-${i}`, caseId: `old-case-${i}`,
      runId: `old-run-${i}`, requestName: 'play_plan', status: 'settled', reservedCostUSD: 0.65,
      actualCostUSD: 0, startedAt: '2026-11-17T12:00:00.000Z', finishedAt: '2026-11-17T12:00:00.000Z' }));
    const f = await fixture({ calls: fullCalls });
    try {
      let requests = 0;
      const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, readBundle: f.readBundle,
        fetchImpl: async () => { requests += 1; }, onProgress: () => {} });
      assert.equal(result.stopReason, 'budget_capacity');
      assert.equal(requests, 0);
      await assert.rejects(readFile(path.join(f.rootDir, '.work', 'curriculum-live-budget.lock')));
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
  await t.test('existing lock blocks before request or ledger mutation', async () => {
    const f = await fixture();
    try {
      const lockPath = path.join(f.rootDir, '.work', 'curriculum-live-budget.lock');
      await writeFile(lockPath, '{"runId":"other","startedAt":"2026-11-17T12:00:00.000Z"}\n');
      const before = await readFile(f.ledgerPath, 'utf8');
      let requests = 0;
      await assert.rejects(runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
        readBundle: f.readBundle, fetchImpl: async () => { requests += 1; }, onProgress: () => {} }), /existing lock/);
      assert.equal(requests, 0);
      assert.equal(await readFile(f.ledgerPath, 'utf8'), before);
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});

test('runtime failure retains patched child HTML and stops selection on a later dry run', async () => {
  const f = await fixture();
  try {
    const ids = ['batch-005', 'repair-005', 'call-005'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: makeFetch(f),
      checkFn: async () => ({ passed: false, errors: ['Mocked checker found a failure.'] }),
      idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.summary.repairRuns[0].status, 'failed');
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    const runDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const child = JSON.parse(await readFile(path.join(runDir, 'cases', 'case-000.json'), 'utf8'));
    assert.equal(child.status, 'failed');
    assert.equal(child.failure.code, 'RUNTIME_CHECK_FAILED');
    assert.equal(child.htmlFiles.length, 1);
    assert.match(await readFile(path.join(runDir, child.htmlFiles[0]), 'utf8'), />new</);
    assert.equal(child.review.expectedBehavior.status, 'unreviewed');
    const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
    assert.equal(dry.eligibleCount, 0);
    assert.equal(dry.skippedPriorRepairs, 1);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('SIGINT after reservation retains unknown cost and cancels the repair', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const ids = ['batch-006', 'repair-006', 'call-006'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, signal: controller.signal, checkFn: async () => ({ passed: true, errors: [] }),
      fetchImpl: async () => { controller.abort(new DOMException('test abort', 'AbortError')); throw new Error('aborted'); },
      idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.stopReason, 'sigint');
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    assert.equal(ledger.calls[0].status, 'unknown');
    assert.equal(ledger.repairRuns[0].status, 'cancelled');
    assert.equal(ledger.repairRuns[0].outgoingProviderRequests, 1);
    assert.equal(ledger.activeRun, null);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('malformed and unfinished repair accounting fail closed', async t => {
  await t.test('malformed repairRuns is rejected', async () => {
    const f = await fixture();
    try {
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      ledger.repairRuns = {};
      await writeFile(f.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      await assert.rejects(runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle }), /repairRuns must be an array/);
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
  await t.test('unfinished repair cannot be resumed', async () => {
    const f = await fixture();
    try {
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      ledger.repairRuns = [{ parentRunId: 'parent-0', runId: 'repair-started', caseId: 'case-000', status: 'started',
        startedAt: '2026-11-17T12:02:00.000Z', runDirectory: 'evaluation/runs/repair-started',
        outgoingProviderRequests: 0, modelInvocations: 0, parentCaseSha256: 'a'.repeat(64), parentHtmlSha256: 'b'.repeat(64) }];
      await writeFile(f.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      await assert.rejects(runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
        readBundle: f.readBundle }), /unfinished repair requires manual review/);
      await assert.rejects(readFile(path.join(f.rootDir, '.work', 'curriculum-live-budget.lock')));
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});

test('unreviewed or no-failure review records are not eligible', async t => {
  for (const reviewMode of ['unreviewed', 'passed']) {
    await t.test(reviewMode, async () => {
      const f = await fixture({ reviewMode });
      try {
        const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
        assert.equal(dry.eligibleCount, 0);
        assert.equal(dry.selected.length, 0);
        assert.equal(dry.status, 'nothing_to_repair');
      } finally { await rm(f.rootDir, { recursive: true, force: true }); }
    });
  }
});

test('invalid repair contract is retained and never selected again', async () => {
  const f = await fixture();
  try {
    const ids = ['batch-007', 'repair-007', 'call-007'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: makeFetch(f, { patch: { status: 'ready', issue: null, edits: [] } }),
      checkFn: async () => ({ passed: true, errors: [] }), idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.summary.repairRuns[0].status, 'failed');
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    const runDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const child = JSON.parse(await readFile(path.join(runDir, 'cases', 'case-000.json'), 'utf8'));
    assert.equal(child.failure.code, 'INVALID_MODEL_OUTPUT');
    assert.deepEqual(child.proposedRepairPatch, { status: 'ready', issue: null, edits: [] });
    assert.deepEqual(child.htmlFiles, []);
    const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
    assert.equal(dry.eligibleCount, 0);
    assert.equal(dry.skippedPriorRepairs, 1);
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('patched-HTML filesystem failure stops the batch and retains terminal accounting', async () => {
  const f = await fixture();
  try {
    const ids = ['batch-008', 'repair-008', 'call-008'];
    const result = await runCurriculumRepair({ rootDir: f.rootDir, live: true, config: modelConfig,
      readBundle: f.readBundle, fetchImpl: makeFetch(f),
      checkFn: async () => ({ passed: true, errors: [] }),
      writeHtmlFn: async () => { throw new Error('mock disk full'); },
      idFactory: () => ids.shift(), onProgress: () => {} });
    assert.equal(result.stopReason, 'infrastructure_error');
    assert.equal(result.status, 'stopped_after_infrastructure_error');
    const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    assert.equal(ledger.repairRuns[0].status, 'failed');
    assert.equal(ledger.activeRun, null);
    const childDir = path.join(f.rootDir, ledger.repairRuns[0].runDirectory);
    const child = JSON.parse(await readFile(path.join(childDir, 'cases', 'case-000.json'), 'utf8'));
    assert.equal(child.failure.code, 'REPAIR_INFRASTRUCTURE_ERROR');
    assert.equal(child.status, 'failed');
  } finally { await rm(f.rootDir, { recursive: true, force: true }); }
});

test('page-only repair excludes root-decided invalid plans and previously retried cases', async t => {
  await t.test('root decision is hash-bound and excludes the page-only path', async () => {
    const f = await fixture();
    try {
      const parentBytes = await readFile(f.parentCasePath);
      const decision = { caseId: f.firstCaseId, parentRunId: 'parent-0',
        parentCaseSha256: createHash('sha256').update(parentBytes).digest('hex'), kind: 'invalid_plan',
        reason: 'The saved plan has an independently reviewed mathematical error.' };
      await writeFile(path.join(f.rootDir, '.work', 'curriculum-regeneration-decisions.json'),
        `${JSON.stringify({ schemaVersion: 1, decisions: [decision] }, null, 2)}\n`);
      const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
      assert.equal(dry.eligibleCount, 0);
      assert.equal(dry.status, 'nothing_to_repair');
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
  await t.test('a terminal retry row excludes a competing page repair', async () => {
    const f = await fixture();
    try {
      const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      const parentBytes = await readFile(f.parentCasePath);
      ledger.retryRuns = [{ schemaVersion: 1, parentRunId: 'parent-0', caseId: f.firstCaseId,
        parentCaseSha256: createHash('sha256').update(parentBytes).digest('hex'), retryReason: 'MODEL_UNAVAILABLE', originalProblem: problem,
        usedProblem: problem, sourceCorrectionReason: null, decisionReason: null, decisionSha256: null,
        runId: 'retry-child', runDirectory: 'evaluation/runs/retry-child', status: 'failed',
        outgoingProviderRequests: 0, runEvaluationModelInvocations: 0,
        startedAt: '2026-11-17T12:02:00.000Z', finishedAt: '2026-11-17T12:03:00.000Z' }];
      await writeFile(f.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      const dry = await runCurriculumRepair({ rootDir: f.rootDir, readBundle: f.readBundle });
      assert.equal(dry.eligibleCount, 0);
      assert.equal(dry.status, 'nothing_to_repair');
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});
