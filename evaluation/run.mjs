import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkHtml } from '../server/check.mjs';
import { validatePage, validatePlan, validateRepairPatch } from '../server/contracts.mjs';
import { generateGame } from '../server/generate.mjs';
import { createModelClient, isModelConfigured, modelConfig } from '../server/model.mjs';
import { loadSuite, readCoverageRegistry, validateDataset, preparedSummary } from './validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const implementationFiles = ['server/prompts.mjs', 'server/generate.mjs', 'server/model.mjs', 'server/contracts.mjs',
  'server/check.mjs', 'public/sandbox.js',
  'evaluation/run.mjs', 'evaluation/validate.mjs', 'evaluation/report.mjs'];
const safeErrorCodes = new Set(['EVALUATION_CALL_CAP', 'GENERATION_TIMEOUT', 'MODEL_REQUEST_FAILED',
  'MODEL_UNAVAILABLE', 'NOT_CONFIGURED', 'BROWSER_UNAVAILABLE', 'RUNTIME_CHECK_FAILED', 'INVALID_MODEL_OUTPUT',
  'INCOMPLETE_MODEL_OUTPUT', 'MODEL_REFUSAL', 'PLAN_CONFLICT']);
const reviewDimensions = ['fidelity', 'mathematics', 'playability', 'explanation'];
const reviewChecks = ['correct', 'wrong', 'reset', 'multipleSolutions'];

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function reviewCell() { return { status: 'unreviewed', reviewer: '', evidence: '' }; }
export function emptyReviewRecord() {
  return { schemaVersion: 1,
    dimensions: Object.fromEntries(reviewDimensions.map(key => [key, reviewCell()])),
    checklist: Object.fromEntries(reviewChecks.map(key => [key, reviewCell()])),
    expectedBehavior: reviewCell() };
}

function splitCounts(cases) {
  const counts = {};
  for (const item of cases) {
    const split = item.split ?? 'not_specified';
    counts[split] = (counts[split] ?? 0) + 1;
  }
  return counts;
}

function specialDisposition(item) {
  if (item.kind === 'software_scenario') return {
    status: 'software_test_required', route: 'software_tests',
    reason: 'This scenario must be exercised by software tests, never sent as a math prompt.',
  };
  if (item.kind === 'image_scenario') return {
    status: 'skipped',
    reason: 'Awaiting an image fixture and P1 runner; excluded from text model calls and not counted as a pass.',
  };
  return null;
}

export function selectCases(cases, { caseId, limit, includeHoldout = false } = {}) {
  let candidates = cases;
  if (caseId) {
    candidates = cases.filter(item => item.id === caseId);
    if (!candidates.length) throw new Error(`Unknown case ID: ${caseId}`);
  }
  const holdoutExcluded = candidates.filter(item => item.split === 'holdout' && !includeHoldout);
  candidates = candidates.filter(item => includeHoldout || item.split !== 'holdout');
  if (Number.isSafeInteger(limit)) candidates = candidates.slice(0, limit);
  return { cases: candidates, holdoutExcluded: holdoutExcluded.map(item => item.id) };
}

function makeManifest({ id, dataset, suiteName, selected, holdoutExcluded, live, maxCalls, modelName,
  implementationHashes, prepared, includeHoldout }) {
  return { schemaVersion: 1, runId: id, status: 'started', evidenceClass: 'live', suite: suiteName,
    datasetStatus: dataset.status, purpose: dataset.purpose, createdAt: new Date().toISOString(),
    finishedAt: null, modelIdentifier: modelName || 'unconfigured', live, maxCalls,
    plannedCount: dataset.cases.length, selectedCount: selected.length, attemptedCount: 0,
    completedGenerationCount: 0, unrunCount: selected.length, providerCalls: 0,
    callLimitRefusals: 0, repairAttempts: 0, errorCount: 0, selectedSplits: splitCounts(selected),
    includeHoldout, holdoutExcluded, selectedCases: selected.map(item => ({ id: item.id, coverage: item.coverage,
      stage: item.stage ?? null, split: item.split ?? 'not_specified', expectedBehavior: item.expected_behavior,
      kind: item.kind ?? 'math' })),
    implementationHashes, preparedCorpus: prepared ?? { pilot: suiteName === 'pilot' ? dataset.cases.length : 0,
      core: suiteName === 'curriculum' ? dataset.cases.filter(item => !item.coverage.startsWith('stress-')).length : 0,
      stress: suiteName === 'curriculum' ? dataset.cases.filter(item => item.coverage.startsWith('stress-')).length : 0,
      totalIncludingPilot: dataset.cases.length, target: { core: 423, stress: 48, total: 471 }, absentCoverage: [] },
  };
}

async function implementationHashes() {
  const hashes = {};
  for (const relative of implementationFiles) {
    const content = await readFile(path.join(ROOT, relative));
    hashes[relative] = sha256(content);
  }
  return hashes;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
}

function safeFailure(error) {
  const code = safeErrorCodes.has(error?.code) ? error.code : 'UNKNOWN';
  const messages = {
    EVALUATION_CALL_CAP: 'The configured provider-call cap was reached before this request was sent.',
    GENERATION_TIMEOUT: 'Generation exceeded its time limit.',
    MODEL_REQUEST_FAILED: 'The model service could not complete the request.',
    MODEL_UNAVAILABLE: 'The model service could not be reached.',
    NOT_CONFIGURED: 'Model configuration is missing.',
    BROWSER_UNAVAILABLE: 'The browser checker is unavailable.',
    RUNTIME_CHECK_FAILED: 'The generated page did not pass runtime checks after one repair.',
    INVALID_MODEL_OUTPUT: 'The model returned output that did not meet the generation contract.',
  };
  return { code, message: messages[code] ?? 'Generation failed; provider details were not retained.' };
}

function allCounters(manifest, records) {
  manifest.attemptedCount = records.filter(record => record.attempted).length;
  manifest.completedGenerationCount = records.filter(record => record.status === 'completed_generation').length;
  manifest.unrunCount = manifest.selectedCount - manifest.attemptedCount;
  manifest.errorCount = records.filter(record => ['failed', 'cancelled'].includes(record.status)).length;
}

export async function runEvaluation({ rootDir = ROOT, dataset, suiteName = 'pilot', live = false,
  maxCalls, modelConfigured = false, model, check = checkHtml, modelName = 'unconfigured',
  includeHoldout = false, caseId, limit, signal, generationTimeoutMs, evidenceClass,
  prepared, coverageRegistry, idFactory = randomUUID, onProgress } = {}) {
  if (!dataset) throw new Error('An evaluation dataset is required.');
  let coverageStages = coverageRegistry;
  if (!coverageStages) {
    try { coverageStages = await readCoverageRegistry(path.resolve(rootDir, '../docs/superpowers/specs/2026-11-16-math-play-lab-coverage.csv')); }
    catch { throw new Error('Coverage registry is unavailable; evaluation was refused.'); }
  }
  const coverageIds = coverageStages ? new Set(coverageStages.keys()) : undefined;
  const validation = validateDataset(dataset, { suiteName, coverageIds, coverageStages });
  if (!validation.valid) throw new Error(`Invalid ${suiteName} dataset: ${validation.errors.join('; ')}`);
  if (live && (!Number.isSafeInteger(maxCalls) || maxCalls <= 0)) {
    throw new Error('Live evaluation requires a positive --max-calls value.');
  }
  if (live && !modelConfigured) throw new Error('Live evaluation refused: model configuration is missing; no run was created.');
  if (live && !model?.complete) throw new Error('Live evaluation requires a configured model client.');
  const selection = selectCases(dataset.cases, { caseId, limit, includeHoldout });
  if (!live) {
    return { kind: 'dry_run', suite: suiteName, modelConfigured, modelIdentifier: modelName,
      plannedCount: dataset.cases.length, selectedCount: selection.cases.length,
      holdoutExcluded: selection.holdoutExcluded,
      selectedSplits: splitCounts(selection.cases), cases: selection.cases.map(item => ({ id: item.id,
        coverage: item.coverage, stage: item.stage ?? null, split: item.split ?? 'not_specified',
        expectedBehavior: item.expected_behavior, kind: item.kind ?? 'math', disposition: specialDisposition(item) })) };
  }

  const id = idFactory();
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) {
    throw new Error('Run ID must be a safe slug.');
  }
  const runDir = path.join(rootDir, 'evaluation', 'runs', id);
  const hashes = await implementationHashes();
  const dirs = [path.dirname(runDir), path.join(runDir, 'cases'), path.join(runDir, 'html')];
  await mkdir(dirs[0], { recursive: true });
  await mkdir(runDir);
  await Promise.all(dirs.slice(1).map(dir => mkdir(dir)));
  const manifest = makeManifest({ id, dataset, suiteName, selected: selection.cases,
    holdoutExcluded: selection.holdoutExcluded, live, maxCalls, modelName, implementationHashes: hashes,
    prepared, includeHoldout });
  manifest.evidenceClass = evidenceClass === 'fixtures' ? 'fixtures' : 'live';
  manifest.caseArtifactFiles = selection.cases.map(item => `cases/${item.id}.json`);
  manifest.promptHashes = { file: 'server/prompts.mjs', sha256: hashes['server/prompts.mjs'] };
  const manifestPath = path.join(runDir, 'manifest.json');
  await writeJson(manifestPath, manifest);

  const records = [];
  let providerCalls = 0;
  let callLimitRefusals = 0;
  let repairAttempts = 0;
  let cancelled = false;
  const persist = async () => {
    manifest.providerCalls = providerCalls;
    manifest.callLimitRefusals = callLimitRefusals;
    manifest.repairAttempts = repairAttempts;
    allCounters(manifest, records);
    manifest.lastUpdatedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
  };

  for (let index = 0; index < selection.cases.length; index++) {
    const item = selection.cases[index];
    const casePath = path.join(runDir, 'cases', `${item.id}.json`);
    const record = { schemaVersion: 1, id: item.id, status: 'pending', attempted: false,
      suite: suiteName, coverage: item.coverage, stage: item.stage ?? null, split: item.split ?? 'not_specified',
      expectedBehavior: item.expected_behavior, modelIdentifier: modelName,
      originalCase: item, originalInput: { problem: item.problem },
      reference: { answer: item.reference_answer, checks: item.checks,
        status: item.reference_status ?? 'legacy_pilot_reference' },
      diagnostics: [], runtimeChecks: [], providerCalls: 0, callLimitRefusals: 0,
      repairCount: 0, htmlFiles: [], validatedContracts: [], review: emptyReviewRecord() };

    const special = specialDisposition(item);
    if (special) {
      Object.assign(record, special);
      records.push(record);
      await writeJson(casePath, record);
      await persist();
      onProgress?.({ index: index + 1, total: selection.cases.length, id: item.id, status: record.status });
      continue;
    }
    if (signal?.aborted || providerCalls >= maxCalls) {
      record.status = 'unrun';
      record.attempted = false;
      record.reason = signal?.aborted ? 'Run cancelled before this case started.' : 'Global provider-call cap reached before this case started.';
      records.push(record);
      await writeJson(casePath, record);
      if (signal?.aborted) cancelled = true;
      await persist();
      continue;
    }

    const caseStarted = performance.now();
    record.status = 'running';
    record.attempted = true;
    record.startedAt = new Date().toISOString();
    records.push(record);
    await writeJson(casePath, record);
    await persist();

    const caseHtmlFiles = [];
    const capturedHtml = [];
    const limitedModel = { async complete(request) {
      if (providerCalls >= maxCalls) {
        callLimitRefusals++;
        record.callLimitRefusals++;
        const error = new Error('Configured provider-call cap reached.');
        error.code = 'EVALUATION_CALL_CAP';
        throw error;
      }
      request.signal?.throwIfAborted();
      providerCalls++;
      record.providerCalls++;
      if (request.name === 'repaired_exercise') {
        repairAttempts++;
        record.repairCount++;
        if (!record.firstAttemptReview && capturedHtml.some(itemHtml => itemHtml.name === 'playable_exercise')) {
          record.firstAttemptReview = structuredClone(record.review);
        }
      }
      const pending = model.complete(request);
      const response = await pending;
      request.signal?.throwIfAborted();
      if (request.name === 'play_plan') {
        let plan;
        try { plan = validatePlan(response?.value, { requireAssessment: true }); }
        catch { return response; }
        record.validatedContracts.push({ requestName: request.name, plan: structuredClone(plan) });
      } else if (request.name === 'playable_exercise') {
        let page;
        try { page = validatePage(response?.value, { requirePlaytest: true }); }
        catch { return response; }
        const pageContract = { requestName: request.name, status: page.status, issue: page.issue,
          playtest: structuredClone(page.playtest) };
        record.validatedContracts.push(pageContract);
      } else if (request.name === 'repaired_exercise') {
        let patch;
        try { patch = validateRepairPatch(response?.value); }
        catch { return response; }
        record.validatedContracts.push({ requestName: request.name, status: patch.status,
          issue: patch.issue, edits: structuredClone(patch.edits) });
      }
      return response;
    } };

    const evaluationCheck = async (html, { signal: checkSignal, attempt, assessment, playtest } = {}) => {
      checkSignal?.throwIfAborted();
      const name = attempt === 0 ? 'playable_exercise' : attempt === 1 ? 'repaired_exercise' : null;
      if (name && typeof html === 'string') {
        const entry = { filename: `${item.id}-${name}.html`, name, html };
        const existingIndex = capturedHtml.findIndex(itemHtml => itemHtml.name === name);
        if (existingIndex === -1) capturedHtml.push(entry);
        else capturedHtml[existingIndex] = entry;
      }
      return check(html, { signal: checkSignal, attempt, assessment, playtest });
    };

    try {
      const result = await generateGame({ problem: item.problem, model: limitedModel, check: evaluationCheck,
        onDiagnostic: diagnostic => {
          record.diagnostics.push(diagnostic);
          if (diagnostic.type === 'runtime_check') record.runtimeChecks.push(diagnostic);
        }, signal, ...(Number.isFinite(generationTimeoutMs) ? { timeoutMs: generationTimeoutMs } : {}) });
      if (result.type === 'result') {
        const game = { ...result.game };
        delete game.html;
        record.status = 'completed_generation';
        record.result = { type: 'result', game };
      } else {
        record.status = 'completed_clarification';
        record.result = { type: 'clarification', question: result.question };
      }
    } catch (error) {
      record.status = signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      record.failure = safeFailure(error);
      if (record.status === 'cancelled') cancelled = true;
    }
    for (const itemHtml of capturedHtml) {
      await writeFile(path.join(runDir, 'html', itemHtml.filename), itemHtml.html, { flag: 'wx' });
      caseHtmlFiles.push(`html/${itemHtml.filename}`);
      if (itemHtml.name === 'repaired_exercise') record.review = emptyReviewRecord();
      record.latestGeneratedAttempt = itemHtml.name;
    }
    record.finishedAt = new Date().toISOString();
    record.durationMs = Math.max(0, Math.round(performance.now() - caseStarted));
    record.htmlFiles = [...caseHtmlFiles];
    record.runtimeChecks = record.diagnostics.filter(item => item.type === 'runtime_check');
    await writeJson(casePath, record);
    await persist();
    onProgress?.({ index: index + 1, total: selection.cases.length, id: item.id, status: record.status });
    if (cancelled) {
      for (const unfinished of selection.cases.slice(index + 1)) {
        const pending = { schemaVersion: 1, id: unfinished.id, status: 'unrun', attempted: false,
          suite: suiteName, coverage: unfinished.coverage, stage: unfinished.stage ?? null,
          split: unfinished.split ?? 'not_specified', expectedBehavior: unfinished.expected_behavior,
          modelIdentifier: modelName, originalCase: unfinished, originalInput: { problem: unfinished.problem },
          reference: { answer: unfinished.reference_answer, checks: unfinished.checks,
            status: unfinished.reference_status ?? 'legacy_pilot_reference' },
          diagnostics: [], runtimeChecks: [], providerCalls: 0, callLimitRefusals: 0, repairCount: 0,
          htmlFiles: [], validatedContracts: [], review: emptyReviewRecord(), reason: 'Run cancelled before this case started.' };
        records.push(pending);
        await writeJson(path.join(runDir, 'cases', `${unfinished.id}.json`), pending);
      }
      break;
    }
  }

  manifest.status = cancelled ? 'cancelled' : 'completed';
  manifest.finishedAt = new Date().toISOString();
  await persist();
  return { kind: 'run', runDir, manifest };
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

export function parseArgs(args) {
  const result = { suite: 'pilot', live: false, includeHoldout: false };
  const seen = new Set();
  const valueOptions = new Map([['--suite', 'suite'], ['--case', 'caseId'], ['--limit', 'limit'], ['--max-calls', 'maxCalls']]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') { result.help = true; continue; }
    if (arg === '--live') { if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`); seen.add(arg); result.live = true; continue; }
    if (arg === '--include-holdout') {
      if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
      seen.add(arg); result.includeHoldout = true; continue;
    }
    const option = valueOptions.get(arg);
    if (!option) throw new Error(`Unsupported argument: ${arg}`);
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    if (option === 'suite') {
      if (!['pilot', 'curriculum'].includes(value)) throw new Error('--suite must be pilot or curriculum.');
      result.suite = value;
    } else if (option === 'caseId') result.caseId = value;
    else result[option] = positiveInteger(value, arg);
  }
  if (result.live && result.maxCalls === undefined) throw new Error('--live requires --max-calls N.');
  if (!result.live && result.maxCalls !== undefined) throw new Error('--max-calls requires --live.');
  if (result.includeHoldout && result.suite !== 'curriculum') throw new Error('--include-holdout is only valid with --suite curriculum.');
  if (result.caseId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(result.caseId)) throw new Error('--case must be a safe case ID slug.');
  return result;
}

const helpText = `Usage: node evaluation/run.mjs [--suite pilot|curriculum] [--case ID] [--limit N]\n       node evaluation/run.mjs --live --max-calls N [--suite pilot|curriculum] [--case ID] [--limit N] [--include-holdout]\nDry run is the default. Holdout cases are excluded unless explicitly included.`;

async function cli() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(helpText); return; }
  try {
    const dataset = await loadSuite(options.suite);
    const coverageStages = await readCoverageRegistry().catch(() => undefined);
    const coverageIds = coverageStages ? new Set(coverageStages.keys()) : undefined;
    const validation = validateDataset(dataset, { suiteName: options.suite, coverageIds, coverageStages });
    if (!validation.valid) throw new Error(`Invalid ${options.suite} dataset: ${validation.errors.join('; ')}`);
    const config = modelConfig();
    const configured = isModelConfigured(config);
    if (options.live && !configured) throw new Error('Live evaluation refused: model configuration is missing; no run was created.');
    const prepared = await preparedSummary({ coverageIds });
    const controller = new AbortController();
    const onSigint = () => controller.abort(new DOMException('Evaluation cancelled by SIGINT.', 'AbortError'));
    if (options.live) process.once('SIGINT', onSigint);
    let result;
    try {
      result = await runEvaluation({ rootDir: ROOT, dataset, suiteName: options.suite, live: options.live,
        maxCalls: options.maxCalls, modelConfigured: configured, model: configured ? createModelClient(config) : undefined,
        modelName: config.model || 'unconfigured', includeHoldout: options.includeHoldout,
        caseId: options.caseId, limit: options.limit, signal: controller.signal, prepared,
        onProgress: options.live ? item => console.error(`${item.index}/${item.total} ${item.id}: ${item.status}`) : undefined });
    } finally { if (options.live) process.off('SIGINT', onSigint); }
    console.log(JSON.stringify(result, null, 2));
    if (result.kind === 'run' && result.manifest.status === 'cancelled') process.exitCode = 130;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
