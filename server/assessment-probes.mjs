import { isDeepStrictEqual } from 'node:util';
import { createExactMath } from '../public/sandbox.js';

const exactMath = createExactMath();
const maximumProbeActions = 200;
const confirmed = state => state === 'correct' || state === 'pending';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function validateIndependentChecks(value, assessment) {
  if (!object(value) || Object.keys(value).sort().join(',') !==
      ['equivalentChecks', 'status', 'testedFields', 'untestedFields'].join(',') ||
      !['passed', 'partial'].includes(value.status) || !Number.isSafeInteger(value.equivalentChecks) ||
      value.equivalentChecks < 0 || !Array.isArray(value.testedFields) || !Array.isArray(value.untestedFields) ||
      !Array.isArray(assessment?.fields) || assessment.fields.some(field => !object(field) || typeof field.id !== 'string')) return false;
  const ids = assessment.fields.map(field => field.id);
  const tested = value.testedFields;
  const untested = value.untestedFields;
  if (tested.some(id => typeof id !== 'string') || untested.some(id => typeof id !== 'string') ||
      new Set(tested).size !== tested.length || new Set(untested).size !== untested.length ||
      tested.some(id => untested.includes(id))) return false;
  const partition = [...tested, ...untested];
  return partition.length === ids.length && new Set(partition).size === ids.length &&
    ids.every(id => partition.includes(id)) &&
    value.status === (untested.length ? 'partial' : 'passed');
}

export function emptyIndependentChecks(assessment) {
  const fields = Array.isArray(assessment?.fields)
    ? assessment.fields.filter(field => object(field) && typeof field.id === 'string').map(field => field.id) : [];
  return { status: fields.length ? 'partial' : 'passed', testedFields: [], untestedFields: fields,
    equivalentChecks: 0 };
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

function rational(numerator, denominator = 1n) {
  if (!denominator) return null;
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function parseDecimal(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) return null;
  const whole = match[2] ?? '0';
  const fractional = match[3] ?? match[4] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  return rational(sign * BigInt(`${whole}${fractional}`), 10n ** BigInt(fractional.length));
}

function parseRational(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const slash = value.indexOf('/');
  if (slash < 0) return parseDecimal(value);
  if (slash !== value.lastIndexOf('/')) return null;
  const numerator = parseDecimal(value.slice(0, slash));
  const denominator = parseDecimal(value.slice(slash + 1));
  if (!numerator || !denominator || denominator.numerator === 0n) return null;
  return rational(numerator.numerator * denominator.denominator,
    numerator.denominator * denominator.numerator);
}

function add(left, right) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function subtract(left, right) {
  return rational(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function compare(left, right) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function decimalString(value) {
  const normalized = rational(value.numerator, value.denominator);
  let denominator = normalized.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos += 1; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives += 1; }
  if (denominator !== 1n) return null;
  const places = Math.max(twos, fives);
  const multiplier = (2n ** BigInt(places - twos)) * (5n ** BigInt(places - fives));
  const scaled = normalized.numerator * multiplier;
  if (!places) return `${scaled}`;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const integer = digits.slice(0, -places) || '0';
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function fractionString(value) {
  return `${value.numerator}/${value.denominator}`;
}

function nearbyUnequal(value) {
  const target = parseRational(value);
  if (!target) return null;
  const neighbor = add(target, rational(1n, 10n ** 18n));
  return decimalString(neighbor) ?? fractionString(neighbor);
}

function equivalentStrings(value, controlType) {
  const target = parseRational(value);
  if (!target) return [];
  const fraction = `${target.numerator * 2n}/${target.denominator * 2n}`;
  const decimal = decimalString(target);
  const nativeDecimal = decimal ? `${decimal}${decimal.includes('.') ? '0' : '.0'}` : null;
  return controlType === 'number' ? [nativeDecimal].filter(Boolean) : [fraction, nativeDecimal].filter(Boolean);
}

function submitOrder(assessment) {
  const byId = new Map(assessment.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]));
  const result = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visited.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id)?.dependsOn ?? []) visit(parent);
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  for (const checkpoint of assessment.checkpoints) visit(checkpoint.id);
  return result;
}

function checkpointReferences(checkpoint) {
  return checkpoint.rule.kind === 'relation' ? exactMath.referencedFields(checkpoint.rule) : [];
}

function relatedCheckpointIds(assessment, fieldId) {
  const checkpoints = assessment.checkpoints;
  const related = new Set(checkpoints.filter(checkpoint => checkpoint.field === fieldId ||
    checkpoint.watchFields.includes(fieldId) || checkpointReferences(checkpoint).includes(fieldId))
    .map(checkpoint => checkpoint.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const checkpoint of checkpoints) {
      if (!related.has(checkpoint.id) && checkpoint.dependsOn.some(id => related.has(id))) {
        related.add(checkpoint.id);
        changed = true;
      }
    }
  }
  return related;
}

function rulesForField(assessment, fieldId) {
  return assessment.checkpoints.filter(checkpoint => checkpoint.field === fieldId ||
    checkpointReferences(checkpoint).includes(fieldId)).map(checkpoint => checkpoint.rule);
}

function gradeRule(rule, raw, values) {
  return rule.kind === 'relation' ? exactMath.grade('', rule, values) : exactMath.grade(raw, rule);
}

function checkpointStatus(checkpoint, values, statuses) {
  const ready = checkpoint.dependsOn.every(id => statuses[id] === 'correct' || statuses[id] === 'pending');
  return ready ? gradeRule(checkpoint.rule, values[checkpoint.field], values) : 'blocked';
}

function gradeIncorrect(candidate, rules, values, fieldId) {
  const context = { ...values, [fieldId]: candidate };
  return candidate !== null && rules.every(rule => gradeRule(rule, candidate, context) !== 'correct');
}

function textCandidates(baseline, rules, values, fieldId) {
  const result = [];
  for (const rule of rules) {
    if (rule.kind === 'exact') result.push(nearbyUnequal(rule.expected));
    if (rule.kind === 'approx') {
      const expected = parseRational(rule.expected);
      const tolerance = parseRational(rule.tolerance);
      if (expected && tolerance) result.push(decimalString(add(add(expected, tolerance), rational(1n, 10n ** 18n))) ??
        fractionString(add(add(expected, tolerance), rational(1n, 10n ** 18n))));
    }
    if (rule.kind === 'choice') result.push('__mpl_probe_wrong__', '0', '1', '2');
    if (rule.kind === 'quantity') {
      const expected = parseRational(rule.expected);
      if (expected) {
        const amount = add(expected, rational(1n));
        result.push(`${decimalString(amount) ?? fractionString(amount)} ${rule.unit}`);
      }
    }
    if (rule.kind === 'range') {
      if (rule.lower !== '-inf') result.push(decimalString(subtract(parseRational(rule.lower), rational(1n))));
      if (rule.upper !== 'inf') result.push(decimalString(add(parseRational(rule.upper), rational(1n))));
    }
    if (rule.kind === 'interval') result.push('__mpl_probe_wrong__');
    if (rule.kind === 'review') result.push('__mpl_probe_changed__');
  }
  result.push('__mpl_probe_changed__', '0', '1', '2', 'x');
  const candidates = [...new Set(result.filter(value => typeof value === 'string' && value.length <= 4096 && value !== baseline))];
  const incorrect = candidates.filter(candidate => !rules.length || gradeIncorrect(candidate, rules, values, fieldId));
  return incorrect.length ? incorrect : candidates;
}

function numericCandidates(info, baseline, rules, values, fieldId) {
  const base = parseRational(baseline);
  const step = info.step && info.step !== 'any' ? parseRational(info.step) : rational(1n);
  const result = [];
  for (const rule of rules) {
    if (rule.kind === 'exact') result.push(nearbyUnequal(rule.expected));
  }
  if (base && step) {
    result.push(decimalString(add(base, step)), decimalString(subtract(base, step)),
      decimalString(add(base, add(step, step))), decimalString(subtract(base, add(step, step))));
  }
  if (base) result.push(decimalString(add(base, rational(1n))), decimalString(subtract(base, rational(1n))));
  const unique = [...new Set(result.filter(value => typeof value === 'string' && value !== baseline && value.length <= 256))];
  const incorrect = unique.filter(candidate => !rules.length || gradeIncorrect(candidate, rules, values, fieldId));
  const selected = incorrect.length ? incorrect : unique;
  return selected.map(value => ({ value, nearby: rules.some(rule => rule.kind === 'exact' &&
    value === nearbyUnequal(rule.expected)) }));
}

async function inspectLocator(locator) {
  try {
    return await locator.evaluate(element => {
      const style = getComputedStyle(element);
      const tag = element.tagName;
      const type = tag === 'INPUT' ? element.type.toLowerCase() : '';
      let kind = null;
      if (tag === 'TEXTAREA') kind = 'text';
      else if (tag === 'SELECT') kind = 'select';
      else if (tag === 'INPUT' && ['text', 'number', 'range'].includes(type)) kind = type;
      const validity = element.validity;
      return { fieldId: element.getAttribute('data-mpl-field'), kind, tag, type, value: element.value,
        visible: element.getClientRects().length > 0 && style.display !== 'none' &&
          !['hidden', 'collapse'].includes(style.visibility), enabled: !element.disabled,
        readOnly: Boolean(element.readOnly), valid: validity?.valid !== false, customError: validity?.customError ?? false,
        min: element.min ?? '',
        max: element.max ?? '', step: element.step ?? '', maxLength: element.maxLength ?? -1,
        options: tag === 'SELECT' ? Array.from(element.options, option => ({ value: option.value,
          disabled: option.matches(':disabled'), selected: option.selected })) : [] };
    });
  } catch { return null; }
}

async function controlsForField(page, fieldId) {
  const all = page.locator('[data-mpl-field]');
  const result = [];
  for (let index = 0; index < await all.count(); index += 1) {
    const locator = all.nth(index);
    const info = await inspectLocator(locator);
    if (info?.fieldId === fieldId && info.kind && info.visible && info.enabled && !info.readOnly) {
      result.push({ locator, info, index });
    }
  }
  return result;
}

async function actualValue(locator) {
  try {
    const [value, validity] = await Promise.all([
      locator.inputValue(), locator.evaluate(element => ({ valid: element.validity?.valid !== false,
        customError: element.validity?.customError ?? false })),
    ]);
    return { value, valid: validity.valid, customError: validity.customError };
  } catch { return null; }
}

async function applyCandidate(control, candidate, actions) {
  if (actions.count >= maximumProbeActions) return { ok: false, exhausted: true };
  actions.count += 1;
  try {
    if (control.info.kind === 'select') await control.locator.selectOption(candidate.value);
    else if (control.info.kind === 'range') await control.locator.press(candidate.direction);
    else await control.locator.fill(candidate.value);
  } catch { return { ok: false, actionFailed: true }; }
  const observed = await actualValue(control.locator);
  if (!observed) return { ok: false, actionFailed: true };
  return { ok: true, observed };
}

function candidateValues(control, baseline, rules, values, fieldId) {
  if (control.info.kind === 'select') {
    const options = control.info.options.filter(option => !option.disabled && option.value !== baseline);
    const wrong = options.find(option => !rules.length || gradeIncorrect(option.value, rules, values, fieldId));
    return (wrong ? [wrong] : options.slice(0, 1)).map(option => ({ value: option.value }));
  }
  if (control.info.kind === 'range') {
    const current = parseRational(baseline);
    if (!current) return [];
    const step = control.info.step && control.info.step !== 'any' ? parseRational(control.info.step) : rational(1n);
    if (!step) return [];
    const candidates = [add(current, step), subtract(current, step)];
    return candidates.filter(value => decimalString(value) !== null && decimalString(value) !== baseline)
      .map(value => ({ value: decimalString(value), direction: compare(value, current) > 0 ? 'ArrowUp' : 'ArrowDown' }));
  }
  if (control.info.kind === 'number') return numericCandidates(control.info, baseline, rules, values, fieldId);
  const maxLength = control.info.maxLength < 0 ? 4096 : control.info.maxLength;
  return textCandidates(baseline, rules, values, fieldId).filter(value => value.length <= maxLength).map(value => ({ value }));
}

function equivalentCandidates(control, baseline, rules, values, fieldId) {
  const exactRules = rules.filter(rule => rule.kind === 'exact');
  const relationRules = rules.filter(rule => rule.kind === 'relation');
  if ((!exactRules.length && !relationRules.length) || control.info.kind === 'range') return [];
  let candidates;
  if (control.info.kind === 'select') {
    candidates = control.info.options.filter(option => !option.disabled && option.value !== baseline &&
      (!relationRules.length || exactMath.equals(option.value, baseline)) &&
      rules.every(rule => ['correct', 'pending'].includes(gradeRule(rule, option.value, { ...values, [fieldId]: option.value })))).map(option => option.value);
  } else {
    candidates = [
      ...exactRules.flatMap(rule => equivalentStrings(rule.expected, control.info.kind)),
      ...(relationRules.length ? equivalentStrings(baseline, control.info.kind) : []),
    ];
  }
  const maxLength = control.info.kind === 'text' && control.info.maxLength >= 0
    ? control.info.maxLength : 4096;
  return [...new Set(candidates.filter(value => typeof value === 'string' && value !== baseline && value.length <= maxLength))]
    .filter(value => rules.every(rule => ['correct', 'pending'].includes(gradeRule(rule, value, { ...values, [fieldId]: value }))))
    .map(value => ({ value, equivalent: true }));
}

function expectedInvalidation(assessment, baseline, after, fieldId) {
  const affected = relatedCheckpointIds(assessment, fieldId);
  const changed = assessment.fields.some(field => baseline.runtime.values[field.id] !== after.runtime.values[field.id]);
  if (!changed || baseline.runtime.values[fieldId] === after.runtime.values[fieldId]) return false;
  if (after.runtime.complete || after.runtime.pendingReview) return false;
  for (const checkpoint of assessment.checkpoints) {
    const before = baseline.runtime.checkpoints[checkpoint.id];
    const current = after.runtime.checkpoints[checkpoint.id];
    if (affected.has(checkpoint.id) && confirmed(before) && confirmed(current)) return false;
    if (!affected.has(checkpoint.id) && current !== before) return false;
  }
  return true;
}

async function submitRelated(page, assessment, fieldId, sync, actions) {
  const affected = relatedCheckpointIds(assessment, fieldId);
  for (const id of submitOrder(assessment)) {
    if (!affected.has(id)) continue;
    if (actions.count >= maximumProbeActions) return false;
    actions.count += 1;
    const button = page.locator(`[data-mpl-submit="${id}"]`);
    if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) return false;
    try { await button.click(); } catch { return false; }
    if (!(await sync(page, assessment)).ok) return false;
  }
  return true;
}

async function restoreField(page, assessment, fieldId, control, baseline, sync, actions, resetAndSolve) {
  if (actions.count >= maximumProbeActions) return resetAndSolve();
  actions.count += 1;
  try {
    if (control.info.kind === 'select') await control.locator.selectOption(baseline.runtime.values[fieldId]);
    else await control.locator.fill(baseline.runtime.values[fieldId]);
  } catch { return resetAndSolve(); }
  if (!(await sync(page, assessment)).ok ||
      !await submitRelated(page, assessment, fieldId, sync, actions)) return resetAndSolve();
  const restored = await sync(page, assessment);
  if (!restored.ok || !isDeepStrictEqual(restored.surface.runtime, baseline.runtime) ||
      !isDeepStrictEqual(restored.surface.common, baseline.common)) return resetAndSolve();
  return true;
}

async function probeOne(page, assessment, field, control, baseline, sync, actions, resetAndSolve) {
  const fieldId = field.id;
  const beforeValue = baseline.runtime.values[fieldId];
  const rules = rulesForField(assessment, fieldId);
  const candidates = candidateValues(control, beforeValue, rules, baseline.runtime.values, fieldId).slice(0, 3);
  if (!candidates.length) return { tested: false, equivalentChecks: 0 };
  const failure = (phase, requested, observed) => {
    const shown = value => typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : 'unavailable';
    const message = `Independent assessment probe failed for field ${fieldId} during ${phase}: requested=${shown(requested)} observed=${shown(observed)}.`;
    return { tested: true, error: message.slice(0, 500), equivalentChecks: 0 };
  };

  let changed = false;
  for (const candidate of candidates) {
    const result = await applyCandidate(control, candidate, actions);
    if (result.exhausted || !result.ok) return failure('edit', candidate.value, null);
    const observed = result.observed.value;
    if (observed === beforeValue) {
      if ((control.info.kind === 'number' && !candidate.nearby) || control.info.kind === 'range') continue;
      return failure('raw-preservation', candidate.value, observed);
    }
    if ((control.info.kind === 'text' || control.info.kind === 'select') && observed !== candidate.value) {
      return failure('raw-preservation', candidate.value, observed);
    }
    if ((control.info.kind === 'number' || control.info.kind === 'range') &&
        !exactMath.equals(observed, candidate.value)) return failure('raw-preservation', candidate.value, observed);
    const synchronized = await sync(page, assessment);
    if (!synchronized.ok || synchronized.surface.runtime.values[fieldId] !== observed ||
        !expectedInvalidation(assessment, baseline, synchronized.surface, fieldId))
      return failure('invalidation', candidate.value, observed);
    changed = true;
    if (!result.observed.valid) {
      if (!await restoreField(page, assessment, fieldId, control, baseline, sync, actions, resetAndSolve)) {
        return failure('recovery', beforeValue, null);
      }
      break;
    }
    const directRules = rules;
    if (directRules.some(rule => rule.kind === 'relation' ||
        (rule.kind === 'exact' && exactMath.grade(observed, rule) === 'incorrect'))) {
      if (!await submitRelated(page, assessment, fieldId, sync, actions))
        return failure('invalidation', candidate.value, observed);
      const checked = await sync(page, assessment);
      if (!checked.ok) return failure('invalidation', candidate.value, observed);
      const afterSubmit = checked.surface;
      for (const checkpoint of assessment.checkpoints.filter(item =>
        (item.field === fieldId && item.rule.kind === 'exact') || checkpointReferences(item).includes(fieldId))) {
        const expected = checkpointStatus(checkpoint, afterSubmit.runtime.values, afterSubmit.runtime.checkpoints);
        if (expected !== afterSubmit.runtime.checkpoints[checkpoint.id])
          return failure('invalidation', candidate.value, observed);
      }
    }
    if (!await restoreField(page, assessment, fieldId, control, baseline, sync, actions, resetAndSolve)) {
      return failure('recovery', beforeValue, null);
    }
    break;
  }
  if (!changed) return { tested: false, equivalentChecks: 0 };

  const restoredBaseline = await sync(page, assessment);
  if (!restoredBaseline.ok || !isDeepStrictEqual(restoredBaseline.surface.runtime, baseline.runtime) ||
      !isDeepStrictEqual(restoredBaseline.surface.common, baseline.common)) return failure('recovery', beforeValue, null);
  const equivalent = equivalentCandidates(control, beforeValue, rules, baseline.runtime.values, fieldId)[0];
  if (!equivalent) return { tested: true, equivalentChecks: 0 };
  const applied = await applyCandidate(control, equivalent, actions);
  if (applied.exhausted || !applied.ok) return failure('equivalent', equivalent.value, null);
  const equivalentRaw = applied.observed.value;
  if (equivalentRaw === beforeValue && control.info.kind === 'number') return { tested: true, equivalentChecks: 0 };
  if (equivalentRaw === beforeValue ||
      (['text', 'select'].includes(control.info.kind) && equivalentRaw !== equivalent.value) ||
      (control.info.kind === 'number' && !exactMath.equals(equivalentRaw, equivalent.value))) {
    return failure('equivalent', equivalent.value, equivalentRaw);
  }
  const equivalentState = await sync(page, assessment);
  if (!equivalentState.ok || !expectedInvalidation(assessment, baseline, equivalentState.surface, fieldId)) {
    return failure('equivalent', equivalent.value, equivalentRaw);
  }
  if (applied.observed.customError || !rules.every(rule => ['correct', 'pending'].includes(
    gradeRule(rule, equivalentRaw, { ...baseline.runtime.values, [fieldId]: equivalentRaw })))) {
    return failure('equivalent', equivalent.value, equivalentRaw);
  }
  if (!applied.observed.valid) {
    if (!await restoreField(page, assessment, fieldId, control, baseline, sync, actions, resetAndSolve)) {
      return failure('recovery', beforeValue, null);
    }
    return { tested: true, equivalentChecks: 0 };
  }
  if (!await submitRelated(page, assessment, fieldId, sync, actions)) return failure('equivalent', equivalent.value, equivalentRaw);
  const resubmitted = (await sync(page, assessment)).surface;
  for (const checkpoint of assessment.checkpoints.filter(item =>
    (item.field === fieldId && item.rule.kind === 'exact') || checkpointReferences(item).includes(fieldId))) {
    const expected = checkpointStatus(checkpoint, resubmitted.runtime.values, resubmitted.runtime.checkpoints);
    if (expected !== resubmitted.runtime.checkpoints[checkpoint.id]) {
      return failure('equivalent', equivalent.value, equivalentRaw);
    }
  }
  if (!await restoreField(page, assessment, fieldId, control, baseline, sync, actions, resetAndSolve)) {
    return failure('recovery', beforeValue, null);
  }
  return { tested: true, equivalentChecks: 1 };
}

export async function runIndependentAssessmentProbes(page, assessment, baseline, { sync, resetAndSolve } = {}) {
  const tested = [];
  const untested = [];
  let equivalentChecks = 0;
  const actions = { count: 0 };
  for (const field of assessment.fields) {
    const related = relatedCheckpointIds(assessment, field.id);
    if (!related.size || ![...related].some(id => confirmed(baseline.runtime.checkpoints[id]))) {
      untested.push(field.id);
      continue;
    }
    const controls = await controlsForField(page, field.id);
    if (!controls.length) {
      untested.push(field.id);
      continue;
    }
    const result = await probeOne(page, assessment, field, controls[0], baseline, sync, actions, resetAndSolve);
    if (result.tested) tested.push(field.id);
    else untested.push(field.id);
    equivalentChecks += result.equivalentChecks;
    if (result.error) {
      for (const remaining of assessment.fields) {
        if (!tested.includes(remaining.id) && !untested.includes(remaining.id)) untested.push(remaining.id);
      }
      return { errors: [result.error], independentChecks: {
        status: untested.length ? 'partial' : 'passed', testedFields: tested, untestedFields: untested,
        equivalentChecks,
      } };
    }
  }
  return { errors: [], independentChecks: { status: untested.length ? 'partial' : 'passed',
    testedFields: tested, untestedFields: untested, equivalentChecks } };
}
