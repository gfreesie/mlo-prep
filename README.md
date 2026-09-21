# The Underwriting Desk

Exam prep for the **SAFE MLO National Test with UST** — the licensing exam for
mortgage loan originators.

**Live: https://gfreesie.github.io/mlo-prep/**

Built for someone retaking the exam after a first failed attempt, so it is
designed around diagnosis rather than re-teaching: it measures which of the five
exam domains is actually costing you points, then drills those hardest.

## What it does

- **500 questions**, every one with an explanation of why the answer is right —
  including the calculations, worked through step by step.
- **Timed mock exams** — 120 questions, 190 minutes, sampled at the real
  blueprint weights. Scores scale to the 115 scored questions and are graded
  against the 86-correct pass line.
- **Mastery tracking per domain**, weighted the way the real exam is, with a
  projected score against the 75% pass mark.
- **A missed-question notebook.** Anything you get wrong lands here with the
  right answer and the reasoning, and stays until you answer it correctly twice.
- **A study plan** built from your diagnostic results and fitted to your real
  test date and the hours you can actually give it. It re-sorts itself as your
  scores move, so your weakest domain keeps coming up first.
- **Flashcards and a reference sheet** for the thresholds and timelines the
  exam leans on hardest.

Answer positions are shuffled on every serve, so repeat questions can't be
answered by remembering the letter.

## Exam blueprint

The question bank matches the published domain weights exactly:

| Domain | Weight | Questions |
|---|---:|---:|
| Mortgage Loan Origination Activities | 27% | 135 |
| Federal Mortgage-Related Law | 24% | 120 |
| General Mortgage Knowledge | 20% | 100 |
| Ethics | 18% | 90 |
| Uniform State Content | 11% | 55 |
| | | **500** |

The real test is 120 questions (115 scored, 5 unscored pretest items), 190
minutes, and needs 75% — 86 of 115 — to pass.

## Running it

No build step is needed to try it: open `index.html` in a browser.

To produce the deployable versions:

```bash
npm install
npm run build:pages     # -> docs/  static, what GitHub Pages serves
npm run build           # -> dist/  includes the cross-device sync client
```

## Optional sync backend

`docs/` is a purely static build — progress lives in `localStorage` on that
device, which is all most people need.

There is also an optional Express + SQLite backend (`server/`) that syncs
progress across devices, for self-hosting on a small VPS. It is offline-first:
`localStorage` stays the working copy and an outbox flushes when the server is
reachable, so the app behaves identically with no signal. Attempts are an
append-only log with client-generated ids, and the server replays that log to
derive mastery — so the client and server can never disagree about the rules.

See [DEPLOY.md](DEPLOY.md). GitHub Pages cannot run it; it needs a real server.

## Layout

```
index.html        the whole app - markup, styles and logic in one file
bank-*.js         500 questions + 52 flashcards
build.mjs         wraps index.html into a standalone document
docs/             static build (GitHub Pages serves this)
sync.js           offline-first sync client, self-hosted build only
server/           Express + SQLite API
deploy/           provisioning and deploy scripts for a VPS
```

Source files are kept pure ASCII on purpose — raw UTF-8 mojibakes when served
without a charset declaration, so string literals use `\uXXXX` escapes. The
build fails if a non-ASCII byte gets in.

## Accuracy

Questions were written against current federal rules and 2026 figures — the
$832,750 conforming baseline, 1.75% FHA UFMIP with 0.55% annual MIP, the 2.15%
VA funding fee at first use with nothing down, and the NMLS retake waits.

That said: **this is study material, not legal or compliance advice.** Rules,
thresholds and figures change. Verify anything you intend to rely on against the
CFPB, HUD, the VA, or the NMLS Resource Center directly.

## License

MIT — see [LICENSE](LICENSE).
