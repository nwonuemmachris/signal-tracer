# Signal Tracer
1. Supabase: create a project, run `sql/schema.sql`, create a user under Authentication > Users, then run the `insert into admin_users` line at the bottom of the schema file.
2. `cp .env.example .env` and fill in URL, anon key, service-role key.
3. `npm install && npm start` -> http://localhost:3000 (viewer) and /admin.html (admin).
4. Excel: Download button on the admin page, or `npm run export` (writes exports/signals.xlsx). Set AUTO_EXPORT=true to refresh that file after every save.

## Live Google Sheet
1. console.cloud.google.com: create a project, enable the **Google Sheets API**.
2. IAM & Admin > Service Accounts: create one, then Keys > Add key > JSON. Save the file as `google-service-account.json` in the project root (never commit it).
3. Create a Google Sheet and **Share** it (Editor) with the service account's `client_email`.
4. Put the sheet ID (the long part of its URL) in `.env` as `GOOGLE_SHEET_ID`.
5. Every admin save/delete now rewrites the "Signals" tab. `npm run sync-sheet` or the admin button forces a refresh. Edit data in the admin page, not the sheet: the sheet is overwritten from the database.

## Upgrading an existing database (locations)
Run `sql/migration-002-locations.sql` in the Supabase SQL Editor once (adds `equipment.location`).

## Importing the master datasheet
1. Run `sql/migration-003-import-fields.sql` once (signal code, terminal group, terminal no).
2. Preview first: `npm run import -- master.xlsx --dry-run`
3. Real run: `npm run import -- master.xlsx --unit "Packing plant"`
Safe to run repeatedly and after manual entry: signals match on equipment tag + PLCRef (case-insensitive), so nothing is duplicated, only empty fields are filled, and JB routes/locations are never touched. Add `--overwrite` to make Excel replace values you typed by hand. Run it once per unit/sheet (`--sheet "Name"`).

## Activity log
Run `sql/migration-004-audit.sql` once. After that:
- Every create, edit and delete is recorded with the admin's email, the time, and exactly which fields changed (old -> new). Deletes keep a full copy of the signal.
- Logins, Excel downloads, manual sheet syncs and imports are recorded too (imports show as `import-script`, or set `IMPORT_ACTOR=your.name npm run import ...`).
- Each signal shows "Last changed" (who and when) on the admin list, and in the Excel file and Google Sheet.
- The log is append-only in the database, so history can't be edited or deleted from the app. Edits made directly in the Supabase dashboard are not captured.
- Use one Supabase login per person so the log shows who did what.
