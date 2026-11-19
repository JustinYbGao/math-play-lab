# Demonstration evidence

## Feature-tour sources

The v3 feature tour uses previously saved AI-generated activity pages. It starts with the calculus graph, types a sample derivative problem into the composer without submitting it, and then shows calculus, geometry, algebra, and equal sharing. The video edit makes no new model request.

The calculus, geometry, and algebra pages are archived model-generated examples. Their saved HTML and mathematical interaction logic are unchanged for this feature tour; the calculus graph uses a separate reduced-height filming stylesheet. The sharing page is a derived local refinement of an earlier generated page, described below.

## Sharing activity refinement

The original question is: “Share 24 strawberries equally among 6 friends. How many strawberries does each friend get?” The saved AI plan specifies a share of 4 and a multiplication check of 24, with the latter depending on the former.

The original page failed production validation because page-authored game messages overwrote the shared assessment status. Its proposed recovery and invalidation traces also restarted actions that should continue from the current state. A derived copy redirects game messages to a separate accessible region and corrects those continuation traces. The original page and assessment remain unchanged in the archive.

The derived page passed the production browser checker: the complete playthrough passed, both assessment fields were independently tested, two equivalent-input probes passed, and no errors were reported. A separate browser audit verified 16 recorded states, including conservation of 24, invalid-deal rejection, undo, wrong share and total rejection, dependency gating, completion, invalidation after an edit, acceptance of 8/2, and hint/reset behavior. No model request was made for this refinement or its audit.

The local correction is not an unmodified AI response and does not count as an additional accepted topic. The historical 141-topic development cohort remains at 79 accepted artifacts after retries and repairs; 62 were not accepted. Its 450-file protected manifest is unchanged. These counts are cumulative development evidence, not a first-attempt rate or a guarantee for new questions.

## Media checks and limits

The v3 feature-tour export, `video/math-play-lab-feature-tour.en.mp4`, passed full decode at 138.005 seconds and 1920 × 1080 H.264/AAC. All 17 spoken cues passed audio checks and exactly match the captions. SHA-256: `8f422322d1df71d45034dab18f023f17a56b91ffd6d823dc9d94bfecf4442172`. The official capture reported no errors, POSTs, or model API calls.

These checks establish the displayed paths only. They do not certify every possible question, unrestricted symbolic mathematics, learning outcomes, or accessibility compliance. No learner study is claimed.
