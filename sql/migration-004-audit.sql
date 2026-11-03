-- Run once in Supabase SQL Editor: activity log + "last changed by" on each signal
alter table signals add column if not exists updated_at timestamptz, add column if not exists updated_by text;

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  user_email text not null,        -- stored as text so history survives if an account is deleted
  action text not null,            -- create, update, delete, import, export, sheet_sync, login
  item text,                       -- e.g. "K309 / AI-03-05"
  summary text,                    -- human readable: "io_panel: A -> B; route changed"
  details jsonb,                   -- full before/after for updates, full snapshot for deletes
  signal_id uuid                   -- no foreign key on purpose: the log outlives deleted signals
);
create index if not exists audit_log_at_idx on audit_log (at desc);
alter table audit_log enable row level security;

-- Append-only: nobody (not even the backend) can edit or erase history
create or replace function audit_log_readonly() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
drop trigger if exists audit_log_no_change on audit_log;
create trigger audit_log_no_change before update or delete on audit_log for each row execute function audit_log_readonly();
