import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright-core';
import { buildSandboxDocument } from '../public/sandbox.js';
import { GenerationError, validateAssessment, validatePlaytest } from './contracts.mjs';
import { runPlaythrough } from './playthrough.mjs';
import { emptyIndependentChecks } from './assessment-probes.mjs';

async function readMathState(page) {
  const snapshot = await page.evaluate(() => {
    const state = window.mathPlayLab?.getState?.();
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    return JSON.stringify(state);
  });
  const state = snapshot ? JSON.parse(snapshot) : null;
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Object.keys(state).length) {
    throw new Error('window.mathPlayLab.getState() must return a nonempty JSON object of mathematical state.');
  }
  return state;
}

async function useControl(control) {
  const { tag, type } = await control.evaluate(element => ({ tag: element.tagName, type: element.type }));
  if (tag === 'INPUT' && ['range', 'number'].includes(type)) {
    const before = await control.inputValue();
    await control.press(type === 'number' ? 'ArrowUp' : 'ArrowRight');
    if (await control.inputValue() === before) await control.press(type === 'number' ? 'ArrowDown' : 'ArrowLeft');
  } else if (tag === 'SELECT') {
    const index = await control.evaluate(element => Array.from(element.options).findIndex(option =>
      !option.selected && option.value !== element.value && !option.matches(':disabled')));
    if (index < 0) throw new Error('Expected a different, enabled option in the mathematical interaction control.');
    await control.selectOption({ index });
  } else if (tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'search'].includes(type))) {
    const before = await control.inputValue();
    await control.fill(before === '1' ? '2' : '1');
  } else await control.click();
}

async function firstVisibleEnabledControl(page) {
  const controls = page.locator('[data-mpl-control]:not(#mpl-reset)');
  for (let index = 0; index < await controls.count(); index++) {
    const control = controls.nth(index);
    if (await control.isVisible() && await control.isEnabled()) return control;
  }
  return null;
}

async function hasGlobalHorizontalOverflow(page) {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) >
    document.documentElement.clientWidth);
}

export async function checkHtml(html, options = {}) {
  const settings = options ?? {};
  const signal = settings.signal;
  const hasAssessment = Object.hasOwn(settings, 'assessment');
  const hasPlaytest = Object.hasOwn(settings, 'playtest');
  const newContract = hasAssessment || hasPlaytest;
  let independentChecks = newContract ? emptyIndependentChecks(settings.assessment) : undefined;
  signal?.throwIfAborted();
  if (hasAssessment !== hasPlaytest) return { passed: false, playthrough: 'failed', independentChecks,
    errors: ['The playthrough contract was invalid.'] };
  if (newContract) {
    try { validateAssessment(settings.assessment); validatePlaytest(settings.playtest); }
    catch { return { passed: false, playthrough: 'failed', independentChecks,
      errors: ['The playthrough contract was invalid.'] }; }
  }
  const checkStartedAt = Date.now();
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined);
  let browser;
  try { browser = await chromium.launch({ executablePath, headless: true, timeout: 10000 }); }
  catch {
    signal?.throwIfAborted();
    throw new GenerationError('BROWSER_UNAVAILABLE', 'The exercise checker is temporarily unavailable. Please try again.');
  }
  const errors = [];
  let timer;
  let abort;
  let playthroughPassed = false;
  try {
      const timeout = new Promise((_, reject) => {
      const deadline = newContract ? Math.max(1, 30000 - (Date.now() - checkStartedAt)) : 10000;
      timer = setTimeout(() => reject(new Error('Browser check exceeded its time limit.')), deadline);
    });
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    const run = async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 720 }, acceptDownloads: false });
      await context.route('**/*', route => route.abort());
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
      page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
      page.on('pageerror', error => { if (errors.length < 10) errors.push(error.message.slice(0,500)); });
      page.on('console', message => { if (message.type() === 'error' && errors.length < 10) errors.push(message.text().slice(0,500)); });
      page.setDefaultTimeout(1500);
      await page.setContent(buildSandboxDocument(html, newContract ? { assessment: settings.assessment } : undefined),
        { waitUntil: 'domcontentloaded', timeout: 4000 });
      for (const selector of ['#mpl-problem', '#mpl-status', '#mpl-reset']) {
        if (await page.locator(selector).count() !== 1 || !await page.locator(selector).isVisible()) {
          errors.push(`Expected one visible ${selector} element.`);
        }
      }
      const hintButton = page.locator('#mpl-hint');
      const hintText = page.locator('#mpl-hint-text');
      if (await hintButton.count() !== 1 ||
          await hintButton.evaluate(element => element.tagName !== 'BUTTON') ||
          !await hintButton.isVisible() || !await hintButton.isEnabled()) {
        errors.push('Expected a visible enabled hint button.');
      }
      if (await hintText.count() !== 1 ||
          await hintText.evaluate(element => {
            const role = element.getAttribute('role')?.toLowerCase();
            const live = element.getAttribute('aria-live')?.toLowerCase();
            return !(['polite', 'assertive'].includes(live) || (role === 'status' && live !== 'off'));
          }) ||
          ((await hintText.textContent()).trim() !== '' && await hintText.isVisible())) {
        errors.push('Expected an initially empty or hidden hint live region.');
      }
      if (await hasGlobalHorizontalOverflow(page)) errors.push('The page has horizontal overflow at desktop width.');
      const control = page.locator('[data-mpl-control]:not(#mpl-reset)').first();
      if (!await control.count() || !await control.isVisible() || !await control.isEnabled()) {
        errors.push('Expected a visible, enabled mathematical interaction control.');
      }

      await page.setViewportSize({ width: 320, height: 720 });
      if (await hasGlobalHorizontalOverflow(page)) errors.push('The page has horizontal overflow at 320px width.');
      const narrowControl = await firstVisibleEnabledControl(page);
      if (!narrowControl) {
        errors.push('Expected a visible, enabled mathematical interaction control.');
      } else {
        const metrics = await narrowControl.evaluate(element => {
          const targets = [element.getBoundingClientRect()];
          if ('labels' in element && element.labels) {
            for (const label of element.labels) {
              const style = getComputedStyle(label);
              if (label.getClientRects().length && !['hidden', 'collapse'].includes(style.visibility) && style.display !== 'none') {
                targets.push(label.getBoundingClientRect());
              }
            }
          }
          const hasTarget = targets.some(target => target.width >= 44 && target.height >= 44);
          const visibleTextFontSizes = root => {
            const sizes = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (!node.nodeValue.trim() || !node.parentElement) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const style = getComputedStyle(node.parentElement);
              if (range.getClientRects().length && !['hidden', 'collapse'].includes(style.visibility)) {
                sizes.push(Number.parseFloat(style.fontSize));
              }
            }
            return sizes;
          };
          let fontSizes;
          if (element.tagName === 'INPUT' && ['range', 'checkbox', 'radio'].includes(element.type.toLowerCase())) {
            fontSizes = Array.from(element.labels ?? []).filter(label => label.getClientRects().length)
              .flatMap(label => visibleTextFontSizes(label));
          } else if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
            fontSizes = [Number.parseFloat(getComputedStyle(element).fontSize)];
          } else {
            fontSizes = visibleTextFontSizes(element);
          }
          return { hasTarget, fontSizes };
        });
        if (!metrics.hasTarget) errors.push('The first mathematical control has a click target smaller than 44 by 44 pixels.');
        if (metrics.fontSizes.some(fontSize => Number.isFinite(fontSize) && fontSize < 16)) {
          errors.push('The first mathematical control text or numeric entry uses a font smaller than 16px.');
        }
      }
      const problemText = page.locator('#mpl-problem');
      if (await problemText.isVisible() && await problemText.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize)) < 16) {
        errors.push('Visible problem text uses a font smaller than 16px.');
      }

      await page.setViewportSize({ width: 900, height: 720 });
      if (errors.length) return;
      if (newContract) {
        const playthrough = await runPlaythrough(page, settings.assessment, settings.playtest);
        independentChecks = playthrough.independentChecks;
        errors.push(...playthrough.errors);
        playthroughPassed = playthrough.errors.length === 0 && errors.length === 0;
        if (!playthroughPassed) return;
      }

      const initial = await readMathState(page);
      await hintButton.click();
      const firstHint = (await hintText.textContent()).trim();
      if (!firstHint || !await hintText.isVisible()) errors.push('The first hint click did not reveal the first hint.');
      await hintButton.click();
      const secondHint = (await hintText.textContent()).trim();
      if (!secondHint || !await hintText.isVisible() || secondHint === firstHint) {
        errors.push('The second hint click did not reveal different additional guidance.');
      }
      if (!isDeepStrictEqual(initial, await readMathState(page))) errors.push('Hint controls changed mathematical state.');

      await useControl(control);
      const changed = await readMathState(page);
      if (isDeepStrictEqual(initial, changed)) errors.push('The interaction control did not change mathematical state.');

      await page.locator('#mpl-reset').click();
      await page.waitForTimeout(100);
      const reset = await readMathState(page);
      if (!isDeepStrictEqual(initial, reset)) errors.push('Reset did not restore initial mathematical state.');
      if ((await hintText.textContent()).trim() && await hintText.isVisible()) errors.push('Reset did not clear or hide the hints.');
      if (!await hintButton.isEnabled()) {
        errors.push('The hint button was not enabled after reset.');
      } else {
        await hintButton.click();
        const resetFirstHint = (await hintText.textContent()).trim();
        if (!resetFirstHint || !await hintText.isVisible() || resetFirstHint !== firstHint) {
          errors.push('Reset did not restore the hint sequence.');
        }
        if (!isDeepStrictEqual(initial, await readMathState(page))) errors.push('Hint controls changed mathematical state.');
      }

      const resetControl = page.locator('[data-mpl-control]:not(#mpl-reset)').first();
      if (!await resetControl.count() || !await resetControl.isVisible() || !await resetControl.isEnabled()) {
        errors.push('Expected the first mathematical interaction control to be visible and enabled after reset.');
      } else {
        await useControl(resetControl);
        if (isDeepStrictEqual(initial, await readMathState(page))) {
          errors.push('After reset, the interaction control did not change mathematical state.');
        }
      }
    };
    try { await Promise.race([run(), timeout, cancelled]); }
    catch (error) {
      signal?.throwIfAborted();
      errors.push(newContract ? 'The complete learner playthrough did not pass.' : error.message.slice(0,500));
    }
    const passed = errors.length === 0;
    return newContract ? { passed, playthrough: playthroughPassed ? 'passed' : 'failed', independentChecks, errors }
      : { passed, errors };
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}
