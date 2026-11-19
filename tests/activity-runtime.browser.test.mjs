import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { buildSandboxDocument } from '../public/sandbox.js';

async function withPage(run) {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ executablePath: existsSync(macChrome) ? macChrome : undefined,
    headless: true, timeout: 10000 });
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(2500);
      await run(page);
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

test('central binding clears completion on an edit, resets inputs, then allows a second solve', async () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'layers', initial: '0' }, { id: 'volume', initial: '0' }],
    checkpoints: [
      { id: 'layer', field: 'layers', dependsOn: [], watchFields: [],
        rule: { kind: 'exact', expected: '6' }, feedback: 'Use length times width to count one layer.' },
      { id: 'total', field: 'volume', dependsOn: ['layer'], watchFields: [],
        rule: { kind: 'exact', expected: '24' }, feedback: 'Combine all four equal layers.' },
    ] };
  const html = `<style>input,button{font:16px sans-serif;min-height:44px}</style>
    <input data-mpl-field="layers"><button data-mpl-submit="layer">Check layer</button><p data-mpl-feedback="layer"></p>
    <input data-mpl-field="volume"><button data-mpl-submit="total">Check total</button><p data-mpl-feedback="total"></p>
    <p id="mpl-status"></p><button id="mpl-reset">Reset</button>`;
  await withPage(async page => {
    await page.setContent(buildSandboxDocument(html, { assessment }), { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('[data-mpl-feedback="layer"]').textContent(), '');
    assert.equal(await page.locator('[data-mpl-feedback="layer"]').getAttribute('data-state'), 'unanswered');
    await page.locator('[data-mpl-field="layers"]').fill('6');
    await page.locator('[data-mpl-submit="layer"]').click();
    assert.equal(await page.locator('[data-mpl-feedback="layer"]').textContent(), 'Correct.');
    await page.locator('[data-mpl-field="volume"]').fill('24');
    await page.locator('[data-mpl-submit="total"]').click();
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'complete');
    await page.locator('[data-mpl-field="layers"]').fill('7');
    assert.equal(await page.locator('[data-mpl-feedback="layer"]').textContent(), '');
    assert.equal(await page.locator('[data-mpl-feedback="total"]').textContent(), '');
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'incomplete');
    assert.equal(await page.locator('[data-mpl-field="volume"]').inputValue(), '24');
    await page.locator('#mpl-reset').click();
    assert.equal(await page.locator('[data-mpl-field="layers"]').inputValue(), '0');
    assert.equal(await page.locator('[data-mpl-field="volume"]').inputValue(), '0');
    assert.equal(await page.locator('[data-mpl-feedback="layer"]').textContent(), '');
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'incomplete');
    await page.locator('[data-mpl-field="layers"]').fill('6');
    await page.locator('[data-mpl-submit="layer"]').click();
    await page.locator('[data-mpl-field="volume"]').fill('24');
    await page.locator('[data-mpl-submit="total"]').click();
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'complete');
  });
});

test('oversized bound edits clear the draft and revoke completion without a browser error', async () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'answer', initial: '' }, { id: 'dependent', initial: '' }, { id: 'watch', initial: '' }],
    checkpoints: [
      { id: 'first', field: 'answer', dependsOn: [], watchFields: ['watch'],
        rule: { kind: 'exact', expected: '4' }, feedback: 'Check the answer.' },
      { id: 'second', field: 'dependent', dependsOn: ['first'], watchFields: [],
        rule: { kind: 'exact', expected: '8' }, feedback: 'Check the next step.' },
    ] };
  const html = `<style>input,button{font:16px sans-serif;min-height:44px}</style>
    <input data-mpl-field="answer"><button data-mpl-submit="first">Check</button><p data-mpl-feedback="first"></p>
    <input data-mpl-field="dependent"><button data-mpl-submit="second">Check</button><p data-mpl-feedback="second"></p>
    <input data-mpl-field="watch">
    <p id="mpl-status"></p><button id="mpl-reset">Reset</button>`;
  await withPage(async page => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent(buildSandboxDocument(html, { assessment }), { waitUntil: 'domcontentloaded' });
    await page.locator('[data-mpl-field="answer"]').fill('4');
    await page.locator('[data-mpl-submit="first"]').click();
    await page.locator('[data-mpl-field="dependent"]').fill('8');
    await page.locator('[data-mpl-submit="second"]').click();
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'complete');

    await page.locator('[data-mpl-field="watch"]').fill('9'.repeat(4097));
    assert.equal(await page.locator('[data-mpl-field="watch"]').inputValue(), '');
    assert.equal(await page.locator('[data-mpl-feedback="first"]').getAttribute('data-state'), 'unanswered');
    assert.equal(await page.locator('[data-mpl-feedback="second"]').getAttribute('data-state'), 'unanswered');
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'incomplete');
    assert.match(await page.locator('[data-mpl-field="watch"]').evaluate(element => element.validationMessage),
      /oversized entry was cleared/i);
    assert.equal(await page.locator('[data-mpl-field="watch"]').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await page.evaluate(() => window.mathPlayLabActivity.getState()), {
      values: { answer: '4', dependent: '8', watch: '' }, checkpoints: { first: 'unanswered', second: 'unanswered' },
      complete: false, pendingReview: false,
    });
    assert.deepEqual(pageErrors, []);

    await page.evaluate(() => window.mathPlayLabActivity.set('watch', 'valid'));
    assert.equal(await page.locator('[data-mpl-field="watch"]').inputValue(), 'valid');
    assert.equal(await page.locator('[data-mpl-field="watch"]').evaluate(element => element.validationMessage), '');
    assert.equal(await page.locator('[data-mpl-field="watch"]').getAttribute('aria-invalid'), null);
    await page.evaluate(() => {
      window.mathPlayLabActivity.set('dependent', '8');
      window.mathPlayLabActivity.submit('first');
      window.mathPlayLabActivity.submit('second');
    });
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'complete');
    await page.evaluate(() => window.mathPlayLabActivity.reset());
    assert.equal(await page.locator('[data-mpl-field="answer"]').inputValue(), '');
    assert.equal(await page.locator('[data-mpl-field="watch"]').evaluate(element => element.validationMessage), '');
    assert.equal(await page.locator('[data-mpl-field="watch"]').getAttribute('aria-invalid'), null);

    await page.locator('[data-mpl-field="answer"]').fill('4');
    await page.locator('[data-mpl-submit="first"]').click();
    await page.locator('[data-mpl-field="dependent"]').fill('8');
    await page.locator('[data-mpl-submit="second"]').click();
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'complete');
    await page.locator('#mpl-reset').click();
    assert.equal(await page.locator('[data-mpl-field="answer"]').inputValue(), '');
    assert.equal(await page.locator('#mpl-status').getAttribute('data-state'), 'incomplete');
  });
});

test('generated render-listener RangeErrors remain visible through normal bound edits', async () => {
  const assessment = { version: 1, requiresReview: false, fields: [{ id: 'answer', initial: '' }],
    checkpoints: [{ id: 'check', field: 'answer', dependsOn: [], watchFields: [],
      rule: { kind: 'exact', expected: '5' }, feedback: 'Check the entry.' }] };
  const html = `<input data-mpl-field="answer"><button data-mpl-submit="check">Check</button>
    <p data-mpl-feedback="check"></p><p id="mpl-status"></p><button id="mpl-reset">Reset</button>
    <script>window.mathPlayLabActivity.subscribe(()=>{throw new RangeError('generated render failure');});</script>`;
  await withPage(async page => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent(buildSandboxDocument(html, { assessment }), { waitUntil: 'domcontentloaded' });
    await page.locator('[data-mpl-field="answer"]').fill('5');
    assert.equal(await page.evaluate(() => window.mathPlayLabActivity.getState().values.answer), '5');
    assert.ok(pageErrors.some(message => message.includes('generated render failure')));
  });
});

test('assessment embedding cannot close its script and runtime globals are fixed', async () => {
  const payload = '</script><script>window.injectedFromAssessment=true</script>';
  const assessment = { version: 1, requiresReview: false, fields: [{ id: 'raw', initial: payload }],
    checkpoints: [{ id: 'check', field: 'raw', dependsOn: [], watchFields: [],
      rule: { kind: 'exact', expected: '1' }, feedback: 'Try again.' }] };
  const html = `<input data-mpl-field="raw"><button data-mpl-submit="check">Check</button><p data-mpl-feedback="check"></p>
    <p id="mpl-status"></p><button id="mpl-reset">Reset</button>
    <script>try{window.mathPlayLabExact={};window.mathPlayLabActivity={};}catch{};</script>`;
  await withPage(async page => {
    await page.setContent(buildSandboxDocument(html, { assessment }), { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(() => {
      const exactDescriptor = Object.getOwnPropertyDescriptor(window, 'mathPlayLabExact');
      const activityDescriptor = Object.getOwnPropertyDescriptor(window, 'mathPlayLabActivity');
      return { injected: window.injectedFromAssessment === true,
        value: document.querySelector('[data-mpl-field="raw"]').value,
        exactFixed: exactDescriptor?.writable === false && exactDescriptor?.configurable === false && Object.isFrozen(window.mathPlayLabExact),
        activityFixed: activityDescriptor?.writable === false && activityDescriptor?.configurable === false && Object.isFrozen(window.mathPlayLabActivity),
        stateValue: window.mathPlayLabActivity.getState().values.raw };
    });
    assert.equal(result.injected, false);
    assert.equal(result.value, payload);
    assert.equal(result.stateValue, payload);
    assert.equal(result.exactFixed, true);
    assert.equal(result.activityFixed, true);
  });
});
