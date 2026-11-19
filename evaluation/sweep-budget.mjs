import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateAssessment, validatePlaytest } from '../server/contracts.mjs';

export const SWEEP_QUEUE_PATH = '.work/curriculum-first-sweep.json';
export const SWEEP_LEDGER_PATH = '.work/curriculum-live-budget.json';
export const SWEEP_LOCK_PATH = '.work/curriculum-live-budget.lock';
export const OPENROUTER_RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';
export const ALLOWED_CASE_COUNT = 141;
export const CALLS_PER_CASE = 3;
export const RESERVATION_EVIDENCE_PATH = '.work/unknown-request-bound-evidence.json';
export const APPROVED_RESERVATION_EVIDENCE_SHA256 = '44a112bb71fb35ed3c21cf5c079ffbde36b40bb8b1d2cb5c8870340563faf174';
export const APPROVED_RESERVATION_PROJECTION_SHA256 = '2f7066d478309bf66d3a567e9110fbef7e939be19b5446518f1532481b3d91c8';
export const RESERVATION_BOUND_ROW_COUNT = 18;

const requestNames = new Set(['play_plan', 'playable_exercise', 'repaired_exercise']);
const requestFields = new Set(['model', 'instructions', 'input', 'store', 'max_output_tokens', 'text',
  'stream', 'provider', 'reasoning']);
const reservationSourcePaths = ['server/contracts.mjs', 'server/generate.mjs', 'server/model.mjs', 'server/prompts.mjs'];
const reservationBoundKeys = ['schemaVersion', 'evidenceFileSha256', 'sourceCaseSha256', 'requestSha256',
  'requestBytes', 'inputTokenUpperBound', 'maxOutputTokens', 'maximumInputUSDPerMillion',
  'maximumOutputUSDPerMillion', 'cushionUSD', 'originalReserveUSD', 'upperBoundUSD'];
const reservationReconciliationKeys = ['schemaVersion', 'evidencePath', 'evidenceFileSha256', 'evidenceCreatedAt',
  'appliedAt', 'rowCount', 'totalOriginalReservedUSD', 'totalBoundUSD', 'projectionSha256', 'sourceFiles', 'callIds'];
const safeLimitSources = new Set(['account', 'api_key', 'organization', 'provider', 'model',
  'credits', 'rate_limit', 'request_limit', 'token_limit', 'openrouter_in_flight_budget',
  'openrouter_credits', 'openrouter_key_limit']);
const safeProviderReasons = new Set(['rate_limit', 'rate_limit_exceeded', 'insufficient_credits',
  'quota_exceeded', 'context_length_exceeded', 'request_rejected', 'provider_error', 'provider_unavailable',
  'in_flight_budget_exhausted', 'weight_exceeds_budget']);

function refuse(message, code = 'SWEEP_REFUSED') {
  return Object.assign(new Error(message), { code });
}

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function finiteNonnegative(value) { return Number.isFinite(value) && value >= 0; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sameSet(left, right) { return left.size === right.size && [...left].every(value => right.has(value)); }
function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function microUSD(value) { return Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) : null; }

export function reservationUpperBoundMicroUSD(bound) {
  if (!Number.isSafeInteger(bound?.inputTokenUpperBound) || bound.inputTokenUpperBound < 1 ||
      !Number.isSafeInteger(bound?.maxOutputTokens) || bound.maxOutputTokens < 1 ||
      bound.maximumInputUSDPerMillion !== 4.4 || bound.maximumOutputUSDPerMillion !== 11 ||
      bound.cushionUSD !== 0.05) {
    throw refuse('Reservation bound refused: formula inputs are outside the approved limits.');
  }
  const inputMicroUSD = Math.floor((bound.inputTokenUpperBound * 22 + 4) / 5);
  return inputMicroUSD + bound.maxOutputTokens * 11 + 50000;
}

export function reservationProjectionSha256(sourceFiles, entries) {
  const sources = Object.fromEntries(reservationSourcePaths.map(relative => [relative,
    { sha256: sourceFiles[relative]?.sha256, mtime: sourceFiles[relative]?.mtime }]));
  const rows = entries.map(({ call, bound }) => ({ callId: call.callId, caseId: call.caseId,
    runId: call.runId, requestName: call.requestName, startedAt: call.startedAt,
    sourceCaseSha256: bound.sourceCaseSha256, requestSha256: bound.requestSha256,
    requestBytes: bound.requestBytes, inputTokenUpperBound: bound.inputTokenUpperBound,
    maxOutputTokens: bound.maxOutputTokens, maximumInputUSDPerMillion: bound.maximumInputUSDPerMillion,
    maximumOutputUSDPerMillion: bound.maximumOutputUSDPerMillion, cushionUSD: bound.cushionUSD,
    originalReserveUSD: bound.originalReserveUSD, upperBoundUSD: bound.upperBoundUSD }))
    .sort((left, right) => left.callId.localeCompare(right.callId));
  return sha256(JSON.stringify({ sourceFiles: sources, rows }));
}

export function validateReservationBound(call, authorization) {
  const bound = call.reservationBound;
  const expectedOutputTokens = call.requestName === 'play_plan' ? 6000 :
    call.requestName === 'playable_exercise' ? 16000 : null;
  if (!exactKeys(bound, reservationBoundKeys) || bound.schemaVersion !== 1 ||
      bound.evidenceFileSha256 !== APPROVED_RESERVATION_EVIDENCE_SHA256 ||
      !isSha256(bound.sourceCaseSha256) || !isSha256(bound.requestSha256) ||
      !Number.isSafeInteger(bound.requestBytes) || bound.requestBytes < 8192 ||
      bound.requestBytes > authorization.maxRequestBytes ||
      !Number.isSafeInteger(bound.inputTokenUpperBound) || bound.inputTokenUpperBound !== bound.requestBytes + 8192 ||
      bound.maxOutputTokens !== expectedOutputTokens || bound.maxOutputTokens > authorization.maxOutputTokens ||
      bound.maximumInputUSDPerMillion !== 4.4 || bound.maximumOutputUSDPerMillion !== 11 ||
      bound.cushionUSD !== 0.05 || bound.originalReserveUSD !== authorization.reserveUSDPerCall ||
      call.status !== 'unknown' || call.actualCostUSD !== null) {
    throw refuse('Sweep refused: reconciled reservation metadata is malformed or no longer eligible.');
  }
  const expectedUpperBoundUSD = reservationUpperBoundMicroUSD(bound) / 1e6;
  if (bound.upperBoundUSD !== expectedUpperBoundUSD || bound.upperBoundUSD > call.reservedCostUSD) {
    throw refuse('Sweep refused: reconciled reservation does not match its conservative formula.');
  }
  return bound;
}

function validateReservationReconciliation(ledger) {
  const provenance = ledger.reservationReconciliation;
  const boundCalls = ledger.calls.filter(call => call.reservationBound !== undefined);
  if (provenance === undefined) {
    if (boundCalls.length) throw refuse('Sweep refused: reservation bounds lack reconciliation provenance.');
    return;
  }
  if (!exactKeys(provenance, reservationReconciliationKeys) || provenance.schemaVersion !== 1 ||
      provenance.evidencePath !== RESERVATION_EVIDENCE_PATH ||
      provenance.evidenceFileSha256 !== APPROVED_RESERVATION_EVIDENCE_SHA256 ||
      typeof provenance.evidenceCreatedAt !== 'string' || !Number.isFinite(Date.parse(provenance.evidenceCreatedAt)) ||
      typeof provenance.appliedAt !== 'string' || !Number.isFinite(Date.parse(provenance.appliedAt)) ||
      Date.parse(provenance.appliedAt) < Date.parse(provenance.evidenceCreatedAt) ||
      provenance.rowCount !== RESERVATION_BOUND_ROW_COUNT || boundCalls.length !== RESERVATION_BOUND_ROW_COUNT ||
      !Array.isArray(provenance.callIds) || provenance.callIds.length !== RESERVATION_BOUND_ROW_COUNT ||
      new Set(provenance.callIds).size !== RESERVATION_BOUND_ROW_COUNT ||
      !exactKeys(provenance.sourceFiles, reservationSourcePaths)) {
    throw refuse('Sweep refused: reservation reconciliation provenance is malformed.');
  }
  for (const relative of reservationSourcePaths) {
    const source = provenance.sourceFiles[relative];
    if (!exactKeys(source, ['sha256', 'mtime']) || !isSha256(source.sha256) ||
        typeof source.mtime !== 'string' || !Number.isFinite(Date.parse(source.mtime)) ||
        Date.parse(source.mtime) >= Date.parse(provenance.evidenceCreatedAt)) {
      throw refuse('Sweep refused: saved reservation source evidence is malformed.');
    }
  }
  const expectedCallIds = boundCalls.map(call => call.callId).sort();
  if (provenance.callIds.slice().sort().join(',') !== expectedCallIds.join(',')) {
    throw refuse('Sweep refused: reconciled call IDs do not match the saved ledger rows.');
  }
  let totalBoundMicroUSD = 0;
  let totalOriginalMicroUSD = 0;
  const startedAt = [];
  const projectionEntries = [];
  for (const call of boundCalls) {
    const bound = validateReservationBound(call, ledger.authorization);
    totalBoundMicroUSD += reservationUpperBoundMicroUSD(bound);
    totalOriginalMicroUSD += microUSD(call.reservedCostUSD);
    startedAt.push(Date.parse(call.startedAt));
    projectionEntries.push({ call, bound });
  }
  const projectionSha256 = reservationProjectionSha256(provenance.sourceFiles, projectionEntries);
  const earliestCallAt = Math.min(...startedAt);
  if (startedAt.some(value => value > Date.parse(provenance.evidenceCreatedAt)) ||
      reservationSourcePaths.some(relative => Date.parse(provenance.sourceFiles[relative].mtime) >= earliestCallAt) ||
      microUSD(provenance.totalBoundUSD) !== totalBoundMicroUSD ||
      microUSD(provenance.totalOriginalReservedUSD) !== totalOriginalMicroUSD ||
      totalOriginalMicroUSD !== RESERVATION_BOUND_ROW_COUNT * microUSD(ledger.authorization.reserveUSDPerCall)) {
    throw refuse('Sweep refused: reconciled reservation totals or timestamps are inconsistent.');
  }
  if (provenance.projectionSha256 !== APPROVED_RESERVATION_PROJECTION_SHA256 ||
      projectionSha256 !== APPROVED_RESERVATION_PROJECTION_SHA256) {
    throw refuse('Sweep refused: saved reservation bounds do not match the approved projection digest.');
  }
}

function safeHeaderId(value, kind) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return undefined;
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
  const prefix = kind === 'request' ? /^(?:req(?:uest)?|trace)[_:-]/i : /^(?:gen(?:eration)?)[_:-]/i;
  return uuid || prefix.test(value) ? value : undefined;
}

function responseDiagnostics(call, response, parsed) {
  if (Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599) {
    call.httpStatus = response.status;
  }
  const retryAfter = response.headers?.get?.('retry-after');
  if (typeof retryAfter === 'string' && /^\d{1,4}(?:\.\d{1,3})?$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds <= 3600) call.retryAfterSeconds = seconds;
  }
  const requestId = safeHeaderId(response.headers?.get?.('x-request-id'), 'request');
  const generationId = safeHeaderId(response.headers?.get?.('x-openrouter-generation-id') ??
    response.headers?.get?.('x-generation-id'), 'generation');
  if (requestId) call.requestId = requestId;
  if (generationId) call.generationId = generationId;

  const error = parsed?.error;
  const candidates = [error, error?.metadata, parsed?.metadata, parsed];
  const safeValue = (key, allowed) => {
    for (const item of candidates) {
      const value = item?.[key];
      if (typeof value === 'string' && allowed.has(value.toLowerCase())) return value.toLowerCase();
    }
    return undefined;
  };
  const limitSource = safeValue('limit_source', safeLimitSources);
  const reason = safeValue('reason', safeProviderReasons);
  if (limitSource) call.limit_source = limitSource;
  if (reason) call.reason = reason;
}

export function validateLiveAuthorization(authorization) {
  if (!isObject(authorization) || authorization.userApproved !== true ||
      authorization.provider !== 'openrouter' || authorization.model !== 'anthropic/claude-sonnet-5.5' ||
      authorization.maxProviderCalls !== 423 || authorization.maxCostUSD !== 20 ||
      authorization.reserveUSDPerCall !== 0.65 || authorization.maxRequestBytes !== 90000 ||
      authorization.maxOutputTokens !== 16000 ||
      authorization.providerMaxPricePerMillion?.prompt !== 2.2 ||
      authorization.providerMaxPricePerMillion?.completion !== 11) {
    throw refuse('Live sweep refused: saved authorization does not match the approved provider and budget.');
  }
  if (!Array.isArray(authorization.allowedCaseIds) || authorization.allowedCaseIds.length !== ALLOWED_CASE_COUNT ||
      new Set(authorization.allowedCaseIds).size !== ALLOWED_CASE_COUNT ||
      authorization.allowedCaseIds.some(id => typeof id !== 'string')) {
    throw refuse('Live sweep refused: authorization must contain 141 unique allowed case IDs.');
  }
}

export function validateSweepData({ authorization, queue, queueRaw, sourceCases }) {
  validateLiveAuthorization(authorization);
  if (sha256(queueRaw) !== authorization.queueSha256) {
    throw refuse('Sweep refused: saved queue bytes do not match the approved queue digest.');
  }
  if (!isObject(queue) || !Array.isArray(queue.cases) || queue.cases.length !== ALLOWED_CASE_COUNT ||
      queue.status !== 'prepared_not_run') {
    throw refuse('Sweep refused: queue must contain the prepared 141-case breadth pass.');
  }
  const queueIds = new Set(queue.cases.map(item => item?.caseId));
  const allowedIds = new Set(authorization.allowedCaseIds);
  if (queueIds.size !== ALLOWED_CASE_COUNT || !sameSet(queueIds, allowedIds)) {
    throw refuse('Sweep refused: queue IDs do not exactly match the approved case set.');
  }

  const sourceById = new Map(sourceCases.map(item => [item?.id, item]));
  for (const queued of queue.cases) {
    const source = sourceById.get(queued.caseId);
    if (!source || source.split !== 'development' || typeof source.coverage !== 'string' ||
        source.coverage.startsWith('stress-') ||
        source.kind !== undefined || !['interactive', 'interactive_reasoning'].includes(source.expected_behavior) ||
        source.reference_status !== 'authored_unreviewed' ||
        source.problem !== queued.problem || source.reference_answer !== queued.reference_answer ||
        source.coverage !== queued.coverage || source.stage !== queued.stage || source.variant !== queued.variant ||
        source.reference_status !== queued.reference_status ||
        JSON.stringify(source.checks) !== JSON.stringify(queued.checks)) {
      throw refuse(`Sweep refused: queued case ${queued.caseId} no longer matches its development source.`);
    }
  }
  return queue.cases.map(item => ({ ...item, source: sourceById.get(item.caseId) }));
}

export function validateLedger(ledger) {
  if (!isObject(ledger) || ledger.schemaVersion !== 1 || !isObject(ledger.authorization) ||
      !Array.isArray(ledger.calls) || !Array.isArray(ledger.runs) ||
      !(ledger.activeRun === null || isObject(ledger.activeRun)) ||
      !(ledger.budgetHalt === undefined || ledger.budgetHalt === null || isObject(ledger.budgetHalt))) {
    throw refuse('Sweep refused: budget ledger structure is malformed.');
  }
  if (!finiteNonnegative(ledger.authorization.reserveUSDPerCall)) {
    throw refuse('Sweep refused: authorization has an invalid per-call reserve.');
  }
  const callIds = new Set();
  for (const call of ledger.calls) {
    if (!isObject(call) || typeof call.callId !== 'string' || !call.callId || callIds.has(call.callId) ||
        typeof call.caseId !== 'string' || typeof call.runId !== 'string' ||
        !requestNames.has(call.requestName) || !['pending', 'settled', 'unknown'].includes(call.status) ||
        !finiteNonnegative(call.reservedCostUSD) ||
        call.reservedCostUSD !== ledger.authorization.reserveUSDPerCall || typeof call.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(call.startedAt)) ||
        (call.status === 'pending' && call.finishedAt !== null) ||
        (call.status !== 'pending' && (typeof call.finishedAt !== 'string' || !Number.isFinite(Date.parse(call.finishedAt))))) {
      throw refuse('Sweep refused: budget ledger contains malformed call accounting.');
    }
    callIds.add(call.callId);
    if (call.status === 'settled' && !finiteNonnegative(call.actualCostUSD)) {
      throw refuse('Sweep refused: settled call is missing a valid actual cost.');
    }
    if (call.status !== 'settled' && call.actualCostUSD !== undefined && call.actualCostUSD !== null) {
      throw refuse('Sweep refused: unsettled call has an invalid actual cost.');
    }
  }
  const runIds = new Set();
  const runCaseIds = new Set();
  for (const run of ledger.runs) {
    if (!isObject(run) || typeof run.runId !== 'string' || !run.runId || runIds.has(run.runId) ||
        typeof run.caseId !== 'string' || !['started', 'completed', 'failed', 'cancelled'].includes(run.status) ||
        runCaseIds.has(run.caseId) || typeof run.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(run.startedAt)) ||
        (run.status === 'started' && run.finishedAt !== undefined) ||
        (run.status !== 'started' && (typeof run.finishedAt !== 'string' || !Number.isFinite(Date.parse(run.finishedAt)))) ||
        (run.runEvaluationModelInvocations !== undefined &&
          (!Number.isSafeInteger(run.runEvaluationModelInvocations) || run.runEvaluationModelInvocations < 0)) ||
        (run.outgoingProviderRequests !== undefined &&
          (!Number.isSafeInteger(run.outgoingProviderRequests) || run.outgoingProviderRequests < 0))) {
      throw refuse('Sweep refused: budget ledger contains malformed run accounting.');
    }
    runIds.add(run.runId);
    runCaseIds.add(run.caseId);
  }
  if (ledger.activeRun !== null && (typeof ledger.activeRun.runId !== 'string' ||
      typeof ledger.activeRun.startedAt !== 'string')) {
    throw refuse('Sweep refused: budget ledger has an incomplete active run.');
  }
  if (ledger.budgetHalt !== undefined && ledger.budgetHalt !== null &&
      (ledger.budgetHalt.reason !== 'cost_exceeded_reservation' ||
       typeof ledger.budgetHalt.callId !== 'string' ||
       !finiteNonnegative(ledger.budgetHalt.actualCostUSD) ||
       !finiteNonnegative(ledger.budgetHalt.reservedCostUSD) ||
       ledger.budgetHalt.actualCostUSD <= ledger.budgetHalt.reservedCostUSD ||
       typeof ledger.budgetHalt.createdAt !== 'string' || !Number.isFinite(Date.parse(ledger.budgetHalt.createdAt)))) {
    throw refuse('Sweep refused: budget halt record is malformed.');
  }
  validateReservationReconciliation(ledger);
  return ledger;
}

export function sweepTotals(ledger, authorization = ledger.authorization) {
  validateLedger(ledger);
  const actualUSD = ledger.calls.reduce((sum, call) =>
    sum + (call.status === 'settled' ? call.actualCostUSD : 0), 0);
  const unknownTotals = ledger.calls.reduce((sum, call) => {
    if (call.status === 'settled') return sum;
    const originalMicroUSD = microUSD(call.reservedCostUSD);
    sum.unknownOriginalMicroUSD += originalMicroUSD;
    if (call.reservationBound) sum.unknownBoundedMicroUSD += reservationUpperBoundMicroUSD(call.reservationBound);
    else sum.unknownUnboundedMicroUSD += originalMicroUSD;
    return sum;
  }, { unknownOriginalMicroUSD: 0, unknownBoundedMicroUSD: 0, unknownUnboundedMicroUSD: 0 });
  const unknownOriginalReservedUSD = unknownTotals.unknownOriginalMicroUSD / 1e6;
  const unknownBoundedUSD = unknownTotals.unknownBoundedMicroUSD / 1e6;
  const unknownUnboundedReservedUSD = unknownTotals.unknownUnboundedMicroUSD / 1e6;
  const unknownReservedUSD = unknownBoundedUSD + unknownUnboundedReservedUSD;
  const committedUSD = actualUSD + unknownReservedUSD;
  return {
    providerCalls: ledger.calls.length,
    maxProviderCalls: authorization.maxProviderCalls,
    remainingProviderCalls: Math.max(0, authorization.maxProviderCalls - ledger.calls.length),
    actualUSD,
    unknownReservedUSD,
    unknownOriginalReservedUSD,
    unknownBoundedUSD,
    unknownUnboundedReservedUSD,
    unknownReserveSavingsUSD: (unknownTotals.unknownOriginalMicroUSD - unknownTotals.unknownBoundedMicroUSD -
      unknownTotals.unknownUnboundedMicroUSD) / 1e6,
    committedUSD,
    maxCostUSD: authorization.maxCostUSD,
    remainingUSD: Math.max(0, authorization.maxCostUSD - committedUSD),
  };
}

export function selectPendingCases(queueCases, ledger, limit = 4) {
  validateLedger(ledger);
  if (!Number.isSafeInteger(limit) || limit < 1) throw refuse('--limit must be a positive integer.');
  const started = new Set([
    ...ledger.runs.map(run => run.caseId),
    ...ledger.calls.map(call => call.caseId),
  ]);
  const pending = queueCases.filter(item => !started.has(item.caseId));
  return { pending, selected: pending.slice(0, limit) };
}

export function assertLedgerIdle(ledger) {
  validateLedger(ledger);
  if (ledger.budgetHalt) {
    throw refuse('Live sweep refused: a prior request exceeded its cost reservation and requires manual review.');
  }
  if (ledger.activeRun !== null || ledger.runs.some(run => run.status === 'started') ||
      ledger.calls.some(call => call.status === 'pending')) {
    throw refuse('Live sweep refused: the ledger records an incomplete run or call that requires manual review.');
  }
}

export async function saveLedgerAtomic(filePath, ledger) {
  validateLedger(ledger);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(tempPath, filePath); }
  catch (error) { await unlink(tempPath).catch(() => {}); throw error; }
}

export async function acquireSweepLock(lockPath, { runId = randomUUID(), now = () => new Date().toISOString() } = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw refuse('Live sweep refused: an existing lock requires manual review.');
    throw error;
  }
  try { await handle.writeFile(`${JSON.stringify({ runId, startedAt: now() })}\n`); }
  catch (error) { await handle.close(); await unlink(lockPath).catch(() => {}); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(lockPath);
  };
}

function hasForbiddenCapability(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenCapability);
  if (!isObject(value)) return false;
  const forbidden = new Set(['tools', 'tool_choice', 'plugins', 'images', 'image_url', 'web_search',
    'fallbacks', 'models', 'provider', 'temperature', 'top_p']);
  return Object.entries(value).some(([key, child]) => forbidden.has(key) || hasForbiddenCapability(child));
}

function validAssessmentRepairInput(input) {
  if (!isObject(input.plan) || !isDeepStrictEqual(input.assessment, input.plan.assessment)) return false;
  try { validateAssessment(input.assessment); validatePlaytest(input.playtest); return true; }
  catch { return false; }
}

function enforceRequest(url, init, authorization) {
  if (url !== OPENROUTER_RESPONSES_URL || init?.method !== 'POST') {
    throw refuse('Sweep request refused: only the approved OpenRouter responses POST is allowed.');
  }
  if (typeof init.body !== 'string') throw refuse('Sweep request refused: serialized JSON body is required.');
  let body;
  try { body = JSON.parse(init.body); }
  catch { throw refuse('Sweep request refused: serialized JSON body is invalid.'); }
  if (!isObject(body) || Object.keys(body).some(key => !requestFields.has(key)) ||
      body.model !== authorization.model || body.store !== false || body.stream !== false ||
      !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1 ||
      body.max_output_tokens > authorization.maxOutputTokens ||
      typeof body.instructions !== 'string' || !body.instructions.trim() || typeof body.input !== 'string' ||
      !isObject(body.text) || !isObject(body.text.format) || !isObject(body.text.format.schema)) {
    throw refuse('Sweep request refused: request model, output, or capability fields are outside authorization.');
  }
  let input;
  try { input = JSON.parse(body.input); }
  catch { throw refuse('Sweep request refused: model input is not valid JSON.'); }
  const name = body.text.format.name;
  const inputKeys = Object.keys(input ?? {}).sort().join(',');
  const legacyRepairInputKeys = ['html', 'originalProblem', 'plan', 'runtimeErrors'].join(',');
  const assessedRepairInputKeys = ['assessment', 'html', 'originalProblem', 'plan', 'playtest', 'runtimeErrors'].join(',');
  const legacyRepair = name === 'repaired_exercise' && inputKeys === legacyRepairInputKeys &&
    !Object.hasOwn(input?.plan ?? {}, 'assessment');
  const assessmentRepair = name === 'repaired_exercise' && inputKeys === assessedRepairInputKeys;
  const expectedInput = name === 'play_plan' ? ['originalProblem'] :
    name === 'playable_exercise' ? ['originalProblem', 'plan'] :
      name === 'repaired_exercise' ? (assessmentRepair
        ? ['assessment', 'html', 'originalProblem', 'plan', 'playtest', 'runtimeErrors']
        : ['html', 'originalProblem', 'plan', 'runtimeErrors']) : null;
  const providerKeys = Object.keys(body.provider ?? {}).sort();
  const textKeys = Object.keys(body.text).sort();
  const formatKeys = Object.keys(body.text.format).sort();
  if (!expectedInput || !requestNames.has(name) || !isObject(input) ||
      Object.keys(input).sort().join(',') !== expectedInput.join(',') || hasForbiddenCapability(input) ||
      typeof input.originalProblem !== 'string' || !input.originalProblem.trim() ||
      (name !== 'play_plan' && !isObject(input.plan)) ||
      (name === 'repaired_exercise' && (typeof input.html !== 'string' || !Array.isArray(input.runtimeErrors))) ||
      (name === 'repaired_exercise' && !legacyRepair && !assessmentRepair) ||
      (assessmentRepair && !validAssessmentRepairInput(input)) ||
      body.text.format.type !== 'json_schema' || body.text.format.strict !== true ||
      textKeys.join(',') !== 'format' || formatKeys.join(',') !== 'name,schema,strict,type' ||
      providerKeys.join(',') !== 'require_parameters' || body.provider.require_parameters !== true ||
      (body.reasoning !== undefined && JSON.stringify(body.reasoning) !== '{"effort":"medium"}')) {
    throw refuse('Sweep request refused: request schema or priced capabilities are outside authorization.');
  }
  body.provider = { require_parameters: true,
    max_price: { prompt: authorization.providerMaxPricePerMillion.prompt,
      completion: authorization.providerMaxPricePerMillion.completion } };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > authorization.maxRequestBytes) {
    throw refuse('Sweep request refused: serialized request exceeds the approved byte limit.');
  }
  return { serialized, name };
}

export function createBudgetedFetch({ ledger, ledgerPath, authorization = ledger.authorization,
  caseId, runId, fetchImpl = fetch, now = () => new Date().toISOString(), idFactory = randomUUID,
  maxProviderCalls = authorization.maxProviderCalls, maxCostUSD = authorization.maxCostUSD }) {
  validateLedger(ledger);
  if (!Number.isSafeInteger(maxProviderCalls) || maxProviderCalls < 1 ||
      maxProviderCalls > authorization.maxProviderCalls || !finiteNonnegative(maxCostUSD) ||
      maxCostUSD <= 0 || maxCostUSD > authorization.maxCostUSD) {
    throw refuse('Sweep budget refused: fixture caps may only lower the approved limits.');
  }
  return async (url, init = {}) => {
    if (ledger.budgetHalt) {
      throw refuse('Sweep halted: an earlier request exceeded its per-call cost reservation.');
    }
    const { serialized, name } = enforceRequest(url, init, authorization);
    const totals = sweepTotals(ledger, { ...authorization, maxProviderCalls, maxCostUSD });
    if (totals.providerCalls >= maxProviderCalls ||
        totals.committedUSD + authorization.reserveUSDPerCall > maxCostUSD) {
      throw refuse('Sweep budget refused this request before network access.', 'EVALUATION_CALL_CAP');
    }
    const call = { callId: idFactory(), caseId, runId, requestName: name, status: 'pending',
      reservedCostUSD: authorization.reserveUSDPerCall, actualCostUSD: null, startedAt: now(), finishedAt: null };
    ledger.calls.push(call);
    await saveLedgerAtomic(ledgerPath, ledger);

    let response;
    try { response = await fetchImpl(url, { ...init, body: serialized }); }
    catch (error) {
      call.status = 'unknown';
      call.failureKind = 'fetch_error';
      call.finishedAt = now();
      await saveLedgerAtomic(ledgerPath, ledger);
      throw error;
    }

    let cost;
    let parsed;
    try {
      parsed = await response.clone().json();
    } catch { /* Missing or unreadable usage keeps the reservation. */ }
    responseDiagnostics(call, response, parsed);
    if (response.ok && finiteNonnegative(parsed?.usage?.cost)) cost = parsed.usage.cost;
    call.finishedAt = now();
    if (cost === undefined) call.status = 'unknown';
    else {
      call.status = 'settled';
      call.actualCostUSD = cost;
    }
    if (cost !== undefined && cost > call.reservedCostUSD) {
      ledger.budgetHalt = { reason: 'cost_exceeded_reservation', callId: call.callId, caseId,
        runId, actualCostUSD: cost, reservedCostUSD: call.reservedCostUSD, createdAt: now() };
    }
    await saveLedgerAtomic(ledgerPath, ledger);
    if (cost !== undefined && cost > call.reservedCostUSD) {
      throw refuse('Sweep halted after provider cost exceeded its per-call reservation.');
    }
    return response;
  };
}
