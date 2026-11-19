# Evaluation runner

The runner defaults to a **zero-call dry run**. It validates a suite and lists its selected cases and model-configuration availability without calling the model or browser checker:

```sh
npm run eval
npm run eval -- --suite curriculum --limit 12
npm run eval -- --case pilot-roots
```

The pilot is the default suite. Curriculum runs read all five files under `evaluation/cases/` and stop with a missing-file error until the complete set is present. Use `npm run eval:validate` to inspect IDs, coverage, required metadata, registry stages, variant gaps, stress-group counts, prepared counts and absent coverage. The validator reports the planned corpus target as 423 core cases plus 48 stress cases; the pilot count is reported separately.

## Live runs

Live mode requires an explicit provider-call cap:

```sh
npm run eval -- --live --max-calls 24 --limit 8
npm run eval -- --live --max-calls 60 --suite curriculum --limit 20 --include-holdout
```

Configure `MODEL_PROVIDER`, the matching API key, and a model identifier in `.env` or the process environment before the live command. `npm run eval` loads the same local `.env` as `npm start`; dry run still makes no calls. The runner checks configuration before creating a run. `--max-calls` counts each planning, page-generation and repair request before it is sent; failed provider requests count. A refused request after the cap is recorded separately and is not counted as an actual provider call. Cases run sequentially, and generation uses at most one repair. No automatic retry loop runs. Holdout cases are excluded unless `--include-holdout` is present; artifacts retain each case's actual split or `not_specified` for legacy pilot cases.

Runs are written to unique directories under `evaluation/runs/`, which is ignored by Git. Each case record preserves its original problem, reference answer and checks, but only `problem` is passed to `generateGame`. Artifacts include sanitized diagnostics, HTML actually passed to the browser checker, result or safe failure code, timing, repair count, model identifier, and prompt/implementation hashes. The `validatedContracts` array records validated model output by request: planning entries contain `{ requestName: "play_plan", plan: <validated plan> }`; initial-page entries contain `{ requestName: "playable_exercise", status, issue }`; repair entries contain `{ requestName: "repaired_exercise", status, issue, edits: [{ find, replace }] }`. A ready repair has 1–6 exact edits; each string is at most 12,000 characters and all find/replace text totals at most 24,000 characters. The runner captures each exact HTML string passed to a check as that attempt's HTML artifact, including the applied repaired page when its second check fails. These structured values are model-authored diagnostic evidence, not mathematical truth. API keys, authorization headers and raw provider error bodies are not stored. Image scenarios are explicitly skipped as awaiting an image fixture/P1 runner. Software scenarios are marked for software-test routing and never sent to the model.

## Bounded curriculum breadth sweep

The dedicated sweep runner validates the byte hash and 141-case ID set in `.work/curriculum-first-sweep.json` against `.work/curriculum-live-budget.json`. It runs the original development source case once per queue entry in saved round-robin order, with a default batch limit of four. Failed or cancelled cases remain attempted and are skipped on later breadth batches.

```sh
node evaluation/curriculum-sweep.mjs
node evaluation/curriculum-sweep.mjs --limit 141
node --env-file-if-exists=.env evaluation/curriculum-sweep.mjs --live --limit 4
```

Dry run is the default and only reads the queue, source cases, and budget ledger. Live mode uses the approved OpenRouter model and fixed limits of 423 provider requests and $20 total committed cost. It admits a case only when three request slots and $1.95 in reservations remain. Every outgoing request reserves $0.65 in the ledger before fetch; known finite `usage.cost` settles the call, while missing or invalid usage and failed or cancelled requests retain the full reservation. A cost above $0.65 writes a durable halt that requires manual review. The runner holds an exclusive lock through the batch and refuses to continue when it finds a stale lock or incomplete ledger run. Progress reports distinguish `runEvaluation` model invocations from outgoing provider requests. Generated games and runtime-check results remain unreviewed artifacts and are not claims of mathematical correctness.

A provider request failure or missing case artifact stops the batch after the attempted case is recorded; later selected cases remain unattempted. HTTP diagnostics are limited to status, a bounded numeric retry delay, approved source/reason values, and safe request IDs. Failed HTTP responses and fetch exceptions keep their full unknown-cost reservation, even if an error body includes a cost field.

## Conservative reservation reconciliation

The reviewed local request reconstruction is an upper bound, not an actual-cost receipt. Its 18 rows bound the prior $11.70 of unknown reservations at $3.560144 while leaving each call's original `reservedCostUSD`, `unknown` status, null actual cost, provider-call count, and parent runs unchanged. Only future held-budget totals use the validated bounds; calls outside the evidence and new requests continue to reserve $0.65 each.

```sh
node evaluation/reconcile-reservations.mjs
node evaluation/reconcile-reservations.mjs --apply
```

The command defaults to a read-only dry run. `--apply` takes the shared sweep lock, verifies the approved evidence digest, all 18 unknown calls and failed parent artifacts, source hashes and pre-call modification times, then atomically records bound metadata and reconciliation provenance. Later reads validate the saved projection without requiring reviewable case artifacts to remain byte-identical.

## Reviewer-triggered bounded repair

The repair runner is dry-run by default. It only selects a first-pass case after all 141 breadth runs are terminal, and only when the saved strict report identifies exactly one explicit independent-review failure. A runtime-failed first-pass case can qualify when its validated ready plan and latest saved HTML are reusable. One new child run and at most one `$0.65`-reserved request are created per case; all requests use the same 423-call and `$20` ledger, lock, and budget halt. A failed or cancelled repair is retained and never selected again. The parent run remains unchanged. A repaired child starts with fresh unreviewed review cells and is not mathematically accepted until a reviewer checks it.

```sh
node evaluation/curriculum-repair.mjs
node --env-file-if-exists=.env evaluation/curriculum-repair.mjs --live --limit 1
```

Live repair refuses to start until all 141 first-pass ledger runs are terminal. It uses saved failed-review evidence and the validated original plan with the latest saved page; it does not create a new plan or replace first-pass artifacts.

## Bounded curriculum delivery retry

The delivery retry runner is dry-run by default. It waits for all 141 first-pass runs to be terminal and only retries verified no-page provider or truncation failures, the explicit M-G01 wording correction, or cases in the root-authored invalid-plan decision file whose parent hashes and independent math review still match. Each original case gets at most one child run, three provider calls, and a full `$1.95` reservation admission under the shared `$20`/423-call ledger and lock. Failed or cancelled children remain recorded and are not retried again; first-pass rows, costs, and parent artifacts are unchanged. Each child starts unreviewed and keeps its original and used question in retry provenance.

```sh
node evaluation/curriculum-retry.mjs
node --env-file-if-exists=.env evaluation/curriculum-retry.mjs --live --limit 1
```

The live command requires the same approved OpenRouter model/endpoint and a complete, idle first-pass ledger. Invalid-plan decisions are read from `.work/curriculum-regeneration-decisions.json`; each decision is bound to a parent run, exact case-artifact hash, and failed independent mathematics or explanation review. Delivery retries preserve unknown provider costs and stop after a request/unavailable or browser failure.

## Manual review and report

Generated artifacts start with an unreviewed manual-review record. Review it by hand in the case JSON after inspecting the original task and generated artifact:

```json
{
  "schemaVersion": 1,
  "dimensions": {
    "fidelity": { "status": "unreviewed", "reviewer": "", "evidence": "" },
    "mathematics": { "status": "unreviewed", "reviewer": "", "evidence": "" },
    "playability": { "status": "unreviewed", "reviewer": "", "evidence": "" },
    "explanation": { "status": "unreviewed", "reviewer": "", "evidence": "" }
  },
  "checklist": {
    "correct": { "status": "unreviewed", "reviewer": "", "evidence": "" },
    "wrong": { "status": "unreviewed", "reviewer": "", "evidence": "" },
    "reset": { "status": "unreviewed", "reviewer": "", "evidence": "" },
    "multipleSolutions": { "status": "unreviewed", "reviewer": "", "evidence": "" }
  },
  "expectedBehavior": { "status": "unreviewed", "reviewer": "", "evidence": "" }
}
```

Each cell allows `unreviewed`, `passed`, `failed`, or `not_applicable`; every reviewed cell needs a reviewer and evidence. Correct, wrong and reset paths must pass; only multiple-solution review can be marked not applicable, with evidence. Full success requires completed generation, the applicable runtime check to pass, and all four independent-review dimensions and expected behavior to pass. Clarification handling has a separate denominator and only counts after independent review of expected behavior. When a repair is sent, `firstAttemptReview` records the first page and `review` records the latest returned page. The report gives first-attempt and after-repair full math totals on the same attempted-question denominator. Runtime checks are reported separately as **RUNTIME** first-attempt and after-repair rates. A runtime pass is never mathematical proof. Malformed review records or a pass without evidence are reported and cannot count as success.

```sh
npm run eval:report -- evaluation/runs/RUN_ID
```

The report includes planned, selected, attempted, completed-generation and unrun counts; actual provider calls, cap refusals, observed usage/cost only, errors, repairs, denominators including failed attempted cases, review gaps, and stage/coverage breakdowns when metadata exists. It labels fixture runs as `fixtures`; fixture output is not live-model evidence.
