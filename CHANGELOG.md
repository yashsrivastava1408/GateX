# Changelog

All notable changes to GateX (earlier entries call it the DDD Evaluator). Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### GateX: new name, new documentation (24 Oct 2026)
- **The product is now called GateX**, with the tagline "Checks your work against a scorecard". The README and every page under `docs/` use the new name.
  Folder and package names such as `ddd` and `@ddd/*` are unchanged.
- **Plainer words.** The three AI models are described as Examiner 1, 2 and 3, and the model that compares them as the Final reviewer. Issues are
  described as Must fix, Should fix or Nice to fix. The colour rule is stated everywhere the same way: below 60 red, 60 to 74 amber, 75 or more green.
- **A shorter README** with how it works, a five-step quick start, what you get (verdict, issues, path to green, PDF with charts, Excel and Markdown)
  and where to read more. Scorecard conversion and PDF checking moved to `docs/scorecard-reference.md`; the Amazon Bedrock setup moved to `docs/operations.md`.
- **Redrawn diagrams** (`docs/diagrams/*.mmd`, the rendered `docs/images/*.svg` and the hand-drawn `docs/images/architecture.svg`) use the new names.

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
