# API reference

The dashboard and the command line are the main clients, and the HTTP API is plain REST, so you can script it too. Base URL in development: `http://localhost:4000`. All endpoints are under `/api`. Bodies are JSON,
except the upload.

> **Sign-in.** GateX has no login of its own. For shared use, put it behind a reverse proxy with sign-in. See
> [security.md](security.md#recommended-setup-for-a-shared-deployment).

The exact response types are in [`shared/src/types.ts`](../shared/src/types.ts) (`RunDetail`, `Report`, `ProjectHistory`, ...).

## Conventions

- **Errors** are always `{ "error": "<message in plain words>" }` with a matching status code.
- `400` the submission or request is wrong (the message says what to fix) · `404` no such run, project or endpoint ·
  `409` the roster is not ready, or the run has no finished report yet · `500` an unexpected server error (see the server log).
- Timestamps are ISO 8601 UTC. Scores are numbers; the weighted score is 0-100 and rounded **down** to one decimal.
- Runs are **asynchronous**: submit, then poll the run until `status` is `done`, `failed` or `cancelled`. `status` is `waiting` (saved, in the [waiting line](#the-waiting-line)), `queued` (taken off the line, starting), `running`, `done`, `failed` or `cancelled`.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Liveness: `{ "ok": true, "db": "postgres" \| "memory" }` |
| `GET /api/config` | The model roster (Examiners 1-3 and the Final reviewer) and whether it is ready |
| `GET /api/projects` | All projects with their latest run and a score history |
| `GET /api/board` | The status board: five steps, each with D1 and D3 (latest result, coloured by score) and D2 and D4 (Frozen once a check used a scorecard), and whether the step is complete |
| `GET /api/accuracy` | The accuracy figures of Roadmap page 14: score within 1 point, same colour, false green (overall and on must-pass questions), false red, same colour when run again, and wrong issues, each with its target, its sample (`n`, files) and `pass`, `fail` or `not_enough_data`. Three groups that are never blended: `human` (a person's marks and ticks), `aiStandin` (an AI's marks, labelled as not a human check) and `self` (re-runs). `sources` says where every number comes from. Demo-model checks are never counted |
| `GET /api/runs/:id/human-review` | A person's own marks for this finished check, oldest first (shadow mode) |
| `POST /api/runs/:id/human-review` | Save a person's marks next to GateX's: `{ reviewer, scores: { <area id>: 0 to 5 }, verdict?: "green" \| "amber" \| "red", note? }`. `409` before the check has finished, `400` for a mark outside 0 to 5 or an area the report does not have. Never changes the check |
| `GET /api/runs/:id/feedback` | The right / wrong / unclear marks people gave the issues of this check |
| `POST /api/runs/:id/findings/:findingId/feedback` | `{ label: "right" \| "wrong" \| "unclear", who, note? }`. One mark per person per issue; a second one from the same person replaces the first. Counts as a human label on the accuracy page |
| `GET /api/projects/:id` | One project's rounds, trend, per-question heatmap and issue changes |
| `POST /api/runs` | Submit a file to check (`.xlsx`, `.csv` or `.pdf`) and its scorecard, in any layout, for evaluation. Nothing needs approving. Add the form field `quick=1` to score every question once and skip the second look at each issue (faster, slightly less steady), and `runTwice=1` to do the whole check twice: the report then carries `twoRuns` (both scores, `average`, `gap`, `unstable`), the score and colour are the average's, and an unstable pair adds a "Needs attention" note (about twice the time and cost) |
| `POST /api/scorecards/import` | Show how a scorecard in any layout is converted into this app's format (multipart: `scorecard`, optional `document`). Optional: `POST /api/runs` converts it the same way |
| `POST /api/scorecards/check` | Re-check a hand-edited scorecard (YAML) and return it frozen |
| `GET /api/scorecard-template.xlsx` | Download a starter Excel scorecard |
| `DELETE /api/projects/:id` | Delete a project with all its runs, scores, findings and saved files (`204`; `409` while a run is in progress) |
| `DELETE /api/runs/:id` | Delete one run and its saved files; its project goes too when it was the last run (`204`; `409` while it is waiting or running; cancel a waiting one first) |
| `POST /api/runs/:id/cancel` | Take a **waiting** run out of the [line](#the-waiting-line) (`200` with the run, now `cancelled`; `409` once it has started or finished) |
| `GET /api/runs/:id` | One run: progress while running, the full report when done |
| `POST /api/runs/:id/override` | Optional: record a different verdict with a reason (nothing waits for it) |
| `GET /api/library` | The test library: each real file pair with its runs and the share of checked issues that are useful |
| `GET /api/library/reliability` | How often each model family's issues were right once checked (the saved table, or measured now if none is saved) |
| `GET /api/library/:id` | One test pair, with the verdict on every issue of its newest run |
| `GET /api/runs/:id/report.:ext` | Download the report as `xlsx`, `pdf`, `md` or `json` |

### `GET /api/config`

```json
{
  "mock": false,
  "ready": true,
  "promptVersion": "l1-prompts/1.8",
  "thresholds": { "accept": 75, "refine": 60 },
  "raters": [
    { "id": "A", "provider": "service-1", "model": "model-a", "family": "family-1", "keyPresent": true, "approved": true }
  ],
  "consolidator": { "id": "K", "provider": "service-1", "model": "model-k", "family": "family-1", "keyPresent": true, "approved": true },
  "problems": [{ "level": "error", "message": "Model B (service-2:model-b) has no API key. Set SERVICE_2_API_KEY in .env." }]
}
```

`ready` is `false` while any `problems` entry has `level: "error"`. Examiners 1, 2 and 3 are the `raters`, and the Final reviewer is the `consolidator`. API keys are never returned, only whether one is set.

### `POST /api/runs`

`multipart/form-data` (limit 25 MB per file):

| Field | Type | Required | Notes |
|---|---|---|---|
| `workbook` | file | yes | The file to check: `.xlsx`, `.csv` or `.pdf` |
| `scorecard` | file | yes | Any layout: `.xlsx`, `.csv`, `.pdf`, `.yaml`, `.yml`, `.json`, `.txt` or `.md`. One in this app's format (YAML/JSON with a `scorecard:` key, or the [Excel layout](scorecard-reference.md#writing-a-scorecard-in-excel)) is read as it is; any other is converted automatically by one model call, then cached under `data/scorecards/` and reused for every later submission of the same file. Every scorecard is frozen by its hash at submission; `frozen` in the file is optional |
| `projectName` | text | no | Reuse a name to add a **round** (iteration) to that project. Default: the workbook's file name |
| `sources` | text | no | Problem statement or docket the work is judged against |
| `instructions` | text | no | Extra instructions for the Examiners, up to 4000 characters. Sent to all three Examiners and the Final reviewer and **recorded in the report header with a hash**. They steer what to look at; the prompt rules say they can never change the scale, the evidence rule or the score |

```bash
curl -X POST http://localhost:4000/api/runs \
  -F workbook=@Talentra-schema.xlsx \
  -F scorecard=@talentra-schema-d2.yaml \
  -F projectName="Talentra schema"
```

Returns `202 Accepted`:

```json
{ "runId": "0b5a...", "projectId": "7c1e...", "iteration": 3 }
```

Every submission is checked **before** anything is stored or any model is called, and a problem comes back as a clear message, for
example: no file · an unsupported file type · the file is not a real workbook · the scorecard does not match the format
(the message lists the issues, and for an Excel scorecard names the sheet and row) · the instructions are too long · no model is ready to convert a scorecard in another layout (`409`) · it names a sheet or column the workbook does not
have · the roster is not ready (`409`).

### `GET /api/runs/:id`

Poll this. While `status` is `waiting`, `stage` is `waiting` and `queuePosition` is the place in line (1 = starts next); it is `null` otherwise. While running, `stage` is one of `queued`, `reading`, `checks`, `rating`, `consolidating`,
`reporting` and `progress.participants` shows each model's status. When `status` is `done`, `report` holds the
eight sections; when `failed`, `error` says why.

```json
{
  "id": "0b5a...", "projectId": "7c1e...", "projectName": "Talentra schema", "iteration": 3,
  "status": "done", "stage": "done", "gate": "D1", "scorecardId": "SC-TALENTRA-D2",
  "weightedScore": 87.5, "agentDecision": "amber", "finalDecision": "amber",
  "progress": { "participants": [{ "id": "A", "role": "rater", "model": "model-a", "status": "ok", "latencyMs": 8210 }] },
  "report": {
    "header": { "...": "ids, hashes, models, prompt version" },
    "verdict": { "weightedScore": 87.5, "decision": "amber", "agentDecision": "amber", "criticalGates": [], "reasons": [], "override": null },
    "dimensions": [], "findings": [], "agreement": [], "notMeasurable": [], "strengths": [],
    "pathToGreen": { "steps": [], "resultingScore": 90.2, "resultingDecision": "amber", "note": "" }
  },
  "runLog": { "...": "timings, tokens, attempts, prompt hashes" }
}
```

`report.findings` lists Confirmed issues first, then "Worth a look" ones. Each finding has optional `tier` (`confirmed` or `worth_a_look`), `tierReason` and `proof`; `report.tiers`
is `{ confirmed, worthALook }`. `verdict.blockingFindings`, the "Needs attention" must-fix note and `pathToGreen` count Confirmed issues only. Older saved runs get a tier when read. `report.cost` (optional) holds
`lines` (label, model, calls, inputTokens, outputTokens, cost or null), the totals, `currency` and `complete` (every model priced). All of these fields are optional, so older clients keep working.

`agentDecision` is what GateX concluded. `finalDecision` is the same unless an override was recorded.

### `GET /api/scorecard-template.xlsx`

Downloads a starter scorecard in the Excel layout. It is valid as it stands: one dimension counted by code and two scored by the
examiners. Edit the sheet names, columns, weights and anchors to fit your own workbook.

### The waiting line

Only **one** evaluation runs at a time (the setting `MAX_CONCURRENT_RUNS`, default `1`; see [operations](operations.md#one-check-at-a-time)). `POST /api/runs` still answers `202` straight away and saves the files, but when another run is going the new run is saved with `status: "waiting"` and starts by itself, first come first served, when the one before it finishes, fails or is cancelled. The answer says which happened:

```json
{ "runId": "9d2f...", "projectId": "7c1e...", "iteration": 4, "status": "waiting", "queuePosition": 2 }
```

`status` is `queued` or `running` with `queuePosition: null` when it started at once. `queuePosition` is also on every run in `GET /api/runs/:id`, `GET /api/projects` (`latest`) and `GET /api/projects/:id` (`runs`). Everything else (reading runs and reports, uploading, importing scorecards) stays free while a run is going. Run twice and Quick check wait in the same line, and the second look at each issue and the close-look pass happen inside the one run, so they never take a second place.

`POST /api/runs/:id/cancel` removes a waiting run from the line (it ends as `cancelled`, `error`: "Cancelled before it started.", uploads kept until the run is deleted). Asking again is harmless. A run that has already started cannot be stopped: the answer is `409` ("This check has already started and cannot be stopped. It finishes by itself."). After a server restart, a run that was mid-way is marked `failed`; runs that were waiting keep their place and continue by themselves.

### `POST /api/runs/:id/override`

```json
{ "decision": "red", "reason": "Schema is being replaced next week", "by": "Lead" }
```

Optional, and never required for a result. `decision` is `green`, `amber` or `red`; `reason` is required (at least 5 characters). GateX's own verdict stays
in `agentDecision` and in the report. Returns the updated run. Every question is marked automatically, so no extra input is needed.

### `GET /api/runs/:id/report.xlsx | .pdf | .md | .json`

The report as a downloadable file: the PDF's eight sections as a workbook (with a first sheet, "What to improve", that lists the fixes in order),
as a printable PDF that opens with the same list, as readable Markdown, or as JSON. `409` until the run has a finished report. `404` for any other extension.

Every finished report is also saved as these files under `data/reports/<project>/iteration-<n>/`, whatever the database mode.

### `POST /api/scorecards/import`

Multipart form with `scorecard` (any layout: `.xlsx`, `.pdf`, `.yaml`, `.json`, `.csv` or text) and an optional `document` (the `.xlsx` or `.pdf` it will judge,
so the conversion can name real sheets, columns or page ranges). Returns `{ yaml, questions, summary, uncertain, adjustments, sourceText, model, cached }`.
The YAML is frozen and ready to use. `questions` lists each question with who marks it (`examiners` or `code`), its weight, whether it is must-pass, and what it reads.
`cached: true` means an earlier conversion of the same file (against a file with the same sheets) was reused, with no model call; `POST /api/runs` uses that same conversion.

### `POST /api/scorecards/check`

JSON `{ yaml }`. Validates the YAML as a scorecard and returns it frozen: `{ yaml, summary }`, or `400` with the problems.

### `GET /api/projects/:id`

Returns the project, every run, and:

- `trend`: score and decision per finished round
- `dimensions`: each question's score per round, in the scorecard's own order (the heatmap)
- `findingDiffs`: per round, how many issues were `fixed`, are `stillOpen`, or are `added`
- `thresholds`: the thresholds of the latest scorecard (the colour rule itself is fixed: below 60 red, 60 to 74 amber, 75 and above green)

## Scripting example

```bash
# submit, then wait for the verdict
RUN=$(curl -s -X POST localhost:4000/api/runs -F workbook=@a.xlsx -F scorecard=@s.yaml | jq -r .runId)
until [ "$(curl -s localhost:4000/api/runs/$RUN | jq -r .status)" != "running" ] \
   && [ "$(curl -s localhost:4000/api/runs/$RUN | jq -r .status)" != "queued" ]; do sleep 2; done
curl -s localhost:4000/api/runs/$RUN | jq '{status, finalDecision, weightedScore, error}'
```
