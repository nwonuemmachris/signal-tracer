-- Run in Supabase > SQL Editor
create extension if not exists "pgcrypto";

create table units (id uuid primary key default gen_random_uuid(), name text unique not null);

create table equipment (
  id uuid primary key default gen_random_uuid(),
  tag text unique not null,
  description text,
  location text,                 -- where the sensor/equipment physically is
  unit_id uuid references units(id) on delete cascade
);

create table junction_boxes (
  id uuid primary key default gen_random_uuid(),
  jb_number text unique not null,
  type text check (type in ('IJB','CJB')) default 'IJB',
  location text
);

create table signals (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id) on delete cascade,
  equipment_id uuid references equipment(id) on delete cascade,
  io_panel text,                 -- e.g. PNL-PK-01
  io_number text not null,       -- label on the interface module, e.g. AI-03-05
  equipment_terminal text,       -- specific tag inside the equipment (e.g. TB1-4)
  signal_type text,              -- AI, AO, DI, DO
  description text,
  signal_code text,              -- full code from the master sheet, e.g. K309_NEW_PWR_ON
  ter_grp text,                  -- terminal group on the I/O panel
  ter_no text,                   -- terminal number in that group
  unique (equipment_id, io_number)
);

create table signal_hops (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references signals(id) on delete cascade,
  seq int not null,              -- order from I/O panel towards field
  jb_id uuid references junction_boxes(id),
  jb_tag text,                   -- cable/terminal tag written in THAT junction box
  unique (signal_id, seq)
);

-- Only people listed here may edit data
create table admin_users (user_id uuid primary key references auth.users(id) on delete cascade);

-- Browsers never touch the DB directly; the Node backend uses the service key
alter table units enable row level security;
alter table equipment enable row level security;
alter table junction_boxes enable row level security;
alter table signals enable row level security;
alter table signal_hops enable row level security;
alter table admin_users enable row level security;

-- After creating your admin user in Authentication > Users, run:
-- insert into admin_users (user_id) select id from auth.users where email = 'you@company.com';

-- Activity log (added later; same as migration-004)
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
