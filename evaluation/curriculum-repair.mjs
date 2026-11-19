import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkHtml } from '../server/check.mjs';
import { validateIndependentChecks } from '../server/assessment-probes.mjs';
import { applyRepairPatch, repairSchema, validatePage, validatePlan, validateRepairPatch } from '../server/contracts.mjs';
import { createModelClient, isModelConfigured, modelConfig } from '../server/model.mjs';
import { repairInstructions } from '../server/prompts.mjs';
import { buildRunReport } from './report.mjs';
import { emptyReviewRecord } from './run.mjs';
import { getCurriculumRetryExclusions } from './curriculum-retry.mjs';
import {
  ALLOWED_CASE_COUNT, SWEEP_LEDGER_PATH, SWEEP_LOCK_PATH, acquireSweepLock, assertLedgerIdle,
  createBudgetedFetch, saveLedgerAtomic, sweepTotals, validateLedger, validateLiveAuthorization,
} from './sweep-budget.mjs';
import { readSweepBundle } from './curriculum-sweep.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewDimensions = ['fidelity', 'mathematics', 'playability', 'explanation'];
const reviewChecks = ['correct', 'wrong', 'reset', 'multipleSolutions'];
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function isWithin(parent, candidate) { return candidate.startsWith(`${parent}${path.sep}`); }
function positiveInteger(value, option) {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${option} must be a positive integer.`);
  return number;
}

export function parseRepairArgs(args) {
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

function validateRepairRuns(ledger) {
  if (Object.hasOwn(ledger, 'repairRuns') && !Array.isArray(ledger.repairRuns)) {
    throw new Error('Repair refused: repairRuns must be an array.');
  }
  const repairs = ledger.repairRuns ?? [];
  const ids = new Set();
  const cases = new Set();
  const runIds = new Set(ledger.runs.map(run => run.runId));
  const parentByRun = new Map(ledger.runs.map(run => [run.runId, run]));
  for (const repair of repairs) {
    const parent = parentByRun.get(repair?.parentRunId);
    const expectedKeys = ['caseId', 'finishedAt', 'modelInvocations', 'outgoingProviderRequests', 'parentCaseSha256',
      'parentHtmlSha256', 'parentRunId', 'runDirectory', 'runId', 'startedAt', 'status'];
    const startedKeys = expectedKeys.filter(key => key !== 'finishedAt');
    if (!isObject(repair) || Object.keys(repair).sort().join(',') !==
        (repair.status === 'started' ? startedKeys : expectedKeys).sort().join(',') ||
        !safeId.test(repair.runId ?? '') || ids.has(repair.runId) || runIds.has(repair.runId) ||
        !safeId.test(repair.caseId ?? '') || cases.has(repair.caseId) ||
        !ledger.authorization.allowedCaseIds.includes(repair.caseId) || !parent ||
        !terminalStatuses.has(parent.status) || parent.caseId !== repair.caseId ||
        !['started', ...terminalStatuses].includes(repair.status) ||
        typeof repair.startedAt !== 'string' || !Number.isFinite(Date.parse(repair.startedAt)) ||
        (repair.status === 'started'
          ? repair.finishedAt !== undefined
          : typeof repair.finishedAt !== 'string' || !Number.isFinite(Date.parse(repair.finishedAt))) ||
        repair.runDirectory !== path.join('evaluation', 'runs', repair.runId) ||
        !Number.isSafeInteger(repair.outgoingProviderRequests) || repair.outgoingProviderRequests < 0 || repair.outgoingProviderRequests > 1 ||
        !Number.isSafeInteger(repair.modelInvocations) || repair.modelInvocations < 0 || repair.modelInvocations > 1 ||
        !/^[a-f0-9]{64}$/.test(repair.parentCaseSha256 ?? '') ||
        !/^[a-f0-9]{64}$/.test(repair.parentHtmlSha256 ?? '')) {
      throw new Error('Repair refused: saved repairRuns accounting is malformed.');
    }
    ids.add(repair.runId); cases.add(repair.caseId); runIds.add(repair.runId);
  }
  return repairs;
}

function summarizeFirstPass(bundle) {
  const allowed = new Set(bundle.ledger.authorization.allowedCaseIds);
  const queued = new Set(bundle.queueCases.map(item => item.caseId));
  if (allowed.size !== ALLOWED_CASE_COUNT || queued.size !== ALLOWED_CASE_COUNT ||
      [...allowed].some(id => !queued.has(id)) || bundle.ledger.runs.some(run => !allowed.has(run.caseId))) {
    throw new Error('Repair refused: the approved first-pass case set is inconsistent.');
  }
  const byCase = new Map(bundle.ledger.runs.map(run => [run.caseId, run]));
  const pending = [...allowed].filter(id => !terminalStatuses.has(byCase.get(id)?.status));
  return { terminalCount: ALLOWED_CASE_COUNT - pending.length, pendingIds: pending, complete: pending.length === 0,
    byCase };
}

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}

async function containedFile(root, relative) {
  if (!safeRelative(relative)) throw new Error('Repair refused: saved artifact path is unsafe.');
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, relative);
  if (!candidate.startsWith(`${rootReal}${path.sep}`)) throw new Error('Repair refused: saved artifact path escapes its run.');
  const candidateReal = await realpath(candidate);
  if (!candidateReal.startsWith(`${rootReal}${path.sep}`)) throw new Error('Repair refused: saved artifact path escapes its run.');
  return candidateReal;
}

async function jsonFile(filePath, label) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch { throw new Error(`Repair refused: ${label} is unreadable.`); }
}

function reviewCells(review) {
  if (!isObject(review) || review.schemaVersion !== 1 || !isObject(review.dimensions) ||
      !isObject(review.checklist) || Object.keys(review.dimensions).sort().join(',') !== reviewDimensions.slice().sort().join(',') ||
      Object.keys(review.checklist).sort().join(',') !== reviewChecks.slice().sort().join(',') ||
      Object.keys(review).sort().join(',') !== ['checklist', 'dimensions', 'expectedBehavior', 'schemaVersion'].sort().join(',')) return null;
  const cells = [...reviewDimensions.map(key => [`dimensions.${key}`, review.dimensions[key]]),
    ...reviewChecks.map(key => [`checklist.${key}`, review.checklist[key]]), ['expectedBehavior', review.expectedBehavior]];
  if (cells.some(([, cell]) => !isObject(cell) || Object.keys(cell).sort().join(',') !== 'evidence,reviewer,status' ||
      !['unreviewed', 'passed', 'failed', 'not_applicable'].includes(cell.status) ||
      typeof cell.reviewer !== 'string' || typeof cell.evidence !== 'string' ||
      (cell.status !== 'unreviewed' && (!cell.reviewer.trim() || !cell.evidence.trim())))) return null;
  return cells.filter(([, cell]) => cell.status === 'failed');
}

function activityPlan(plan) {
  const copy = structuredClone(plan);
  delete copy.explanation;
  return copy;
}

function buildRepairInput(candidate) {
  const failures = candidate.failedCells.map(([name, cell]) => `${name}: ${cell.evidence.trim()}`);
  const input = {
    originalProblem: candidate.source.problem,
    plan: activityPlan(candidate.plan),
    html: candidate.html,
    runtimeErrors: [
      'Independent reviewer findings from the saved first-pass review; these are not browser runtime diagnostics.',
      ...failures,
    ],
  };
  if (candidate.assessment) {
    input.assessment = structuredClone(candidate.assessment);
    input.playtest = structuredClone(candidate.playtest);
  }
  return input;
}

function requestFitsAuthorization(input, authorization) {
  const body = {
    model: authorization.model, instructions: repairInstructions, input: JSON.stringify(input), store: false,
    max_output_tokens: 6000,
    text: { format: { type: 'json_schema', name: 'repaired_exercise', schema: repairSchema, strict: true } },
    stream: false, provider: { require_parameters: true, max_price: {
      prompt: authorization.providerMaxPricePerMillion.prompt,
      completion: authorization.providerMaxPricePerMillion.completion,
    } },
    reasoning: { effort: 'medium' },
  };
  return Buffer.byteLength(JSON.stringify(body), 'utf8') <= authorization.maxRequestBytes;
}

async function loadCandidate(bundle, queueCase, parentRun) {
  const rootDir = path.resolve(bundle.rootDir);
  const sourceData = queueCase.source ?? queueCase;
  const caseId = queueCase.caseId ?? sourceData.id;
  const sourceProblem = queueCase.problem ?? sourceData.problem;
  if (sourceData.id !== undefined && sourceData.id !== caseId || sourceData.problem !== sourceProblem) return null;
  const source = { ...sourceData, caseId };
  const runRelative = parentRun.runDirectory;
  if (!safeId.test(parentRun.runId ?? '') ||
      runRelative !== path.join('evaluation', 'runs', parentRun.runId)) return null;
  const runsRoot = path.join(rootDir, 'evaluation', 'runs');
  let runDir;
  try {
    const rootReal = await realpath(rootDir);
    const runsRootReal = await realpath(runsRoot);
    if (!isWithin(rootReal, runsRootReal)) return null;
    runDir = await containedFile(runsRoot, parentRun.runId);
    if (!isWithin(runsRootReal, await realpath(runDir))) return null;
  } catch { return null; }

  let manifest;
  try { manifest = await jsonFile(await containedFile(runDir, 'manifest.json'), 'parent manifest'); }
  catch { return null; }
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || manifest.runId !== parentRun.runId ||
      manifest.suite !== 'curriculum' || manifest.evidenceClass !== 'live' || manifest.status !== 'completed') return null;
  const caseRelative = path.join('cases', `${caseId}.json`);
  if (!Array.isArray(manifest.caseArtifactFiles) || !manifest.caseArtifactFiles.includes(caseRelative)) return null;
  for (const relative of manifest.caseArtifactFiles) {
    try { await containedFile(runDir, relative); }
    catch { return null; }
  }
  let casePath;
  try { casePath = await containedFile(runDir, caseRelative); }
  catch { return null; }
  let record;
  let caseBytes;
  try { caseBytes = await readFile(casePath); record = JSON.parse(caseBytes.toString('utf8')); }
  catch { return null; }
  if (!isObject(record) || record.id !== caseId || record.suite !== 'curriculum' ||
      record.attempted !== true || record.originalCase?.id !== caseId ||
      record.originalCase?.problem !== sourceProblem || record.originalInput?.problem !== sourceProblem ||
      record.expectedBehavior !== source.expected_behavior || !Array.isArray(record.htmlFiles) ||
      !record.htmlFiles.length || !['playable_exercise', 'repaired_exercise'].includes(record.latestGeneratedAttempt)) return null;

  const completed = parentRun.status === 'completed' && record.status === 'completed_generation' &&
    record.result?.type === 'result' && isObject(record.result.game);
  const runtimeFailure = parentRun.status === 'failed' && record.status === 'failed' &&
    record.failure?.code === 'RUNTIME_CHECK_FAILED' && !record.result?.game;
  const invalidAutomaticRepair = parentRun.status === 'failed' && record.status === 'failed' &&
    record.failure?.code === 'INVALID_MODEL_OUTPUT' && record.repairCount === 1 && !record.result?.game &&
    record.runtimeChecks?.some(item => item?.attempt === 0 && item.passed === false) &&
    !record.runtimeChecks?.some(item => item?.attempt === 1) &&
    record.diagnostics?.some(item => item?.type === 'model_call' && item.name === 'repaired_exercise' &&
      item.outcome === 'completed');
  if (!completed && !runtimeFailure && !invalidAutomaticRepair) return null;

  const failedCells = reviewCells(record.review);
  if (!failedCells?.length) return null;
  let report;
  try { report = await buildRunReport(runDir); }
  catch { return null; }
  if (report.review?.malformedRecords !== 0 || report.mathematical?.fullSuccess?.failedReview !== 1) return null;

  const planEntry = record.validatedContracts?.find(item => item?.requestName === 'play_plan' && item.plan);
  if (!planEntry) return null;
  let plan;
  try { plan = validatePlan(planEntry.plan, { requireAssessment: Object.hasOwn(planEntry.plan, 'assessment') }); }
  catch { return null; }
  if (plan.status !== 'ready') return null;
  const assessment = Object.hasOwn(plan, 'assessment') ? structuredClone(plan.assessment) : undefined;
  let playtest;
  if (assessment) {
    const pageContracts = record.validatedContracts?.filter(item => item?.requestName === 'playable_exercise') ?? [];
    if (pageContracts.length !== 1 || pageContracts[0].status !== 'ready' ||
        !Object.hasOwn(pageContracts[0], 'playtest') || pageContracts[0].playtest === null) return null;
    playtest = structuredClone(pageContracts[0].playtest);
    if (completed && (!record.result.game.assessment || !isDeepStrictEqual(record.result.game.assessment, assessment))) return null;
    if (record.result?.game?.assessment !== undefined && !isDeepStrictEqual(record.result.game.assessment, assessment)) return null;
  }

  const htmlRelative = record.htmlFiles.at(-1);
  if (path.basename(htmlRelative ?? '') !== `${caseId}-${record.latestGeneratedAttempt}.html`) return null;
  let htmlPath;
  let htmlBytes;
  let html;
  try {
    htmlPath = await containedFile(runDir, htmlRelative);
    htmlBytes = await readFile(htmlPath);
    html = htmlBytes.toString('utf8');
    if (!Buffer.from(html, 'utf8').equals(htmlBytes)) return null;
    const page = { status: 'ready', issue: null, html };
    if (assessment) page.playtest = playtest;
    validatePage(page, { requirePlaytest: Boolean(assessment) });
  } catch { return null; }

  const candidate = { source, parentRun, runDir, record, caseBytes, htmlBytes, html, plan, assessment, playtest,
    failedCells, parentCaseSha256: sha256(caseBytes), parentHtmlSha256: sha256(htmlBytes) };
  candidate.input = buildRepairInput(candidate);
  if (!requestFitsAuthorization(candidate.input, bundle.ledger.authorization)) return null;
  return candidate;
}

async function eligibleCases(bundle) {
  const repairs = validateRepairRuns(bundle.ledger);
  const attempted = new Set(repairs.map(item => item.caseId));
  const first = summarizeFirstPass(bundle);
  if (!first.complete) return { first, eligible: [], skippedPrior: attempted.size };
  const retryExclusions = await getCurriculumRetryExclusions({ rootDir: bundle.rootDir, bundle });
  const eligible = [];
  for (const item of bundle.queueCases) {
    if (attempted.has(item.caseId) || retryExclusions.has(item.caseId)) continue;
    const parent = first.byCase.get(item.caseId);
    const candidate = await loadCandidate(bundle, item, parent);
    if (candidate) eligible.push(candidate);
  }
  return { first, eligible, skippedPrior: attempted.size };
}

function liveConfig(config) {
  const selected = config ?? modelConfig();
  if (!isModelConfigured(selected) || selected.provider !== 'openrouter' ||
      selected.model !== 'anthropic/claude-sonnet-5.5' ||
      selected.baseUrl !== 'https://openrouter.ai/api/v1') {
    throw new Error('Live repair refused: configured model does not match the approved OpenRouter endpoint and model.');
  }
  return selected;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, filePath); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

function gameFromPlan(plan, problem, html, id, independentChecks) {
  const game = { id, title: plan.title, problem, html, topics: plan.topics, objective: plan.objective,
    activityType: plan.activityType, requiresReview: plan.requiresReview, referenceAnswer: plan.referenceAnswer,
    explanation: plan.explanation, repairCount: 1,
    verification: { runtime: 'passed', mathematics: 'not_independently_verified' } };
  if (plan.assessment) {
    game.assessment = structuredClone(plan.assessment);
    game.verification.playthrough = 'passed';
    game.verification.independentChecks = structuredClone(independentChecks);
  }
  return game;
}

function childArtifacts(candidate, runId, authorization, now) {
  const source = candidate.source;
  const record = {
    schemaVersion: 1, id: source.caseId, status: 'running', attempted: true, suite: 'curriculum',
    coverage: source.coverage, stage: source.stage, split: source.split ?? 'development',
    expectedBehavior: source.expected_behavior, modelIdentifier: authorization.model,
    originalCase: structuredClone(candidate.record.originalCase), originalInput: { problem: source.problem },
    reference: structuredClone(candidate.record.reference), diagnostics: [], runtimeChecks: [],
    providerCalls: 0, modelInvocations: 0, callLimitRefusals: 0, repairCount: 0, htmlFiles: [],
    validatedContracts: [{ requestName: 'play_plan', plan: structuredClone(candidate.plan) }],
    ...(candidate.assessment ? { inheritedPlaytest: structuredClone(candidate.playtest) } : {}),
    review: emptyReviewRecord(), firstAttemptReview: structuredClone(candidate.record.review),
    firstAttemptReviewProvenance: { source: 'saved independent review of parent page', parentRunId: candidate.parentRun.runId,
      parentCaseSha256: candidate.parentCaseSha256, parentHtmlSha256: candidate.parentHtmlSha256 },
    reviewerTriggeredRepair: true, parentRunId: candidate.parentRun.runId,
    parentCaseSha256: candidate.parentCaseSha256, parentHtmlSha256: candidate.parentHtmlSha256,
    startedAt: now(), latestGeneratedAttempt: null,
  };
  const manifest = {
    schemaVersion: 1, runId, status: 'started', evidenceClass: 'live', suite: 'curriculum',
    reviewerTriggeredRepair: true, parentRunId: candidate.parentRun.runId,
    purpose: 'One bounded reviewer-triggered repair; reuses the original question and validated plan.',
    createdAt: now(), finishedAt: null, modelIdentifier: authorization.model, live: true,
    maxCalls: 1, plannedCount: 1, selectedCount: 1, attemptedCount: 0, completedGenerationCount: 0,
    unrunCount: 1, providerCalls: 0, modelInvocations: 0, outgoingProviderRequests: 0, callLimitRefusals: 0,
    repairAttempts: 0, errorCount: 0, caseArtifactFiles: [`cases/${source.caseId}.json`],
    selectedCases: [{ id: source.caseId, coverage: source.coverage, stage: source.stage,
      split: source.split ?? 'development', expectedBehavior: source.expected_behavior }],
    sourceHashes: { parentCaseSha256: candidate.parentCaseSha256, parentHtmlSha256: candidate.parentHtmlSha256 },
  };
  return { record, manifest };
}

async function saveChild(runDir, record, manifest) {
  manifest.attemptedCount = record.attempted ? 1 : 0;
  manifest.completedGenerationCount = record.status === 'completed_generation' ? 1 : 0;
  manifest.unrunCount = manifest.selectedCount - manifest.attemptedCount;
  manifest.errorCount = ['failed', 'cancelled'].includes(record.status) ? 1 : 0;
  manifest.providerCalls = record.providerCalls;
  manifest.modelInvocations = record.modelInvocations ?? 0;
  manifest.repairAttempts = record.repairCount;
  await writeJsonAtomic(path.join(runDir, 'cases', `${record.id}.json`), record);
  await writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest);
}

function setFailure(record, code) {
  record.status = 'failed';
  record.failure = { code, message: code === 'PLAN_CONFLICT'
    ? 'The saved plan and page could not be reconciled safely.'
    : code === 'RUNTIME_CHECK_FAILED' ? 'The repaired page did not pass runtime checks.'
      : 'The repair attempt did not produce a usable page.' };
}

async function repairOne({ rootDir, bundle, candidate, runId, batchId, config, fetchImpl, checkFn, writeHtmlFn,
  now, idFactory, signal, onProgress }) {
  const ledger = bundle.ledger;
  const ledgerPath = bundle.ledgerPath;
  const authorization = ledger.authorization;
  const row = { parentRunId: candidate.parentRun.runId, runId, caseId: candidate.source.caseId,
    status: 'started', startedAt: now(), runDirectory: path.join('evaluation', 'runs', runId),
    outgoingProviderRequests: 0, modelInvocations: 0,
    parentCaseSha256: candidate.parentCaseSha256, parentHtmlSha256: candidate.parentHtmlSha256 };
  ledger.repairRuns.push(row);
  ledger.activeRun = { runId: batchId, purpose: 'reviewer-triggered-repair', startedAt: ledger.activeRun.startedAt,
    caseId: row.caseId, repairRunId: runId };
  validateRepairRuns(ledger);
  await saveLedgerAtomic(ledgerPath, ledger);

  const runDir = path.join(rootDir, row.runDirectory);
  const { record, manifest } = childArtifacts(candidate, runId, authorization, now);
  let beforeCalls = ledger.calls.length;
  let infraError = null;
  let phase = 'artifacts';
  let artifactDirectoryReady = false;
  const writeCurrent = async () => saveChild(runDir, record, manifest);
  try {
    await mkdir(runDir);
    await mkdir(path.join(runDir, 'cases'), { recursive: false });
    await mkdir(path.join(runDir, 'html'));
    artifactDirectoryReady = true;
    await writeCurrent();
    if (signal?.aborted) throw signal.reason ?? new DOMException('Repair cancelled.', 'AbortError');

    const budgetedFetch = createBudgetedFetch({ ledger, ledgerPath, authorization, caseId: row.caseId,
      runId, fetchImpl, now, idFactory });
    const model = createModelClient(config, budgetedFetch);
    row.modelInvocations = 1;
    record.modelInvocations = 1;
    record.repairCount = 1;
    manifest.repairAttempts = 1;
    await saveLedgerAtomic(ledgerPath, ledger);
    await writeCurrent();

    phase = 'model';
    const response = await model.complete({ name: 'repaired_exercise', instructions: repairInstructions,
      input: candidate.input, schema: repairSchema, signal });
    record.diagnostics.push({ type: 'model_call', name: 'repaired_exercise', usage: response.usage ?? null });
    record.proposedRepairPatch = structuredClone(response.value);
    let patch;
    try { patch = validateRepairPatch(response.value); }
    catch { setFailure(record, 'INVALID_MODEL_OUTPUT'); }
    if (patch?.status === 'conflict') {
      record.validatedContracts.push({ requestName: 'repaired_exercise', status: patch.status,
        issue: patch.issue, edits: [] });
      setFailure(record, 'PLAN_CONFLICT');
    } else if (patch?.status === 'ready') {
      record.validatedContracts.push({ requestName: 'repaired_exercise', status: patch.status,
        issue: patch.issue, edits: structuredClone(patch.edits) });
      let repairedHtml;
      try { repairedHtml = applyRepairPatch(candidate.html, patch); }
      catch { setFailure(record, 'INVALID_MODEL_OUTPUT'); }
      if (repairedHtml !== undefined) {
        const htmlName = `${record.id}-repaired_exercise.html`;
        phase = 'artifacts';
        await writeHtmlFn(path.join(runDir, 'html', htmlName), repairedHtml, { flag: 'wx' });
        record.htmlFiles.push(`html/${htmlName}`);
        record.latestGeneratedAttempt = 'repaired_exercise';
        phase = 'check';
        const runtimeOptions = { attempt: 1, signal };
        if (candidate.assessment) {
          runtimeOptions.assessment = structuredClone(candidate.assessment);
          runtimeOptions.playtest = structuredClone(candidate.playtest);
        }
        const runtime = await checkFn(repairedHtml, runtimeOptions);
        const errors = Array.isArray(runtime?.errors) ? runtime.errors : [];
        const playthroughPassed = !candidate.assessment || runtime?.playthrough === 'passed';
        const coverageValid = !candidate.assessment || validateIndependentChecks(runtime?.independentChecks,
          candidate.assessment);
        const passed = runtime?.passed === true && playthroughPassed && coverageValid;
        if (!coverageValid) errors.push('The independent assessment field checks did not report valid coverage.');
        if (!passed && candidate.assessment && !errors.length) errors.push('The complete learner playthrough did not pass.');
        const check = { type: 'runtime_check', attempt: 1, passed, errors,
          ...(candidate.assessment ? { playthrough: playthroughPassed ? 'passed' : 'failed',
            ...(coverageValid ? { independentChecks: structuredClone(runtime.independentChecks) } : {}) } : {}) };
        record.runtimeChecks.push(check);
        record.diagnostics.push(check);
        if (check.passed) {
          record.status = 'completed_generation';
          const game = gameFromPlan(candidate.plan, candidate.source.problem, repairedHtml, idFactory(), check.independentChecks);
          delete game.html;
          record.result = { type: 'result', game };
        } else setFailure(record, 'RUNTIME_CHECK_FAILED');
      }
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      record.status = 'cancelled';
      record.failure = { code: 'CANCELLED', message: 'Repair stopped by cancellation.' };
    } else if (error?.code === 'EVALUATION_CALL_CAP' || ledger.budgetHalt) {
      setFailure(record, 'EVALUATION_CALL_CAP');
    } else if (phase === 'model') {
      const known = new Set(['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE', 'NOT_CONFIGURED',
        'INVALID_MODEL_OUTPUT', 'INCOMPLETE_MODEL_OUTPUT', 'MODEL_REFUSAL', 'PLAN_CONFLICT']);
      const failureCode = known.has(error?.code) ? error.code : 'MODEL_UNAVAILABLE';
      setFailure(record, failureCode);
      if (['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE', 'NOT_CONFIGURED'].includes(failureCode)) {
        const message = failureCode === 'MODEL_REQUEST_FAILED' ? 'The model service could not complete the request.' :
          failureCode === 'NOT_CONFIGURED' ? 'Model configuration is missing.' : 'The model service could not be reached.';
        infraError = Object.assign(new Error(message), { code: failureCode });
      }
    } else {
      infraError = error;
      setFailure(record, 'REPAIR_INFRASTRUCTURE_ERROR');
    }
    if (row.modelInvocations && error?.usage) record.pendingModelUsage = error.usage;
  }

  row.outgoingProviderRequests = ledger.calls.length - beforeCalls;
  record.providerCalls = row.outgoingProviderRequests;
  if (row.modelInvocations && row.outgoingProviderRequests &&
      !record.diagnostics.some(item => item.type === 'model_call')) {
    record.diagnostics.push({ type: 'model_call', name: 'repaired_exercise', usage: record.pendingModelUsage ?? null });
  }
  delete record.pendingModelUsage;
  if (record.status === 'running') setFailure(record, 'INVALID_MODEL_OUTPUT');
  record.finishedAt = now();
  manifest.finishedAt = record.finishedAt;
  manifest.status = record.status === 'completed_generation' ? 'completed' : record.status;
  manifest.outgoingProviderRequests = row.outgoingProviderRequests;
  row.status = record.status === 'completed_generation' ? 'completed' : record.status;
  row.finishedAt = record.finishedAt;
  validateRepairRuns(ledger);
  if (artifactDirectoryReady) await writeCurrent();
  await saveLedgerAtomic(ledgerPath, ledger);
  onProgress?.({ id: row.caseId, status: row.status, outgoingProviderRequests: row.outgoingProviderRequests,
    modelInvocations: row.modelInvocations });
  return { row, infraError };
}

function preview(bundle, eligible, limit) {
  const totals = sweepTotals(bundle.ledger, bundle.ledger.authorization);
  const blocked = [];
  if (!eligible.first.complete) blocked.push('first_pass_incomplete');
  if (bundle.ledger.activeRun !== null) blocked.push('active_run');
  if (bundle.ledger.budgetHalt) blocked.push('budget_halt');
  if (bundle.ledger.calls.some(call => call.status === 'pending') ||
      bundle.ledger.runs.some(run => run.status === 'started')) blocked.push('incomplete_ledger_record');
  if (validateRepairRuns(bundle.ledger).some(run => run.status === 'started')) blocked.push('unfinished_repair');
  const canInspect = eligible.first.complete && blocked.length === 0;
  const cases = canInspect ? eligible.eligible : [];
  return { kind: 'dry_run', status: blocked.length ? 'blocked' : cases.length ? 'ready' : 'nothing_to_repair',
    selectedLimit: limit, firstPass: { terminal: eligible.first.terminalCount, total: ALLOWED_CASE_COUNT,
      pendingIds: eligible.first.pendingIds }, eligibleCount: cases.length,
    selected: cases.slice(0, limit).map(item => ({ id: item.source.caseId, parentRunId: item.parentRun.runId,
      parentStatus: item.record.status, failedReviewCells: item.failedCells.map(([key]) => key) })),
    skippedPriorRepairs: eligible.skippedPrior, blocked,
    budget: { ...totals, admissionCalls: 1, admissionCostUSD: bundle.ledger.authorization.reserveUSDPerCall } };
}

export async function runCurriculumRepair({ rootDir = ROOT, live = false, limit = 1, config,
  readBundle = readSweepBundle, fetchImpl = fetch, checkFn = checkHtml,
  writeHtmlFn = (filePath, html, options) => writeFile(filePath, html, options),
  now = () => new Date().toISOString(), idFactory = randomUUID, signal,
  onProgress = item => console.error(item) } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
  rootDir = path.resolve(rootDir);
  const initial = await readBundle(rootDir);
  validateLedger(initial.ledger);
  validateLiveAuthorization(initial.ledger.authorization);
  if (path.resolve(initial.ledgerPath) !== path.resolve(rootDir, SWEEP_LEDGER_PATH)) {
    throw new Error('Repair refused: ledger path is outside the approved root.');
  }
  const rootReal = await realpath(rootDir);
  const ledgerReal = await realpath(initial.ledgerPath);
  const ledgerDirectoryReal = await realpath(path.dirname(initial.ledgerPath));
  if (!isWithin(rootReal, ledgerReal) || !isWithin(rootReal, ledgerDirectoryReal)) {
    throw new Error('Repair refused: ledger resolves outside the approved root.');
  }
  const initialEligible = await eligibleCases({ ...initial, rootDir });
  const dry = preview({ ...initial, rootDir }, initialEligible, limit);
  if (!live) return dry;

  if (!initialEligible.first.complete) {
    throw new Error(`Live repair refused: first-pass breadth is incomplete (${initialEligible.first.terminalCount}/${ALLOWED_CASE_COUNT} terminal).`);
  }
  assertLedgerIdle(initial.ledger);
  if (initial.ledger.repairRuns?.some(item => item.status === 'started')) {
    throw new Error('Live repair refused: an unfinished repair requires manual review.');
  }
  if (!initialEligible.eligible.length) {
    return { kind: 'repair', status: 'nothing_to_repair', stopReason: 'no_eligible_cases', selectedCount: 0,
      summary: { budget: sweepTotals(initial.ledger), repairRuns: initial.ledger.repairRuns?.length ?? 0 } };
  }
  const firstTotals = sweepTotals(initial.ledger);
  if (firstTotals.remainingProviderCalls < 1 || firstTotals.remainingUSD < initial.ledger.authorization.reserveUSDPerCall) {
    return { kind: 'repair', status: 'capacity_stopped', stopReason: 'budget_capacity', selectedCount: 0,
      summary: { budget: firstTotals } };
  }
  const configValue = liveConfig(config);

  const batchId = idFactory();
  if (!safeId.test(batchId ?? '') || initial.ledger.runs.some(run => run.runId === batchId) ||
      (initial.ledger.repairRuns ?? []).some(run => run.runId === batchId)) {
    throw new Error('Live repair refused: generated batch ID is invalid or already used.');
  }
  const lockPath = path.resolve(rootDir, SWEEP_LOCK_PATH);
  const lockDirectoryReal = await realpath(path.dirname(lockPath));
  if (!isWithin(rootReal, lockDirectoryReal)) throw new Error('Live repair refused: lock path resolves outside the approved root.');
  const releaseLock = await acquireSweepLock(lockPath, { runId: batchId, now });
  let ledger;
  let ledgerPath;
  let stopReason;
  let infraError = null;
  const completed = [];
  const batchCallsBefore = initial.ledger.calls.length;
  let cleanFinalize = false;
  try {
    const current = await readBundle(rootDir);
    ledger = current.ledger;
    ledgerPath = current.ledgerPath;
    validateLedger(ledger);
    validateLiveAuthorization(ledger.authorization);
    if (path.resolve(ledgerPath) !== path.resolve(rootDir, SWEEP_LEDGER_PATH)) throw new Error('Repair refused: ledger path changed.');
    assertLedgerIdle(ledger);
    if (ledger.repairRuns?.some(item => item.status === 'started')) throw new Error('Live repair refused: an unfinished repair requires manual review.');
    const selection = await eligibleCases({ ...current, rootDir });
    if (!selection.first.complete) throw new Error('Live repair refused: first-pass breadth became incomplete before lock acquisition.');
    const selected = selection.eligible.slice(0, limit);
    if (!selected.length) {
      cleanFinalize = true;
      return { kind: 'repair', status: 'nothing_to_repair', stopReason: 'no_eligible_cases', selectedCount: 0,
        summary: { budget: sweepTotals(ledger), repairRuns: ledger.repairRuns?.length ?? 0 } };
    }
    ledger.repairRuns ??= [];
    ledger.activeRun = { runId: batchId, purpose: 'reviewer-triggered-repair', startedAt: now(),
      selectedCaseIds: selected.map(item => item.source.caseId) };
    await saveLedgerAtomic(ledgerPath, ledger);

    for (const candidate of selected) {
      if (signal?.aborted) { stopReason = 'sigint'; break; }
      const totals = sweepTotals(ledger);
      if (totals.remainingProviderCalls < 1 || totals.remainingUSD < ledger.authorization.reserveUSDPerCall) {
        stopReason = 'budget_capacity'; break;
      }
      if (ledger.budgetHalt) { stopReason = 'budget_halt'; break; }
      const runId = idFactory();
      if (!safeId.test(runId ?? '') || ledger.runs.some(run => run.runId === runId) ||
          ledger.repairRuns.some(run => run.runId === runId) || runId === batchId) {
        infraError = new Error('Generated repair run ID is invalid or already used.');
        stopReason = 'infrastructure_error';
        break;
      }
      const result = await repairOne({ rootDir, bundle: { ...current, ledger, ledgerPath }, candidate, runId,
        batchId, config: configValue, fetchImpl, checkFn, writeHtmlFn, now, idFactory, signal, onProgress });
      completed.push(result.row);
      if (result.infraError) { infraError = result.infraError; stopReason = 'infrastructure_error'; break; }
      if (signal?.aborted || result.row.status === 'cancelled') { stopReason = 'sigint'; break; }
      if (ledger.budgetHalt) { stopReason = 'budget_halt'; break; }
      if (result.row.outgoingProviderRequests === 0 && result.row.modelInvocations > 0 &&
          ledger.calls.length === batchCallsBefore) { stopReason = 'budget_capacity'; break; }
    }
    if (!stopReason) stopReason = selected.length < selection.eligible.length ? 'limit_reached' : 'eligible_cases_exhausted';
    ledger.activeRun = null;
    await saveLedgerAtomic(ledgerPath, ledger);
    cleanFinalize = true;
  } finally {
    try {
      if (!cleanFinalize && ledger && ledgerPath) {
        // Keep activeRun set so a restart fails closed if final accounting was interrupted.
        await saveLedgerAtomic(ledgerPath, ledger).catch(() => {});
      }
    } finally { await releaseLock(); }
  }
  if (infraError) onProgress?.({ status: 'stopped_after_infrastructure_error', message: infraError.message });
  const status = stopReason === 'sigint' ? 'cancelled' : stopReason === 'budget_halt' ? 'budget_halted' :
    stopReason === 'budget_capacity' ? 'capacity_stopped' : stopReason === 'infrastructure_error' ? 'stopped_after_infrastructure_error' : 'completed';
  return { kind: 'repair', status, stopReason, selectedCount: completed.length,
    summary: { repairRuns: completed.map(item => ({ caseId: item.caseId, runId: item.runId, status: item.status,
      outgoingProviderRequests: item.outgoingProviderRequests, modelInvocations: item.modelInvocations })),
      budget: sweepTotals(ledger), outgoingProviderRequests: ledger.calls.length - batchCallsBefore } };
}

const helpText = `Usage: node evaluation/curriculum-repair.mjs [--limit N] [--live]\nDry run is the default; --limit defaults to 1. Live mode requires all 141 first-pass runs to be terminal and uses one shared-budget request per eligible reviewed failure.`;

async function cli() {
  let options;
  try { options = parseRepairArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(helpText); return; }
  const controller = new AbortController();
  const onSigint = () => controller.abort(new DOMException('Repair cancelled by SIGINT.', 'AbortError'));
  if (options.live) process.once('SIGINT', onSigint);
  try {
    const result = await runCurriculumRepair({ ...options, signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (result.kind === 'repair' && result.stopReason === 'sigint') process.exitCode = 130;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { if (options.live) process.off('SIGINT', onSigint); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
