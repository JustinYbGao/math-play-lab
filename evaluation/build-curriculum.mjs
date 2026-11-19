import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSuite, validateDataset } from './validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.resolve(ROOT, '../docs/superpowers/specs/2026-11-16-math-play-lab-coverage.csv');
const PUBLIC_PATH = path.join(ROOT, 'public', 'curriculum.json');
const QUEUE_PATH = path.join(ROOT, '.work', 'curriculum-first-sweep.json');
const VARIANT_ORDER = ['basic', 'transfer', 'edge'];
const INTERACTIVE_BEHAVIORS = new Set(['interactive', 'interactive_reasoning']);

export function parseCoverageRegistry(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const header = lines.shift()?.split(',').map(value => value.trim());
  const required = ['id', 'stage', 'domain', 'topic'];
  if (!required.every((column, index) => header?.[index] === column)) {
    throw new Error('Coverage registry must start with id,stage,domain,topic columns.');
  }

  const rows = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const [id, stage, domain, title] = line.split(',').map(value => value.trim());
    if (!id || !stage || !domain || !title) throw new Error(`Coverage registry row ${index + 2} is incomplete.`);
    if (seen.has(id)) throw new Error(`Duplicate coverage ID in registry: ${id}`);
    seen.add(id);
    rows.push({ id, stage, domain, title });
  }
  if (!rows.length) throw new Error('Coverage registry is empty.');
  return rows;
}

function validateSources(registryRows, cases) {
  const topicById = new Map(registryRows.map(row => [row.id, row]));
  const coverageIds = new Set(topicById.keys());
  const coverageStages = new Map(registryRows.map(row => [row.id, row.stage]));
  const validation = validateDataset({ status: 'prepared_not_run', purpose: 'Curriculum catalog build.', cases }, {
    suiteName: 'curriculum', coverageIds, coverageStages,
  });
  if (validation.errors.length) throw new Error(`Invalid curriculum sources:\n${validation.errors.join('\n')}`);

  const caseIds = new Set();
  const byCoverage = new Map(registryRows.map(row => [row.id, []]));
  for (const item of cases) {
    if (caseIds.has(item.id)) throw new Error(`Duplicate case ID across curriculum sources: ${item.id}`);
    caseIds.add(item.id);
    if (typeof item.coverage === 'string' && item.coverage.startsWith('stress-')) continue;
    const topic = topicById.get(item.coverage);
    if (!topic) throw new Error(`Case ${item.id} references unknown coverage ${item.coverage}.`);
    if (item.id !== `${item.coverage}-${item.variant}` && !item.id.startsWith(`${item.coverage}-${item.variant}-`)) {
      throw new Error(`Case ID ${item.id} does not match ${item.coverage}-${item.variant}.`);
    }
    byCoverage.get(topic.id).push(item);
  }

  for (const row of registryRows) {
    if (!byCoverage.get(row.id).some(item => item.split === 'development')) {
      throw new Error(`Coverage ${row.id} has no development exercise.`);
    }
  }
  return byCoverage;
}

function exampleFromCase(item) {
  return { id: item.id, variant: item.variant, problem: item.problem };
}

export function buildCurriculumArtifacts(registryRows, cases) {
  if (new Set(registryRows.map(row => row.id)).size !== registryRows.length) {
    throw new Error('Coverage registry contains duplicate IDs.');
  }
  const byCoverage = validateSources(registryRows, cases);
  const orderedStages = [...new Set(registryRows.map(row => row.stage))];
  const stageCounts = Object.fromEntries(orderedStages.map(stage => [stage,
    registryRows.filter(row => row.stage === stage).length]));
  const topics = registryRows.map(row => {
    const examples = byCoverage.get(row.id)
      .filter(item => item.split === 'development' && !item.coverage.startsWith('stress-'))
      .map(exampleFromCase);
    if (!examples.length) throw new Error(`Coverage ${row.id} has no development exercise.`);
    return { id: row.id, stage: row.stage, domain: row.domain, title: row.title, examples };
  });

  const queueByStage = new Map(orderedStages.map(stage => [stage, []]));
  for (const row of registryRows) {
    const candidate = byCoverage.get(row.id)
      .filter(item => item.split === 'development' && !item.coverage.startsWith('stress-') &&
        INTERACTIVE_BEHAVIORS.has(item.expected_behavior) && !item.kind)
      .sort((left, right) => VARIANT_ORDER.indexOf(left.variant) - VARIANT_ORDER.indexOf(right.variant))[0];
    if (!candidate) throw new Error(`Coverage ${row.id} has no development text interaction case for the first sweep.`);
    queueByStage.get(row.stage).push({
      caseId: candidate.id,
      coverage: candidate.coverage,
      stage: candidate.stage,
      variant: candidate.variant,
      problem: candidate.problem,
      reference_answer: candidate.reference_answer,
      reference_status: candidate.reference_status,
      checks: candidate.checks,
    });
  }

  const firstSweep = [];
  const maxStageSize = Math.max(...[...queueByStage.values()].map(items => items.length));
  for (let index = 0; index < maxStageSize; index += 1) {
    for (const stage of orderedStages) {
      const item = queueByStage.get(stage)[index];
      if (item) firstSweep.push(item);
    }
  }

  return {
    catalog: {
      schemaVersion: 1,
      counts: { topics: topics.length, stages: orderedStages.length },
      stages: orderedStages.map(id => ({ id, title: id, count: stageCounts[id] })),
      topics,
    },
    firstSweep: {
      status: 'prepared_not_run',
      purpose: 'Preparation-only review queue. These are not live results or an authorization to run a sweep.',
      counts: { topics: firstSweep.length, stages: orderedStages.length },
      stageCounts,
      liveAcceptanceClaim: false,
      cases: firstSweep,
    },
  };
}

export async function buildCurriculumFiles({ rootDir = ROOT } = {}) {
  const registryPath = path.resolve(rootDir, path.relative(ROOT, REGISTRY_PATH));
  const registryRows = parseCoverageRegistry(await readFile(registryPath, 'utf8'));
  const { cases } = await loadSuite('curriculum', { rootDir });
  const { catalog, firstSweep } = buildCurriculumArtifacts(registryRows, cases);
  const catalogPath = path.join(rootDir, 'public', 'curriculum.json');
  const queuePath = path.join(rootDir, '.work', 'curriculum-first-sweep.json');
  await mkdir(path.dirname(queuePath), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(queuePath, `${JSON.stringify(firstSweep, null, 2)}\n`);
  return { catalogPath, queuePath, catalog, firstSweep };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { catalog, firstSweep } = await buildCurriculumFiles();
    console.log(JSON.stringify({
      catalog: { topics: catalog.counts.topics, stages: catalog.counts.stages, stageCounts: Object.fromEntries(catalog.stages.map(stage => [stage.id, stage.count])) },
      firstSweep: { status: firstSweep.status, cases: firstSweep.cases.length, firstFourStages: firstSweep.cases.slice(0, 4).map(item => item.stage) },
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
