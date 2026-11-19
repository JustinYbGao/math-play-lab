import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuite } from '../evaluation/validate.mjs';
import { buildCurriculumArtifacts, parseCoverageRegistry } from '../evaluation/build-curriculum.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.resolve(root, '../docs/superpowers/specs/2026-11-16-math-play-lab-coverage.csv');

async function getSources() {
  const [csv, suite] = await Promise.all([readFile(registryPath, 'utf8'), loadSuite('curriculum')]);
  return { registryRows: parseCoverageRegistry(csv), cases: suite.cases };
}

test('public curriculum contains the full registry and only development prompt fields', async () => {
  const { registryRows, cases } = await getSources();
  const { catalog } = buildCurriculumArtifacts(registryRows, cases);
  const sourceDevelopmentIds = new Set(cases.filter(item => item.split === 'development').map(item => item.id));
  assert.equal(catalog.topics.length, 141);
  assert.deepEqual(Object.fromEntries(catalog.stages.map(stage => [stage.id, stage.count])), {
    '小学': 35, '初中': 34, '高中': 43, '基础微积分': 29,
  });
  assert.deepEqual(catalog.topics.map(topic => topic.id), registryRows.map(row => row.id));
  for (const topic of catalog.topics) {
    assert.ok(topic.examples.length >= 1, `${topic.id} has a development prompt`);
    for (const example of topic.examples) {
      assert.ok(sourceDevelopmentIds.has(example.id), `${example.id} comes from development`);
      assert.deepEqual(Object.keys(example).sort(), ['id', 'problem', 'variant']);
    }
  }
  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /reference_answer|reference_status|checks|holdout/i);
});

test('English display projection stays hash-bound and complete without changing the source catalog', async () => {
  const [sourceBytes, projectionBytes] = await Promise.all([
    readFile(path.resolve(root, 'public/curriculum.json')),
    readFile(path.resolve(root, 'public/curriculum.en.json')),
  ]);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  const projection = JSON.parse(projectionBytes.toString('utf8'));
  assert.equal(projection.language, 'en');
  assert.equal(projection.sourceCatalogPath, 'public/curriculum.json');
  assert.equal(projection.sourceCatalogSha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.deepEqual(Object.keys(projection.stages), source.stages.map(stage => stage.id));
  assert.deepEqual(Object.keys(projection.topics), source.topics.map(topic => topic.id));
  assert.deepEqual(Object.keys(projection.domains), [...new Set(source.topics.map(topic => topic.domain))]);
  const hasHan = value => /\p{Script=Han}/u.test(value);
  assert.ok(Object.values(projection.stages).every(value => !hasHan(value)));
  assert.ok(Object.values(projection.domains).every(value => !hasHan(value)));
  let translatedCount = 0;
  let exampleCount = 0;
  for (const topic of source.topics) {
    const display = projection.topics[topic.id];
    assert.ok(display.title && !hasHan(display.title), `${topic.id} has an English title`);
    const sourceIds = topic.examples.map(example => example.id);
    assert.ok(Object.keys(display.examples).every(id => sourceIds.includes(id)), `${topic.id} has no unknown translations`);
    for (const example of topic.examples) {
      exampleCount++;
      const translated = display.examples[example.id];
      if (hasHan(example.problem)) {
        assert.ok(typeof translated === 'string' && translated.length > 0, `${example.id} is translated`);
        assert.ok(!hasHan(translated), `${example.id} displays in English`);
        translatedCount++;
      } else {
        assert.equal(translated, undefined, `${example.id} reuses its original English prompt`);
      }
    }
  }
  assert.equal(exampleCount, 337);
  assert.equal(translatedCount, 160);
});

test('first sweep is deterministic, round-robins all stages, and preserves unreviewed status', async () => {
  const sources = await getSources();
  const first = buildCurriculumArtifacts(sources.registryRows, sources.cases).firstSweep;
  const second = buildCurriculumArtifacts(sources.registryRows, sources.cases).firstSweep;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'prepared_not_run');
  assert.equal(first.liveAcceptanceClaim, false);
  assert.equal(first.cases.length, 141);
  assert.deepEqual(first.cases.slice(0, 4).map(item => item.stage), ['小学', '初中', '高中', '基础微积分']);
  assert.equal(new Set(first.cases.map(item => item.coverage)).size, 141);
  assert.ok(first.cases.every(item => item.reference_status === 'authored_unreviewed'));
  assert.ok(first.cases.every(item => !item.caseId.includes('stress') && !item.coverage.startsWith('stress-')));
});

test('build fails when a registry topic has no development case', async () => {
  const { registryRows, cases } = await getSources();
  const withoutOneDevelopment = cases.filter(item => item.coverage !== registryRows[0].id || item.split !== 'development');
  assert.throws(() => buildCurriculumArtifacts(registryRows, withoutOneDevelopment), /E-N01 has no development exercise/);
});

test('build rejects mismatched case IDs and duplicate coverage IDs', async () => {
  const { registryRows, cases } = await getSources();
  const mismatched = cases.map(item => item.id === 'E-N01-basic' ? { ...item, id: 'wrong-basic' } : item);
  assert.throws(() => buildCurriculumArtifacts(registryRows, mismatched), /does not match E-N01-basic/);
  const ambiguousVariant = cases.map(item => item.id === 'E-N02-basic' ? { ...item, id: 'E-N02-basically' } : item);
  assert.throws(() => buildCurriculumArtifacts(registryRows, ambiguousVariant), /does not match E-N02-basic/);
  assert.throws(() => buildCurriculumArtifacts([...registryRows, registryRows[0]], cases), /duplicate IDs/i);
});
