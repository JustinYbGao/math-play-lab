# Judge guide — Math Play Lab

Math Play Lab is an AI math learning companion designed for learners of all ages. The feature tour opens with calculus, then explores geometry, algebra, and equal sharing through visible actions and feedback.

1. **Introductory calculus:** explore the difference quotient for f(x) = x² at x = 3, observe secant slopes from both sides, and connect them to a limit of 6.
2. **High school geometry:** connect y² = 8x with its vertex, focus (2, 0), directrix x = −2, and equal distances.
3. **Middle school algebra:** solve 5x − 7 = 18 by changing both sides equally, then substitute x = 5 to check.
4. **Elementary mathematics:** share 24 strawberries among 6 friends and connect equal groups with division.

The v3 video types a sample derivative question into the composer and then explores AI-generated activities. It does not submit a new build request. Provenance for the sharing activity is in `credits.en.md` and `evidence-summary.en.md`.

Try an incorrect answer, read the feedback, correct it, and use Hint or Reset. The accompanying video includes English narration and matching captions; the separate caption file and transcript are included.

## Running the application

Requirements: Node.js 20.20 or later and Chrome/Chromium. From a separately supplied source checkout, run:

```sh
npm install
npm start
```

Open `http://127.0.0.1:4318`. A model key configured on the server is required to generate new activities; never put a model key in the browser. A built-in preview is available without a model key. This submission package does not include credentials or a source checkout, and local addresses are not public demonstration links.

## Evidence and limits

The historical development cohort covers 141 topics, with 79 accepted artifacts after retries and repairs. This is a cumulative result, not a first-attempt success rate or a guarantee for new problems. The locally refined sharing activity is separate from that cohort and does not change the accepted-topic count. Browser checks cover specific paths and rules; they do not prove every interpretation, diagram, or proof. No learner study or accessibility certification is claimed.

The credits identify inherited UGREEN work, current additions, AI assistance, and video provenance.
