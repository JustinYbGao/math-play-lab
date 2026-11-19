# Devpost 可直接粘贴的提交稿

使用方法：每个英文字段下的正文可直接复制。中文说明不用粘进表单。

## Project name

Math Play Lab

## Elevator pitch / Project tagline

An AI math learning companion for all ages. Turn problems into playable experiences with interactive visuals, guided hints, and instant feedback—from elementary math to introductory calculus.

中文说明：191 个字符，包含空格和标点；按当前表单的 200 字符上限准备。

## Built with

JavaScript, HTML5, CSS3, Node.js, OpenRouter, Claude, Playwright, Chromium

中文说明：按表单可用标签逐项选择，共 8 个。

## Project story

从下方 Inspiration 开始，复制至 Event contribution and credits 结束。若页面提供多个分栏，则按同名标题分别粘贴。

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

---

以下为补充字段的独立回答，按表单实际出现的问题使用。

## Who is it for, and what barrier does it address?

Math Play Lab is designed for learners of all ages, including students encountering abstract mathematics and adults revisiting it. It addresses the gap between reading a symbolic solution and understanding the quantities, shapes, and relationships behind it. Interactive actions and immediate feedback give learners another way to explore a concept, from elementary mathematics through introductory calculus.

## What did you build during the hackathon?

Building on an earlier UGREEN concept and a small prebuilt sample, this iteration adds a general text-problem composer, online AI planning and generation, clarification and bounded repair, an isolated activity player, usage controls, a broad evaluation corpus, shared assessment state, independent browser probes, and an English presentation layer.

## How did you use AI?

The product uses AI through OpenRouter to plan and generate interactive math activities. Development also used AI coding assistants: Codex coordinated implementation and audits, while Luna coding agents implemented changes. Human direction came from Yubin Gao. Generated activities were exercised through browser tests and separate mathematical checks; detailed provenance is included in the credits and evidence summary.

## Contributor

Yubin Gao

Contribution: Product concept, requirements, interaction-design direction, and hackathon presentation, with implementation and testing support from AI coding assistants.

中文说明：目前仅列出已确认的成员。居住国家按本人实际情况填写；学生与年龄条件此前已确认。

## Thumbnail and gallery

封面推荐使用 `screenshots/devpost-thumbnail-1500x1000.png`，1500 × 1000，符合官方建议的 3:2 比例。

建议画廊顺序：

1. `screenshots/00-all-ages-opening.png` — Math learning for every age: an interactive calculus exploration.
2. `screenshots/02-question.png` — Start with your own math question.
3. `screenshots/calculus-graph.png` — Move a point and watch secant slopes approach the derivative.
4. `screenshots/algebra.png` — Keep both sides balanced and verify the solution.
5. `screenshots/geometry.png` — Connect a parabola to its focus, directrix, and equal distances.
6. `screenshots/sharing-groups.png` — Explore division through equal groups.

## Video demo link

上传 `video/math-play-lab-feature-tour.en.mp4` 后，填写实际获得的公开视频链接。配套字幕为 `captions.en.srt`，视频标题与简介见 `video-upload.en.md`。视频链接待上传后填写。

## Try it out / Source code

填写实际可访问的演示地址或公开代码仓库地址。当前提交材料没有已确认的公开部署或仓库链接；本机的 localhost 和文件路径不能作为评委访问链接。

## Field references

- [Devpost 字段与素材要求](https://help.devpost.com/article/126-know-your-submission-steps)
- [本比赛要求](https://accessed-hacks.devpost.com/)
