-- Run once in Supabase SQL Editor (signal code + terminal location on the I/O panel)
alter table signals
  add column if not exists signal_code text,
  add column if not exists ter_grp text,
  add column if not exists ter_no text;
create index if not exists signals_code_idx on signals (signal_code);
