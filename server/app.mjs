import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { modelConfig, isModelConfigured, createModelClient } from './model.mjs';
import { generateGame } from './generate.mjs';
import { checkHtml } from './check.mjs';
import { GenerationError } from './contracts.mjs';
import { createUsageGate, readSessionCookie, sessionCookieHeader } from './usage.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
  ['/curriculum.json', ['curriculum.json', 'application/json']],
  ['/curriculum.en.json', ['curriculum.en.json', 'application/json']],
  ['/sandbox.js', ['sandbox.js', 'text/javascript']],
  ['/activity-runtime.js', ['activity-runtime.js', 'text/javascript']],
  ['/samples/math-quest.html', ['samples/math-quest.html', 'text/html']],
]);

const hostCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

function httpError(response, status, code, error, retryAt) {
  const body = { error, code };
  const headers = {};
  if (retryAt) {
    body.retryAt = retryAt;
    headers['Retry-After'] = String(Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)));
  }
  return json(response, status, body, headers);
}

async function readInput(request) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 50000) throw new Error('Request too large.');
    parts.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (typeof input?.problem !== 'string' || !input.problem.trim() || input.problem.trim().length > 10000) {
    throw new Error('Enter a problem of 1 to 10,000 characters.');
  }
  return input.problem.trim();
}

export function createApp({ config = modelConfig(), model, check = checkHtml, generate = generateGame, usage = createUsageGate() } = {}) {
  const client = model || createModelClient(config);
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', hostCsp);
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const configured = isModelConfigured(config);
      const availability = await usage.status({ configured, cookieId: readSessionCookie(request.headers.cookie) });
      const body = { configured, provider: config.provider || null, model: config.model || null,
        textInput: true, imageInput: false, available: availability.available, code: availability.available ? null : availability.code };
      if (availability.retryAt) body.retryAt = availability.retryAt;
      return json(response, 200, body);
    }
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      const controller = new AbortController();
      let clientDisconnected = request.aborted;
      request.on('aborted', () => { clientDisconnected = true; controller.abort(); });
      response.on('close', () => {
        if (!response.writableEnded) {
          clientDisconnected = true;
          controller.abort();
        }
      });
      if (!request.headers['content-type']?.startsWith('application/json')) return httpError(response,415,'INVALID_REQUEST','Use a JSON request.');
      if (request.headers.origin) {
        let originHost;
        try { originHost = new URL(request.headers.origin).host; } catch { return httpError(response,403,'ORIGIN_NOT_ALLOWED','Origin not allowed.'); }
        if (originHost !== request.headers.host) return httpError(response,403,'ORIGIN_NOT_ALLOWED','Origin not allowed.');
      }
      let problem;
      try { problem = await readInput(request); } catch {
        if (clientDisconnected) return;
        return httpError(response,400,'INVALID_REQUEST','Enter a problem of 1 to 10,000 characters in a valid JSON request.');
      }
      const admission = await usage.admit({ configured: isModelConfigured(config),
        cookieId: readSessionCookie(request.headers.cookie), isAborted: () => clientDisconnected || controller.signal.aborted });
      if (!admission.admitted) {
        if (admission.aborted || clientDisconnected) return;
        const status = admission.code === 'SESSION_LIMIT' || admission.code === 'SERVER_BUSY' ? 429 : 503;
        return httpError(response, status, admission.code, admission.error, admission.retryAt);
      }
      if (admission.newSession) response.setHeader('Set-Cookie', sessionCookieHeader(admission.sessionId, { secure: usage.mode === 'public' }));
      response.writeHead(200, { 'Content-Type':'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering':'no' });
      const send = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
      try {
        const result = await generate({ problem, model: client, check, signal: controller.signal,
          onStage: stage => send({type:'stage',stage}) });
        send(result);
      } catch (error) {
        if (!controller.signal.aborted) send({type:'error',
          code:error instanceof GenerationError ? error.code : 'GENERATION_FAILED',
          message:error instanceof GenerationError ? error.message : 'The exercise could not be generated. Please try again.'});
      } finally {
        admission.release();
        if (!response.destroyed) response.end();
      }
      return;
    }
    if (request.method !== 'GET') return httpError(response,405,'METHOD_NOT_ALLOWED','Method not allowed.');
    const file = staticFiles.get(url.pathname);
    if (!file) return httpError(response,404,'NOT_FOUND','Not found.');
    try {
      const body = await readFile(path.join(publicRoot,file[0]));
      response.writeHead(200,{'Content-Type':`${file[1]}; charset=utf-8`});
      response.end(body);
    } catch { httpError(response,404,'NOT_FOUND','Not found.'); }
  });
}
