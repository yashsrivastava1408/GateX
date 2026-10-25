-- A person's own marks for a finished check, kept next to GateX's so the two can be compared (shadow mode),
-- and a person's verdict on each issue (right, wrong or unclear). Both feed the accuracy page as human evidence.
create table human_reviews (
  id         text primary key,
  run_id     text not null references runs(id),
  reviewer   text not null,
  verdict    text,
  scores     jsonb not null,
  note       text,
  created_at timestamptz not null default now()
);

create index human_reviews_run_idx on human_reviews (run_id);

create table finding_feedback (
  run_id     text not null references runs(id),
  finding_id text not null,
  who        text not null,
  label      text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (run_id, finding_id, who)
)
