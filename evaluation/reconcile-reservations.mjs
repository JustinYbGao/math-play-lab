import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APPROVED_RESERVATION_EVIDENCE_SHA256, RESERVATION_BOUND_ROW_COUNT,
  RESERVATION_EVIDENCE_PATH, SWEEP_LEDGER_PATH, SWEEP_LOCK_PATH, acquireSweepLock, assertLedgerIdle,
  reservationProjectionSha256, reservationUpperBoundMicroUSD, saveLedgerAtomic, sweepTotals,
  validateLedger, validateLiveAuthorization,
} from './sweep-budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = ['server/contracts.mjs', 'server/generate.mjs', 'server/model.mjs', 'server/prompts.mjs'];
const evidenceKeys = ['kind', 'network', 'createdAt', 'sourceFiles', 'rows', 'totalOriginalReservedUSD',
  'totalProposedUpperBoundUSD', 'method'];
const rowKeys = ['callId', 'caseId', 'runId', 'requestName', 'startedAt', 'casePath', 'caseSha256',
  'requestSha256', 'requestBytes', 'inputTokenUpperBound', 'outputTokenUpperBound',
  'maximumInputUSDPerMillion', 'maximumOutputUSDPerMillion', 'cushionUSD', 'upperBoundUSD', 'originalReserveUSD'];

function refuse(message) { throw new Error(`Reservation reconciliation refused: ${message}`); }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function microUSD(value) { return Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) : null; }
function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}

async function containedFile(root, relative) {
  if (!safeRelative(relative)) refuse('saved artifact path is unsafe.');
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, relative);
  if (!candidate.startsWith(`${rootReal}${path.sep}`)) refuse('saved artifact path escapes the project.');
  const fileReal = await realpath(candidate);
  if (!fileReal.startsWith(`${rootReal}${path.sep}`)) refuse('saved artifact path escapes the project.');
  return fileReal;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { refuse(`${label} is malformed JSON.`); }
}

async function readState(rootDir) {
  const ledgerPath = await containedFile(rootDir, SWEEP_LEDGER_PATH);
  const evidencePath = await containedFile(rootDir, RESERVATION_EVIDENCE_PATH);
  const [ledgerBytes, evidenceBytes] = await Promise.all([readFile(ledgerPath), readFile(evidencePath)]);
  const evidenceFileSha256 = sha256(evidenceBytes);
  if (evidenceFileSha256 !== APPROVED_RESERVATION_EVIDENCE_SHA256) {
    refuse('approved evidence file bytes have changed.');
  }
  const ledger = validateLedger(parseJson(ledgerBytes, 'budget ledger'));
  validateLiveAuthorization(ledger.authorization);
  return { ledgerPath, evidenceBytes, evidenceFileSha256, ledger };
}

function expectedOutputTokens(requestName) {
  return requestName === 'play_plan' ? 6000 : requestName === 'playable_exercise' ? 16000 : null;
}

function createCallBound(row, evidenceFileSha256) {
  return { schemaVersion: 1, evidenceFileSha256, sourceCaseSha256: row.caseSha256,
    requestSha256: row.requestSha256, requestBytes: row.requestBytes,
    inputTokenUpperBound: row.inputTokenUpperBound, maxOutputTokens: row.outputTokenUpperBound,
    maximumInputUSDPerMillion: row.maximumInputUSDPerMillion,
    maximumOutputUSDPerMillion: row.maximumOutputUSDPerMillion,
    cushionUSD: row.cushionUSD, originalReserveUSD: row.originalReserveUSD,
    upperBoundUSD: row.upperBoundUSD };
}

async function validateSourceSnapshot(rootDir, proof) {
  if (!exactKeys(proof.sourceFiles, sourcePaths)) refuse('source file evidence list is malformed.');
  const sourceFiles = {};
  const proofCreatedAt = Date.parse(proof.createdAt);
  for (const relative of sourcePaths) {
    const described = proof.sourceFiles[relative];
    if (!exactKeys(described, ['sha256', 'mtime']) || !isSha256(described.sha256) ||
        typeof described.mtime !== 'string' || !Number.isFinite(Date.parse(described.mtime))) {
      refuse('source file evidence entry is malformed.');
    }
    const filePath = await containedFile(rootDir, relative);
    const [bytes, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
    const actualMtime = fileStat.mtime.toISOString();
    if (sha256(bytes) !== described.sha256 || actualMtime !== described.mtime ||
        Date.parse(actualMtime) >= proofCreatedAt) {
      refuse(`audited source snapshot no longer matches ${relative}.`);
    }
    sourceFiles[relative] = { sha256: described.sha256, mtime: described.mtime };
  }
  return sourceFiles;
}

async function validateEvidenceRows(rootDir, ledger, evidenceBytes, evidenceFileSha256) {
  const proof = parseJson(evidenceBytes, 'reservation evidence');
  if (!exactKeys(proof, evidenceKeys) ||
      proof.kind !== 'Root audited local reconstruction of unknown-cost request size; not original HTTP captures or actual cost receipts' ||
      proof.network !== 'mock only; no real API key loaded' ||
      typeof proof.createdAt !== 'string' || !Number.isFinite(Date.parse(proof.createdAt)) ||
      !Array.isArray(proof.rows) || proof.rows.length !== RESERVATION_BOUND_ROW_COUNT ||
      typeof proof.method !== 'string' || !proof.method.includes('Conservative token bound')) {
    refuse('evidence file structure is not the reviewed request reconstruction.');
  }
  const sourceFiles = await validateSourceSnapshot(rootDir, proof);
  const callsById = new Map(ledger.calls.map(call => [call.callId, call]));
  const runsById = new Map(ledger.runs.map(run => [run.runId, run]));
  const callIds = new Set();
  const caseIds = new Set();
  const runIds = new Set();
  const rows = [];
  let originalMicroUSD = 0;
  let boundMicroUSD = 0;
  const callTime = Date.parse(proof.createdAt);

  for (const row of proof.rows) {
    if (!exactKeys(row, rowKeys) ||
        typeof row.callId !== 'string' || !row.callId || callIds.has(row.callId) ||
        typeof row.caseId !== 'string' || !row.caseId || caseIds.has(row.caseId) ||
        typeof row.runId !== 'string' || !row.runId || runIds.has(row.runId) ||
        !['play_plan', 'playable_exercise'].includes(row.requestName) ||
        typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt)) ||
        Date.parse(row.startedAt) > callTime || !isSha256(row.caseSha256) || !isSha256(row.requestSha256) ||
        !Number.isSafeInteger(row.requestBytes) || row.requestBytes < 8192 ||
        row.requestBytes > ledger.authorization.maxRequestBytes ||
        row.inputTokenUpperBound !== row.requestBytes + 8192 ||
        row.outputTokenUpperBound !== expectedOutputTokens(row.requestName) ||
        row.outputTokenUpperBound > ledger.authorization.maxOutputTokens ||
        row.maximumInputUSDPerMillion !== 4.4 || row.maximumOutputUSDPerMillion !== 11 ||
        row.cushionUSD !== 0.05 || row.originalReserveUSD !== ledger.authorization.reserveUSDPerCall ||
        !Number.isFinite(row.upperBoundUSD) || row.upperBoundUSD <= 0 || row.upperBoundUSD > row.originalReserveUSD) {
      refuse('an evidence row is malformed, duplicated, or outside the reviewed bounds.');
    }
    callIds.add(row.callId);
    caseIds.add(row.caseId);
    runIds.add(row.runId);

    const expectedCasePath = path.join('evaluation', 'runs', row.runId, 'cases', `${row.caseId}.json`);
    if (row.casePath !== expectedCasePath) refuse('evidence case path does not match its run and case IDs.');
    const call = callsById.get(row.callId);
    const run = runsById.get(row.runId);
    if (!call || call.caseId !== row.caseId || call.runId !== row.runId ||
        call.requestName !== row.requestName || call.startedAt !== row.startedAt ||
        call.status !== 'unknown' || call.reservedCostUSD !== ledger.authorization.reserveUSDPerCall ||
        call.actualCostUSD !== null || !run || run.caseId !== row.caseId || run.status !== 'failed' ||
        run.runDirectory !== path.join('evaluation', 'runs', row.runId)) {
      refuse('an evidence row does not exactly match its terminal unknown call and failed parent run.');
    }
    const caseFile = await containedFile(rootDir, row.casePath);
    const caseBytes = await readFile(caseFile);
    if (sha256(caseBytes) !== row.caseSha256) refuse('a source case artifact no longer matches its audited hash.');
    const record = parseJson(caseBytes, 'source case artifact');
    if (!isObject(record) || record.id !== row.caseId || record.suite !== 'curriculum' ||
        record.attempted !== true || record.originalCase?.id !== row.caseId ||
        !['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE'].includes(record.failure?.code) ||
        record.modelIdentifier !== ledger.authorization.model) {
      refuse('a source case artifact does not match its failed provider request.');
    }
    const bound = createCallBound(row, evidenceFileSha256);
    const rowBoundMicroUSD = reservationUpperBoundMicroUSD(bound);
    if (row.upperBoundUSD !== rowBoundMicroUSD / 1e6) {
      refuse('an evidence row understates or misstates its conservative upper bound.');
    }
    originalMicroUSD += microUSD(row.originalReserveUSD);
    boundMicroUSD += rowBoundMicroUSD;
    rows.push({ call, bound });
  }

  const proofOriginalMicroUSD = microUSD(proof.totalOriginalReservedUSD);
  const proofBoundMicroUSD = microUSD(proof.totalProposedUpperBoundUSD);
  if (originalMicroUSD !== RESERVATION_BOUND_ROW_COUNT * microUSD(ledger.authorization.reserveUSDPerCall) ||
      proofOriginalMicroUSD !== originalMicroUSD || proofBoundMicroUSD !== boundMicroUSD) {
    refuse('evidence totals do not equal the validated rows.');
  }
  const earliestCallAt = Math.min(...rows.map(item => Date.parse(item.call.startedAt)));
  if (sourcePaths.some(relative => Date.parse(sourceFiles[relative].mtime) >= earliestCallAt)) {
    refuse('audited source files must predate the first failed call.');
  }
  const projectionSha256 = reservationProjectionSha256(sourceFiles, rows);
  return { proof, sourceFiles, rows, originalMicroUSD, boundMicroUSD, projectionSha256 };
}

function makeProvenance(plan, evidenceFileSha256, appliedAt) {
  return { schemaVersion: 1, evidencePath: RESERVATION_EVIDENCE_PATH, evidenceFileSha256,
    evidenceCreatedAt: plan.proof.createdAt, appliedAt, rowCount: plan.rows.length,
    totalOriginalReservedUSD: plan.originalMicroUSD / 1e6, totalBoundUSD: plan.boundMicroUSD / 1e6,
    projectionSha256: plan.projectionSha256, sourceFiles: plan.sourceFiles,
    callIds: plan.rows.map(item => item.call.callId).sort() };
}

function totalsSummary(totals) {
  return { providerCalls: totals.providerCalls, actualUSD: totals.actualUSD,
    heldUnknown: { originalReserveUSD: totals.unknownOriginalReservedUSD,
      boundedUSD: totals.unknownBoundedUSD, unboundedUSD: totals.unknownUnboundedReservedUSD,
      heldUSD: totals.unknownReservedUSD, savingsUSD: totals.unknownReserveSavingsUSD },
    committedUSD: totals.committedUSD, remainingUSD: totals.remainingUSD,
    maxProviderCalls: totals.maxProviderCalls, maxCostUSD: totals.maxCostUSD };
}

function previewTotals(ledger, plan, evidenceFileSha256, now) {
  const previewLedger = structuredClone(ledger);
  for (const item of plan.rows) {
    const call = previewLedger.calls.find(candidate => candidate.callId === item.call.callId);
    call.reservationBound = structuredClone(item.bound);
  }
  previewLedger.reservationReconciliation = makeProvenance(plan, evidenceFileSha256, now());
  return sweepTotals(previewLedger, previewLedger.authorization);
}

async function prepare(rootDir, state) {
  if (state.ledger.reservationReconciliation) {
    if (state.ledger.reservationReconciliation.evidenceFileSha256 === state.evidenceFileSha256) {
      return { alreadyApplied: true, ledger: state.ledger, rows: [] };
    }
    refuse('a different reservation reconciliation is already recorded.');
  }
  assertLedgerIdle(state.ledger);
  const plan = await validateEvidenceRows(rootDir, state.ledger, state.evidenceBytes, state.evidenceFileSha256);
  if (plan.rows.length !== RESERVATION_BOUND_ROW_COUNT) refuse('not all reviewed rows were matched.');
  return { alreadyApplied: false, ledger: state.ledger, ...plan };
}

export async function reconcileReservations({ rootDir = ROOT, apply = false,
  now = () => new Date().toISOString() } = {}) {
  rootDir = path.resolve(rootDir);
  const initialState = await readState(rootDir);
  const initialPlan = await prepare(rootDir, initialState);
  if (initialPlan.alreadyApplied) {
    return { kind: 'reservation_reconciliation', status: 'already_applied', applied: false,
      evidenceFileSha256: initialState.evidenceFileSha256,
      summary: totalsSummary(sweepTotals(initialPlan.ledger)) };
  }
  if (!apply) {
    const totals = previewTotals(initialPlan.ledger, initialPlan, initialState.evidenceFileSha256, now);
    return { kind: 'reservation_reconciliation', status: 'ready', applied: false,
      evidenceFileSha256: initialState.evidenceFileSha256, rowCount: initialPlan.rows.length,
      summary: totalsSummary(totals) };
  }

  const lockPath = path.resolve(rootDir, SWEEP_LOCK_PATH);
  const rootReal = await realpath(rootDir);
  const lockDirectoryReal = await realpath(path.dirname(lockPath));
  if (!lockDirectoryReal.startsWith(`${rootReal}${path.sep}`)) refuse('shared lock path escapes the project.');
  const releaseLock = await acquireSweepLock(lockPath, { runId: 'reservation-reconciliation', now });
  try {
    const current = await readState(rootDir);
    const plan = await prepare(rootDir, current);
    if (plan.alreadyApplied) {
      return { kind: 'reservation_reconciliation', status: 'already_applied', applied: false,
        evidenceFileSha256: current.evidenceFileSha256, summary: totalsSummary(sweepTotals(plan.ledger)) };
    }
    assertLedgerIdle(current.ledger);
    for (const item of plan.rows) {
      const call = current.ledger.calls.find(candidate => candidate.callId === item.call.callId);
      call.reservationBound = item.bound;
    }
    current.ledger.reservationReconciliation = makeProvenance(plan, current.evidenceFileSha256, now());
    await saveLedgerAtomic(current.ledgerPath, current.ledger);
    return { kind: 'reservation_reconciliation', status: 'applied', applied: true,
      evidenceFileSha256: current.evidenceFileSha256, rowCount: plan.rows.length,
      summary: totalsSummary(sweepTotals(current.ledger)) };
  } finally { await releaseLock(); }
}

export function parseReconciliationArgs(args) {
  const options = { apply: false };
  for (const arg of args) {
    if (arg === '--help') options.help = true;
    else if (arg === '--apply' && !options.apply) options.apply = true;
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

const helpText = `Usage: node evaluation/reconcile-reservations.mjs [--apply]\nDry run is the default. --apply records reviewed conservative bounds in the saved ledger without changing original call costs or reserves.`;

async function cli() {
  let options;
  try { options = parseReconciliationArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(helpText); return; }
  try {
    const result = await reconcileReservations(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
