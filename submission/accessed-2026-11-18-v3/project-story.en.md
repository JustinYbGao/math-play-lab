## Inspiration

Math Play Lab began with a simple question: what if a math problem could become something you play with?

Students encountering an abstract idea for the first time, and adults returning to mathematics, can follow a worked solution without seeing why it works. We wanted to give those learners another way to explore: move a point, change a quantity, test an answer, and watch the relationship respond.

Our focus for AccessED is the gap between mathematical notation and understanding. Math Play Lab is an AI math learning companion designed for learners of all ages, with a scope from elementary mathematics through introductory calculus.

## What it does

A learner enters a written math problem. AI plans an activity and builds an interactive page around it. Learners explore the mathematical relationships, try answers, receive feedback, reveal hints, and reset to try again. The original question remains available alongside the activity.

Our feature tour demonstrates four kinds of exploration:

- **Calculus:** move a point along a curve, observe secant slopes from both sides, build a difference quotient, and find its limit.
- **Geometry:** connect a parabola's equation to its focus, directrix, and equal-distance relationships.
- **Algebra:** apply operations to both sides of an equation and verify the solution by substitution.
- **Elementary mathematics:** distribute quantities into equal groups and connect the result to division and multiplication.

For example, a worked solution can state that the derivative of x squared at x = 3 is 6. In our activity, the learner moves a second point, observes slopes approaching 6 from both sides, and builds the quotient that explains the result. The formula becomes a relationship they can investigate.

## How we built it

The interface uses JavaScript, HTML, and CSS, with a Node.js backend and model access through OpenRouter. The generation pipeline creates a structured activity plan, produces an interactive page, and checks it in Chromium with Playwright before delivery. It can request clarification or attempt a repair when necessary.

Generated activities run in isolated iframes. A shared assessment runtime handles supported answer rules, exact rational comparisons, and dependencies between steps. Independent browser probes supplement the model's proposed interaction tests. Editing a watched value clears the confirmations that depend on it, so feedback follows the learner's current state.

## Challenges we ran into

The hardest part was making interaction and mathematical feedback agree. An activity could look convincing while rejecting an equivalent fraction, accepting an incorrect answer, or keeping a completion badge after an input changed.

We addressed these problems with exact arithmetic, shared assessment state, browser playthroughs, and independently authored checks. We also learned to separate page-rendering success from evidence that the mathematical interaction works.

## Accomplishments that we're proud of

We built a working question-to-activity pipeline and an English interface centered on the learner's own problem. The demo shows mathematical actions across elementary math, algebra, geometry, and introductory calculus, with feedback, hints, and reset.

We created a 141-topic evaluation corpus. After iteration and repairs, 79 topics had accepted activity artifacts. That cumulative development evidence helps us identify where generation needs more work. We also produced a narrated feature tour with matching English captions.

## What we learned

A useful math interaction gives the learner something meaningful to change and a relationship to investigate. Feedback must remain correct as the learner explores. Designing the activity, its assessment, and its tests together was as important as generating the page itself.

## What's next for Math Play Lab

Our next steps are testing with learners and educators, expanding reliable coverage, and improving mathematical diagrams and explanations. We also want to make it easier for teachers to review activities before using them in a lesson.

## Event contribution and credits

Earlier UGREEN work supplied the initial concept and a small prebuilt sample. This iteration adds the general text-input product, online generation pipeline, clarification and repair flow, isolated player, usage controls, evaluation corpus, shared assessment, and independent browser probes.

Yubin Gao directed the product concept and priorities. Development used AI assistance: Codex coordinated implementation and audits, and Luna coding agents implemented changes. The feature tour uses AI-generated activities; the sharing activity includes a local refinement documented in the accompanying credits and evidence summary. Examples are synthetic, and learner outcomes have not yet been measured.
