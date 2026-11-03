-- Only needed if you already ran schema.sql before locations existed
alter table equipment add column if not exists location text;
