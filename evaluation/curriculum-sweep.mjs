import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createModelClient, isModelConfigured, modelConfig } from '../server/model.mjs';
import { loadSuite } from './validate.mjs';
import { runEvaluation } from './run.mjs';
import {
  ALLOWED_CASE_COUNT, CALLS_PER_CASE, SWEEP_LEDGER_PATH, SWEEP_LOCK_PATH,
  SWEEP_QUEUE_PATH, acquireSweepLock, assertLedgerIdle, createBudgetedFetch, saveLedgerAtomic,
  selectPendingCases, sweepTotals, validateLedger, validateLiveAuthorization, validateSweepData,
} from './sweep-budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerFailureCodes = new Set(['MODEL_REQUEST_FAILED', 'MODEL_UNAVAILABLE']);
const infrastructureFailureCodes = new Set([...providerFailureCodes, 'BROWSER_UNAVAILABLE']);

function positiveInteger(value, option) {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${option} must be a positive integer.`);
  return number;
}

export function parseSweepArgs(args) {
  const options = { live: false, limit: 4 };
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

function parseJson(raw, label) {
  try { return JSON.parse(raw); }
  catch { throw new Error(`Sweep refused: ${label} is not valid JSON.`); }
}

export async function readSweepBundle(rootDir = ROOT) {
  const ledgerPath = path.join(rootDir, SWEEP_LEDGER_PATH);
  const queuePath = path.join(rootDir, SWEEP_QUEUE_PATH);
  const [ledgerRaw, queueRaw] = await Promise.all([
    readFile(ledgerPath, 'utf8'), readFile(queuePath, 'utf8'),
  ]);
  const ledger = validateLedger(parseJson(ledgerRaw, 'budget ledger'));
  const queue = parseJson(queueRaw, 'sweep queue');
  const sourceDataset = await loadSuite('curriculum', { rootDir });
  const queueCases = validateSweepData({ authorization: ledger.authorization, queue, queueRaw,
    sourceCases: sourceDataset.cases });
  return { ledgerPath, queuePath, ledger, queue, queueCases, sourceDataset };
}

function reportFromBundle(bundle, limit) {
  const { pending, selected } = selectPendingCases(bundle.queueCases, bundle.ledger, limit);
  const totals = sweepTotals(bundle.ledger, bundle.ledger.authorization);
  return {
    kind: 'dry_run',
    selectedLimit: limit,
    pendingCount: pending.length,
    pendingIds: pending.map(item => item.caseId),
    selected: selected.map(item => ({ id: item.caseId, stage: item.stage, coverage: item.coverage })),
    budget: { ...totals, callCapPerCaseAdmission: CALLS_PER_CASE,
      costReservationPerCaseUSD: Number((CALLS_PER_CASE * bundle.ledger.authorization.reserveUSDPerCall).toFixed(2)) },
    activeRun: bundle.ledger.activeRun !== null,
  };
}

function assertLiveConfig(config) {
  if (!isModelConfigured(config) || config.provider !== 'openrouter' ||
      config.model !== 'anthropic/claude-sonnet-5.5' ||
      config.baseUrl !== 'https://openrouter.ai/api/v1' || !config.apiKey) {
    throw new Error('Live sweep refused: configured model does not match the approved OpenRouter endpoint and model.');
  }
}

function summarizeLedger(ledger, batchRunIds, batchCalls, queueCases) {
  const runs = ledger.runs.filter(run => batchRunIds.has(run.runId));
  const totals = sweepTotals(ledger, ledger.authorization);
  return {
    cases: { completed: runs.filter(run => run.status === 'completed').length,
      failed: runs.filter(run => run.status === 'failed').length,
      cancelled: runs.filter(run => run.status === 'cancelled').length },
    providerCalls: { outgoingRequests: batchCalls,
      runEvaluationModelInvocations: runs.reduce((sum, run) => sum + (run.runEvaluationModelInvocations ?? 0), 0) },
    budget: totals,
    nextPending: selectPendingCases(queueCases, ledger, ALLOWED_CASE_COUNT).pending
      .map(item => ({ id: item.caseId, stage: item.stage })),
  };
}

export async function runSweep({ rootDir = ROOT, live = false, limit = 4, config,
  readBundle = readSweepBundle, runEvaluationFn = runEvaluation, fetchImpl = fetch,
  now = () => new Date().toISOString(), idFactory = randomUUID, signal,
  onProgress = line => console.error(line) } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
  const initial = await readBundle(rootDir);
  validateLiveAuthorization(initial.ledger.authorization);
  const preview = reportFromBundle(initial, limit);
  if (!live) return preview;
  assertLedgerIdle(initial.ledger);
  assertLiveConfig(config ?? modelConfig());

  const batchId = idFactory();
  const lockPath = path.join(rootDir, SWEEP_LOCK_PATH);
  const releaseLock = await acquireSweepLock(lockPath, { runId: batchId, now });
  let ledger;
  let queueCases;
  let sourceDataset;
  let ledgerPath;
  let canFinishCleanly = true;
  let failedInfrastructure = false;
  let stopReason;
  const batchRunIds = new Set();
  let callsBeforeBatch = 0;
  try {
    const current = await readBundle(rootDir);
    ledger = current.ledger;
    queueCases = current.queueCases;
    sourceDataset = current.sourceDataset;
    ledgerPath = current.ledgerPath;
    assertLedgerIdle(ledger);
    const selection = selectPendingCases(queueCases, ledger, limit);
    ledger.activeRun = { runId: batchId, startedAt: now(), selectedCaseIds: selection.selected.map(item => item.caseId) };
    callsBeforeBatch = ledger.calls.length;
    await saveLedgerAtomic(current.ledgerPath, ledger);

    for (let index = 0; index < selection.selected.length; index += 1) {
      if (signal?.aborted) { stopReason = 'sigint'; break; }
      const queued = selection.selected[index];
      const authorization = ledger.authorization;
      const totals = sweepTotals(ledger, authorization);
      const caseReserveUSD = CALLS_PER_CASE * authorization.reserveUSDPerCall;
      if (totals.remainingProviderCalls < CALLS_PER_CASE || totals.remainingUSD < caseReserveUSD) {
        stopReason = 'budget_capacity';
        break;
      }

      const runId = idFactory();
      batchRunIds.add(runId);
      const runRecord = { runId, caseId: queued.caseId, status: 'started', startedAt: now(),
        runEvaluationModelInvocations: 0, outgoingProviderRequests: 0 };
      ledger.runs.push(runRecord);
      ledger.activeRun = { runId: batchId, caseId: queued.caseId, caseRunId: runId, startedAt: ledger.activeRun.startedAt,
        selectedCaseIds: selection.selected.map(item => item.caseId) };
      await saveLedgerAtomic(current.ledgerPath, ledger);
      const beforeCaseCalls = ledger.calls.length;
      const budgetedFetch = createBudgetedFetch({ ledger, ledgerPath: current.ledgerPath, authorization,
        caseId: queued.caseId, runId, fetchImpl, now, idFactory });
      let result;
      try {
        result = await runEvaluationFn({ rootDir, dataset: sourceDataset, suiteName: 'curriculum', live: true,
          maxCalls: CALLS_PER_CASE, modelConfigured: true,
          model: createModelClient(config ?? modelConfig(), budgetedFetch), modelName: authorization.model,
          caseId: queued.caseId, idFactory: () => runId, signal });
      } catch {
        runRecord.status = 'failed';
        runRecord.finishedAt = now();
        runRecord.outgoingProviderRequests = ledger.calls.length - beforeCaseCalls;
        runRecord.safeFailure = 'RUNNER_ERROR';
        ledger.activeRun = { runId: batchId, startedAt: ledger.activeRun.startedAt,
          selectedCaseIds: selection.selected.map(item => item.caseId) };
        await saveLedgerAtomic(current.ledgerPath, ledger);
        failedInfrastructure = true;
        stopReason = 'runner_error';
        onProgress(`case ${index + 1}/${selection.selected.length} ${queued.caseId}: failed; outgoingProviderRequests=${runRecord.outgoingProviderRequests}; runEvaluationModelInvocations=0`);
        break;
      }

      let caseRecord;
      if (result?.kind === 'run') {
        runRecord.runEvaluationModelInvocations = result.manifest?.providerCalls ?? 0;
        runRecord.runDirectory = path.relative(rootDir, result.runDir);
        try { caseRecord = parseJson(await readFile(path.join(result.runDir, 'cases', `${queued.caseId}.json`), 'utf8'), 'case artifact'); }
        catch { caseRecord = null; }
      }
      const outcome = caseRecord?.status;
      const validOutcome = ['cancelled', 'failed', 'completed_generation', 'completed_clarification'].includes(outcome);
      if (!caseRecord || !validOutcome) {
        runRecord.status = 'failed';
        runRecord.safeFailure = caseRecord ? 'INVALID_CASE_ARTIFACT' : 'MISSING_CASE_ARTIFACT';
        failedInfrastructure = true;
        stopReason = 'artifact_persistence_failure';
      } else {
        runRecord.status = outcome === 'cancelled' || result?.manifest?.status === 'cancelled' ? 'cancelled' :
          outcome === 'failed' ? 'failed' : 'completed';
        if (outcome === 'failed') {
          const failureCode = caseRecord.failure?.code;
          runRecord.safeFailure = typeof failureCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failureCode)
            ? failureCode : 'CASE_FAILED';
          if (infrastructureFailureCodes.has(failureCode)) {
            failedInfrastructure = true;
            stopReason = providerFailureCodes.has(failureCode) ? 'provider_failure' : 'infrastructure_failure';
          }
        }
      }
      runRecord.outgoingProviderRequests = ledger.calls.length - beforeCaseCalls;
      runRecord.finishedAt = now();
      ledger.activeRun = { runId: batchId, startedAt: ledger.activeRun.startedAt,
        selectedCaseIds: selection.selected.map(item => item.caseId) };
      await saveLedgerAtomic(current.ledgerPath, ledger);
      const currentTotals = sweepTotals(ledger, authorization);
      onProgress(`case ${index + 1}/${selection.selected.length} ${queued.caseId}: ${runRecord.status}; outgoingProviderRequests=${runRecord.outgoingProviderRequests}; runEvaluationModelInvocations=${runRecord.runEvaluationModelInvocations}; committedUSD=${currentTotals.committedUSD.toFixed(4)}; unknownReservedUSD=${currentTotals.unknownReservedUSD.toFixed(4)}`);
      if (runRecord.status === 'cancelled') { stopReason = signal?.aborted ? 'sigint' : 'case_cancelled'; break; }
      if (ledger.budgetHalt) { stopReason = 'budget_halt'; break; }
      if (failedInfrastructure) { stopReason ??= 'runner_error'; break; }
    }
    if (!stopReason && signal?.aborted) stopReason = 'sigint';
    if (!stopReason && selection.selected.length < selection.pending.length) stopReason = 'batch_limit_reached';
    if (!stopReason) stopReason = 'queue_exhausted';
  } catch (error) {
    canFinishCleanly = false;
    throw error;
  } finally {
    try {
      if (canFinishCleanly && ledger) {
        ledger.activeRun = null;
        await saveLedgerAtomic(ledgerPath, ledger);
      }
    } finally { await releaseLock(); }
  }

  const batchCalls = ledger.calls.length - callsBeforeBatch;
  const status = stopReason === 'sigint' || stopReason === 'case_cancelled' ? 'cancelled' :
    stopReason === 'budget_halt' ? 'budget_halted' :
      stopReason === 'budget_capacity' ? 'capacity_stopped' :
        stopReason === 'provider_failure' ? 'stopped_after_provider_failure' :
          stopReason === 'infrastructure_failure' ? 'stopped_after_infrastructure_failure' :
            stopReason === 'artifact_persistence_failure' ? 'stopped_after_artifact_failure' :
              stopReason === 'runner_error' ? 'stopped_after_runner_error' : 'completed';
  return { kind: 'sweep', status, stopReason, selectedLimit: limit, selectedCount: batchRunIds.size,
    summary: summarizeLedger(ledger, batchRunIds, batchCalls, queueCases) };
}

const helpText = `Usage: node evaluation/curriculum-sweep.mjs [--limit N] [--live]\nDry run is the default; --limit defaults to 4. Live mode uses the approved 141-case queue, 423-request and $20 ledger caps.`;

async function cli() {
  let options;
  try { options = parseSweepArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(helpText); return; }
  const controller = new AbortController();
  const onSigint = () => controller.abort(new DOMException('Sweep cancelled by SIGINT.', 'AbortError'));
  if (options.live) process.once('SIGINT', onSigint);
  try {
    const result = await runSweep({ ...options, config: options.live ? modelConfig() : undefined,
      signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (result.kind === 'sweep' && result.stopReason === 'sigint') process.exitCode = 130;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { if (options.live) process.off('SIGINT', onSigint); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
