import { createActivityRuntime } from '../public/activity-runtime.js';
import { createExactMath } from '../public/sandbox.js';

export class GenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
  }
}

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const activityTypes = ['solve', 'explore', 'reason', 'model'];
const exactRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['exact'] }, expected: string }, required: ['kind', 'expected'] };
const approximateRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['approx'] }, expected: string, tolerance: string },
  required: ['kind', 'expected', 'tolerance'] };
const quantityRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['quantity'] }, expected: string, unit: string,
    units: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false,
      properties: { symbol: string, factor: string }, required: ['symbol', 'factor'] } } },
  required: ['kind', 'expected', 'unit', 'units'] };
const intervalRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['interval', 'range'] }, lower: string, upper: string,
    lowerClosed: { type: 'boolean' }, upperClosed: { type: 'boolean' } },
  required: ['kind', 'lower', 'upper', 'lowerClosed', 'upperClosed'] };
const choiceRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['choice'] }, accepted: { type: 'array', minItems: 1, maxItems: 40, items: string } },
  required: ['kind', 'accepted'] };
const reviewRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['review'] } }, required: ['kind'] };
const relationConditionSchema = { type: 'object', additionalProperties: false,
  properties: { left: { type: 'string', minLength: 1, maxLength: 256 },
    operator: { type: 'string', enum: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] },
    right: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['left', 'operator', 'right'] };
const relationRuleSchema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['relation'] },
    integerFields: { type: 'array', maxItems: 40, uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' } },
    conditions: { type: 'array', minItems: 1, maxItems: 12, items: relationConditionSchema } },
  required: ['kind', 'integerFields', 'conditions'] };
const checkpointRuleSchema = { anyOf: [exactRuleSchema, approximateRuleSchema, quantityRuleSchema,
  intervalRuleSchema, choiceRuleSchema, reviewRuleSchema, relationRuleSchema] };
export const assessmentSchema = { type: 'object', additionalProperties: false,
  properties: { version: { type: 'integer', enum: [1] }, requiresReview: { type: 'boolean' },
    fields: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' }, initial: { type: 'string', maxLength: 4096 } },
      required: ['id', 'initial'] } },
    checkpoints: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' }, field: { type: 'string' },
        dependsOn: strings, watchFields: strings, rule: checkpointRuleSchema,
        feedback: { type: 'string', minLength: 1, maxLength: 1000 } },
      required: ['id', 'field', 'dependsOn', 'watchFields', 'rule', 'feedback'] } } },
  required: ['version', 'requiresReview', 'fields', 'checkpoints'] };
const nullableAssessmentSchema = { anyOf: [assessmentSchema, { type: 'null' }] };
const selectorPattern = '^#[A-Za-z][A-Za-z0-9_-]{0,79}$';
const actionSchemas = ['click', 'fill', 'select', 'press'].map(action => ({ type: 'object', additionalProperties: false,
  properties: { action: { type: 'string', enum: [action] }, selector: { type: 'string', pattern: selectorPattern },
    value: action === 'click' ? { type: 'null' } : action === 'press'
      ? { type: 'string', enum: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Space', 'Backspace', 'Tab'] }
      : { type: 'string', maxLength: 4096 } }, required: ['action', 'selector', 'value'] }));
const playtestTraceSchema = { type: 'array', minItems: 1, maxItems: 64, items: { anyOf: actionSchemas } };
export const playtestSchema = { type: 'object', additionalProperties: false,
  properties: { solve: playtestTraceSchema, wrong: playtestTraceSchema, recover: playtestTraceSchema, invalidate: playtestTraceSchema },
  required: ['solve', 'wrong', 'recover', 'invalidate'] };
const nullablePlaytestSchema = { anyOf: [playtestSchema, { type: 'null' }] };
export const planSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ready', 'clarify'] },
    title: string, problem: string, topics: strings, constraints: strings,
    referenceAnswer: string, objective: string, activityType: { type: 'string', enum: activityTypes },
    initialState: string, invariants: strings, actions: strings, hints: strings,
    requiresReview: { type: 'boolean' }, winCondition: string, explanation: string,
    clarification: { type: ['string', 'null'] },
    assessment: nullableAssessmentSchema,
  },
  required: ['status', 'title', 'problem', 'topics', 'constraints', 'referenceAnswer',
    'objective', 'activityType', 'initialState', 'invariants', 'actions', 'hints',
    'requiresReview', 'winCondition', 'explanation', 'clarification', 'assessment'],
};

export const htmlSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ready', 'conflict'] },
    html: string,
    issue: { type: ['string', 'null'] },
    playtest: nullablePlaytestSchema,
  },
  required: ['status', 'html', 'issue', 'playtest'],
};

export const repairSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ready', 'conflict'] },
    edits: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        properties: { find: { type: 'string', maxLength: 12000 }, replace: { type: 'string', maxLength: 12000 } },
        required: ['find', 'replace'],
      },
    },
    issue: { type: ['string', 'null'], maxLength: 1000 },
  },
  required: ['status', 'edits', 'issue'],
};

const planFields = new Set(planSchema.required);
const pageFields = new Set(htmlSchema.required);
const repairFields = new Set(repairSchema.required);
const repairEditFields = new Set(['find', 'replace']);
const maxRepairEdits = 6;
const maxRepairFieldLength = 12000;
const maxRepairTextLength = 24000;

function hasOnlyFields(value, fields) {
  return Object.keys(value).every(key => fields.has(key));
}

const validPressKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
  'Enter', 'Space', 'Backspace', 'Tab']);

export function validateAssessment(assessment) {
  try { createActivityRuntime(assessment, createExactMath()); }
  catch { throw new GenerationError('INVALID_MODEL_OUTPUT', 'The exercise plan was incomplete. Please try again.'); }
}

export function validatePlaytest(playtest) {
  const invalid = () => { throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated exercise was incomplete. Please try again.'); };
  const phases = ['solve', 'wrong', 'recover', 'invalidate'];
  if (!playtest || typeof playtest !== 'object' || Array.isArray(playtest) || !hasOnlyFields(playtest, new Set(phases))) invalid();
  let total = 0;
  for (const phase of phases) {
    const actions = playtest[phase];
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 64) invalid();
    total += actions.length;
    for (const action of actions) {
      if (!action || typeof action !== 'object' || Array.isArray(action) ||
          !hasOnlyFields(action, new Set(['action', 'selector', 'value'])) ||
          !['click', 'fill', 'select', 'press'].includes(action.action) ||
          typeof action.selector !== 'string' || /[\r\n]/.test(action.selector) ||
          !new RegExp(selectorPattern).test(action.selector)) invalid();
      if (action.action === 'click' ? action.value !== null : typeof action.value !== 'string' || action.value.length > 4096) invalid();
      if (action.action === 'press' && !validPressKeys.has(action.value)) invalid();
    }
  }
  if (total > 200) invalid();
}

export function validatePlan(value, { requireAssessment = false } = {}) {
  const invalid = () => {
    throw new GenerationError('INVALID_MODEL_OUTPUT', 'The exercise plan was incomplete. Please try again.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyFields(value, planFields) ||
      !['ready', 'clarify'].includes(value.status)) invalid();
  if (requireAssessment && !Object.hasOwn(value, 'assessment')) invalid();

  const textFields = ['title', 'problem', 'referenceAnswer', 'objective', 'initialState', 'winCondition', 'explanation'];
  for (const key of textFields) {
    if (typeof value[key] !== 'string' || value[key].length > 20000) invalid();
    if (value.status === 'ready' && !value[key].trim()) invalid();
  }
  if (!activityTypes.includes(value.activityType) || typeof value.requiresReview !== 'boolean') invalid();

  for (const key of ['topics', 'constraints', 'invariants', 'actions', 'hints']) {
    const maxLength = key === 'hints' ? 3000 : 5000;
    if (!Array.isArray(value[key]) || value[key].length > 50 ||
        value[key].some(item => typeof item !== 'string' || item.length > maxLength)) invalid();
  }
  if (value.actions.some(action => !action.trim())) invalid();
  if (value.status === 'ready') {
    const normalizedHints = value.hints.map(hint => hint.trim().toLocaleLowerCase());
    if (!value.actions.length || value.clarification !== null || value.hints.length < 2 ||
        value.hints.some(hint => !hint.trim()) || new Set(normalizedHints).size < 2 ||
        value.invariants.some(invariant => !invariant.trim())) invalid();
  }
  if (value.clarification !== null && typeof value.clarification !== 'string') invalid();
  if (value.status === 'clarify' && (typeof value.clarification !== 'string' ||
      !value.clarification.trim() || value.clarification.length > 3000)) invalid();
  if (Object.hasOwn(value, 'assessment')) {
    if (value.status === 'clarify') {
      if (value.assessment !== null) invalid();
    } else {
      if (!value.assessment || value.assessment.requiresReview !== value.requiresReview) invalid();
      validateAssessment(value.assessment);
    }
  } else if (requireAssessment) invalid();
  return value;
}

function validateDocument(html) {
  if (typeof html !== 'string' || html.length > 300000 ||
      !/<html[\s>]/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated exercise was incomplete. Please try again.');
  }
  return html;
}

export function validatePage(value, { requirePlaytest = false } = {}) {
  const invalid = () => {
    throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated exercise was incomplete. Please try again.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyFields(value, pageFields) ||
      !['ready', 'conflict'].includes(value.status) || typeof value.html !== 'string' || value.html.length > 300000) invalid();
  if (requirePlaytest && !Object.hasOwn(value, 'playtest')) invalid();
  if (value.status === 'conflict') {
    if (typeof value.issue !== 'string' || !value.issue.trim() || value.issue.length > 3000) invalid();
    if (Object.hasOwn(value, 'playtest') && value.playtest !== null) invalid();
    if (requirePlaytest && !Object.hasOwn(value, 'playtest')) invalid();
    return value;
  }
  if (value.issue !== null) invalid();
  if (Object.hasOwn(value, 'playtest')) {
    if (value.playtest === null) invalid();
    validatePlaytest(value.playtest);
  } else if (requirePlaytest) invalid();
  validateDocument(value.html);
  return value;
}

export function validateRepairPatch(value) {
  const invalid = () => {
    throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated exercise could not be safely repaired. Please try again.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyFields(value, repairFields) ||
      !['ready', 'conflict'].includes(value.status) || !Array.isArray(value.edits) || value.edits.length > maxRepairEdits) invalid();

  if (value.status === 'conflict') {
    if (value.edits.length !== 0 || typeof value.issue !== 'string' || !value.issue.trim() || value.issue.length > 1000) invalid();
    return value;
  }

  if (value.issue !== null || value.edits.length === 0) invalid();
  let textLength = 0;
  for (const edit of value.edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || !hasOnlyFields(edit, repairEditFields) ||
        typeof edit.find !== 'string' || typeof edit.replace !== 'string' || !edit.find.length ||
        edit.find.length > maxRepairFieldLength || edit.replace.length > maxRepairFieldLength ||
        edit.find === edit.replace) invalid();
    textLength += edit.find.length + edit.replace.length;
    if (textLength > maxRepairTextLength) invalid();
  }
  return value;
}

export function applyRepairPatch(html, value) {
  const patch = validateRepairPatch(value);
  if (patch.status !== 'ready' || typeof html !== 'string') {
    throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated exercise could not be safely repaired. Please try again.');
  }

  let repaired = html;
  for (const edit of patch.edits) {
    const first = repaired.indexOf(edit.find);
    if (first === -1 || repaired.indexOf(edit.find, first + 1) !== -1) {
      throw new GenerationError('INVALID_MODEL_OUTPUT', 'The generated exercise could not be safely repaired. Please try again.');
    }
    repaired = repaired.slice(0, first) + edit.replace + repaired.slice(first + edit.find.length);
  }
  return validateDocument(repaired);
}
