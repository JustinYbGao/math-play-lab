import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CURRICULUM_FILES = ['elementary', 'middle', 'high', 'calculus', 'stress']
  .map(name => path.join(ROOT, 'evaluation', 'cases', `${name}.json`));
export const STRESS_GROUPS = ['input_ambiguity', 'domain', 'solution_sets', 'diagram_precision',
  'reasoning', 'interaction', 'transfer', 'generation_failure'];
export const TARGET_CASES = { core: 423, stress: 48, total: 471 };

export function validateDataset(dataset, { suiteName = 'pilot', coverageIds, coverageStages } = {}) {
  const errors = [];
  const warnings = [];
  const cases = Array.isArray(dataset?.cases) ? dataset.cases : [];
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) errors.push('dataset must be an object');
  if (typeof dataset?.status !== 'string' || !dataset.status.trim()) errors.push('status must be a nonempty string');
  if (typeof dataset?.purpose !== 'string' || !dataset.purpose.trim()) errors.push('purpose must be a nonempty string');
  if (!Array.isArray(dataset?.cases)) errors.push('cases must be an array');

  const ids = new Set();
  const foundCoverage = new Set();
  for (const [index, item] of cases.entries()) {
    const prefix = `cases[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const id = item.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) {
      errors.push(`${prefix}.id must be a safe case ID slug`);
    } else if (ids.has(id)) errors.push(`${prefix}.id duplicates ${id}`);
    else ids.add(id);

    if (typeof item.coverage !== 'string' ||
        !(/^[A-Z]-[A-Z][A-Z0-9]*\d{2}$/.test(item.coverage) || /^stress-[a-z0-9_-]+$/.test(item.coverage))) {
      errors.push(`${prefix}.coverage must be a valid registry ID or stress-* ID`);
    } else {
      foundCoverage.add(item.coverage);
      if (!item.coverage.startsWith('stress-') && coverageIds && !coverageIds.has(item.coverage)) {
        errors.push(`${prefix}.coverage ${item.coverage} is absent from the coverage registry`);
      }
      if (suiteName === 'curriculum' && coverageStages) {
        const expectedStage = item.coverage.startsWith('stress-') ? '跨学段' : coverageStages.get(item.coverage);
        if (expectedStage && item.stage !== expectedStage) {
          errors.push(`${prefix}.stage must match coverage registry stage ${expectedStage}`);
        }
      }
    }
    if (typeof item.problem !== 'string' || !item.problem.trim()) errors.push(`${prefix}.problem must be nonempty`);
    if (typeof item.reference_answer !== 'string' || !item.reference_answer.trim()) {
      errors.push(`${prefix}.reference_answer must be an independent nonempty reference`);
    }
    if (!Array.isArray(item.checks) || item.checks.length === 0 ||
        item.checks.some(check => typeof check !== 'string' || !check.trim())) {
      errors.push(`${prefix}.checks must contain nonempty concrete checks`);
    } else if (suiteName === 'curriculum' && item.checks.length < 3) {
      errors.push(`${prefix}.checks must contain at least three concrete checks`);
    }

    if (suiteName === 'curriculum') {
      if (!['basic', 'transfer', 'edge'].includes(item.variant)) errors.push(`${prefix}.variant must be basic, transfer, or edge`);
      if (typeof item.stage !== 'string' || !item.stage.trim()) errors.push(`${prefix}.stage must be nonempty`);
      if (!['authored_unreviewed', 'reviewed'].includes(item.reference_status)) {
        errors.push(`${prefix}.reference_status is invalid`);
      }
      if (!['development', 'holdout'].includes(item.split)) errors.push(`${prefix}.split must be development or holdout`);
      if (typeof item.coverage === 'string' && item.coverage.startsWith('stress-')) {
        if (!STRESS_GROUPS.includes(item.stress_group)) errors.push(`${prefix}.stress_group is invalid`);
        if (item.coverage !== `stress-${item.stress_group}`) errors.push(`${prefix}.coverage must match stress_group`);
      }
    }

    if (item.kind === 'software_scenario') {
      if (item.coverage !== 'stress-generation_failure' || item.stress_group !== 'generation_failure' ||
          !['error', 'cancellation'].includes(item.expected_behavior)) {
        errors.push(`${prefix} software_scenario must be a generation_failure error or cancellation`);
      }
    } else if (item.kind === 'image_scenario') {
      const fixtureDescription = item.fixture_description ?? item.image_fixture?.description ?? item.image_fixture;
      if (typeof fixtureDescription !== 'string' || !fixtureDescription.trim()) {
        errors.push(`${prefix} image_scenario needs a fixture description`);
      }
    } else if (item.kind !== undefined) errors.push(`${prefix}.kind is invalid`);

    if (item.kind === 'software_scenario') continue;
    if (!['interactive', 'interactive_reasoning', 'clarification'].includes(item.expected_behavior) &&
        !(['software_scenario'].includes(item.kind) && ['error', 'cancellation'].includes(item.expected_behavior))) {
      errors.push(`${prefix}.expected_behavior is invalid`);
    }
  }

  const absentCoverage = coverageIds
    ? [...coverageIds].filter(id => !foundCoverage.has(id)).sort()
    : [];
  if (absentCoverage.length) warnings.push(`${absentCoverage.length} coverage IDs have no case in this dataset`);
  const variants = ['basic', 'transfer', 'edge'];
  const variantCoverage = suiteName === 'curriculum' && coverageIds
    ? [...coverageIds].sort().map(coverage => {
      const matching = cases.filter(item => item?.coverage === coverage);
      const present = [...new Set(matching.map(item => item?.variant).filter(value => variants.includes(value)))].sort();
      const missingVariants = variants.filter(value => !present.includes(value));
      return { coverage, caseCount: matching.length, variantsPresent: present, missingVariants,
        meetsMinimum: matching.length >= 3 && missingVariants.length === 0 };
    }) : [];
  const missingVariantCoverage = variantCoverage.filter(item => !item.meetsMinimum).map(item => item.coverage);
  if (missingVariantCoverage.length) warnings.push(`${missingVariantCoverage.length} core coverage IDs lack three cases across basic, transfer, and edge variants`);
  const stressGroupCounts = Object.fromEntries(STRESS_GROUPS.map(group => [group,
    cases.filter(item => item?.stress_group === group).length]));
  const hasStressCases = cases.some(item => typeof item?.coverage === 'string' && item.coverage.startsWith('stress-'));
  const stressGroupGaps = suiteName === 'curriculum' && hasStressCases
    ? STRESS_GROUPS.filter(group => stressGroupCounts[group] !== 6)
    : [];
  if (stressGroupGaps.length) warnings.push(`${stressGroupGaps.length} stress groups do not have exactly six cases`);
  return { valid: errors.length === 0, errors, warnings, caseCount: cases.length,
    coverageCount: foundCoverage.size, absentCoverage, variantCoverage, missingVariantCoverage,
    stressGroupCounts, stressGroupGaps };
}

export async function readCoverageRegistry(filePath = path.resolve(ROOT, '../docs/superpowers/specs/2026-11-16-math-play-lab-coverage.csv')) {
  const text = await readFile(filePath, 'utf8');
  const stages = new Map();
  for (const [index, line] of text.trim().split(/\r?\n/).entries()) {
    if (index === 0 || !line.trim()) continue;
    const [id, stage] = line.split(',', 2).map(value => value.trim());
    if (id && stage) stages.set(id, stage);
  }
  return stages;
}

export async function loadJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing evaluation data file: ${path.relative(ROOT, filePath)}`);
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in evaluation data file: ${path.relative(ROOT, filePath)}`);
    throw error;
  }
}

export async function loadSuite(suiteName, { rootDir = ROOT } = {}) {
  if (suiteName === 'pilot') return loadJson(path.join(rootDir, 'evaluation', 'pilot.json'));
  if (suiteName !== 'curriculum') throw new Error(`Unsupported suite: ${suiteName}`);
  const files = CURRICULUM_FILES.map(file => path.join(rootDir, path.relative(ROOT, file)));
  const missing = [];
  for (const file of files) {
    try { await readFile(file); } catch (error) { if (error?.code === 'ENOENT') missing.push(path.relative(rootDir, file)); else throw error; }
  }
  if (missing.length) throw new Error(`Curriculum suite is incomplete; missing: ${missing.join(', ')}`);
  const datasets = await Promise.all(files.map(loadJson));
  return { status: 'prepared_not_run', purpose: 'Combined elementary, middle, high, calculus and stress corpus.',
    cases: datasets.flatMap(dataset => dataset.cases ?? []), sources: files.map(file => path.relative(rootDir, file)) };
}

export async function preparedSummary({ rootDir = ROOT, coverageIds } = {}) {
  const curriculumFiles = CURRICULUM_FILES.map(file => path.join(rootDir, path.relative(ROOT, file)));
  let pilotCases = [];
  const errors = [];
  try {
    const pilot = await loadJson(path.join(rootDir, 'evaluation', 'pilot.json'));
    if (!Array.isArray(pilot?.cases)) errors.push('evaluation/pilot.json: cases must be an array');
    else {
      pilotCases = pilot.cases.filter((item, index) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) return true;
        errors.push(`evaluation/pilot.json: cases[${index}] must be an object`);
        return false;
      });
    }
  } catch (error) { errors.push(error.message); }
  const curriculum = [];
  const missingFiles = [];
  for (const file of curriculumFiles) {
    try {
      const dataset = await loadJson(file);
      if (!Array.isArray(dataset?.cases)) errors.push(`${path.relative(rootDir, file)}: cases must be an array`);
      else {
        dataset.cases = dataset.cases.filter((item, index) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) return true;
          errors.push(`${path.relative(rootDir, file)}: cases[${index}] must be an object`);
          return false;
        });
        curriculum.push(dataset);
      }
    }
    catch (error) {
      if (/^Missing evaluation data file:/.test(error.message)) missingFiles.push(path.relative(rootDir, file));
      else errors.push(error.message);
    }
  }
  const curriculumCases = curriculum.flatMap(dataset => dataset.cases);
  const preparedCoverage = new Set(curriculumCases.map(item => item.coverage).filter(id => typeof id === 'string'));
  const variantCoverage = coverageIds ? [...coverageIds].sort().map(coverage => {
    const matching = curriculumCases.filter(item => item.coverage === coverage);
    const variantsPresent = [...new Set(matching.map(item => item.variant).filter(value => ['basic', 'transfer', 'edge'].includes(value)))].sort();
    const missingVariants = ['basic', 'transfer', 'edge'].filter(value => !variantsPresent.includes(value));
    return { coverage, caseCount: matching.length, variantsPresent, missingVariants,
      meetsMinimum: matching.length >= 3 && missingVariants.length === 0 };
  }) : [];
  const missingVariantCoverage = variantCoverage.filter(item => !item.meetsMinimum).map(item => item.coverage);
  const stressGroupCounts = Object.fromEntries(STRESS_GROUPS.map(group => [group,
    curriculumCases.filter(item => item.stress_group === group).length]));
  const stressGroupGaps = STRESS_GROUPS.filter(group => stressGroupCounts[group] !== 6);
  return {
    pilot: pilotCases.length,
    core: curriculumCases.filter(item => typeof item.coverage === 'string' && !item.coverage.startsWith('stress-')).length,
    stress: curriculumCases.filter(item => typeof item.coverage === 'string' && item.coverage.startsWith('stress-')).length,
    totalIncludingPilot: pilotCases.length + curriculumCases.length,
    target: TARGET_CASES,
    missingFiles,
    errors,
    absentCoverage: coverageIds ? [...coverageIds].filter(id => !preparedCoverage.has(id)).sort() : [],
    variantCoverage,
    missingVariantCoverage,
    stressGroupCounts,
    stressGroupGaps,
  };
}

export async function validateAvailableData({ rootDir = ROOT } = {}) {
  const errors = [];
  let coverageIds;
  let coverageStages;
  try {
    const registry = await readCoverageRegistry(path.resolve(rootDir, '../docs/superpowers/specs/2026-11-16-math-play-lab-coverage.csv'));
    coverageIds = new Set(registry.keys());
    coverageStages = registry;
  }
  catch { errors.push('Coverage registry is unavailable.'); }
  const data = [];
  const paths = [path.join(rootDir, 'evaluation', 'pilot.json'), ...CURRICULUM_FILES.map(file => path.join(rootDir, path.relative(ROOT, file)))];
  const knownIds = new Set();
  for (const file of paths) {
    let parsed;
    try { parsed = await loadJson(file); }
    catch (error) {
      if (!/^Missing evaluation data file:/.test(error.message)) errors.push(error.message);
      continue;
    }
    const suiteName = path.basename(file) === 'pilot.json' ? 'pilot' : 'curriculum';
    const check = validateDataset(parsed, { suiteName, coverageIds, coverageStages });
    errors.push(...check.errors.map(error => `${path.relative(rootDir, file)}: ${error}`));
    for (const item of (Array.isArray(parsed?.cases) ? parsed.cases : [])) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
      if (knownIds.has(item.id)) errors.push(`Duplicate case ID across files: ${item.id}`);
      knownIds.add(item.id);
    }
    data.push({ file: path.relative(rootDir, file), suite: suiteName, ...check });
  }
  const prepared = await preparedSummary({ rootDir, coverageIds });
  errors.push(...prepared.errors);
  return { valid: errors.length === 0, errors, datasets: data, prepared };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await validateAvailableData();
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
