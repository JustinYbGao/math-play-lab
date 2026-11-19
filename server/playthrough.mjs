import { isDeepStrictEqual } from 'node:util';
import { emptyIndependentChecks, runIndependentAssessmentProbes } from './assessment-probes.mjs';
import { createExactMath } from '../public/sandbox.js';

const exactMath = createExactMath();

const phaseErrors = {
  contract: 'The playthrough contract was invalid.',
  runtime: 'The shared assessment runtime was unavailable during playthrough.',
  wrong: 'The wrong-answer playthrough phase did not produce an incorrect checkpoint.',
  recover: 'The recovery playthrough phase did not reach the expected terminal state.',
  reset: 'Reset did not restore the complete initial activity state and interface.',
  solve: 'The solve playthrough phase did not reach the expected terminal state.',
  invalidate: 'The invalidation playthrough phase did not clear the confirmed result.',
  replay: 'The replay playthrough phase did not reach the expected terminal state.',
};

const checkpointText = (state, feedback) => state === 'correct' ? 'Correct.' : state === 'incorrect' ? feedback
  : state === 'blocked' ? 'Complete the prior step first.' : state === 'pending' ? 'Ready for review.' : '';

function initialAssessmentState(assessment) {
  return { values: Object.fromEntries(assessment.fields.map(field => [field.id, field.initial])),
    checkpoints: Object.fromEntries(assessment.checkpoints.map(checkpoint => [checkpoint.id, 'unanswered'])),
    complete: false, pendingReview: false };
}

async function readSurface(page) {
  return page.evaluate(() => {
    const json = value => {
      try { return JSON.parse(JSON.stringify(value)); }
      catch { return null; }
    };
    const visible = element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== 'none' &&
        !['hidden', 'collapse'].includes(style.visibility);
    };
    const activity = window.mathPlayLabActivity;
    let runtime = null;
    try { runtime = activity?.getState?.() ?? null; } catch { runtime = null; }
    let common = null;
    try { common = window.mathPlayLab?.getState?.() ?? null; } catch { common = null; }
    return {
      activityExists: Boolean(activity && typeof activity.getState === 'function' && typeof activity.set === 'function' &&
        typeof activity.submit === 'function' && typeof activity.reset === 'function' && typeof activity.subscribe === 'function'),
      runtime: json(runtime), common: json(common),
      fields: Array.from(document.querySelectorAll('[data-mpl-field]')).map(element => ({
        id: element.getAttribute('data-mpl-field'), value: element.value,
      })),
      feedback: Array.from(document.querySelectorAll('[data-mpl-feedback]')).map(element => ({
        id: element.getAttribute('data-mpl-feedback'), state: element.dataset.state,
        text: element.textContent, visible: visible(element),
      })),
      status: Array.from(document.querySelectorAll('#mpl-status')).map(element => ({
        state: element.dataset.state, text: element.textContent, visible: visible(element),
      })),
      reset: Array.from(document.querySelectorAll('#mpl-reset')).map(element => ({ visible: visible(element),
        enabled: !element.disabled })),
      hints: Array.from(document.querySelectorAll('#mpl-hint-text')).map(element => ({
        text: element.textContent, visible: visible(element), hidden: element.hidden,
      })),
    };
  });
}

function isTerminal(snapshot, requiresReview) {
  const states = Object.values(snapshot.checkpoints ?? {});
  if (requiresReview) return snapshot.complete === false && snapshot.pendingReview === true &&
    states.length > 0 && states.every(state => state === 'correct' || state === 'pending');
  return snapshot.complete === true && snapshot.pendingReview === false && states.length > 0 &&
    states.every(state => state === 'correct');
}

async function assertSynchronized(page, assessment, initialState = null) {
  const surface = await readSurface(page);
  if (!surface.activityExists || !surface.runtime || !surface.common ||
      !isDeepStrictEqual(surface.common.assessment, surface.runtime) ||
      (Object.hasOwn(surface.common, 'complete') && surface.common.complete !== surface.runtime.complete) ||
      (Object.hasOwn(surface.common, 'pendingReview') && surface.common.pendingReview !== surface.runtime.pendingReview)) {
    return { ok: false, surface };
  }
  if (initialState && !isDeepStrictEqual(surface.common, initialState)) return { ok: false, surface };

  for (const item of surface.fields) {
    if (!Object.hasOwn(surface.runtime.values ?? {}, item.id) || surface.runtime.values[item.id] !== item.value) {
      return { ok: false, surface };
    }
  }
  const expectedFeedback = new Map(assessment.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]));
  if (surface.feedback.length !== assessment.checkpoints.length) return { ok: false, surface };
  for (const checkpoint of assessment.checkpoints) {
    const nodes = surface.feedback.filter(item => item.id === checkpoint.id);
    if (nodes.length !== 1 || !nodes[0].visible ||
        nodes[0].state !== surface.runtime.checkpoints?.[checkpoint.id] ||
        nodes[0].text !== checkpointText(nodes[0].state, checkpoint.feedback)) return { ok: false, surface };
    expectedFeedback.delete(checkpoint.id);
  }
  if (expectedFeedback.size || surface.status.length !== 1 || !surface.status[0].visible) return { ok: false, surface };
  const expectedGlobal = surface.runtime.complete ? ['complete', 'Complete.'] : surface.runtime.pendingReview
    ? ['pending', 'Ready for independent review.'] : ['incomplete', 'In progress.'];
  if (surface.status[0].state !== expectedGlobal[0] || surface.status[0].text !== expectedGlobal[1]) return { ok: false, surface };
  return { ok: true, surface };
}

async function performAction(page, action) {
  const control = page.locator(action.selector);
  if (await control.count() !== 1 || !await control.isVisible() || !await control.isEnabled()) return false;
  const shape = await control.evaluate(element => ({ tag: element.tagName, type: element.type }));
  try {
    if (action.action === 'click') await control.click();
    else if (action.action === 'fill' && (shape.tag === 'TEXTAREA' ||
      (shape.tag === 'INPUT' && ['text', 'number', 'range'].includes(shape.type)))) await control.fill(action.value);
    else if (action.action === 'select' && shape.tag === 'SELECT') await control.selectOption(action.value);
    else if (action.action === 'press') await control.press(action.value);
    else return false;
  } catch { return false; }
  return true;
}

async function runTrace(page, phase, trace, assessment) {
  for (const action of trace) {
    if ((phase === phaseErrors.recover || phase === phaseErrors.invalidate) && action.selector === '#mpl-reset') {
      return { ok: false, surface: null, phase };
    }
    if (!await performAction(page, action)) return { ok: false, surface: null, phase };
    const synchronized = await assertSynchronized(page, assessment);
    if (!synchronized.ok) return { ok: false, surface: synchronized.surface, phase };
  }
  const synchronized = await assertSynchronized(page, assessment);
  if (!synchronized.ok) return { ok: false, surface: synchronized.surface, phase };
  return { ok: true, surface: synchronized.surface, phase };
}

async function resetToInitial(page, assessment, initialAssessment, initialState) {
  const reset = page.locator('#mpl-reset');
  if (await reset.count() !== 1 || !await reset.isVisible() || !await reset.isEnabled()) return false;
  try { await reset.click(); } catch { return false; }
  const synchronized = await assertSynchronized(page, assessment, initialState);
  if (!synchronized.ok || !isDeepStrictEqual(synchronized.surface.runtime, initialAssessment)) return false;
  const surface = synchronized.surface;
  if (surface.reset.length !== 1 || !surface.reset[0].visible || !surface.reset[0].enabled ||
      surface.hints.length !== 1 || (surface.hints[0].text.trim() && surface.hints[0].visible)) return false;
  return true;
}

function invalidatedCheckpointIds(assessment, changedFields) {
  const affected = new Set(assessment.checkpoints.filter(checkpoint => changedFields.some(field =>
    checkpoint.field === field || checkpoint.watchFields.includes(field) ||
    (checkpoint.rule.kind === 'relation' && exactMath.referencedFields(checkpoint.rule).includes(field))))
    .map(checkpoint => checkpoint.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const checkpoint of assessment.checkpoints) {
      if (!affected.has(checkpoint.id) && checkpoint.dependsOn.some(id => affected.has(id))) {
        affected.add(checkpoint.id);
        changed = true;
      }
    }
  }
  return affected;
}

export async function runPlaythrough(page, assessment, playtest) {
  const unchecked = emptyIndependentChecks(assessment);
  const finish = (errors, independentChecks = unchecked) => ({ errors, independentChecks });
  if (!assessment || !playtest || !page) return finish([phaseErrors.contract]);
  const expectedInitial = initialAssessmentState(assessment);
  let synchronized = await assertSynchronized(page, assessment);
  if (!synchronized.ok || !isDeepStrictEqual(synchronized.surface.runtime, expectedInitial) ||
      synchronized.surface.reset.length !== 1 || !synchronized.surface.reset[0].visible ||
      !synchronized.surface.reset[0].enabled || synchronized.surface.hints.length !== 1 ||
      (synchronized.surface.hints[0].text.trim() && synchronized.surface.hints[0].visible)) return finish([phaseErrors.runtime]);
  const initialState = synchronized.surface.common;
  if (!await resetToInitial(page, assessment, expectedInitial, initialState)) return finish([phaseErrors.reset]);

  let result = await runTrace(page, phaseErrors.wrong, playtest.wrong, assessment);
  if (!result.ok) return finish([result.phase]);
  const wrongStates = Object.values(result.surface.runtime.checkpoints);
  if (!wrongStates.includes('incorrect') || result.surface.runtime.complete || result.surface.runtime.pendingReview) {
    return finish([phaseErrors.wrong]);
  }

  result = await runTrace(page, phaseErrors.recover, playtest.recover, assessment);
  if (!result.ok || !isTerminal(result.surface.runtime, assessment.requiresReview)) return finish([result.phase || phaseErrors.recover]);

  if (!await resetToInitial(page, assessment, expectedInitial, initialState)) return finish([phaseErrors.reset]);
  result = await runTrace(page, phaseErrors.solve, playtest.solve, assessment);
  if (!result.ok || !isTerminal(result.surface.runtime, assessment.requiresReview)) return finish([result.phase || phaseErrors.solve]);

  const solvedBaseline = result.surface;
  const resetAndSolve = async () => {
    if (!await resetToInitial(page, assessment, expectedInitial, initialState)) return false;
    const replay = await runTrace(page, phaseErrors.solve, playtest.solve, assessment);
    return replay.ok && isTerminal(replay.surface.runtime, assessment.requiresReview) &&
      isDeepStrictEqual(replay.surface.runtime, solvedBaseline.runtime) &&
      isDeepStrictEqual(replay.surface.common, solvedBaseline.common);
  };
  const probes = await runIndependentAssessmentProbes(page, assessment, solvedBaseline, {
    sync: assertSynchronized, resetAndSolve,
  });
  if (probes.errors.length) return finish(probes.errors, probes.independentChecks);

  const beforeInvalidation = result.surface.runtime;
  let traceResult = await runTrace(page, phaseErrors.invalidate, playtest.invalidate, assessment);
  if (!traceResult.ok) return finish([traceResult.phase || phaseErrors.invalidate], probes.independentChecks);
  const changedFields = assessment.fields.filter(field => beforeInvalidation.values[field.id] !== traceResult.surface.runtime.values[field.id])
    .map(field => field.id);
  const confirmedUsesChangedField = assessment.checkpoints.some(checkpoint => {
    const state = beforeInvalidation.checkpoints[checkpoint.id];
    return ['correct', 'pending'].includes(state) && changedFields.some(field =>
      checkpoint.field === field || checkpoint.watchFields.includes(field) ||
      (checkpoint.rule.kind === 'relation' && exactMath.referencedFields(checkpoint.rule).includes(field)));
  });
  const invalidated = invalidatedCheckpointIds(assessment, changedFields);
  const invalidatedStatusesCleared = [...invalidated].every(id =>
    !['correct', 'pending'].includes(traceResult.surface.runtime.checkpoints[id]));
  if (!confirmedUsesChangedField || !invalidatedStatusesCleared || traceResult.surface.runtime.complete ||
      traceResult.surface.runtime.pendingReview) return finish([phaseErrors.invalidate], probes.independentChecks);

  if (!await resetToInitial(page, assessment, expectedInitial, initialState)) return finish([phaseErrors.reset], probes.independentChecks);
  traceResult = await runTrace(page, phaseErrors.replay, playtest.solve, assessment);
  if (!traceResult.ok || !isTerminal(traceResult.surface.runtime, assessment.requiresReview)) {
    return finish([traceResult.phase || phaseErrors.replay], probes.independentChecks);
  }
  if (!await resetToInitial(page, assessment, expectedInitial, initialState)) return finish([phaseErrors.reset], probes.independentChecks);
  return finish([], probes.independentChecks);
}
