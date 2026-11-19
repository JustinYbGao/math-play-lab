# Math Play Lab

An AI math learning companion for all ages. Turn mathematics problems into playable browser activities, from elementary math to introductory calculus.

![Math Play Lab](submission/accessed-2026-11-18-v3/screenshots/math-play-lab-thumbnail-3x2.png)

Enter a problem, explore an interactive activity, and learn through guided hints and immediate feedback. This project builds on the original UGREEN Math Play Lab concept.

- [Watch or download the narrated feature tour](submission/accessed-2026-11-18-v3/video/math-play-lab-feature-tour.en.mp4)
- [Project story](submission/accessed-2026-11-18-v3/project-story.en.md)
- [Credits and AI assistance](submission/accessed-2026-11-18-v3/credits.en.md)

Historical raw evaluation runs, private working notes, and API configuration are excluded from this repository. References below to those local records describe development evidence; those records are not included in the public checkout.

## Run locally

Requires Node.js 20.20 or later and Google Chrome (or another Chromium executable). Install dependencies and start:

```sh
npm install
cp .env.example .env
npm start
```

Open http://127.0.0.1:4318. The development server always listens on `127.0.0.1`; set `PORT` to use a different port. The prebuilt three-problem sample works without a model API. It is explicitly labeled as a sample; arbitrary inputs are never silently replaced by it.

To enable real generation, set the OpenRouter configuration in `.env` locally:

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=deepseek/deepseek-v3.2
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Restart the server after configuration changes. If `MODEL_PROVIDER` is omitted, the server selects OpenRouter when `OPENROUTER_API_KEY` is present; otherwise it uses the existing OpenAI settings. Set `MODEL_PROVIDER=openai` with `OPENAI_API_KEY`, `OPENAI_MODEL`, and optional `OPENAI_BASE_URL` to select OpenAI explicitly. An unknown provider fails closed. Both providers use the Responses API with JSON Schema Structured Outputs; a generic Chat Completions-only endpoint is not compatible. Keep keys out of the browser, source control, and chat.

## Demo usage limits

`APP_MODE` defaults to `development`. In development, generation is enabled unless `GENERATION_ENABLED=false`; without `DEMO_MAX_GENERATIONS`, the global counter is memory-only and has no overall cap. Each anonymous browser session can have five admitted generation requests in a rolling hour. This cookie-based limit is a lightweight demo control, not authentication; it resets if the browser loses its cookie or the server loses its in-memory session state. The persistent global request cap is the backstop. Invalid requests, paused generation, unavailable model configuration, and requests rejected because both generation slots are busy do not count. A request counts once admitted, including a clarification, a failed model run, or a cancellation after admission.

Before enabling a public deployment, configure `APP_MODE=public`, a positive integer `DEMO_MAX_GENERATIONS`, and a writable persistent `DEMO_BUDGET_FILE` (default `.data/generation-budget.json`). Public mode fails closed when the cap is missing or invalid, the counter is corrupt or unavailable, or the cap is exhausted. If the ledger file is absent on a writable path, the server initializes it at zero. `GENERATION_ENABLED=false` pauses new generation while prebuilt samples remain available. This server continues to bind only to `127.0.0.1`; public use requires an explicitly configured TLS reverse proxy, which this project does not deploy.

`DEMO_MAX_GENERATIONS` is a generation-request cap, not a literal provider-call or currency cap. A single admitted generation can invoke up to three model requests (planning, page generation, and one repair), and cost varies with model and output length. The ledger stores only a version and the global admitted request count. It is designed for one server process on one durable volume; do not run multiple replicas against it. A valid count survives a restart, and a corrupt or unreadable ledger fails closed instead of resetting. To reset deliberately, stop the server, review and back up the ledger, then remove it; the next availability check initializes it at zero.

The adapter uses OpenRouter's [Responses API](https://openrouter.ai/docs/api_reference/responses/overview), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), and [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection). The default model is [DeepSeek V3.2](https://openrouter.ai/deepseek/deepseek-v3.2).

When OpenRouter is configured with `anthropic/claude-sonnet-5.5`, each generation stage requests medium reasoning effort to limit reasoning-token consumption under the existing output caps. This policy does not guarantee completion, latency, or quality. The reviewed pilot used this model; to reproduce that selection without rewriting `.env`, start with `OPENROUTER_MODEL=anthropic/claude-sonnet-5.5 npm start`.

On macOS the checker uses `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Elsewhere set `BROWSER_EXECUTABLE` to your Chromium executable.

## Development architecture

- `public/`: problem input, actual generation-stage updates, clarification/error handling, and isolated HTML player.
- `server/model.mjs`: one narrow model adapter; native server-side API calls.
- `server/generate.mjs`: structured problem/play planning, HTML generation, browser check, at most one repair, and one 180-second deadline across the pipeline.
- `server/check.mjs`: a fresh browser context with outbound network blocked; checks the legacy smoke path, replays the wrong/recover/solve/invalidate/reset/replay traces, and adds bounded host-generated field edits and exact-equivalent submissions for new activities. Assessment results record tested and untested fields; this is browser coverage evidence, not proof of the proposed mathematics.
- `server/contracts.mjs` and `public/activity-runtime.js`: new activities share a typed assessment state for fields, checkpoint feedback, dependencies, completion and review-only work. The browser checker verifies those states and traces; it does not prove the proposed mathematics.
- `public/sandbox.js`: sandbox policy and preinstalled exact arithmetic for integer, finite-decimal and fraction values, plus bounded numeric relation rules. It uses bounded BigInt parsing and rejects invalid expressions; it is not a general symbolic solver.
- `tests/`: controlled model fixtures, HTTP integration and real browser checks.

Generated pages run with restricted CSP inside `sandbox="allow-scripts"`, without access to the parent application's origin. The checker reads `window.mathPlayLab.getState()` before and after interacting and after reset. That function reports a nonempty JSON object from the exercise's actual mathematical state, excluding hints, timers and cosmetic values. Browser checks are basic runtime checks. They do **not** prove mathematical correctness, pedagogical value, all possible interaction paths, or safe execution of arbitrary adversarial programs.

New assessments use exact bounded rules or explicitly review-only checkpoints. Inputs longer than 4096 characters are cleared, invalidate dependent confirmations, and show a native validity message until valid input or reset; values are never truncated into a potentially correct answer. Saved historical pages without an assessment continue through the legacy smoke checker.

A `PLAN_CONFLICT` is the model's signal that its proposed page does not match its plan; it is not independent proof that the original problem is inconsistent.

## Verification

```sh
npm test
```

Tests launch a local HTTP listener and headless Chrome. Restricted execution environments may need permission for those local processes. Test model calls are fixtures; `npm test` does not spend API credits. On this workstation `node_modules/playwright-core` points to the preinstalled bundled version; `package.json` pins the same dependency for ordinary installation elsewhere.

## Current limits

The local application, model adapter, runtime checker and usage controls are implemented. As of November 16, 2026, **all eight original pilot scenarios have an independently accepted artifact: seven interactive activities and one missing-information clarification**. These artifacts come from several development iterations. The integral artifact passed only after the main agent reproduced graph and exact-checkpoint defects and requested one bounded AI patch; it is not an autonomous first-attempt pass or a repair triggered by the app's automatic runtime checker. The failed parent output and exact model patch are preserved. See [.work/pilot-current-acceptance.md](.work/pilot-current-acceptance.md) for source runs, evidence and limitations. This does not measure success on arbitrary new problems.

The November 16, 2026 pilot snapshot passed 103/103 fixture/software tests and 548 independent exact-equality comparisons against Python Fraction. This is historical pilot evidence, not the current suite total. The repaired integral was independently replayed, including all 7 cut positions, 35 region probes, exact and equivalent inputs, wrong paths and reset.

A later breadth review covered 141 curriculum topics: 79 were independently accepted and 62 were not accepted. This cohort is separate from the original eight pilot scenarios and includes bounded retry and page-repair artifacts; it does not establish success on arbitrary new problems.

The November 18, 2026 local relation update passed the 247/247 software suite. Its independent exact-arithmetic checks covered 511 relation vectors and 772 existing numeric vectors; four cross-stage relation fixtures passed, and the 79 accepted legacy artifacts replayed 79/79. This local update made zero provider calls and did not change the 141-topic cohort results.

In the original November 16 pilot budget record, all 57 authorized calls were used. Its final three calls reported $0.122418; the additional pilot round reported $1.754948 and one call had unknown cost. These are pilot-only figures and do not form a complete bill. The separate 141-topic curriculum authorization used 423/423 outgoing calls. No API requests were made in this local relation implementation round.

The separate curriculum corpus contains 472 prepared cases (424 core across 141 topics, plus 48 stress cases), with 97 held-out cases. References remain `authored_unreviewed`; prepared counts are not tested or passed counts. Image input, the full corpus run, learner testing, and public deployment remain pending.

Original sample: `/Users/justingao/Documents/Codex/2026-11-11/n/outputs/math-quest-demo.html`.

Product and coverage specifications are in `../docs/superpowers/specs/2026-11-16-math-play-lab-*`; the implementation plan is in `../docs/superpowers/plans/2026-11-16-math-play-lab-product-v1.md`.
