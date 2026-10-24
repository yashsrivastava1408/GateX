# The GateX engine

> **Where is the engine?** In one folder: [`server/src/agent/`](../server/src/agent/).
> The entry point is [`orchestrator.ts`](../server/src/agent/orchestrator.ts), function `evaluate()`.
> The rest of the application reaches it only through [`agent/index.ts`](../server/src/agent/index.ts).

This page explains what GateX does with your file, step by step, and which file does each part. (The folder is still called `agent`.) It is the
Level 1 evaluator from the *Talencia Global · Data-Driven Development · Agentic Roadmap* (pages 9-14). For the whole system around it, see
[architecture.md](architecture.md).

---

## 1. What the engine does

You give GateX a file (a schema or an output document) and the scorecard that says how to judge it. GateX marks every question in the
scorecard, decides **green, amber or red**, and explains the result: where each issue is, how to fix it, and the smallest set of fixes that
would turn the result green.

- It **reads** your file and never changes it. The file is fingerprinted (hashed) before and after, so you can see it stayed the same.
- It **counts** what can be counted in code, so those scores are exact.
- It asks **three AI Examiners** to mark the rest independently, and a **Final reviewer** to compare their marks.
- It decides the colour with **a fixed rule** (a function), never with an AI.
- It follows a **fixed flow**, so every step can be enforced and tested. Your part is to fix the file and check it again.

## 2. The folder

```
server/src/agent/
├── index.ts            public API: evaluate(), buildVerdictSection(), buildPathToGreen(), PROMPT_VERSION
├── orchestrator.ts     ★ evaluate(): runs the six steps in order        (start reading here)
│
├── checks/             step 2: exact checks done in code
│   ├── library.ts        the built-in checks
│   ├── index.ts          runs a scorecard's counted questions, share → 0-5 by bands
│   └── types.ts
│
├── prompts/            versioned prompts (PROMPT_VERSION)
│   ├── rater.ts          what each Examiner is told
│   └── consolidator.ts   what the Final reviewer is told
│
├── rater.ts            step 3: runs one Examiner, keeps only evidence-backed claims
├── fallback.ts           backup models: same Examiner, same family, tried in order
├── repeats.ts            the median of one Examiner's repeated runs of a section, and how far they differed
├── sectionPlanner.ts     groups questions into sections by the sheets and columns they `reads`
├── autoReads.ts          gives a question that names no sheets the sheets that match it, when the whole file is large
├── prompt.ts             builds what the Examiners are sent, one prompt per section (shared with the pre-submit check)
├── preflight.ts          before running: can enough Examiners take this prompt?
├── callModel.ts          one model call + the "repair" retry on a reply in the wrong shape
├── raterSchema.ts        the exact shape a model reply must have
├── evidence.ts           "does this cited cell really exist, and does the quote appear in it?"
│
├── consolidate.ts      step 4: the Final reviewer compares three Examiners; code enforces the PDF rules
│
├── verdict.ts          step 5: weighted score, must-pass questions, green / amber / red
├── findings.ts         step 6: issues from code checks, ids, ordering
├── findingCheck.ts     step 6: sets aside issues the file contradicts or that say nothing, and merges repeats
├── presence.ts         step 6: sets aside "the file has no X" issues when a cell really holds X (the Final reviewer finds it, code proves the quote)
├── reliability.ts      step 6: the lone-examiner rule, from what the test library measured
├── sweep.ts            step 2/6: the row-by-row sweep in code (empty cells, repeated ids, dangling references, ids cited but defined nowhere, wrong counts, filler)
├── pathToGreen.ts      step 6: smallest set of fixes that lifts the colour
└── types.ts            internal types (Examiner outcomes, draft issues, call metadata)
```

What the engine **uses** but does not own: `llm/` (talks to the model services), `excel/` (reads
files), `util/` (hashing, small helpers). What it keeps clear of: `api/`, `db/`, `report/`. That boundary
is checked in [architecture.md](architecture.md#dependency-rules).

## 3. Inputs and outputs

| | |
|---|---|
| **In** | The file path · the parsed, frozen **scorecard** (from an Excel, YAML or JSON file, and its hash) · optional **source documents** and optional **extra instructions** (text) · the model **roster** (3 Examiners + a Final reviewer) · a run id, project name and iteration number |
| **Out** | `EvaluationOutput`: the unchanging **core** (header, per-question results, issues, strengths, notes), one record per model call (prompt, raw reply, what was set aside), and a **run log** (models, hashes, timings, tokens) |
| **Side effects** | None on your file. Progress events go to a callback so the dashboard can show live status. The engine itself does not touch the database. |

The verdict, the "not in the file" list and the path to green are **worked out** from the core (plus an override, if one was
recorded through the API) whenever a report is read, by `report/assemble.ts`. The core never changes after the run.

## 4. The six steps

![The six steps](images/02-agent-pipeline.svg)

### Step 1 · Freeze  (`orchestrator.ts`)

Fixes the inputs so the target stays put (PDF p.13).

1. Locks the scorecard by its hash.
2. Checks the roster: three Examiners from **three different model families**, every model on the **approved**
   list, every service has a key (`llm/roster.ts`).
3. Reads the file **once**, takes its SHA-256, and parses it from those bytes.
4. Checks that every sheet the scorecard names exists, and builds the set of sheets an Examiner may cite.
5. At the very end it reads the file again and compares the hash, which proves the file stayed the same.

### Step 2 · Count in code  (`checks/`)

Questions marked `measured_by: code` are counted exactly by a built-in check: "how many of these rows are right?", for example
*"168 of 169 nodes have a definition"*. The pass ratio is turned into a 0-5 mark by the question's `bands`. The checks are listed in the
[scorecard reference](scorecard-reference.md#built-in-checks): `max_value`, `column_filled`, `unique`, `any_filled`, `list_refs_resolve`,
`lists_referenced`, `values_in_list`, `value_not_in`, `row_count_at_least`, and the text checks `text_terms_absent`, `text_terms_present`
and `text_ids_valid` (they count lines of text, so they work on a PDF).

Why code for these: code is exact, free and repeatable, so counted questions get the same score every time. This is the one place the build
goes beyond the PDF's wording (see [decisions.md](decisions.md#adr-3-code-scores-the-countable-dimensions)).

A check that has nothing to read (for example a missing column) marks its question **unscored**, which counts as 0, and a HIGH issue says
why, so a missing mark never helps the score.

### Step 3 · Examiners 1, 2 and 3 mark  (`rater.ts`, `callModel.ts`, `evidence.ts`, `prompts/rater.ts`)

The three Examiners work **at the same time**, each in its own call, and each is sent exactly the same prompt:

- the frozen scorecard (the questions the Examiners mark, with their 0-5 anchors),
- your file: every non-empty cell written with its address, for example `H5="Which product..."`,
- the context sheets and the source documents,
- the **extra instructions** typed at submission, if any. The same words go to every Examiner and to the Final reviewer, and are saved in the
  report header with a hash. The rules say these instructions can steer what to look at and can never change the anchors, the 0-5 scale, the
  evidence rule or the reply format, and cannot say what mark to give.
- the rules: *mark each question 0-5 using only the anchors, cite the cell, never invent, reply in the set format only*.

Nothing else is in the prompt: no other Examiner's mark, no self-assessment by the author, and no code-check results. That is what makes the
marking blind (PDF p.13). The scorecard's `columns` option trims what the Examiners see so the prompt stays compact. A question can also list
`reads`, the sheets and columns it needs. Questions with the same `reads` form a **section**, and each section is its own smaller prompt (see
*Sectioned scoring* in the scorecard reference). The three Examiners work together inside a section, and sections run one after another. A
question that names no sheets would be sent the whole file; when that is more than 30,000 tokens, code gives it the sheets and columns that
best match its words (`autoReads.ts`, deterministic) and writes the choice in the run notes.

Every reply is checked, not just trusted:

| Check | Result |
|---|---|
| The reply has the right shape (valid format, a `dimensions` list) | If not, the Examiner gets up to two repair attempts that say what to fix |
| A mark is a whole number from 0 to 5 | Other marks are set aside |
| A mark cites a cell that exists, with a quote that appears in it (`evidence.ts`) | "No evidence, no mark": a mark without it is set aside |
| An issue names a known question and a real location | Others are set aside |
| The Examiner says `not_measurable` | Counted as "nothing to mark here", not as a score |

Everything set aside is counted and stored per Examiner, so the report shows exactly what was kept. When a model's input limit is known
(`maxInputTokens` in `models.json`), GateX measures the prompt first and tells you in plain words before running.

If a model is busy, its configured **fallback models** are tried in order. A fallback answers as the same Examiner and counts as the same
family, so independence is kept (`agent/fallback.ts`). The report header names the model that really answered. The Final reviewer has
fallbacks too.

### Step 4 · The Final reviewer compares  (`consolidate.ts`, `prompts/consolidator.ts`)

The Final reviewer reads the three checked sets of marks plus the file and proposes, for each question, one mark and a set of merged issues. It
does **not** mark from scratch. Then **code applies the PDF's rules** to whatever it proposed (PDF p.10):

| Situation | Result |
|---|---|
| Every Examiner declined | The question is **not in the file**: left out of the score (`unmeasured: skip`, the default) or counted as 0 (`zero`) |
| No Examiner gave a valid mark, but some were set aside | **Unscored**: counts as 0 and is flagged |
| Only one Examiner gave a valid mark | That mark, flagged as backed by one Examiner |
| Examiners differ by **1 point or less** | The Final reviewer's mark if it lies between the lowest and highest Examiner mark, otherwise the lowest |
| Examiners differ by **more than 1** and the Final reviewer settled it **with cited evidence** | Its mark, if it lies between the lowest and highest Examiner mark (choosing the lowest needs no evidence) |
| Examiners differ by more than 1 and there is no evidence-backed answer | **The lower mark stands** |

So the Final reviewer can never invent a mark outside what the Examiners said, and a big disagreement is only settled with evidence that really
exists in the file. Repeated issues are merged, the highest severity of any member wins (merging never softens an issue), and any issue the
Final reviewer did not merge is kept.

### Step 5 · Decide by a fixed rule  (`verdict.ts`)

A plain function, never an AI (PDF p.12).

```
weighted score = sum(weight × mark) × 100 / (5 × sum of weights counted)
```

Every counted and Examiner-marked question is included (an unscored one counts as 0). A question with nothing in the file to mark is left out,
or counted as 0 with `unmeasured: zero`. A question written for a person (`measured_by: human`) is simply an Examiner question: the Examiners
mark what the file records about it.

![Verdict rule](images/05-verdict-rule.svg)

The colour comes from the score alone ([ADR-18](decisions.md#adr-18-one-colour-rule-for-every-score-decided-by-the-score-alone)): **below 60 red,
60 to 74 amber, 75 to 100 green**, the same rule for every scorecard. A must-pass question below 4, a **HIGH issue** ("Must fix"), a mark only one
Examiner backed (or one the Examiners could not agree on) and a score built on a small part of the scorecard (less than half of the weight, `MINIMUM_COVERAGE` in `verdict.ts`) are
listed first as **Needs attention** notes. They do not change the colour. When the server starts, it refreshes any saved result that an older
version of this rule coloured differently. The score is compared unrounded and shown rounded **down**, so 74.96 is never shown as 75. An
optional override (API only, with a written reason) is shown next to GateX's own verdict, which stays on record.

### Step 6 · Explain  (`findings.ts`, `pathToGreen.ts`)

- **Issues.** Every code check that is not perfect becomes an issue pointing at the failing cells, with a fix taken from the scorecard.
  Examiner issues are added after the Final reviewer. Each gets an id (`F-01`...), a severity, the stage to return to, and who raised it.
  The severities are **HIGH** (shown to people as "Must fix"), **MEDIUM** ("Should fix") and **LOW** ("Nice to fix").
- **Path to green.** Plain arithmetic. First lift every must-pass question below 4, then raise the questions that add the most weighted score
  until the next colour is reached. Each step shows its gain (`4 → 5, +2.6`) and the HIGH issues to fix first.
- **A plain report.** The PDF (with charts), Excel and Markdown reports are built from the core by `report/assemble.ts`.

**The row-by-row sweep** (`sweep.ts`). Models read a whole sheet and skim it; code reads every row. Whatever the scorecard asks, code finds what
is off by the file's own pattern: an empty cell in a column that is otherwise full, a repeated id, a reference to an id that does not exist, a
child count that does not match the rows, a definition made of filler, an id cited in text that is defined nowhere (`D3-S14-P15` among
`D3-S14-P01..P09`), a cell empty on a row of a kind that always has it, a value in a Required column that is not a way of saying required or
optional, and a tally the file states about a sheet that is a little off ("278 parameters" for 276 rows, LOW). Each is an exact code issue at one
cell, attached to the scorecard question with the most words in common, and the cleaning steps below never touch it.

The sweep also keeps the score honest (`capByExactFindings`): a question the sweep found mistakes under keeps a mark of at most 4 (one or two
mistakes), 3 (three to five) or 2 (six or more), whatever the Examiners gave it. The cap is named in the question's rationale and in the run notes.

**"The file already has it"** (`presence.ts`, after the cleaning below). An Examiner may say "the file has no X" about an X the file defines in
other words or on a sheet it did not read. For each such issue, code picks the eight rows most likely to hold X (rare words count more) and the
Final reviewer is asked whether one of them does. Its answer is never trusted alone: it must give a cell and copy the words that define X, and
code checks that the cell (or its row) holds those words and shares a distinctive word with the claim. Cells on discussion sheets (decisions, logs,
comparisons, open questions) never count. Only then is the issue set aside, with the cell named in the set-aside list. This check can only remove
issues, and if the proof does not hold the issue stays. `npm run presence:eval` repeats the measurement on the labelled examples in
`data/presence/step2-labels.json`.

**Cleaning the Examiners' issues** (`findingCheck.ts`, by code, before they are numbered). No model marks its own homework:

| Check | What it does | Example it caught |
|---|---|---|
| Cells named | An issue that says named cells are empty is tested cell by cell; filled cells are taken out of the claim | "rows 47-52 have no tag" when they do |
| Everything missing | A claim about every field is tested against nearly-full columns on the cited sheet | "no field has a data type" when a type column is 96% filled |
| Missing, but in the file | "X is missing" is set aside if every word of X appears together in three or more places of the file; a claim about a named sheet is tested on that sheet only | "no exit gate" when a sheet `Exit_Gate_Checks` holds 17 checks |
| Vague | A short, hedged issue with no id, number, quote or acronym is set aside | "Some rules are not fully specified, which could lead to..." |
| About the prompt | "The sheet was not provided", "not visible in the provided artifact" describe what the Examiner was shown, so they are set aside | "feature names are not visible" when column G holds them |
| Cannot be measured | An issue about a question the file cannot measure (left out of the score) is set aside | "no evidence of two independent runs" |
| Repeats | Issues in the same question at the same cell with similar wording become one, and so do issues on the same sheet whose words mostly overlap; the other wordings stay in an "Also reported as" note | five issues about one `CONFLICT` cell |
| Lone Examiner | An issue only one Examiner raised is set aside when that Examiner's model family has a low hit rate on lone issues in the test library (at least 20 checked). Read from `data/library/reliability.json`, which `npm run reliability` measures | an issue only one family raised that checking showed was rarely right |

Every set-aside issue is kept in the report with its reason. Only a plain contradiction sets an issue aside, and a severity is never raised. If
the Final reviewer's reply for a batch of questions cannot be read, the batch is split in half and each half asked again (`consolidate.ts`).

## 5. Safeguards

Every safeguard on PDF page 13 is enforced by code, and each has a test.

| Safeguard | Where it is enforced | Test |
|---|---|---|
| Independence: different model families | `llm/roster.ts` checks the roster | `orchestrator.test.ts` › Independence |
| Freeze: fixed and hashed before marking | `orchestrator.ts` hashes first, re-hashes last | › Freeze |
| Blind marking | one shared prompt, built without marks or other Examiners | › keeps raters blind |
| Evidence: unsupported claims set aside | `evidence.ts`, `rater.ts` | `evidence.test.ts`, › discards scores that cite no evidence |
| Lower mark stands | `consolidate.ts` | › keeps the lower score… / › refuses a consolidator score outside the range |
| Read-only | the reader only reads; hash compared after | › never touches the workbook |
| Reproducible | prompts, hashes, models, tokens and set-aside claims stored | `api.test.ts` run log |
| Confidentiality | `llm/roster.ts` approved list | › Confidentiality |

## 6. Staying steady when a service is busy

Model services can be slow or busy. GateX is built to keep going and to say what happened.

| Situation | What GateX does |
|---|---|
| An Examiner's reply is in the wrong shape | Up to two repair attempts that say what to fix, then the Examiner's other sections carry on |
| A model service is rate-limited or busy | The request is retried with back-off (honouring `Retry-After`), then the Examiner's **fallback models** are tried in order, in the same family |
| Only two Examiners can answer | Their marks are used, and every mark only one Examiner backed is flagged |
| The Final reviewer is unavailable | Where Examiners differ, the lower mark is used and flagged, and every Examiner issue is kept |
| A code check has nothing to read | The question is unscored (0) with a HIGH issue that says why |
| The scorecard names a missing sheet or column | You get a message up front that says exactly what to fix |
| A prompt is bigger than a model's limit | GateX tells you before the run, and suggests `columns` or `reads` |

Whatever happens, the report's run notes say how it was produced.

## 7. What is recorded

For every run, in Postgres ([data model](architecture.md#data-model)): the frozen scorecard, both hashes, every model call (the exact prompt,
the raw reply, how many claims were set aside and why, tokens, latency), each question's mark from each Examiner, every issue, and any override.
Given that, any result can be explained and any run repeated.

## 8. Extending it

| To... | Do this |
|---|---|
| Add a built-in check | Add it to `agent/checks/library.ts` and the `CHECKS` map, describe its params with zod, add a test in `checks.test.ts`, and list it in [scorecard-reference.md](scorecard-reference.md) |
| Add a model service | Anything OpenAI-compatible needs only an entry under `providers` in `server/config/models.json`. A different API shape needs an adapter in `llm/` implementing `LlmProvider` and a case in `llm/registry.ts` |
| Change what the Examiners are told | Edit `agent/prompts/*.ts` **and bump `PROMPT_VERSION`**, so old runs stay explainable |
| Change the verdict rule | `agent/verdict.ts` plus its test table in `verdict.test.ts`. The colour rule is fixed on purpose, so change it only on the owner's decision |
| Add a scorecard | Write a YAML or Excel file in the [scorecard format](scorecard-reference.md); no code change |

## 9. Glossary

| Term | Meaning |
|---|---|
| **D1, D2, D3, D4** | Schema design, its scorecard, the output document, its scorecard. GateX judges D1 against D2 and D3 against D4 |
| **Question (dimension)** | One thing a scorecard measures, with a weight, and who marks it (code or the Examiners) |
| **Must-pass question (critical gate)** | A key question; it should score 4 or more, and below that it is listed as needing attention (it does not change the colour) |
| **Anchors** | The text that says what a 0, 1 ... 5 means for one question |
| **Bands** | For counted questions: which pass share maps to which 0-5 mark |
| **Spread** | Highest minus lowest Examiner mark for a question |
| **Not in the file** | A question the Examiners found nothing in the file to mark; left out of the score (or 0 with `unmeasured: zero`) |
| **Examiner 1, 2, 3** | The three AI models that mark independently (called raters in the code) |
| **Final reviewer** | The model that compares the Examiners' marks (called the consolidator in the code) |
| **Iteration (round)** | One check of a project; each is scored and kept |
