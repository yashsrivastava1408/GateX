# Changelog

All notable changes to GateX (earlier entries call it the DDD Evaluator). Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added: the anchor floor, and more criteria scored by an exact count (24 Oct 2026)
- **Anchor floor** (`server/src/agent/anchorFloor.ts`, applied in `orchestrator.ts` just before the exact ceilings). When a scored criterion is below the lowest rung that the
  scorecard's own scale describes, it is raised to that rung. Real case: G07-C05 "Machine-readable specification" in `data/inputs/step2-v32` ("5 a machine-readable schema matches the
  prose; 3 structured tables but no machine format; 1 prose only") was scored 0 by the examiners; the converter spreads "1 prose only" over 0 and 1. Applied only when the lowest rung is 1
  and does not say absent / none / missing, the question is not one that needs outside evidence, and at least one cited cell exists, holds text and contains its quote. A scale that starts at
  2 is left alone. The adjustment is written in the report notes and in the question's rationale. Tests: `tests/anchorFloor.test.ts` (11, including the real wording and the cached real conversion).
- **New exact families** (`server/src/agent/sweepDeep.ts`, `exactScore.ts`): id pattern ("ids follow NFR-nnn", or the one shape 97% of 30+ ids share), parent width ("no parent has more than 10
  children"), reasons that only repeat the definition, cross-sheet references and orphan rows (a path id 1.2.3 whose parent 1.2 is missing), values that are a case or one-letter slip of the usual ones.
  "Definition present", "Cell fill" and "Fields with a type" are now read as filled-cell counts. These checks feed the score ceilings only: they add no issue to the report (the ceiling note names up to
  three wrong cells), and each stays silent unless the column plainly follows the rule almost everywhere. Planted tests: `tests/exactDeep.test.ts` (20). The planted Step 4 fixture still scores 10.4
  points below the clean register when every examiner gives a clean 5 (100 vs 89.6); the new planted register (bad ids, copied reasons, slipped values, blanks) 10+ below its clean one.
- **Wording fixes (fewer false "exact" criteria).** A limit or a choice is not a fill count ("every table stays small: at most 40 columns", "every rule states X or a schema-wide rule covers it"), and
  wording about what a gate detects ("detects duplicate and orphan requirements") gets no ceiling. These three step 2 criteria (G06-C03, G07-C03, G11-C04) were counted as exact and are judgement.
- **Measured offline** with the new `npm run exact:measure` (no model; the cached scorecard conversions of `data/inputs`). Exact share = criteria measured by code or with a ceiling from an exact count,
  of the criteria that can be measured from the file (outside-evidence ones left out). Before -> after:

  | Pair | Criteria (measurable) | Exact before | Exact after |
  |---|---|---|---|
  | step2-v32 | 58 (47) | 17 = 36% | 14 = 30% (3 criteria that are judgements stop being counted as exact; nothing new to count: its countable criteria are already code checks) |
  | step3 | 27 (27) | 4 = 15% | 4 = 15% |
  | step4 | 20 (17) | 9 = 53% | 9 = 53% (SD-02 now counted as parent width; SC-03 also checks the id pattern) |
  | step5 | 11 (9) | 4 = 44% | 5 = 56% |
  | docket | 38 (34) | 1 = 3% | 8 = 24% |
  | raw-step1 / 2 / 3 / 4 / 5 | 8 (6) each | 2 / 0 / 1 / 1 / 1 | 2 / 0 / 1 / 1 / 1 (generic dimensions, no counts to make) |

  The two clean files with a workbook (step 2, step 3) and the clean Step 4 register produce no new ceiling; step 2's known dangling id (`Value_Codes!E130`, `D3-S14-P15`) is still found.
- Still judged on purpose, or not buildable offline: conditions that cite declared ids (G05-C02, needs the condition column parsed), the 13 vague terms (the term list is in the file), "at least three
  competitors" (S03-01-C01) and "7 areas covered" (CP-02) (need a column mapping the scorecard does not give), cross-file questions (SC-01), and every docket / step 5 criterion that reads a PDF table
  (the row sweep does not run over PDF pages).
- No live run for this change (see the lead's note); `npm run test` has 5 failing `adaptiveRepeats` tests that count model calls and are not touched by this work.

### Added: a second look at every issue the Examiners raise (24 Oct 2026)
- New `server/src/agent/verifyFindings.ts`, run in `orchestrator.ts` right after the presence check. A separate model call reads each remaining Examiner issue next to the rows of the file it is about
  (header row, cited row and neighbours, rows holding the claim's rarest words, defining rows for any id named; machinery from `presence.ts`) and says true / false / unsure. Several issues go in one call.
  An issue is set aside only when ALL hold: the model says false and names a cell and copies the words that show it; code finds those words in that cell (or its row), not on a discussion sheet and not a placeholder;
  the quote, its cell or its column name shares a distinctive word with the claim; and two other models (second reading, `verifier.confirmers`) each answer that the cell contradicts the claim.
  No quote, an unproven quote, "partly", "unsure", a failed call: the issue stays. Issues found by code (sweep, exact counts, tallies) and issues carrying a code fact-check note are never sent and never dropped.
- Every issue set aside is listed with its cell and quote in the report's set-aside list and in `run-log.json` under `verification` (model, checked, skipped, calls, what the first look said, tokens in and out, each set-aside issue with its quote).
- On by default. Off with a Quick check (CLI `--quick`, form field `quick=1`, the upload-page box), with `"verifyFindings": false` under `settings` in the models file, or with `VERIFY_FINDINGS=0`. Models: optional `verifier` in the models file (default: the Final reviewer and its fallbacks), with `verifier.confirmers`; `server/config/models.bedrock.json` uses Nova Pro for the first look and GLM-5 + Qwen3-next-80B for the second reading.
  UI wording is plain (no model names): the Quick check line and the "Writing the report" step mention the second look.
- Measured offline on every labelled issue (`npm run verify:eval`, 255 issues of 14 runs, our labels; 40 of them with blind labels), real Bedrock calls, files in `data/verify/`:
  as written, 8 set aside (7 wrong, 1 labelled partly); useful 31% -> 32%, wrong 24% -> 21% of what is kept. The one "partly" (step 2 run 1 F-25, "no approver is not the author requirement") is false on re-check:
  `Value_Codes` CHANGE-CONTROL says "One approver other than the author" / "Two distinct approvers, neither of them the author" (correction recorded in `data/verify/label-corrections.json`); with it, 0 real or partly set aside.
  Blind labels: 1 wrong set aside, useful 35% -> 36%, wrong 40% -> 38%, 0 real or partly. A first-look model alone (Nova Pro, no second reading) proposed 19 and 3 were labelled partly; GLM-5 as first look set 3 labelled-partly aside; the second reading is what keeps real issues.
  Tried and rejected: showing a small cited sheet whole (set aside fewer wrong issues, 2 labelled partly); GLM-5 as the first look.
  The gain is small: the issues left after the earlier filters are mostly judgement calls ("unclear", "should be required"), which a quote cannot disprove. The three blind cases S25 (degraded_behaviour), S28 and S37 (CtO legend) are in the tests with scripted models, but the live model did not set them aside.
- Live check on the step 2 v3.2 pair (`data/verify/live-cli-step2-v32/`): the pass checked 12 issues in 2 calls (about 32,000 tokens), set 0 aside (8 true, 3 unsure, 1 false that the second reading kept: F-15 "never-reuse rule", which is partly right).
- Tests: `server/tests/verifyFindings.test.ts` (15). New scripts: `npm run verify:eval`, `npm run verify:report`.

### Added: calibration pack for a human, and a second blind AI pass on the spot-check sheet (24 Oct 2026)
- `npm run calibration:make` writes `data/calibration-pack/`: `README.txt`, `calibration-form.csv` (5 pairs: docket, step 2 v3.2, step 3, step 4, step 5; about 10 judged criteria each, chosen where the examiners disagreed, one examiner alone backed the mark or the dimension is heavy, for a person to score 0 to 5 with cell evidence; up to 15 findings each to label real / partly / wrong / vague; step 4 has 12 and step 5 has 14 because that is all the tool produced) and `answer-key.json` (the tool's scores and our labels, kept out of the form).
- `npm run calibration:read -- --file <filled form csv>` prints mean absolute difference, share within 1 point, share exact and bias (tool higher or lower) overall and per pair, the criteria that differ by 2 or more, and the finding-label agreement with ours. Code: `server/scripts/calibration.ts`, `server/scripts/calibrationLib.ts`, `server/tests/calibration.test.ts` (6). Not yet filled by a person.
- `data/review-sheet/spot-check-filled-agent2.csv` (second blind AI reviewer) and `data/review-sheet/consensus.md` / `consensus.csv` (three-way comparison). Both reviewers are AI agents: this is not a human check.

### Added: code-only claim checks for "X is not defined" and for cited cells (24 Oct 2026)
- New `server/src/agent/claimCheck.ts`, run in `orchestrator.ts` right after the finding fact check and before the presence check. No model is called. Kept rules:
  - `definedNames` (drops): a finding says a snake_case field name or an id (ranges such as `D3-S04-P27..P29` expanded) is itself "not defined" / "missing" / "lacks a definition for ...",
    and every one of those names is the whole content of a cell of the file (or, in a PDF, a column of a table row) with a description beside it. Decision logs, corrections and gap sheets
    never count, and a mention in prose is not a definition. One name the file lacks keeps the finding. A finding about the values of a field ("X and Y have UNKNOWN values") names nothing here.
  - `citedCellContent` (flags, no drop): a finding says what its cited cell holds ("H5 contains 'Atomic'") and the cell does not hold it (the S14/S22 case: the limit is in the scorecard's H5, the schema's H5 is empty). A note is added to the detail.
  - `alreadyDisclosed` (flags, no drop): the cited cell is the file's own marker for a known gap (UNKNOWN, UNSPECIFIED, None stated, To add, Partial, CONFLICT, To be confirmed ...) and the finding quotes it. A note is added; the gap is real.
- Measured with `npm run replay:all` (14 labelled runs, our labels): kept 172 -> 170, useful 43.0% -> 43.5%, wrong 20.9% -> 20.0%; 2 wrong dropped (docket F-01 "source_of_truth / data_stored lack definitions", step 2 R4 F-03 "D3-S04-P27..P29 not defined"), 0 real or partly dropped.
  Flags: `alreadyDisclosed` 12 findings (4 real, 4 partly, 2 vague, 1 wrong, 1 unlabelled), `citedCellContent` 2 (both labelled partly by us, both wrong in the blind check).
  Against the blind labels (`npm run replay:blind`, the 40 rows of `data/review-sheet/spot-check-filled-agent.csv`): useful 35% -> 36%, wrong 40% -> 38% (1 wrong dropped). The 5 `alreadyDisclosed` flags in that sample were all blind "partly" (true but already disclosed).
- Tried and rejected (each would drop a finding we labelled partly, or removes fewer than two wrong): ids named as having "missing source statements" while their rows hold a source (1 hit, labelled partly); a quoted single word found as part of a field name ("degradation" / `degraded_behaviour`, also fires on "purpose" / `run_purpose`); an abbreviation said to be undefined that a legend defines ("CtO", 1 hit, labelled vague); dropping on `citedCellContent` (would drop 2 findings we labelled partly); a loose "all words appear in the file" search (hits real findings: "privilege" appears 198 times).
- New `npm run replay:blind` (`server/scripts/replayBlind.ts`) scores each rule alone and together against the blind labels. `npm run replay:all` now applies the claim rules too (`--rules=none` shows the filter without them, `--rules=a,b` picks some) and prints the flags by label.
- Tests: `server/tests/claimCheck.test.ts` (12).

### Added: counted criteria are scored by an exact count, and the figures a file states about itself are recounted (24 Oct 2026)
- A criterion that is a count ("ids are unique", "every field has a definition, a type and a reason", "no blank cells", "every reference resolves", "hold only allowed
  values", "child counts match", "counts reconciled") now gets a ceiling computed by code from every row: clean share 100% -> 5, 99% -> 4, 97.5% -> 3, 95% -> 2, 90% -> 1,
  below -> 0, any mistake caps at 4; tallies: 5 minus the number wrong. The Examiners' mark is lowered to the ceiling and never raised. New: `server/src/agent/exactScore.ts`,
  hooked in `orchestrator.ts` before the criteria are combined. A judgement criterion is never touched. The older cap per dimension (`capByExactFindings`) is unchanged.
- The sweep can now count every mistake (`all`) and what it looked at (`SweepStats`), not only the first few it lists in the report.
- New `server/src/agent/tallies.ts` recounts figures a file states about itself: "283 of 426 (66%)" arithmetic, a PDF field dictionary ("14 fields" tiles, "8 sections - 68 fields",
  "Mandatory - conditional 56 - 12"), and section tables ("COUNT | ... 50 L4 leaves", "92 leaves") counted by leaf id. A mismatch is a MEDIUM code issue (`tally_mismatch`) and caps
  a criterion that asks for correct counts. A PDF recount is trusted only where it agrees with the document on most tiles or tables.
- Measured: on the saved Step 5 documents (`data/inputs/step5`, `raw-step5`) and `raw-step1/2/3` every tally the document states is true, so the recount changes no score there.
- Real runs (live Bedrock, same Step 4 pair, `data/live-exact-step4-clean`, `data/planted/exact-scoring`): clean register 95.6 green; the same register with 8 planted mistakes 75.1 (the
  first rule version also lowered one criterion by a loose word match, "defined" with "Definition"; matching is now whole words, which gives about 79.0 on the same run's marks, not re-run). Before:
  planted 90.7-95.6 against clean about 93-96. All 8 planted mistakes are in the report. Step 5 (pdf + xlsx, `data/live-exact-step5`): 96.8; the recount found every tally in the document true, so it changed nothing.
- Tests: `server/tests/exactScore.test.ts` (scale, wording of each family, planted register, regression on the saved planted fixture, tallies).

### Added: a human spot-check sheet for our labels (24 Oct 2026)
- Every label in `data/library` and `data/reviews` was written by an AI agent. `npm run spotcheck:make` now writes `data/review-sheet/spot-check.csv` (40 findings the app would
  show, spread over the test pairs and balanced across our labels, shuffled; finding text, cited cell and its text, the file to open, blank real / partly / wrong / vague
  columns and notes) and `data/review-sheet/answer-key.json` (our label for each row, kept apart so the teammate stays blind), plus a plain `README.txt` in the same folder.
- `npm run spotcheck:read -- --file <filled csv>` reads the filled sheet back and prints agreement with our labels (exact and "useful or not"), the useful and wrong rates for
  both, a confusion table, a per-pair table and every row where the teammate and we differ. Blank rows, rows with two marks and unknown ids are left out with the reason.
  Code: `server/scripts/spotCheck.ts`, `server/src/library/spotCheck.ts`, `server/tests/spotCheck.test.ts`. Nobody has filled the sheet yet, so the labels are still unchecked by a person.

### Changed: two more finding filters, built from the findings labelled wrong (24 Oct 2026)
- `npm run wrongs -- --run <dir> --workbook <file> --labels <review.json>` lists the wrong findings of a run with the cell they cite; `npm run replay:all` replays the filter on all
  14 labelled runs listed in `data/replay-runs.json` (the 13 library runs plus the blind-labelled R4 check) and fails if one real or partly-right finding is dropped.
- **Asks the file for work done outside it** (`asksFileForOutsideWork`): "no evidence of two independent runs", "no author interview", "no reviewer spot-checks", "no blind
  second derivation (Run B)". A file cannot hold that, and the scorecard already caps such a question. Removed 11 wrong findings and 1 vague one on replay, 0 real or partly right.
  Not applied when the workbook has a sheet named for such work (runs, interview, agreement, spot-check, blind, derivation).
- **A finding that says the work is fine** (`saysTheWorkIsFine`): "which appears consistent. However, this should be verified", "TH-008 (SPOOFING) is present ... despite its presence".
  Removed 2 wrong findings, 0 real or partly right.
- Tried and rejected because replay showed they would drop real or partly-right findings: cited cell is a bare id, cited cell is empty, cited cell is in row 1, "to add" wording,
  and loosening "the file names it in 3 places" to 1 or 2. A third pattern, "no example shows the field", removed nothing because the PDF reader holds too little of the examples.
- Measured on the 14 labelled runs, filter only (the lone-examiner rule and the live model checks are not part of replay), labels ours: of the 186 labelled findings kept before,
  39.8% were useful and 26.3% wrong; of the 172 kept now, 43.0% are useful and 20.9% wrong (43.5% and 20.0% with the schema-design rule the app uses). The newest run (R4, 22 kept):
  55% useful, 32% wrong. The targets (60% useful, 10% wrong) are still not met. These filters were written from the same labels they are measured on, so on a new run expect less.

### Fixed: an examiner's broken JSON no longer loses the section so easily (24 Oct 2026)
- Real failures in the logs: GLM-5 wrote a rationale without its opening quote (`Unexpected token 'O', ..."tionale": Only the c"...`) and a review batch had two objects with no
  comma between them (`Expected ',' or ']' after array element ... line 210 column 6`). `extractJson` now also repairs a missing comma between items and a comma left after the last
  item (`repairListPunctuation`, which never touches text inside a string). A reply that was cut off is still refused, not guessed.
- A reply that is not valid JSON is asked again **once**, with `STRICT_JSON_RULES` added to the system prompt (one JSON object only, every text in double quotes, commas, short
  sentences) and the parse problem named. If that is also broken, the examiner's model is given up on for that section and the next model of the same examiner (its fallback)
  takes the section. A reply that is JSON in the wrong shape keeps the old extra ask. Code: `server/src/agent/callModel.ts` (`JsonSyntaxError`, `syntaxRetries`), `server/src/agent/rater.ts`. A rater that never returns JSON
  now makes 2 calls, not 3. Tests: `server/tests/jsonRecovery.test.ts`, `server/tests/wrongPatterns.test.ts`.

### Added: "Run twice" for a steadier score (24 Oct 2026)
- Scores move from run to run (Step 2: 63.8, 75.2, 80.4, 72.2, 78.4, 76.0), and near the 75 line that decides the colour. An optional **Run twice** mode does two
  full checks with the same Examiners and shows the **average** (the colour comes from the average, by score alone), both scores and the gap. A gap of 8 points or
  more, or two runs in different colours, adds a "Needs attention" note, "Result is unstable, treat it as a range"; the colour does not change.
- Off by default, next to Quick check: `runTwice=1` on `POST /api/runs`, `--twice` (and `--quick`) on `npm run evaluate`, and a tick box on the upload page. It is in the
  web report, PDF, Excel and Markdown. `twoRuns` is part of the shared report types. Adaptive repeats are untouched: each run is an ordinary evaluation (`agent/twoRuns.ts`).

### Fixed: the Docker image could not start without a database (24 Oct 2026)
- `pg-mem`, the in-memory database used for the demo and for tests, was a dev-only dependency, but the image installs production dependencies only. Started without
  `DATABASE_URL` (for example `docker run -e MOCK_LLM=1 -e DB_MODE=memory`), the container exited at once with a missing-module error. The compose setup uses Postgres,
  so it never showed. It is now a normal dependency, so the demo mode works in the image too. CI's `docker` job caught it; it now passes (health check, one whole check
  through the container, and the three reports).

### Home page: lighter scrolling, a calmer hero, pages that open by themselves (24 Oct 2026)
- Scrolling is native again. The wheel-smoothing layer doubled up with a trackpad's own inertia and felt laggy, so it is gone, along with the scroll-linked
  re-rendering of the report section, the blur on every reveal, the blurred and animated glow layers, the translucent blur behind every card, and the looping
  float and shine animations. Measured with a browser trace over six seconds of scrolling at retina size: painting fell about 65%, building layers about 74%,
  layout about 75% and per-frame animation work about 82%.
- The hero scene is tidy and still: cards sit in an aligned layout, nothing floats or follows the mouse, and the check plays through once and stays settled. The
  score ring shows a dash and "checking" until the result arrives, then counts up to 81 and stays there (it used to restart from zero every 14 seconds).
- The five report pages fan open on their own about half a second after the section appears, instead of waiting for a scroll position.

### A home page for GateX (24 Oct 2026)
- GateX now opens on a landing page at `/` (React, no new libraries): a glowing gate scene that plays a check through (file and scorecard in, three Examiners
  marking, the Final reviewer settling, the score arriving), how it works, the result bar you can drag, the report that fans out as you scroll, issue rows you can
  filter, blocks rising along the path to green, scorecard conversion, the proof panel with the highlighted cell, the progress chart and check history, FAQ and a
  closing call to action. The dashboard moved to `/projects`; every link inside the app was updated.
- Motion: reveal on scroll, count-ups, drawn lines and charts, floating cards, cards that lean toward the pointer, a scene that drifts with the pointer, and inertial
  wheel scrolling that gives way to keyboard, scrollbar and script scrolling. All of it is off under reduced motion. It was checked in a real headless Chrome
  (hero sequence, count to 81, filter chips, chart growth, tilt, parallax, scroll hand-over) and at phone width.

### GateX: new name, new documentation (24 Oct 2026)
- **The product is now called GateX**, with the tagline "Checks your work against a scorecard". The README and every page under `docs/` use the new name.
  Folder and package names such as `ddd` and `@ddd/*` are unchanged.
- **Plainer words.** The three AI models are described as Examiner 1, 2 and 3, and the model that compares them as the Final reviewer. Issues are
  described as Must fix, Should fix or Nice to fix. The colour rule is stated everywhere the same way: below 60 red, 60 to 74 amber, 75 or more green.
- **A shorter README** with how it works, a five-step quick start, what you get (verdict, issues, path to green, PDF with charts, Excel and Markdown)
  and where to read more. Scorecard conversion and PDF checking moved to `docs/scorecard-reference.md`; the Amazon Bedrock setup moved to `docs/operations.md`.
- **Redrawn diagrams** (`docs/diagrams/*.mmd`, the rendered `docs/images/*.svg` and the hand-drawn `docs/images/architecture.svg`) use the new names.

### Stronger CI (24 Oct 2026)
- `.github/workflows/ci.yml` now has four jobs: `check` (as before), `postgres` (the server tests on a real Postgres 16), `docker` (builds the image, starts it with scripted
  demo models, runs `scripts/smokeTest.mjs` through it, validates the compose file and keeps the report PDF, Excel and Markdown it produced as a download) and
  `security` (`npm audit` on production dependencies at high and above, and a secret scan).
- `.github/dependabot.yml` opens a weekly batch of updates for the npm libraries, the Actions and the Docker base image.
- `npm run smoke -- <url>` runs the end-to-end smoke test against any running GateX.

### Two cheap fixes for misread findings (24 Oct 2026, prompts `l1-prompts/1.8`)
- Examiners are told that a column recording the state of the work against a source (for example "In this master?" holding "To add") is a status, not a missing
  field, and that a schema defines fields, so example rows or instance data not being filled in is not a defect.
- A code filter sets aside "not shown populated" and "no filled instance rows" complaints about a schema's own templates or definitions (`asksSchemaForFilledData`
  in `agent/findingCheck.ts`), only for a scorecard that judges schema design, and never for sample content the workbook does hold (personas, actors,
  permission rows). On the labelled R4 run it matches two findings, both labelled wrong, and no useful one.
- A broader pass that tested every other claim against the file the same way was measured on 45 labelled findings and wrongly dropped a real gap in both runs while
  catching none of the new wrong ones, so it is not part of the pipeline. "The file already has it" stays: 9 of 24 dropped, 0 of 21 real gaps, identical on two runs.

### Examiners now see the rows that relate to their question (24 Oct 2026, prompts `l1-prompts/1.7`)
- A question that names sheets to read ("Validation_Rules, Permission_Matrix") showed the examiners only those, although what it asks about (a data class, a
  purpose, a masking rule) is defined on another sheet (`L2_Parameters`). Examiners then reported it "not in the sheets given", and one gave the privacy
  question a 0 (a live check scored it 0 and the run fell to 72.2). Now each section also gets **supporting rows** (`agent/supporting.ts`): the few rows
  of the rest of the file that share the most distinctive words with the section's questions, shown with their header row (`rows` on a sheet spec,
  `excel/serialize.ts`). They are cut to fit beside the section for an examiner with a small prompt limit, never include decision-log or comparison sheets,
  and are cited like any other cell. A section that already reads the whole workbook gets nothing extra.
- **"Already has it" check sharpened:** claims that name ids get the rows that define them first (ranges such as `D3-S04-P27..P29` expanded), "incomplete" and
  "not yet added" wordings are checked too, and a cell that is a placeholder (proposed, unspecified, still to add) never counts as proof. On 39 labelled findings it
  sets aside 6 to 8 of the 21 the file already answers and none of the 18 real gaps.
- **Measured on the same R4 file:** prompts 1.6 without supporting rows scored 72.2 AMBER (privacy 0); prompts 1.7 with supporting rows scored 86.4 GREEN with every
  key check at 4 or more. A fresh reviewer then labelled that run's 24 findings: 5 real, 7 partly right, 9 wrong, 3 vague (50% useful).
- `npm run dump -- --workbook <file> --out <folder>` writes a workbook as plain text, one file per sheet, for reviewers who cannot open Excel.

### Scoring a zero fairly (24 Oct 2026, prompts `l1-prompts/1.6`)
- Two examiners gave "Machine-readable specification" a 0 for a workbook of structured tables, although the scorecard's own anchors put "structured tables but no
  machine format" at 2 to 3 and its reference assessment scores this workbook 3. A single 0 caps the whole question at 2, so a critical question lost its pass.
  Examiners are now told to score against the anchors as written (0 is for a file with nothing on the point, or one that contradicts it), and the final
  reviewer will not keep a 0 when the cited cells show what a higher anchor describes. Earlier runs used `l1-prompts/1.5` and are not directly comparable.

### Phases 1 to 4 after the R3 report (24 Oct 2026)
- **"The file already has it" check** (`agent/presence.ts`): a finding that says something is missing is set aside when a model points at a cell that really
  holds it and code proves the quote is in that cell. On 23 labelled findings it dropped 8 of 15 the file already answers and 0 of 8 real gaps; it keeps
  everything if the call fails. `npm run presence:eval` repeats the measurement.
- **More code checks in the sweep:** a cell empty on a row of a kind that always has it (the planted blank data type), a value such as "Maybe" in a Required
  column, and a stated tally that is a little off ("278 parameters" for 276 rows, LOW). The sweep now finds all eight planted defects offline; it found 6 before.
  Measured on eight real workbooks: no false finding from the new checks.
- **The report says when an examiner failed**, next to the colour ("this score rests on 2 of 3 examiners. Run it again before relying on it").
- **`npm run release:check`** runs type-check, tests, docs and the filter replay on every labelled run, so a change that makes the evaluator worse is caught
  before it ships; `-- --live` adds the model-backed check.

### Fixed and added after the R2 report (24 Oct 2026)
- **A cited id that exists nowhere is now a finding** (`sweepMissingTargets` in `agent/sweep.ts`). When the file defines a whole family of ids (eight or more
  of one form, defined in an id column such as `D3-S14-P01..P09`), an id of that form named in running text but defined nowhere (`D3-S14-P15`) is reported
  with its cell. Zero padding is ignored (PER-01 and PER-001 match), pattern placeholders (PER-000) and example or pattern columns are skipped. On the real
  Step 2 workbook it finds two ids and no false ones; two other workbooks give none. The first run missed `D3-S14-P15` in `Value_Codes!E130`.
- **A small-window model can no longer be asked for too much** (`outputBudget` in `agent/rater.ts`). Qwen3-32B was sent a 24,577-token prompt and asked for
  8,192 back, one token over its 32,768 window, so Bedrock refused it and examiner C was lost. The answer size is cut to what fits, and a model with under
  2,048 tokens of room left is not asked.
- **Examiners get a third try** at a reply that is not valid JSON (the last ask also says to keep each text short). The final reviewer still gets two.
- **Naming columns survives a moved header row** (`excel/serialize.ts`). A reused scorecard conversion pinned README's header row as 6; a file with its
  titles on row 5 stopped the run with "column not found". Now the one nearby row that holds every named column is used; if none does, the error stands.
- **Inter-rater agreement counts as evidence from outside the file**, like independent runs and interviews, so a 0 there no longer caps the question.

### Added: a test library, so you can see whether the evaluator is getting better
- **Test library** page in the dashboard (`/library`, API `GET /api/library` and `GET /api/library/:id`). It lists real file pairs, the runs made on
  each, and a verdict on every finding checked against the real file: real, partly right, wrong, vague, repeat or not checked. It shows the share of
  checked findings that are useful. A later run carries a verdict over only for a finding at the same cell and question, and marks it "carried over".
  The pairs are plain files under `data/library/`, the runs under `data/live-*/`, the verdicts under `data/reviews/`; no database is needed.
- `npm run survey -- --folder <dir>` reads every file in a folder with no model and prints what the app sees in each (sheets, header rows, sizes).
- `npm run replay -- --run <dir> --workbook <file> --labels <review.json> [--show]` re-runs the finding filter on a finished run and scores it against
  the verdicts, with no model call. A filter change is only good if it never drops a finding labelled real or partly right.
- **A `.csv` can now be the file under test** (`server/src/excel/csvReader.ts`). It reads as one sheet named `Sheet1`; quotes, line breaks inside
  quotes, a byte-order mark and comma, semicolon or tab separators are handled. Before, only a scorecard could be a CSV.

### Changed: fewer false and empty findings
Measured on the first real Step 2 run (93 findings, each checked against the real workbook): 12 real, 18 partly right, 39 vague, 14 wrong, 7 repeats and
3 not checked, so about a third were useful. After these changes the same findings, replayed with no model call, give 55 findings of which about half are
useful, and no real or partly-right finding is dropped.
- **Vague findings are dropped.** A finding that is short, hedged ("some", "may", "could", "not all") and names no id, number, quote or acronym is dropped
  with its reason (`isVague` in `agent/findingCheck.ts`).
- **"Missing X" is tested against the whole file.** If every word of X appears together in three or more places (a sheet name, a title, a definition), the
  finding is dropped. A claim about a sheet it names is tested on that sheet only.
- **Repeats merge more.** Findings in the same question at the same cell with similar wording are merged (the threshold was 0.4, now 0.2); the other
  wordings stay in an "Also reported as" note.
- **The review of disagreements recovers.** If the final reviewer's reply for a batch cannot be read, the batch is split in half and each half asked again,
  so one bad reply costs a few questions their review, not eight. A service error (for example 503) is not split.
- **Prompts `l1-prompts/1.5`.** Four rules are added: a schema defines, it is not filled data; every finding must point at a specific id, row, column or
  quote; a `<workbook_map>` lists every sheet so a rater who sees only some sheets does not say a thing is missing from the file; and a figure the file
  states about itself ("definitions 71/71 100%") is a claim, not proof (score no higher than 4 unless checked). Each rater prompt is about 400 tokens
  longer, so the Step 04 sample (7,252 tokens) no longer fits a 7,000-token limit; the live roster does not use one.
- **Findings about what the examiner was shown are dropped.** "The sheet was not provided", "not visible in the provided artifact" describe the prompt,
  not the file (`complainsAboutThePrompt`).
- **Findings about a question the file cannot measure are set aside.** A question left out of the score (an interview, a second run) can no longer raise a
  finding that blocks green; the findings are listed with the dropped ones.
- **More repeats merge.** The same question on the same sheet, in words that mostly overlap (0.3), merges even when the cited cells differ.

### Changed: one colour rule for every score (ADR-18)
- **Below 60 is red, 60 to 74 is amber, 75 to 100 is light green**, everywhere: the verdict, the report (PDF, Excel, Markdown, JSON), the dashboard, the history
  and the per-question scores (3 of 5 is 60, 3.75 is 75). It is one constant in `shared/src/types.ts` (`SCORE_BANDS`, `bandOf`), and no scorecard can change it:
  the `thresholds` a scorecard states (GS-1 says 90 and 75) are ignored. Old runs are recoloured when opened. The greens are lighter in the dashboard, the PDF and the Excel.
- **The colour now comes from the score alone.** A critical question below 4, an open high-risk finding, a score only one examiner could back and a score built on a small part
  of the scorecard are listed as "Needs attention" at the top of the verdict instead of turning a green result amber, and a critical question at the old `red_at_or_below`
  line no longer forces red. A report that read "RED 79.6, green needs 90" now reads green. This deviates from the PDF's decision table; see ADR-18.
- Report fixes found in a real report: the `≠`, `≤`, `×` and `§` signs no longer vanish from the PDF; an empty-cell finding keeps the column's own capitalisation
  and is not raised on a row with no id (a total or a note); the report's run notes say in one line which questions had their sheets chosen by code.

### Added: ready for a team to use (PDF tables, a score that follows the evidence, quick check, user guide)
- **PDF tables are read row by row** (`excel/pdfTables.ts`). A PDF stores a table as loose pieces of text, and a cell that wraps onto three lines used to
  become three lines, so the examiners saw `question_to_ask | The exact | A precise` with the rest of each description floating below. Now the columns are
  found from where many lines start, a new row starts where the gap is wider than between wrapped lines (or, when rows are not padded, where the line starts
  in the field-name column), and each column's pieces are joined across the lines. The Docket's `question_to_ask` row now reads
  `The exact question | A precise question gets a precise answer | Text(500) | A | Yes | ANALYST | Ends with "?"`. A page without a table is read exactly as before.
  Checked on five real PDFs (no crash on any page). The Docket pair had only 5% useful findings, mostly from this misreading.
- **The score follows the exact evidence.** A question cannot keep a clean score the examiners gave it when the row-by-row sweep found mistakes under it:
  4 for one or two, 3 for three to five, 2 for six or more (`capByExactFindings`). Only MEDIUM findings count, a cap only ever lowers a score, and the report
  says which question was capped and why. Before, a file with planted defects scored the same as the clean one.
- **Quick check** (a tick box on the upload page, `quick=1` on `POST /api/runs`): every question is scored once, so a repeat run is about a third faster.
  The roster's `sectionConcurrency` is now 4 (it was 2), since one person submits at a time.
- The upload page now accepts a `.csv` as the file to check (the server already did).
- **Measured on the Docket pair** (a 56-page PDF against a 49-question scorecard): with the PDF table reader and four sections at a time it ran in **13 minutes
  instead of 31**, gave 11 findings instead of 25, and 2 of the 11 were useful (18%) instead of 1 of 22 (5%). The same Step 2 register that took about 20 minutes
  took about 10 through the dashboard.
- `verbal`, `oral defence`, `visual`, `appearance` and `look and feel` join the wording that marks a question as needing evidence from outside the file, and a
  question with no sub-criteria that matches is wrapped as one outside criterion (`D8-C01`). "Visual / Format Quality" scored 0 on every PDF because the examiners
  read extracted text with no appearance, which cost about 12 points of the score; it is now left out ("not in the file") instead. On the real converted scorecards the rule
  touched only the "Verbal", "Visual / Format Quality", independent-runs and build-runs questions.
- **`docs/user-guide.md`**: one page for authors on how to submit, read the report, fix and check again, and what the score does and does not mean.

### Added: the planted-defect test, and a row-by-row sweep in code
- **`npm run planted -- --workbook <good register> --scorecard <scorecard> --label <name> [--models <models.json>]`** breaks a copy of a good register
  on purpose (a blank definition, reason and data type; a duplicate id; a parent that does not exist; an invalid "Required" value; a vague definition; a
  wrong child count), runs the app with live models, and scores how many were found, per examiner (`server/src/planted/`). The answer key is what was
  planted, so no reviewer's opinion is needed. Results are saved in `data/planted/<label>/result.json` and shown on the Test library page.
- **First result: the app found 0 of 8.** On the Step 4 register, GLM 5, Llama 3.3 and Qwen3 found none of the eight planted defects and the broken file
  scored 95.6. Every question in that scorecard is "judged", so the models read the whole sheet and skim it. Eleven other model slots were tried on the same file (DeepSeek v3.2, Kimi K2.5, gpt-oss-120B, Llama 4 Maverick, Nemotron Super,
  MiniMax M2.5, Mistral Large 3, GLM 4.7, Qwen3-32B and the current three): ten found none and Kimi found 1 of 8, so a better model does not fix this. The scores
  they gave the same nearly-clean file ranged from 45.8 (DeepSeek, Kimi, gpt-oss) to 95.6, so their harshness differs a lot. All of them answered with valid JSON,
  so they are drop-in alternatives; `server/config/candidates/` holds the rosters.
- **The row-by-row sweep** (`agent/sweep.ts`) reads every row in code, whatever the scorecard asks, and reports what is wrong by the file's own pattern:
  an empty cell in a column that is otherwise full, a repeated id, a reference to an id that does not exist, a child count that does not match the rows,
  and a definition made of filler. Each result is an exact code finding at one cell, attached to the scorecard question whose words match, so the finding
  filters leave it alone. On the planted file it finds 6 of the 8 (the blank definition and reason, the duplicate id, the broken parent, the wrong count and the filler definition). It misses the blank data type, because that column is legitimately empty on section rows, and the invalid "Required" value, which only the removed one-use-value rule could see.
  It is silent on clean registers (0 findings on the Step 4 CSV, the Step 4 and Step 3 workbooks and the Step 2 schema, apart from a handful of one-cell
  LOW observations on other sheets). A first version also flagged "a value used once in a column" and was right about 1 time in 9 (for example "Low" among
  Critical/High/Medium), so that rule was removed.
- **Known limit:** the planted file still scores about the same as the clean one (95.6 against 93.6), because the sweep adds exact findings but the score is
  still the examiners' judgement of the scorecard's questions. Making a counted question (for example "every field has a definition") use an exact count instead
  of a reading is the next step.
- `npm run survey`, `replay`, `reliability`, `review:dump` and `planted` are the tools of the test loop (see docs/development.md).

### Added: the evaluator learns how reliable each examiner is, from checked work
- `npm run reliability` measures, from the verdicts in the test library, how often each model family's findings were right once checked against the
  real file, and saves `data/library/reliability.json` (no model is called). On the 160 findings checked so far: raised by one examiner, 18% were useful;
  by two, 68%; by three, 80%. Alone, `zhipu` was right 57% of the time, `meta` 2% and `mistral` 0%.
- **The agent reads that table as a plain rule** (`agent/reliability.ts`). A finding only one examiner raised is set aside when that examiner's family
  has been right under 20% of the time on its lone findings, once at least 20 were checked. A second examiner agreeing keeps it, and the rule runs after
  duplicates are merged. A family with fewer than 20 checked findings is never filtered. Each set-aside finding is listed with this reason. The agent does
  not change while it scores: the table is data, read once at the start of a run (CLI and dashboard).
- Estimated by leaving one run out at a time (table built from the other runs): filters alone gave 42% useful findings (49 of 118); with the examiner rule
  53% (48 of 91), losing one useful finding. Five runs on four file pairs is a small sample; re-run `npm run reliability` after reviewing more runs.
- The Test library page shows the table ("How often each examiner is right"); `GET /api/library/reliability` serves it.

### Changed: the Bedrock roster
- **Examiner C is now `qwen.qwen3-next-80b-a3b` (family `qwen`)**, with `qwen.qwen3-32b-v1:0` as its same-maker backup, instead of Mistral Large. Mistral hit its
  daily token limit (HTTP 429) in the middle of the test runs, and its lone findings had been right 0 times in 33 checked. GLM 5 (examiner A) gains
  `zai.glm-4.7` as a same-maker backup. The old file is kept as `server/config/models.bedrock.mistral-backup.json`. A new maker starts with no reliability
  history, so nothing it raises alone is set aside until 20 of its lone findings have been checked. Every model was pinged and answered before the switch.
  Claude models are listed on the account but refused (AWS payment setup); DeepSeek v3.2, Kimi K2.5, gpt-oss-120B, Llama 4 Maverick and Nemotron also answered.
- **A text value missing its opening quote is repaired** when a model writes `"rationale": The artifact ...` (GLM 5 did, and lost a section each time);
  only after the reply failed to parse as written (`quoteBareValues` in `agent/callModel.ts`).

### Fixed
- **A question that needs evidence from outside the file no longer scores 0.** A criterion whose wording needs several independent runs, or the
  author's interview or answers, is treated as outside the file even when the converter called it `counted` (`retypeOutsideCriteria`). A 0, or no usable
  score, on such a criterion now counts as "not in the file" (GS-1's own rule caps that at 3) and is no longer an unscored zero. A missing-evidence
  complaint about such a criterion is set aside too, so it cannot block green. On the Docket pair this had cost SC-D05 (weight 5) and SC-D08 (weight 9.4).
  Findings tagged with a criterion id (`AU-01`) are now matched to their dimension, which the first version of the unmeasurable-question rule missed.
- **The exact code checks counted a summary row.** A row whose first cell is `COUNT`, `Total`, `Sum` and so on is no longer counted as data, so a
  `COUNT` row can no longer fail "every row has a tier" (`isSummaryRow` in `agent/checks/library.ts`).
- **A big file no longer leaves questions unscored.** A question with no `reads` list was sent the whole workbook (316,000 tokens on the Step 2 schema),
  which every examiner refused, so it came out unscored. Code now gives it the sheets and columns that best match its words, up to 30,000 tokens
  (`agent/autoReads.ts`). Each choice is written in the run notes.
- **A scorecard with missing weights converts.** A question with a blank, zero or non-numeric weight gets the average of the others (or 1), with a note,
  instead of the whole scorecard being refused (`repairWeights` in `scorecard/importDraft.ts`).
- Tests: 444 server and 10 dashboard.

### Documented now (built earlier, not yet described here)
- **Workbook profile** (`excel/profile.ts`): for every sheet its real header row, id column, size, and for every column what it holds and how full it is.
  Built from the file alone. It decides which columns a question reads, tests findings against the file, and sizes prompts.
- **Criteria** (`agent/aggregate.ts`): a dimension can hold criteria, each scored on its own (examiners or exact code counts), then combined by the
  scorecard's own rule (`aggregate`, for example mean with a floor and caps), so the score follows the scorecard's arithmetic.
- **Fact check and merge of findings** (`agent/findingCheck.ts`): a finding that says cells are empty is tested cell by cell; a claim about every field is
  tested against nearly-full columns; duplicates are merged. Dropped findings are listed in the report with the reason.
- **Adaptive repeats** (`repeatMode`, default `adaptive`): every rater scores everything once, then only the questions the examiners disagreed on are
  scored again, and the median is kept.
- **Scorecard pinning** (migration `003_scorecard_pins.sql`): a project keeps the scorecard its first iteration was converted to, so later iterations are
  marked against the identical target. Use a new project name when the saved scorecard is wrong.
- **Batched review**: the final reviewer is asked about 8 questions per call.
- A guard refuses the same file uploaded as both the file to check and the scorecard.

### Changed: result bands
- Default bands are now **0-59 red, 60-74 amber, 75-100 green** (accept 75, refine 60; was 90 and 75). A scorecard that states its own `thresholds` keeps them
  (the GS-1 workbook states 90 and 75). The green is lighter in the dashboard. Docs and diagram sources updated.

### Changed: fully automatic scoring (no person in the loop)
- **Any scorecard layout is scored straight away.** Upload a GS-1 workbook, CSV, PDF or text rubric on *Check a new file* (or `--scorecard` on the CLI):
  it is converted by one model call, checked by code and used. There is no draft, no approval and no name to type. The conversion is cached in
  `data/scorecards/`, so every iteration uses the identical scorecard (same hash) and the model is called once per scorecard; simultaneous submissions share it.
- **Nothing waits for a person.** A question written for a person (`measured_by: human`, "unmeasurable" criteria such as an interview or a second run)
  is scored by the examiners from what the file records. Only when they find nothing at all is it left out (`unmeasured: skip`, the default) or counted
  as 0 (`unmeasured: zero`). The old `unmeasured: person` reads as `skip`.
- **`frozen` is optional.** Every scorecard is frozen by its hash at submission; an unfrozen one is no longer refused. Reports never say "provisional".
- **Converted questions stay small.** The converter names the columns each question needs (`Sheet[Col|Col]`); code matches them to the real headers and,
  if a question still reads more than the tightest rater allows, cuts its widest sheets to the id column plus the columns that match the question.
  On the Talentra Master Schema this took the largest section from about 135,000 to about 36,000 tokens.
- Dashboard: *Import a scorecard* is now *Convert a scorecard* (optional preview); "Needs your input" is now a read-only "Not in the file" list;
  the "Change the result" button and the approval banner are gone. Wording no longer asks anyone to check, approve or supply anything.
- `PROMPT_VERSION` is `l1-prompts/1.2` (raters score outside-evidence questions from what the file records). `IMPORT_VERSION` is `import/2.2`.

### Removed
- `POST /api/runs/:id/evidence`, the human-evidence form, `pathToGreen.needsPerson`, `RunDetail.evidence`, and the `approvedBy` field of
  `POST /api/scorecards/check` (it now just re-checks and freezes a YAML scorecard). The override API remains, optional.

### Verified
- 282 server tests and 10 web tests pass, on the in-memory database (not re-run against a real Postgres this time). New tests cover the converter (format detection, cache across restarts,
  concurrent submissions, damaged cache, no model), the column and size safety net, `unmeasured: zero`, and that no verdict, report or screen asks a person for anything.
- **Live, on Bedrock, no mock:** the GS-1 workbook (`Talentra_Step2_Master_Scorecard_Final.xlsx`) converted in 40-76 s into its 13 dimensions
  (weights 100, the 7 GATE dimensions critical, red line 2, evidence gates E1-E3 left out as the workbook says they are not scored). The Master Schema
  was then evaluated against it end to end: **RED 53.0** in 3 min 44 s, all 13 dimensions scored, 159 findings (54 HIGH), about 1.85M input tokens.
  Mistral Large sat out the five sections over its 24,000-token limit; the other two examiners covered them.

### Added
- **Delete a report or a project** from the dashboard, after a confirmation. `DELETE /api/runs/:id` and `DELETE /api/projects/:id` remove the
  database rows and the saved upload and report files; a run that is still in progress cannot be deleted.
- **Findings that repeat are folded into one** in the report view, with the other wordings under "Also said", a search box, and expand/collapse.
- **Light theme**, a theme switch in the sidebar, a redesigned "New evaluation" page, live progress and elapsed time while a run works,
  toasts, and a "Copy summary" button on a finished report.
- **Server setup.** The image is smaller and runs as a non-root user with a health check. The app and the database listen on this machine only;
  `docker compose --profile https up -d` adds Caddy for automatic HTTPS. `POSTGRES_PASSWORD` and `DOMAIN` in `.env` (see "Putting it on a server"
  in `docs/operations.md`).

- **Import scores everything it can.** Questions are no longer given to a person because they are counts. With the file the scorecard will be used on, the
  importer sees each sheet's real column headings (it finds the header row by itself), proposes exact computer counts for a workbook (column filled, unique,
  values in an allowed list, maximum value, not one of these values, minimum rows), and each proposal is **tried on the real file** and dropped if the
  sheet or column is wrong. A count no exact check can make is scored by the AI examiners from the file, on a standard 0 to 5 scale when the source has none.
- **`unmeasured: skip`** on a scorecard leaves a question that needs something outside the file (a second run, an interview, a document not given) out of the
  score instead of waiting for a person. It is listed as "Not measured" and does not hold green back. Imported scorecards use it; `person` stays the default.

- **A score one examiner alone could back cannot make a green result.** Before, a 100 built on a single examiner's 5 on several questions, including must-pass
  ones, read as Green. Now the verdict stays amber and names the questions that need a second opinion. The note beside such a score says "Only examiner B gave
  a score that the file could back up" instead of the final reviewer's "all examiners agree". The import also tells you when the scorecard refers to sheets
  the file does not have.

- **A score built on a small part of the scorecard cannot be green.** At least half of the scorecard's weight must be scored (the rest being left out as not
  measured). A file scored on 12% of the questions had read Green 100. On start-up the server also brings every saved result in line with the current rule,
  so lists and the sidebar never show an older rule's answer.

### Changed
- The dashboard stops at the scorecard report: the "next iteration" buttons, trend chart and round-by-round comparison are no longer shown.

## [1.6.0] - 2026-10-23

### Added
- **Counting in the text of a PDF.** Three new code checks count words and identifiers in every line of a document, so they work on a PDF as well as
  a workbook: `text_terms_absent` (share of lines free of listed words, such as vague terms), `text_terms_present` (share of required terms that appear)
  and `text_ids_valid` (share of ID-shaped tokens that fit a strict pattern). A miss is cited as "Page n · line m". Nothing to count in (no lines, no IDs,
  unknown sheet) leaves the question unscored and flagged instead of scoring it as perfect.
- **Import can hand a counted criterion to code.** When counting words or IDs settles a criterion exactly, the import proposes a `check` for it. Code
  makes it its own `measured_by: code` question (weight shared by criteria count, the source's ratio bands 98/90/75/50/>0%) and the review table
  shows "Counted by code" with what it counts. The words or pattern are the model's proposal unless the source lists them, so the import notes say
  "confirm before approving". A proposal the app cannot run is dropped and the criterion stays with a person. The counts are by line of text; where
  the source counts fields or rows, the import says so.

## [1.5.0] - 2026-10-23

### Added
- **Import a scorecard written in any layout** (sidebar "Import a scorecard", `POST /api/scorecards/import`). An examiner model reads the file
  (Excel, PDF, YAML, JSON, CSV or text) and drafts it in this app's format, optionally using the file it will judge so the draft names real sheets or
  page ranges. Code then checks the draft: it is never frozen, never claims an approval, counted criteria become "needs a person", and unknown
  sheets or pages are dropped, with every change listed. A person compares it with the original side by side, edits it, and approves it with their
  name (`POST /api/scorecards/check`), which freezes it and records who approved it and when. The draft is not trusted until then.
- **Every finished report is also saved as files**, in any database mode: `data/reports/<project>/iteration-<n>/report.json`, `.md`, `.xlsx` and `.pdf`,
  rewritten when a person adds evidence or an override. Even on the in-memory demo database a result is never lost. `docker compose up --build` now runs
  the whole app with Postgres (history kept in the `ddd_pgdata` volume, files in `./data`).
- **Steadier scores.** `settings.repeats` (default 1; 3 in `models.bedrock.json`) makes each examiner score each section several times and keeps the
  median (the lower middle of two), noting how far the runs differed. Each judged question now carries a **confidence**: steady (two or more examiners
  within a point, and stable across repeats), shaky, or single (only one examiner could score it); the report page shows "Scores differ" for shaky ones.
- **A shaky score cannot force RED alone.** With a scorecard's `red_at_or_below`, a must-pass question at the red line forces RED only when the score
  is reliable. A single-examiner score or an unresolved disagreement keeps the result AMBER and says a person should check it.
- Fixed: finding references (`A1`, `A2`, ...) restarted in every section, so findings from different sections could share a reference and be mixed up by the consolidator.
- Import: judged questions get anchors written for that question (the general anchor is only the fallback), and each lists the criteria it covers.
- **Import splits dimensions in code.** The model labels each criterion judged or counted; code splits mixed dimensions into a judged question and a
  `-counted` question for a person, shares the weight by criteria count, trims over-long PDF page ranges (3 pages on free tiers, 10 on a roomy
  roster), and fills missing anchors from the source's general anchor. `npm run scorecard:import` does the same from a terminal.
- **Sections can run at the same time** (`settings.sectionConcurrency`, default 1; 3 in `models.bedrock.json`). Scores are identical to one at a time.
- Import review page: a table of the questions found (who marks each, weight, must-pass, pages), with the original and the raw YAML folded away.
- `MODELS_CONFIG` may be a repository-relative path (`server/config/models.bedrock.json`) from any folder; `models.bedrock.json` now uses GLM 5, Llama 3.3 70B, Mistral Large and Nova Pro.
- **`red_at_or_below`** (optional scorecard setting, also a row on the Excel `Scorecard` sheet): a critical dimension scoring at or below it forces RED
  whatever the total, as in the mentor's GS-1 scorecard. Without it nothing changes.
- **Amazon Bedrock provider** (`type: "bedrock"`, Converse API, Bedrock API key as a bearer token). A second roster file,
  `server/config/models.bedrock.json` (Claude, Llama, Mistral + Nova as consolidator), is chosen with `MODELS_CONFIG`; the default Groq + Gemini
  roster is unchanged. `models:check` lists a region's models and matches inference-profile ids (`us.`, `eu.`). Model ids in the file are
  unverified placeholders until checked against a real account.
- **PDF as the file to check.** Each page becomes a sheet named `Page n` and each line a cell in column A, so raters cite `Page 3!A12`
  and the rest of the pipeline is unchanged. A scorecard may name page ranges (`Page 7-9`) in its sheets and in a dimension's `reads`.
  Repeated headers, footers and bare page numbers are dropped. Scanned (image-only) PDFs are refused with a clear message.
  Only rater questions apply to a PDF; code checks need Excel columns. Draft scorecard: `samples/talentra/talentra-output-schema-pdf.yaml`.
- **PDF report** (`/api/runs/:id/report.pdf`, `report.pdf` from the CLI, "PDF" in the Download menu): verdict, a prioritised "What to improve"
  list, colour-coded scores, strengths and the path to green.
- **"What to improve" sheet** first in the Excel report: one ordered to-do list (findings by severity, low scores, items only a person can
  supply) with a Done column and a filter. Dimension scores are now colour-coded.

## [1.4.0] - 2026-10-23

### Added
- **Sectioned scoring.** A rater dimension can list `reads`: the sheets, and optionally columns, it needs (`Tree[Path id|Name|Definition]`). Questions
  with the same `reads` share a prompt (a section); each section goes to the three raters on its own and the results are merged. Scorecards without
  `reads` behave exactly as before. In Excel the entries go in a `Reads` column of the `Dimensions` sheet.
- The consolidator is sent only the sheets behind dimensions the raters disagree on by more than a point (everything, as before, for unsectioned scorecards).
- The size check at submit now judges each section on its own and names the section that is too big.
- `npm run prompt:size -- <workbook> <scorecard>` shows, without any API call, the tokens per sheet, per section and which raters can take each.
- `samples/talentra/talentra-schema-d2-sectioned.yaml`: the D2 scorecard with `reads` (same questions, weights and anchors).
- `evaluate` also writes `run-log.json` (models, real token counts, timings).
- **Dashboard rewrite in plain words.** The report page now shows the result, a "What to do next" list and tabs (Scores, What to fix, Examiner agreement, Needs your input,
  Path to green, Strengths, Technical details). Scores are grouped by who checked them and colour-coded; hints explain the terms; downloads are in one menu.
  All wording lives in `web/src/copy.ts`.
- GitHub Actions CI: typecheck, tests, build and docs check on every push and pull request, with mock models only (no API keys).

### Changed
- The orchestrator runs every scorecard through one section loop (an unsectioned scorecard is one section) instead of two copies of the rater code.

### Verified
- 187 server tests and the web tests pass. One live run of the sectioned D2 scorecard on free Groq and Gemini keys: AMBER 84.8 in 3 min 56 s (was impossible before),
  partial because of provider limits (details in the README).

## [1.3.0] - 2026-10-23

### Added
- **Fallback models.** A rater or the consolidator can list backup models, tried in order if its model fails (overload, quota, prompt too large). A fallback answers
  as the same participant and counts as the same family, so three different families are always kept. Fallbacks must be approved; one without a key
  is skipped with a warning. The report names the model that really answered, the run notes say what failed first, and the live view shows the model answering now.
- `models:check` lists and pings fallbacks; the Models page shows them. `server/config/models.json` gives Gemini rater B a fallback (`gemini-3.1-flash-lite`).

### Verified
- A full evaluation (Step 04 scorecard) ran on live Groq and Gemini models. Live, a Gemini quota error (HTTP 429) was absorbed by a fallback, and a Groq size refusal
  (HTTP 413) left one rater out cleanly while the run finished.

## [1.2.1] - 2026-10-23

### Fixed
- The first live run failed because the schema prompt is far bigger than estimated. The token estimate is now calibrated against what Groq
  counted (2.7 characters per token, not 4), and the documentation numbers are corrected (18,000 to 21,500 tokens per rater, not 13,400).
- The app now **checks before running**: at submit it measures the real prompt against each rater's `maxInputTokens` and refuses the
  evaluation, with a plain explanation and fixes, if fewer than two raters can take it.
- Provider errors now show the provider's sentence instead of a block of JSON.
- Transient provider overloads (503) are retried five times instead of three.

### Changed
- `server/config/models.json`: the Groq raters carry the token limits Groq reported for this account (8,000 and 7,000).

## [1.2.0] - 2026-10-23

### Changed
- **Dashboard redesign.** One typeface everywhere (Inter, bundled with the app, no monospace), a larger type scale, roomier cards,
  tables, buttons and inputs, bigger section tabs that share the width evenly, and a restructured set of stylesheets
  (`tokens`, `base`, `layout`, `components`, `charts`, `pipeline`, `pages`, `report`).
- **Motion.** Pages rise in, the score ring draws and counts up, the threshold marker slides to the score, hover and focus states ease,
  loading shows skeleton blocks, dialogs pop in over a blurred backdrop. All of it respects reduced-motion settings.
- History: whole rows are clickable, dates no longer wrap, and wide tables scroll inside their card instead of overflowing.

## [1.1.0] - 2026-10-22

### Added
- **Excel scorecards.** A scorecard can be written as an `.xlsx` (sheets `Scorecard`, `Sheets`, `Dimensions`) and uploaded like a YAML file.
  It reads into the same validated scorecard, with errors that name the sheet and row. A starter template is downloadable from the
  New evaluation page (`GET /api/scorecard-template.xlsx`), and `npm run scorecard:xlsx` converts YAML to Excel (round trip gives the identical hash).
- **Extra instructions box.** Optional text for the examiners, sent to every rater and the consolidator, saved with the run (new column `runs.instructions`,
  migration `002_instructions.sql`) and hashed in the report header. Shown in the Markdown and Excel reports.
- Excel versions of both Talentra sample scorecards.

### Changed
- `PROMPT_VERSION` is now `l1-prompts/1.1` (the prompts gained an `<instructions>` section and a rule about it).
- The default model roster now uses models that answered a live `models:check --ping` on a Groq and a Gemini key.

### Fixed
- Starting the server with `DATABASE_URL` set but Postgres not running now says how to fix it (start Docker, or remove the URL) instead of printing a stack trace.
- `npm run models:check -- --ping` dropped the `--ping` flag; the ping's token budget was too small for reasoning models.

## [1.0.0] - 2026-10-22

First release: the **Level 1 evaluator agent** from the Agentic Roadmap.

### Added
- The evaluator agent (`server/src/agent/`): freeze, count in code, three blind raters, a consolidator, a verdict decided
  by rule, and an eight-section report with a path to green.
- Nine built-in code checks, and scorecards in the PDF's YAML/JSON format.
- Provider adapters for Groq and any OpenAI-compatible API, and for Gemini; a scripted mock provider for tests and demos.
- Postgres storage (plain SQL migrations) with an in-memory twin for tests; Docker Compose for Postgres.
- Dashboard (React, black theme): projects, new evaluation, live pipeline, report, iteration history, models.
- Command-line evaluator, `models:check`, and a demo-data seeder.
- Two draft scorecards for the Talentra workbook (schema gate and Step 04 output gate).
- Documentation set: architecture, agent, scorecard reference, API, operations, security, PDF traceability, decisions.

### Behaviour worth knowing
- A HIGH-risk finding blocks green (PDF p.11), even when the score is high.
- A custom read-only .xlsx reader replaces ExcelJS for input (ExcelJS cannot open the Talentra file).

### Not in this release
Calibration, shadow mode, the gate tracker, authentication and roles, sectioned evaluation. See
[docs/pdf-traceability.md](docs/pdf-traceability.md).
