import { GenerationError } from './contracts.mjs';

const openRouterDefaultModel = 'deepseek/deepseek-v3.2';

function schemaConstraintDescription(key, value) {
  if (key === 'pattern') {
    if (value === '^[a-z][a-z0-9_-]{0,39}$') {
      return 'Use a 1–40 character identifier: start with a lowercase letter, then use lowercase letters, digits, underscores, or hyphens. This is validated locally.';
    }
    if (value === '^#[A-Za-z][A-Za-z0-9_-]{0,79}$') {
      return 'Use a CSS id selector starting with # and a letter, followed by up to 79 letters, digits, underscores, or hyphens. This is validated locally.';
    }
    return `Match this local validation pattern: ${value}.`;
  }
  if (key === 'maxLength') return `Use at most ${value} characters; this is validated locally.`;
  if (key === 'minLength') return `Use at least ${value} characters; this is validated locally.`;
  if (key === 'maxItems') return `Use no more than ${value} items; this is validated locally.`;
  if (key === 'minItems') return `Use at least ${value} items; this is validated locally.`;
  if (key === 'uniqueItems') return 'Every item must be unique; this is validated locally.';
  if (key === 'minimum') return `Use a value greater than or equal to ${value}; this is validated locally.`;
  if (key === 'maximum') return `Use a value less than or equal to ${value}; this is validated locally.`;
  if (key === 'exclusiveMinimum') return `Use a value greater than ${value}; this is validated locally.`;
  if (key === 'exclusiveMaximum') return `Use a value less than ${value}; this is validated locally.`;
  if (key === 'multipleOf') return `Use a multiple of ${value}; this is validated locally.`;
  return null;
}

const compactedSchemaKeywords = new Set([
  'pattern', 'maxLength', 'minLength', 'maxItems', 'uniqueItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);
const schemaMapKeywords = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const schemaChildKeywords = new Set([
  'items', 'additionalItems', 'contains', 'additionalProperties', 'propertyNames',
  'not', 'if', 'then', 'else',
]);
const schemaArrayKeywords = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);

function mapSchemaValue(value) {
  if (Array.isArray(value)) return value.map(compactAnthropicSchema);
  return compactAnthropicSchema(value);
}

function compactAnthropicSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactAnthropicSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const result = {};
  const descriptions = [];
  for (const [key, value] of Object.entries(schema)) {
    const unsupportedMinItems = key === 'minItems' && value !== 0 && value !== 1;
    if (compactedSchemaKeywords.has(key) || unsupportedMinItems) {
      const description = schemaConstraintDescription(key, value);
      if (description) descriptions.push(description);
      continue;
    }
    if (schemaMapKeywords.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactAnthropicSchema(child)]));
    } else if (schemaChildKeywords.has(key)) {
      result[key] = mapSchemaValue(value);
    } else if (schemaArrayKeywords.has(key) && Array.isArray(value)) {
      result[key] = value.map(compactAnthropicSchema);
    } else {
      result[key] = value;
    }
  }
  if (descriptions.length) {
    const existing = typeof result.description === 'string' ? result.description : '';
    result.description = [existing, ...descriptions].filter(Boolean).join(' ');
  }
  return result;
}

export function anthropicWireSchema(schema, requestName) {
  const result = compactAnthropicSchema(schema);
  const field = requestName === 'play_plan' ? 'assessment'
    : requestName === 'playable_exercise' ? 'playtest' : null;
  const originalContract = schema?.properties?.[field];
  if (field && result?.properties && originalContract) {
    const isNullable = requestName === 'play_plan' || requestName === 'playable_exercise';
    result.properties[field] = {
      type: isNullable ? ['string', 'null'] : 'string',
      description: `Return this field as a JSON-encoded string matching the original nested contract: ${JSON.stringify(originalContract)}. The server parses the string and applies the full local contract.`,
    };
  }
  return result;
}

export function anthropicWireInstructions(instructions, requestName) {
  if (requestName === 'play_plan') {
    return `${instructions}\n\nWire format: return assessment as a JSON-encoded string containing the complete assessment object described in its schema-field description, or null when no assessment applies. Return valid JSON only, without Markdown or extra text. The server parses the string before full local validation.`;
  }
  if (requestName === 'playable_exercise') {
    return `${instructions}\n\nWire format: return playtest as a JSON-encoded string containing the complete playtest object described in its schema-field description, or null only when the page status is conflict. Return valid JSON only, without Markdown or extra text. The server parses the string before full local validation.`;
  }
  return instructions;
}

function parseAnthropicNestedJson(value, requestName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const field = requestName === 'play_plan' ? 'assessment'
    : requestName === 'playable_exercise' ? 'playtest' : null;
  if (field && Object.hasOwn(value, field) && value[field] !== null) {
    if (typeof value[field] !== 'string') {
      throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated content was not in the expected format.');
    }
    try { value[field] = JSON.parse(value[field]); }
    catch { throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated content was not in the expected format.'); }
  }
  return value;
}

function normalizeBaseUrl(value, fallback) {
  return (value?.trim() || fallback).replace(/\/$/, '');
}

export function modelConfig(env = process.env) {
  const requestedProvider = env.MODEL_PROVIDER?.trim();
  const provider = requestedProvider || (env.OPENROUTER_API_KEY?.trim() ? 'openrouter' : 'openai');
  if (provider === 'openrouter') {
    return {
      provider,
      apiKey: env.OPENROUTER_API_KEY?.trim() || '',
      model: env.OPENROUTER_MODEL?.trim() || openRouterDefaultModel,
      baseUrl: normalizeBaseUrl(env.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1'),
    };
  }
  if (provider === 'openai') {
    return {
      provider,
      apiKey: env.OPENAI_API_KEY?.trim() || '',
      model: env.OPENAI_MODEL?.trim() || '',
      baseUrl: normalizeBaseUrl(env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    };
  }
  return { provider, apiKey: '', model: '', baseUrl: '' };
}

export function isModelConfigured(config) {
  return ['openai', 'openrouter'].includes(config?.provider) && Boolean(config.apiKey && config.model && config.baseUrl);
}

export function sanitizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const safe = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0) safe[key] = usage[key];
  }
  if (Number.isFinite(usage.cost) && usage.cost >= 0) safe.cost = usage.cost;
  return Object.keys(safe).length ? safe : null;
}

export function createModelClient(config, fetcher = fetch) {
  return {
    async complete({ instructions, input, schema, name, signal }) {
      if (!isModelConfigured(config)) {
        throw new GenerationError('NOT_CONFIGURED', 'Exercise generation is currently unavailable.');
      }
      const body = {
        model: config.model,
        instructions: config.provider === 'openrouter' && config.model === 'anthropic/claude-sonnet-5.5'
          ? anthropicWireInstructions(instructions, name) : instructions,
        input: JSON.stringify(input),
        store: false,
        max_output_tokens: ['play_plan', 'repaired_exercise'].includes(name) ? 6000 : 16000,
        text: { format: { type: 'json_schema', name,
          schema: config.provider === 'openrouter' && config.model === 'anthropic/claude-sonnet-5.5'
            ? anthropicWireSchema(schema, name) : schema,
          strict: true } },
      };
      if (config.provider === 'openrouter') {
        body.stream = false;
        body.provider = { require_parameters: true };
        if (config.model === 'anthropic/claude-sonnet-5.5') body.reasoning = { effort: 'medium' };
      }

      let response;
      try {
        response = await fetcher(`${config.baseUrl}/responses`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        signal?.throwIfAborted();
        throw new GenerationError('MODEL_UNAVAILABLE', 'The model service could not be reached. Please try again.');
      }
      if (!response.ok) {
        throw new GenerationError('MODEL_REQUEST_FAILED', 'The model service could not complete the request. Please try again.');
      }
      let result;
      try { result = await response.json(); } catch {
        signal?.throwIfAborted();
        throw new GenerationError('INVALID_MODEL_OUTPUT', 'The model service returned an unreadable response.');
      }
      if (result?.status !== 'completed') {
        const error = new GenerationError('INCOMPLETE_MODEL_OUTPUT', 'The model did not finish the exercise. Please try again.');
        error.usage = sanitizeUsage(result?.usage);
        if (result?.incomplete_details?.reason === 'max_output_tokens') error.incompleteReason = 'max_output_tokens';
        throw error;
      }
      const contents = (Array.isArray(result.output) ? result.output : [])
        .filter(item => item?.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []);
      if (contents.some(item => item?.type === 'refusal')) {
        throw new GenerationError('MODEL_REFUSAL', 'The model could not generate an exercise for that input.');
      }
      const text = contents.filter(item => item?.type === 'output_text').map(item => item.text).join('');
      let value;
      try { value = JSON.parse(text); } catch {
        throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated content was not in the expected format.');
      }
      if (config.provider === 'openrouter' && config.model === 'anthropic/claude-sonnet-5.5') {
        value = parseAnthropicNestedJson(value, name);
      }
      return { value, usage: sanitizeUsage(result.usage) };
    },
  };
}
