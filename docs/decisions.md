# Design decisions

The significant choices behind GateX, with the reasons and what each gives you. Each is short on purpose. Where the PDF decided
something, the decision says so.

| # | Decision |
|---|---|
| [1](#adr-1-level-1-only-no-auto-fix) | Level 1 only: GateX evaluates, you fix |
| [2](#adr-2-no-agent-framework) | No agent framework; a fixed flow in plain code |
| [3](#adr-3-code-scores-the-countable-dimensions) | Code scores the countable dimensions |
| [4](#adr-4-the-verdict-is-a-function-not-a-model-output) | The verdict is a function, not a model output |
| [5](#adr-5-a-claim-without-a-real-cell-is-discarded) | A claim without a real cell is discarded |
| [6](#adr-6-the-evaluation-is-immutable-the-report-is-derived) | The evaluation is immutable; the report is derived |
| [7](#adr-7-a-custom-read-only-xlsx-reader) | A custom read-only .xlsx reader |
| [8](#adr-8-postgres-with-plain-sql-and-an-in-memory-twin-for-tests) | Postgres with plain SQL, and an in-memory twin for tests |
| [9](#adr-9-model-providers-over-plain-https) | Model providers over plain HTTPS |
| [10](#adr-10-evaluations-run-in-process) | Evaluations run in-process |
| [11](#adr-11-gatex-keeps-going-and-says-what-happened) | GateX keeps going and says what happened |
| [12](#adr-12-prompts-are-versioned-artifacts) | Prompts are versioned artifacts |
| [13](#adr-13-a-scripted-mock-provider-is-part-of-the-product) | A scripted mock provider is part of the product |
| [14](#adr-14-everything-the-agent-needs-lives-in-one-folder) | Everything the agent needs lives in one folder |
| [15](#adr-15-excel-scorecards-and-an-extra-instructions-box) | Excel scorecards and an extra-instructions box |
| [16](#adr-16-fallback-models-keep-the-family) | Fallback models keep the family |
| [17](#adr-17-fully-automatic-scoring-no-person-in-the-loop) | Fully automatic scoring, no person in the loop |
| [18](#adr-18-one-colour-rule-for-every-score-decided-by-the-score-alone) | One colour rule for every score, decided by the score alone |

---

## ADR-1: Level 1 only, no auto-fix

**Context.** The PDF's principle is *"you cannot automate what you have not made repeatable"*. Generator agents are
Level 2, to be earned with evidence from Level 1. The mentor confirmed in writing: the agent should not touch the
schema, and auto-fix is not required at Level 1.

**Decision.** GateX only evaluates. It reports; the author fixes the file and checks it again. Every round is scored independently.

**Consequences.** GateX never grades its own work, which is the independence safeguard. The loop to green is: check, fix, check again, with
each round kept so you can see the progress.

## ADR-2: No agent framework

**Context.** Frameworks such as LangGraph suit agents that decide their own next step. Here the flow is fixed:
freeze, count, rate, consolidate, decide, report. The PDF's rules (blind rating, evidence, lower score stands,
read-only) must be enforced exactly and tested.

**Decision.** Plain TypeScript. One function calls the Examiners in parallel, validates each reply, calls the
Final reviewer, then applies the rule. It is about the same size as a graph definition would be.

**Consequences.** Every rule is a function with a test; nothing sits between the rule and the code. If Level 2
generator agents are added later, a framework can sit **on top of** the evaluator without changing it.

## ADR-3: Code scores the countable dimensions

**Context.** The PDF has Examiners score every dimension. Many dimensions are counting questions: "how many nodes have a
definition?", "are any path ids duplicated?". A model asked to count 169 rows is slow, costs money and sometimes
miscounts, and three models may disagree about a plain fact.

**Decision.** A scorecard marks each dimension `code`, `raters` or `human`. Code dimensions are scored by built-in
checks that return an exact pass ratio, mapped to 0-5 by bands. Examiners score only judgement dimensions, and are not
shown the code results (so they stay blind).

**Consequences.** Exact, free, repeatable scores for everything countable, and smaller Examiner prompts. This is the
main place the build goes beyond the PDF's wording. It is recorded in [pdf-traceability.md](pdf-traceability.md).

## ADR-4: The verdict is a function, not a model output

**Context.** The PDF fixes the decision rule (p.12). A model can be persuaded; a function cannot.

**Decision.** `agent/verdict.ts` computes green, amber or red from the score. No model ever writes or alters a verdict. An optional
override can be recorded with a reason, and both are kept.

**Consequences.** Verdicts are reproducible and testable with a table of cases. Serious issues are listed first as "Needs attention" so a
high score cannot hide them (see ADR-18). Scores are compared unrounded and shown rounded down, so 74.96 never displays as 75.

## ADR-5: A claim without a real cell is discarded

**Context.** "Fluent but wrong" is the PDF's first risk: Examiners reward well-written text. The PDF requires every
score and finding to cite a location, and unsupported claims to be discarded.

**Decision.** A citation counts only if the sheet is part of this evaluation, the cell exists, and any quoted text
really appears in that cell. Otherwise the score or finding is dropped and counted in the report.

**Consequences.** A model cannot score what it did not read, and text planted in a document cannot fabricate
evidence. The set-aside count is shown in the report, so you can see how much of each model's output was backed by the file.

## ADR-6: The evaluation is immutable; the report is derived

**Context.** An optional override can be recorded after GateX has finished. GateX's own scores must stay as they were, or the audit trail loses its value.

**Decision.** The stored result of a run (the *core*) never changes. The verdict, the "not in the file" list and the
path to green are worked out from the core (plus any override) each time a report is read.

**Consequences.** Any report can be re-derived, an override cannot change GateX's own record, and it sits beside GateX's verdict. Reading a
report costs a small recomputation.

## ADR-7: A custom read-only .xlsx reader

**Context.** Real files come from many tools, and the general spreadsheet library (ExcelJS) could not open the Talentra workbook because of a drawing
part of the file.

**Decision.** A small reader (`excel/xlsxReader.ts`, about 150 lines) unzips the file and reads cell values from
the XML directly. It ignores drawings, charts, images and styles, and it only reads. ExcelJS is still used to
*write* the report, where its input is under our control.

**Consequences.** It opens files the library cannot, and gives a small attack surface (nothing is executed).
Formulas that were never calculated are shown as their formula text.

## ADR-8: Postgres with plain SQL, and an in-memory twin for tests

**Context.** The data must be durable and easy to inspect (the requester wants to see it in a database). Docker was
the stated way to run it. But tests and a quick demo should not need a server.

**Decision.** Postgres 16, `pg` driver, plain SQL migrations, no ORM. `pg-mem` (an in-memory Postgres) runs the
**same SQL** when no `DATABASE_URL` is set. The API tests run on both, and also on a real Postgres through
`TEST_DATABASE_URL`.

**Consequences.** One code path for storage, inspectable with any client. Only features `pg-mem` supports are used,
which keeps queries simple. Real Postgres remains the source of truth, and the same test suite has been run against it.

## ADR-9: Model providers over plain HTTPS

**Context.** Several kinds of model service were requested. Many share the OpenAI chat format; others have their own.

**Decision.** Small adapters over `fetch`: one OpenAI-compatible (configured by base URL and key variable), plus one for each other API shape. A shared HTTP helper retries rate limits and 5xx errors with back-off, honouring `Retry-After`. No vendor SDKs.

**Consequences.** Adding any OpenAI-compatible provider is a config entry. Few dependencies. Keys travel in headers
only. Replies are validated by schema instead of relying on any one service's special modes, which works for every service.

## ADR-10: Evaluations run in-process

**Context.** An evaluation takes tens of seconds to minutes. A queue and workers would add infrastructure for a
workload of a few evaluations at a time.

**Decision.** `POST /api/runs` returns `202` and the evaluation continues in the same process; progress is written to
the database as it goes, and the dashboard polls. A run left unfinished by a crash is marked failed on the next start.

**Consequences.** Simple to run and reason about. A run that was still going when the server stopped is closed with a clear message on the next start. If load
grows, `EvaluationService.execute` is the one seam to move onto a queue; the engine is unchanged.

## ADR-11: GateX keeps going and says what happened

**Context.** Four model calls per check means a busy service or an oddly shaped reply will happen sometimes.

**Decision.** Each situation has a defined, visible outcome: a repair attempt for a reply in the wrong shape; an Examiner that cannot answer is
left out and the gap is flagged; an unavailable Final reviewer falls back to the lower mark with a flag; a check with nothing to read becomes an
unscored question with a HIGH issue; and a check where **no Examiner can answer** reports why instead of showing a score.

**Consequences.** The report always tells the truth about how it was produced ("Run notes"). GateX never invents confidence, and never shows a
misleading red from missing data.

## ADR-12: Prompts are versioned artifacts

**Context.** The PDF requires prompts to be frozen and versioned "like any other artifact", and results to be
reproducible. Changing a prompt changes scores.

**Decision.** Prompts live in `agent/prompts/` with a `PROMPT_VERSION`. Each run records the version and a hash of the
exact prompt each model received, with the full prompt and raw reply.

**Consequences.** Any score can be traced to the exact words that produced it. Changing a prompt requires bumping the
version, so you can always see which prompts produced a score.

## ADR-13: A scripted mock provider is part of the product

**Context.** The safeguards matter most when a model answers in an unusual way (wrong shape, no evidence, unavailable). Live models cost money, vary
from run to run, and cannot be asked to answer badly on demand.

**Decision.** A mock provider reads the real prompt and answers by persona (`mock-strict`, `mock-lenient`,
`mock-garbage`, `mock-nocite`, `mock-alarmist`, `mock-down` ...). It drives the tests and the no-key demo, which the
sidebar labels "Mock models (demo)".

**Consequences.** The complete pipeline, including prompt building, parsing, evidence checking and the Final reviewer's step, is
tested in a repeatable way. The test library measures real runs.

## ADR-14: Everything the agent needs lives in one folder

**Context.** The engine's code was first spread across `eval/`, `checks/` and `prompts/`. Someone asking "where is the
engine?" had no single answer.

**Decision.** Everything that makes up the GateX engine is in `server/src/agent/`, with a single public entry,
`agent/index.ts`. It imports only `llm/`, `excel/` and `util/`; the API, database and report layers import the
engine, never the reverse.

**Consequences.** One folder to read, review and test; the engine runs from the command line without a server. The
dependency rule is documented in [architecture.md](architecture.md#dependency-rules).

## ADR-15: Excel scorecards and an extra-instructions box

**Context.** The lead asked for scoring that works from an Excel file and a prompt. A scorecard written only as free text
cannot give repeatable weighted scores, critical gates, a rule-based verdict or a path to green, and the PDF requires a
frozen, hashed, machine-readable scorecard (p.13, p.17). Authors also find a spreadsheet easier than YAML.

**Decision.** Two additions, neither of which weakens the structured scorecard. (1) A scorecard can be written in **Excel**
(three sheets: settings, sheets to read, dimensions). It is read into the same raw object as the YAML format and goes through the
same validation and hashing, so an Excel and a YAML scorecard with the same content have the same hash (there is a test for
this, and a converter in both directions). Mistakes are reported with the sheet and row. (2) An optional **extra instructions**
box. Its text goes to every Examiner and the Final reviewer in identical words, is saved with the run and hashed in the report header,
and the prompt rules state that it can steer what to look at but never change the scale, the evidence rule, the output format, or the score.

**Consequences.** People can write scorecards in the tool they know, and add context ("treat column X as out of scope") without
touching the scorecard. The PDF's Examiner pattern says "scorecard, artifact, sources, nothing else", so the instructions are a
documented extension; leaving the box empty follows the PDF exactly. The report header shows the instructions beside the score, so two runs are easy to compare.
Writing scorecards stays with people; the PDF places generating them at Level 2.

## ADR-16: Fallback models keep the family

**Context.** Model services are sometimes busy, over quota or limited in prompt size, and with only three Examiners each one matters. Simply swapping in
any other model would break the PDF's independence rule (three different families).

**Decision.** Any Examiner or the Final reviewer may list `fallbacks`. If the model fails for any reason, the fallbacks are tried in order. A fallback
answers **as the same participant and counts as the same family**, must be on the approved list (it receives the documents), and is skipped with a
warning if it has no key. The report header names the models that really answered, the run notes say what failed first, and progress shows the
model currently answering. The pre-submit size check counts an Examiner as able to take the prompt if its model or any fallback can.

**Consequences.** One service's busy hour no longer removes an Examiner, and three different families are still guaranteed. The report says when a
fallback answered. A fallback from a different service that hosts the same family is a strong option when a plan's limits are the reason.

## ADR-17: Fully automatic scoring, no person in the loop

**Context.** A scorecard written for people (the GS-1 workbook) used to be imported as a draft that a person compared and approved before anything
could run, and every question needing outside evidence (an interview, a sign-off, a second run) became a "needs a person" item. The owner asked
for GateX to score everything itself, against the scorecard as it is, so every submission gives a complete number.

**Decision.**
- **No approval step.** Every scorecard is frozen by its hash at submission; `frozen` and `approval` in the file are informational. A scorecard in any
  layout is accepted by `POST /api/runs` and the CLI: one not in the app's format is converted by one model call, checked by code (weights, gates,
  sheet and column names, size, counts tried on the real file against the scorecard's own N and D) and used straight away.
- **Conversions are cached** (`data/scorecards/<key>.json`, keyed by the scorecard's bytes, the judged file's sheet names and `IMPORT_VERSION`), so every
  iteration of a project is marked against the identical scorecard (same hash) and the model is called once per scorecard. Concurrent submissions
  share one conversion; a damaged or outdated cache file is converted again.
- **No question is held for a person.** `measured_by: human` (and an "unmeasurable" criterion) is marked by the Examiners from what the file records,
  on the standard 0-5 scale unless it has anchors. Only when the Examiners find nothing at all does `unmeasured` apply: `skip` (default) or `zero`.
- **Removed:** the human-evidence endpoint and form, the "a person must supply" verdict reason and path step, the provisional-scorecard banner, and the
  dashboard's override button (the override API stays for scripts and is never required).
- **Size safety net.** A converted question names the columns it needs; code checks them against the real headers and, if a question still reads more
  than the tightest Examiner can take, cuts its widest sheets to the id column plus the columns that share words with the question.

**Consequences.** Every submission produces a complete, reproducible score with nobody involved. This is a deliberate choice that differs from the
PDF's Level 1 ("people approve", human evidence gates E1-E3). The code checks above, the "Worth knowing" list on the Convert page and the scorecard's
source line in every report show how a converted scorecard was understood. A conversion is made once per scorecard and reused, so every round of
a project uses the same one.


## ADR-18: One colour rule for every score, decided by the score alone

**Decision (24 Oct 2026, the owner's instruction).** Below 60 is red, 60 to 74 is amber, and 75 to 100 is light green. This is one fixed rule in
`shared/src/types.ts` (`SCORE_BANDS`, `bandOf`) used by the verdict, the path to green, the history trend, the report in all four formats and the dashboard. No scorecard can change it:
the `thresholds` a scorecard states (GS-1 says 90 and 75) are ignored. The per-question scores (0-5) use the same rule: 3 is 60 and 3.75 is 75.

**What it means.** The colour comes from the score alone. A must-pass question below 4, a high-risk issue, a mark only one Examiner could back and a score built on
a small part of the scorecard are listed at the top of the verdict as "Needs attention" notes, so nothing is hidden. An optional override can still change the colour, with a reason.

**Why.** Many people read these reports without the history behind them. One number with one colour is easy to read and easy to explain.

**Consequences.** This is a deliberate choice that differs from the PDF's decision table (green needs every gate passed and no high-risk issue open). Old runs are
recoloured when their report is opened, because the verdict is worked out then. The "Needs attention" lines, which the report puts first, carry the
detail that the colour leaves out.


## ADR-19: Accuracy target for a labelled run

**Status: Proposed, needs owner sign-off.** Nothing below is in force until the owner accepts it. The table in `docs/development.md` ("The accuracy targets") stays as it is until then.

**Context.** GateX has no agreed line for "accurate enough". The working targets in `docs/development.md` were set by the builders, and the last measured run (Step 2, one labelled run of 24 issues) reached about 50% useful and 38% wrong before the later filters; the latest estimate is about 63% useful and 21 to 26% wrong. Scores of the same file also vary from run to run (Step 2 gave 63.8, 75.2, 80.4, 72.2, and 76 to 81 on one file after the same prompts).

**Proposed decision.** A build is accurate enough to hand over when, on the labelled runs in `data/library` (each issue checked against the real file, by a person or a fresh reviewer):
1. At least 60% of the issues listed are useful (real or partly right).
2. At most 10% of the issues listed are wrong.
3. Two or more runs of the same file and scorecard differ by 8 points or less in the total score.
4. The planted-defect test finds at least 7 of the 8 planted defects (today the code sweep finds all 8; the 7 of 8 line leaves room for one new check that is still being tuned).

**Consequences if accepted.** `docs/development.md` and `npm run release:check` would be changed to these four numbers (the current table says 5 points and all 8). The 8-point spread is wide enough to be met by a three-examiner panel today; the 10% wrong limit is not met yet (about 21 to 26%) and would be the main work left. The labels so far were made by the builders and a fresh reviewer, not by a second person, so the owner may also want a teammate to check about 20 of them before the numbers are used for sign-off.

**Alternatives.** Keep the current table (stricter on spread: 5 points; stricter on recall: 8 of 8). Or require two runs averaged for the score, which lowers spread but doubles cost (about $2 a run).
