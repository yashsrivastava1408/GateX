# Development guide

For people changing the GateX code. To *run* GateX, see [operations.md](operations.md). To understand the engine, see
[agent.md](agent.md).

## Repository layout

```
ddd/
├── README.md  ·  CHANGELOG.md  ·  docker-compose.yml  ·  .env.example  ·  .nvmrc  ·  .editorconfig
├── docs/                         documentation, diagram sources (diagrams/) and rendered images (images/)
├── samples/talentra/             the Talentra workbook and sample scorecards
├── scripts/                      checkDocs.mjs: verifies links, anchors, paths and folder trees in the docs
│
├── shared/src/                   types and the scorecard schema, used by server and dashboard
│   ├── types.ts                    every type that crosses the API
│   └── scorecardSchema.ts          scorecard file format (Zod) → domain Scorecard
│
├── server/
│   ├── config/                   models.json (live roster) · models.mock.json (demo roster)
│   ├── scripts/                  modelsCheck.ts · seedDemo.ts · patchCells.ts · scorecardToExcel.ts
│   ├── src/
│   │   ├── agent/                ★ the GateX engine (see agent.md)
│   │   │   ├── checks/             built-in code checks
│   │   │   └── prompts/            versioned rater and consolidator prompts
│   │   ├── api/                  Express routes (app.ts) and EvaluationService (service.ts)
│   │   ├── db/                   pool.ts · migrate.ts · store.ts · migrations/*.sql
│   │   ├── excel/                xlsxReader.ts · workbook.ts · serialize.ts
│   │   ├── llm/                  provider adapters, roster rules, mock provider, model catalog
│   │   ├── report/               assemble.ts · xlsx.ts · markdown.ts
│   │   ├── scorecard/            parse.ts · excel.ts (Excel layout, both directions) · template.ts
│   │   ├── util/                 hash.ts · errors.ts · text.ts
│   │   ├── config.ts  env.ts  cli.ts  index.ts
│   └── tests/                    Vitest suites and helpers
│
└── web/                          React dashboard
    └── src/
        ├── pages/                  Projects · NewEvaluation · Run · Project · Models  (+ report/ sections)
        ├── components/             Layout · Charts · Chip · DropZone · Pipeline · SectionNav · Icons
        ├── styles/                 tokens.css · base.css · layout.css · components.css · charts.css · pipeline.css · pages.css · report.css
        ├── api.ts  hooks.ts  format.ts  App.tsx  main.tsx
```

### Dependency rules

`web` → `/api` · `api` → `agent`, `db`, `report` · `agent` → `llm`, `excel`, `util` · `db` and `report` → `agent` (via
`agent/index.ts` only). **Keep `agent/` free of imports from `api/`, `db/` and `report/`.** See
[architecture.md](architecture.md#dependency-rules). Check it any time with:

```bash
grep -rlE "from '(\.\./)+(api|db|report)/" server/src/agent || echo "ok: the agent imports none of them"
```

## Setup

```bash
nvm use                 # Node 22 (see .nvmrc)
npm install
npm run typecheck && npm test
```

| Command | What it does |
|---|---|
| `npm run dev:server` | API with auto-reload (`tsx watch`) on :4000 |
| `npm run dev:web` | Dashboard with hot reload on :5173, proxying `/api` |
| `npm test` | Server tests (Vitest) then dashboard tests |
| `npm run typecheck` | TypeScript on shared, server and web |
| `npm run build` | Production build of the dashboard |
| `npm run docs:check` | Verifies every link, anchor, repository path and folder tree written in the docs |
| `npm run evaluate -- --workbook ... --scorecard ... --mock` | One check from the command line |
| `npm run models:check -- --ping` | Check the real model roster |
| `npm run seed:demo -w server` | Fill a running server with three demo rounds |
| `npm run scorecard:xlsx -- in.yaml [out.xlsx]` | Convert a YAML scorecard into the Excel layout |

Use `MOCK_LLM=1` for everything that does not need a real model.

## Conventions

- **TypeScript strict**, including `noUncheckedIndexedAccess`. ES modules with `.js` import suffixes (TypeScript resolves them to `.ts`).
- **Validate at the edge, trust inside.** Scorecards, request bodies and model replies are checked with Zod where they
  enter. Inside, types are trusted.
- **Errors for people are `UserError`** (a message safe to show, with a status). Everything else is a bug and returns a generic 500.
- **No ORM.** Plain SQL, parameterised. Keep to what `pg-mem` supports so tests keep running without Docker.
- **Pure where possible.** Verdict, path to green, consolidation rules and report assembly are pure functions of their
  inputs, which is why they are easy to test.
- **Comments explain why**, not what. Cite the PDF page when code exists because of a PDF rule.
- **The dashboard** uses plain CSS built from design tokens (`styles/tokens.css`), no UI framework. See [Look and feel](#look-and-feel).
- **Plain words for people.** Say "file", "scorecard", "Examiner 1, 2, 3", "Final reviewer", "issue" and "path to green" in anything a user reads. Codes such as `F-01` belong in the technical pages.

## Testing

The suite is built around the PDF's rules. The server and dashboard tests are all repeatable: no test needs a real model.

| File | What it proves |
|---|---|
| `verdict.test.ts` | The colour bands (60 and 75 edges, one fixed rule), the "Needs attention" notes for must-pass questions and HIGH issues, questions with nothing to mark (skip or zero), overrides, no reason ever waits for a person |
| `pathToGreen.test.ts` | Critical gates first, smallest set, blocking findings, never waiting for a person |
| `resolve.test.ts` | Scorecards in any layout: format detection, conversion cache (memory, disk, restarts, damaged files), concurrent submissions |
| `checks.test.ts` | Each built-in check, `where` filters, a check that cannot run, band edges |
| `evidence.test.ts` | Real cell accepted; invented sheet, cell, quote or address rejected |
| `scorecard.test.ts` | The PDF format, error messages, the shipped samples, **and the example in the docs** |
| `scorecardExcel.test.ts` | The Excel layout: every field, band presets, forgiving spellings, row-numbered errors, and **YAML → Excel → back gives the identical scorecard and hash** |
| `reader.test.ts` | The real Talentra file opens; read-only; dates, rich text, formulas |
| `orchestrator.test.ts` | The whole pipeline; every safeguard; every kind of model answer (good, badly shaped, no evidence, unavailable); planted defects must never be green |
| `promptSize.test.ts` | What raters are sent; token budgets for the samples (regression guard) |
| `providers.test.ts` | The model service adapters against recorded response shapes: retries, back-off, key never in an error |
| `api.test.ts` | Every endpoint, validation errors, evidence and override, downloads, iteration history |
| `report.test.ts` | Eight sections, in order, in both formats; the core never changes |
| `fallback.test.ts` | Fallback models: same family, named in the report, ordered, protect the consolidator, show live, approved-only, skipped without a key |
| `preflight.test.ts` | The size check before submit, including fallbacks |
| `sectionPlanner.test.ts`, `sectionTokens.test.ts` | Sectioned scoring: grouping by `reads`, column narrowing, per-section size check, what the consolidator is sent, a full mock run |
| `catalog.test.ts`, `cli.test.ts`, `dbErrors.test.ts` | Model listing, command-line paths, and the plain-language database start-up messages |

**Scripted models.** `llm/mock.ts` answers from the real prompt by persona, chosen by model name:

| Persona | Behaviour |
|---|---|
| `mock-strict` / `mock-mid` / `mock-lenient` / `mock-low` | Scores 3 / 4 / 5 / 1 with valid citations |
| `mock-alarmist` | Scores 5 but raises a HIGH finding |
| `mock-garbage` | Replies in the wrong shape (to test the repair step) |
| `mock-nocite` | Scores with no evidence |
| `mock-abstain` | Declines every dimension (not measurable) |
| `mock-down` | The service is unavailable |
| `mock-consolidator` / `-unresolved` / `-greedy` / `-down` | Final reviewer: compares / leaves a gap unresolved / answers out of range / unavailable |

**Planted defects.** `server/scripts/patchCells.ts` edits the cell XML of the real Talentra workbook, so tests can plant a
4-level node, a duplicate id or missing definitions and assert the result is never green, even with perfect raters.

**Real Postgres.** The API tests also run on a real database:

```bash
TEST_DATABASE_URL=postgres://ddd:ddd@localhost:5432/ddd npm test -w server
```

Each test harness creates its own schema, so they do not disturb each other. The tests prove the rules and the plumbing; the test library below measures real runs.

## Look and feel

The dashboard follows a few rules so it stays consistent as it grows.

- **One typeface.** Inter (variable), bundled with the app through `@fontsource-variable/inter`, so it looks the same on every
  machine and makes no request to an outside font service. It is set once on `body` (`--font`); buttons, inputs, code and
  SVG text inherit it. There is no monospace font. Identifiers and hashes use the same face. Tabular figures are applied only to
  numbers (`.num`, scores, counters), because in Inter they also widen punctuation such as hyphens.
- **Scales, not one-off values.** Type sizes are `--text-xs` ... `--text-3xl`, spacing is `--space-1` ... `--space-10`, and
  radii, shadows and motion timings are tokens too. Reach for a token before writing a number.
- **Colour has jobs.** Green, amber and red mean verdicts and nothing else. Teal is the agent colour (accents, primary buttons).
  Blue marks "counted by code".
- **Plain words, in one place.** Every label, help text and result headline lives in `web/src/copy.ts` ("Must-pass checks", "Examiner 1", "Final reviewer",
  "What to fix"). Change a word there, not in the pages. Prefer a short everyday word over the PDF's term, and put the PDF term in the hint.
- **Motion is gentle and optional.** Each page's blocks rise in once, one after another (the `.page` wrapper in `Layout`
  is keyed by the address). The score ring draws itself and counts up, the threshold marker slides to the score, hover and
  focus states ease, loading shows skeleton blocks. Everything respects `prefers-reduced-motion`.
- **Stylesheets are split by concern:** `tokens` (the scales), `base` (typography, reset), `layout` (shell, sidebar, page header, grids),
  `components` (buttons, cards, chips, tables, forms, dialogs, empty and loading states), `charts`, `pipeline` (the live run view),
  `pages`, and `report`.
- **Responsive.** The sidebar becomes a top bar below 900 px, grids collapse below 1100 px, and wide tables scroll inside their card.

**Refreshing the README screenshots** (needs the server running with demo data, see `npm run seed:demo -w server`):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --force-prefers-reduced-motion --window-size=1440,1560 --virtual-time-budget=8000 \
  --screenshot=docs/images/screens/report.png "http://localhost:4000/runs/<run id>"
```

`--force-prefers-reduced-motion` makes the page skip its animations, so the capture shows the final state.

## Recipes

### Add a built-in check

1. In `agent/checks/library.ts`, write a `CheckDefinition`: `describe`, and `run(ctx, params)` that parses its params
   with Zod and returns `{ passed, total, failures, summary }`. Use `load`, `need`, `rowsWhere` and `countRows`.
2. Register it in the `CHECKS` map at the bottom.
3. Test it in `checks.test.ts`: the pass case, the failing cells, and `where`.
4. Document it in [scorecard-reference.md](scorecard-reference.md#built-in-checks).

### Add a model service

- OpenAI-compatible: add it under `providers` in `server/config/models.json` (`type`, `baseUrl`, `keyEnv`) and its models to
  `approved`. No code.
- Another API shape: implement `LlmProvider` in `llm/` (see `gemini.ts`), add a `type` to `config.ts` and a case in
  `llm/registry.ts`, and cover retries and error messages in `providers.test.ts`. Keys go in headers, never URLs.

### Measure a change to the evaluator

The test library (`/library` in the dashboard) is how you tell better from worse.
1. `npm run survey -- --folder <dir>` (no model): can the app read every file, and what does it see?
2. `npm run evaluate -- --workbook <file> --scorecard <scorecard> --out data/live-<name>` (live models): a real run.
3. Check each issue against the real file and write a verdict per issue to `data/reviews/<case>.json`
   (`{ "labels": [{ "id": "F-01", "verdict": "real|partly|wrong|vague|duplicate|unchecked", "note": "why" }] }`).
4. Add the pair to `data/library/<case>.json` (title, file names, and each run with its folder and review file).
5. Change the filter or a prompt, then `npm run replay -- --run data/live-<name> --workbook <file> --labels data/reviews/<case>.json --show`
   re-runs the finding filter on that run for free and says whether it dropped anything real. Only a prompt change needs a new live run.

6. `npm run reliability` re-measures how often each model family's issues were right and saves `data/library/reliability.json`, which
   every later run reads (an issue only a rarely-right Examiner raised is set aside). Re-run it after adding verdicts.

### What runs on every push (CI)

`.github/workflows/ci.yml` runs four jobs, none of which calls a real model or needs a secret:

| Job | What it proves |
|---|---|
| `check` | The types, every test on the in-memory database, the dashboard build and the docs check |
| `postgres` | The server tests again, against a real Postgres 16 |
| `docker` | The real image builds, starts, and runs one whole check through `scripts/smokeTest.mjs` (health, a check, the PDF, Excel and Markdown reports); the report it produced is kept as a download on the run |
| `security` | `npm audit` on production dependencies (high or critical fails) and a scan for committed secrets |

`.github/dependabot.yml` opens a weekly batch of dependency updates for the libraries, the Actions and the Node base image.
Run the smoke test on your own machine against any running GateX with `npm run smoke -- http://localhost:4000`.

### The accuracy targets

GateX is measured against five targets, all checked on real files:

| Target | How it is checked |
|---|---|
| At least 60% of the issues listed are useful (real or partly right) | Each issue is checked against the real file, by a person or by a fresh reviewer with no context, and saved under `data/reviews/` |
| At most 10% of the issues listed are wrong | The same check |
| No real issue is ever dropped by the filters | `npm run release:check` replays the filters on every labelled run and fails if one is lost |
| All eight planted defects are found by the code sweep | The planted-defect test inside `npm test` |
| The same file scores within 5 points on two runs | Two runs of one file side by side (the project history lists the score of every run) |

Add a labelled issue to the library whenever GateX gets one wrong, so the target stays honest.

### Before handing a build over: the release check

`npm run release:check` runs, with no model call: the type-check, every server and web test (including the planted-defect test, where the code sweep must find all
eight planted defects and nothing in a clean register), the docs check, and the finding filter replayed on every labelled run in `data/library` (it fails if the
filter sets aside an issue labelled real or partly right). `npm run release:check -- --live` also runs `npm run presence:eval`, which asks the live final reviewer
whether the issues in `data/presence/step2-labels.json` are already answered by the file; it fails if a labelled real gap is dropped. It costs a few cents.
Add a labelled issue to that file whenever GateX wrongly keeps or drops one.

### Reading a workbook as text

`npm run dump -- --workbook <file.xlsx> --out <folder>` writes every sheet as a plain text file (one line per row, `A5=value | B5=value`). A reviewer can search
the real cells with any text tool, which is how a fresh reviewer checks findings without opening Excel.

### Test with planted defects

`npm run planted -- --workbook <good register> --scorecard <scorecard> --label <name> [--models <models.json>] [--seed 1]` plants eight known mistakes in
a copy of the register (a different seed plants them in different rows), runs the app on it with live models and scores the report against what was
planted: how many the report points at, how many the Examiners found alone, how many the row-by-row code sweep found, and what each Examiner found.
`server/config/candidates/` holds rosters for trying other models: one run tests three models at once, one per Examiner slot. The result is saved in
`data/planted/<label>/result.json` and shown on the Test library page. Use it before and after a change to the sweep or the prompts.

### Change what the Examiners are told

Edit `agent/prompts/rater.ts` or `consolidator.ts` and **bump `PROMPT_VERSION`**. Update any test that checks prompt
content, and treat earlier iterations as not comparable.

### Add a database migration

Add a new file to `server/src/db/migrations/`, numbered after the last one (for example `002_add_reviews.sql`), in lower-case SQL. Never edit a released migration.
Check it on `pg-mem` (run the tests) and on a real Postgres.

### Change the verdict rule

The colour rule is fixed on purpose, so change it only on the owner's decision. Edit `agent/verdict.ts`, update the table in
`verdict.test.ts`, the diagram `docs/diagrams/05-verdict-rule.mmd`, [agent.md](agent.md) and
[pdf-traceability.md](pdf-traceability.md).

### Edit a diagram

Sources are Mermaid files in `docs/diagrams/`; the system architecture image `docs/images/architecture.svg` is a
hand-laid-out SVG. After editing a `.mmd` file:

```bash
bash docs/diagrams/render.sh      # needs Node; the first run downloads a headless Chromium
```

Keep the source and the rendered SVG together.

The main architecture diagram, `docs/diagrams/00-architecture.mmd`, is different: it is pasted **as live Mermaid** into
the README and `docs/architecture.md` (GitHub draws it, so fonts and themes always fit). The first line of each pasted
block, `%% source: docs/diagrams/00-architecture.mmd`, tells `npm run docs:check` to verify the copy still matches the
source. Edit the `.mmd` file, then paste its text into both blocks.

### Add a dashboard page

Add a file in `web/src/pages/`, a route in `App.tsx`, and a nav link in `components/Layout.tsx`. Fetch with
`useResource` (it handles loading, errors and polling). Reuse `Card`, `PageHeader`, `EmptyState` and the chips; take
colours from the tokens.

## Definition of done

- [ ] `npm run typecheck` and `npm test` pass (and `TEST_DATABASE_URL` tests if storage changed)
- [ ] New behaviour has a test, including the edge cases
- [ ] If a PDF rule is involved, [pdf-traceability.md](pdf-traceability.md) is updated
- [ ] If behaviour users see changed, the docs and `CHANGELOG.md` are updated, and `npm run docs:check` passes
- [ ] `agent/` still imports nothing from `api/`, `db/` or `report/`
- [ ] No secret, key or client document is committed (`.env` is git-ignored)
