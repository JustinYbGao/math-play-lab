import test from 'node:test';
import assert from 'node:assert/strict';
import { createExactMath } from '../public/sandbox.js';

const { equals } = createExactMath();

test('exact equality accepts equivalent decimals and fractions', () => {
  assert.equal(equals('0.125', '1/8'), true);
  assert.equal(equals(' -3 / -2 ', '1.5'), true);
  assert.equal(equals('1.5/0.5', '3'), true);
  assert.equal(equals('-0.00', '0'), true);
  assert.equal(equals('-0/5', '0.0'), true);
});

test('exact equality distinguishes large integers and close decimals', () => {
  assert.equal(equals('9007199254740993123456789', '9007199254740993123456789'), true);
  assert.equal(equals('9007199254740993123456789', '9007199254740993123456790'), false);
  assert.equal(equals('-1.5000000001', '-3/2'), false);
  assert.equal(equals('2.0000000001', 2), false);
});

test('malformed, unsupported, nonfinite, and zero-denominator inputs are rejected', () => {
  for (const input of ['', '   ', '1/0', '1/-0', '1//2', '1/2/3', '1e-3', 'Infinity', 'NaN', '2 + 2', '--1', '1 /']) {
    assert.equal(equals(input, '1'), false, input);
    assert.equal(equals('1', input), false, input);
  }
});

test('number arguments must be safe integers', () => {
  assert.equal(equals(4, '4'), true);
  for (const input of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, null, {}]) {
    assert.equal(equals(input, '1'), false, String(input));
  }
});

test('each string input is limited to 256 characters', () => {
  const atLimit = '9'.repeat(256);
  const overLimit = '9'.repeat(257);
  assert.equal(equals(atLimit, atLimit), true);
  assert.equal(equals(overLimit, overLimit), false);
});

test('typed exact rules retain decimal and rational equality without floating point', () => {
  const math = createExactMath();
  assert.equal(math.grade('4.0', { kind: 'exact', expected: '4' }), 'correct');
  assert.equal(math.grade('8', { kind: 'exact', expected: '8' }), 'correct');
  assert.equal(math.grade('2', { kind: 'exact', expected: '2' }), 'correct');
  assert.equal(math.grade('6.000000000000000001', { kind: 'exact', expected: '6' }), 'incorrect');
  assert.equal(math.grade('3/2', { kind: 'exact', expected: '1.5' }), 'correct');
  assert.equal(math.validRule({ kind: 'exact', expected: '1.5' }), true);
});

test('typed approximate rules compare the exact absolute tolerance boundary', () => {
  const math = createExactMath();
  const rule = { kind: 'approx', expected: '1', tolerance: '0.1' };
  assert.equal(math.grade('1.1', rule), 'correct');
  assert.equal(math.grade('1.1000000001', rule), 'incorrect');
  assert.equal(math.validRule({ kind: 'approx', expected: '1.4', tolerance: '0.001' }), true);
  assert.equal(math.validRule({ kind: 'approx', expected: '1', tolerance: '0' }), false);
});

test('quantity rules require an allowed explicit unit and exact positive conversion factors', () => {
  const math = createExactMath();
  const rule = { kind: 'quantity', expected: '2400', unit: 'g', units: [
    { symbol: 'g', factor: '1' }, { symbol: 'kg', factor: '1000' }
  ] };
  assert.equal(math.grade('2.4 kg', rule), 'correct');
  assert.equal(math.grade('2400 g', rule), 'correct');
  assert.equal(math.grade('2.4kg', rule), 'incorrect');
  assert.equal(math.grade('2.4 m', rule), 'incorrect');
  assert.equal(math.grade('2400', rule), 'incorrect');
  assert.equal(math.validRule({ ...rule, units: [...rule.units, { symbol: 'bad', factor: '0' }] }), false);
});

test('interval rules compare rational endpoints and endpoint closure exactly', () => {
  const math = createExactMath();
  const rule = { kind: 'interval', lower: '1', upper: '4', lowerClosed: false, upperClosed: true };
  assert.equal(math.grade('(1, 4]', rule), 'correct');
  assert.equal(math.grade('(2/2, 8/2]', rule), 'correct');
  assert.equal(math.grade('[1, 4]', rule), 'incorrect');
  assert.equal(math.grade('(1, 4)', rule), 'incorrect');
  assert.equal(math.grade('(-inf, ∞)', { kind: 'interval', lower: '-inf', upper: 'inf', lowerClosed: false, upperClosed: false }), 'correct');
  assert.equal(math.grade('[−∞, 4]', { kind: 'interval', lower: '-inf', upper: '4', lowerClosed: false, upperClosed: true }), 'incorrect');
});

test('interval and range rules reject reversed, degenerate, or closed-infinite bounds', () => {
  const math = createExactMath();
  assert.equal(math.validRule({ kind: 'interval', lower: '4', upper: '1', lowerClosed: true, upperClosed: true }), false);
  assert.equal(math.validRule({ kind: 'range', lower: '3', upper: '3', lowerClosed: true, upperClosed: false }), false);
  assert.equal(math.validRule({ kind: 'interval', lower: '3', upper: '3', lowerClosed: true, upperClosed: true }), true);
  assert.equal(math.validRule({ kind: 'range', lower: '-inf', upper: '10', lowerClosed: true, upperClosed: true }), false);
  assert.equal(math.validRule({ kind: 'interval', lower: 'inf', upper: '10', lowerClosed: false, upperClosed: true }), false);
  assert.equal(math.validRule({ kind: 'interval', lower: '-inf', upper: 'inf', lowerClosed: false, upperClosed: false }), true);
});

test('range rules grade numeric points with open and closed endpoints', () => {
  const math = createExactMath();
  const rule = { kind: 'range', lower: '1', upper: '4', lowerClosed: false, upperClosed: true };
  assert.equal(math.grade('1', rule), 'incorrect');
  assert.equal(math.grade('3/2', rule), 'correct');
  assert.equal(math.grade('4', rule), 'correct');
  assert.equal(math.grade('5', rule), 'incorrect');
});

test('choice and review rules have bounded typed outcomes', () => {
  const math = createExactMath();
  const choice = { kind: 'choice', accepted: ['reason-a', 'reason-b'] };
  assert.equal(math.grade(' reason-a ', choice), 'correct');
  assert.equal(math.grade('reason-c', choice), 'incorrect');
  assert.equal(math.grade('', { kind: 'review' }), 'incorrect');
  assert.equal(math.grade('I checked the diagram.', { kind: 'review' }), 'pending');
  assert.equal(math.validRule({ kind: 'review', expected: 'anything' }), false);
});

test('malicious learner strings and invalid rules fail closed', () => {
  const math = createExactMath();
  for (const input of ['', '   ', '1+1', 'alert(1)', '1e3', '∞', '9'.repeat(257), null]) {
    assert.equal(math.grade(input, { kind: 'exact', expected: '2' }), 'incorrect');
  }
  for (const rule of [null, { kind: 'exact', expected: '2', extra: true },
    { kind: 'exact', expected: '9'.repeat(257) },
    { kind: 'quantity', expected: '1', unit: 'kg', units: [{ symbol: 'kg', factor: '0' }] }]) {
    assert.equal(math.validRule(rule), false);
    assert.throws(() => math.grade('2', rule), TypeError);
  }
});

test('numeric relation rules evaluate exact rational assignments and expose references', () => {
  const math = createExactMath();
  const rule = { kind: 'relation', integerFields: [], conditions: [
    { left: '[a] + [b]', operator: 'eq', right: '10' },
    { left: '[a]', operator: 'gte', right: '0' },
    { left: '[b]', operator: 'gte', right: '0' },
  ] };
  assert.equal(math.validRule(rule), true);
  const firstReferences = math.referencedFields(rule);
  assert.deepEqual(firstReferences, ['a', 'b']);
  assert.notEqual(math.referencedFields(rule), firstReferences);
  assert.equal(math.grade('', rule, { a: '3', b: '7' }), 'correct');
  assert.equal(math.grade('', rule, { a: '4', b: '6' }), 'correct');
  assert.equal(math.grade('', rule, { a: '3/2', b: '17/2' }), 'correct');
  assert.equal(math.grade('', rule, { a: '3', b: '6' }), 'incorrect');
  assert.equal(math.grade('', rule, { a: '-1', b: '11' }), 'incorrect');
  assert.equal(math.grade('', rule, { a: '3', b: null }), 'incorrect');
  assert.deepEqual(math.referencedFields({ kind: 'exact', expected: '3' }), []);
  assert.throws(() => math.referencedFields({ kind: 'relation', integerFields: [], conditions: [] }), TypeError);
});

test('relation integer fields require exact integer-valued normalized rationals', () => {
  const math = createExactMath();
  const rule = { kind: 'relation', integerFields: ['a', 'b'], conditions: [
    { left: '[a] + [b]', operator: 'eq', right: '10' },
  ] };
  assert.equal(math.grade('', rule, { a: '3.0', b: '7' }), 'correct');
  assert.equal(math.grade('', rule, { a: '6/2', b: '14/2' }), 'correct');
  assert.equal(math.grade('', rule, { a: '3/2', b: '17/2' }), 'incorrect');
  assert.equal(math.grade('', rule, { a: '3.000000000000000001', b: '7' }), 'incorrect');
});

test('relation expression grammar preserves exact precedence, comparisons, and defined domains', () => {
  const math = createExactMath();
  const relation = (left, operator, right) => ({ kind: 'relation', integerFields: [],
    conditions: [{ left, operator, right }] });
  const precedence = relation('-2^2 + [x]', 'eq', '-4 + [x]');
  assert.equal(math.validRule(precedence), true);
  assert.equal(math.grade('', precedence, { x: '6' }), 'correct');
  assert.equal(math.grade('', relation('(-2)^2 + [x]', 'eq', '4 + [x]'), { x: '6' }), 'correct');
  assert.equal(math.grade('', relation('[x] / [d]', 'eq', '[q]'), { x: '3', d: '2', q: '3/2' }), 'correct');
  assert.equal(math.grade('', relation('[x] / [d]', 'eq', '[q]'), { x: '3', d: '0', q: '3/2' }), 'incorrect');
  assert.equal(math.grade('', relation('[x]', 'gt', '3/2'), { x: '1.500000000000000001' }), 'correct');
  assert.equal(math.grade('', relation('[x]', 'lt', '3/2'), { x: '1.499999999999999999' }), 'correct');
  assert.equal(math.grade('', relation('[x]', 'neq', '3/2'), { x: '1.500000000000000001' }), 'correct');
  assert.equal(math.validRule(relation('1/0 + [x]', 'eq', '2')), false);
  assert.equal(math.validRule(relation('0^0 + [x]', 'eq', '2')), false);
});

test('relation rules reject malformed grammar, invalid references, and out-of-bounds exponents', () => {
  const math = createExactMath();
  const relation = left => ({ kind: 'relation', integerFields: [],
    conditions: [{ left, operator: 'eq', right: '1' }] });
  for (const expression of ['x', 'Math.random()+[a]', '1e3+[a]', '[a]+2**3', '[a]^3^2', '[a]^+3', '[a]^(3)',
    '[a]^13', `${'('.repeat(13)}[a]${')'.repeat(13)}`,
    Array.from({ length: 65 }, (_, index) => index === 0 ? '[a]' : '1').join('+'), '[bad id]']) {
    assert.equal(math.validRule(relation(expression)), false, expression);
  }
  const twelfthPower = { ...relation('[a]^12'), conditions: [{ left: '[a]^12', operator: 'eq', right: '4096' }] };
  assert.equal(math.validRule(twelfthPower), true);
  assert.equal(math.grade('', twelfthPower, { a: '2' }), 'correct');
  assert.equal(math.validRule({ ...relation('[a]'), integerFields: ['unused'] }), false);
  assert.equal(math.validRule({ ...relation('[a]'), conditions: [{ left: '[a]', operator: 'eq', right: '1', extra: true }] }), false);
  assert.equal(math.validRule({ ...relation('[a]'), conditions: Array.from({ length: 13 }, () =>
    ({ left: '[a]', operator: 'eq', right: '1' })) }), false);
  assert.equal(math.validRule({ ...relation('[a]'), integerFields: ['a', 'a'] }), false);
  assert.equal(math.validRule({ ...relation('[a]'), integerFields: ['invalid'] }), false);
});
