import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSweep } from '../evaluation/curriculum-sweep.mjs';
import {
  APPROVED_RESERVATION_EVIDENCE_SHA256, acquireSweepLock, assertLedgerIdle, createBudgetedFetch,
  reservationProjectionSha256, reservationUpperBoundMicroUSD, selectPendingCases, sweepTotals,
  validateLedger, validateReservationBound, validateSweepData,
} from '../evaluation/sweep-budget.mjs';

function makeAuth(allowedCaseIds = []) {
  return { userApproved: true, provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5',
    maxProviderCalls: 423, maxCostUSD: 20, reserveUSDPerCall: 0.65, maxRequestBytes: 90000,
    maxOutputTokens: 16000, providerMaxPricePerMillion: { prompt: 2.2, completion: 11 },
    queueSha256: '', allowedCaseIds };
}

function makeLedger(authorization) {
  return { schemaVersion: 1, authorization, calls: [], runs: [], activeRun: null };
}

function syntheticBoundCall() {
  const call = { callId: 'call-synthetic', caseId: 'case-synthetic', runId: 'run-synthetic',
    requestName: 'play_plan', status: 'unknown', reservedCostUSD: 0.65, actualCostUSD: null,
    startedAt: '2026-11-17T06:00:00.000Z', finishedAt: '2026-11-17T06:00:01.000Z' };
  call.reservationBound = { schemaVersion: 1, evidenceFileSha256: APPROVED_RESERVATION_EVIDENCE_SHA256,
    sourceCaseSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), requestBytes: 8192,
    inputTokenUpperBound: 16384, maxOutputTokens: 6000, maximumInputUSDPerMillion: 4.4,
    maximumOutputUSDPerMillion: 11, cushionUSD: 0.05, originalReserveUSD: 0.65,
    upperBoundUSD: reservationUpperBoundMicroUSD({ inputTokenUpperBound: 16384, maxOutputTokens: 6000,
      maximumInputUSDPerMillion: 4.4, maximumOutputUSDPerMillion: 11, cushionUSD: 0.05 }) / 1e6 };
  return call;
}

function makeRequest(name = 'play_plan', changes = {}) {
  const input = name === 'play_plan' ? { originalProblem: 'Solve 2+2.' } :
    name === 'playable_exercise' ? { originalProblem: 'Solve 2+2.', plan: { status: 'ready' } } :
      { html: '<p></p>', originalProblem: 'Solve 2+2.', plan: { status: 'ready' }, runtimeErrors: ['missing reset'] };
  const body = { model: 'anthropic/claude-sonnet-5.5', instructions: 'Return JSON.', input: JSON.stringify(input),
    store: false, max_output_tokens: 16000,
    text: { format: { type: 'json_schema', name,
      schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false },
      strict: true } },
    stream: false, provider: { require_parameters: true }, reasoning: { effort: 'medium' }, ...changes };
  return { url: 'https://openrouter.ai/api/v1/responses', init: {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } };
}

function makeAssessmentRepairRequest(overrides = {}) {
  const assessment = { version: 1, requiresReview: false, fields: [{ id: 'answer', initial: '' }],
    checkpoints: [{ id: 'answer-check', field: 'answer', dependsOn: [], watchFields: [],
      rule: { kind: 'exact', expected: '4' }, feedback: 'Try again.' }] };
  const playtest = { solve: [{ action: 'fill', selector: '#answer', value: '4' }],
    wrong: [{ action: 'fill', selector: '#answer', value: '5' }],
    recover: [{ action: 'fill', selector: '#answer', value: '4' }],
    invalidate: [{ action: 'fill', selector: '#answer', value: '5' }] };
  const input = { assessment, html: '<p>Saved activity</p>', originalProblem: 'Solve 2+2.',
    plan: { assessment: structuredClone(assessment) }, playtest, runtimeErrors: ['The playthrough failed.'], ...overrides };
  return makeRequest('repaired_exercise', { input: JSON.stringify(input) });
}

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'curriculum-sweep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fetcherFor({ ledger, ledgerPath, authorization = ledger.authorization, caseId = 'case-000',
  runId = randomUUID(), fetchImpl, ...caps }) {
  return createBudgetedFetch({ ledger, ledgerPath, authorization, caseId, runId, fetchImpl, ...caps });
}

test('reserves and persists before fetch, injects price caps, then settles known cost', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  const ledgerPath = path.join(directory, 'ledger.json');
  let fetched = 0;
  const budgetedFetch = fetcherFor({ ledger, ledgerPath, fetchImpl: async (_url, init) => {
    fetched += 1;
    const saved = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(saved.calls[0].status, 'pending');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.provider, { require_parameters: true, max_price: { prompt: 2.2, completion: 11 } });
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.ok(Buffer.byteLength(init.body) <= 90000);
    return new Response(JSON.stringify({ usage: { cost: 0.21 } }), { status: 200,
      headers: { 'content-type': 'application/json' } });
  } });
  const { url, init } = makeRequest();
  const response = await budgetedFetch(url, init);
  assert.equal(fetched, 1);
  assert.deepEqual(await response.json(), { usage: { cost: 0.21 } });
  assert.equal(ledger.calls[0].status, 'settled');
  assert.equal(ledger.calls[0].actualCostUSD, 0.21);
  assert.equal(sweepTotals(ledger).committedUSD, 0.21);
});

test('accepts exact legacy and assessment-bearing repair inputs, rejecting partial or mismatched traces before fetch', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  let fetched = 0;
  const budgetedFetch = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'),
    fetchImpl: async () => { fetched += 1; return new Response(JSON.stringify({ usage: { cost: 0.1 } })); } });
  const legacy = makeRequest('repaired_exercise');
  await budgetedFetch(legacy.url, legacy.init);
  const assessed = makeAssessmentRepairRequest();
  await budgetedFetch(assessed.url, assessed.init);

  const validInput = JSON.parse(JSON.parse(assessed.init.body).input);
  const legacyWithAssessment = JSON.parse(JSON.parse(legacy.init.body).input);
  legacyWithAssessment.plan.assessment = structuredClone(validInput.assessment);
  const invalidInputs = [
    legacyWithAssessment,
    { ...validInput, playtest: undefined },
    { ...validInput, assessment: { ...validInput.assessment, requiresReview: true } },
    { ...validInput, extra: true },
    { ...validInput, playtest: { ...validInput.playtest, solve: [{ action: 'evaluate', selector: '#answer', value: '4' }] } },
  ];
  for (const input of invalidInputs) {
    const request = makeRequest('repaired_exercise', { input: JSON.stringify(input) });
    await assert.rejects(budgetedFetch(request.url, request.init), /request schema or priced capabilities/);
  }
  assert.equal(fetched, 2);
  assert.equal(ledger.calls.length, 2);
});

test('keeps HTTP error cost unknown while retaining safe response metadata and a readable body', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  const body = { error: { message: 'Do not save this error text.', limit_source: 'provider',
    reason: 'rate_limit_exceeded', account_id: 'account-private-123', metadata: { prompt: 'private prompt' } },
  usage: { cost: 0.13 } };
  const budgetedFetch = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'),
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 429,
      headers: { 'retry-after': '12.5', 'x-request-id': 'req_123.safe',
        'x-openrouter-generation-id': 'gen-123.safe' } }) });
  const { url, init } = makeRequest();
  const response = await budgetedFetch(url, init);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), body);
  assert.equal(ledger.calls[0].status, 'unknown');
  assert.equal(ledger.calls[0].reservedCostUSD, 0.65);
  assert.equal(ledger.calls[0].actualCostUSD, null);
  assert.equal(ledger.calls[0].httpStatus, 429);
  assert.equal(ledger.calls[0].retryAfterSeconds, 12.5);
  assert.equal(ledger.calls[0].requestId, 'req_123.safe');
  assert.equal(ledger.calls[0].generationId, 'gen-123.safe');
  assert.equal(ledger.calls[0].limit_source, 'provider');
  assert.equal(ledger.calls[0].reason, 'rate_limit_exceeded');
  const saved = JSON.stringify(ledger.calls[0]);
  for (const secret of ['Do not save', 'account-private-123', 'private prompt', '0.13']) {
    assert.equal(saved.includes(secret), false);
  }
  assert.equal(sweepTotals(ledger).unknownReservedUSD, 0.65);
});

test('drops unrecognized provider metadata, unsafe IDs, and unbounded retry-after values', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  const budgetedFetch = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'),
    fetchImpl: async () => new Response(JSON.stringify({ error: { limit_source: 'account-123-secret',
      reason: 'raw provider message with private data' } }), { status: 503,
      headers: { 'retry-after': '86400', 'x-request-id': 'account-private-123' } }) });
  const { url, init } = makeRequest();
  await budgetedFetch(url, init);
  const call = ledger.calls[0];
  assert.equal(call.httpStatus, 503);
  assert.equal(Object.hasOwn(call, 'retryAfterSeconds'), false);
  assert.equal(Object.hasOwn(call, 'requestId'), false);
  assert.equal(Object.hasOwn(call, 'limit_source'), false);
  assert.equal(Object.hasOwn(call, 'reason'), false);
  assert.equal(call.status, 'unknown');
  assert.equal(call.reservedCostUSD, 0.65);
  assert.equal(JSON.stringify(call).includes('private'), false);
});

test('keeps official OpenRouter budget metadata from nested error details', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  const cases = [
    ['openrouter_in_flight_budget', 'in_flight_budget_exhausted'],
    ['openrouter_credits', 'weight_exceeds_budget'],
    ['openrouter_key_limit', 'weight_exceeds_budget'],
  ];
  for (const [limitSource, reason] of cases) {
    const budgetedFetch = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'),
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'sensitive message',
        metadata: { limit_source: limitSource, reason, account_id: 'private-account', prompt: 'private prompt' } } }),
      { status: 402 }) });
    const { url, init } = makeRequest();
    await budgetedFetch(url, init);
    const call = ledger.calls.at(-1);
    assert.equal(call.limit_source, limitSource);
    assert.equal(call.reason, reason);
    assert.equal(call.status, 'unknown');
    assert.equal(call.reservedCostUSD, 0.65);
    const saved = JSON.stringify(call);
    assert.equal(saved.includes('sensitive message'), false);
    assert.equal(saved.includes('private-account'), false);
    assert.equal(saved.includes('private prompt'), false);
  }
});

test('retains the full reservation when cost is absent, malformed, non-JSON, or fetch aborts', async t => {
  const outcomes = [
    ['missing usage', async () => new Response(JSON.stringify({ status: 'completed' }))],
    ['missing cost', async () => new Response(JSON.stringify({ usage: { total_tokens: 2 } }))],
    ['negative cost', async () => new Response(JSON.stringify({ usage: { cost: -1 } }))],
    ['string cost', async () => new Response(JSON.stringify({ usage: { cost: '0.12' } }))],
    ['non-JSON body', async () => new Response('not json')],
    ['abort', async () => { throw new DOMException('aborted', 'AbortError'); }],
  ];
  for (const [name, fetchImpl] of outcomes) await t.test(name, async t2 => {
    const directory = await tempDir(t2);
    const ledger = makeLedger(makeAuth());
    const budgetedFetch = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'), fetchImpl });
    const { url, init } = makeRequest();
    if (name === 'abort') await assert.rejects(budgetedFetch(url, init), { name: 'AbortError' });
    else await budgetedFetch(url, init);
    assert.equal(ledger.calls[0].status, 'unknown');
    assert.equal(ledger.calls[0].reservedCostUSD, 0.65);
    assert.equal(ledger.calls[0].actualCostUSD, null);
    assert.equal(sweepTotals(ledger).unknownReservedUSD, 0.65);
    assert.equal(sweepTotals(ledger).unknownOriginalReservedUSD, 0.65);
    assert.equal(sweepTotals(ledger).unknownBoundedUSD, 0);
  });
});

test('provider and cost caps stop before network access', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return new Response(JSON.stringify({ usage: { cost: 0.1 } }));
  };
  const limited = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'), fetchImpl,
    maxProviderCalls: 1 });
  const request = makeRequest();
  await limited(request.url, request.init);
  await assert.rejects(limited(request.url, request.init), /before network access/);
  assert.equal(fetched, 1);

  const noRoomLedger = makeLedger(makeAuth());
  const noRoom = fetcherFor({ ledger: noRoomLedger, ledgerPath: path.join(directory, 'no-room.json'),
    fetchImpl, maxCostUSD: 0.64 });
  await assert.rejects(noRoom(request.url, request.init), /before network access/);
  assert.equal(fetched, 1);
  assert.equal(noRoomLedger.calls.length, 0);
});

test('rejects wrong destination, wrong model, tools, and oversized injected request before fetch', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  let fetched = 0;
  const budgetedFetch = fetcherFor({ ledger, ledgerPath: path.join(directory, 'ledger.json'),
    fetchImpl: async () => { fetched += 1; return new Response('{}'); } });
  const request = makeRequest();
  await assert.rejects(budgetedFetch('https://example.com/responses', request.init), /only the approved/);
  const wrongModel = makeRequest('play_plan', { model: 'other/model' });
  await assert.rejects(budgetedFetch(wrongModel.url, wrongModel.init), /outside authorization/);
  const withTools = makeRequest('play_plan', { tools: [{ type: 'web_search' }] });
  await assert.rejects(budgetedFetch(withTools.url, withTools.init), /outside authorization/);
  const oversized = makeRequest('play_plan', { instructions: 'x'.repeat(90001) });
  await assert.rejects(budgetedFetch(oversized.url, oversized.init), /byte limit/);
  assert.equal(fetched, 0);
  assert.equal(ledger.calls.length, 0);
});

test('persists a durable halt on per-call overrun and refuses later requests and batches', async t => {
  const directory = await tempDir(t);
  const ledger = makeLedger(makeAuth());
  const ledgerPath = path.join(directory, 'ledger.json');
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return new Response(JSON.stringify({ usage: { cost: 0.66 } }));
  };
  const first = fetcherFor({ ledger, ledgerPath, fetchImpl });
  const request = makeRequest();
  await assert.rejects(first(request.url, request.init), /exceeded its per-call reservation/);
  const saved = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.equal(saved.budgetHalt.reason, 'cost_exceeded_reservation');
  assert.equal(saved.calls[0].status, 'settled');
  assert.equal(saved.calls[0].actualCostUSD, 0.66);
  const restarted = fetcherFor({ ledger, ledgerPath, fetchImpl });
  await assert.rejects(restarted(request.url, request.init), /earlier request exceeded/);
  assert.throws(() => assertLedgerIdle(ledger), /requires manual review/);
  assert.equal(fetched, 1);
});

test('malformed accounting and unauthorized cap increases fail closed', () => {
  const ledger = makeLedger(makeAuth());
  ledger.calls.push({ callId: 'call-1', caseId: 'case-000', runId: 'run-1', requestName: 'play_plan',
    status: 'unknown', reservedCostUSD: 0, actualCostUSD: null, startedAt: '2026-11-17T00:00:00Z',
    finishedAt: '2026-11-17T00:00:01Z' });
  assert.throws(() => sweepTotals(ledger), /malformed call accounting/);
  const cleanLedger = makeLedger(makeAuth());
  assert.throws(() => fetcherFor({ ledger: cleanLedger, ledgerPath: '/tmp/unused-ledger.json',
    fetchImpl: async () => new Response('{}'), maxProviderCalls: 424 }), /may only lower/);
  assert.throws(() => fetcherFor({ ledger: cleanLedger, ledgerPath: '/tmp/unused-ledger.json',
    fetchImpl: async () => new Response('{}'), maxCostUSD: 21 }), /may only lower/);
});

test('reservation formula and call validation are portable without evidence or ledger fixtures', () => {
  const bound = { inputTokenUpperBound: 16384, maxOutputTokens: 6000,
    maximumInputUSDPerMillion: 4.4, maximumOutputUSDPerMillion: 11, cushionUSD: 0.05 };
  assert.equal(reservationUpperBoundMicroUSD(bound), 188090);
  assert.throws(() => reservationUpperBoundMicroUSD({ ...bound, maximumInputUSDPerMillion: 2.2 }), /outside the approved limits/);

  const call = syntheticBoundCall();
  const authorization = makeAuth();
  authorization.maxRequestBytes = 90000;
  authorization.maxOutputTokens = 16000;
  assert.equal(validateReservationBound(call, authorization), call.reservationBound);
  const underbound = structuredClone(call);
  underbound.reservationBound.upperBoundUSD -= 0.000001;
  assert.throws(() => validateReservationBound(underbound, authorization), /conservative formula/);
  const badStatus = structuredClone(call);
  badStatus.status = 'pending';
  assert.throws(() => validateReservationBound(badStatus, authorization), /malformed or no longer eligible/);

  const ledger = makeLedger(authorization);
  ledger.calls.push(call);
  assert.throws(() => validateLedger(ledger), /lack reconciliation provenance/);
  const malformedProvenance = makeLedger(authorization);
  malformedProvenance.reservationReconciliation = {};
  assert.throws(() => validateLedger(malformedProvenance), /provenance is malformed/);
});

test('canonical projection digest changes with coherent bound or call identity edits', () => {
  const sourceFiles = Object.fromEntries(['server/contracts.mjs', 'server/generate.mjs', 'server/model.mjs', 'server/prompts.mjs']
    .map((relative, index) => [relative, { sha256: String(index + 1).repeat(64), mtime: '2026-11-16T00:00:00.000Z' }]));
  const call = syntheticBoundCall();
  const entries = [{ call, bound: call.reservationBound }];
  const initial = reservationProjectionSha256(sourceFiles, entries);
  assert.equal(reservationProjectionSha256(sourceFiles, entries), initial);
  assert.match(initial, /^[a-f0-9]{64}$/);

  const coherentBound = structuredClone(call);
  coherentBound.reservationBound.requestBytes += 1;
  coherentBound.reservationBound.inputTokenUpperBound += 1;
  coherentBound.reservationBound.upperBoundUSD = reservationUpperBoundMicroUSD(coherentBound.reservationBound) / 1e6;
  assert.notEqual(reservationProjectionSha256(sourceFiles,
    [{ call: coherentBound, bound: coherentBound.reservationBound }]), initial);

  const changedIdentity = structuredClone(call);
  changedIdentity.runId = 'other-run';
  assert.notEqual(reservationProjectionSha256(sourceFiles,
    [{ call: changedIdentity, bound: changedIdentity.reservationBound }]), initial);
});

test('lock is exclusive and only its owner releases it', async t => {
  const directory = await tempDir(t);
  const lockPath = path.join(directory, 'sweep.lock');
  const release = await acquireSweepLock(lockPath, { runId: 'run-1' });
  await assert.rejects(acquireSweepLock(lockPath, { runId: 'run-2' }), /existing lock requires manual review/);
  await release();
  const releaseAgain = await acquireSweepLock(lockPath, { runId: 'run-3' });
  await releaseAgain();
});

function makeQueueFixture() {
  const cases = Array.from({ length: 141 }, (_, index) => {
    const caseId = `case-${String(index).padStart(3, '0')}`;
    return { caseId, coverage: `E-N${String((index % 9) + 1).padStart(2, '0')}`, stage: ['小学', '初中', '高中', '基础微积分'][index % 4],
      variant: 'basic', problem: `question ${index}`, reference_answer: `answer ${index}`,
      reference_status: 'authored_unreviewed', checks: ['result', 'reason', 'error'] };
  });
  const queue = { status: 'prepared_not_run', cases };
  const queueRaw = `${JSON.stringify(queue, null, 2)}\n`;
  const authorization = makeAuth(cases.map(item => item.caseId));
  authorization.queueSha256 = createHash('sha256').update(queueRaw).digest('hex');
  const sourceCases = cases.map(item => ({ id: item.caseId, split: 'development', coverage: item.coverage,
    stage: item.stage, variant: item.variant, problem: item.problem, reference_answer: item.reference_answer,
    reference_status: item.reference_status, checks: item.checks, expected_behavior: 'interactive' }));
  const validated = validateSweepData({ authorization, queue, queueRaw, sourceCases });
  return { authorization, queue, queueRaw, sourceCases, queueCases: validated, ledger: makeLedger(authorization) };
}

test('validates queue sources and deterministically skips already started or failed cases', () => {
  const fixture = makeQueueFixture();
  fixture.ledger.runs = [
    { runId: 'run-a', caseId: 'case-000', status: 'completed', startedAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:01Z' },
    { runId: 'run-b', caseId: 'case-001', status: 'failed', startedAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:01Z' },
    { runId: 'run-c', caseId: 'case-002', status: 'cancelled', startedAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:01Z' },
  ];
  const first = selectPendingCases(fixture.queueCases, fixture.ledger, 4);
  const second = selectPendingCases(fixture.queueCases, fixture.ledger, 4);
  assert.deepEqual(first.selected.map(item => item.caseId), ['case-003', 'case-004', 'case-005', 'case-006']);
  assert.deepEqual(second.selected.map(item => item.caseId), first.selected.map(item => item.caseId));

  const holdout = structuredClone(fixture.sourceCases);
  holdout[0].split = 'holdout';
  assert.throws(() => validateSweepData({ authorization: fixture.authorization, queue: fixture.queue,
    queueRaw: fixture.queueRaw, sourceCases: holdout }), /no longer matches/);
  const changedReference = structuredClone(fixture.sourceCases);
  changedReference[0].reference_answer = 'different';
  assert.throws(() => validateSweepData({ authorization: fixture.authorization, queue: fixture.queue,
    queueRaw: fixture.queueRaw, sourceCases: changedReference }), /no longer matches/);
});

test('dry run only reports queue and budget state without ledger writes, lock, model, or fetch', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  const ledgerPath = path.join(directory, '.work/curriculum-live-budget.json');
  const lockPath = path.join(directory, '.work/curriculum-live-budget.lock');
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const originalText = `${JSON.stringify(fixture.ledger, null, 2)}\n`;
  await writeFile(ledgerPath, originalText);
  const readBundle = async () => ({ ...fixture, ledgerPath });
  let modelCalls = 0;
  const result = await runSweep({ rootDir: directory, limit: 4, readBundle,
    runEvaluationFn: async () => { modelCalls += 1; throw new Error('dry run called model'); },
    fetchImpl: async () => { modelCalls += 1; throw new Error('dry run fetched'); } });
  assert.equal(result.kind, 'dry_run');
  assert.equal(result.pendingCount, 141);
  assert.deepEqual(result.selected.map(item => item.id), ['case-000', 'case-001', 'case-002', 'case-003']);
  assert.equal(result.budget.providerCalls, 0);
  assert.equal(result.budget.remainingUSD, 20);
  assert.equal(modelCalls, 0);
  assert.equal(await readFile(ledgerPath, 'utf8'), originalText);
  await assert.rejects(readFile(lockPath));
});

function makeLiveBundle(directory, fixture) {
  const ledgerPath = path.join(directory, '.work/curriculum-live-budget.json');
  return { ...fixture, ledgerPath, sourceDataset: { cases: fixture.sourceCases } };
}

const testModelConfig = { provider: 'openrouter', apiKey: 'test-key',
  model: 'anthropic/claude-sonnet-5.5', baseUrl: 'https://openrouter.ai/api/v1' };

test('live batch reports capacity stop before admitting a case without a full reserve', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  for (let index = 0; index < 28; index += 1) {
    fixture.ledger.calls.push({ callId: `prior-${index}`, caseId: `prior-case-${index}`, runId: `prior-run-${index}`,
      requestName: 'play_plan', status: 'unknown', reservedCostUSD: 0.65, actualCostUSD: null,
      startedAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:01Z' });
  }
  const bundle = makeLiveBundle(directory, fixture);
  let modelInvocations = 0;
  let networkCalls = 0;
  const result = await runSweep({ rootDir: directory, live: true, limit: 1, config: testModelConfig,
    readBundle: async () => bundle, runEvaluationFn: async () => { modelInvocations += 1; },
    fetchImpl: async () => { networkCalls += 1; throw new Error('must not fetch'); }, onProgress: () => {} });
  assert.equal(result.status, 'capacity_stopped');
  assert.equal(result.stopReason, 'budget_capacity');
  assert.equal(result.selectedCount, 0);
  assert.ok(Math.abs(result.summary.budget.remainingUSD - 1.8) < 1e-9);
  assert.equal(modelInvocations, 0);
  assert.equal(networkCalls, 0);
  assert.equal(fixture.ledger.activeRun, null);
});

test('live batch stops on SIGINT between cases and reports both call counters', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  const bundle = makeLiveBundle(directory, fixture);
  const controller = new AbortController();
  let evaluated = 0;
  const runEvaluationFn = async options => {
    evaluated += 1;
    const runId = options.idFactory();
    const runDir = path.join(directory, 'evaluation', 'runs', runId);
    await mkdir(path.join(runDir, 'cases'), { recursive: true });
    await writeFile(path.join(runDir, 'cases', `${options.caseId}.json`), JSON.stringify({ status: 'completed_generation' }));
    controller.abort(new DOMException('interrupted', 'AbortError'));
    return { kind: 'run', runDir, manifest: { status: 'completed', providerCalls: 2 } };
  };
  const result = await runSweep({ rootDir: directory, live: true, limit: 2, config: testModelConfig,
    readBundle: async () => bundle, runEvaluationFn, signal: controller.signal, onProgress: () => {} });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopReason, 'sigint');
  assert.equal(evaluated, 1);
  assert.deepEqual(result.summary.providerCalls, { outgoingRequests: 0, runEvaluationModelInvocations: 2 });
  assert.equal(result.summary.cases.completed, 1);
  assert.equal(fixture.ledger.activeRun, null);
  await assert.rejects(readFile(path.join(directory, '.work/curriculum-live-budget.lock')));
});

test('live batch reports and stops after provider cost overrun despite model-client error wrapping', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  const bundle = makeLiveBundle(directory, fixture);
  const runEvaluationFn = async options => {
    let failed = false;
    try {
      await options.model.complete({ instructions: 'Plan the task.', input: { originalProblem: '2+2' },
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, name: 'play_plan' });
    } catch { failed = true; }
    assert.equal(failed, true);
    const runId = options.idFactory();
    const runDir = path.join(directory, 'evaluation', 'runs', runId);
    await mkdir(path.join(runDir, 'cases'), { recursive: true });
    await writeFile(path.join(runDir, 'cases', `${options.caseId}.json`), JSON.stringify({ status: 'failed' }));
    return { kind: 'run', runDir, manifest: { status: 'completed', providerCalls: 1 } };
  };
  const result = await runSweep({ rootDir: directory, live: true, limit: 2, config: testModelConfig,
    readBundle: async () => bundle, runEvaluationFn,
    fetchImpl: async () => new Response(JSON.stringify({ usage: { cost: 0.66 } })), onProgress: () => {} });
  assert.equal(result.status, 'budget_halted');
  assert.equal(result.stopReason, 'budget_halt');
  assert.equal(result.selectedCount, 1);
  assert.equal(result.summary.providerCalls.outgoingRequests, 1);
  assert.equal(result.summary.providerCalls.runEvaluationModelInvocations, 1);
  assert.equal(fixture.ledger.budgetHalt.actualCostUSD, 0.66);
  assert.equal(result.summary.nextPending.length, 140);
});

async function saveMockCaseArtifact(directory, caseId, runId, record) {
  const runDir = path.join(directory, 'evaluation', 'runs', runId);
  await mkdir(path.join(runDir, 'cases'), { recursive: true });
  await writeFile(path.join(runDir, 'cases', `${caseId}.json`), JSON.stringify(record));
  return { kind: 'run', runDir, manifest: { status: 'completed', providerCalls: record.providerCalls ?? 0 } };
}

test('provider HTTP failures stop before a second case and preserve only sanitized diagnostics', async t => {
  for (const status of [402, 503]) await t.test(`HTTP ${status}`, async t2 => {
    const directory = await tempDir(t2);
    const fixture = makeQueueFixture();
    const bundle = makeLiveBundle(directory, fixture);
    let evaluated = 0;
    let fetched = 0;
    const result = await runSweep({ rootDir: directory, live: true, limit: 2, config: testModelConfig,
      readBundle: async () => bundle, onProgress: () => {},
      fetchImpl: async () => {
        fetched += 1;
        return new Response(JSON.stringify({ error: { message: 'private provider text', account_id: 'secret-123',
          limit_source: 'provider', reason: 'insufficient_credits' }, usage: { cost: 0.42 } }),
        { status, headers: { 'retry-after': '30', 'x-request-id': 'request-123' } });
      },
      runEvaluationFn: async options => {
        evaluated += 1;
        let failure;
        try {
          await options.model.complete({ name: 'play_plan', instructions: 'Make a plan.',
            input: { originalProblem: 'Solve 2+2.' },
            schema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
        } catch (error) { failure = error; }
        assert.equal(failure?.code, 'MODEL_REQUEST_FAILED');
        return saveMockCaseArtifact(directory, options.caseId, options.idFactory(),
          { status: 'failed', failure: { code: failure.code }, providerCalls: 1 });
      } });
    assert.equal(result.status, 'stopped_after_provider_failure');
    assert.equal(result.stopReason, 'provider_failure');
    assert.equal(result.selectedCount, 1);
    assert.equal(result.summary.cases.failed, 1);
    assert.deepEqual(result.summary.providerCalls,
      { outgoingRequests: 1, runEvaluationModelInvocations: 1 });
    assert.equal(result.summary.nextPending.length, 140);
    assert.equal(evaluated, 1);
    assert.equal(fetched, 1);
    assert.equal(fixture.ledger.runs.length, 1);
    assert.equal(fixture.ledger.runs[0].status, 'failed');
    assert.equal(fixture.ledger.runs[0].safeFailure, 'MODEL_REQUEST_FAILED');
    assert.equal(fixture.ledger.activeRun, null);
    const call = fixture.ledger.calls[0];
    assert.equal(call.status, 'unknown');
    assert.equal(call.reservedCostUSD, 0.65);
    assert.equal(call.actualCostUSD, null);
    assert.equal(call.httpStatus, status);
    assert.equal(call.retryAfterSeconds, 30);
    assert.equal(call.requestId, 'request-123');
    assert.equal(call.limit_source, 'provider');
    assert.equal(call.reason, 'insufficient_credits');
    const savedCall = JSON.stringify(call);
    assert.equal(savedCall.includes('private provider text'), false);
    assert.equal(savedCall.includes('secret-123'), false);
  });
});

test('fetch exceptions stop the batch, retain unknown cost, and are not retried', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  const bundle = makeLiveBundle(directory, fixture);
  let evaluated = 0;
  let fetched = 0;
  const result = await runSweep({ rootDir: directory, live: true, limit: 2, config: testModelConfig,
    readBundle: async () => bundle, onProgress: () => {},
    fetchImpl: async () => { fetched += 1; throw new Error('private network diagnostic'); },
    runEvaluationFn: async options => {
      evaluated += 1;
      let failure;
      try {
        await options.model.complete({ name: 'play_plan', instructions: 'Make a plan.',
          input: { originalProblem: 'Solve 2+2.' },
          schema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
      } catch (error) { failure = error; }
      assert.equal(failure?.code, 'MODEL_UNAVAILABLE');
      return saveMockCaseArtifact(directory, options.caseId, options.idFactory(),
        { status: 'failed', failure: { code: failure.code }, providerCalls: 1 });
    } });
  assert.equal(result.status, 'stopped_after_provider_failure');
  assert.equal(result.stopReason, 'provider_failure');
  assert.equal(result.selectedCount, 1);
  assert.equal(result.summary.providerCalls.outgoingRequests, 1);
  assert.equal(evaluated, 1);
  assert.equal(fetched, 1);
  assert.equal(fixture.ledger.calls[0].status, 'unknown');
  assert.equal(fixture.ledger.calls[0].failureKind, 'fetch_error');
  assert.equal(fixture.ledger.calls[0].reservedCostUSD, 0.65);
  assert.equal(JSON.stringify(fixture.ledger.calls[0]).includes('private network diagnostic'), false);
  assert.equal(fixture.ledger.activeRun, null);
});

test('ordinary generation failures continue to the next selected case', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  const bundle = makeLiveBundle(directory, fixture);
  let evaluated = 0;
  const runEvaluationFn = async options => {
    evaluated += 1;
    const record = options.caseId === 'case-000'
      ? { status: 'failed', failure: { code: 'PLAN_CONFLICT' } }
      : { status: 'completed_generation' };
    return saveMockCaseArtifact(directory, options.caseId, options.idFactory(), record);
  };
  const result = await runSweep({ rootDir: directory, live: true, limit: 2, config: testModelConfig,
    readBundle: async () => bundle, runEvaluationFn, onProgress: () => {} });
  assert.equal(result.stopReason, 'batch_limit_reached');
  assert.equal(result.selectedCount, 2);
  assert.equal(result.summary.cases.failed, 1);
  assert.equal(result.summary.cases.completed, 1);
  assert.equal(evaluated, 2);
  assert.deepEqual(fixture.ledger.runs.map(run => run.caseId), ['case-000', 'case-001']);
  assert.equal(fixture.ledger.activeRun, null);
});

test('artifact persistence failures stop the batch and retain exact attempt accounting', async t => {
  const directory = await tempDir(t);
  const fixture = makeQueueFixture();
  const bundle = makeLiveBundle(directory, fixture);
  let evaluated = 0;
  const result = await runSweep({ rootDir: directory, live: true, limit: 2, config: testModelConfig,
    readBundle: async () => bundle, onProgress: () => {},
    runEvaluationFn: async () => { evaluated += 1; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  assert.equal(result.status, 'stopped_after_runner_error');
  assert.equal(result.stopReason, 'runner_error');
  assert.equal(result.selectedCount, 1);
  assert.equal(result.summary.providerCalls.outgoingRequests, 0);
  assert.equal(evaluated, 1);
  assert.equal(fixture.ledger.runs.length, 1);
  assert.equal(fixture.ledger.runs[0].status, 'failed');
  assert.equal(fixture.ledger.runs[0].safeFailure, 'RUNNER_ERROR');
  assert.equal(fixture.ledger.activeRun, null);
});
