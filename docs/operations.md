# Operations guide

How to install, set up, run and look after GateX. For what it does, see [agent.md](agent.md).

## Contents

1. [Prerequisites](#prerequisites)
2. [Install and first run](#install-and-first-run)
3. [Configuration](#configuration)
4. [Choosing and checking models](#choosing-and-checking-models)
5. [Database](#database)
6. [Running](#running)
7. [Cost and size](#cost-and-size)
8. [Backup and restore](#backup-and-restore)
9. [Upgrading](#upgrading)
10. [Putting it on a server](#putting-it-on-a-server)
11. [Check the set-up](#check-the-set-up-npm-run-doctor)
12. [When a run fails half-way](#when-a-run-fails-half-way)
13. [Old logs and scripts](#old-logs-and-scripts)
14. [Setup messages](#setup-messages)

## Prerequisites

| Need | For |
|---|---|
| Node.js 22 or newer (`.nvmrc` pins 22) | everything |
| Docker Desktop | Postgres for real use (optional for the demo) |
| API keys for your model services | real checks (not needed for the demo) |

## Install and first run

```bash
npm install
npm run build                    # builds the dashboard into web/dist
MOCK_LLM=1 npm run start         # demo: scripted models, in-memory database
```

Open http://localhost:4000: the GateX home page opens first, and the dashboard is at http://localhost:4000/projects. The dashboard sidebar says **Mock models (demo)**. The demo keeps its history in memory while the server runs; use Postgres (below) to keep it for good.

For real use:

```bash
cp .env.example .env             # fill in keys and DATABASE_URL
docker compose up -d db          # Postgres 16 on localhost:5432
npm run models:check -- --ping   # keys valid? models exist? do they answer?
npm run start
```

`npm run start` runs the database migrations first (they are safe to repeat), then serves the API and the dashboard.
During development use two terminals: `npm run dev:server` and `npm run dev:web` (http://localhost:5173, which proxies `/api`).

## Configuration

Settings come from the **environment**, loaded from `.env` in the project root (a `.env` inside `server/` is also read). A real environment
variable always wins over the file, so CI and containers can override it.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | empty | Postgres connection string. Empty means an **in-memory** database that forgets everything on exit |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, ... | empty | One key per model service used by the roster. The variable names come from `models.json` (`keyEnv`) |
| `PORT` | `4000` | HTTP port |
| `DATA_DIR` | `./data` (project root) | Where uploaded files are kept (`data/uploads/<run id>/`) |
| `MODELS_CONFIG` | `server/config/models.json` | Use a different roster file |
| `VERIFY_FINDINGS` | on | `0` = skip the second look at every issue (also `settings.verifyFindings` in the models file; a Quick check skips it too) |
| `MOCK_LLM` | unset | `1` = scripted models from `models.mock.json`, no API calls |
| `MOCK_DELAY_MS` | `700` | Pause per mock call so live progress is visible |
| `DB_MODE` | derived | `memory` forces the in-memory database even if `DATABASE_URL` is set |

Keys are read from the environment only. They are never written to the database, never logged and never sent to the browser.

### The roster file: `server/config/models.json`

```jsonc
{
  "approved": ["groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b", "groq:qwen/qwen3.8-27b", "gemini:gemini-3.5-flash", "gemini:gemini-3.1-flash-lite"],   // only these may receive project documents
  "providers": {
    "groq":   { "type": "openai-compatible", "baseUrl": "https://api.groq.com/openai/v1", "keyEnv": "GROQ_API_KEY" },
    "gemini": { "type": "gemini", "keyEnv": "GEMINI_API_KEY" }
  },
  "raters": [                                                  // Examiners 1, 2, 3: exactly three, three different families
    { "id": "A", "provider": "groq",   "model": "openai/gpt-oss-120b", "family": "openai" },
    { "id": "B", "provider": "gemini", "model": "gemini-3.5-flash",    "family": "google",
      "fallbacks": [{ "provider": "gemini", "model": "gemini-3.1-flash-lite" }] },
    { "id": "C", "provider": "groq",   "model": "qwen/qwen3.8-27b",    "family": "alibaba", "maxInputTokens": 30000 }
  ],
  "consolidator": { "id": "K", "provider": "groq", "model": "openai/gpt-oss-20b", "family": "openai" },
  "settings": { "temperature": 0, "maxOutputTokens": 8192, "timeoutMs": 120000, "retries": 3 }
}
```

| Field | Notes |
|---|---|
| `approved` | `provider:model` or `provider:*`. A model not listed is refused. This is the confidentiality control |
| `providers.*.type` | `openai-compatible` (many hosted services), `gemini`, `bedrock`, or `mock` |
| `raters` | Examiners 1, 2 and 3: exactly three. Their `family` values must differ |
| `family` | Free text naming the model family (`meta`, `google`, `openai` ...). The independence rule compares these |
| `maxInputTokens` | Optional. A prompt estimated above this fails that rater at once with advice, instead of sending a doomed request |
| `consolidator` | The Final reviewer. Ideally from a fourth family |
| `fallbacks` | Optional list of backup models, tried **in order** if the model cannot answer (busy, quota used up, prompt too large). A fallback answers as the same participant and **counts as the same family**, so the three raters stay three different families, and it must be on `approved` because it receives the documents. A fallback with no API key is skipped with a warning. The report names the model that really answered |
| `settings` | Temperature 0 for reproducibility; `retries` applies to rate limits, 5xx errors and timeouts |

The roster above is an example. Model availability differs by account, so run `models:check --ping` on your own keys and edit the file to
match what your account offers.

### Using Amazon Bedrock

One Bedrock API key can supply all three Examiners and the Final reviewer from different model families. It is a second roster file, switched on
with environment variables:

```
AWS_BEARER_TOKEN_BEDROCK=your-key
AWS_REGION=us-east-1
MODELS_CONFIG=server/config/models.bedrock.json
```

`models.bedrock.json` also sets `sectionConcurrency: 2` (two sections marked at the same time) and `repeats: 3` (each Examiner marks each
section three times and the median is kept, which steadies the marks). Set `repeats` to 1 to spend less. Enable each model for your account in
the Bedrock console, in that region. The model ids in `models.bedrock.json` are starting points: run `npm run models:check -- --ping` to see which
ids your account offers and that each one answers, then edit the file.

## Choosing and checking models

```bash
npm run models:check              # lists each provider's models and marks which roster models exist
npm run models:check -- --ping    # also sends one tiny prompt to every roster model
```

It prints a tick or a cross per model (key set, approved, offered by the provider, answers). It exits non-zero if
anything is wrong, so it can gate a deployment.

Choose models from **three different families** for Examiners 1, 2 and 3, and the Final reviewer ideally from a fourth. The PDF's reason:
Examiners from one family share blind spots, and three families give an independent view.

## Database

- **Results are always saved twice.** The database keeps the history shown in the dashboard (Postgres survives restarts; the in-memory demo database does not). Whatever the mode, every finished report is also written to `data/reports/<project>/iteration-<n>/` as `report.json`, `report.md`, `report.xlsx` and `report.pdf`, and rewritten if an override is recorded.
- **Whole app in Docker**: `docker compose up --build` starts Postgres and the evaluator together (open http://localhost:4000); `MOCK_LLM=1 docker compose up` runs it on scripted models. The app container reads keys and `MODELS_CONFIG` from `.env`, talks to the database container, and keeps uploads in `./data`.
- **Start only the database**: `docker compose up -d db` (Postgres 16, user / password / database all `ddd`, port 5432, data in the
  `ddd_pgdata` volume, so it survives restarts and `docker compose down`).
- **Migrate**: automatic on server start, or `npm run db:migrate` (safe to repeat; applied files are recorded in `schema_migrations`).
- **Look inside**: connect any client (psql, DBeaver, TablePlus, pgAdmin) to `localhost:5432`. Useful tables:
  `runs`, `dimension_scores`, `findings`, `model_calls` (every prompt and raw reply), `overrides`.
  See the [data model](architecture.md#data-model).
- **Example queries**

```sql
-- score trend of every project
select p.name, r.iteration, r.weighted_score, r.agent_decision, r.final_decision
from runs r join projects p on p.id = r.project_id where r.status = 'done' order by p.name, r.iteration;

-- every override, with its reason
select p.name, r.iteration, o.decision, o.reason, o.by_name, o.created_at
from overrides o join runs r on r.id = o.run_id join projects p on p.id = r.project_id;

-- claims that models made without evidence (and were set aside)
select run_id, participant_id, jsonb_array_length(discarded) as discarded from model_calls where jsonb_array_length(discarded) > 0;
```

- **Start fresh**: `docker compose down -v` removes the volume and all saved data, so use it only when you want a clean slate.

## Running

| Purpose | Command |
|---|---|
| Production-style | `npm run build && npm run start` (API + built dashboard on one port) |
| Development | `npm run dev:server` and `npm run dev:web` |
| One-off check, no server or database | `npm run evaluate -- --workbook a.xlsx --scorecard s.yaml [--mock] [--out dir]` |
| Demo data | `npm run seed:demo -w server` (needs the server running) |

Paths given to `npm run evaluate` are resolved from the directory you typed the command in.

**Liveness**: `GET /api/health`. **Logs**: console, prefixed `[ddd]`. Stop with Ctrl-C; the server finishes
in-flight runs before exiting. A run that was still going when the process stopped is closed on the next
start with the message "The server stopped before this evaluation finished. Submit it again."

## Cost and size

Each check makes **four model calls** (Examiners 1, 2 and 3, and the Final reviewer), and each call carries your file. The size of a prompt depends
on your file and scorecard, and it is estimated at about 2.7 characters per token. Each service counts a little differently, and the run records
the real counts.

- Extra instructions (up to 4,000 characters, roughly 1,000 tokens) are added to every call, so a few clear sentences are best.
- **At submit, GateX measures the prompt against each Examiner's `maxInputTokens`** and tells you in plain words if fewer than two Examiners
  can take it, instead of failing later. To make a prompt smaller, use a model or plan with a larger limit, `columns` in the scorecard, or `reads`
  on the questions. `maxInputTokens` belongs to your account: raise or remove it when you move to a bigger plan.
- Rate limits and busy periods are retried with back-off, honouring `Retry-After`, up to `retries` times.
- **Sectioned scoring**: a question can list the sheets and columns it needs (`reads`), and each group of questions is sent as its own smaller
  prompt. The size check judges every section on its own. See *Sectioned scoring* in the scorecard reference. Run
  `npm run prompt:size -- <workbook> <scorecard>` to see, without calling any model, how big each prompt is and which Examiners can take it.

## Backup and restore

State lives in two places: the **database** and the **uploads folder** (`DATA_DIR`). Back up both.

```bash
# database (standard Postgres tools; container name from docker-compose.yml)
docker exec ddd-postgres pg_dump -U ddd ddd > ddd-backup.sql
docker exec -i ddd-postgres psql -U ddd ddd < ddd-backup.sql        # restore into an empty database

# uploaded files
tar czf ddd-uploads.tgz data/uploads
```

The `model_calls` table contains the full prompts, which include the content of your files. Keep backups as safe as the files themselves.

## Upgrading

1. Stop the server.
2. Pull the new code, `npm install`, `npm run build`.
3. Start it: new migrations are applied automatically. Migrations only ever add; they are never edited once released.
4. Every run records its `PROMPT_VERSION`, so you can always see which instructions produced a score.

## Putting it on a server

One small server (for example an AWS Lightsail instance with 2 to 4 GB of memory and Docker installed) is enough. Keep the address inside your
company network or VPN, or put it behind a proxy with sign-in.

1. Copy the project to the server and create `.env` from `.env.example`.
2. Set `POSTGRES_PASSWORD` to a long random value (`openssl rand -hex 24`) **before the first start**. Postgres keeps the password it was
   first created with, so changing it later means changing it inside the database too.
3. Add your model keys. For automatic HTTPS, point your domain at the server and set `DOMAIN` in `.env`.
4. `docker compose --profile https up -d --build`

`Caddyfile` is the only thing open to the internet (ports 80 and 443). The app and the database listen on the server itself only, so
neither can be reached from outside. Without `DOMAIN`, Caddy serves plain `http` on port 80. Open ports 22, 80 and 443 in the firewall and
no others. The saved reports and uploads are in `data/`, the database in the `ddd_pgdata` volume: back both up (see
[Backup and restore](#backup-and-restore)), for example with a Lightsail snapshot.

The image runs as an ordinary user, not root, and has a health check (`docker ps` shows `healthy`). On Linux, `data/` must be writable by
user id 1000, the default first user: `sudo chown -R 1000:1000 data`.

Reports and projects can be deleted from the dashboard (a confirmation first). Deleting removes the database rows and the saved files for them.

## Check the set-up: `npm run doctor`

```bash
npm run doctor
```

Says in plain words whether this machine is ready: Node version, whether `.env` exists (it shows setting **names** only, never values), whether the
models file reads and has a key for every provider it uses, whether the database answers (when `DATABASE_URL` is set), and whether `data/` is writable.
Each line starts with `OK`, `CHECK` (worth a look) or `NEEDS FIX` (with the next step). It exits non-zero only when something needs fixing, and it makes no model call.

## When a run fails half-way

What happens today: if a model service goes down in the middle of a run, the run is saved as **failed** with the error message only. The marks
that finished before the outage are **not kept**, so submitting the same files again starts from the beginning (and pays for the finished sections again). A
single rater failing is different: the other raters carry on, a fallback model is tried first, and the run still finishes.
The same happens to a run cut short by a server restart ("the server stopped before this evaluation finished").

Why it is not built: `evaluate()` in `server/src/agent/orchestrator.ts` keeps the section results in memory only, and repeated marks of the same prompt
are *meant* to differ (the median of `repeats` calls steadies the score), so a plain "same prompt, same model" cache would collapse them.

Recommended approach if it is needed (a small, safe change, not done yet):
1. In `service.ts` wrap the provider factory in a caching layer, outside the agent. Key: hash of model + system prompt + user prompt + **call number** (the n-th identical call in this run). Store the reply in `data/cache/<hash>.json` only after a successful reply.
2. Use the cache only when a run is submitted as a **re-run of a failed run** (a new "Resume" button, or `resumeOf` on the request) and give it the failed run's cache folder. Normal runs never read it, so scores stay independent.
3. Show "N model calls reused" in the report notes so the saving is visible, and delete the cache folder when the run finishes.
Until then: if a run fails on a model outage, wait for the service to recover (or use a Quick check) and submit it again.

## Old logs and scripts

Logs and helper scripts from past live runs (`docker-build*.log`, `live-*.log`, `run-*.sh`, `planted-*.log`, `swing-run-*.log`) are kept in `data/archive/`. `data/` is not committed, so they are only on this machine.

## Setup messages

GateX says in plain words what to do. The common ones:

| You see | What it means | What to do |
|---|---|---|
| `The evaluator roster is not ready: Model B (...) has no API key. Set GEMINI_API_KEY in .env.` | A service in the roster needs its key | Add the key to `.env`, restart |
| `... is not on the approved list, so it may not receive project documents.` | The model is not in `approved` | Add `provider:model` to `models.json` if your organisation permits |
| `The three raters must come from three different model families.` | Two Examiners share a `family` | Give one Examiner another family |
| `No model is ready to read this scorecard.` | A scorecard in another layout needs one model call to convert | Add a key (`npm run models:check`), or use a scorecard in the app's format |
| `<file> does not match the scorecard format:` followed by a list | The YAML is valid but a field is off | Fix the listed fields; see [scorecard-reference.md](scorecard-reference.md) |
| `<file> is not valid YAML or JSON: Nested mappings are not allowed...` | A value contains `: ` | Put the value in quotes |
| `my.xlsx does not match the scorecard format: Dimensions sheet, row 7 (J03): ...` | An Excel scorecard row needs a fix | Fix the named sheet and row; see [scorecard-reference.md](scorecard-reference.md#writing-a-scorecard-in-excel) |
| `The Excel scorecard needs a sheet called "Dimensions"` | The workbook lacks one of the three sheets | Start from the template on the **Check a new file** page |
| A converted scorecard reads differently from what you meant | The converted scorecard in `data/scorecards/` is reused every time | Delete that scorecard's `.json` file there to convert again, or download the YAML from *Convert a scorecard*, edit it and add that |
| `The scorecard names a sheet "X" that this workbook does not have. Sheets found: ...` | Sheet name or file differs | Correct the sheet name |
| `Column "X" named by the scorecard was not found in sheet "Y". Columns: ...` | A column title in `columns` differs | Use the exact header title |
| `This evaluation sends about N tokens to each rater, but only 1 of 3 raters can take that` | The prompt is larger than the limits set for the Examiners | Add `columns`, use `reads`, or give an Examiner a model or plan with a larger limit |
| `Cannot reach Postgres at localhost:5432. DATABASE_URL is set but nothing is answering there.` | `DATABASE_URL` is in `.env` but Postgres is not running | `docker compose up -d db`, or remove `DATABASE_URL` to use the in-memory demo database |
| `Postgres at ... rejected the user or password` / `has no such database` | `DATABASE_URL` differs from the database | Match `docker-compose.yml` (`ddd` / `ddd` / `ddd`) |
| The dashboard shows "Mock models (demo)" | `MOCK_LLM=1` is set | Unset it to use real models |
| History is empty after a restart | `DATABASE_URL` is empty, so the in-memory database was used | Set `DATABASE_URL` |
