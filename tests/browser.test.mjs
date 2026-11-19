import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHtml } from '../server/check.mjs';
import { runPlaythrough } from '../server/playthrough.mjs';
import { assessmentHtml, readyPlan, fixturePage, fixturePlaytest, reviewAssessment, reviewPlaytest,
  fixtureHtml, rebuiltControlAfterResetHtml, staleCapturedStateHtml } from './fixtures.mjs';

function singleFieldActivity({ type = 'text', expected = '6', initial, attributes = '', extraScript = '' } = {}) {
  const fieldInitial = initial ?? (type === 'range' || type === 'select' ? '5' : '');
  const input = type === 'select'
    ? `<select id="answer" data-mpl-control data-mpl-field="answer"><option value="5" ${fieldInitial === '5' ? 'selected' : ''}>5</option><option value="6" ${fieldInitial === '6' ? 'selected' : ''}>6</option></select>`
    : `<input id="answer" type="${type}" data-mpl-control data-mpl-field="answer" value="${fieldInitial}" ${attributes}>`;
  const action = (value, phase) => type === 'range'
    ? { action: 'press', selector: '#answer', value }
    : type === 'select' ? { action: 'select', selector: '#answer', value }
      : { action: 'fill', selector: '#answer', value };
  const submit = { action: 'click', selector: '#answer-check', value: null };
  const solveEdit = type === 'range' ? 'ArrowUp' : expected;
  const wrongEdit = type === 'range' ? 'ArrowDown' : type === 'select' ? fieldInitial : '5';
  const recover = type === 'range' ? [{ action: 'press', selector: '#answer', value: 'ArrowUp' },
    { action: 'press', selector: '#answer', value: 'ArrowUp' }, { action: 'click', selector: '#answer-check', value: null }]
    : [action(expected), { action: 'click', selector: '#answer-check', value: null }];
  const invalidateEdit = type === 'range' ? 'ArrowDown' : type === 'select' ? fieldInitial : '5';
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'answer', initial: fieldInitial }],
    checkpoints: [{ id: 'answer-check', field: 'answer', dependsOn: [], watchFields: [],
      rule: { kind: 'exact', expected }, feedback: 'Check the value.' }] };
  const playtest = {
    solve: [action(solveEdit), submit],
    wrong: [action(wrongEdit), submit],
    recover,
    invalidate: [action(invalidateEdit)],
  };
  const html = `<style>body{font:16px sans-serif}#mpl-problem{font-size:16px}input,select,button{font:16px sans-serif;min-height:44px;min-width:64px}input[type=range]{width:120px}[data-mpl-feedback]{min-height:24px}</style>
    <p id="mpl-problem">Enter the exact value.</p>${input}<button id="answer-check" data-mpl-submit="answer-check">Check</button>
    <p data-mpl-feedback="answer-check"></p><p id="mpl-status" role="status">In progress.</p>
    <button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p><button id="mpl-reset">Reset</button>
    <script>window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};
      let hintCount=0;document.querySelector('#mpl-hint').addEventListener('click',()=>{
        hintCount++;const hint=document.querySelector('#mpl-hint-text');hint.textContent=hintCount===1?'Check the value.':'Use exact arithmetic.';hint.hidden=false;});
      document.querySelector('#mpl-reset').addEventListener('click',()=>{hintCount=0;const hint=document.querySelector('#mpl-hint-text');hint.textContent='';hint.hidden=true;});
      ${extraScript}</script>`;
  return { assessment, playtest, html };
}

test('the browser checker actually loads and interacts with an isolated exercise',async()=>{
  const report=await checkHtml(fixtureHtml);
  assert.deepEqual(report,{passed:true,errors:[]});
});

test('the browser checker rejects global horizontal overflow at 320px',async()=>{
  const html=fixtureHtml.replace('</body>','<div style="width:470px;height:1px"></div></body>');
  const report=await checkHtml(html);
  assert.deepEqual(report,{passed:false,errors:['The page has horizontal overflow at 320px width.']});
});

test('the browser checker rejects an undersized first mathematical target',async()=>{
  const html=fixtureHtml
    .replace('min-height:44px;font-size:16px','min-height:30px;font-size:16px')
    .replace('width:64px;height:44px;font-size:16px','width:32px;height:30px;font-size:16px');
  const report=await checkHtml(html);
  assert.deepEqual(report,{passed:false,errors:['The first mathematical control has a click target smaller than 44 by 44 pixels.']});
});

test('the browser checker rejects small first-control entry text',async()=>{
  const html=fixtureHtml.replace('input[data-mpl-control]{width:64px;height:44px;font-size:16px}',
    'input[data-mpl-control]{width:64px;height:44px;font-size:12px}');
  const report=await checkHtml(html);
  assert.deepEqual(report,{passed:false,errors:['The first mathematical control text or numeric entry uses a font smaller than 16px.']});
});

test('a native 13px range uses its 16px associated label text for the font check',async()=>{
  const html=fixtureHtml
    .replace('input[data-mpl-control]{width:64px;height:44px;font-size:16px}',
      'input[data-mpl-control]{width:64px;height:44px;font-size:16px}label{width:64px;min-height:44px}input[type=range]{width:32px;height:24px;font-size:13px}')
    .replace('<input data-mpl-control type="number" value="0">',
      '<input data-mpl-control type="range" min="0" max="10" value="0">');
  assert.deepEqual(await checkHtml(html),{passed:true,errors:[]});
});

test('hidden small helper text in a visible range label is ignored',async()=>{
  const rangeHtml=fixtureHtml
    .replace('input[data-mpl-control]{width:64px;height:44px;font-size:16px}',
      'input[data-mpl-control]{width:64px;height:44px;font-size:16px}label{width:64px;min-height:44px}input[type=range]{width:32px;height:24px;font-size:13px}')
    .replace('<input data-mpl-control type="number" value="0">',
      '<input data-mpl-control type="range" min="0" max="10" value="0">');
  for(const visibility of ['hidden','collapse']){
    const html=rangeHtml.replace('Value <input',
      `Value <span style="visibility:${visibility};font-size:12px">Hidden helper</span><input`);
    assert.deepEqual(await checkHtml(html),{passed:true,errors:[]});
  }
});

test('a responsive associated label can provide the first control hit target',async()=>{
  const html=fixtureHtml.replace('</style>',
    'label{width:56px;min-height:44px}input[data-mpl-control]{width:32px;height:24px}</style>');
  assert.deepEqual(await checkHtml(html),{passed:true,errors:[]});
});

test('the first desktop mathematical marker must itself be visible and enabled',async()=>{
  for(const marker of ['<button data-mpl-control hidden>Hidden first</button>',
    '<button data-mpl-control disabled>Disabled first</button>']){
    const html=fixtureHtml.replace('<body>',`<body>${marker}`);
    assert.deepEqual(await checkHtml(html),
      {passed:false,errors:['Expected a visible, enabled mathematical interaction control.']});
  }
});

test('the browser checker requires two progressive hints and reset to clear them',async()=>{
  const repeated=fixtureHtml.replace("hintStep===1?'Keep the two sides balanced as you simplify.':'Keep the two sides balanced as you simplify. Subtract 3 from both sides, then divide by 2.'",
    "'Keep the two sides balanced as you simplify.'");
  const report=await checkHtml(repeated);
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('different additional guidance')));

  const uncleared=fixtureHtml.replace("hintStep=0;hintText.textContent='';hintText.hidden=true;",'hintStep=0;');
  const resetReport=await checkHtml(uncleared);
  assert.equal(resetReport.passed,false);
  assert.ok(resetReport.errors.some(error=>error.includes('clear or hide the hints')));
});

test('reset restores the first hint and enabled button, not just cleared hint text',async()=>{
  const broken=fixtureHtml
    .replace('hintStep=Math.min(2,hintStep+1);',"hintStep=Math.min(2,hintStep+1);if(hintStep===2)document.querySelector('#mpl-hint').disabled=true;")
    .replace("hintStep=0;hintText.textContent='';hintText.hidden=true;", "hintText.textContent='';hintText.hidden=true;");
  const report=await checkHtml(broken);
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('hint button was not enabled after reset')));
});

test('the first mathematical action still changes state after reset',async()=>{
  const report=await checkHtml(staleCapturedStateHtml);
  assert.equal(report.passed,false);
  assert.ok(report.errors.includes('After reset, the interaction control did not change mathematical state.'));
  assert.ok(!report.errors.includes('The interaction control did not change mathematical state.'));
  assert.ok(!report.errors.includes('Reset did not restore initial mathematical state.'));
});

test('the post-reset action works when reset rebuilds the control DOM',async()=>{
  assert.deepEqual(await checkHtml(rebuiltControlAfterResetHtml),{passed:true,errors:[]});
});

test('assessment-bearing activity passes wrong, recover, solve, invalidation, reset, and replay traces', async () => {
  const report = await checkHtml(assessmentHtml, { assessment: readyPlan.assessment, playtest: fixturePlaytest });
  assert.deepEqual(report, { passed: true, playthrough: 'passed',
    independentChecks: { status: 'passed', testedFields: ['removed', 'solution'], untestedFields: [], equivalentChecks: 2 },
    errors: [] });
});

test('review-only work reaches pending review without claiming completion', async () => {
  const html = `<style>body{font:16px sans-serif}input,textarea,button{font:16px sans-serif;min-height:44px}</style>
    <p id="mpl-problem">Give a proof argument.</p><label>Reason <textarea id="proof-input" data-mpl-control data-mpl-field="proof"></textarea></label>
    <button id="proof-check" data-mpl-submit="argument">Check argument</button><p data-mpl-feedback="argument"></p>
    <p id="mpl-status" role="status"></p><button id="mpl-hint">Hint</button>
    <p id="mpl-hint-text" aria-live="polite" hidden></p><button id="mpl-reset">Reset</button>
    <script>const hint=document.querySelector('#mpl-hint-text');let step=0;
      window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};
      document.querySelector('#mpl-hint').addEventListener('click',()=>{step++;hint.textContent=step===1?'Consider equality.':'Explain the operation.';hint.hidden=false;});
      document.querySelector('#mpl-reset').addEventListener('click',()=>{step=0;hint.textContent='';hint.hidden=true;});</script>`;
  const report = await checkHtml(html, { assessment: reviewAssessment, playtest: reviewPlaytest });
  assert.deepEqual(report, { passed: true, playthrough: 'passed',
    independentChecks: { status: 'passed', testedFields: ['proof'], untestedFields: [], equivalentChecks: 0 }, errors: [] });
});

test('playthrough rejects missing runtime, fresh-load success, stale shared state, and detached completion', async () => {
  const missingRuntime = await runPlaythrough({ evaluate: async () => ({ activityExists: false, runtime: null, common: null }) },
    readyPlan.assessment, fixturePlaytest);
  assert.deepEqual(missingRuntime, { errors: ['The shared assessment runtime was unavailable during playthrough.'],
    independentChecks: { status: 'partial', testedFields: [], untestedFields: ['removed', 'solution'], equivalentChecks: 0 } });

  const autoSolved = assessmentHtml.replace('</body>', `<script>
    window.mathPlayLabActivity.set('removed','3');window.mathPlayLabActivity.submit('subtract');
    window.mathPlayLabActivity.set('solution','4');window.mathPlayLabActivity.submit('solve');
  </script></body>`);
  const autoSolvedReport = await checkHtml(autoSolved, { assessment: readyPlan.assessment, playtest: fixturePlaytest });
  assert.ok(autoSolvedReport.errors.includes('The shared assessment runtime was unavailable during playthrough.'));

  const staleGetter = assessmentHtml.replace(
    'window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};',
    `let cached=window.mathPlayLabActivity.getState();
     window.mathPlayLab={getState:()=>({assessment:cached})};
     window.mathPlayLabActivity.subscribe(state=>{if(state.checkpoints.subtract!=='correct')cached=state;});`);
  const staleReport = await checkHtml(staleGetter, { assessment: readyPlan.assessment, playtest: fixturePlaytest });
  assert.ok(staleReport.errors.includes('The recovery playthrough phase did not reach the expected terminal state.'));

  const detached = assessmentHtml.replace(
    'getState:()=>({assessment:window.mathPlayLabActivity.getState()})',
    'getState:()=>({assessment:window.mathPlayLabActivity.getState(),complete:true})');
  const detachedReport = await checkHtml(detached, { assessment: readyPlan.assessment, playtest: fixturePlaytest });
  assert.ok(detachedReport.errors.includes('The shared assessment runtime was unavailable during playthrough.'));
});

test('playthrough rejects ineffective wrong, recovery reset, unreachable solve, hidden action, stale feedback, and reset invalidation', async () => {
  const wrongDoesNotFail = { ...fixturePlaytest, wrong: [
    { action: 'fill', selector: '#removed-input', value: '3' },
    { action: 'click', selector: '#removed-check', value: null },
  ] };
  const resetRecovery = { ...fixturePlaytest, recover: [
    { action: 'click', selector: '#mpl-reset', value: null }, ...fixturePlaytest.recover,
  ] };
  const unreachableSolve = { ...fixturePlaytest, solve: fixturePlaytest.solve.map(action =>
    action.selector === '#solution-input' ? { ...action, value: '5' } : action) };
  const hiddenActionHtml = assessmentHtml.replace('<button id="removed-check"', '<button id="removed-check" hidden');
  const noopInvalidate = { ...fixturePlaytest, invalidate: [{ action: 'fill', selector: '#removed-input', value: '3' }] };
  const resetInvalidate = { ...fixturePlaytest, invalidate: [{ action: 'click', selector: '#mpl-reset', value: null }] };
  const staleFeedback = assessmentHtml.replace('</body>', `<script>
    let wasComplete=false;const feedback=document.querySelector('#solution-feedback');
    window.mathPlayLabActivity.subscribe(state=>{if(state.complete)wasComplete=true;});
    document.addEventListener('input',event=>{if(wasComplete&&event.target.id==='removed-input'&&
      window.mathPlayLabActivity.getState().values.solution==='4'){
      feedback.dataset.state='correct';feedback.textContent='Correct.';}});
  </script></body>`);
  const brokenReset = assessmentHtml.replace('</body>', `<script>
    document.querySelector('#mpl-reset').addEventListener('click',event=>event.stopImmediatePropagation(),true);
  </script></body>`);
  const cases = [
    [assessmentHtml, wrongDoesNotFail, 'The wrong-answer playthrough phase did not produce an incorrect checkpoint.'],
    [assessmentHtml, resetRecovery, 'The recovery playthrough phase did not reach the expected terminal state.'],
    [assessmentHtml, unreachableSolve, 'The solve playthrough phase did not reach the expected terminal state.'],
    [hiddenActionHtml, fixturePlaytest, 'The wrong-answer playthrough phase did not produce an incorrect checkpoint.'],
    [staleFeedback, fixturePlaytest, 'Independent assessment probe failed'],
    [brokenReset, fixturePlaytest, 'Reset did not restore the complete initial activity state and interface.'],
    [assessmentHtml, noopInvalidate, 'The invalidation playthrough phase did not clear the confirmed result.'],
    [assessmentHtml, resetInvalidate, 'The invalidation playthrough phase did not clear the confirmed result.'],
  ];
  for (const [html, playtest, error] of cases) {
    const report = await checkHtml(html, { assessment: readyPlan.assessment, playtest });
    assert.equal(report.passed, false);
    assert.equal(report.playthrough, 'failed');
    assert.ok(report.errors.some(item => item.includes(error)), `${error}: ${report.errors.join('; ')}`);
  }
});

test('partial or invalid assessment arguments fail closed without launching the browser', async () => {
  assert.deepEqual(await checkHtml(assessmentHtml, { assessment: readyPlan.assessment }), {
    passed: false, playthrough: 'failed',
    independentChecks: { status: 'partial', testedFields: [], untestedFields: ['removed', 'solution'], equivalentChecks: 0 },
    errors: ['The playthrough contract was invalid.'],
  });
  assert.deepEqual(await checkHtml(assessmentHtml, { assessment: null, playtest: fixturePlaytest }), {
    passed: false, playthrough: 'failed', independentChecks: { status: 'passed', testedFields: [], untestedFields: [],
      equivalentChecks: 0 }, errors: ['The playthrough contract was invalid.'],
  });
  assert.deepEqual(await checkHtml('<html></html>', { assessment: { fields: [null] }, playtest: fixturePlaytest }), {
    passed: false, playthrough: 'failed', independentChecks: { status: 'passed', testedFields: [], untestedFields: [],
      equivalentChecks: 0 }, errors: ['The playthrough contract was invalid.'],
  });
});

test('independent field probes detect an omitted-field stale input before the model invalidation trace', async () => {
  const staleSecondField = assessmentHtml.replace('</body>', `<script>
    let solved=false;window.mathPlayLabActivity.subscribe(state=>{if(state.complete)solved=true;});
    document.querySelector('#mpl-reset').addEventListener('click',()=>{solved=false;});
    document.querySelector('#solution-input').addEventListener('input',event=>{if(solved)event.stopImmediatePropagation();});
  </script></body>`);
  const report = await checkHtml(staleSecondField, { assessment: readyPlan.assessment, playtest: fixturePlaytest });
  assert.equal(report.passed, false);
  assert.match(report.errors[0], /field solution during invalidation/);
  assert.match(report.errors[0], /requested=/);
});

test('independent equivalent probes reject a generated page that coalesces an exact fraction', async () => {
  const fixture = singleFieldActivity({ extraScript: `document.querySelector('#answer').addEventListener('input',event=>{
    if(event.target.value==='12/2')event.target.value='6';
  });` });
  const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest: fixture.playtest });
  assert.equal(report.passed, false);
  assert.match(report.errors[0], /field answer during equivalent/);
  assert.match(report.errors[0], /12\/2/);
});

test('independent numeric probes reject nearby decimals rounded by generated code', async () => {
  const fixture = singleFieldActivity({ type: 'number', attributes: 'step="any"', extraScript: `document.querySelector('#answer').addEventListener('input',event=>{
    if(event.target.value.includes('000000000000000001'))event.target.value=String(Number(event.target.value));
  });` });
  const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest: fixture.playtest });
  assert.equal(report.passed, false);
  assert.match(report.errors[0], /field answer during raw-preservation/);
  assert.match(report.errors[0], /6\.000000000000000001/);
});

test('a wrong exact answer may have generated custom validity when it still invalidates and recovers', async () => {
  const fixture = singleFieldActivity({ extraScript: `document.addEventListener('DOMContentLoaded',()=>{
    document.querySelector('#answer').addEventListener('input',event=>{
      event.target.setCustomValidity(event.target.value==='6.000000000000000001'?'Try the exact value.':'');
    });
  });` });
  const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest: fixture.playtest });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['answer'], untestedFields: [], equivalentChecks: 1 });
});

test('maxlength-constrained exact text input remains covered without an impossible equivalent form', async () => {
  const fixture = singleFieldActivity({ expected: '3', initial: '', attributes: 'maxlength="1"' });
  const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest: {
    solve: [{ action: 'fill', selector: '#answer', value: '3' }, { action: 'click', selector: '#answer-check', value: null }],
    wrong: [{ action: 'fill', selector: '#answer', value: '2' }, { action: 'click', selector: '#answer-check', value: null }],
    recover: [{ action: 'fill', selector: '#answer', value: '3' }, { action: 'click', selector: '#answer-check', value: null }],
    invalidate: [{ action: 'fill', selector: '#answer', value: '2' }],
  } });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['answer'], untestedFields: [], equivalentChecks: 0 });
});

test('native number input finds an equivalent decimal for a fraction-form exact target', async () => {
  const fixture = singleFieldActivity({ type: 'number', expected: '8/2', attributes: 'step="any"' });
  const playtest = {
    solve: [{ action: 'fill', selector: '#answer', value: '4' }, { action: 'click', selector: '#answer-check', value: null }],
    wrong: [{ action: 'fill', selector: '#answer', value: '5' }, { action: 'click', selector: '#answer-check', value: null }],
    recover: [{ action: 'fill', selector: '#answer', value: '4' }, { action: 'click', selector: '#answer-check', value: null }],
    invalidate: [{ action: 'fill', selector: '#answer', value: '5' }],
  };
  const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['answer'], untestedFields: [],
    equivalentChecks: 1 });
});

test('range and wide-approximation checkpoints use a valid changed numeric probe when no wrong one exists', async () => {
  const cases = [
    { rule: { kind: 'range', lower: '0', upper: '10', lowerClosed: true, upperClosed: true } },
    { rule: { kind: 'approx', expected: '3', tolerance: '5' } },
  ];
  for (const { rule } of cases) {
    const fixture = singleFieldActivity({ type: 'number', expected: '3', attributes: 'min="0" max="10" step="any"' });
    fixture.assessment.checkpoints[0].rule = rule;
    const edit = value => ({ action: 'fill', selector: '#answer', value });
    const submit = { action: 'click', selector: '#answer-check', value: null };
    const playtest = { solve: [edit('3'), submit], wrong: [edit('20'), submit], recover: [edit('3'), submit],
      invalidate: [edit('4')] };
    const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest });
    assert.equal(report.passed, true, `${rule.kind}: ${report.errors.join('; ')}`);
    assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['answer'], untestedFields: [],
      equivalentChecks: 0 });
  }
});

test('native number, range, and select inputs remain probeable with their real constraints', async () => {
  for (const type of ['number', 'range', 'select']) {
    const fixture = singleFieldActivity({ type, attributes: type === 'number' ? 'step="any"' : '' });
    const report = await checkHtml(fixture.html, { assessment: fixture.assessment, playtest: fixture.playtest });
    assert.equal(report.passed, true, `${type}: ${report.errors.join('; ')}`);
    assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['answer'], untestedFields: [],
      equivalentChecks: type === 'number' ? 1 : 0 });
  }
});

test('independent edits preserve a confirmed unrelated checkpoint branch', async () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'first', initial: '' }, { id: 'second', initial: '' }],
    checkpoints: [
      { id: 'first-check', field: 'first', dependsOn: [], watchFields: [], rule: { kind: 'exact', expected: '3' }, feedback: 'Check first.' },
      { id: 'second-check', field: 'second', dependsOn: [], watchFields: [], rule: { kind: 'exact', expected: '4' }, feedback: 'Check second.' },
    ] };
  const edit = (id, value) => ({ action: 'fill', selector: `#${id}-input`, value });
  const submit = id => ({ action: 'click', selector: `#${id}-submit`, value: null });
  const solve = [edit('first', '3'), submit('first'), edit('second', '4'), submit('second')];
  const playtest = { solve, wrong: [edit('first', '2'), submit('first')], recover: solve,
    invalidate: [edit('first', '2')] };
  const html = `<style>body{font:16px sans-serif}#mpl-problem{font-size:16px}input,button{font:16px sans-serif;min-height:44px;min-width:64px}[data-mpl-feedback]{min-height:24px}</style>
    <p id="mpl-problem">Find both exact values.</p>
    <input id="first-input" type="text" data-mpl-control data-mpl-field="first"><button id="first-submit" data-mpl-submit="first-check">Check first</button><p data-mpl-feedback="first-check"></p>
    <input id="second-input" type="text" data-mpl-field="second"><button id="second-submit" data-mpl-submit="second-check">Check second</button><p data-mpl-feedback="second-check"></p>
    <p id="mpl-status" role="status">In progress.</p><button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p><button id="mpl-reset">Reset</button>
    <script>window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};let n=0;
      document.querySelector('#mpl-hint').addEventListener('click',()=>{const h=document.querySelector('#mpl-hint-text');n++;h.textContent=n===1?'Check both values.':'Keep the branches separate.';h.hidden=false;});
      document.querySelector('#mpl-reset').addEventListener('click',()=>{n=0;const h=document.querySelector('#mpl-hint-text');h.textContent='';h.hidden=true;});</script>`;
  const report = await checkHtml(html, { assessment, playtest });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['first', 'second'], untestedFields: [],
    equivalentChecks: 2 });
});

test('custom-only assessment fields are reported as partial coverage without failing the page', async () => {
  const assessment = { version: 1, requiresReview: true,
    fields: [{ id: 'answer', initial: '' }, { id: 'proof', initial: '' }],
    checkpoints: [
      { id: 'answer-check', field: 'answer', dependsOn: [], watchFields: [], rule: { kind: 'exact', expected: '6' }, feedback: 'Check the value.' },
      { id: 'proof-check', field: 'proof', dependsOn: [], watchFields: [], rule: { kind: 'review' }, feedback: 'Review this proof.' },
    ] };
  const answerEdit = value => ({ action: 'fill', selector: '#answer-input', value });
  const answerSubmit = { action: 'click', selector: '#answer-submit', value: null };
  const proofActions = [{ action: 'click', selector: '#proof-action', value: null },
    { action: 'click', selector: '#proof-submit', value: null }];
  const completed = [answerEdit('6'), answerSubmit, ...proofActions];
  const playtest = { solve: completed,
    wrong: [answerEdit('5'), answerSubmit], recover: completed,
    invalidate: [answerEdit('5')] };
  const html = `<style>body{font:16px sans-serif}#mpl-problem{font-size:16px}input,button{font:16px sans-serif;min-height:44px;min-width:64px}[data-mpl-feedback]{min-height:24px}</style>
    <p id="mpl-problem">Find the value and state a reason.</p>
    <input id="answer-input" data-mpl-control data-mpl-field="answer"><button id="answer-submit" data-mpl-submit="answer-check">Check answer</button><p data-mpl-feedback="answer-check"></p>
    <button id="proof-action" data-mpl-control>Write the reason</button><button id="proof-submit" data-mpl-submit="proof-check">Check reason</button><p data-mpl-feedback="proof-check"></p>
    <p id="mpl-status" role="status">In progress.</p><button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p><button id="mpl-reset">Reset</button>
    <script>window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};let n=0;
      document.querySelector('#proof-action').addEventListener('click',()=>window.mathPlayLabActivity.set('proof','Reason provided.'));
      document.querySelector('#mpl-hint').addEventListener('click',()=>{const h=document.querySelector('#mpl-hint-text');n++;h.textContent=n===1?'Check the value.':'State a reason.';h.hidden=false;});
      document.querySelector('#mpl-reset').addEventListener('click',()=>{n=0;const h=document.querySelector('#mpl-hint-text');h.textContent='';h.hidden=true;});</script>`;
  const report = await checkHtml(html, { assessment, playtest });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'partial', testedFields: ['answer'], untestedFields: ['proof'],
    equivalentChecks: 1 });
});

test('relation playthrough accepts two constructions and host-probes an omitted non-primary field', async () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'a', initial: '' }, { id: 'b', initial: '' }],
    checkpoints: [
      { id: 'b_domain', field: 'b', dependsOn: [], watchFields: [],
        rule: { kind: 'range', lower: '5', upper: '7', lowerClosed: true, upperClosed: true },
        feedback: 'Keep the second count between five and seven.' },
      { id: 'total', field: 'a', dependsOn: ['b_domain'], watchFields: [], rule: { kind: 'relation',
      integerFields: ['a', 'b'], conditions: [
        { left: '[a] + [b]', operator: 'eq', right: '10' },
        { left: '[a]', operator: 'gte', right: '0' },
        { left: '[b]', operator: 'gte', right: '0' },
      ] }, feedback: 'Keep both counts nonnegative and make the total ten.' },
    ] };
  const edit = (field, value) => ({ action: 'fill', selector: `#${field}-input`, value });
  const submitDomain = { action: 'click', selector: '#b-domain-submit', value: null };
  const submitTotal = { action: 'click', selector: '#total-submit', value: null };
  const recoverAndShowTwoSolutions = [edit('a', '3'), edit('b', '7'), submitDomain, submitTotal,
    edit('a', '4'), edit('b', '6'), submitDomain, submitTotal];
  const playtest = { solve: recoverAndShowTwoSolutions,
    wrong: [edit('a', '3'), edit('b', '4'), submitDomain, submitTotal],
    recover: recoverAndShowTwoSolutions,
    invalidate: [edit('b', '4')] };
  const html = `<style>body{font:16px sans-serif}#mpl-problem{font-size:16px}input,button{font:16px sans-serif;min-height:44px;min-width:64px}[data-mpl-feedback]{min-height:24px}</style>
    <p id="mpl-problem">Choose two nonnegative values that total ten.</p>
    <label>A <input id="a-input" data-mpl-control data-mpl-field="a"></label>
    <label>B <input id="b-input" data-mpl-field="b"></label>
    <button id="b-domain-submit" data-mpl-submit="b_domain">Check the second count</button><p data-mpl-feedback="b_domain"></p>
    <button id="total-submit" data-mpl-submit="total">Check total</button><p data-mpl-feedback="total"></p>
    <p id="mpl-status" role="status">In progress.</p><button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p>
    <button id="mpl-reset">Reset</button><script>
      window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};let hints=0;
      document.querySelector('#mpl-hint').addEventListener('click',()=>{const hint=document.querySelector('#mpl-hint-text');
        hints++;hint.textContent=hints===1?'Keep the values nonnegative.':'Try another pair with the same total.';hint.hidden=false;});
      document.querySelector('#mpl-reset').addEventListener('click',()=>{hints=0;const hint=document.querySelector('#mpl-hint-text');hint.textContent='';hint.hidden=true;});
    </script>`;
  const report = await checkHtml(html, { assessment, playtest });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['a', 'b'], untestedFields: [],
    equivalentChecks: 2 });
});

test('select alternatives that preserve an inequality are not counted as equivalent spellings', async () => {
  const assessment = { version: 1, requiresReview: false,
    fields: [{ id: 'a', initial: '' }, { id: 'b', initial: '' }],
    checkpoints: [
      { id: 'b_domain', field: 'b', dependsOn: [], watchFields: [],
        rule: { kind: 'range', lower: '5', upper: '8', lowerClosed: true, upperClosed: true },
        feedback: 'Keep the second value between five and eight.' },
      { id: 'total', field: 'a', dependsOn: ['b_domain'], watchFields: [], rule: { kind: 'relation',
        integerFields: [], conditions: [
          { left: '[a] + [b]', operator: 'gte', right: '10' },
          { left: '[a]', operator: 'gte', right: '0' },
          { left: '[b]', operator: 'gte', right: '0' },
        ] }, feedback: 'Make the total at least ten.' },
    ] };
  const editA = value => ({ action: 'fill', selector: '#a-input', value });
  const editB = value => ({ action: 'select', selector: '#b-select', value });
  const submitDomain = { action: 'click', selector: '#b-domain-submit', value: null };
  const submitTotal = { action: 'click', selector: '#total-submit', value: null };
  const solve = [editA('3'), editB('7'), submitDomain, submitTotal,
    editA('3'), editB('8'), submitDomain, submitTotal];
  const playtest = { solve, wrong: [editA('3'), editB('6'), submitDomain, submitTotal],
    recover: solve, invalidate: [editB('6')] };
  const html = `<style>body{font:16px sans-serif}#mpl-problem{font-size:16px}input,select,button{font:16px sans-serif;min-height:44px;min-width:64px}[data-mpl-feedback]{min-height:24px}</style>
    <p id="mpl-problem">Choose nonnegative values with a total of at least ten, keeping the second value from five to eight.</p>
    <label>A <input id="a-input" data-mpl-control data-mpl-field="a"></label>
    <label>B <select id="b-select" data-mpl-field="b"><option value="">Choose</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label>
    <button id="b-domain-submit" data-mpl-submit="b_domain">Check second value</button><p data-mpl-feedback="b_domain"></p>
    <button id="total-submit" data-mpl-submit="total">Check total</button><p data-mpl-feedback="total"></p>
    <p id="mpl-status" role="status">In progress.</p><button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p>
    <button id="mpl-reset">Reset</button><script>
      window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};let hints=0;
      document.querySelector('#mpl-hint').addEventListener('click',()=>{const hint=document.querySelector('#mpl-hint-text');
        hints++;hint.textContent=hints===1?'Check the allowed range.':'Then compare the total.';hint.hidden=false;});
      document.querySelector('#mpl-reset').addEventListener('click',()=>{hints=0;const hint=document.querySelector('#mpl-hint-text');hint.textContent='';hint.hidden=true;});
    </script>`;
  const report = await checkHtml(html, { assessment, playtest });
  assert.equal(report.passed, true, report.errors.join('; '));
  assert.deepEqual(report.independentChecks, { status: 'passed', testedFields: ['a', 'b'], untestedFields: [],
    equivalentChecks: 1 });
});

test('the hint region must announce updates instead of setting aria-live off',async()=>{
  const report=await checkHtml(fixtureHtml.replace('aria-live="polite"','role="status" aria-live="off"'));
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('hint live region')));
});

test('a control that moves without updating mathematical state fails the browser check',async()=>{
  const report=await checkHtml(fixtureHtml.replace('state.value=Number(input.value);',''));
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('did not change mathematical state')));
});

test('reset fails the browser check when it restores the input but leaves mathematical state changed',async()=>{
  const report=await checkHtml(fixtureHtml.replace('state.value=0;input.value=0;','input.value=0;'));
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('did not restore initial mathematical state')));
});

test('the checker selects a different enabled option and accepts reset with reordered state keys',async()=>{
  const html=fixtureHtml.replace(/<label>.*<\/label>/,
    '<label>Value <select data-mpl-control><option>1</option><option disabled>Locked</option><option selected>0</option></select></label>')
    .replace(/<script>[\s\S]*<\/script>/,`<script>
      const input=document.querySelector('select');
      let state={value:0, equation:{left:"2x + 3",right:11}};
      const hintText=document.querySelector('#mpl-hint-text');
      let hintStep=0;
      window.mathPlayLab={getState:()=>state};
      input.addEventListener('change',()=>{state.value=Number(input.value);});
      document.querySelector('#mpl-hint').addEventListener('click',()=>{
        hintStep=Math.min(2,hintStep+1);
        hintText.textContent=hintStep===1?'Keep the two sides balanced.':'Keep the two sides balanced. Select the equal operation.';
        hintText.hidden=false;
      });
      document.querySelector('#mpl-reset').addEventListener('click',()=>{
        if(state.value!==1) throw new Error('Expected the other enabled value before reset.');
        input.value='0';
        state={equation:{right:11,left:"2x + 3"},value:0};
        hintStep=0;
        hintText.textContent='';
        hintText.hidden=true;
      });
    </script>`);
  assert.deepEqual(await checkHtml(html),{passed:true,errors:[]});
});

test('empty mathematical state fails the browser check',async()=>{
  const report=await checkHtml(fixtureHtml.replace('getState:()=>state','getState:()=>({})'));
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('nonempty JSON object')));
});

test('browser script errors are reported rather than treated as successful rendering',async()=>{
  const report=await checkHtml(fixtureHtml.replace('</body>','<script>throw new Error("fixture-broken-script")</script></body>'));
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>error.includes('fixture-broken-script')));
});

test('untrusted markup cannot put a fake head comment before the sandbox policy',async()=>{
  const report=await checkHtml('<!-- <head> -->'+fixtureHtml.replace('</body>',
    '<script src="https://unrelated.example/never-load.js"></script></body>'));
  assert.equal(report.passed,false);
  assert.ok(report.errors.some(error=>/Content Security Policy|script-src|violates/i.test(error)));
});

test('exact math is installed before generated scripts and keeps the browser runtime contract',async()=>{
  const html=`<style>
    body{margin:0;padding:8px;font:16px sans-serif}#mpl-problem{font-size:16px}
    label{display:inline-flex;align-items:center;min-height:44px;gap:8px}
    input[data-mpl-control]{width:64px;height:44px;font-size:16px}
    button{min-height:44px;font-size:16px}
  </style>
  <p id="mpl-problem">Check an exact value.</p>
  <label>Value <input id="answer" data-mpl-control type="text" value="0"></label>
  <p id="mpl-status" role="status">Try an exact value.</p>
  <button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p>
  <button id="mpl-reset">Reset</button>
  <script>
    const exact=window.mathPlayLabExact;
    const descriptor=Object.getOwnPropertyDescriptor(window,'mathPlayLabExact');
    if(!exact||!Object.isFrozen(exact)||descriptor?.writable!==false||descriptor?.configurable!==false){
      throw new Error('Exact math was not installed as a fixed frozen helper before page scripts.');
    }
    if(!exact.equals(' -3 / -2 ','1.5')||exact.equals('-1.5000000001','-3/2')){
      throw new Error('Exact equality failed equivalence or close-value rejection.');
    }
    const input=document.querySelector('#answer');
    const status=document.querySelector('#mpl-status');
    const hintText=document.querySelector('#mpl-hint-text');
    const currentState=()=>({value:input.value,correct:exact.equals(input.value,'2')});
    window.mathPlayLab={getState:currentState};
    const update=()=>{status.textContent=exact.equals(input.value,'2')?'Exact value matches.':'Keep exploring.';};
    input.addEventListener('input',update);
    let hintStep=0;
    document.querySelector('#mpl-hint').addEventListener('click',()=>{
      hintStep=Math.min(2,hintStep+1);
      hintText.textContent=hintStep===1?'Compare exact values.':'Try the equivalent fraction form.';
      hintText.hidden=false;
    });
    document.querySelector('#mpl-reset').addEventListener('click',()=>{
      input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));
      hintStep=0;hintText.textContent='';hintText.hidden=true;
    });
  </script>`;
  assert.deepEqual(await checkHtml(html),{passed:true,errors:[]});
});
