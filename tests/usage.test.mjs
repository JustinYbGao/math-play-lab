import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { createUsageGate, usageConfig } from '../server/usage.mjs';

const HOUR = 60 * 60 * 1000;
const configuredModel = { provider: 'openai', apiKey: 'private-test-key', model: 'fixture-model', baseUrl: 'https://model.example/v1' };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'math-play-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function capConfig(directory, max = 20, mode = 'development') {
  return usageConfig({ APP_MODE: mode, DEMO_MAX_GENERATIONS: String(max), DEMO_BUDGET_FILE: path.join(directory, 'budget.json') });
}

async function admitAndRelease(gate, options = {}) {
  const result = await gate.admit({ configured: true, ...options });
  if (result.admitted) result.release();
  return result;
}

async function startServer(t, options = {}) {
  const app = createApp({ config: configuredModel, generate: async () => ({ type: 'result' }), ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    app.closeAllConnections();
    app.close(resolve);
  }));
  return `http://127.0.0.1:${app.address().port}`;
}

test('one anonymous session gets five admitted requests, the sixth is limited, and another session is independent', async t => {
  const directory = await temporaryDirectory(t);
  const gate = createUsageGate({ config: capConfig(directory), now: () => Date.UTC(2026, 0, 1),
    idFactory: (() => { let id = 0; return () => `session-${++id}`; })() });
  const first = await admitAndRelease(gate);
  assert.equal(first.admitted, true);
  for (let count = 1; count < 5; count++) {
    assert.equal((await admitAndRelease(gate, { cookieId: first.sessionId })).admitted, true);
  }
  const limited = await gate.admit({ configured: true, cookieId: first.sessionId });
  assert.equal(limited.code, 'SESSION_LIMIT');
  assert.equal(limited.error, 'This browser has reached its hourly generation limit.');
  assert.equal(limited.retryAt, new Date(Date.UTC(2026, 0, 1) + HOUR).toISOString());

  const independent = await admitAndRelease(gate);
  assert.equal(independent.admitted, true);
  assert.notEqual(independent.sessionId, first.sessionId);
});

test('session limit uses a rolling hour and reports the oldest admitted request time', async t => {
  const directory = await temporaryDirectory(t);
  let now = Date.UTC(2026, 0, 1);
  const gate = createUsageGate({ config: capConfig(directory), now: () => now, idFactory: () => 'rolling-session' });
  const first = await admitAndRelease(gate);
  for (let count = 1; count < 5; count++) await admitAndRelease(gate, { cookieId: first.sessionId });
  const status = await gate.status({ configured: true, cookieId: first.sessionId });
  assert.equal(status.retryAt, new Date(now + HOUR).toISOString());
  now += HOUR;
  assert.equal((await admitAndRelease(gate, { cookieId: first.sessionId })).admitted, true);
});

test('invalid, paused, and busy requests do not consume a session slot', async t => {
  const directory = await temporaryDirectory(t);
  const gate = createUsageGate({ config: capConfig(directory), maxConcurrent: 1, idFactory: (() => { let id = 0; return () => `session-${++id}`; })() });
  assert.equal((await gate.admit({ configured: false })).code, 'NOT_CONFIGURED');

  const held = await gate.admit({ configured: true });
  assert.equal((await gate.admit({ configured: true, cookieId: held.sessionId })).code, 'SERVER_BUSY');
  held.release();
  for (let count = 1; count < 5; count++) {
    assert.equal((await admitAndRelease(gate, { cookieId: held.sessionId })).admitted, true);
  }
  assert.equal((await gate.admit({ configured: true, cookieId: held.sessionId })).code, 'SESSION_LIMIT');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'budget.json'), 'utf8')),
    { version: 1, admitted: 5 });

  const paused = createUsageGate({ config: { ...capConfig(directory), generationEnabled: false } });
  assert.equal((await paused.admit({ configured: true })).code, 'GENERATION_PAUSED');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'budget.json'), 'utf8')),
    { version: 1, admitted: 5 });
});

test('cancellations after admission count toward the hourly session limit', async t => {
  const directory = await temporaryDirectory(t);
  const gate = createUsageGate({ config: capConfig(directory), idFactory: () => 'cancelled-session' });
  const first = await admitAndRelease(gate);
  for (let count = 1; count < 5; count++) await admitAndRelease(gate, { cookieId: first.sessionId });
  assert.equal((await gate.admit({ configured: true, cookieId: first.sessionId })).code, 'SESSION_LIMIT');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'budget.json'), 'utf8')),
    { version: 1, admitted: 5 });
});

test('concurrent reservations serialize and never admit beyond the global cap', async t => {
  const directory = await temporaryDirectory(t);
  const budgetFile = path.join(directory, 'budget.json');
  const gate = createUsageGate({ config: capConfig(directory, 2), idFactory: (() => { let id = 0; return () => `session-${++id}`; })() });
  const results = await Promise.all(Array.from({ length: 12 }, () => gate.admit({ configured: true })));
  const admitted = results.filter(result => result.admitted);
  assert.equal(admitted.length, 2);
  assert.ok(results.filter(result => result.code === 'BUDGET_EXHAUSTED').length >= 1);
  for (const result of admitted) result.release();
  assert.equal((await gate.admit({ configured: true })).code, 'BUDGET_EXHAUSTED');
  assert.deepEqual(JSON.parse(await readFile(budgetFile, 'utf8')), { version: 1, admitted: 2 });
});

test('a new gate instance restores the persisted global admitted count', async t => {
  const directory = await temporaryDirectory(t);
  const config = capConfig(directory, 1);
  const firstGate = createUsageGate({ config });
  const first = await admitAndRelease(firstGate);
  assert.equal(first.admitted, true);

  const restartedGate = createUsageGate({ config });
  const status = await restartedGate.status({ configured: true });
  assert.equal(status.available, false);
  assert.equal(status.code, 'BUDGET_EXHAUSTED');
});

test('corrupt and unavailable ledgers fail closed without exposing their paths', async t => {
  const directory = await temporaryDirectory(t);
  const corruptPath = path.join(directory, 'corrupt.json');
  await writeFile(corruptPath, JSON.stringify({ version: 1, admitted: 0, prompt: 'secret input' }));
  const corruptGate = createUsageGate({ config: usageConfig({
    APP_MODE: 'public', DEMO_MAX_GENERATIONS: '3', DEMO_BUDGET_FILE: corruptPath,
  }) });
  const corruptStatus = await corruptGate.status({ configured: true });
  assert.equal(corruptStatus.code, 'BUDGET_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(corruptStatus), /corrupt\.json|secret input/);

  const occupiedPath = path.join(directory, 'regular-file');
  await writeFile(occupiedPath, 'not a directory');
  const unavailableGate = createUsageGate({ config: usageConfig({
    APP_MODE: 'public', DEMO_MAX_GENERATIONS: '3', DEMO_BUDGET_FILE: path.join(occupiedPath, 'ledger.json'),
  }) });
  assert.equal((await unavailableGate.status({ configured: true })).code, 'BUDGET_UNAVAILABLE');
});

test('public mode without a positive cap is unavailable', async () => {
  const gate = createUsageGate({ config: usageConfig({ APP_MODE: 'public' }) });
  const status = await gate.status({ configured: true });
  assert.equal(status.available, false);
  assert.equal(status.code, 'BUDGET_NOT_CONFIGURED');
});

test('HTTP config and errors are safe, invalid input is free, and admitted requests get opaque cookies', async t => {
  const directory = await temporaryDirectory(t);
  const budgetFile = path.join(directory, 'counter.json');
  const gate = createUsageGate({ config: usageConfig({
    APP_MODE: 'development', DEMO_MAX_GENERATIONS: '20', DEMO_BUDGET_FILE: budgetFile,
  }) });
  let generationCalls = 0;
  const base = await startServer(t, { usage: gate, generate: async () => { generationCalls++; return { type: 'result' }; } });
  const configResponse = await fetch(`${base}/api/config`, { headers: { Cookie: 'mpl_session=attacker-selected' } });
  const configText = await configResponse.text();
  const availability = JSON.parse(configText);
  assert.equal(availability.configured, true);
  assert.equal(availability.available, true);
  assert.equal(availability.code, null);
  assert.doesNotMatch(configText, /private-test-key|counter\.json|math-play-usage/);
  assert.deepEqual(JSON.parse(await readFile(budgetFile, 'utf8')), { version: 1, admitted: 0 });

  const invalid = await fetch(`${base}/api/generate`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: 'mpl_session=attacker-selected',
  }, body: JSON.stringify({ problem: '   ' }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_REQUEST');
  assert.equal(invalid.headers.get('set-cookie'), null);
  assert.equal(generationCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(budgetFile, 'utf8')), { version: 1, admitted: 0 });

  const rawInput = 'PRIVATE raw problem text x + 1 = 2';
  const headers = { 'Content-Type': 'application/json', Cookie: 'mpl_session=attacker-selected' };
  const first = await fetch(`${base}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ problem: rawInput }) });
  const firstBody = await first.text();
  assert.equal(first.status, 200);
  assert.doesNotMatch(firstBody, /PRIVATE raw problem text|private-test-key|counter\.json/);
  const setCookie = first.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  const issuedCookie = setCookie.split(';')[0];
  assert.notEqual(issuedCookie, 'mpl_session=attacker-selected');

  for (let count = 1; count < 5; count++) {
    const accepted = await fetch(`${base}/api/generate`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Cookie: issuedCookie,
    }, body: JSON.stringify({ problem: 'another valid problem' }) });
    assert.equal(accepted.status, 200);
    await accepted.text();
  }
  const limited = await fetch(`${base}/api/generate`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: issuedCookie,
  }, body: JSON.stringify({ problem: 'sixth valid problem' }) });
  const limitedBody = await limited.json();
  assert.equal(limited.status, 429);
  assert.equal(limitedBody.code, 'SESSION_LIMIT');
  assert.ok(limitedBody.retryAt);
  assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.equal(generationCalls, 5);
  const limitedConfig = await fetch(`${base}/api/config`, { headers: { Cookie: issuedCookie } });
  const limitedAvailability = await limitedConfig.json();
  assert.equal(limitedAvailability.available, false);
  assert.equal(limitedAvailability.code, 'SESSION_LIMIT');
  assert.ok(limitedAvailability.retryAt);

  const ledgerText = await readFile(budgetFile, 'utf8');
  assert.deepEqual(JSON.parse(ledgerText), { version: 1, admitted: 5 });
  assert.doesNotMatch(ledgerText, /PRIVATE raw problem text|private-test-key|counter\.json/);
});

test('an abort during budget persistence does not admit or invoke generation', async t => {
  const directory = await temporaryDirectory(t);
  let releaseReservation;
  let onReservationStart;
  let stored = 0;
  const reservationStarted = new Promise(resolve => { onReservationStart = resolve; });
  const storage = {
    persistent: true,
    async load() { return stored; },
    async save(value) {
      if (value === 1) {
        onReservationStart();
        await new Promise(resolve => { releaseReservation = resolve; });
      }
      stored = value;
    },
  };
  const gate = createUsageGate({ config: capConfig(directory, 2), storage });
  let generationCalls = 0;
  const base = await startServer(t, { usage: gate, generate: async () => { generationCalls++; return { type: 'result' }; } });
  const controller = new AbortController();
  const request = fetch(`${base}/api/generate`, { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ problem: 'valid problem' }) });
  await reservationStarted;
  controller.abort();
  await assert.rejects(request);
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseReservation();
  await gate.status({ configured: true });
  assert.equal(generationCalls, 0);
  assert.equal(stored, 0);
  assert.equal((await gate.status({ configured: true })).available, true);
});

test('public mode sets Secure on an admitted session cookie', async t => {
  const directory = await temporaryDirectory(t);
  const gate = createUsageGate({ config: usageConfig({
    APP_MODE: 'public', DEMO_MAX_GENERATIONS: '2', DEMO_BUDGET_FILE: path.join(directory, 'budget.json'),
  }) });
  const base = await startServer(t, { usage: gate });
  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problem: 'x + 1 = 2' }) });
  await response.text();
  assert.match(response.headers.get('set-cookie'), /; Secure/);
});
