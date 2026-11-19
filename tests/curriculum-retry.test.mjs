import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emptyReviewRecord } from '../evaluation/run.mjs';
import { parseRetryArgs, runCurriculumRetry } from '../evaluation/curriculum-retry.mjs';

const modelConfig = { provider: 'openrouter', apiKey: 'mock', model: 'anthropic/claude-sonnet-5.5',
  baseUrl: 'https://openrouter.ai/api/v1' };
const M_G01_ORIGINAL = 'Two parallel lines are cut by a transversal. One interior angle is 68°. Find its alternate interior angle and the adjacent interior angle on the same side of the transversal.';
const M_G01_CORRECTED = 'Two parallel lines are cut by a transversal. One interior angle is 68°. Find its alternate interior angle and the interior angle at the other intersection on the same side of the transversal.';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function makeAuthorization(ids) {
  return { userApproved: true, provider: 'openrouter', model: modelConfig.model,
    maxProviderCalls: 423, maxCostUSD: 20, reserveUSDPerCall: 0.65, maxRequestBytes: 90000,
    maxOutputTokens: 16000, providerMaxPricePerMillion: { prompt: 2.2, completion: 11 },
    queueSha256: 'a'.repeat(64), allowedCaseIds: ids };
}

function caseSource(id, problem, index) {
  return { id, problem, reference_answer: `answer ${index}`, checks: [`check ${index}`],
    stage: 'Middle School', coverage: 'M-A01', expected_behavior: 'interactive_reasoning',
    split: 'development', variant: 'basic', reference_status: 'authored_unreviewed' };
}

function makeRunReview(status = 'failed') {
  const cell = value => ({ status: value, reviewer: value === 'unreviewed' ? '' : 'reviewer',
    evidence: value === 'unreviewed' ? '' : `${value} evidence` });
  return { schemaVersion: 1,
    dimensions: { fidelity: cell('passed'), mathematics: cell(status), playability: cell('passed'), explanation: cell('passed') },
    checklist: { correct: cell('passed'), wrong: cell('passed'), reset: cell('passed'), multipleSolutions: cell('passed') },
    expectedBehavior: cell('passed') };
}

async function fixture(t, { cases = [{ id: 'case-000', kind: 'MODEL_UNAVAILABLE' }], complete = true,
  decisionIds = [], invalidDecisionHash = false, unreviewedDecision = false, unsafeRunId = false,
  missingArtifactIds = [] } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'mpl-curriculum-retry-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const customIds = new Set(cases.map(item => item.id));
  const ids = Array.from({ length: 141 }, (_, index) => {
    if (index < cases.length) return cases[index].id;
    let candidate = `case-${String(index).padStart(3, '0')}`;
    while (customIds.has(candidate)) candidate = `case-extra-${index}-${customIds.size}`;
    customIds.add(candidate);
    return candidate;
  });
  const queueCases = ids.map((id, index) => {
    const requested = cases.find(item => item.id === id);
    const problem = id === 'M-G01-basic' ? M_G01_ORIGINAL : `Original question ${index}`;
    const source = caseSource(id, problem, index);
    return { caseId: id, problem, reference_answer: source.reference_answer, checks: source.checks,
      stage: source.stage, coverage: source.coverage, variant: source.variant,
      reference_status: source.reference_status, source };
  });
  const allRuns = ids.map((caseId, index) => {
    const requested = cases.find(item => item.id === caseId);
    const failed = requested && ['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE', 'INCOMPLETE_MODEL_OUTPUT',
      'PLAN_CONFLICT'].includes(requested.kind);
    return { runId: `parent-${index}`, caseId, status: failed ? 'failed' : 'completed',
      startedAt: '2026-11-17T12:00:00.000Z', finishedAt: '2026-11-17T12:01:00.000Z',
      runDirectory: unsafeRunId && index === 0 ? '../outside' : path.join('evaluation', 'runs', `parent-${index}`),
      runEvaluationModelInvocations: 2, outgoingProviderRequests: 2 };
  }).slice(0, complete ? ids.length : ids.length - 1);
  const ledgerPath = path.join(rootDir, '.work', 'curriculum-live-budget.json');
  const ledger = { schemaVersion: 1, authorization: makeAuthorization(ids), calls: [], runs: allRuns,
    activeRun: null, budgetHalt: null };
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await mkdir(path.join(rootDir, 'evaluation', 'runs'), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const artifacts = new Map();
  for (const item of cases) {
    if (missingArtifactIds.includes(item.id)) continue;
    const index = ids.indexOf(item.id);
    const queued = queueCases[index];
    const runId = `parent-${index}`;
    const runDir = path.join(rootDir, 'evaluation', 'runs', runId);
    await mkdir(path.join(runDir, 'cases'), { recursive: true });
    await mkdir(path.join(runDir, 'html'), { recursive: true });
    const wantsHtml = item.savedHtml === true;
    const htmlRelative = wantsHtml ? `html/${item.id}-playable_exercise.html` : null;
    if (wantsHtml) await writeFile(path.join(runDir, htmlRelative), '<!doctype html><p>saved</p>');
    const recordStatus = item.kind === 'completed_generation' || item.kind === 'invalid_plan'
      ? 'completed_generation' : item.kind === 'completed_clarification' ? 'completed_clarification' : 'failed';
    const failureCode = item.kind === 'invalid_plan' ? 'PLAN_CONFLICT' : item.kind;
    const record = { schemaVersion: 1, id: item.id, status: recordStatus,
      attempted: true, suite: 'curriculum', coverage: queued.coverage, stage: queued.stage,
      split: 'development', expectedBehavior: queued.source.expected_behavior,
      originalCase: structuredClone(queued.source), originalInput: { problem: queued.problem },
      reference: { answer: queued.reference_answer, checks: queued.checks, status: queued.reference_status },
      review: item.review === 'unreviewed' ? emptyReviewRecord() : makeRunReview(item.review ?? 'failed'),
      htmlFiles: htmlRelative ? [htmlRelative] : [], latestGeneratedAttempt: htmlRelative ? 'playable_exercise' : null,
      providerCalls: 2, diagnostics: [], runtimeChecks: [], validatedContracts: [] };
    if (recordStatus === 'failed') record.failure = { code: failureCode, message: 'Local fixture failure.' };
    else if (recordStatus === 'completed_generation') record.result = { type: 'result', game: { id: 'parent-game' } };
    else record.result = { type: 'clarification', question: 'Clarify the question.' };
    const casePath = path.join(runDir, 'cases', `${item.id}.json`);
    await writeFile(casePath, `${JSON.stringify(record, null, 2)}\n`);
    const manifest = { schemaVersion: 1, runId, status: 'completed', evidenceClass: 'live', suite: 'curriculum',
      modelIdentifier: modelConfig.model, caseArtifactFiles: [`cases/${item.id}.json`] };
    await writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    artifacts.set(item.id, { casePath, caseBytes: await readFile(casePath), runDir });
  }
  if (decisionIds.length) {
    const decisions = decisionIds.map(caseId => {
      const run = allRuns.find(item => item.caseId === caseId);
      const artifact = artifacts.get(caseId);
      return { caseId, parentRunId: run.runId,
        parentCaseSha256: invalidDecisionHash ? '0'.repeat(64) : sha256(artifact.caseBytes),
        kind: 'invalid_plan', reason: 'The saved plan has an independently reviewed mathematical error.' };
    });
    if (unreviewedDecision) {
      const artifact = artifacts.get(decisionIds[0]);
      const record = JSON.parse((await readFile(artifact.casePath, 'utf8')));
      record.review = emptyReviewRecord();
      const updated = `${JSON.stringify(record, null, 2)}\n`;
      await writeFile(artifact.casePath, updated);
      artifact.caseBytes = Buffer.from(updated);
    }
    await writeFile(path.join(rootDir, '.work', 'curriculum-regeneration-decisions.json'),
      `${JSON.stringify({ schemaVersion: 1, decisions }, null, 2)}\n`);
  }

  const readBundle = async () => ({ rootDir, ledgerPath,
    ledger: JSON.parse(await readFile(ledgerPath, 'utf8')), queueCases,
    sourceDataset: { status: 'prepared_not_run', purpose: 'test', cases: queueCases.map(item => structuredClone(item.source)) } });
  return { rootDir, ledgerPath, readBundle, queueCases, artifacts };
}

function idSequence() {
  let index = 0;
  return () => `new-${++index}`;
}

function responseFetch({ fail = false, onFetch } = {}) {
  let fetched = 0;
  const fetchImpl = async (_url, _init) => {
    fetched += 1;
    onFetch?.(_init, fetched);
    if (fail) return new Response(JSON.stringify({ error: { message: 'private' } }), { status: 503 });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: '{}' }] }], usage: { cost: 0.1 } }), { status: 200 });
  };
  return { fetchImpl, get fetched() { return fetched; } };
}

function fakeRunEvaluation({ mode = 'success', modelCalls = 1, outcomeByCase = {}, prefetchRefusalByCase = [], onDataset } = {}) {
  return async args => {
    assert.equal(args.maxCalls, 3);
    assert.equal(args.live, true);
    const selected = args.dataset.cases.find(item => item.id === args.caseId);
    onDataset?.(selected);
    const prefetchRefusal = prefetchRefusalByCase.includes(args.caseId);
    let invoked = prefetchRefusal ? 1 : 0;
    let modelFailure;
    const requests = [
      ['play_plan', { originalProblem: selected.problem }],
      ['playable_exercise', { originalProblem: selected.problem, plan: {} }],
      ['repaired_exercise', { html: '<p>old</p>', originalProblem: selected.problem, plan: {}, runtimeErrors: ['failed'] }],
      ['play_plan', { originalProblem: selected.problem }],
    ];
    for (const [name, input] of (args.signal?.aborted || prefetchRefusal ? [] : requests.slice(0, modelCalls))) {
      invoked += 1;
      try { await args.model.complete({ name, input, instructions: 'Return a JSON object.', schema: { type: 'object' }, signal: args.signal }); }
      catch (error) { modelFailure = error; break; }
    }
    const runId = args.idFactory();
    const runDir = path.join(args.rootDir, 'evaluation', 'runs', runId);
    await mkdir(path.join(runDir, 'cases'), { recursive: true });
    await mkdir(path.join(runDir, 'html'), { recursive: true });
    const wasCancelled = args.signal?.aborted === true;
    const explicitFailure = outcomeByCase[args.caseId] ?? (prefetchRefusal ? 'MODEL_UNAVAILABLE' : null);
    const failed = Boolean(explicitFailure) || mode === 'provider_failure' ||
      modelFailure?.code === 'MODEL_REQUEST_FAILED' || modelFailure?.code === 'MODEL_UNAVAILABLE';
    const status = wasCancelled ? 'unrun' : failed ? 'failed' : 'completed_generation';
    const record = { schemaVersion: 1, id: args.caseId, status, attempted: !wasCancelled,
      suite: 'curriculum', originalCase: structuredClone(selected), originalInput: { problem: selected.problem },
      providerCalls: Math.min(invoked, 3), review: emptyReviewRecord(),
      htmlFiles: [], diagnostics: [],
      ...(failed ? { failure: { code: explicitFailure ?? modelFailure?.code ?? 'MODEL_UNAVAILABLE', message: 'Local failure.' } } : {}) };
    if (['RUNTIME_CHECK_FAILED', 'BROWSER_UNAVAILABLE'].includes(record.failure?.code)) {
      const htmlName = `html/${args.caseId}-playable_exercise.html`;
      await writeFile(path.join(runDir, htmlName), '<!doctype html><p>generated</p>');
      record.htmlFiles = [htmlName];
      record.runtimeChecks = [{ type: 'runtime_check', attempt: 0, passed: false, errors: ['Local browser result.'] }];
    }
    const manifest = { schemaVersion: 1, runId, status: wasCancelled ? 'cancelled' : 'completed',
      evidenceClass: 'live', suite: 'curriculum', modelIdentifier: modelConfig.model,
      caseArtifactFiles: [`cases/${args.caseId}.json`], providerCalls: record.providerCalls };
    await writeFile(path.join(runDir, 'cases', `${args.caseId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { kind: 'run', runDir, manifest };
  };
}

test('retry CLI defaults to a one-case zero-call preview', () => {
  assert.deepEqual(parseRetryArgs([]), { live: false, limit: 1 });
  assert.deepEqual(parseRetryArgs(['--live', '--limit', '2']), { live: true, limit: 2 });
  assert.throws(() => parseRetryArgs(['--limit', '0']), /positive integer/);
});

test('incomplete first pass is visible in dry run and refuses live mode', async t => {
  const f = await fixture(t, { complete: false });
  const dry = await runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle });
  assert.equal(dry.status, 'blocked');
  assert.equal(dry.firstPass.pendingCount, 1);
  await assert.rejects(runCurriculumRetry({ rootDir: f.rootDir, live: true, readBundle: f.readBundle }), /incomplete/);
});

test('dry run is read-only and reports provider, truncation and correction candidates', async t => {
  const f = await fixture(t, { cases: [
    { id: 'case-000', kind: 'MODEL_REQUEST_FAILED' },
    { id: 'case-001', kind: 'INCOMPLETE_MODEL_OUTPUT' },
    { id: 'M-G01-basic', kind: 'PLAN_CONFLICT' },
  ] });
  const before = await readFile(f.ledgerPath, 'utf8');
  const preview = await runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle, limit: 3 });
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.eligible.map(item => item.reason), ['MODEL_REQUEST_FAILED', 'INCOMPLETE_MODEL_OUTPUT', 'source_correction']);
  assert.deepEqual(preview.selected.map(item => item.id), ['case-000', 'case-001', 'M-G01-basic']);
  assert.equal(preview.budget.admissionCalls, 3);
  assert.equal(preview.budget.admissionCostUSD, 1.95);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), before);
  assert.equal((await readdir(path.join(f.rootDir, '.work'))).includes('curriculum-live-budget.lock'), false);
  assert.deepEqual(await readdir(path.join(f.rootDir, 'evaluation', 'runs')), ['parent-0', 'parent-1', 'parent-2']);
});

test('saved HTML, other conflicts, clarification and unsafe parents are excluded', async t => {
  const f = await fixture(t, { cases: [
    { id: 'case-000', kind: 'MODEL_UNAVAILABLE', savedHtml: true },
    { id: 'case-001', kind: 'PLAN_CONFLICT' },
    { id: 'case-002', kind: 'completed_clarification' },
    { id: 'case-003', kind: 'completed_generation' },
  ] });
  const preview = await runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle });
  assert.deepEqual(preview.eligible, []);

  const unsafe = await fixture(t, { unsafeRunId: true, cases: [{ id: 'case-000', kind: 'MODEL_UNAVAILABLE' }] });
  const unsafePreview = await runCurriculumRetry({ rootDir: unsafe.rootDir, readBundle: unsafe.readBundle });
  assert.deepEqual(unsafePreview.eligible, []);

  const missing = await fixture(t, { cases: [{ id: 'case-000', kind: 'MODEL_REQUEST_FAILED' }],
    missingArtifactIds: ['case-000'] });
  const missingPreview = await runCurriculumRetry({ rootDir: missing.rootDir, readBundle: missing.readBundle });
  assert.deepEqual(missingPreview.eligible, []);
});

test('root decision is hash-bound and permits a full retry of an independently failed saved page', async t => {
  const f = await fixture(t, { cases: [{ id: 'case-000', kind: 'invalid_plan', savedHtml: true }], decisionIds: ['case-000'] });
  const preview = await runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle });
  assert.equal(preview.eligible[0].reason, 'invalid_plan');
  assert.equal(preview.eligible[0].id, 'case-000');

  const badHash = await fixture(t, { cases: [{ id: 'case-000', kind: 'invalid_plan' }],
    decisionIds: ['case-000'], invalidDecisionHash: true });
  await assert.rejects(runCurriculumRetry({ rootDir: badHash.rootDir, readBundle: badHash.readBundle }), /stale or lacks/);

  const unreviewed = await fixture(t, { cases: [{ id: 'case-000', kind: 'invalid_plan' }],
    decisionIds: ['case-000'], unreviewedDecision: true });
  await assert.rejects(runCurriculumRetry({ rootDir: unreviewed.rootDir, readBundle: unreviewed.readBundle }), /stale or lacks/);

  const tampered = await fixture(t, { cases: [{ id: 'case-000', kind: 'invalid_plan' }], decisionIds: ['case-000'] });
  const tamperedRecord = JSON.parse(await readFile(tampered.artifacts.get('case-000').casePath, 'utf8'));
  tamperedRecord.originalInput.problem = 'tampered question';
  await writeFile(tampered.artifacts.get('case-000').casePath, `${JSON.stringify(tamperedRecord, null, 2)}\n`);
  await assert.rejects(runCurriculumRetry({ rootDir: tampered.rootDir, readBundle: tampered.readBundle }), /stale or lacks/);

  const malformed = await fixture(t, { cases: [{ id: 'case-000', kind: 'invalid_plan' }], decisionIds: ['case-000'] });
  const decisionPath = path.join(malformed.rootDir, '.work', 'curriculum-regeneration-decisions.json');
  const saved = JSON.parse(await readFile(decisionPath, 'utf8'));
  saved.decisions.push({ ...saved.decisions[0], extra: 'not approved' });
  await writeFile(decisionPath, `${JSON.stringify(saved, null, 2)}\n`);
  await assert.rejects(runCurriculumRetry({ rootDir: malformed.rootDir, readBundle: malformed.readBundle }), /fields are malformed/);
});

test('one retry preserves first-pass rows and parent bytes, stores truthful child provenance and empty review', async t => {
  const f = await fixture(t, { cases: [{ id: 'case-000', kind: 'MODEL_UNAVAILABLE' }] });
  const beforeLedger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  const parentBytes = await readFile(f.artifacts.get('case-000').casePath);
  const fetch = responseFetch();
  const result = await runCurriculumRetry({ rootDir: f.rootDir, live: true, limit: 1,
    config: modelConfig, readBundle: f.readBundle, fetchImpl: fetch.fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ mode: 'success' }), now: () => '2026-11-17T13:00:00.000Z',
    idFactory: idSequence(), onProgress: () => {} });
  assert.equal(result.status, 'completed');
  assert.equal(result.outgoingProviderRequests, 1);
  assert.equal(fetch.fetched, 1);
  const after = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.deepEqual(after.runs, beforeLedger.runs);
  assert.deepEqual(await readFile(f.artifacts.get('case-000').casePath), parentBytes);
  assert.equal(after.retryRuns.length, 1);
  assert.equal(after.retryRuns[0].parentCaseSha256, sha256(parentBytes));
  const childPath = path.join(f.rootDir, after.retryRuns[0].runDirectory, 'cases', 'case-000.json');
  const child = JSON.parse(await readFile(childPath, 'utf8'));
  assert.equal(child.originalInput.problem, 'Original question 0');
  assert.equal(child.originalCase.problem, 'Original question 0');
  assert.ok(Object.values(child.review.dimensions).every(cell => cell.status === 'unreviewed'));
  assert.equal(child.retryProvenance.parentCaseSha256, sha256(parentBytes));
  assert.equal(child.retryProvenance.usedProblem, 'Original question 0');
  const resumed = await runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle });
  assert.equal(resumed.status, 'nothing_to_retry');
  assert.deepEqual(resumed.skippedAlreadyRetried, ['case-000']);
});

test('M-G01 uses only the explicit corrected prompt and records the original question', async t => {
  const f = await fixture(t, { cases: [{ id: 'M-G01-basic', kind: 'PLAN_CONFLICT' }] });
  let seenProblem;
  const result = await runCurriculumRetry({ rootDir: f.rootDir, live: true, config: modelConfig,
    readBundle: f.readBundle, fetchImpl: responseFetch().fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ onDataset: item => { seenProblem = item.problem; } }),
    idFactory: idSequence(), onProgress: () => {} });
  assert.equal(result.retries[0].reason, 'source_correction');
  assert.equal(seenProblem, M_G01_CORRECTED);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  const row = ledger.retryRuns[0];
  assert.equal(row.originalProblem, M_G01_ORIGINAL);
  assert.equal(row.usedProblem, M_G01_CORRECTED);
  assert.match(row.sourceCorrectionReason, /different intersections/);
  const child = JSON.parse(await readFile(path.join(f.rootDir, row.runDirectory, 'cases', row.caseId + '.json'), 'utf8'));
  assert.equal(child.originalCase.problem, M_G01_CORRECTED);
  assert.equal(child.originalInput.problem, M_G01_CORRECTED);
});

test('provider failure stops after one retry and preserves its unknown cost', async t => {
  const f = await fixture(t, { cases: [
    { id: 'case-000', kind: 'MODEL_UNAVAILABLE' },
    { id: 'case-001', kind: 'INCOMPLETE_MODEL_OUTPUT' },
  ] });
  const fetch = responseFetch({ fail: true });
  const result = await runCurriculumRetry({ rootDir: f.rootDir, live: true, limit: 2,
    config: modelConfig, readBundle: f.readBundle, fetchImpl: fetch.fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ mode: 'provider_failure' }), idFactory: idSequence(), onProgress: () => {} });
  assert.equal(result.status, 'stopped_after_provider_failure');
  assert.equal(result.selectedCount, 1);
  assert.equal(fetch.fetched, 1);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.calls[0].status, 'unknown');
  assert.equal(ledger.calls[0].actualCostUSD, null);
  assert.equal(ledger.retryRuns.length, 1);
  assert.equal(ledger.retryRuns[0].status, 'failed');
});

test('runtime page failure is retained while the next retry proceeds', async t => {
  const f = await fixture(t, { cases: [
    { id: 'case-000', kind: 'MODEL_UNAVAILABLE' },
    { id: 'case-001', kind: 'INCOMPLETE_MODEL_OUTPUT' },
  ] });
  const fetch = responseFetch();
  const result = await runCurriculumRetry({ rootDir: f.rootDir, live: true, limit: 2,
    config: modelConfig, readBundle: f.readBundle, fetchImpl: fetch.fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ outcomeByCase: { 'case-000': 'RUNTIME_CHECK_FAILED' } }),
    idFactory: idSequence(), onProgress: () => {} });
  assert.equal(result.status, 'completed');
  assert.equal(result.selectedCount, 2);
  assert.equal(fetch.fetched, 2);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.deepEqual(ledger.retryRuns.map(row => row.status), ['failed', 'completed']);
  assert.equal(ledger.retryRuns[0].outgoingProviderRequests, 1);
});

test('browser infrastructure failure stops before the next retry', async t => {
  const f = await fixture(t, { cases: [
    { id: 'case-000', kind: 'MODEL_UNAVAILABLE' },
    { id: 'case-001', kind: 'INCOMPLETE_MODEL_OUTPUT' },
  ] });
  const fetch = responseFetch();
  const result = await runCurriculumRetry({ rootDir: f.rootDir, live: true, limit: 2,
    config: modelConfig, readBundle: f.readBundle, fetchImpl: fetch.fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ outcomeByCase: { 'case-000': 'BROWSER_UNAVAILABLE' } }),
    idFactory: idSequence(), onProgress: () => {} });
  assert.equal(result.status, 'stopped_after_browser_failure');
  assert.equal(result.selectedCount, 1);
  assert.equal(fetch.fetched, 1);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.equal(ledger.retryRuns.length, 1);
  assert.equal(ledger.retryRuns[0].status, 'failed');
});

test('prefetch refusal keeps model-invocation and outgoing-request counts distinct', async t => {
  const f = await fixture(t, { cases: [{ id: 'case-000', kind: 'MODEL_UNAVAILABLE' }] });
  const fetch = responseFetch();
  const result = await runCurriculumRetry({ rootDir: f.rootDir, live: true, config: modelConfig,
    readBundle: f.readBundle, fetchImpl: fetch.fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ prefetchRefusalByCase: ['case-000'] }),
    idFactory: idSequence(), onProgress: () => {} });
  assert.equal(result.status, 'stopped_after_provider_failure');
  assert.equal(fetch.fetched, 0);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.equal(ledger.calls.length, 0);
  assert.equal(ledger.retryRuns[0].runEvaluationModelInvocations, 1);
  assert.equal(ledger.retryRuns[0].outgoingProviderRequests, 0);
  const child = JSON.parse(await readFile(path.join(f.rootDir, ledger.retryRuns[0].runDirectory,
    'cases', 'case-000.json'), 'utf8'));
  assert.equal(child.providerCalls, 1);
});

test('retry local call cap blocks a fourth provider request before fetch', async t => {
  const f = await fixture(t, { cases: [{ id: 'case-000', kind: 'MODEL_UNAVAILABLE' }] });
  const fetch = responseFetch();
  await runCurriculumRetry({ rootDir: f.rootDir, live: true, config: modelConfig,
    readBundle: f.readBundle, fetchImpl: fetch.fetchImpl,
    runEvaluationFn: fakeRunEvaluation({ modelCalls: 4 }), idFactory: idSequence(), onProgress: () => {} });
  assert.equal(fetch.fetched, 3);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.equal(ledger.retryRuns[0].outgoingProviderRequests, 3);
  assert.equal(ledger.calls.length, 3);
});

test('duplicate or malformed saved retry accounting refuses instead of selecting again', async t => {
  const f = await fixture(t, { cases: [{ id: 'case-000', kind: 'MODEL_UNAVAILABLE' }] });
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  ledger.retryRuns = {};
  await writeFile(f.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await assert.rejects(runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle }), /retryRuns must be an array/);

  ledger.retryRuns = [];
  const row = { schemaVersion: 1, parentRunId: 'parent-0', caseId: 'case-000',
    parentCaseSha256: 'a'.repeat(64), retryReason: 'MODEL_UNAVAILABLE',
    originalProblem: 'Original question 0', usedProblem: 'Original question 0',
    sourceCorrectionReason: null, decisionReason: null, decisionSha256: null,
    runId: 'retry-one', runDirectory: 'evaluation/runs/retry-one', status: 'failed',
    outgoingProviderRequests: 0, runEvaluationModelInvocations: 0,
    startedAt: '2026-11-17T12:02:00.000Z', finishedAt: '2026-11-17T12:03:00.000Z' };
  ledger.retryRuns = [row, { ...row, runId: 'retry-two', runDirectory: 'evaluation/runs/retry-two' }];
  await writeFile(f.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await assert.rejects(runCurriculumRetry({ rootDir: f.rootDir, readBundle: f.readBundle }), /saved retryRuns accounting is malformed/);

  ledger.retryRuns = [];
  await writeFile(f.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await assert.rejects(runCurriculumRetry({ rootDir: f.rootDir, live: true, config: modelConfig,
    readBundle: f.readBundle, idFactory: idSequence(), onProgress: () => {},
    runEvaluationFn: async () => { throw new Error('must not run'); } }), /must not run/);
});

test('active shared lock refuses live retry', async t => {
  const f = await fixture(t);
  const lockPath = path.join(f.rootDir, '.work', 'curriculum-live-budget.lock');
  await writeFile(lockPath, '{"runId":"other","startedAt":"2026-11-17T12:00:00.000Z"}\n');
  await assert.rejects(runCurriculumRetry({ rootDir: f.rootDir, live: true, config: modelConfig,
    readBundle: f.readBundle, idFactory: idSequence(), onProgress: () => {} }), /existing lock/);
});

test('cancellation persists a cancelled child and runner failure leaves a started fail-closed row', async t => {
  const cancelled = await fixture(t);
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  const cancelledResult = await runCurriculumRetry({ rootDir: cancelled.rootDir, live: true,
    config: modelConfig, readBundle: cancelled.readBundle, signal: controller.signal,
    runEvaluationFn: fakeRunEvaluation(), idFactory: idSequence(), onProgress: () => {} });
  assert.equal(cancelledResult.status, 'cancelled');
  const cancelledLedger = JSON.parse(await readFile(cancelled.ledgerPath, 'utf8'));
  assert.equal(cancelledLedger.retryRuns[0].status, 'cancelled');
  assert.equal(cancelledLedger.activeRun, null);

  const failed = await fixture(t);
  await assert.rejects(runCurriculumRetry({ rootDir: failed.rootDir, live: true, config: modelConfig,
    readBundle: failed.readBundle, idFactory: idSequence(), onProgress: () => {},
    runEvaluationFn: async () => { throw new Error('mock persistence failure'); } }), /mock persistence failure/);
  const failedLedger = JSON.parse(await readFile(failed.ledgerPath, 'utf8'));
  assert.equal(failedLedger.retryRuns[0].status, 'started');
  assert.ok(failedLedger.activeRun);
  await assert.rejects(runCurriculumRetry({ rootDir: failed.rootDir, readBundle: failed.readBundle }), /unfinished retry/);
});
