import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const chromePath = process.env.BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
let baseUrl;
let context;
let page;
let calls;
let generateQueue;
let sampleQueue;
let configQueue;
let requests;

function resultEvent(problem, title = 'Explore the equation') {
  return { type: 'result', game: {
    id: title.toLowerCase().replaceAll(' ', '-'), title,
    html: `<!doctype html><html><body><h1>${title}</h1></body></html>`,
    referenceAnswer: 'x = 4', explanation: 'Subtract 3, then divide by 2.',
    verification: { runtime: 'passed' },
  } };
}

async function fulfill(route, status, body, contentType) {
  try { await route.fulfill({ status, body, contentType }); } catch { /* The browser may have aborted this fixture request. */ }
}

before(async () => {
  baseUrl = 'http://math-play-lab.test/';
  browser = await chromium.launch({ executablePath: existsSync(chromePath) ? chromePath : undefined, headless: true });
});

after(async () => {
  await browser?.close();
});

beforeEach(() => {
  calls = [];
  generateQueue = [];
  sampleQueue = [];
  configQueue = [];
  requests = [];
});

afterEach(async () => {
  await context?.close();
  context = null;
  page = null;
});

async function openPage(viewport = { width: 1100, height: 850 }) {
  context = await browser.newContext({ viewport });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname });
    if (request.method() === 'GET' && url.pathname === '/api/config') {
      const value = configQueue.shift() ?? { configured: true, imageInput: false };
      return fulfill(route, 200, JSON.stringify(value), 'application/json');
    }
    if (request.method() === 'POST' && url.pathname === '/api/generate') {
      const problem = request.postDataJSON().problem;
      calls.push(problem);
      const handler = generateQueue.shift();
      if (handler) return handler(problem, route);
      return fulfill(route, 200, `${JSON.stringify({ type: 'stage', stage: 'understanding' })}\n${JSON.stringify(resultEvent(problem))}\n`, 'application/x-ndjson');
    }
    if (request.method() === 'GET' && url.pathname === '/samples/math-quest.html') {
      const handler = sampleQueue.shift();
      if (handler) return handler(route);
      return fulfill(route, 200, await readFile(path.join(publicRoot, 'samples/math-quest.html'), 'utf8'), 'text/html');
    }
    const files = new Map([
      ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
      ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
      ['/sandbox.js', ['sandbox.js', 'text/javascript']],
      ['/activity-runtime.js', ['activity-runtime.js', 'text/javascript']],
    ]);
    const file = files.get(url.pathname);
    if (!file) return fulfill(route, 404, JSON.stringify({ error: 'Not found.' }), 'application/json');
    return fulfill(route, 200, await readFile(path.join(publicRoot, file[0]), 'utf8'), file[1]);
  });
  page = await context.newPage();
  page.setDefaultTimeout(3000);
  await page.goto(baseUrl);
  await page.waitForFunction(() => {
    const notice = document.querySelector('#config-notice');
    return notice?.hidden || document.querySelector('#config-title')?.textContent !== 'Connecting to the lab';
  });
  return page;
}

function holdGeneration() {
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  let route;
  generateQueue.push((problem, requestRoute) => {
    route = requestRoute;
    startedResolve({ problem, route: requestRoute });
  });
  return {
    started,
    async finish(event) {
      await fulfill(route, 200, `${JSON.stringify(event)}\n`, 'application/x-ndjson');
    },
    async finishResult(title) { await this.finish(resultEvent('', title)); },
  };
}

async function openSample() {
  await page.getByRole('button', { name: 'Try an interactive preview' }).click();
  await page.waitForFunction(() => document.querySelector('#player') && !document.querySelector('#player').hidden && document.querySelector('#player-title')?.textContent === 'Math Quest');
  await page.waitForFunction(() => document.querySelector('#open-sample')?.getAttribute('aria-busy') !== 'true');
  assert.equal(await page.getByRole('button', { name: 'Try an interactive preview' }).getAttribute('aria-busy'), null);
}

async function submitProblem(problem) {
  await page.locator('#problem').fill(problem);
  await page.getByRole('button', { name: /Make it playable/ }).click();
}

test('the homepage focuses on freeform problem generation and submits the entered prompt', async () => {
  await openPage({ width: 390, height: 844 });
  assert.equal(await page.locator('#curriculum').count(), 0);
  assert.equal(await page.locator('#curriculum-stage').count(), 0);
  assert.equal(await page.locator('.how-steps li').count(), 3);
  assert.equal(await page.locator('#player').isVisible(), false);
  assert.equal(requests.some(request => request.path.includes('curriculum')), false,
    'the homepage does not fetch either catalog projection');
  assert.equal(calls.length, 0, 'opening the page does not generate an activity');

  const problem = 'Explain why x²−5x+6 factors as (x−2)(x−3), then solve x²−5x+6=0.';
  const held = holdGeneration();
  await submitProblem(problem);
  const request = await held.started;
  assert.equal(request.problem, problem);
  assert.deepEqual(calls, [problem]);
  await held.finish(resultEvent(problem, 'Factoring and roots'));
  await page.getByRole('heading', { name: 'Factoring and roots' }).waitFor();
  assert.equal(await page.locator('#submitted-problem').textContent(), problem);
});

test('blank and oversized drafts stay editable and fail visibly without a request', async () => {
  await openPage();
  const input = page.locator('#problem');
  const submit = page.getByRole('button', { name: /Make it playable/ });
  assert.equal(await submit.isEnabled(), true, 'empty input can be submitted for validation');
  await submit.click();
  assert.match(await page.locator('#problem-error').textContent(), /Add a math problem/);
  assert.equal(await input.evaluate(el => el.getAttribute('aria-invalid')), 'true');
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  assert.equal(calls.length, 0);

  const oversized = 'x'.repeat(10001);
  await input.fill(oversized);
  await submit.click();
  assert.equal(await input.inputValue(), oversized, 'oversized paste is never truncated');
  assert.match(await page.locator('#problem-error').textContent(), /10,000/);
  assert.equal(calls.length, 0);

  await input.fill('x'.repeat(10000));
  const held = holdGeneration();
  await submit.click();
  const request = await held.started;
  assert.equal(request.problem.length, 10000, 'the supported upper bound is sent intact');
  await page.getByRole('button', { name: 'Cancel generation' }).click();
});

test('generation uses the submitted snapshot while later edits remain the next draft', async () => {
  await openPage();
  const held = holdGeneration();
  await submitProblem('Problem A');
  const request = await held.started;
  await page.locator('#problem').fill('Problem B');
  assert.match(await page.locator('#draft-status').textContent(), /next generation/i);
  const elapsed = page.locator('#elapsed');
  const firstElapsed = await elapsed.textContent();
  await page.waitForTimeout(1050);
  assert.notEqual(await elapsed.textContent(), firstElapsed, 'visible waiting time advances while the request is pending');
  assert.equal(request.problem, 'Problem A');
  await held.finish(resultEvent(request.problem, 'Activity for A'));
  await page.getByRole('heading', { name: 'Activity for A' }).waitFor();
  assert.equal(await page.locator('#problem').inputValue(), 'Problem B');
  assert.equal(await page.locator('#problem').evaluate(el => el === document.activeElement), true);
  await page.locator('#submitted-details > summary').click();
  await page.locator('#submitted-problem').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#submitted-problem').textContent(), 'Problem A');
  await page.getByRole('button', { name: 'Edit problem' }).click();
  assert.equal(await page.locator('#problem').inputValue(), 'Problem B');
  assert.equal(await page.locator('#problem').evaluate(el => el === document.activeElement), true);
});

test('cancel aborts pending work, returns focus, and ignores a late result', async () => {
  await openPage();
  await openSample();
  const held = holdGeneration();
  await submitProblem('Keep the sample');
  await held.started;
  await page.getByRole('button', { name: 'Cancel generation' }).click();
  assert.equal(await page.locator('#problem').evaluate(el => el === document.activeElement), true);
  assert.match(await page.locator('#build-title').textContent(), /cancelled/i);
  await held.finish(resultEvent('Keep the sample', 'Late result'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#player-title').textContent(), 'Math Quest');
  assert.equal(await page.locator('#player-badge').textContent(), 'Built-in preview');
});

test('exploring an already visible sample cancels a pending generation first', async () => {
  await openPage();
  await openSample();
  const held = holdGeneration();
  await submitProblem('Another problem');
  await held.started;
  await page.getByRole('button', { name: 'Try an interactive preview' }).click();
  assert.match(await page.locator('#build-title').textContent(), /cancelled/i);
  assert.equal(await page.locator('#player-title').textContent(), 'Math Quest');
  await held.finish(resultEvent('Another problem', 'Must not replace sample'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#player-title').textContent(), 'Math Quest');
});

test('clarification resubmits the original problem with a labeled supplement', async () => {
  await openPage();
  const held = holdGeneration();
  generateQueue.push((problem, route) => fulfill(route, 200, `${JSON.stringify({ type: 'result', game: { id: 'clarified', title: 'Clarified activity', html: '<!doctype html><html><body>Ready</body></html>', referenceAnswer: 'x = 4', explanation: 'Because the angles sum to 180°.' } })}\n`, 'application/x-ndjson'));
  await submitProblem('Use the diagram to find x.');
  await held.started;
  await page.getByRole('button', { name: 'Cancel generation' }).focus();
  await held.finish({ type: 'clarification', question: 'Which diagram angles are given?' });
  await page.getByText('Which diagram angles are given?').waitFor();
  assert.equal(await page.locator('#additional-details').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#clarification-original').textContent(), 'Use the diagram to find x.');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  assert.equal(calls.length, 1, 'empty clarification cannot trigger another request');
  assert.match(await page.locator('#additional-details-error').textContent(), /Add details/);
  await page.locator('#additional-details').fill('The marked angles are 40° and 60°.');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  await page.getByRole('heading', { name: 'Clarified activity' }).waitFor();
  assert.equal(calls[1], 'Use the diagram to find x.\n\nAdditional details: The marked angles are 40° and 60°.');
  assert.equal(await page.locator('#submitted-problem').textContent(), calls[1]);
});

test('a repeated clarification keeps one form, blocks unchanged details, and resubmits only the latest supplement', async () => {
  await openPage();
  for (const question of ['Which diagram angles are given?', 'What is the unit for the marked side?']) {
    generateQueue.push((_problem, route) => fulfill(route, 200,
      `${JSON.stringify({ type: 'clarification', question })}\n`, 'application/x-ndjson'));
  }
  generateQueue.push((problem, route) => fulfill(route, 200,
    `${JSON.stringify({ type: 'result', game: { id: 'clarified', title: 'Clarified activity', html: '<!doctype html><html><body>Ready</body></html>' } })}\n`, 'application/x-ndjson'));
  await submitProblem('Use the diagram to find x.');
  await page.getByText('Which diagram angles are given?').waitFor();
  await page.locator('#additional-details').fill('The marked angles are 40° and 60°.');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  await page.getByText('What is the unit for the marked side?').waitFor();
  assert.equal(await page.locator('#clarification-original').textContent(), 'Use the diagram to find x.');
  assert.equal(await page.locator('#additional-details').inputValue(), 'The marked angles are 40° and 60°.');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  assert.equal(calls.length, 2, 'unchanged details do not trigger another request');
  assert.match(await page.locator('#additional-details-error').textContent(), /different detail/i);
  await page.locator('#additional-details').fill('The marked side is 8 centimeters.');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  await page.getByRole('heading', { name: 'Clarified activity' }).waitFor();
  assert.equal(calls[2], 'Use the diagram to find x.\n\nAdditional details: The marked side is 8 centimeters.');
});

test('clarification supplement must fit in the server problem limit before the form is cleared', async () => {
  await openPage();
  generateQueue.push((_problem, route) => fulfill(route, 200,
    `${JSON.stringify({ type: 'clarification', question: 'Add the missing diagram details.' })}\n`, 'application/x-ndjson'));
  await submitProblem('x'.repeat(9990));
  await page.getByText('Add the missing diagram details.').waitFor();
  await page.locator('#additional-details').fill('1234567890');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  assert.equal(calls.length, 1);
  assert.equal(await page.locator('#additional-details').inputValue(), '1234567890');
  assert.match(await page.locator('#additional-details-error').textContent(), /10,000/);
});

test('editing a failed supplemented request does not rewrite the previous activity original', async () => {
  await openPage();
  await submitProblem('First problem');
  await page.getByRole('heading', { name: 'Explore the equation' }).waitFor();
  generateQueue.push((_problem, route) => fulfill(route, 200,
    `${JSON.stringify({ type: 'clarification', question: 'Add a missing detail.' })}\n`, 'application/x-ndjson'));
  generateQueue.push((_problem, route) => fulfill(route, 200,
    `${JSON.stringify({ type: 'error', code: 'GENERATION_FAILED', message: 'Could not complete this activity.' })}\n`, 'application/x-ndjson'));
  await submitProblem('Problem that needs detail');
  await page.getByText('Add a missing detail.').waitFor();
  await page.locator('#additional-details').fill('Here is the missing detail.');
  await page.getByRole('button', { name: 'Generate with these details' }).click();
  await page.locator('#edit-failed').waitFor();
  await page.locator('#edit-failed').click();
  await page.locator('#submitted-details > summary').click();
  assert.equal(await page.locator('#submitted-problem').textContent(), 'First problem');
});

test('a failed request labels a visible sample as previous activity', async () => {
  await openPage();
  await openSample();
  generateQueue.push((_problem, route) => fulfill(route, 200,
    `${JSON.stringify({ type: 'error', code: 'GENERATION_FAILED', message: 'Could not complete this activity.' })}\n`, 'application/x-ndjson'));
  await submitProblem('A request that fails');
  await page.getByRole('button', { name: 'Retry this problem' }).waitFor();
  assert.equal(await page.locator('#player-title').textContent(), 'Math Quest');
  assert.equal(await page.locator('#previous-activity').isVisible(), true);
});

test('availability can be retried without losing the draft or exposing configuration details', async () => {
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  configQueue.push({ configured: true, available: false, code: 'SESSION_LIMIT', retryAt });
  configQueue.push({ configured: true, available: true, code: null });
  await openPage();
  await page.locator('#problem').fill('Keep this problem while the lab is paused.');
  assert.equal(await page.getByRole('button', { name: /Make it playable/ }).isDisabled(), true);
  const unavailableCopy = await page.locator('#config-message').textContent();
  assert.doesNotMatch(unavailableCopy, /OPENAI_API_KEY|OPENAI_MODEL|environment variable/i);
  assert.ok(unavailableCopy.includes(new Date(retryAt).toLocaleString(undefined, { timeZoneName: 'short' })), 'a supplied recovery time includes the local timezone');
  await page.getByRole('button', { name: 'Retry availability' }).click();
  await page.waitForFunction(() => document.querySelector('#config-notice')?.hidden);
  assert.equal(await page.locator('#problem').inputValue(), 'Keep this problem while the lab is paused.');
  assert.equal(await page.getByRole('button', { name: /Make it playable/ }).isEnabled(), true);
  assert.equal(calls.length, 0);
});

test('paused generation explains that the built-in preview is still available', async () => {
  configQueue.push({ configured: true, available: false, code: 'GENERATION_PAUSED' });
  await openPage();
  assert.match(await page.locator('#config-message').textContent(), /activities are paused.*built-in preview is still available/i);
  assert.equal(await page.getByRole('button', { name: 'Try an interactive preview' }).isEnabled(), true);
});

test('a failed request retry stays disabled until availability is checked again', async () => {
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  await openPage();
  generateQueue.push((_problem, route) => fulfill(route, 429,
    JSON.stringify({ error: 'Please try again later.', code: 'SESSION_LIMIT', retryAt }), 'application/json'));
  await submitProblem('This request reaches the session limit.');
  const retry = page.getByRole('button', { name: 'Retry this problem' });
  await retry.waitFor();
  assert.equal(await retry.isDisabled(), true);
  assert.ok((await page.locator('#config-message').textContent()).includes(new Date(retryAt).toLocaleString(undefined, { timeZoneName: 'short' })));
  await page.locator('#problem').fill('A later draft');
  await page.getByRole('button', { name: 'Retry availability' }).click();
  await page.waitForFunction(() => document.querySelector('#config-notice')?.hidden);
  assert.equal(await retry.isEnabled(), true);
  await retry.click();
  await page.waitForFunction(() => document.querySelector('#build-title')?.textContent === 'Your activity is ready');
  assert.equal(calls[1], 'This request reaches the session limit.');
  assert.equal(await page.locator('#problem').inputValue(), 'A later draft');
});

test('failure preserves the previous activity and retry uses the failed snapshot', async () => {
  await openPage();
  await submitProblem('First problem');
  await page.getByRole('heading', { name: 'Explore the equation' }).waitFor();
  generateQueue.push((_problem, route) => {
    return fulfill(route, 200, `${JSON.stringify({ type: 'error', code: 'GENERATION_FAILED', message: 'Could not complete this activity.' })}\n`, 'application/x-ndjson');
  });
  await submitProblem('Failed snapshot');
  await page.getByRole('button', { name: 'Retry this problem' }).waitFor();
  assert.equal(await page.locator('#previous-activity').textContent(), 'Previous activity');
  assert.equal(await page.locator('#previous-activity').isVisible(), true);
  assert.equal(await page.locator('#player-title').textContent(), 'Explore the equation');
  await page.locator('#problem').fill('New unsent draft');
  await page.locator('#failed-problem-details > summary').click();
  assert.equal(await page.locator('#failed-problem').textContent(), 'Failed snapshot');
  assert.equal(await page.locator('#player-title').textContent(), 'Explore the equation', 'the visible activity remains the older result');
  await page.getByRole('button', { name: 'Retry this problem' }).click();
  await page.waitForFunction(() => document.querySelector('#build-title')?.textContent === 'Your activity is ready');
  assert.equal(await page.locator('#player-title').evaluate(el => el === document.activeElement), true);
  assert.equal(calls[2], 'Failed snapshot');
  assert.equal(await page.locator('#problem').inputValue(), 'New unsent draft');
});

test('generated explanation starts collapsed and can be opened without claiming math verification', async () => {
  await openPage();
  await submitProblem('Solve 2x + 3 = 11.');
  await page.getByRole('heading', { name: 'Explore the equation' }).waitFor();
  assert.equal(await page.locator('#player-title').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#elapsed').isVisible(), false, 'completed requests do not retain waiting-time copy');
  const disclosure = page.locator('#explanation-details');
  assert.equal(await disclosure.evaluate(el => el.open), false);
  assert.equal(await page.locator('#player-badge').textContent(), 'AI-generated activity');
  await page.getByText('See explanation', { exact: true }).click();
  assert.equal(await disclosure.evaluate(el => el.open), true);
  assert.equal(await page.locator('#reference-answer').textContent(), 'x = 4');
  assert.equal(await page.locator('#explanation').textContent(), 'Subtract 3, then divide by 2.');
  assert.match(await page.locator('.answer-note').textContent(), /Browser checks do not verify the mathematics/);
});

test('host renders a returned assessment and the iframe uses its shared checkpoint runtime', async () => {
  await openPage();
  const assessment = { version: 1, requiresReview: false, fields: [{ id: 'answer', initial: '' }],
    checkpoints: [{ id: 'result', field: 'answer', dependsOn: [], watchFields: [],
      rule: { kind: 'exact', expected: '4' }, feedback: 'Check the exact value.' }] };
  const html = `<style>input,button{font:16px sans-serif;min-height:44px}</style>
    <p id="mpl-problem">Solve 2x + 3 = 11.</p><input id="answer" data-mpl-control data-mpl-field="answer">
    <button id="check" data-mpl-submit="result">Check</button><p id="feedback" data-mpl-feedback="result"></p>
    <p id="mpl-status" role="status"></p><button id="mpl-hint">Hint</button>
    <p id="mpl-hint-text" aria-live="polite" hidden></p><button id="mpl-reset">Reset</button>
    <script>window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};</script>`;
  const result = { type: 'result', game: { id: 'assessment-result', title: 'Balance the equation',
    problem: 'Solve 2x + 3 = 11.', html, assessment, referenceAnswer: 'x = 4',
    verification: { runtime: 'passed', playthrough: 'passed', mathematics: 'not_independently_verified' } } };
  generateQueue.push((_problem, route) => fulfill(route, 200,
    `${JSON.stringify({ type: 'stage', stage: 'understanding' })}\n${JSON.stringify(result)}\n`, 'application/x-ndjson'));
  await submitProblem('Solve 2x + 3 = 11.');
  await page.getByRole('heading', { name: 'Balance the equation' }).waitFor();
  const frame = page.frameLocator('#game-frame');
  assert.equal(await frame.locator('#mpl-status').getAttribute('data-state'), 'incomplete');
  await frame.locator('#answer').fill('4');
  await frame.locator('#check').click();
  assert.equal(await frame.locator('#feedback').textContent(), 'Correct.');
  assert.equal(await frame.locator('#mpl-status').getAttribute('data-state'), 'complete');
  await frame.locator('#answer').fill('5');
  assert.equal(await frame.locator('#feedback').textContent(), '');
  assert.equal(await frame.locator('#mpl-status').getAttribute('data-state'), 'incomplete');
});

test('server error copy is rendered as literal text', async () => {
  await openPage();
  const message = '<img src=x onerror="window.pwned=true"> Please retry.';
  generateQueue.push((_problem, route) => {
    return fulfill(route, 200, `${JSON.stringify({ type: 'error', code: 'GENERATION_FAILED', message })}\n`, 'application/x-ndjson');
  });
  await submitProblem('An error fixture');
  await page.getByRole('button', { name: 'Retry this problem' }).waitFor();
  assert.equal(await page.locator('#build-message').textContent(), message);
  assert.equal(await page.locator('#build-message img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
});

test('sample response arriving after a new result does not replace it or leave loading state', async () => {
  await openPage();
  let releaseSample;
  const sampleStarted = new Promise(resolve => { releaseSample = resolve; });
  let sendSample;
  sampleQueue.push(route => {
    sendSample = () => fulfill(route, 200, '<h1>Late Math Quest</h1>', 'text/html');
    releaseSample();
  });
  const sampleClick = page.getByRole('button', { name: 'Try an interactive preview' }).click();
  await sampleStarted;
  await submitProblem('A new generation');
  await page.getByRole('heading', { name: 'Explore the equation' }).waitFor();
  sendSample();
  await sampleClick;
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#player-title').textContent(), 'Explore the equation');
  assert.equal(await page.getByRole('button', { name: 'Try an interactive preview' }).getAttribute('aria-busy'), null);
  assert.equal(await page.locator('#sample-status').isVisible(), false);
});

test('narrow layout has no horizontal overflow, orders the player before sample, and typing keeps focus', async () => {
  await openPage({ width: 320, height: 760 });
  const held = holdGeneration();
  await submitProblem('Focus stays on input');
  await held.started;
  const input = page.locator('#problem');
  await input.fill('Editing while waiting');
  await held.finish(resultEvent('Focus stays on input', 'Narrow activity'));
  await page.getByRole('heading', { name: 'Narrow activity' }).waitFor();
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  const geometry = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    composer: document.querySelector('.composer').getBoundingClientRect().top,
    player: document.querySelector('#player').getBoundingClientRect().top,
    sample: document.querySelector('.sample-card').getBoundingClientRect().top,
  }));
  assert.ok(geometry.width <= geometry.viewport, `unexpected horizontal overflow: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.composer < geometry.player && geometry.player < geometry.sample, `unexpected mobile order: ${JSON.stringify(geometry)}`);
  await openSample();
  await page.frameLocator('#game-frame').getByRole('heading', { name: 'Math Quest' }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('../.work/v1-frontend.png', import.meta.url)), fullPage: true });
});
