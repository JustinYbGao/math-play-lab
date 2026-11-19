import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { GenerationError } from '../server/contracts.mjs';
import { readyPlan, fixturePage, scriptedModel } from './fixtures.mjs';

const passingIndependentChecks = { status: 'passed', testedFields: readyPlan.assessment.fields.map(field => field.id),
  untestedFields: [], equivalentChecks: 0 };

async function server(t, options = {}) {
  const app = createApp({config:{provider:'openai',apiKey:'',model:'',baseUrl:'https://model.example/v1'},...options});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  return `http://127.0.0.1:${app.address().port}`;
}

test('configuration reports the selected provider without exposing the credential',async t=>{
  const base=await server(t,{config:{provider:'openrouter',apiKey:'private-test-key',model:'fixture-model',baseUrl:'https://openrouter.ai/api/v1'}});
  const response=await fetch(`${base}/api/config`);
  const body=await response.text();
  assert.equal(JSON.parse(body).configured,true);
  assert.equal(JSON.parse(body).provider,'openrouter');
  assert.ok(!body.includes('private-test-key'));
});

test('unconfigured generation is a clear error, not a sample substituted for new input',async t=>{
  const base=await server(t);
  const response=await fetch(`${base}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({problem:'A new question'})});
  assert.equal(response.status,503);
  const body=await response.json();
  assert.equal(body.code,'NOT_CONFIGURED');
  assert.doesNotMatch(body.error,/OPENAI|OPENROUTER|API_KEY|environment variable/i);
});

test('blank input and cross-origin calls are rejected',async t=>{
  const base=await server(t);
  const empty=await fetch(`${base}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"problem":"  "}'});
  assert.equal(empty.status,400);
  const foreign=await fetch(`${base}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://unrelated.example'},body:'{"problem":"x=1"}'});
  assert.equal(foreign.status,403);
});

test('the HTTP pipeline streams actual stages then its result',async t=>{
  const model=scriptedModel([readyPlan,fixturePage]);
  const base=await server(t,{config:{provider:'openai',apiKey:'fixture',model:'fixture',baseUrl:'https://model.example/v1'},model,
    check:async()=>({passed:true,playthrough:'passed',independentChecks:passingIndependentChecks,errors:[]})});
  const response=await fetch(`${base}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({problem:readyPlan.problem})});
  assert.match(response.headers.get('content-type'),/application\/x-ndjson/);
  const events=(await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(x=>x.type==='stage').map(x=>x.stage),['understanding','building','checking']);
  assert.equal(events.at(-1).game.html,fixturePage.html);
  assert.deepEqual(events.at(-1).game.assessment,readyPlan.assessment);
  assert.equal(events.at(-1).game.verification.mathematics,'not_independently_verified');
  assert.equal(events.at(-1).game.verification.playthrough,'passed');
  assert.deepEqual(events.at(-1).game.verification.independentChecks,passingIndependentChecks);
});

test('the HTTP stream delivers a friendly generation timeout before closing',async t=>{
  const timeoutMessage='This activity took too long to generate. Please try again.';
  const base=await server(t,{config:{provider:'openai',apiKey:'fixture',model:'fixture',baseUrl:'https://model.example/v1'},
    generate:async()=>{throw new GenerationError('GENERATION_TIMEOUT',timeoutMessage);}});
  const response=await fetch(`${base}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({problem:'x + 1 = 2'})});
  const events=(await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events,[{type:'error',code:'GENERATION_TIMEOUT',message:timeoutMessage}]);
});

test('files outside the fixed public assets cannot be read',async t=>{
  const base=await server(t);
  for(const suffix of ['/.env','/server/model.mjs','/%2e%2e/%2e%2e/etc/passwd']) {
    assert.equal((await fetch(base+suffix)).status,404);
  }
});

test('English curriculum projection is served from the fixed public asset route', async t => {
  const base = await server(t);
  const response = await fetch(`${base}/curriculum.en.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const expected = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/curriculum.en.json'), 'utf8');
  assert.equal(await response.text(), expected);
});
