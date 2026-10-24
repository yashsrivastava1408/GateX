-- A project keeps the scorecard its first iteration was converted to, one per uploaded scorecard file (by its hash),
-- so every later iteration is marked against the identical target, even if the workbook's sheets are renamed or added.
create table scorecard_pins (
  project_id       text not null references projects(id),
  source_hash      text not null,
  source_name      text not null,
  scorecard_hash   text not null,
  scorecard        jsonb not null,
  pinned_iteration integer not null,
  created_at       timestamptz not null default now(),
  primary key (project_id, source_hash)
)
