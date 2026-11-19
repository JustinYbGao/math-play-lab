import { bindActivityRuntime, createActivityRuntime } from './activity-runtime.js';

const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function createExactMath() {
  const decimalPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const fractionPattern = new RegExp(`^(${decimalPattern})\\s*\\/\\s*(${decimalPattern})$`);

  function parseDecimal(value) {
    const match = value.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
    if (!match) return null;

    const whole = match[2] ?? '0';
    const fractional = match[3] ?? match[4] ?? '';
    const sign = match[1] === '-' ? -1n : 1n;
    return {
      numerator: sign * BigInt(`${whole}${fractional}`),
      denominator: 10n ** BigInt(fractional.length),
    };
  }

  function parse(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? { numerator: BigInt(value), denominator: 1n } : null;
    }
    if (typeof value !== 'string' || value.length > 256) return null;

    const text = value.trim();
    const fraction = text.match(fractionPattern);
    if (fraction) {
      const numerator = parseDecimal(fraction[1]);
      const denominator = parseDecimal(fraction[2]);
      if (!numerator || !denominator || denominator.numerator === 0n) return null;

      let resultNumerator = numerator.numerator * denominator.denominator;
      let resultDenominator = numerator.denominator * denominator.numerator;
      if (resultDenominator < 0n) {
        resultNumerator = -resultNumerator;
        resultDenominator = -resultDenominator;
      }
      return { numerator: resultNumerator, denominator: resultDenominator };
    }
    return parseDecimal(text);
  }

  function equals(left, right) {
    const first = parse(left);
    const second = parse(right);
    return first !== null && second !== null &&
      first.numerator * second.denominator === second.numerator * first.denominator;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }

  function exactKeys(value, keys) {
    return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  }

  function validNumericString(value) {
    return typeof value === 'string' && value.length <= 256 && parse(value) !== null;
  }

  const relationIdPattern = /^[a-z][a-z0-9_-]{0,39}$/;
  const relationOperators = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']);
  const maxRelationDigits = 4096;

  function relationRational(numerator, denominator) {
    if (denominator === 0n) throw new TypeError('Undefined relation arithmetic.');
    if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
    let left = numerator < 0n ? -numerator : numerator;
    let right = denominator;
    while (right) [left, right] = [right, left % right];
    const divisor = left || 1n;
    const result = { numerator: numerator / divisor, denominator: denominator / divisor };
    const numeratorDigits = (result.numerator < 0n ? -result.numerator : result.numerator).toString().length;
    if (numeratorDigits > maxRelationDigits || result.denominator.toString().length > maxRelationDigits) {
      throw new RangeError('Relation arithmetic exceeds its size limit.');
    }
    return result;
  }

  function tokenizeRelation(expression) {
    if (typeof expression !== 'string' || expression.length < 1 || expression.length > 256) throw new TypeError('Invalid relation expression.');
    const tokens = [];
    let index = 0;
    const addToken = token => {
      tokens.push(token);
      if (tokens.length > 128) throw new TypeError('Relation expression has too many tokens.');
    };
    while (index < expression.length) {
      const character = expression[index];
      if (/[ \t\r\n\f\v]/.test(character)) { index += 1; continue; }
      const remainder = expression.slice(index);
      if (character === '[') {
        const match = remainder.match(/^\[([a-z][a-z0-9_-]{0,39})\]/);
        if (!match) throw new TypeError('Invalid relation field reference.');
        addToken({ type: 'field', value: match[1] });
        index += match[0].length;
        continue;
      }
      if (/[0-9.]/.test(character)) {
        const match = remainder.match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
        if (!match) throw new TypeError('Invalid relation number.');
        const parsed = parseDecimal(match[0]);
        if (!parsed) throw new TypeError('Invalid relation number.');
        addToken({ type: 'number', raw: match[0], value: relationRational(parsed.numerator, parsed.denominator) });
        index += match[0].length;
        continue;
      }
      if ('+-*/^()'.includes(character)) {
        addToken({ type: character, value: character });
        index += 1;
        continue;
      }
      throw new TypeError('Unsupported relation expression token.');
    }
    return tokens;
  }

  function parseRelationExpression(expression) {
    const tokens = tokenizeRelation(expression);
    let index = 0;
    const current = () => tokens[index];
    const fail = () => { throw new TypeError('Invalid relation expression.'); };

    function primary(depth) {
      const token = current();
      if (!token) return fail();
      if (token.type === 'number') { index += 1; return { type: 'number', value: token.value }; }
      if (token.type === 'field') { index += 1; return { type: 'field', id: token.value }; }
      if (token.type === '(') {
        if (depth >= 12) return fail();
        index += 1;
        const node = sum(depth + 1);
        if (current()?.type !== ')') return fail();
        index += 1;
        return node;
      }
      return fail();
    }

    function power(depth) {
      let node = primary(depth);
      if (current()?.type === '^') {
        index += 1;
        const exponent = current();
        if (exponent?.type !== 'number' || !/^\d+$/.test(exponent.raw)) return fail();
        const value = BigInt(exponent.raw);
        if (value > 12n) return fail();
        index += 1;
        node = { type: 'power', base: node, exponent: Number(value) };
      }
      return node;
    }

    function unary(depth) {
      const token = current();
      if (token?.type === '+' || token?.type === '-') {
        if (depth >= 12) return fail();
        index += 1;
        return { type: 'unary', operator: token.type, value: unary(depth + 1) };
      }
      return power(depth);
    }

    function product(depth) {
      let node = unary(depth);
      while (current()?.type === '*' || current()?.type === '/') {
        const operator = current().type;
        index += 1;
        node = { type: 'binary', operator, left: node, right: unary(depth) };
      }
      return node;
    }

    function sum(depth) {
      let node = product(depth);
      while (current()?.type === '+' || current()?.type === '-') {
        const operator = current().type;
        index += 1;
        node = { type: 'binary', operator, left: node, right: product(depth) };
      }
      return node;
    }

    const ast = sum(0);
    if (index !== tokens.length) fail();
    return ast;
  }

  function walkRelation(node, visit) {
    visit(node);
    if (node.type === 'unary') walkRelation(node.value, visit);
    else if (node.type === 'power') walkRelation(node.base, visit);
    else if (node.type === 'binary') {
      walkRelation(node.left, visit);
      walkRelation(node.right, visit);
    }
  }

  function relationHasField(node) {
    let found = false;
    walkRelation(node, item => { if (item.type === 'field') found = true; });
    return found;
  }

  function relationExpressionFields(node, fields) {
    walkRelation(node, item => { if (item.type === 'field') fields.add(item.id); });
  }

  function relationInput(fieldId, values) {
    if (!isObject(values) || !Object.hasOwn(values, fieldId) || typeof values[fieldId] !== 'string') {
      throw new TypeError('Missing numeric relation field.');
    }
    const value = parse(values[fieldId]);
    if (!value) throw new TypeError('Invalid numeric relation field.');
    return relationRational(value.numerator, value.denominator);
  }

  function evaluateRelation(node, values) {
    if (node.type === 'number') return node.value;
    if (node.type === 'field') return relationInput(node.id, values);
    if (node.type === 'unary') {
      const value = evaluateRelation(node.value, values);
      return node.operator === '-' ? relationRational(-value.numerator, value.denominator) : value;
    }
    if (node.type === 'power') {
      const base = evaluateRelation(node.base, values);
      if (node.exponent === 0 && base.numerator === 0n) throw new TypeError('Zero to the zero power is undefined.');
      return relationRational(base.numerator ** BigInt(node.exponent), base.denominator ** BigInt(node.exponent));
    }
    const left = evaluateRelation(node.left, values);
    const right = evaluateRelation(node.right, values);
    if (node.operator === '+') return relationRational(left.numerator * right.denominator + right.numerator * left.denominator,
      left.denominator * right.denominator);
    if (node.operator === '-') return relationRational(left.numerator * right.denominator - right.numerator * left.denominator,
      left.denominator * right.denominator);
    if (node.operator === '*') return relationRational(left.numerator * right.numerator,
      left.denominator * right.denominator);
    if (right.numerator === 0n) throw new TypeError('Division by zero is undefined.');
    return relationRational(left.numerator * right.denominator, left.denominator * right.numerator);
  }

  function validateRelationConstants(node) {
    if (node.type === 'unary') validateRelationConstants(node.value);
    else if (node.type === 'power') validateRelationConstants(node.base);
    else if (node.type === 'binary') {
      validateRelationConstants(node.left);
      validateRelationConstants(node.right);
    }
    if (!relationHasField(node)) evaluateRelation(node, {});
  }

  function compileRelation(rule) {
    try {
      if (!exactKeys(rule, ['kind', 'integerFields', 'conditions']) || rule.kind !== 'relation' ||
          !Array.isArray(rule.integerFields) || rule.integerFields.length > 40 ||
          !Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > 12) return null;
      const integerFields = new Set();
      for (const id of rule.integerFields) {
        if (!relationIdPattern.test(id) || integerFields.has(id)) return null;
        integerFields.add(id);
      }
      const fields = new Set();
      const conditions = [];
      for (const condition of rule.conditions) {
        if (!exactKeys(condition, ['left', 'operator', 'right']) || !relationOperators.has(condition.operator)) return null;
        const left = parseRelationExpression(condition.left);
        const right = parseRelationExpression(condition.right);
        validateRelationConstants(left);
        validateRelationConstants(right);
        relationExpressionFields(left, fields);
        relationExpressionFields(right, fields);
        conditions.push({ left, operator: condition.operator, right });
      }
      if (!fields.size || [...integerFields].some(id => !fields.has(id))) return null;
      return { conditions, fields: [...fields], integerFields: [...integerFields] };
    } catch { return null; }
  }

  function gradeRelation(rule, values) {
    const relation = compileRelation(rule);
    if (!relation) return 'incorrect';
    try {
      for (const id of relation.integerFields) {
        if (relationInput(id, values).denominator !== 1n) return 'incorrect';
      }
      for (const condition of relation.conditions) {
        const order = compare(evaluateRelation(condition.left, values), evaluateRelation(condition.right, values));
        const accepted = condition.operator === 'eq' ? order === 0 : condition.operator === 'neq' ? order !== 0
          : condition.operator === 'lt' ? order < 0 : condition.operator === 'lte' ? order <= 0
            : condition.operator === 'gt' ? order > 0 : order >= 0;
        if (!accepted) return 'incorrect';
      }
      return 'correct';
    } catch { return 'incorrect'; }
  }

  function referencedFields(rule) {
    if (!validRule(rule)) throw new TypeError('Invalid exact math rule.');
    return rule.kind === 'relation' ? [...compileRelation(rule).fields] : [];
  }

  function compare(left, right) {
    const difference = left.numerator * right.denominator - right.numerator * left.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  function positive(value) {
    return value !== null && value.numerator > 0n;
  }

  function validBounds(rule) {
    if (typeof rule.lowerClosed !== 'boolean' || typeof rule.upperClosed !== 'boolean') return false;
    const lowerInfinite = rule.lower === '-inf';
    const upperInfinite = rule.upper === 'inf';
    if ((!lowerInfinite && !validNumericString(rule.lower)) || (!upperInfinite && !validNumericString(rule.upper))) return false;
    if (lowerInfinite && rule.lowerClosed || upperInfinite && rule.upperClosed) return false;
    if (lowerInfinite || upperInfinite) return true;
    const lower = parse(rule.lower);
    const upper = parse(rule.upper);
    const order = compare(lower, upper);
    return order < 0 || (order === 0 && rule.lowerClosed && rule.upperClosed);
  }

  function validRule(rule) {
    if (!isObject(rule) || typeof rule.kind !== 'string') return false;
    if (rule.kind === 'relation') return compileRelation(rule) !== null;
    if (rule.kind === 'exact') return exactKeys(rule, ['kind', 'expected']) && validNumericString(rule.expected);
    if (rule.kind === 'approx') {
      return exactKeys(rule, ['kind', 'expected', 'tolerance']) && validNumericString(rule.expected) &&
        validNumericString(rule.tolerance) && positive(parse(rule.tolerance));
    }
    if (rule.kind === 'quantity') {
      if (!exactKeys(rule, ['kind', 'expected', 'unit', 'units']) || !validNumericString(rule.expected) ||
          typeof rule.unit !== 'string' || !/^[^\s]{1,40}$/.test(rule.unit) ||
          !Array.isArray(rule.units) || rule.units.length < 1 || rule.units.length > 40) return false;
      const symbols = new Set();
      let hasUnit = false;
      for (const item of rule.units) {
        if (!exactKeys(item, ['symbol', 'factor']) || typeof item.symbol !== 'string' ||
            !/^[^\s]{1,40}$/.test(item.symbol) || symbols.has(item.symbol) ||
            !validNumericString(item.factor) || !positive(parse(item.factor))) return false;
        symbols.add(item.symbol);
        if (item.symbol === rule.unit) hasUnit = true;
      }
      return hasUnit;
    }
    if (rule.kind === 'interval' || rule.kind === 'range') {
      return exactKeys(rule, ['kind', 'lower', 'upper', 'lowerClosed', 'upperClosed']) && validBounds(rule);
    }
    if (rule.kind === 'choice') {
      if (!exactKeys(rule, ['kind', 'accepted']) || !Array.isArray(rule.accepted) ||
          rule.accepted.length < 1 || rule.accepted.length > 40) return false;
      const accepted = new Set();
      for (const item of rule.accepted) {
        if (typeof item !== 'string' || item.length < 1 || item.length > 256 || item.trim() !== item || accepted.has(item)) return false;
        accepted.add(item);
      }
      return true;
    }
    if (rule.kind === 'review') return exactKeys(rule, ['kind']);
    return false;
  }

  function parseEndpoint(value, side) {
    if (side === 'lower' && (value === '-inf' || value === '-∞' || value === '−∞')) return { infinite: -1 };
    if (side === 'upper' && (value === 'inf' || value === '∞')) return { infinite: 1 };
    const rational = parse(value);
    return rational === null ? null : { rational };
  }

  function parseInterval(value) {
    const match = value.trim().match(/^([[(])\s*([^,]+?)\s*,\s*([^,]+?)\s*([\])])$/);
    if (!match) return null;
    const lower = parseEndpoint(match[2], 'lower');
    const upper = parseEndpoint(match[3], 'upper');
    if (!lower || !upper) return null;
    const lowerClosed = match[1] === '[';
    const upperClosed = match[4] === ']';
    if ((lower.infinite && lowerClosed) || (upper.infinite && upperClosed)) return null;
    if (!lower.infinite && !upper.infinite) {
      const order = compare(lower.rational, upper.rational);
      if (order > 0 || (order === 0 && !(lowerClosed && upperClosed))) return null;
    }
    return { lower, upper, lowerClosed, upperClosed };
  }

  function gradeInterval(input, rule) {
    const answer = parseInterval(input);
    if (!answer || answer.lowerClosed !== rule.lowerClosed || answer.upperClosed !== rule.upperClosed) return 'incorrect';
    const expectedLower = parseEndpoint(rule.lower, 'lower');
    const expectedUpper = parseEndpoint(rule.upper, 'upper');
    const sameEndpoint = (left, right) => left.infinite === right.infinite &&
      (left.infinite || compare(left.rational, right.rational) === 0);
    return sameEndpoint(answer.lower, expectedLower) && sameEndpoint(answer.upper, expectedUpper)
      ? 'correct' : 'incorrect';
  }

  function withinRange(value, rule) {
    const point = parse(value);
    if (!point) return false;
    if (rule.lower !== '-inf') {
      const order = compare(point, parse(rule.lower));
      if (order < 0 || (order === 0 && !rule.lowerClosed)) return false;
    }
    if (rule.upper !== 'inf') {
      const order = compare(point, parse(rule.upper));
      if (order > 0 || (order === 0 && !rule.upperClosed)) return false;
    }
    return true;
  }

  function multiply(left, right) {
    return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
  }

  function grade(rawString, rule, values) {
    if (!validRule(rule)) throw new TypeError('Invalid exact math rule.');
    if (rule.kind === 'relation') return gradeRelation(rule, values);
    if (typeof rawString !== 'string' || rawString.length > 4096 || !rawString.trim()) return 'incorrect';
    const text = rawString.trim();
    if (rule.kind === 'review') return 'pending';
    if (rule.kind === 'choice') return rule.accepted.includes(text) ? 'correct' : 'incorrect';
    if (rule.kind === 'exact') return equals(text, rule.expected) ? 'correct' : 'incorrect';
    if (rule.kind === 'approx') {
      const answer = parse(text);
      const expected = parse(rule.expected);
      const tolerance = parse(rule.tolerance);
      if (!answer) return 'incorrect';
      const numerator = answer.numerator * expected.denominator - expected.numerator * answer.denominator;
      const distance = { numerator: numerator < 0n ? -numerator : numerator,
        denominator: answer.denominator * expected.denominator };
      return distance.numerator * tolerance.denominator <= tolerance.numerator * distance.denominator
        ? 'correct' : 'incorrect';
    }
    if (rule.kind === 'quantity') {
      const match = text.match(/^(.+?)\s+([^\s]+)$/);
      if (!match || match[1].trim().length > 256) return 'incorrect';
      const amount = parse(match[1].trim());
      const unit = rule.units.find(item => item.symbol === match[2]);
      const targetUnit = rule.units.find(item => item.symbol === rule.unit);
      if (!amount || !unit || !targetUnit) return 'incorrect';
      return compare(multiply(amount, parse(unit.factor)), multiply(parse(rule.expected), parse(targetUnit.factor))) === 0
        ? 'correct' : 'incorrect';
    }
    if (rule.kind === 'interval') return gradeInterval(text, rule);
    if (rule.kind === 'range') return withinRange(text, rule) ? 'correct' : 'incorrect';
    return 'incorrect';
  }

  return Object.freeze({ equals, validRule, referencedFields, grade });
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function buildSandboxDocument(html, { assessment } = {}) {
  const guards = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`;
  const exactMath = `<script>Object.defineProperty(window,"mathPlayLabExact",{value:(${createExactMath.toString()})(),writable:false,configurable:false});</script>`;
  const activityRuntime = assessment === undefined ? '' : `<script>(function(){
    const createActivityRuntime=(${createActivityRuntime.toString()});
    const bindActivityRuntime=(${bindActivityRuntime.toString()});
    const activity=createActivityRuntime(${scriptJson(assessment)},window.mathPlayLabExact);
    Object.defineProperty(window,"mathPlayLabActivity",{value:activity,writable:false,configurable:false});
    const bind=()=>bindActivityRuntime(activity,document);
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind,{once:true});else bind();
  })();</script>`;
  // Install the policy before parsing any untrusted markup, even a misleading comment.
  return `<!doctype html><html><head>${guards}${exactMath}${activityRuntime}</head><body>${html}</body></html>`;
}
