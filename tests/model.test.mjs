import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicWireInstructions, anthropicWireSchema, createModelClient, isModelConfigured, modelConfig } from '../server/model.mjs';
import { htmlSchema, planSchema, validatePage, validatePlan } from '../server/contracts.mjs';
import { gameInstructions, planInstructions } from '../server/prompts.mjs';
import { fixturePage, fixturePlaytest, readyPlan } from './fixtures.mjs';

const config = { provider: 'openai', apiKey: 'fixture-key', model: 'fixture-model', baseUrl: 'https://model.example/v1' };
const request = { instructions: 'Use the contract.', input: { problem: 'x+1=2' }, schema: { type: 'object' }, name: 'fixture' };

test('OpenAI Responses parsing accepts text after a reasoning item and keeps credentials server-side', async () => {
  let submitted;
  const model = createModelClient(config, async (url, options) => {
    submitted = { url, options };
    return Response.json({ status: 'completed', output: [{ type: 'reasoning' },
      { type: 'message', content: [{ type: 'output_text', text: '{"answer":1}' }] }],
    usage: { input_tokens: 2, output_tokens: 3, provider_payload: 'never preserve' } });
  });
  const result = await model.complete(request);
  assert.deepEqual(result.value, { answer: 1 });
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
  assert.equal(submitted.url, 'https://model.example/v1/responses');
  const body = JSON.parse(submitted.options.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.model, 'fixture-model');
  assert.ok(!submitted.options.body.includes('fixture-key'));
  assert.ok(!JSON.stringify(result).includes('provider_payload'));
});

test('OpenRouter config selects its model and sends bounded Responses parameters', async () => {
  const openrouter = modelConfig({ OPENROUTER_API_KEY: 'router-secret' });
  assert.deepEqual(openrouter, {
    provider: 'openrouter', apiKey: 'router-secret', model: 'deepseek/deepseek-v3.2',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  let submitted;
  const model = createModelClient(openrouter, async (url, options) => {
    submitted = { url, options };
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: '{"ok":true}' },
    ] }], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, cost: 0.001 } });
  });
  const result = await model.complete(request);
  assert.deepEqual(result.value, { ok: true });
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6, cost: 0.001 });
  assert.equal(submitted.url, 'https://openrouter.ai/api/v1/responses');
  const body = JSON.parse(submitted.options.body);
  assert.equal(body.model, 'deepseek/deepseek-v3.2');
  assert.equal(body.stream, false);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 16000);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema, request.schema);
  assert.equal(submitted.options.headers.Authorization, 'Bearer router-secret');
  assert.ok(!submitted.options.body.includes('router-secret'));
});

test('OpenRouter Sonnet 5.5 uses medium reasoning effort on every stage without changing caps', async () => {
  const sonnet = { provider: 'openrouter', apiKey: 'router-secret', model: 'anthropic/claude-sonnet-5.5',
    baseUrl: 'https://openrouter.ai/api/v1' };
  const submitted = [];
  const model = createModelClient(sonnet, async (_url, options) => {
    submitted.push(JSON.parse(options.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: '{"ok":true}' },
    ] }] });
  });
  for (const name of ['play_plan', 'playable_exercise', 'repaired_exercise']) await model.complete({ ...request, name });
  assert.deepEqual(submitted.map(body => body.reasoning), [
    { effort: 'medium' }, { effort: 'medium' }, { effort: 'medium' },
  ]);
  assert.deepEqual(submitted.map(body => body.max_output_tokens), [6000, 16000, 6000]);
});

test('Anthropic wire schema drops only local constraints and preserves schema-shaped property names', async () => {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      maxLength: { type: 'string', maxLength: 4096 },
      pattern: { type: 'array', minItems: 1, maxItems: 64,
        items: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' } },
      unique: { type: 'array', uniqueItems: true, items: { type: 'string' } },
      numeric: { type: 'integer', minimum: 1, maximum: 40 },
    },
    required: ['maxLength', 'pattern', 'unique', 'numeric'],
  };
  const original = structuredClone(schema);
  const wireSchema = anthropicWireSchema(schema);
  assert.deepEqual(schema, original);
  assert.deepEqual(Object.keys(wireSchema.properties), ['maxLength', 'pattern', 'unique', 'numeric']);
  assert.equal(wireSchema.properties.maxLength.maxLength, undefined);
  assert.match(wireSchema.properties.maxLength.description, /at most 4096 characters/i);
  assert.equal(wireSchema.properties.pattern.maxItems, undefined);
  assert.equal(wireSchema.properties.pattern.minItems, 1);
  assert.equal(wireSchema.properties.pattern.items.pattern, undefined);
  assert.match(wireSchema.properties.pattern.items.description, /lowercase letter/i);
  assert.equal(wireSchema.properties.unique.uniqueItems, undefined);
  assert.match(wireSchema.properties.unique.description, /unique/i);
  assert.equal(wireSchema.properties.numeric.minimum, undefined);
  assert.equal(wireSchema.properties.numeric.maximum, undefined);
  assert.match(wireSchema.properties.numeric.description, /greater than or equal to 1/i);

  let submitted;
  const sonnet = { provider: 'openrouter', apiKey: 'router-secret', model: 'anthropic/claude-sonnet-5.5',
    baseUrl: 'https://openrouter.ai/api/v1' };
  await createModelClient(sonnet, async (_url, options) => {
    submitted = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: '{"ok":true}' },
    ] }] });
  }).complete({ ...request, schema });
  assert.deepEqual(submitted.text.format.schema, wireSchema);
  assert.deepEqual(schema, original);
});

test('Anthropic nested assessment and playtest JSON strings round-trip into the unchanged local contracts', async () => {
  const sonnet = { provider: 'openrouter', apiKey: 'router-secret', model: 'anthropic/claude-sonnet-5.5',
    baseUrl: 'https://openrouter.ai/api/v1' };
  const outputs = [
    { ...readyPlan, assessment: JSON.stringify(readyPlan.assessment) },
    { ...fixturePage, playtest: JSON.stringify(fixturePlaytest) },
  ];
  const submitted = [];
  const model = createModelClient(sonnet, async (_url, options) => {
    submitted.push(JSON.parse(options.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(outputs.shift()) },
    ] }] });
  });

  const plan = await model.complete({ name: 'play_plan', instructions: planInstructions,
    input: { originalProblem: readyPlan.problem }, schema: planSchema });
  assert.deepEqual(plan.value.assessment, readyPlan.assessment);
  assert.equal(validatePlan(plan.value, { requireAssessment: true }), plan.value);
  assert.deepEqual(submitted[0].text.format.schema.properties.assessment.type, ['string', 'null']);
  assert.ok(submitted[0].text.format.schema.properties.assessment.description.includes(JSON.stringify(planSchema.properties.assessment)));
  assert.equal(submitted[0].instructions, anthropicWireInstructions(planInstructions, 'play_plan'));

  const page = await model.complete({ name: 'playable_exercise', instructions: gameInstructions,
    input: { originalProblem: readyPlan.problem, plan: readyPlan }, schema: htmlSchema });
  assert.deepEqual(page.value.playtest, fixturePlaytest);
  assert.equal(validatePage(page.value, { requirePlaytest: true }), page.value);
  assert.deepEqual(submitted[1].text.format.schema.properties.playtest.type, ['string', 'null']);
  assert.ok(submitted[1].text.format.schema.properties.playtest.description.includes(JSON.stringify(htmlSchema.properties.playtest)));
  assert.equal(submitted[1].instructions, anthropicWireInstructions(gameInstructions, 'playable_exercise'));
});

test('malformed Anthropic nested JSON fails with a safe invalid-output error', async () => {
  const sonnet = { provider: 'openrouter', apiKey: 'router-secret', model: 'anthropic/claude-sonnet-5.5',
    baseUrl: 'https://openrouter.ai/api/v1' };
  for (const [name, instructions, schema, field] of [
    ['play_plan', planInstructions, planSchema, 'assessment'],
    ['playable_exercise', gameInstructions, htmlSchema, 'playtest'],
  ]) {
    for (const nested of ['{malformed nested JSON', { unexpected: 'object' }]) {
      const value = { [field]: nested };
      const model = createModelClient(sonnet, async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify(value) },
      ] }] }));
      await assert.rejects(model.complete({ name, instructions, input: { originalProblem: 'fixture' }, schema }), error =>
        error.code === 'INVALID_MODEL_OUTPUT' && error.message === 'The generated content was not in the expected format.' &&
        !JSON.stringify(error).includes('malformed nested JSON'));
    }
  }
});

test('Anthropic wire transport leaves other OpenRouter models on the original response schema', async () => {
  const deepseek = { provider: 'openrouter', apiKey: 'router-secret', model: 'deepseek/deepseek-v3.2',
    baseUrl: 'https://openrouter.ai/api/v1' };
  const schema = { type: 'object', properties: { answer: { type: 'string', maxLength: 12 } }, required: ['answer'] };
  let body;
  await createModelClient(deepseek, async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: '{"answer":"ok"}' },
    ] }] });
  }).complete({ ...request, schema });
  assert.deepEqual(body.text.format.schema, schema);
  assert.equal(body.instructions, request.instructions);
});

test('medium reasoning effort is absent for other models and providers', async () => {
  const configs = [
    { ...config, provider: 'openrouter' },
    { ...config, model: 'anthropic/claude-sonnet-5.5' },
  ];
  for (const selected of configs) {
    let body;
    await createModelClient(selected, async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: '{"ok":true}' },
      ] }] });
    }).complete(request);
    assert.equal(Object.hasOwn(body, 'reasoning'), false);
  }
});

test('only the repair response cap is reduced to 6000 output tokens', async () => {
  const submitted = [];
  const model = createModelClient(config, async (_url, options) => {
    submitted.push(JSON.parse(options.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: '{"ok":true}' },
    ] }] });
  });
  for (const name of ['play_plan', 'playable_exercise', 'repaired_exercise']) await model.complete({ ...request, name });
  assert.deepEqual(submitted.map(body => [body.model, body.max_output_tokens]), [
    ['fixture-model', 6000], ['fixture-model', 16000], ['fixture-model', 6000],
  ]);
});

test('provider selection keeps OpenAI compatibility and fails closed for unknown providers', async () => {
  const openai = modelConfig({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'gpt-test',
    OPENROUTER_API_KEY: 'router-key', OPENROUTER_MODEL: 'router-model' });
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.apiKey, 'openai-key');
  assert.equal(openai.model, 'gpt-test');
  let authorization;
  await createModelClient(openai, async (_url, options) => {
    authorization = options.headers.Authorization;
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: '{"ok":true}' },
    ] }] });
  }).complete(request);
  assert.equal(authorization, 'Bearer openai-key');

  const missingRouterKey = modelConfig({ MODEL_PROVIDER: 'openrouter', OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'gpt-test' });
  assert.equal(isModelConfigured(missingRouterKey), false);
  const unknown = modelConfig({ MODEL_PROVIDER: 'other', OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'gpt-test',
    OPENROUTER_API_KEY: 'router-key', OPENROUTER_MODEL: 'router-model' });
  assert.equal(isModelConfigured(unknown), false);
  let called = false;
  await assert.rejects(createModelClient(unknown, async () => { called = true; }).complete(request), error =>
    error.code === 'NOT_CONFIGURED' && !/OPENAI|OPENROUTER|API_KEY/.test(error.message));
  assert.equal(called, false);
});

test('provider errors do not expose response bodies or setup details', async () => {
  const model = createModelClient(config, async () => new Response('OPENAI_API_KEY=secret raw upstream diagnostic', { status: 401 }));
  await assert.rejects(model.complete(request), error => error.code === 'MODEL_REQUEST_FAILED' &&
    !/secret|diagnostic|OPENAI_API_KEY/.test(error.message));
});

test('incomplete outputs, refusals and invalid JSON are not accepted as generated content', async () => {
  for (const [body, code] of [
    [{ status: 'incomplete', output: [] }, 'INCOMPLETE_MODEL_OUTPUT'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'MODEL_REFUSAL'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not-json' }] }] }, 'INVALID_MODEL_OUTPUT'],
  ]) {
    const model = createModelClient(config, async () => Response.json(body));
    await assert.rejects(model.complete(request), error => error.code === code);
  }
});

test('incomplete output preserves only sanitized usage and the exact allowlisted reason', async () => {
  const model = createModelClient(config, async () => Response.json({
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens', provider_secret: 'do-not-retain' },
    output: [{ type: 'reasoning', summary: [{ text: 'hidden reasoning secret' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'partial output secret' }] }],
    usage: { input_tokens: 8, output_tokens: 144, total_tokens: 152, cost: 0.004,
      provider_payload: 'provider secret' },
    response_secret: 'response secret',
  }));
  await assert.rejects(model.complete(request), error => {
    assert.equal(error.code, 'INCOMPLETE_MODEL_OUTPUT');
    assert.equal(error.message, 'The model did not finish the exercise. Please try again.');
    assert.deepEqual(error.usage, { input_tokens: 8, output_tokens: 144, total_tokens: 152, cost: 0.004 });
    assert.equal(error.incompleteReason, 'max_output_tokens');
    assert.doesNotMatch(JSON.stringify(error), /provider_secret|hidden reasoning|partial output|response_secret|provider_payload/);
    return true;
  });
});

test('incomplete output omits an unknown raw reason', async () => {
  const model = createModelClient(config, async () => Response.json({
    status: 'incomplete', incomplete_details: { reason: 'provider-secret-reason' },
  }));
  await assert.rejects(model.complete(request), error => {
    assert.equal(error.code, 'INCOMPLETE_MODEL_OUTPUT');
    assert.equal(error.usage, null);
    assert.equal(Object.hasOwn(error, 'incompleteReason'), false);
    assert.doesNotMatch(JSON.stringify(error), /provider-secret-reason/);
    return true;
  });
});
