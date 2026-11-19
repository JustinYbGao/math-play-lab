import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createModelClient, isModelConfigured, modelConfig } from '../server/model.mjs';
import { emptyReviewRecord, runEvaluation } from './run.mjs';
import {
  ALLOWED_CASE_COUNT, CALLS_PER_CASE, SWEEP_LEDGER_PATH, SWEEP_LOCK_PATH,
  acquireSweepLock, assertLedgerIdle, createBudgetedFetch, saveLedgerAtomic, sweepTotals,
  validateLedger, validateLiveAuthorization,
} from './sweep-budget.mjs';
import { readSweepBundle } from './curriculum-sweep.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECISIONS_PATH = '.work/curriculum-regeneration-decisions.json';
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const retryReasons = new Set(['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE', 'INCOMPLETE_MODEL_OUTPUT',
  'source_correction', 'invalid_plan']);
const providerFailures = new Set(['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE']);
const browserFailures = new Set(['BROWSER_UNAVAILABLE']);
const runnerFailures = new Set(['GENERATION_TIMEOUT', 'NOT_CONFIGURED', 'UNKNOWN']);
const reviewDimensions = ['fidelity', 'mathematics', 'playability', 'explanation'];
const reviewChecks = ['correct', 'wrong', 'reset', 'multipleSolutions'];

const M_G01_ORIGINAL = 'Two parallel lines are cut by a transversal. One interior angle is 68°. Find its alternate interior angle and the adjacent interior angle on the same side of the transversal.';
const M_G01_CORRECTED = 'Two parallel lines are cut by a transversal. One interior angle is 68°. Find its alternate interior angle and the interior angle at the other intersection on the same side of the transversal.';
const M_G01_REASON = 'Same-side interior angles are at different intersections and are not adjacent; the authored prompt conflated these relationships.';

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}
function parseJson(raw, label) {
  try { return JSON.parse(raw); }
  catch { throw new Error(`Retry refused: ${label} is not valid JSON.`); }
}
function positiveInteger(value, option) {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${option} must be a positive integer.`);
  return number;
}

export function parseRetryArgs(args) {
  const options = { live: false, limit: 1 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') { options.help = true; continue; }
    if (arg === '--live') {
      if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
      seen.add(arg); options.live = true; continue;
    }
    if (arg === '--limit') {
      if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
      seen.add(arg);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--limit requires a value.');
      options.limit = positiveInteger(value, '--limit');
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

function summarizeFirstPass(bundle) {
  const allowed = bundle.ledger.authorization.allowedCaseIds;
  const allowedSet = new Set(allowed);
  const queued = bundle.queueCases;
  const queuedSet = new Set(queued.map(item => item?.caseId));
  if (allowedSet.size !== ALLOWED_CASE_COUNT || queuedSet.size !== ALLOWED_CASE_COUNT ||
      [...allowedSet].some(id => !queuedSet.has(id)) ||
      queued.some(item => !isObject(item?.source) || item.source.id !== item.caseId ||
        item.source.problem !== item.problem) || bundle.ledger.runs.some(run => !allowedSet.has(run.caseId))) {
    throw new Error('Retry refused: approved first-pass IDs, queue, or corpus are inconsistent.');
  }
  const byCase = new Map(bundle.ledger.runs.map(run => [run.caseId, run]));
  const pendingIds = allowed.filter(id => !terminalStatuses.has(byCase.get(id)?.status));
  return { byCase, terminalCount: ALLOWED_CASE_COUNT - pendingIds.length, pendingIds,
    complete: pendingIds.length === 0 };
}

function validReview(review) {
  if (!isObject(review) || review.schemaVersion !== 1 || !isObject(review.dimensions) ||
      !isObject(review.checklist) || !exactKeys(review.dimensions, reviewDimensions) ||
      !exactKeys(review.checklist, reviewChecks) ||
      !exactKeys(review, ['schemaVersion', 'dimensions', 'checklist', 'expectedBehavior'])) return false;
  const cells = [...reviewDimensions.map(key => review.dimensions[key]),
    ...reviewChecks.map(key => review.checklist[key]), review.expectedBehavior];
  return cells.every(cell => isObject(cell) && exactKeys(cell, ['status', 'reviewer', 'evidence']) &&
    ['unreviewed', 'passed', 'failed', 'not_applicable'].includes(cell.status) &&
    typeof cell.reviewer === 'string' && typeof cell.evidence === 'string' &&
    (cell.status === 'unreviewed' || (cell.reviewer.trim() && cell.evidence.trim())));
}

function hasFailedMathReview(review) {
  if (!validReview(review)) return false;
  return ['mathematics', 'explanation'].some(key => review.dimensions[key].status === 'failed');
}

async function containedPath(projectRoot, base, relative) {
  if (!safeRelative(relative)) throw new Error('Retry refused: saved artifact path is unsafe.');
  const baseReal = await realpath(base);
  if (!baseReal.startsWith(`${projectRoot}${path.sep}`)) throw new Error('Retry refused: saved artifact path escapes the project.');
  const candidate = path.resolve(baseReal, relative);
  if (!candidate.startsWith(`${baseReal}${path.sep}`)) throw new Error('Retry refused: saved artifact path escapes its run.');
  const candidateReal = await realpath(candidate);
  if (!candidateReal.startsWith(`${baseReal}${path.sep}`) || !candidateReal.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('Retry refused: saved artifact path escapes its run.');
  }
  return candidateReal;
}

async function readParentArtifact(rootDir, queueCase, parentRun, { allowHtml = false } = {}) {
  const source = queueCase.source;
  const caseId = queueCase.caseId;
  if (!safeId.test(caseId ?? '') || source.id !== caseId || source.problem !== queueCase.problem ||
      parentRun?.caseId !== caseId || !safeId.test(parentRun?.runId ?? '') ||
      parentRun.runDirectory !== path.join('evaluation', 'runs', parentRun.runId)) return null;
  let projectRoot;
  let runsRoot;
  let runDir;
  try {
    projectRoot = await realpath(rootDir);
    runsRoot = await realpath(path.join(projectRoot, 'evaluation', 'runs'));
    if (!runsRoot.startsWith(`${projectRoot}${path.sep}`)) return null;
    runDir = await containedPath(projectRoot, runsRoot, parentRun.runId);
    if (!runDir.startsWith(`${runsRoot}${path.sep}`)) return null;
  } catch { return null; }

  let manifest;
  let casePath;
  let caseBytes;
  let record;
  try {
    manifest = parseJson(await readFile(await containedPath(projectRoot, runDir, 'manifest.json'), 'utf8'), 'parent manifest');
    const caseRelative = path.join('cases', `${caseId}.json`);
    casePath = await containedPath(projectRoot, runDir, caseRelative);
    caseBytes = await readFile(casePath);
    record = JSON.parse(caseBytes.toString('utf8'));
  } catch { return null; }
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || manifest.runId !== parentRun.runId ||
      manifest.suite !== 'curriculum' || manifest.evidenceClass !== 'live' ||
      !['completed', 'cancelled'].includes(manifest.status) ||
      manifest.modelIdentifier !== 'anthropic/claude-sonnet-5.5' ||
      !Array.isArray(manifest.caseArtifactFiles) || manifest.caseArtifactFiles.length !== 1 ||
      manifest.caseArtifactFiles[0] !== path.join('cases', `${caseId}.json`) ||
      !isObject(record) || record.schemaVersion !== 1 || record.id !== caseId ||
      record.suite !== 'curriculum' || record.attempted !== true ||
      record.originalCase?.id !== caseId || record.originalCase?.problem !== source.problem ||
      record.originalInput?.problem !== source.problem || record.expectedBehavior !== source.expected_behavior ||
      record.reference?.answer !== source.reference_answer ||
      JSON.stringify(record.reference?.checks) !== JSON.stringify(source.checks) ||
      record.reference?.status !== source.reference_status || !Array.isArray(record.htmlFiles)) return null;
  for (const relative of record.htmlFiles) {
    if (typeof relative !== 'string' || path.extname(relative).toLowerCase() !== '.html') return null;
    try { await containedPath(projectRoot, runDir, relative); }
    catch { return null; }
  }
  if (!allowHtml) {
    if (record.htmlFiles.length !== 0) return null;
    try {
      const htmlDir = await containedPath(projectRoot, runDir, 'html');
      if ((await readdir(htmlDir)).length !== 0) return null;
    } catch { return null; }
  }
  return { runDir, manifest, record, caseBytes, parentCaseSha256: sha256(caseBytes) };
}

function canonicalDecision(decision) {
  return JSON.stringify({ caseId: decision.caseId, parentRunId: decision.parentRunId,
    parentCaseSha256: decision.parentCaseSha256, kind: decision.kind, reason: decision.reason });
}

async function readDecisionBytes(rootDir) {
  const projectRoot = await realpath(rootDir);
  const decisionPath = path.resolve(projectRoot, DECISIONS_PATH);
  const workDir = path.dirname(decisionPath);
  let workReal;
  try { workReal = await realpath(workDir); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!workReal.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('Retry refused: regeneration decision path escapes the project.');
  }
  let decisionReal;
  try { decisionReal = await realpath(decisionPath); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!decisionReal.startsWith(`${workReal}${path.sep}`)) {
    throw new Error('Retry refused: regeneration decision path escapes its directory.');
  }
  return readFile(decisionReal, 'utf8');
}

async function loadInvalidPlanDecisions(rootDir, bundle, firstPass = summarizeFirstPass(bundle)) {
  const raw = await readDecisionBytes(rootDir);
  if (raw === null) return new Map();
  const saved = parseJson(raw, 'regeneration decisions');
  if (!exactKeys(saved, ['schemaVersion', 'decisions']) || saved.schemaVersion !== 1 ||
      !Array.isArray(saved.decisions)) throw new Error('Retry refused: regeneration decisions are malformed.');
  const queueById = new Map(bundle.queueCases.map(item => [item.caseId, item]));
  const seen = new Set();
  const decisions = new Map();
  for (const decision of saved.decisions) {
    if (!exactKeys(decision, ['caseId', 'parentRunId', 'parentCaseSha256', 'kind', 'reason']) ||
        !safeId.test(decision.caseId ?? '') || seen.has(decision.caseId) ||
        !bundle.ledger.authorization.allowedCaseIds.includes(decision.caseId) ||
        decision.kind !== 'invalid_plan' || !safeId.test(decision.parentRunId ?? '') ||
        !isSha256(decision.parentCaseSha256) || typeof decision.reason !== 'string' ||
        !decision.reason.trim() || decision.reason.length > 2000) {
      throw new Error('Retry refused: regeneration decision fields are malformed.');
    }
    seen.add(decision.caseId);
    const parentRun = firstPass.byCase.get(decision.caseId);
    const queued = queueById.get(decision.caseId);
    if (!parentRun || !queued || parentRun.runId !== decision.parentRunId || !terminalStatuses.has(parentRun.status)) {
      throw new Error(`Retry refused: regeneration decision for ${decision.caseId} has stale parent identity.`);
    }
    const artifact = await readParentArtifact(rootDir, queued, parentRun, { allowHtml: true });
    if (!artifact || artifact.parentCaseSha256 !== decision.parentCaseSha256 ||
        !['completed_generation', 'failed'].includes(artifact.record.status) ||
        artifact.record.result?.type === 'clarification' || !hasFailedMathReview(artifact.record.review)) {
      throw new Error(`Retry refused: regeneration decision for ${decision.caseId} is stale or lacks failed independent review.`);
    }
    const normalized = { ...decision, decisionSha256: sha256(canonicalDecision(decision)), artifact };
    decisions.set(decision.caseId, normalized);
  }
  return decisions;
}

function retryProvenance(row) {
  return { parentRunId: row.parentRunId, parentCaseSha256: row.parentCaseSha256,
    retryReason: row.retryReason, originalProblem: row.originalProblem, usedProblem: row.usedProblem,
    sourceCorrectionReason: row.sourceCorrectionReason, decisionReason: row.decisionReason,
    decisionSha256: row.decisionSha256 };
}

function allKnownRunIds(ledger) {
  return new Set([...ledger.runs.map(run => run.runId),
    ...(Array.isArray(ledger.repairRuns) ? ledger.repairRuns.map(run => run.runId) : []),
    ...(Array.isArray(ledger.retryRuns) ? ledger.retryRuns.map(run => run.runId) : [])]);
}

export function validateRetryLedger(ledger, queueCases, { allowStarted = false } = {}) {
  if (Object.hasOwn(ledger, 'retryRuns') && !Array.isArray(ledger.retryRuns)) {
    throw new Error('Retry refused: retryRuns must be an array.');
  }
  if (Object.hasOwn(ledger, 'repairRuns') && !Array.isArray(ledger.repairRuns)) {
    throw new Error('Retry refused: repairRuns must be an array.');
  }
  const retries = ledger.retryRuns ?? [];
  const queueById = new Map(queueCases.map(item => [item.caseId, item]));
  const parentById = new Map(ledger.runs.map(run => [run.runId, run]));
  const runIds = new Set(ledger.runs.map(run => run.runId));
  for (const repair of ledger.repairRuns ?? []) {
    if (typeof repair?.runId !== 'string' || runIds.has(repair.runId)) {
      throw new Error('Retry refused: saved follow-up run IDs are malformed or duplicated.');
    }
    runIds.add(repair.runId);
  }
  const cases = new Set();
  for (const row of retries) {
    const expectedKeys = ['schemaVersion', 'parentRunId', 'caseId', 'parentCaseSha256', 'retryReason',
      'originalProblem', 'usedProblem', 'sourceCorrectionReason', 'decisionReason', 'decisionSha256',
      'runId', 'runDirectory', 'status', 'outgoingProviderRequests', 'runEvaluationModelInvocations',
      'startedAt', 'finishedAt'];
    const parent = parentById.get(row?.parentRunId);
    const queued = queueById.get(row?.caseId);
    if (!exactKeys(row, expectedKeys) || row.schemaVersion !== 1 || !safeId.test(row.runId ?? '') ||
        runIds.has(row.runId) || !safeId.test(row.caseId ?? '') || cases.has(row.caseId) || !queued ||
        !ledger.authorization.allowedCaseIds.includes(row.caseId) || !parent ||
        parent.caseId !== row.caseId || !terminalStatuses.has(parent.status) ||
        !isSha256(row.parentCaseSha256) || !retryReasons.has(row.retryReason) ||
        typeof row.originalProblem !== 'string' || !row.originalProblem.trim() ||
        typeof row.usedProblem !== 'string' || !row.usedProblem.trim() ||
        row.runDirectory !== path.join('evaluation', 'runs', row.runId) ||
        !['started', ...terminalStatuses].includes(row.status) ||
        typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt)) ||
        (row.status === 'started' ? row.finishedAt !== null :
          typeof row.finishedAt !== 'string' || !Number.isFinite(Date.parse(row.finishedAt))) ||
        !Number.isSafeInteger(row.outgoingProviderRequests) || row.outgoingProviderRequests < 0 || row.outgoingProviderRequests > CALLS_PER_CASE ||
        !Number.isSafeInteger(row.runEvaluationModelInvocations) || row.runEvaluationModelInvocations < 0 ||
          row.runEvaluationModelInvocations > CALLS_PER_CASE || row.runEvaluationModelInvocations < row.outgoingProviderRequests) {
      throw new Error('Retry refused: saved retryRuns accounting is malformed.');
    }
    const source = queued.source;
    if (source.problem !== row.originalProblem || (row.retryReason === 'source_correction'
        ? row.caseId !== 'M-G01-basic' || row.originalProblem !== M_G01_ORIGINAL || row.usedProblem !== M_G01_CORRECTED ||
          row.sourceCorrectionReason !== M_G01_REASON || row.decisionReason !== null || row.decisionSha256 !== null
        : row.retryReason === 'invalid_plan'
          ? row.usedProblem !== row.originalProblem || typeof row.decisionReason !== 'string' || !row.decisionReason.trim() ||
            !isSha256(row.decisionSha256) || row.sourceCorrectionReason !== null
          : row.usedProblem !== row.originalProblem || row.sourceCorrectionReason !== null ||
            row.decisionReason !== null || row.decisionSha256 !== null)) {
      throw new Error('Retry refused: saved retry provenance does not match the approved question.');
    }
    const matchingCalls = ledger.calls.filter(call => call.runId === row.runId);
    if (matchingCalls.some(call => call.caseId !== row.caseId) ||
        (row.status !== 'started' && matchingCalls.length !== row.outgoingProviderRequests) ||
        (row.status === 'started' && matchingCalls.length < row.outgoingProviderRequests)) {
      throw new Error('Retry refused: saved retry call accounting does not match the ledger.');
    }
    runIds.add(row.runId);
    cases.add(row.caseId);
  }
  if (!allowStarted && retries.some(row => row.status === 'started')) {
    throw new Error('Retry refused: an unfinished retry requires manual review.');
  }
  return retries;
}

async function verifyRetryArtifacts(rootDir, ledger, retries) {
  const projectRoot = await realpath(rootDir);
  const runsRoot = await realpath(path.join(projectRoot, 'evaluation', 'runs'));
  if (!runsRoot.startsWith(`${projectRoot}${path.sep}`)) throw new Error('Retry refused: run artifacts escape the project.');
  for (const row of retries) {
    if (row.status === 'started') continue;
    let runDir;
    let manifest;
    let record;
    try {
      runDir = await containedPath(projectRoot, runsRoot, row.runId);
      manifest = parseJson(await readFile(await containedPath(projectRoot, runDir, 'manifest.json'), 'utf8'), 'retry manifest');
      record = parseJson(await readFile(await containedPath(projectRoot, runDir, path.join('cases', `${row.caseId}.json`)), 'utf8'), 'retry case');
    } catch { throw new Error(`Retry refused: saved child artifacts for ${row.caseId} are missing or unsafe.`); }
    const expected = retryProvenance(row);
    if (!isObject(manifest) || manifest.runId !== row.runId || manifest.suite !== 'curriculum' ||
        manifest.evidenceClass !== 'live' || !Array.isArray(manifest.caseArtifactFiles) ||
        !manifest.caseArtifactFiles.includes(path.join('cases', `${row.caseId}.json`)) ||
        JSON.stringify(manifest.retryProvenance) !== JSON.stringify(expected) ||
        !isObject(record) || record.id !== row.caseId || record.suite !== 'curriculum' ||
        record.originalCase?.id !== row.caseId || record.originalCase?.problem !== row.usedProblem ||
        record.originalInput?.problem !== row.usedProblem ||
        JSON.stringify(record.retryProvenance) !== JSON.stringify(expected) || !validReview(record.review) ||
        record.providerCalls !== row.runEvaluationModelInvocations || manifest.providerCalls !== row.runEvaluationModelInvocations ||
        !Array.isArray(record.htmlFiles) ||
        (row.status === 'completed' && !['completed_generation', 'completed_clarification'].includes(record.status)) ||
        (row.status === 'failed' && record.status !== 'failed') ||
        (row.status === 'cancelled' && !['cancelled', 'unrun'].includes(record.status)) ||
        (row.status === 'cancelled' ? manifest.status !== 'cancelled' : manifest.status !== 'completed')) {
      throw new Error(`Retry refused: saved child artifacts for ${row.caseId} do not match retry accounting.`);
    }
    for (const relative of record.htmlFiles) {
      if (typeof relative !== 'string' || path.extname(relative).toLowerCase() !== '.html') {
        throw new Error(`Retry refused: saved child artifacts for ${row.caseId} contain an unsafe page path.`);
      }
      try { await containedPath(projectRoot, runDir, relative); }
      catch { throw new Error(`Retry refused: saved child artifacts for ${row.caseId} contain an unsafe page path.`); }
    }
  }
}

export async function getCurriculumRetryExclusions({ rootDir, bundle }) {
  validateLedger(bundle.ledger);
  validateLiveAuthorization(bundle.ledger.authorization);
  const firstPass = summarizeFirstPass(bundle);
  const retries = validateRetryLedger(bundle.ledger, bundle.queueCases, { allowStarted: false });
  await verifyRetryParents(rootDir, bundle, retries);
  const decisions = firstPass.complete ? await loadInvalidPlanDecisions(rootDir, bundle, firstPass) : new Map();
  validateRetryDecisions(retries, decisions);
  return new Set([...retries.map(row => row.caseId), ...decisions.keys()]);
}

async function verifyRetryParents(rootDir, bundle, retries) {
  if (!retries.length) return;
  const firstPass = summarizeFirstPass(bundle);
  const queueById = new Map(bundle.queueCases.map(item => [item.caseId, item]));
  for (const row of retries) {
    const parent = firstPass.byCase.get(row.caseId);
    const artifact = parent && await readParentArtifact(rootDir, queueById.get(row.caseId), parent, { allowHtml: true });
    if (!artifact || parent.runId !== row.parentRunId || artifact.parentCaseSha256 !== row.parentCaseSha256 ||
        artifact.record.originalInput?.problem !== row.originalProblem) {
      throw new Error(`Retry refused: saved parent artifact for ${row.caseId} no longer matches its retry hash.`);
    }
  }
}

function validateRetryDecisions(retries, decisions) {
  for (const row of retries) {
    if (row.retryReason !== 'invalid_plan') continue;
    const decision = decisions.get(row.caseId);
    if (!decision || decision.parentRunId !== row.parentRunId ||
        decision.parentCaseSha256 !== row.parentCaseSha256 || decision.reason !== row.decisionReason ||
        decision.decisionSha256 !== row.decisionSha256) {
      throw new Error(`Retry refused: saved invalid-plan provenance for ${row.caseId} no longer matches its decision.`);
    }
  }
}

async function collectEligible(rootDir, bundle, firstPass) {
  const retries = validateRetryLedger(bundle.ledger, bundle.queueCases, { allowStarted: false });
  const alreadyRetriedIds = new Set(retries.map(row => row.caseId));
  const decisions = await loadInvalidPlanDecisions(rootDir, bundle, firstPass);
  validateRetryDecisions(retries, decisions);
  const repairIds = new Set((bundle.ledger.repairRuns ?? []).map(row => row.caseId));
  const eligible = [];
  for (const queued of bundle.queueCases) {
    const caseId = queued.caseId;
    if (alreadyRetriedIds.has(caseId) || repairIds.has(caseId)) continue;
    const parentRun = firstPass.byCase.get(caseId);
    if (!parentRun) continue;
    const decision = decisions.get(caseId);
    if (decision) {
      eligible.push({ queueCase: queued, parentRun, parentRecord: decision.artifact.record,
        parentCaseSha256: decision.artifact.parentCaseSha256, retryReason: 'invalid_plan',
        originalProblem: queued.problem, usedProblem: queued.problem, sourceCorrectionReason: null,
        decisionReason: decision.reason, decisionSha256: decision.decisionSha256 });
      continue;
    }
    const artifact = await readParentArtifact(rootDir, queued, parentRun, { allowHtml: false });
    if (!artifact || parentRun.status !== 'failed' || artifact.record.status !== 'failed') continue;
    const code = artifact.record.failure?.code;
    if (['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE', 'INCOMPLETE_MODEL_OUTPUT'].includes(code)) {
      eligible.push({ queueCase: queued, parentRun, parentRecord: artifact.record,
        parentCaseSha256: artifact.parentCaseSha256, retryReason: code, originalProblem: queued.problem,
        usedProblem: queued.problem, sourceCorrectionReason: null, decisionReason: null, decisionSha256: null });
      continue;
    }
    if (caseId === 'M-G01-basic' && code === 'PLAN_CONFLICT' && queued.problem === M_G01_ORIGINAL) {
      eligible.push({ queueCase: queued, parentRun, parentRecord: artifact.record,
        parentCaseSha256: artifact.parentCaseSha256, retryReason: 'source_correction',
        originalProblem: queued.problem, usedProblem: M_G01_CORRECTED,
        sourceCorrectionReason: M_G01_REASON, decisionReason: null, decisionSha256: null });
    }
  }
  return { eligible, alreadyRetriedIds, decisions };
}

function retryPreview(bundle, firstPass, candidates, limit) {
  const totals = sweepTotals(bundle.ledger, bundle.ledger.authorization);
  const selected = candidates.eligible.slice(0, limit);
  const admissionUSD = Number((CALLS_PER_CASE * bundle.ledger.authorization.reserveUSDPerCall).toFixed(6));
  const capacity = totals.remainingProviderCalls >= CALLS_PER_CASE && totals.remainingUSD >= admissionUSD;
  return { kind: 'dry_run', status: !firstPass.complete ? 'blocked' : !capacity && selected.length ? 'capacity_stopped' : selected.length ? 'ready' : 'nothing_to_retry',
    selectedLimit: limit, firstPass: { terminal: firstPass.terminalCount, total: ALLOWED_CASE_COUNT,
      pendingCount: firstPass.pendingIds.length, pendingIds: firstPass.pendingIds },
    eligible: candidates.eligible.map(item => ({ id: item.queueCase.caseId, parentRunId: item.parentRun.runId,
      reason: item.retryReason })),
    selected: selected.map(item => ({ id: item.queueCase.caseId, parentRunId: item.parentRun.runId,
      reason: item.retryReason })),
    skippedAlreadyRetried: [...candidates.alreadyRetriedIds],
    activeRun: bundle.ledger.activeRun !== null,
    budget: { ...totals, admissionCalls: CALLS_PER_CASE, admissionCostUSD: admissionUSD,
      enoughForOneRetry: capacity } };
}

function liveConfig(config) {
  if (!isModelConfigured(config) || config.provider !== 'openrouter' ||
      config.model !== 'anthropic/claude-sonnet-5.5' || config.baseUrl !== 'https://openrouter.ai/api/v1') {
    throw new Error('Live retry refused: configured model does not match the approved OpenRouter endpoint and model.');
  }
  return config;
}

function makeRetryRow(candidate, runId, now) {
  return { schemaVersion: 1, parentRunId: candidate.parentRun.runId, caseId: candidate.queueCase.caseId,
    parentCaseSha256: candidate.parentCaseSha256, retryReason: candidate.retryReason,
    originalProblem: candidate.originalProblem, usedProblem: candidate.usedProblem,
    sourceCorrectionReason: candidate.sourceCorrectionReason, decisionReason: candidate.decisionReason,
    decisionSha256: candidate.decisionSha256, runId, runDirectory: path.join('evaluation', 'runs', runId),
    status: 'started', outgoingProviderRequests: 0, runEvaluationModelInvocations: 0,
    startedAt: now(), finishedAt: null };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, filePath); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

function datasetForRetry(sourceDataset, candidate) {
  const dataset = structuredClone(sourceDataset);
  const item = dataset.cases.find(entry => entry.id === candidate.queueCase.caseId);
  if (!item || item.problem !== candidate.originalProblem) {
    throw new Error('Retry refused: cloned source case no longer matches the approved question.');
  }
  item.problem = candidate.usedProblem;
  return dataset;
}

async function persistRetryProvenance(rootDir, row, manifest, result) {
  const runDirectory = path.resolve(rootDir, row.runDirectory);
  if (path.resolve(result.runDir) !== runDirectory) throw new Error('Retry stopped: child run path does not match its ledger ID.');
  const projectRoot = await realpath(rootDir);
  const runsRoot = await realpath(path.join(projectRoot, 'evaluation', 'runs'));
  const runDir = await containedPath(projectRoot, runsRoot, row.runId);
  if (runDir !== await realpath(runDirectory)) throw new Error('Retry stopped: child run path is unsafe.');
  const manifestPath = await containedPath(projectRoot, runDir, 'manifest.json');
  const casePath = await containedPath(projectRoot, runDir, path.join('cases', `${row.caseId}.json`));
  const childManifest = parseJson(await readFile(manifestPath, 'utf8'), 'child manifest');
  const record = parseJson(await readFile(casePath, 'utf8'), 'child case');
  if (!isObject(childManifest) || childManifest.runId !== row.runId || childManifest.suite !== 'curriculum' ||
      childManifest.evidenceClass !== 'live' || !isObject(record) || record.id !== row.caseId ||
      record.suite !== 'curriculum' || record.originalCase?.problem !== row.usedProblem ||
      record.originalInput?.problem !== row.usedProblem || !['failed', 'cancelled', 'completed_generation',
        'completed_clarification', 'unrun'].includes(record.status) || !validReview(record.review) ||
      !Array.isArray(record.htmlFiles)) {
    throw new Error('Retry stopped: generated child artifacts are missing or malformed.');
  }
  for (const relative of record.htmlFiles) {
    if (typeof relative !== 'string' || path.extname(relative).toLowerCase() !== '.html') {
      throw new Error('Retry stopped: generated child page path is malformed.');
    }
    await containedPath(projectRoot, runDir, relative);
  }
  record.review = emptyReviewRecord();
  const provenance = retryProvenance(row);
  record.retryProvenance = provenance;
  childManifest.retryProvenance = provenance;
  manifest.retryProvenance = provenance;
  await writeJsonAtomic(casePath, record);
  await writeJsonAtomic(manifestPath, childManifest);
  return { record, childManifest };
}

function stopForChild(record, signal) {
  if (signal?.aborted || record.status === 'cancelled' || record.status === 'unrun') return 'sigint';
  const failureCode = record.failure?.code;
  if (providerFailures.has(failureCode)) return 'provider_failure';
  if (browserFailures.has(failureCode)) return 'browser_failure';
  if (failureCode === 'EVALUATION_CALL_CAP') return 'budget_capacity';
  if (runnerFailures.has(failureCode)) return 'runner_error';
  return null;
}

function retryStatus(stopReason) {
  return stopReason === 'sigint' ? 'cancelled' : stopReason === 'budget_halt' ? 'budget_halted' :
    stopReason === 'budget_capacity' ? 'capacity_stopped' : stopReason === 'provider_failure' ? 'stopped_after_provider_failure' :
      stopReason === 'browser_failure' ? 'stopped_after_browser_failure' :
        stopReason === 'runner_error' ? 'stopped_after_runner_error' :
          stopReason === 'persistence_failure' ? 'stopped_after_persistence_failure' :
            stopReason === 'accounting_failure' ? 'stopped_after_accounting_failure' : 'completed';
}

export async function runCurriculumRetry({ rootDir = ROOT, live = false, limit = 1, config,
  readBundle = readSweepBundle, runEvaluationFn = runEvaluation, fetchImpl = fetch,
  now = () => new Date().toISOString(), idFactory = randomUUID, signal,
  onProgress = item => console.error(item) } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
  rootDir = path.resolve(rootDir);
  const initial = await readBundle(rootDir);
  validateLedger(initial.ledger);
  validateLiveAuthorization(initial.ledger.authorization);
  if (path.resolve(initial.ledgerPath) !== path.resolve(rootDir, SWEEP_LEDGER_PATH)) {
    throw new Error('Retry refused: ledger path is outside the approved root.');
  }
  const initialRootReal = await realpath(rootDir);
  const initialLedgerReal = await realpath(initial.ledgerPath);
  if (!initialLedgerReal.startsWith(`${initialRootReal}${path.sep}`)) {
    throw new Error('Retry refused: ledger resolves outside the approved root.');
  }
  const firstPass = summarizeFirstPass(initial);
  const initialRetries = validateRetryLedger(initial.ledger, initial.queueCases, { allowStarted: false });
  await verifyRetryArtifacts(rootDir, initial.ledger, initialRetries);
  await verifyRetryParents(rootDir, initial, initialRetries);
  const initialCandidates = firstPass.complete
    ? await collectEligible(rootDir, initial, firstPass)
    : { eligible: [], alreadyRetriedIds: new Set((initial.ledger.retryRuns ?? []).map(row => row.caseId)) };
  const preview = retryPreview(initial, firstPass, initialCandidates, limit);
  if (!live) return preview;
  if (!firstPass.complete) {
    throw new Error(`Live retry refused: first-pass breadth is incomplete (${firstPass.terminalCount}/${ALLOWED_CASE_COUNT} terminal).`);
  }
  assertLedgerIdle(initial.ledger);
  if ((initial.ledger.repairRuns ?? []).some(row => row.status === 'started')) {
    throw new Error('Live retry refused: an unfinished page repair requires manual review.');
  }
  const configValue = liveConfig(config ?? modelConfig());
  if (!initialCandidates.eligible.length) {
    return { kind: 'retry', status: 'nothing_to_retry', stopReason: 'no_eligible_cases', selectedCount: 0,
      firstPass: { terminal: firstPass.terminalCount, total: ALLOWED_CASE_COUNT }, retries: [],
      budget: sweepTotals(initial.ledger) };
  }
  const initialBudget = sweepTotals(initial.ledger, initial.ledger.authorization);
  const admissionUSD = Number((CALLS_PER_CASE * initial.ledger.authorization.reserveUSDPerCall).toFixed(6));
  if (initialBudget.remainingProviderCalls < CALLS_PER_CASE || initialBudget.remainingUSD < admissionUSD) {
    return { kind: 'retry', status: 'capacity_stopped', stopReason: 'budget_capacity', selectedCount: 0,
      firstPass: { terminal: firstPass.terminalCount, total: ALLOWED_CASE_COUNT }, retries: [], budget: initialBudget };
  }

  const batchId = idFactory();
  if (!safeId.test(batchId ?? '') || allKnownRunIds(initial.ledger).has(batchId) ||
      initial.ledger.calls.some(call => call.callId === batchId)) {
    throw new Error('Live retry refused: generated batch ID is invalid or already used.');
  }
  const lockPath = path.resolve(rootDir, SWEEP_LOCK_PATH);
  const rootReal = await realpath(rootDir);
  const lockParentReal = await realpath(path.dirname(lockPath));
  if (!lockParentReal.startsWith(`${rootReal}${path.sep}`)) throw new Error('Live retry refused: lock path escapes the approved root.');
  const releaseLock = await acquireSweepLock(lockPath, { runId: batchId, now });
  let ledger;
  let ledgerPath;
  let stopReason;
  let cleanFinalize = false;
  const completedRows = [];
  const batchCallsBefore = initial.ledger.calls.length;
  try {
    const current = await readBundle(rootDir);
    ledger = current.ledger;
    ledgerPath = current.ledgerPath;
    validateLedger(ledger);
    validateLiveAuthorization(ledger.authorization);
    if (path.resolve(ledgerPath) !== path.resolve(rootDir, SWEEP_LEDGER_PATH)) {
      throw new Error('Live retry refused: ledger path changed.');
    }
    const currentLedgerReal = await realpath(ledgerPath);
    if (!currentLedgerReal.startsWith(`${rootReal}${path.sep}`)) throw new Error('Live retry refused: ledger resolves outside the approved root.');
    assertLedgerIdle(ledger);
    const currentFirstPass = summarizeFirstPass(current);
    const existingRetries = validateRetryLedger(ledger, current.queueCases, { allowStarted: false });
    await verifyRetryArtifacts(rootDir, ledger, existingRetries);
    await verifyRetryParents(rootDir, current, existingRetries);
    if (!currentFirstPass.complete) throw new Error('Live retry refused: first-pass breadth became incomplete before lock acquisition.');
    if ((ledger.repairRuns ?? []).some(row => row.status === 'started')) {
      throw new Error('Live retry refused: an unfinished page repair requires manual review.');
    }
    const selectionData = await collectEligible(rootDir, current, currentFirstPass);
    const selected = selectionData.eligible.slice(0, limit);
    if (!selected.length) {
      cleanFinalize = true;
      return { kind: 'retry', status: 'nothing_to_retry', stopReason: 'no_eligible_cases', selectedCount: 0,
        firstPass: { terminal: currentFirstPass.terminalCount, total: ALLOWED_CASE_COUNT }, retries: [],
        budget: sweepTotals(ledger) };
    }
    ledger.activeRun = { runId: batchId, purpose: 'bounded-curriculum-delivery-retry', startedAt: now(),
      selectedCaseIds: selected.map(item => item.queueCase.caseId) };
    await saveLedgerAtomic(ledgerPath, ledger);

    for (const candidate of selected) {
      const beforeBudget = sweepTotals(ledger, ledger.authorization);
      const caseReserveUSD = Number((CALLS_PER_CASE * ledger.authorization.reserveUSDPerCall).toFixed(6));
      if (beforeBudget.remainingProviderCalls < CALLS_PER_CASE || beforeBudget.remainingUSD < caseReserveUSD) {
        stopReason = 'budget_capacity'; break;
      }
      const runId = idFactory();
      if (!safeId.test(runId ?? '') || allKnownRunIds(ledger).has(runId) || runId === batchId ||
          ledger.calls.some(call => call.callId === runId)) {
        stopReason = 'accounting_failure';
        throw new Error('Live retry stopped: generated child ID is invalid or already used.');
      }
      const row = makeRetryRow(candidate, runId, now);
      ledger.retryRuns ??= [];
      ledger.retryRuns.push(row);
      validateRetryLedger(ledger, current.queueCases, { allowStarted: true });
      ledger.activeRun = { runId: batchId, purpose: 'bounded-curriculum-delivery-retry', startedAt: ledger.activeRun.startedAt,
        caseId: row.caseId, retryRunId: row.runId, selectedCaseIds: selected.map(item => item.queueCase.caseId) };
      await saveLedgerAtomic(ledgerPath, ledger);

      const beforeCalls = ledger.calls.length;
      const localMaxProviderCalls = Math.min(ledger.authorization.maxProviderCalls,
        ledger.calls.length + CALLS_PER_CASE);
      const localMaxCostUSD = Math.min(ledger.authorization.maxCostUSD,
        Number((beforeBudget.committedUSD + caseReserveUSD).toFixed(6)));
      const retryCallIds = new Set(ledger.calls.map(call => call.callId));
      const callIdFactory = () => {
        const callId = idFactory();
        if (!safeId.test(callId ?? '') || retryCallIds.has(callId) || allKnownRunIds(ledger).has(callId)) {
          throw new Error('Live retry stopped: generated provider-call ID is invalid or already used.');
        }
        retryCallIds.add(callId);
        return callId;
      };
      const budgetedFetch = createBudgetedFetch({ ledger, ledgerPath, authorization: ledger.authorization,
        caseId: row.caseId, runId, fetchImpl, now, idFactory: callIdFactory,
        maxProviderCalls: localMaxProviderCalls, maxCostUSD: localMaxCostUSD });
      const dataset = datasetForRetry(current.sourceDataset, candidate);
      let result;
      try {
        result = await runEvaluationFn({ rootDir, dataset, suiteName: 'curriculum', live: true,
          maxCalls: CALLS_PER_CASE, modelConfigured: true,
          model: createModelClient(configValue, budgetedFetch), modelName: ledger.authorization.model,
          caseId: row.caseId, idFactory: () => runId, signal });
      } catch (error) {
        stopReason = signal?.aborted || error?.name === 'AbortError' ? 'sigint' : 'runner_error';
        onProgress({ id: row.caseId, runId, status: 'stopped', reason: stopReason });
        throw error;
      }
      if (result?.kind !== 'run' || !result.manifest || !result.runDir) {
        stopReason = 'runner_error';
        throw new Error('Live retry stopped: evaluation runner returned no saved child run.');
      }
      row.outgoingProviderRequests = ledger.calls.length - beforeCalls;
      row.runEvaluationModelInvocations = result.manifest.providerCalls ?? 0;
      if (!Number.isSafeInteger(row.outgoingProviderRequests) || row.outgoingProviderRequests < 0 ||
          row.outgoingProviderRequests > CALLS_PER_CASE || !Number.isSafeInteger(row.runEvaluationModelInvocations) ||
          row.runEvaluationModelInvocations < row.outgoingProviderRequests ||
          row.runEvaluationModelInvocations > CALLS_PER_CASE ||
          ledger.calls.slice(beforeCalls).some(call => call.runId !== runId || call.caseId !== row.caseId)) {
        stopReason = 'accounting_failure';
        throw new Error('Live retry stopped: child call accounting exceeded or disagreed with its three-call cap.');
      }
      const updated = await persistRetryProvenance(rootDir, row, result.manifest, result);
      const record = updated.record;
      if (record.status === 'unrun' && signal?.aborted) row.status = 'cancelled';
      else if (record.status === 'cancelled') row.status = 'cancelled';
      else if (record.status === 'failed') row.status = 'failed';
      else row.status = 'completed';
      row.finishedAt = now();
      validateRetryLedger(ledger, current.queueCases, { allowStarted: true });
      await verifyRetryArtifacts(rootDir, ledger, [row]);
      await saveLedgerAtomic(ledgerPath, ledger);
      completedRows.push(row);
      const totals = sweepTotals(ledger, ledger.authorization);
      onProgress({ id: row.caseId, parentRunId: row.parentRunId, runId, status: row.status,
        outgoingProviderRequests: row.outgoingProviderRequests,
        runEvaluationModelInvocations: row.runEvaluationModelInvocations, budget: totals });
      if (ledger.budgetHalt) { stopReason = 'budget_halt'; break; }
      const childStop = stopForChild(record, signal);
      if (childStop) { stopReason = childStop; break; }
    }
    if (!stopReason && signal?.aborted) stopReason = 'sigint';
    if (!stopReason) stopReason = selected.length < selectionData.eligible.length ? 'limit_reached' : 'eligible_cases_exhausted';
    ledger.activeRun = null;
    await saveLedgerAtomic(ledgerPath, ledger);
    cleanFinalize = true;
  } catch (error) {
    if (!stopReason) stopReason = error?.code === 'EVALUATION_CALL_CAP' ? 'budget_capacity' : 'persistence_failure';
    throw error;
  } finally {
    try {
      if (!cleanFinalize && ledger && ledgerPath && ledger.activeRun !== null) {
        // Leave the durable active marker in place if the retry accounting may be incomplete.
        await saveLedgerAtomic(ledgerPath, ledger).catch(() => {});
      }
    } finally { await releaseLock(); }
  }
  const status = retryStatus(stopReason);
  return { kind: 'retry', status, stopReason, selectedCount: completedRows.length,
    firstPass: { terminal: ALLOWED_CASE_COUNT, total: ALLOWED_CASE_COUNT },
    retries: completedRows.map(row => ({ originalId: row.caseId, parentRunId: row.parentRunId,
      childRunId: row.runId, status: row.status, reason: row.retryReason,
      outgoingProviderRequests: row.outgoingProviderRequests,
      runEvaluationModelInvocations: row.runEvaluationModelInvocations })),
    outgoingProviderRequests: ledger.calls.length - batchCallsBefore,
    budget: sweepTotals(ledger, ledger.authorization) };
}

const helpText = `Usage: node evaluation/curriculum-retry.mjs [--limit N] [--live]\nDry run is the default; --limit defaults to 1. Live mode requires all 141 first-pass cases to be terminal and admits each retry at three calls/$1.95 under the shared $20/423-call ledger.`;

async function cli() {
  let options;
  try { options = parseRetryArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(helpText); return; }
  const controller = new AbortController();
  const onSigint = () => controller.abort(new DOMException('Retry cancelled by SIGINT.', 'AbortError'));
  if (options.live) process.once('SIGINT', onSigint);
  try {
    const result = await runCurriculumRetry({ ...options, config: options.live ? modelConfig() : undefined,
      signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (result.kind === 'retry' && result.stopReason === 'sigint') process.exitCode = 130;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { if (options.live) process.off('SIGINT', onSigint); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
