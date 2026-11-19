export function createActivityRuntime(assessment, math) {
  const idPattern = /^[a-z][a-z0-9_-]{0,39}$/;
  const runtimeKey = Symbol.for('mathPlayLabActivityRuntimePrivate');

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }

  function exactKeys(value, keys) {
    return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  }

  function validId(value) { return typeof value === 'string' && idPattern.test(value); }

  function fail() { throw new TypeError('Invalid activity assessment.'); }

  if (!exactKeys(assessment, ['version', 'requiresReview', 'fields', 'checkpoints']) || assessment.version !== 1 ||
      typeof assessment.requiresReview !== 'boolean' || !Array.isArray(assessment.fields) ||
      assessment.fields.length < 1 || assessment.fields.length > 40 || !Array.isArray(assessment.checkpoints) ||
      assessment.checkpoints.length < 1 || assessment.checkpoints.length > 40 ||
      !math || typeof math.validRule !== 'function' || typeof math.grade !== 'function') fail();
  const requiresReview = assessment.requiresReview;

  const fields = [];
  const fieldIds = new Set();
  for (const field of assessment.fields) {
    if (!exactKeys(field, ['id', 'initial']) || !validId(field.id) || fieldIds.has(field.id) ||
        typeof field.initial !== 'string' || field.initial.length > 4096) fail();
    fieldIds.add(field.id);
    fields.push({ id: field.id, initial: field.initial });
  }

  const checkpointIds = new Set();
  const relationFieldsByCheckpoint = new Map();
  for (const checkpoint of assessment.checkpoints) {
    if (!exactKeys(checkpoint, ['id', 'field', 'dependsOn', 'watchFields', 'rule', 'feedback']) ||
        !validId(checkpoint.id) || checkpointIds.has(checkpoint.id) || !fieldIds.has(checkpoint.field) ||
        !Array.isArray(checkpoint.dependsOn) || !Array.isArray(checkpoint.watchFields) ||
        typeof checkpoint.feedback !== 'string' || !checkpoint.feedback.trim() || checkpoint.feedback.length > 1000 ||
        !math.validRule(checkpoint.rule) || (checkpoint.rule.kind === 'review' && !assessment.requiresReview)) fail();
    if (checkpoint.rule.kind === 'relation') {
      if (typeof math.referencedFields !== 'function') fail();
      let references;
      try { references = math.referencedFields(checkpoint.rule); } catch { fail(); }
      if (!Array.isArray(references) || !references.includes(checkpoint.field) ||
          references.some(id => !fieldIds.has(id))) fail();
      relationFieldsByCheckpoint.set(checkpoint.id, references);
    }
    checkpointIds.add(checkpoint.id);
  }

  const checkpoints = [];
  const checkpointById = new Map();
  for (const checkpoint of assessment.checkpoints) {
    const dependencies = new Set();
    for (const id of checkpoint.dependsOn) {
      if (!validId(id) || !checkpointIds.has(id) || dependencies.has(id)) fail();
      dependencies.add(id);
    }
    const relationFields = relationFieldsByCheckpoint.get(checkpoint.id) ?? [];
    const watchedFields = new Set([checkpoint.field, ...relationFields]);
    const explicitWatchFields = new Set();
    for (const id of checkpoint.watchFields) {
      if (!validId(id) || !fieldIds.has(id) || explicitWatchFields.has(id) ||
          (watchedFields.has(id) && id !== checkpoint.field && !relationFields.includes(id))) fail();
      explicitWatchFields.add(id);
      watchedFields.add(id);
    }
    const item = { id: checkpoint.id, field: checkpoint.field, dependsOn: [...dependencies],
      watchedFields: [...watchedFields], rule: JSON.parse(JSON.stringify(checkpoint.rule)), feedback: checkpoint.feedback };
    checkpoints.push(item);
    checkpointById.set(item.id, item);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail();
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of checkpointById.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const item of checkpoints) visit(item.id);

  const initialValues = Object.fromEntries(fields.map(field => [field.id, field.initial]));
  const values = { ...initialValues };
  const statuses = Object.fromEntries(checkpoints.map(item => [item.id, 'unanswered']));
  const listeners = new Set();
  const feedback = Object.freeze(Object.fromEntries(checkpoints.map(item => [item.id, item.feedback])));
  const metadata = Object.freeze({ fieldIds: Object.freeze(fields.map(field => field.id)),
    checkpointIds: Object.freeze(checkpoints.map(item => item.id)), feedback });

  function getState() {
    const states = { ...statuses };
    const allCorrect = checkpoints.every(item => states[item.id] === 'correct');
    const pendingReview = requiresReview && checkpoints.every(item =>
      states[item.id] === 'correct' || states[item.id] === 'pending');
    return { values: { ...values }, checkpoints: states, complete: allCorrect && !requiresReview, pendingReview };
  }

  function emit() {
    let listenerError;
    let listenerFailed = false;
    for (const listener of listeners) {
      try { listener(getState()); } catch (error) {
        if (!listenerFailed) listenerError = error;
        listenerFailed = true;
      }
    }
    if (listenerFailed) throw listenerError;
  }

  function invalidate(fieldId) {
    const affected = new Set(checkpoints.filter(item => item.watchedFields.includes(fieldId)).map(item => item.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of checkpoints) {
        if (!affected.has(item.id) && item.dependsOn.some(id => affected.has(id))) {
          affected.add(item.id);
          changed = true;
        }
      }
    }
    for (const id of affected) statuses[id] = 'unanswered';
  }

  function set(fieldId, rawString) {
    if (!Object.hasOwn(values, fieldId)) throw new TypeError('Unknown activity field.');
    if (typeof rawString !== 'string' || rawString.length > 4096) {
      values[fieldId] = '';
      invalidate(fieldId);
      emit();
      if (typeof rawString !== 'string') throw new TypeError('Activity values must be strings.');
      const error = new RangeError('Activity value exceeds 4096 characters.');
      error.code = 'ACTIVITY_VALUE_TOO_LONG';
      throw error;
    }
    if (values[fieldId] === rawString) return getState();
    values[fieldId] = rawString;
    invalidate(fieldId);
    emit();
    return getState();
  }

  function submit(checkpointId) {
    const checkpoint = checkpointById.get(checkpointId);
    if (!checkpoint) throw new TypeError('Unknown activity checkpoint.');
    const prerequisitesReady = checkpoint.dependsOn.every(id =>
      statuses[id] === 'correct' || statuses[id] === 'pending');
    statuses[checkpointId] = prerequisitesReady ? math.grade(values[checkpoint.field], checkpoint.rule, values) : 'blocked';
    emit();
    return statuses[checkpointId];
  }

  function reset() {
    for (const field of fields) values[field.id] = field.initial;
    for (const checkpoint of checkpoints) statuses[checkpoint.id] = 'unanswered';
    emit();
    return getState();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Activity listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const activity = { set, submit, reset, getState, subscribe };
  Object.defineProperty(activity, runtimeKey, { value: metadata, writable: false, configurable: false, enumerable: false });
  return Object.freeze(activity);
}

export function bindActivityRuntime(activity, document) {
  const metadata = activity?.[Symbol.for('mathPlayLabActivityRuntimePrivate')];
  if (!metadata || typeof activity.getState !== 'function' || typeof activity.set !== 'function' ||
      typeof activity.submit !== 'function' || typeof activity.reset !== 'function' ||
      typeof activity.subscribe !== 'function' || !document?.querySelectorAll) {
    throw new TypeError('Invalid activity binding.');
  }

  const fields = new Map(metadata.fieldIds.map(id => [id, []]));
  const feedback = new Map(metadata.checkpointIds.map(id => [id, []]));
  const removers = [];
  for (const element of document.querySelectorAll('[data-mpl-field]')) {
    const id = element.getAttribute('data-mpl-field');
    const supported = element.tagName === 'INPUT' ? ['text', 'number', 'range'].includes(element.type)
      : ['SELECT', 'TEXTAREA'].includes(element.tagName);
    if (!fields.has(id) || !supported) throw new TypeError('Unsupported bound activity field.');
    fields.get(id).push(element);
    const update = () => {
      if (element.value.length > 4096) {
        try { activity.set(id, element.value); }
        catch (error) {
          if (!(error instanceof RangeError) || error.code !== 'ACTIVITY_VALUE_TOO_LONG') throw error;
        }
        element.value = activity.getState().values[id];
        element.setCustomValidity('Entries are limited to 4096 characters. The oversized entry was cleared.');
        element.setAttribute('aria-invalid', 'true');
        element.reportValidity();
        return;
      }
      element.setCustomValidity('');
      element.removeAttribute('aria-invalid');
      activity.set(id, element.value);
    };
    element.addEventListener('input', update);
    element.addEventListener('change', update);
    removers.push(() => { element.removeEventListener('input', update); element.removeEventListener('change', update); });
  }

  for (const element of document.querySelectorAll('[data-mpl-submit]')) {
    const id = element.getAttribute('data-mpl-submit');
    if (!metadata.checkpointIds.includes(id) || element.tagName !== 'BUTTON') continue;
    const submit = event => { event.preventDefault(); activity.submit(id); };
    element.addEventListener('click', submit);
    removers.push(() => element.removeEventListener('click', submit));
  }

  for (const element of document.querySelectorAll('[data-mpl-feedback]')) {
    const id = element.getAttribute('data-mpl-feedback');
    if (!feedback.has(id)) continue;
    feedback.get(id).push(element);
  }

  const statusElements = [...document.querySelectorAll('#mpl-status')];
  const resetElements = [...document.querySelectorAll('#mpl-reset')];
  const render = snapshot => {
    for (const [id, elements] of fields) {
      for (const element of elements) {
        if (element.value !== snapshot.values[id]) element.value = snapshot.values[id];
        element.setCustomValidity('');
        element.removeAttribute('aria-invalid');
      }
    }
    for (const [id, elements] of feedback) {
      const state = snapshot.checkpoints[id];
      const text = state === 'correct' ? 'Correct.' : state === 'incorrect' ? metadata.feedback[id]
        : state === 'blocked' ? 'Complete the prior step first.' : state === 'pending' ? 'Ready for review.' : '';
      for (const element of elements) {
        element.dataset.state = state;
        element.textContent = text;
      }
    }
    const state = snapshot.complete ? 'complete' : snapshot.pendingReview ? 'pending' : 'incomplete';
    const text = state === 'complete' ? 'Complete.' : state === 'pending' ? 'Ready for independent review.' : 'In progress.';
    for (const element of statusElements) {
      element.dataset.state = state;
      element.textContent = text;
    }
  };

  const unsubscribe = activity.subscribe(render);
  for (const element of resetElements) {
    const reset = event => {
      event.preventDefault();
      activity.reset();
    };
    element.addEventListener('click', reset);
    removers.push(() => element.removeEventListener('click', reset));
  }
  render(activity.getState());
  return () => { unsubscribe(); for (const remove of removers) remove(); };
}
