# How GateX follows the Agentic Roadmap

This page maps GateX to *Talencia Global · Data-Driven Development · Agentic Roadmap* (v1.0, October 2026, 22 pages). GateX is the
**Level 1 evaluator** (pages 9-19): it marks every deliverable against its scorecard, decides green, amber or red, and shows the way to green.

Status values: **Done** (built and tested), **GateX choice** (a deliberate choice that differs from the PDF's wording, with the reason),
**Process** (an organisational step, not software).

## Contents

- [Summary](#summary)
- [Principles (p.5)](#principles-p5)
- [Level 1 architecture and the 3 + 1 model (p.9-10)](#level-1-architecture-and-the-3--1-model-p9-10)
- [The evaluation report (p.11)](#the-evaluation-report-p11)
- [Decisions and routing (p.12)](#decisions-and-routing-p12)
- [Safeguards (p.13)](#safeguards-p13)
- [Calibration data (p.14)](#calibration-data-p14)
- [Build plan: the components (p.16)](#build-plan-the-components-p16)
- [Formats and prompts (p.17)](#formats-and-prompts-p17)
- [Getting started (p.19)](#getting-started-p19)
- [Risks and their controls (p.21)](#risks-and-their-controls-p21)
- [Where GateX goes beyond the PDF](#where-gatex-goes-beyond-the-pdf)

## Summary

| Area | Status |
|---|---|
| The engine: orchestrator, Examiners 1-3, Final reviewer, decision rule | Done |
| The eight-section report (PDF, Excel and Markdown, with charts in the PDF) | Done |
| All eight safeguards | Done |
| Run log and audit trail | Done |
| Scorecard format, Examiner and Final reviewer prompts | Done |
| Score trend across rounds | Done (project history) |
| Gate tracker: one board of D1-D4 for every step (p.16, p.18) | Done (Status board) |
| Overrides with a written reason | Done |

## Principles (p.5)

| # | Principle | Status | Where |
|---|---|---|---|
| 01 | Proven before automated | Process | Applies to when to adopt, not to the code |
| 02 | Evaluate before generate | Done | GateX only evaluates: it never writes or changes the work |
| 03 | Independent by design | Done | `llm/roster.ts` requires three distinct model families; a fallback model answers as the same Examiner and counts as the same family, so this holds when a model is busy (`agent/fallback.ts`); GateX never edits or runs in the author's session |
| 04 | Evidence, not opinion | Done | `agent/evidence.ts`: a mark or issue must cite a real cell; otherwise it is set aside |
| 05 | People own the judgement | GateX choice | Scoring is fully automatic by the owner's decision ([ADR-17](decisions.md#adr-17-fully-automatic-scoring-no-person-in-the-loop)): nothing waits for approval. People decide what to fix, and an optional override API records a different verdict with a reason |
| 06 | Everything is logged | Done | Prompts, raw replies, models, hashes, marks, set-aside claims and overrides are stored (`model_calls`, `runs.run_log`, ...) |

## Level 1 architecture and the 3 + 1 model (p.9-10)

| PDF requirement | Status | Where | Test |
|---|---|---|---|
| One engine used at both gates (D1 against D2, D3 against D4) | Done | `scorecard.judges` selects the gate; same `evaluate()` | `orchestrator.test.ts` › the output gate |
| Artifact under test, frozen scorecard (hashed), source documents | Done | File, scorecard and `sources` text field; both hashes in the report | › writes a header that proves what was evaluated |
| Orchestrator freezes inputs and sends to the Examiners | Done | `agent/orchestrator.ts` | › Freeze |
| Three Examiners, different model families, blind | Done | `llm/roster.ts`, one shared prompt | › Independence, › keeps raters blind |
| Examiners mark every question 0-5 against the anchors | Done | `agent/rater.ts`, `raterSchema.ts` | `orchestrator.test.ts` |
| Examiners cite the location for every mark and issue | Done | `agent/evidence.ts` | `evidence.test.ts` |
| Issues carry a severity (high, medium, low) | Done | `agent/findings.ts`, Examiner issues | |
| An Examiner marks a question NOT MEASURABLE | Done | `not_measurable` in the reply; the question is left out of the score (or 0) and listed as "Not in the file" | › treats a dimension every rater declines as not measurable |
| The Final reviewer reconciles, and does not mark from scratch | Done | `agent/consolidate.ts`; code limits it to the Examiners' range | › refuses a consolidator score outside the range |
| Agree within one point: take the evidence-backed mark | Done | `consolidate.ts` | |
| Differ by more than one: check claims against the file text | Done | The Final reviewer's mark needs cited, validated evidence | › accepts the consolidator's score only when it cites real evidence |
| Unresolved: the lower mark stands (now the median, the lower middle on ties) | Done | `lower_stands` | › keeps the median mark and flags it |
| Merge repeated issues, apply the decision rule, write the report | Done | `consolidate.ts`, `verdict.ts`, `report/` | |
| Examiner spread reported per question | Done | Report sections 3 and 6 | `report.test.ts` |

## The evaluation report (p.11)

| Section | Status | Where |
|---|---|---|
| 1 Header: file id and hash, scorecard version and hash, Examiners and models, date and run id | Done | `report.header` |
| 2 Verdict: weighted score, colour, result of each must-pass question | Done | `report.verdict` |
| 3 Question scores: each Examiner, final, spread | Done | `report.dimensions` |
| 4 Strengths, with evidence | Done | `report.strengths` |
| 5 Gaps and issues: id, severity, question, location, fix, stage to return to | Done | `report.findings` |
| 6 Examiner agreement: disagreements and how they were settled | Done | `report.agreement` |
| 7 Not in the file: questions the file holds nothing for | Done | `report.notMeasurable` |
| 8 Path to green: smallest set of fixes in priority order | Done | `report.pathToGreen`, `agent/pathToGreen.ts` |
| Delivered as a PDF with charts, a workbook and readable Markdown | Done | `report/` |
| High risk: listed first and fixed first | GateX choice ([ADR-18](decisions.md#adr-18-one-colour-rule-for-every-score-decided-by-the-score-alone)): listed first as "Needs attention"; the colour comes from the score alone | `agent/verdict.ts`, `verdict.test.ts` › things that need attention |
| Medium and Low issues | Done | Shown in order of severity |

## Decisions and routing (p.12)

| PDF requirement | Status | Where |
|---|---|---|
| Green, amber and red from the score | GateX choice: green is 75 or more, amber is 60 to 74, red is below 60. Must-pass questions and high-risk issues are "Needs attention" notes, shown first | `agent/verdict.ts`, `verdict.test.ts` |
| Questions only a person could answer | GateX choice ([ADR-17](decisions.md#adr-17-fully-automatic-scoring-no-person-in-the-loop)): the Examiners mark what the file records about them | `scorecard.test.ts`, `verdict.test.ts` |
| A person may override up or down, recording why | Done | `POST /api/runs/:id/override`; reason required; GateX's own verdict is kept |
| Every run is kept with inputs and report; score trend visible | Done | Postgres; project history page |
| Amber: fix, check, run again | Done | Each new check is a new round of the project |
| Red: back to Discover or Define | Done | `return_to` on every issue; stated on the verdict |

The colour rule is the same for every scorecard: below 60 red, 60 to 74 amber, 75 and above green ([ADR-18](decisions.md#adr-18-one-colour-rule-for-every-score-decided-by-the-score-alone)). The PDF proposed 90 and 75 as "starting values for the team to confirm", and the team chose these.

## Safeguards (p.13)

| Safeguard | Status | Where | Test |
|---|---|---|---|
| Independence: never in the author's session; different families | Done | `llm/roster.ts` | › Independence |
| Freeze: file and scorecard fixed and hashed before marking | Done | `orchestrator.ts` hashes first and last | › Freeze |
| Blind marking | Done | One shared prompt, no marks in it | › keeps raters blind |
| Evidence: unsupported claims are set aside | Done | `evidence.ts`, `rater.ts` | › discards scores that cite no evidence |
| Lower mark stands (median of the marks, lower middle on ties) | Done | `consolidate.ts`, `finalMark.ts` | › keeps the median mark… |
| Read-only: never edits the file | Done | Reader only reads; file hashed after | › never touches the workbook |
| Reproducible: prompts, model versions, settings logged | Done | `model_calls`, `run_log`, `PROMPT_VERSION` | `api.test.ts` |
| Confidentiality: only approved models receive project documents | Done | `approved` list in `models.json` | › Confidentiality |

## Calibration data (p.14)

GateX stores what calibration needs: marks per question and per Examiner, colours, overrides and the full run log of every check. The test
library (`/library` in the dashboard, with `npm run reliability` and `npm run planted`) measures how often each model family's issues were right
and how many planted mistakes GateX finds.

| Measure | Where GateX records it |
|---|---|
| Examiner spread, per question per run | `dimension_scores.spread` |
| Cost and time per check | Tokens and timings in `runs.run_log` |
| How often each family's issues were right | `npm run reliability`, saved to `data/library/reliability.json` |
| Planted mistakes found | `npm run planted`, shown on the Test library page |
| Score within 1 point, same colour, false green, false red, same colour when run again, wrong issues, each against the Roadmap's target | The **Accuracy** page (`/accuracy`, `GET /api/accuracy`, `npm run accuracy`): people's marks and ticks kept apart from AI stand-ins, with the sample size and "not enough data" instead of a verdict on a thin sample |
| Shadow mode: a person scores alongside GateX | "Compare with a person" on every finished check (`POST /api/runs/:id/human-review`), stored in `human_reviews`; the gap per question is shown side by side |

## Build plan: the components (p.16)

| Component | Status | Where |
|---|---|---|
| Formats: machine-readable scorecards and reports with version and hash | Done | Scorecard YAML/JSON/Excel with version and hash; report as JSON |
| Examiner prompt | Done | `agent/prompts/rater.ts` (versioned) |
| Final reviewer prompt | Done | `agent/prompts/consolidator.ts` |
| Orchestrator | Done | `agent/orchestrator.ts` |
| Report writer: PDF, workbook and readable summary | Done | `report/` |
| Run log | Done | Postgres: `model_calls`, `runs.run_log` |
| Gate tracker | Done | `shared/src/board.ts`, `GET /api/board`, `web/src/pages/BoardPage.tsx` (Status board) |

## Formats and prompts (p.17)

Scorecards can also be written in **Excel**; that file is converted to exactly the same validated structure and hash, so the
machine-readable, frozen, hashed scorecard the PDF asks for is unchanged (see
[scorecard-reference.md](scorecard-reference.md#writing-a-scorecard-in-excel)). A scorecard in any other layout is converted once and reused
([details](scorecard-reference.md#scorecards-in-any-layout)).

The scorecard example on page 17 is supported with **one addition**: an `artifact:` block that says which sheets
GateX reads (the PDF's example does not need it because it shows no workbook). Everything else is accepted as the PDF
writes it: `thresholds`, `critical`, `anchors` keyed 0-5, `measurable_by_agent: false`, and `judges: D1 schema · Step 01`. The Examiner and Final reviewer
prompt patterns are implemented as the starting point the PDF describes, versioned and hashed. Details in [scorecard-reference.md](scorecard-reference.md).

## Getting started (p.19)

| Move | Status |
|---|---|
| 1 Agree the formats | Done (this build proposes them) |
| 2 Freeze Phase 1 scorecards | Done in code: every scorecard is frozen by its hash at submission; sample scorecards are provided |
| 4 Build the evaluator | Done |
| 3, 5, 6 Calibration set, shadow mode, switching on the gate | Process: steps the team takes with real deliverables |

## Risks and their controls (p.21)

| Risk | Control in the PDF | Control in GateX |
|---|---|---|
| Fluent but wrong | Evidence citation required | The evidence gate (`evidence.ts`): every mark and issue must point at a real cell |
| Shared blind spots | Different model families | Three different families are required, and fallbacks keep the family |
| Model drift | Model versions logged | Models and the prompt version are recorded in every report |
| Over-trust | Review of amber and red | Marks only one Examiner backed are labelled and listed under "Needs attention"; the report shows the path to green |
| Confidential data | Approved models only | The approved list, enforced before anything is sent. See [security.md](security.md) |
| Cost and latency | Cost tracked per step; evaluate small sections first | Per-run tokens and timings are stored, and sectioned scoring (`reads`) keeps prompts small |

## Where GateX goes beyond the PDF

Choices made where the PDF is silent or where a stricter rule protects the PDF's intent. Reasons in [decisions.md](decisions.md).

| Choice | Why |
|---|---|
| Countable questions are scored by code, not by the Examiners | Exact, free and repeatable |
| A question with no evidence-backed mark counts as 0 and is flagged | A missing mark never helps the score |
| A question the file holds nothing for is left out of the weighted score (or 0 with `unmeasured: zero`) | Every submission gets a complete score (ADR-17) |
| A check where no Examiner can answer reports why instead of showing a score | A report built on nothing would show a misleading red |
| Scores shown rounded down; compared unrounded | 74.96 is never displayed as 75 |
| An optional **extra instructions** input is given to the Examiners and the Final reviewer (the PDF's pattern lists the scorecard, the file and the sources) | Requested by the lead (an Excel scorecard plus a prompt box). It is identical for all Examiners so blind marking holds, is saved with the run and hashed in the report header, and the prompt rules say it can never change the scale, the evidence rule or the mark. Leave it empty to follow the PDF exactly |
