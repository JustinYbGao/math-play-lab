export const readyPlan = {
  status: 'ready', title: 'Balance the equation', problem: 'Solve 2x + 3 = 11.',
  topics: ['linear equations'], constraints: ['Keep both sides equal.'],
  referenceAnswer: 'x = 4', objective: 'Find the value inside each box.', activityType: 'solve',
  initialState: 'The unknown box has value 0 and both equation sides are visible.',
  invariants: ['Each operation keeps both sides equal.'],
  actions: ['Remove equal weights from both sides.', 'Divide both sides equally.'],
  hints: ['Keep the two sides balanced as you simplify.', 'Subtract 3 from both sides, then divide by 2.'],
  requiresReview: false,
  assessment: { version: 1, requiresReview: false,
    fields: [{ id: 'removed', initial: '' }, { id: 'solution', initial: '' }],
    checkpoints: [
      { id: 'subtract', field: 'removed', dependsOn: [], watchFields: [],
        rule: { kind: 'exact', expected: '3' }, feedback: 'Subtract 3 from both sides.' },
      { id: 'solve', field: 'solution', dependsOn: ['subtract'], watchFields: ['removed'],
        rule: { kind: 'exact', expected: '4' }, feedback: 'Check the value in the original equation.' },
    ] },
  winCondition: 'The original equation holds with x = 4.',
  explanation: 'Subtract 3 from both sides, then divide both sides by 2.',
  clarification: null,
};

export const fixtureHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test fixture</title>
<style>body{margin:0;padding:8px;font:16px sans-serif}#mpl-problem{font-size:16px}label{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:16px}input[data-mpl-control]{width:64px;height:44px;font-size:16px}select{min-width:64px;height:44px;font-size:16px}</style></head>
<body><p id="mpl-problem">Solve 2x + 3 = 11.</p>
<label>Value <input data-mpl-control type="number" value="0"></label>
<p id="mpl-status" role="status">Try a value.</p>
<button id="mpl-hint">Hint</button><p id="mpl-hint-text" aria-live="polite" hidden></p>
<button id="mpl-reset">Reset</button>
<script>const input=document.querySelector('input');
const state={value:0};
const hintText=document.querySelector('#mpl-hint-text');
let hintStep=0;
window.mathPlayLab={getState:()=>state};
input.addEventListener('input',()=>{state.value=Number(input.value);document.querySelector('#mpl-status').textContent=state.value===4?'Equal!':'Keep exploring.';});
document.querySelector('#mpl-hint').addEventListener('click',()=>{hintStep=Math.min(2,hintStep+1);hintText.textContent=hintStep===1?'Keep the two sides balanced as you simplify.':'Keep the two sides balanced as you simplify. Subtract 3 from both sides, then divide by 2.';hintText.hidden=false;});
document.querySelector('#mpl-reset').addEventListener('click',()=>{state.value=0;input.value=0;hintStep=0;hintText.textContent='';hintText.hidden=true;document.querySelector('#mpl-status').textContent='Try a value.';});</script>
</body></html>`;

export const assessmentHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Balance the equation</title>
<style>body{margin:0;padding:8px;font:16px sans-serif}#mpl-problem{font-size:16px}label{display:flex;align-items:center;gap:8px;min-height:52px}input{width:84px;height:44px;font-size:16px}button{min-height:44px;min-width:72px;font-size:16px}[data-mpl-feedback]{min-height:24px}</style></head><body>
<p id="mpl-problem">Solve 2x + 3 = 11 by balancing both sides, then find x.</p>
<label>Amount removed from each side <input id="removed-input" type="text" data-mpl-control data-mpl-field="removed" autocomplete="off"></label>
<button id="removed-check" type="button" data-mpl-submit="subtract">Check balance step</button><p id="removed-feedback" data-mpl-feedback="subtract"></p>
<label>Value of x <input id="solution-input" type="text" data-mpl-field="solution" autocomplete="off"></label>
<button id="solution-check" type="button" data-mpl-submit="solve">Check solution</button><p id="solution-feedback" data-mpl-feedback="solve"></p>
<p id="mpl-status" role="status">Keep exploring.</p><button id="mpl-hint" type="button">Hint</button><p id="mpl-hint-text" role="status" aria-live="polite" hidden></p>
<button id="mpl-reset" type="button">Reset</button>
<script>let hintStep=0;const hint=document.querySelector('#mpl-hint-text');
window.mathPlayLab={getState:()=>({assessment:window.mathPlayLabActivity.getState()})};
document.querySelector('#mpl-hint').addEventListener('click',()=>{hintStep=Math.min(2,hintStep+1);hint.textContent=hintStep===1?'Keep both sides balanced.':'Subtract 3 from both sides, then divide by 2.';hint.hidden=false;});
document.querySelector('#mpl-reset').addEventListener('click',()=>{hintStep=0;hint.textContent='';hint.hidden=true;});</script>
</body></html>`;

export const fixturePlaytest = {
  solve: [
    { action: 'fill', selector: '#removed-input', value: '3' },
    { action: 'click', selector: '#removed-check', value: null },
    { action: 'fill', selector: '#solution-input', value: '4' },
    { action: 'click', selector: '#solution-check', value: null },
  ],
  wrong: [
    { action: 'fill', selector: '#removed-input', value: '2' },
    { action: 'click', selector: '#removed-check', value: null },
  ],
  recover: [
    { action: 'fill', selector: '#removed-input', value: '3' },
    { action: 'click', selector: '#removed-check', value: null },
    { action: 'fill', selector: '#solution-input', value: '4' },
    { action: 'click', selector: '#solution-check', value: null },
  ],
  invalidate: [{ action: 'fill', selector: '#removed-input', value: '2' }],
};
export const reviewAssessment = { version: 1, requiresReview: true, fields: [{ id: 'proof', initial: '' }],
  checkpoints: [{ id: 'argument', field: 'proof', dependsOn: [], watchFields: [], rule: { kind: 'review' },
    feedback: 'Review this proof step.' }] };
export const reviewPlaytest = {
  wrong: [{ action: 'click', selector: '#proof-check', value: null }],
  recover: [{ action: 'fill', selector: '#proof-input', value: 'The two sides remain equal.' },
    { action: 'click', selector: '#proof-check', value: null }],
  solve: [{ action: 'fill', selector: '#proof-input', value: 'Subtract equal amounts from both sides.' },
    { action: 'click', selector: '#proof-check', value: null }],
  invalidate: [{ action: 'fill', selector: '#proof-input', value: 'A changed argument.' }],
};

export const staleCapturedStateHtml = fixtureHtml
  .replace('const state={value:0};', 'let state={value:0};const capturedState=state;')
  .replace('state.value=Number(input.value);', 'capturedState.value=Number(input.value);')
  .replace('state.value=0;input.value=0;', 'state={value:0};input.value=0;');

export const rebuiltControlAfterResetHtml = fixtureHtml.replace(
  'state.value=0;input.value=0;',
  `state.value=0;
  const replacement=document.createElement('input');
  replacement.dataset.mplControl='';replacement.type='number';replacement.value='0';
  replacement.addEventListener('input',()=>{state.value=Number(replacement.value);document.querySelector('#mpl-status').textContent=state.value===4?'Equal!':'Keep exploring.';});
  input.replaceWith(replacement);`
);

export const fixturePage = { status: 'ready', html: assessmentHtml, issue: null, playtest: fixturePlaytest };
export const fixtureRepair = { status: 'ready', edits: [{ find: 'Keep exploring.', replace: 'Review the original equation.' }], issue: null };
export const fixtureRepairedHtml = assessmentHtml.replace('Keep exploring.', 'Review the original equation.');
export const legacyFixtureRepair = fixtureRepair;
export const legacyFixtureRepairedHtml = fixtureHtml.replace('Keep exploring.', 'Review the original equation.');

export function scriptedModel(values) {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const value = values.shift();
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error('Unexpected extra model call.');
      return { value, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}
