-- One evaluation at a time: a submitted run can wait its turn. It keeps its uploads and the choices made at submit
-- (quick check, run twice, scorecard notes) so it can start by itself later, even after a server restart.
-- queue_no is the place in the line (smaller goes first); it is set when the run is saved and never reused.
alter table runs add column queue_no bigint;
alter table runs add column run_options jsonb;
create index runs_waiting_idx on runs (status, queue_no)
