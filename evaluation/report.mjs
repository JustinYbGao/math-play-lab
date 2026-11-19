import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const reviewStatuses = new Set(['unreviewed', 'passed', 'failed', 'not_applicable']);
const dimensionKeys = ['fidelity', 'mathematics', 'playability', 'explanation'];
const checklistKeys = ['correct', 'wrong', 'reset', 'multipleSolutions'];

async function readJson(filePath) { return JSON.parse(await readFile(filePath, 'utf8')); }

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validReviewCell(value) {
  if (!exactKeys(value, ['status', 'reviewer', 'evidence']) || !reviewStatuses.has(value.status) ||
      typeof value.reviewer !== 'string' || typeof value.evidence !== 'string') return false;
  return value.status === 'unreviewed' || Boolean(value.reviewer.trim() && value.evidence.trim());
}

function validateReview(review) {
  if (!exactKeys(review, ['schemaVersion', 'dimensions', 'checklist', 'expectedBehavior']) || review.schemaVersion !== 1 ||
      !exactKeys(review.dimensions, dimensionKeys) || !exactKeys(review.checklist, checklistKeys)) return false;
  return [...dimensionKeys.map(key => review.dimensions[key]), ...checklistKeys.map(key => review.checklist[key]),
    review.expectedBehavior].every(validReviewCell);
}

function independentMathPass(record, review, reviewValid, runtimePassed) {
  return record.status === 'completed_generation' && runtimePassed && record.htmlFiles?.length > 0 && reviewValid &&
    dimensionKeys.every(key => review.dimensions[key].status === 'passed') &&
    ['correct', 'wrong', 'reset'].every(key => review.checklist[key].status === 'passed') &&
    ['passed', 'not_applicable'].includes(review.checklist.multipleSolutions.status) &&
    review.expectedBehavior.status === 'passed';
}

function reviewState(review, valid) {
  if (!valid) return { unreviewed: true, failed: false };
  const cells = [...dimensionKeys.map(key => review.dimensions[key]),
    ...checklistKeys.map(key => review.checklist[key]), review.expectedBehavior];
  return { unreviewed: cells.some(cell => cell.status === 'unreviewed'),
    failed: cells.some(cell => cell.status === 'failed') };
}

function addGroup(groups, key, pass, unreviewed) {
  if (!key) return;
  const value = groups[key] ??= { denominator: 0, passed: 0, unreviewed: 0 };
  value.denominator++;
  if (pass) value.passed++;
  if (unreviewed) value.unreviewed++;
}

function rate(passed, denominator) { return denominator ? passed / denominator : null; }

export async function buildRunReport(runDir) {
  const absoluteRunDir = path.resolve(runDir);
  const manifest = await readJson(path.join(absoluteRunDir, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.caseArtifactFiles)) {
    throw new Error('Run manifest is malformed.');
  }
  const records = [];
  for (const relative of manifest.caseArtifactFiles) {
    if (typeof relative !== 'string' || relative.startsWith('/') || relative.split(/[\\/]/).includes('..')) {
      throw new Error('Run manifest contains an unsafe artifact path.');
    }
    records.push(await readJson(path.join(absoluteRunDir, relative)));
  }
  const attempted = records.filter(record => record.attempted === true);
  const interactive = attempted.filter(record => ['interactive', 'interactive_reasoning'].includes(record.expectedBehavior));
  const clarifications = attempted.filter(record => record.expectedBehavior === 'clarification');
  const malformedReviewIds = new Set();
  const fullSuccess = {
    firstAttempt: { passed: 0, denominator: interactive.length, unreviewed: 0, failedReview: 0 },
    afterRepair: { passed: 0, denominator: interactive.length, unreviewed: 0, failedReview: 0 },
  };
  let clarificationPassCount = 0;
  let clarificationUnreviewed = 0;
  const runtime = { firstAttempt: { passed: 0, denominator: 0 }, afterRepair: { passed: 0, denominator: 0 } };
  const tokenUsage = { knownCalls: 0, unknownUsageCalls: 0, observedCost: 0, callsWithObservedCost: 0,
    fields: Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens'].map(key => [key, { total: 0, measuredCalls: 0 }])) };
  let repairCalls = 0;
  let callLimitRefusals = 0;
  const stageGroups = {};
  const coverageGroups = {};
  const errors = [];

  for (const record of records) {
    const reviewValid = validateReview(record.review);
    if (!reviewValid) malformedReviewIds.add(`${record.id}:final`);
    const review = record.review;
    if (interactive.includes(record)) {
      const initialReview = record.firstAttemptReview ??
        (record.latestGeneratedAttempt === 'playable_exercise' ? review : null);
      const initialValid = initialReview ? validateReview(initialReview) : false;
      if (record.firstAttemptReview && !initialValid) malformedReviewIds.add(`${record.id}:initial`);
      const initialRuntimeCheck = (record.runtimeChecks ?? []).find(item => item.attempt === 0);
      const repairRuntimeCheck = (record.runtimeChecks ?? []).find(item => item.attempt === 1);
      const finalRuntimePassed = repairRuntimeCheck ? repairRuntimeCheck.passed === true : initialRuntimeCheck?.passed === true;
      const first = record.repairCount === 0 && record.latestGeneratedAttempt === 'playable_exercise' &&
        independentMathPass(record, review, reviewValid, initialRuntimeCheck?.passed === true);
      const after = independentMathPass(record, review, reviewValid, finalRuntimePassed);

      for (const [key, pass, value, valid] of [
        ['firstAttempt', first, initialReview, initialValid], ['afterRepair', after, review, reviewValid],
      ]) {
        const state = reviewState(value, valid);
        if (pass) fullSuccess[key].passed++;
        else if (state.unreviewed) fullSuccess[key].unreviewed++;
        else if (state.failed) fullSuccess[key].failedReview++;
      }
      const finalState = reviewState(review, reviewValid);
      addGroup(stageGroups, record.stage, after, finalState.unreviewed);
      addGroup(coverageGroups, record.coverage, after, finalState.unreviewed);
    }
    if (clarifications.includes(record)) {
      const pass = record.status === 'completed_clarification' && reviewValid && review.expectedBehavior.status === 'passed';
      if (pass) clarificationPassCount++;
      if (!pass && (!reviewValid || review.expectedBehavior.status === 'unreviewed')) clarificationUnreviewed++;
    }

    repairCalls += Number.isSafeInteger(record.repairCount) ? record.repairCount : 0;
    for (const check of record.runtimeChecks ?? []) {
      if (check?.attempt === 0 && typeof check.passed === 'boolean') {
        runtime.firstAttempt.denominator++;
        if (check.passed) runtime.firstAttempt.passed++;
      }
      if (check?.attempt === 1 && typeof check.passed === 'boolean') {
        runtime.afterRepair.denominator++;
        if (check.passed) runtime.afterRepair.passed++;
      }
    }
    for (const diagnostic of record.diagnostics ?? []) {
      if (diagnostic?.type !== 'model_call') continue;
      const usage = diagnostic.usage;
      if (!usage || typeof usage !== 'object') {
        tokenUsage.unknownUsageCalls++;
        continue;
      }
      tokenUsage.knownCalls++;
      for (const [key, field] of Object.entries(tokenUsage.fields)) {
        if (Number.isFinite(usage[key]) && usage[key] >= 0) {
          field.total += usage[key];
          field.measuredCalls++;
        }
      }
      if (Number.isFinite(usage.cost) && usage.cost >= 0) {
        tokenUsage.observedCost += usage.cost;
        tokenUsage.callsWithObservedCost++;
      }
    }
    callLimitRefusals += Number.isSafeInteger(record.callLimitRefusals) ? record.callLimitRefusals : 0;
    if (record.status === 'failed' || record.status === 'cancelled') {
      errors.push({ id: record.id, status: record.status, code: record.failure?.code ?? 'UNKNOWN' });
    }
  }

  tokenUsage.unknownUsageCalls = Math.max(0, tokenUsage.unknownUsageCalls - callLimitRefusals);
  const tokenTotals = Object.fromEntries(Object.entries(tokenUsage.fields).map(([key, field]) => [key, {
    total: field.measuredCalls ? field.total : null, measuredCalls: field.measuredCalls,
    incompleteCalls: Math.max(0, manifest.providerCalls - field.measuredCalls),
  }]));
  const unrunCount = records.filter(record => record.attempted !== true).length;
  const completedGeneration = records.filter(record => record.status === 'completed_generation').length;
  const afterRepair = fullSuccess.afterRepair;
  return {
    schemaVersion: 1, runId: manifest.runId, evidenceClass: manifest.evidenceClass,
    status: manifest.status, suite: manifest.suite, modelIdentifier: manifest.modelIdentifier,
    preparedCorpus: manifest.preparedCorpus,
    counts: { planned: manifest.plannedCount, selected: manifest.selectedCount, attempted: attempted.length,
      completedGeneration, unrun: unrunCount, errors: errors.length },
    modelCalls: { actualProviderCalls: manifest.providerCalls, limit: manifest.maxCalls,
      refusedAtCap: callLimitRefusals, repairs: repairCalls, knownUsageCalls: tokenUsage.knownCalls,
      unknownUsageCalls: tokenUsage.unknownUsageCalls },
    tokenUsage: { inputTokens: tokenTotals.input_tokens, outputTokens: tokenTotals.output_tokens,
      totalTokens: tokenTotals.total_tokens, unknownUsageCalls: tokenUsage.unknownUsageCalls,
      observedCost: tokenUsage.callsWithObservedCost ? tokenUsage.observedCost : null,
      costCalls: tokenUsage.callsWithObservedCost },
    runtime: { label: 'RUNTIME', firstAttempt: { ...runtime.firstAttempt,
      rate: rate(runtime.firstAttempt.passed, runtime.firstAttempt.denominator) },
      afterRepair: { ...runtime.afterRepair, rate: rate(runtime.afterRepair.passed, runtime.afterRepair.denominator) } },
    mathematical: { label: 'independently reviewed mathematical success',
      fullSuccess: { passed: afterRepair.passed, denominator: afterRepair.denominator,
        rate: rate(afterRepair.passed, afterRepair.denominator), unreviewed: afterRepair.unreviewed,
        failedReview: afterRepair.failedReview,
        firstAttempt: { ...fullSuccess.firstAttempt, rate: rate(fullSuccess.firstAttempt.passed, interactive.length) },
        afterRepair: { ...afterRepair, rate: rate(afterRepair.passed, afterRepair.denominator) } },
      byStage: stageGroups, byCoverage: coverageGroups },
    clarification: { label: 'independently reviewed clarification handling',
      passed: clarificationPassCount, denominator: clarifications.length,
      rate: rate(clarificationPassCount, clarifications.length), unreviewed: clarificationUnreviewed },
    review: { malformedRecords: malformedReviewIds.size }, errors,
  };
}

async function cli() {
  const [runDir] = process.argv.slice(2);
  if (!runDir || runDir.startsWith('--')) {
    console.error('Usage: node evaluation/report.mjs <evaluation/runs/RUN_ID>');
    process.exitCode = 2;
    return;
  }
  try { console.log(JSON.stringify(await buildRunReport(runDir), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
