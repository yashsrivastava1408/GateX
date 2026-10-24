# Scorecard reference

A **scorecard** tells GateX what to judge and how. It is a list of questions, each with a weight. People write it before the work it judges
exists, so the target never moves (PDF p.3-4). GateX only reads it, and fixes it by its hash for every check.

A scorecard is a YAML or JSON file in the PDF's format (page 17), **or an Excel workbook** with the same content
(see [Writing a scorecard in Excel](#writing-a-scorecard-in-excel)). Both give exactly the same scorecard and the same
hash. Two drafts to copy from, each in both formats:
[`samples/talentra/talentra-schema-d2.yaml`](../samples/talentra/talentra-schema-d2.yaml) /
[`.xlsx`](../samples/talentra/talentra-schema-d2.xlsx) (judges a schema, D1) and
[`samples/talentra/talentra-step04-d4.yaml`](../samples/talentra/talentra-step04-d4.yaml) /
[`.xlsx`](../samples/talentra/talentra-step04-d4.xlsx) (judges an output, D3).

## Contents

- [A minimal example](#a-minimal-example)
- [Writing a scorecard in Excel](#writing-a-scorecard-in-excel)
- [Top-level fields](#top-level-fields)
- [Scorecards in any layout](#scorecards-in-any-layout)
- [Checking a PDF](#checking-a-pdf)
- [Which sheets GateX reads](#which-sheets-gatex-reads)
- [Sectioned scoring: `reads`](#sectioned-scoring-reads)
- [Questions (dimensions)](#dimensions)
- [Built-in checks](#built-in-checks)
- [Bands: ratio to score](#bands-ratio-to-score)
- [What GateX checks in a scorecard](#what-gatex-checks-in-a-scorecard)
- [Tips](#tips)

## A minimal example

```yaml
scorecard:
  id: SC-STEP01-D2
  name: Requirements docket schema scorecard
  version: "1.0"
  judges: D1 schema design · Step 01        # must start with D1 (schema) or D3 (output)
  frozen: true                              # optional: every scorecard is frozen by its hash at submission
  approval: "Written for Step 01"           # optional: shown in the report header as the scorecard's source
  thresholds: { accept: 90, refine: 75 }    # the defaults

  artifact:
    sheets:
      - { name: Tree, header_row: 1 }
  dimensions:
    - id: C01                                # measured by code: exact, free, repeatable
      name: Every node is defined
      weight: 15
      critical: true
      check:
        id: column_filled
        params: { sheet: Tree, column: Definition }
        bands: [{ min: 1.0, score: 5 }, { min: 0.97, score: 4 }, { min: 0.9, score: 3 }, { min: 0.01, score: 1 }]
        fix: Write a one-sentence definition for each listed node.

    - id: J01                                # marked by Examiners 1, 2 and 3
      name: A newcomer could fill it in unaided
      weight: 10
      anchors:
        5: Every parameter says what to record, in what form, with an example where needed.
        4: Almost all are clear; a few need a short explanation.
        3: Most are clear, but several need the author to explain.
        2: Many parameters are ambiguous without help from the author.
        1: A newcomer could not fill most of it in unaided.
        0: Unusable without the author.

    - id: H01                                # written for a person: the examiners score what the file records about it
      name: Author understanding
      weight: 10
      critical: true
      measured_by: human
      needs: A scored author interview (0-5).
```

## Writing a scorecard in Excel

If you would rather work in a spreadsheet, write the scorecard as an `.xlsx` and upload it where you would upload a
YAML file. **Download a starter from the New check page** (the link under the scorecard box, also
`GET /api/scorecard-template.xlsx`). It is valid as it stands, includes a "How to fill" sheet, and has one dimension of each kind.

The workbook has three sheets. Other sheets are ignored. Keep the titles in row 1 (case does not matter).

**`Scorecard`** (two columns, `Setting` and `Value`):

| Setting | Meaning |
|---|---|
| `id`, `version`, `judges` | Required. `judges` must start with `D1` (schema) or `D3` (output). Format the `version` cell as **Text**, or Excel turns `1.0` into `1` |
| `name`, `step`, `approval` | Optional |
| `frozen` | Optional. Every scorecard is frozen by its hash when work is submitted |
| `unmeasured` | Optional. `skip` (default) or `zero`: what happens to a question the file holds nothing for |
| `accept`, `refine` | Thresholds; default 75 and 60 |

**`Sheets`** (which sheets of the evaluated workbook to read):

| Column | Meaning |
|---|---|
| `Sheet` | The sheet name |
| `Header row` | Row holding the column titles (default 1) |
| `Columns` | Optional, comma-separated: the columns the examiners should see (blank = all) |
| `Role` | `judged` (examiners score it) or `context` (reference material). Default `judged` |

**`Dimensions`** (one row per dimension):

| Column | Meaning |
|---|---|
| `ID`, `Name`, `Weight` | Required |
| `Critical` | `yes` = must score 4 or more |
| `Measured by` | `code` or `raters` (the Examiners; `human` is accepted and also scored by the Examiners). Blank is inferred: a `Check` means code, otherwise Examiners |
| `Measure`, `Description` | Optional text shown to the Examiners |
| `Anchor 5` ... `Anchor 0` | For `raters`: what each score means. All six are required |
| `Check` | For `code`: one of the [built-in checks](#built-in-checks) |
| `Params` | For `code`: a **JSON object**, for example `{"sheet": "Tree", "column": "Definition"}` |
| `Bands` | For `code`: `strict`, `exact`, or pairs such as `1:5, 0.97:4, 0.9:3, 0.01:1` (a pass ratio of at least the first number scores the second) |
| `Fix` | For `code`: what to do when the check fails |
| `Needs` | For `human`: what the question is about; the Examiners mark what the file records about it |
| `Return to` | `Discover`, `Define`, `Generate`, `Analyse`, `Validate` or `Refine` |

The band presets are `strict` = `1:5, 0.97:4, 0.9:3, 0.75:2, 0.01:1` and `exact` = `1:5, 0.01:1` (one mistake fails it).
`Bands` is required for a code dimension; there is no silent default.

If something is wrong, the message names the sheet and row, for example
`my.xlsx does not match the scorecard format: Dimensions sheet, row 7 (J03): the Anchor columns: anchor for score 3 is missing`.

**Converting an existing YAML scorecard to Excel** (and the file reads back to the identical scorecard hash):

```bash
npm run scorecard:xlsx -- samples/talentra/talentra-schema-d2.yaml          # writes talentra-schema-d2.xlsx beside it
```

## Top-level fields

All under the `scorecard:` key.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short code, e.g. `SC-STEP01-D2` |
| `name` | no | Display name (defaults to `id`) |
| `version` | yes | Any string or number; shown in every report |
| `judges` | yes | Free text that **starts with `D1`** (a schema design) **or `D3`** (an output document). Decides the gate and the default "return to" stage |
| `step` | no | Lifecycle step, shown in the dashboard |
| `frozen` | no | Informational. The target still cannot move: the scorecard is frozen by its hash at submission and the hash is in every report |
| `approval` | no | Where the scorecard came from, shown in the report header. A converted scorecard says which model converted it and when. Nothing is ever provisional |
| `unmeasured` | no | `skip` (default): a question the Examiners find nothing in the file for is left out of the score. `zero`: it counts as 0. (`person`, the older setting, reads as `skip`) |
| `thresholds` | no | Read, and not used for the colour. The colour rule is the same for every scorecard: below 60 red, 60 to 74 amber, 75 and above green (ADR-18) |
| `artifact` | yes | Which sheets GateX reads (see [below](#which-sheets-gatex-reads)) |
| `dimensions` | yes | At least one (see below) |

## Scorecards in any layout

Add the scorecard as it is on **New check**, or pass it to `npm run evaluate -- --scorecard <file>`. One in this app's format (YAML or JSON with
a `scorecard:` key, or the Excel layout with sheets Scorecard, Sheets and Dimensions) is read as it is. Anything else (a GS-1 workbook, CSV, PDF,
text) is converted by one model call, checked by code and used straight away. Nobody has to approve it.

- **Converted once, reused every time.** The conversion is kept in `data/scorecards/`, keyed by the scorecard's bytes and the sheet names of the
  file being checked. Every round uses the identical scorecard (same hash in every report) and no further model call is needed. Adding rows to your
  file keeps the key; renaming or adding a sheet makes a new conversion.
- **What code checks.** Weights, must-pass questions and thresholds as the source states them; that every sheet, page and column named exists;
  that a proposed count reproduces the scorecard's own N and D (within 1%) when tried on the real file; and that a question never reads more
  than the tightest Examiner can take (it is cut to the columns that match it). Every change is listed.
- **Every question gets a mark.** Criteria about outside evidence (an interview, a second run, a sign-off) are marked by the Examiners from what the
  file records about them. Steps the scorecard keeps outside its own score (GS-1's evidence gates E1-E3) stay outside the score.
- **The colour rule is the same everywhere.** GateX's fixed rule decides the colour, and rules a format cannot hold (GS-1's "mean of criteria rounded
  down", the NM cap at 3) are listed in the conversion notes.
- **Optional preview.** *Convert a scorecard* in the sidebar, or `npm run scorecard:import -- <scorecard> [file.xlsx|pdf] [--out folder]`, shows what
  was understood and writes the YAML. It uses the same saved conversion, so the preview and the check use the identical scorecard.
- The conversion uses the first Examiner with no prompt-size limit (else the Final reviewer).

## Checking a PDF

The file to check can be an `.xlsx`, a `.csv` (read as one sheet, `Sheet1`) or a `.pdf`. A PDF is read as text: each page is a sheet (`Page 1`,
`Page 2`, ...) and each line is a cell in column A, so evidence is cited as `Page 3!A12`. A PDF scorecard gives each question a page range in
`reads` (`reads: ["Page 7-9"]`); see `samples/talentra/talentra-output-schema-pdf.yaml`. Questions marked by the Examiners apply to a PDF, and
the counted checks that read Excel columns apply to Excel files. Check prompt sizes first, with no model calls:
`npm run prompt:size -- file.pdf scorecard.yaml`.

## Which sheets GateX reads

```yaml
artifact:
  sheets:                       # what is judged (the Examiners see these, and may cite cells in them)
    - name: Tree
      header_row: 1             # row that holds the column titles (default 1)
      columns: [Path id, Name, Definition]   # optional: the Examiners see only these columns
    - Allowed values            # a plain string means header_row 1, all columns
  context_sheets:               # reference material the Examiners may read and cite (the playbook, say)
    - { name: Stage 1 steps, header_row: 4 }
```

- `sheets` and `context_sheets` are what the **Examiners** are sent. They may cite only cells in these sheets.
- `columns` limits what the Examiners see, by header title. **Use it.** Smaller prompts are cheaper, faster and fit
  models with lower token limits. Code checks are not affected: they read the whole workbook.
- A sheet that is **not** listed can still be used by a code check (for example a lookup table), but the Examiners never see it.
- A header row is used to find columns by title. Duplicate titles become `Title`, `Title #2`.
- A sheet or column that the file does not have gets a clear message up front, listing what the file does have.

## Sectioned scoring: `reads`

By default every Examiner question is asked in **one** prompt holding every judged sheet. For a big schema, `reads` lets a question name the
parts of the workbook it actually needs, so each prompt is smaller and fits models with a modest input limit:

```yaml
- id: J02
  name: Definitions are one clear sentence
  measured_by: raters
  reads: ["Tree[Path id|Name|Definition]"]      # only these three columns of the Tree
- id: J04
  name: Nothing the playbook or brief asked for is missing
  measured_by: raters
  reads: ["Tree[Path id|Name]", "Stage 1 steps", "Playbook map"]
```

- An entry is a sheet name from `sheets` or `context_sheets`, optionally narrowed to columns: `Sheet[col|col|col]`. Separate columns with `|`.
  A narrowed list may only name columns that exist (the same check as `columns`).
- Questions with the **same** `reads` share one prompt (a *section*). Each section is sent to the three Examiners on its own, one section after another.
  Questions with no `reads` are asked together against the whole workbook, so older scorecards work unchanged.
- The Final reviewer is sent only the sheets behind the questions the Examiners disagreed on by more than a point, instead of the whole workbook.
- In Excel, put the entries in the `Reads` column of the `Dimensions` sheet, separated by `;`.
- **For a PDF**, each page is a sheet named `Page 1`, `Page 2`, ... and a range works: `reads: ["Page 7-9"]`. A range of a few pages per question keeps each prompt compact.
- **Must-pass questions.** `red_at_or_below` is read from a scorecard, and a must-pass question scoring at or below it is listed as "Needs attention".
  The colour itself comes from the score alone (ADR-18).
- **Questions the file cannot show.** The Examiners mark every question from what the file records, including one about outside evidence (an
  interview, a second run, a sign-off). Only when they find nothing at all does `unmeasured` apply: `skip` (the default) leaves the question out of
  the score, and the report lists it under "Not in the file"; `zero` counts it as 0. Green needs at least half of the scorecard's weight to be marked.
- **What it gives you.** Each prompt gets much smaller, so a model with a modest input limit can take it. Instructions and shared columns repeat
  in every section, so use `reads` where the per-request limit matters. Run `npm run prompt:size -- <workbook> <scorecard>` to see the numbers for
  your own files before spending any quota.
- Give a question the `reads` it needs: an Examiner marks what it is shown, and may cite only cells it saw.

## Dimensions

Each dimension says **who measures it** with `measured_by`:

| `measured_by` | Measured by | Needs | Notes |
|---|---|---|---|
| `code` | A built-in check | `check` | Exact. Use for anything countable |
| `raters` | Examiners 1, 2 and 3, 0-5 against your anchors | `anchors` for 0, 1, 2, 3, 4, 5 | Each mark must cite a real cell |
| `human` | Examiners 1, 2 and 3 (older spelling) | nothing; `needs` is optional | Accepted for older scorecards. Marked by the Examiners from what the file records, on the standard 0-5 scale unless it has `anchors` |

If `measured_by` is left out: a dimension with a `check` is `code`, `measurable_by_agent: false` (the PDF's
spelling) means `human`, and anything else is `raters`.

| Field | Meaning |
|---|---|
| `id` | Letters, digits, `-` or `_`. Unique within the scorecard |
| `name` | Display name |
| `weight` | A positive number. Weights need not add to 100; the score is normalised over the questions that count |
| `critical` | `true` = a must-pass question: it should score **4 or more**; below that it is listed as needing attention (the colour comes from the score alone) |
| `description`, `measure` | Optional text shown to the Examiners (and in reports) |
| `anchors` | Examiner questions: what each mark 0-5 means, all six required |
| `check` | Code dimensions: `id`, `params`, `bands`, optional `fix` |
| `needs` | `human` questions: what the question is about (added to what the Examiners are asked) |
| `return_to` | Which stage an issue on this question sends the author back to: `Discover`, `Define`, `Generate`, `Analyse`, `Validate` or `Refine`. Default `Define` for D1, `Generate` for D3 |

## Built-in checks

Each check answers "**how many of these rows are right?**" and returns a pass ratio. Every check names its
`sheet` and `column` by title. Most accept an optional `where` filter.

```yaml
where: { column: Level, equals: 3 }      # only rows whose Level is 3
where: { column: Used by id, not_blank: true }
```

| Check | Passes when | Params |
|---|---|---|
| `max_value` | the numeric value is at most `max` (non-numbers fail) | `sheet`, `column`, `max`, `where?` |
| `column_filled` | the cell is not blank, and matches `pattern` if given | `sheet`, `column`, `pattern?` (regular expression), `where?` |
| `unique` | the value appears once (blank values are ignored; every row in a duplicate fails) | `sheet`, `column`, `where?` |
| `any_filled` | at least one of the listed columns is filled | `sheet`, `columns[]`, `where?` |
| `list_refs_resolve` | every `list: Name` reference names a list that exists **exactly** (a rule glued onto the name fails) | `sheet`, `column`, `prefix?` (default `list:`), `lists_sheet`, `lists_column`, `where?` |
| `lists_referenced` | every defined list is used by at least one reference | `sheet`, `column`, `prefix?`, `lists_sheet`, `lists_column` |
| `values_in_list` | every value is a member of a named allowed list (blanks ignored) | `sheet`, `column`, `lists_sheet`, `lists_name_column`, `lists_value_column`, `list`, `where?` |
| `value_not_in` | the value is not one of `forbidden` (case-insensitive); blank also fails unless `blank_fails: false` | `sheet`, `column`, `forbidden[]`, `blank_fails?`, `where?` |
| `row_count_at_least` | the sheet has at least `min` rows (partial credit by ratio) | `sheet`, `min`, `where?` |
| `text_terms_absent` | share of text lines (cells) that contain none of the `terms`, whole words, any case; works on a PDF | `terms`, `sheets?` (default all) |
| `text_terms_present` | share of the `terms` that appear anywhere in the text | `terms`, `sheets?` |
| `text_ids_valid` | share of things matching `find` (a regular expression) that also fit `valid` (the strict regular expression) | `find`, `valid`, `sheets?` |

Rows that are completely empty are not counted as records. If a check has nothing to read (a column is missing, a list has
no values), the question becomes **unscored** (counts as 0) and a HIGH issue says why.

Failing cells are listed in the issue (up to 25), so the author can go straight to them.

### Criteria that are counts: scored by an exact count

A criterion whose own words ask for a count the sweep can make (see [agent.md](agent.md#3-inputs-and-outputs): empty cells, unique ids, references that resolve,
allowed values, child counts, tallies that match) is counted by code over every row, even when it is marked `raters`. The Examiners still score it, but their
mark can only be **lowered** to the ceiling the count allows: 5 for a clean count, then 4 for 99% of rows clean, 3 for 97.5%, 2 for 95%, 1 for 90%, 0 below
(any mistake caps it at 4); for tallies the file states about itself, 5 minus the number that are wrong. To get an exact score on purpose, write the
criterion the way the count is said: "Ids are unique", "No blank cells: every field has a definition and a reason", "Every reference resolves to an existing id".
A criterion worded as a judgement ("the definitions are clear") is not affected.

More counts that are made exact when the criterion says them: "ids follow NFR-nnn" (every id of the id column must match the pattern the criterion states),
"no parent has more than 10 children" (or "15 children or fewer", "<= 15 children"), "reasons that do not restate the definition", "no orphan rows" /
"cross-sheet references resolve" / "foreign key", and "hold only values from the allowed list". "Definition present", "Cell fill" and "Fields with a type" are
read as filled-cell counts. Wording that sets a limit or a choice ("at most 40 columns", "or a schema-wide rule covers it") or describes what a gate detects is
never a count. See [agent.md](agent.md#3-inputs-and-outputs) for what each one counts.

### Writing a scale so the lowest rung is kept

If the lowest rung you describe is 1 ("1 prose only"), a score of 0 for a file that has that prose is raised to 1 when the cells the examiners cite exist and hold
text. If 0 means something (absent, contradicted), describe it ("0 absent") and it is never raised.

## Bands: ratio to score

For a code dimension, the check's pass ratio (passed ÷ total) is turned into 0-5 by `bands`. The first band, from
the highest `min` down, whose `min` the ratio reaches gives the score; no band reached gives 0.

```yaml
bands:
  - { min: 1.00, score: 5 }
  - { min: 0.97, score: 4 }
  - { min: 0.90, score: 3 }
  - { min: 0.75, score: 2 }
  - { min: 0.01, score: 1 }
```

| Pass ratio | Score |
|---|---|
| 1.00 | 5 |
| 0.97 to 0.99 | 4 |
| 0.90 to 0.96 | 3 |
| 0.75 to 0.89 | 2 |
| 0.01 to 0.74 | 1 |
| 0 | 0 (no band reached) |

For a structural rule that is either kept or broken (tree depth, duplicate ids) use two bands only,
`{min: 1, score: 5}` and `{min: 0.01, score: 1}`, so a single violation fails a must-pass question. YAML anchors let you
define a band set once and reuse it:

```yaml
x-bands: &strict [{ min: 1.0, score: 5 }, { min: 0.97, score: 4 }, { min: 0.01, score: 1 }]
# ...
        bands: *strict
```

## What GateX checks in a scorecard

Every scorecard is read against these rules, and a message names the file and the field when one needs a fix:

- the YAML or JSON parses and matches the format (unknown keys such as `x-bands` are ignored)
- `judges` starts with `D1` or `D3`
- question ids are unique; an Examiner question has all six anchors; a code question has a `check`
- `thresholds.refine` is below `thresholds.accept`
- every sheet and column named exists in the file (checked on submission, before any model is called)

The scorecard's **hash** (shown in every report) is the SHA-256 of its canonical parsed form, so reformatting the
file does not change it, but changing a weight, anchor or threshold does.

## Tips

- **Quote YAML values that contain `: `** (a colon and a space), for example `measure: 'References written as "list: Name"'`.
  Otherwise YAML reads it as a nested mapping and rejects the file. The error message says which line.
- Put everything countable in code. Use the Examiners for judgement, and keep their anchors concrete and distinguishable.
- Give every must-pass Examiner question anchors where **4** means "good, with one minor gap", because 4 is the gate.
- Keep prompts compact with `columns`, and per question with `reads`. GateX checks the size at submit and tells you.
- Treat a scorecard like code: version it, review it, freeze it, then do not edit it. Change means a new `version`.
- Excel or YAML is a matter of taste: they are interchangeable. Keep **one** of them as the master copy so they cannot drift apart.
