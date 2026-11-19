import { buildSandboxDocument } from './sandbox.js';

const byId = (id) => document.getElementById(id);
const form = byId('problem-form');
const input = byId('problem');
const submit = byId('make-playable');
const cancel = byId('cancel-build');
const status = byId('build-status');
const sampleButton = byId('open-sample');
const sampleStatus = byId('sample-status');
const player = byId('player');
const playerTitle = byId('player-title');
const frame = byId('game-frame');
const submitted = byId('submitted-details');
const explanation = byId('explanation-details');
const formatter = new Intl.NumberFormat('en-US');
const availabilityCodes = new Set([
  'NOT_CONFIGURED', 'GENERATION_PAUSED', 'BUDGET_NOT_CONFIGURED', 'BUDGET_EXHAUSTED',
  'BUDGET_UNAVAILABLE', 'SESSION_LIMIT', 'SERVER_BUSY',
]);

const stages = {
  understanding: ['Understanding your problem…', 'Identifying what the player needs to figure out.'],
  building: ['Building your activity…', 'Turning the math into actions the player can try.'],
  checking: ['Checking the activity…', 'Checking that the activity loads and responds.'],
  repairing: ['Adjusting the activity…', 'Making one adjustment after a browser check.'],
};

let available = false;
let activeBuild = null;
let failedBuild = null;
let clarification = null;
let activity = null;
let playerRevision = 0;
let showingSample = false;
let sampleBuild = null;
let configCheckId = 0;

function updateSubmit() {
  submit.disabled = !available || Boolean(activeBuild);
  cancel.hidden = !activeBuild;
  byId('retry-failed').disabled = !available || Boolean(activeBuild);
}

function setAvailability(config) {
  available = typeof config.available === 'boolean' ? config.available : config.configured === true;
  const code = config.code || (config.configured === false ? 'NOT_CONFIGURED' : 'UNAVAILABLE');
  const notice = byId('config-notice');
  notice.hidden = available;
  byId('retry-availability').hidden = available;
  if (!available) {
    notice.dataset.kind = code === 'SERVER_BUSY' || code === 'SESSION_LIMIT' ? 'warning' : 'error';
    byId('config-title').textContent = 'Generation is unavailable';
    byId('config-message').textContent = availabilityMessage(code, config.retryAt);
  }
  updateSubmit();
}

function availabilityMessage(code, retryAt) {
  const retryTime = retryAt ? new Date(retryAt) : null;
  const localTime = retryTime && Number.isFinite(retryTime.getTime())
    ? retryTime.toLocaleString(undefined, { timeZoneName: 'short' }) : null;
  if (code === 'GENERATION_PAUSED' || code === 'BUDGET_EXHAUSTED') {
    return 'New activities are paused for now. The built-in preview is still available.';
  }
  if (code === 'SESSION_LIMIT') {
    return `You've reached the demo limit for now.${localTime ? ` Try again after ${localTime}.` : ' Please try again later.'}`;
  }
  if (code === 'SERVER_BUSY') return 'All generation slots are busy. Please try again shortly.';
  return 'Live generation is not available right now. You can still try the built-in preview.';
}

async function loadConfig() {
  const checkId = ++configCheckId;
  const retry = byId('retry-availability');
  retry.disabled = true;
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not check availability');
    const config = await response.json();
    if (typeof config.configured !== 'boolean') throw new Error('Invalid availability response');
    if (checkId === configCheckId) setAvailability(config);
  } catch {
    if (checkId === configCheckId) {
      setAvailability({ configured: false, available: false, code: 'UNAVAILABLE' });
    }
  } finally {
    if (checkId === configCheckId) retry.disabled = false;
  }
}

function displayStatus(kind, title, message) {
  status.dataset.kind = kind;
  byId('build-icon').textContent = { working: '', info: 'i', warning: '?', error: '!' }[kind] || '';
  byId('build-title').textContent = title;
  byId('build-message').textContent = message;
  status.hidden = false;
}

function clearProblemError() {
  byId('problem-error').hidden = true;
  input.removeAttribute('aria-invalid');
}

function showProblemError(message) {
  byId('problem-error').textContent = message;
  byId('problem-error').hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.focus({ preventScroll: true });
}

function validateProblem(raw) {
  const problem = raw.trim();
  if (!problem) {
    showProblemError('Add a math problem to get started.');
    return null;
  }
  if (problem.length > 10000) {
    showProblemError(`Keep the problem under 10,000 characters. Your text has ${formatter.format(problem.length)}.`);
    return null;
  }
  clearProblemError();
  return problem;
}

function updateElapsed(request) {
  if (activeBuild !== request) return;
  const seconds = Math.floor((Date.now() - request.startedAt) / 1000);
  byId('elapsed').textContent = `Waiting for ${formatter.format(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function clearRequestTimer(request) {
  clearInterval(request.interval);
  clearTimeout(request.timeout);
}

function setPreviousActivity(isPrevious) {
  if (!activity) return;
  activity.previous = isPrevious;
  byId('previous-activity').hidden = !isPrevious;
}

function endRequest(request) {
  if (activeBuild !== request) return false;
  clearRequestTimer(request);
  activeBuild = null;
  byId('draft-status').hidden = true;
  byId('elapsed').hidden = true;
  updateSubmit();
  return true;
}

function safeErrorMessage(message, fallback) {
  if (typeof message !== 'string' || !message.trim()) return fallback;
  if (/OPENAI_API_KEY|OPENAI_MODEL|environment variable/i.test(message)) return fallback;
  return message;
}

function failRequest(request, title, message, { code, retryAt, unavailable = false } = {}) {
  if (activeBuild !== request) return;
  if (unavailable || availabilityCodes.has(code)) {
    setAvailability({ configured: false, available: false, code, retryAt });
  }
  endRequest(request);
  failedBuild = {
    problem: request.problem,
    sourceDraft: request.sourceDraft,
  };
  byId('failed-problem').textContent = failedBuild.problem;
  byId('failed-problem-details').open = false;
  byId('failed-problem-details').hidden = false;
  byId('error-actions').hidden = false;
  displayStatus('error', title, safeErrorMessage(message, 'Please try again or edit the problem.'));
  setPreviousActivity(true);
}

function renderActivity(nextActivity) {
  const sandboxedHTML = buildSandboxDocument(nextActivity.html, { assessment: nextActivity.assessment });
  activity = nextActivity;
  showingSample = nextActivity.kind === 'sample';
  ++playerRevision;
  playerTitle.textContent = nextActivity.title;
  frame.title = `${nextActivity.title} — math activity`;
  byId('player-badge').textContent = showingSample ? 'Built-in preview' : 'AI-generated activity';
  byId('previous-activity').hidden = !nextActivity.previous;
  byId('player-source').textContent = showingSample ? 'Built-in preview' : 'Play the math';
  byId('activity-objective').textContent = nextActivity.objective || '';
  byId('activity-objective').hidden = !nextActivity.objective;
  byId('edit-problem').hidden = showingSample;
  submitted.hidden = showingSample;
  submitted.open = false;
  byId('submitted-problem').textContent = nextActivity.problem || '';
  byId('reference-answer').textContent = nextActivity.referenceAnswer || '';
  byId('explanation').textContent = nextActivity.explanation || '';
  byId('explanation-summary').textContent = 'See explanation';
  explanation.hidden = showingSample;
  explanation.open = false;
  frame.srcdoc = sandboxedHTML;
  player.hidden = false;
}

function beginRequest({ problem, sourceDraft, originalProblem = problem, supplement = null }) {
  if (!available || activeBuild) return;
  const focusWasInRequestUI = status.contains(document.activeElement)
    || document.activeElement === submit
    || Boolean(document.activeElement?.closest('#clarification-form'));
  invalidateSample();
  clarification = null;
  byId('clarification-area').hidden = true;
  byId('failed-problem-details').hidden = true;
  byId('failed-problem-details').open = false;
  byId('error-actions').hidden = true;
  failedBuild = null;
  byId('elapsed').textContent = 'Waiting for 0 seconds';
  byId('elapsed').hidden = false;
  const request = {
    controller: new AbortController(), problem, sourceDraft, originalProblem, supplement,
    startedAt: Date.now(), interval: null, timeout: null,
  };
  activeBuild = request;
  updateSubmit();
  displayStatus('working', 'Starting generation…', 'Generating from your submitted problem.');
  if (focusWasInRequestUI) status.focus({ preventScroll: true });
  request.interval = setInterval(() => updateElapsed(request), 1000);
  request.timeout = setTimeout(() => {
    if (activeBuild !== request) return;
    request.controller.abort();
    failRequest(request, 'Generation took too long', 'This generation took too long. You can try again.');
  }, 180000);
  void generate(request);
}

function notifyDraftChanged() {
  if (!activeBuild) {
    byId('draft-status').hidden = true;
    return;
  }
  const changed = input.value !== activeBuild.sourceDraft;
  byId('draft-status').textContent = changed
    ? 'Generating from your submitted problem. Edits will apply to the next generation.'
    : '';
  byId('draft-status').hidden = !changed;
}

async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let lineEnd;
      while ((lineEnd = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, lineEnd).trim();
        pending = pending.slice(lineEnd + 1);
        if (line) yield JSON.parse(line);
      }
      if (done) break;
    }
    if (pending.trim()) yield JSON.parse(pending);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function showClarification(request, question) {
  const waitingHadFocus = status.contains(document.activeElement) || document.activeElement === cancel;
  endRequest(request);
  clarification = {
    original: request.originalProblem,
    sourceDraft: request.sourceDraft,
    lastSupplement: request.supplement,
  };
  byId('clarification-original').textContent = request.originalProblem;
  byId('clarification-question').textContent = question;
  byId('additional-details').value = request.supplement || '';
  byId('additional-details-error').hidden = true;
  byId('clarification-area').hidden = false;
  byId('error-actions').hidden = true;
  displayStatus('warning', 'One detail is missing', 'Add the missing information to continue.');
  if (waitingHadFocus) byId('additional-details').focus({ preventScroll: true });
}

async function generate(request) {
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/x-ndjson' },
      body: JSON.stringify({ problem: request.problem }),
      signal: request.controller.signal,
    });
    if (activeBuild !== request) return;
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (activeBuild !== request) return;
      const code = data.code || (response.status === 503 ? 'NOT_CONFIGURED' : response.status === 429 ? 'SERVER_BUSY' : null);
      if (code && availabilityCodes.has(code)) {
        failRequest(request, 'Generation is unavailable', availabilityMessage(code, data.retryAt), { code, retryAt: data.retryAt, unavailable: true });
      } else {
        failRequest(request, 'Could not start the activity', data.error || 'Please try again.');
      }
      return;
    }

    for await (const event of readEvents(response)) {
      if (activeBuild !== request) return;
      if (event.type === 'stage' && Object.hasOwn(stages, event.stage)) {
        displayStatus('working', ...stages[event.stage]);
      } else if (event.type === 'clarification' || event.clarification) {
        showClarification(request, event.question || event.clarification?.question || 'Add the missing information.');
        return;
      } else if (event.type === 'error') {
        const code = event.code || null;
        const timeout = code === 'GENERATION_TIMEOUT';
        const unavailable = availabilityCodes.has(code);
        failRequest(request, timeout ? 'Generation took too long' : 'Could not finish this activity',
          timeout ? 'This generation took too long. You can try again.' : unavailable
            ? availabilityMessage(code, event.retryAt) : event.message || 'Please try again.',
          { code, retryAt: event.retryAt, unavailable });
        return;
      } else if (event.type === 'result' && event.game) {
        const game = event.game;
        const waitingHadFocus = status.contains(document.activeElement) || document.activeElement === cancel;
        endRequest(request);
        byId('error-actions').hidden = true;
        const nextActivity = {
          kind: 'generated', id: game.id, title: game.title, problem: game.problem ?? request.problem,
          html: game.html,
          assessment: game.assessment,
          referenceAnswer: game.referenceAnswer, explanation: game.explanation,
          objective: game.objective, sourceDraft: request.sourceDraft, previous: false,
        };
        renderActivity(nextActivity);
        displayStatus('success', 'Your activity is ready', 'Play the activity below or edit the problem to make another.');
        if (waitingHadFocus) playerTitle.focus({ preventScroll: true });
        return;
      }
    }
    if (activeBuild === request) failRequest(request, 'Could not finish this activity', 'The activity ended before a complete result arrived. Please try again.');
  } catch {
    if (activeBuild === request) failRequest(request, 'Could not connect to the lab', 'The activity could not be completed. You can try again.');
  }
}

function cancelGeneration({ returnFocus = true } = {}) {
  if (!activeBuild) return false;
  const request = activeBuild;
  activeBuild = null;
  clearRequestTimer(request);
  request.controller.abort();
  byId('draft-status').hidden = true;
  byId('elapsed').hidden = true;
  updateSubmit();
  displayStatus('info', 'Generation cancelled', 'Your draft is saved on this page.');
  if (returnFocus) input.focus({ preventScroll: true });
  return true;
}

function invalidateSample() {
  ++playerRevision;
  if (!sampleBuild) return;
  sampleBuild.controller.abort();
  sampleBuild = null;
  sampleButton.removeAttribute('aria-busy');
  sampleStatus.hidden = true;
}

function submitClarification(event) {
  event.preventDefault();
  if (!clarification || activeBuild) return;
  const supplement = byId('additional-details').value.trim();
  const error = byId('additional-details-error');
  if (!supplement) {
    error.textContent = 'Add details before generating with them.';
    error.hidden = false;
    byId('additional-details').focus({ preventScroll: true });
    return;
  }
  if (clarification.lastSupplement === supplement) {
    error.textContent = 'Add a different detail or edit the problem.';
    error.hidden = false;
    byId('additional-details').focus({ preventScroll: true });
    return;
  }
  const current = clarification;
  const combined = `${current.original}\n\nAdditional details: ${supplement}`;
  if (combined.length > 10000) {
    error.textContent = `Keep the problem and additional details under 10,000 characters. Their combined text has ${formatter.format(combined.length)}.`;
    error.hidden = false;
    byId('additional-details').focus({ preventScroll: true });
    return;
  }
  clarification = null;
  byId('clarification-area').hidden = true;
  beginRequest({ problem: combined, sourceDraft: current.sourceDraft, originalProblem: current.original, supplement });
}

function editProblem(problem = null, sourceDraft = null) {
  const snapshot = problem ?? (activity?.kind === 'generated' ? activity.problem : null);
  const source = sourceDraft ?? (activity?.kind === 'generated' ? activity.sourceDraft : null);
  const unchanged = !input.value.trim() || input.value === source;
  if (snapshot && unchanged) {
    input.value = snapshot;
    submitted.open = false;
  } else if (activity?.kind === 'generated') {
    submitted.open = true;
  }
  syncInput();
  input.focus({ preventScroll: true });
}

function syncInput() {
  byId('char-count').textContent = `${formatter.format(input.value.length)} / 10,000`;
  if (byId('problem-error').hidden === false) clearProblemError();
  updateSubmit();
  notifyDraftChanged();
}

input.addEventListener('input', syncInput);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (submit.disabled || activeBuild) return;
  const problem = validateProblem(input.value);
  if (problem === null) return;
  byId('error-actions').hidden = true;
  const sourceDraft = input.value;
  beginRequest({ problem, sourceDraft, originalProblem: problem });
});

byId('clarification-form').addEventListener('submit', submitClarification);

cancel.addEventListener('click', () => cancelGeneration());

byId('retry-failed').addEventListener('click', () => {
  if (!failedBuild || activeBuild || !available) return;
  beginRequest({ ...failedBuild });
});

byId('edit-failed').addEventListener('click', () => {
  if (!failedBuild) return;
  editProblem(failedBuild.problem, failedBuild.sourceDraft);
});

byId('retry-availability').addEventListener('click', async () => {
  byId('config-title').textContent = 'Checking availability';
  byId('config-message').textContent = 'Checking whether live generation is available.';
  await loadConfig();
});

byId('edit-problem').addEventListener('click', () => editProblem());

byId('explanation-summary').addEventListener('click', () => {
  requestAnimationFrame(() => {
    byId('explanation-summary').textContent = explanation.open ? 'Hide explanation' : 'See explanation';
  });
});

sampleButton.addEventListener('click', async () => {
  if (activeBuild) cancelGeneration({ returnFocus: false });
  if (showingSample) {
    playerTitle.focus({ preventScroll: true });
    return;
  }
  if (sampleBuild) return;
  const request = { controller: new AbortController(), revision: ++playerRevision };
  sampleBuild = request;
  sampleButton.setAttribute('aria-busy', 'true');
  sampleStatus.textContent = 'Opening the built-in preview…';
  sampleStatus.hidden = false;
  try {
    const response = await fetch('/samples/math-quest.html', { signal: request.controller.signal });
    if (!response.ok) throw new Error('Sample unavailable');
    const html = await response.text();
    if (sampleBuild !== request || request.revision !== playerRevision) return;
    renderActivity({ kind: 'sample', id: 'math-quest', title: 'Math Quest', html });
    if (status.dataset.kind === 'success') status.hidden = true;
    if (document.activeElement === sampleButton) playerTitle.focus({ preventScroll: true });
    sampleStatus.hidden = true;
  } catch {
    if (sampleBuild === request && request.revision === playerRevision) {
      sampleStatus.textContent = 'The sample did not load. Try again.';
      sampleStatus.hidden = false;
    }
  } finally {
    if (sampleBuild === request) {
      sampleBuild = null;
      sampleButton.removeAttribute('aria-busy');
    }
    if (request.revision !== playerRevision && !showingSample) sampleStatus.hidden = true;
  }
});

loadConfig();
syncInput();
