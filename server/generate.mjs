import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GenerationError, planSchema, htmlSchema, repairSchema, applyRepairPatch, validatePlan, validatePage,
  validateRepairPatch } from './contracts.mjs';
import { sanitizeUsage } from './model.mjs';
import { validateIndependentChecks } from './assessment-probes.mjs';
import { planInstructions, gameInstructions, repairInstructions } from './prompts.mjs';

const generationTimeoutMessage = 'This activity took too long to generate. Please try again.';
const maxGenerationTimeoutMs = 180000;

function abortReason(signal) {
  return signal.reason || new DOMException('The operation was aborted.', 'AbortError');
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function safeDiagnosticErrors(errors) {
  if (!Array.isArray(errors)) return ['Runtime check failed.'];
  return errors.slice(0, 10).map(error => {
    if (typeof error !== 'string') return 'Generated page runtime error.';
    if (error.startsWith('Independent assessment probe failed for field ')) {
      return 'An independent assessment field probe failed.';
    }
    const known = new Set([
      'Expected one visible #mpl-problem element.',
      'Expected one visible #mpl-status element.',
      'Expected one visible #mpl-reset element.',
      'Expected a visible, enabled mathematical interaction control.',
      'The page has horizontal overflow at desktop width.',
      'The page has horizontal overflow at 320px width.',
      'The first mathematical control has a click target smaller than 44 by 44 pixels.',
      'The first mathematical control text or numeric entry uses a font smaller than 16px.',
      'Visible problem text uses a font smaller than 16px.',
      'The interaction control did not change mathematical state.',
      'Expected the first mathematical interaction control to be visible and enabled after reset.',
      'After reset, the interaction control did not change mathematical state.',
      'Reset did not restore initial mathematical state.',
      'Expected a different, enabled option in the mathematical interaction control.',
      'window.mathPlayLab.getState() must return a nonempty JSON object of mathematical state.',
      'Expected a visible enabled hint button.',
      'Expected an initially empty or hidden hint live region.',
      'The first hint click did not reveal the first hint.',
      'The second hint click did not reveal different additional guidance.',
      'Reset did not clear or hide the hints.',
      'Reset did not restore the hint sequence.',
      'The hint button was not enabled after reset.',
      'Hint controls changed mathematical state.',
      'The playthrough contract was invalid.',
      'The shared assessment runtime was unavailable during playthrough.',
      'A playthrough action could not be performed safely.',
      'The wrong-answer playthrough phase did not produce an incorrect checkpoint.',
      'The recovery playthrough phase did not reach the expected terminal state.',
      'Reset did not restore the complete initial activity state and interface.',
      'The solve playthrough phase did not reach the expected terminal state.',
      'The invalidation playthrough phase did not clear the confirmed result.',
      'The replay playthrough phase did not reach the expected terminal state.',
      'An independent assessment field probe failed.',
      'The independent assessment field checks did not report valid coverage.',
      'The complete learner playthrough did not pass.',
    ]);
    return known.has(error) ? error : 'Generated page runtime error.';
  });
}

function diagnostic(callback, record) {
  try { callback?.(record); } catch { /* Diagnostics must not change generation behavior. */ }
}

export async function generateGame({ problem, model, check, onStage = () => {}, onDiagnostic,
  signal, timeoutMs = 180000 }) {
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.min(maxGenerationTimeoutMs, Math.max(0, timeoutMs)) : maxGenerationTimeoutMs;
  const linkedController = new AbortController();
  const linkedSignal = linkedController.signal;
  const timeoutError = new GenerationError('GENERATION_TIMEOUT', generationTimeoutMessage);
  let timer;
  let callerAbort;

  if (signal?.aborted) linkedController.abort(abortReason(signal));
  else if (signal) {
    callerAbort = () => linkedController.abort(abortReason(signal));
    signal.addEventListener('abort', callerAbort, { once: true });
  }
  if (!linkedSignal.aborted) {
    timer = setTimeout(() => linkedController.abort(timeoutError), deadlineMs);
  }

  const ensureActive = () => {
    if (linkedSignal.aborted) throw abortReason(linkedSignal);
  };
  const stage = name => { ensureActive(); onStage(name); };
  const modelCall = async request => {
    ensureActive();
    const started = performance.now();
    let result;
    try {
      result = await withAbort(Promise.resolve().then(() => model.complete({ ...request, signal: linkedSignal })), linkedSignal);
    } catch (error) {
      const record = {
        type: 'model_call', name: request.name, durationMs: Math.max(0, Math.round(performance.now() - started)),
        outcome: 'failed', usage: sanitizeUsage(error?.usage),
      };
      if (error?.incompleteReason === 'max_output_tokens') record.incompleteReason = 'max_output_tokens';
      diagnostic(onDiagnostic, record);
      throw error;
    }
    diagnostic(onDiagnostic, {
      type: 'model_call', name: request.name, durationMs: Math.max(0, Math.round(performance.now() - started)),
      outcome: 'completed', usage: sanitizeUsage(result?.usage),
    });
    ensureActive();
    return result;
  };
  const runtimeCheck = async (html, attempt, assessment, playtest) => {
    ensureActive();
    let report;
    try {
      report = await withAbort(Promise.resolve().then(() => check(html, {
        signal: linkedSignal, attempt, assessment: structuredClone(assessment), playtest: structuredClone(playtest),
      })), linkedSignal);
    } catch (error) {
      const message = error?.code === 'BROWSER_UNAVAILABLE' ? 'Browser checker unavailable.' : 'Browser check failed.';
      diagnostic(onDiagnostic, { type: 'runtime_check', attempt, passed: false, playthrough: 'failed', errors: [message] });
      throw error;
    }
    const errors = Array.isArray(report?.errors) ? report.errors.filter(error => typeof error === 'string').slice(0, 10).map(error => error.slice(0, 500)) : [];
    const coverageValid = validateIndependentChecks(report?.independentChecks, assessment);
    const passed = report?.passed === true && report?.playthrough === 'passed' && coverageValid;
    if (!coverageValid && !errors.length) errors.push('The independent assessment field checks did not report valid coverage.');
    if (!passed && !errors.length) errors.push('The complete learner playthrough did not pass.');
    diagnostic(onDiagnostic, { type: 'runtime_check', attempt, passed,
      playthrough: report?.playthrough === 'passed' ? 'passed' : 'failed',
      ...(coverageValid ? { independentChecks: structuredClone(report.independentChecks) } : {}),
      errors: passed ? [] : safeDiagnosticErrors(errors) });
    ensureActive();
    return { passed, playthrough: report?.playthrough === 'passed' ? 'passed' : 'failed',
      independentChecks: coverageValid ? structuredClone(report.independentChecks) : null, errors };
  };

  try {
    stage('understanding');
    const analysis = await modelCall({ instructions: planInstructions, input: { originalProblem: problem },
      schema: planSchema, name: 'play_plan' });
    const plan = validatePlan(analysis.value, { requireAssessment: true });
    if (plan.status === 'clarify') return { type: 'clarification', question: plan.clarification };
    const assessment = structuredClone(plan.assessment);
    const activityPlan = { ...plan, assessment: structuredClone(assessment) };
    delete activityPlan.explanation;

    stage('building');
    const generated = await modelCall({ instructions: gameInstructions,
      input: { originalProblem: problem, plan: structuredClone(activityPlan) }, schema: htmlSchema, name: 'playable_exercise' });
    const page = validatePage(generated.value, { requirePlaytest: true });
    if (page.status === 'conflict') {
      throw new GenerationError('PLAN_CONFLICT', 'The activity could not be matched to the original problem. Please try again.');
    }
    const playtest = structuredClone(page.playtest);
    let html = page.html;
    let repairCount = 0;
    stage('checking');
    let report = await runtimeCheck(html, 0, assessment, playtest);
    if (!report.passed) {
      stage('repairing');
      const repaired = await modelCall({ instructions: repairInstructions,
        input: { originalProblem: problem, plan: structuredClone(activityPlan), assessment: structuredClone(assessment),
          playtest: structuredClone(playtest), html, runtimeErrors: report.errors },
        schema: repairSchema, name: 'repaired_exercise' });
      const repairPatch = validateRepairPatch(repaired.value);
      if (repairPatch.status === 'conflict') {
        throw new GenerationError('PLAN_CONFLICT', 'The activity could not be matched to the original problem. Please try again.');
      }
      html = applyRepairPatch(html, repairPatch);
      repairCount = 1;
      stage('checking');
      report = await runtimeCheck(html, 1, assessment, playtest);
    }
    ensureActive();
    if (!report.passed) {
      throw new GenerationError('RUNTIME_CHECK_FAILED', 'This exercise did not pass its browser checks after one repair. Please try again.');
    }
    return { type: 'result', game: {
      id: randomUUID(), title: plan.title, problem, html, topics: plan.topics,
      objective: plan.objective, activityType: plan.activityType, requiresReview: plan.requiresReview,
      referenceAnswer: plan.referenceAnswer, explanation: plan.explanation, repairCount,
      assessment: structuredClone(assessment),
      verification: { runtime: 'passed', playthrough: 'passed', mathematics: 'not_independently_verified',
        independentChecks: structuredClone(report.independentChecks) },
    } };
  } finally {
    clearTimeout(timer);
    if (signal && callerAbort) signal.removeEventListener('abort', callerAbort);
  }
}
