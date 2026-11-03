const path = require('path');
const { google } = require('googleapis');
const { fetchTable } = require('./export');

const TAB = 'Signals';
exports.enabled = () => !!(process.env.GOOGLE_SHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE));

async function write() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = raw ? JSON.parse(raw) : require(path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_FILE));
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const api = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await api.spreadsheets.get({ spreadsheetId });
  if (!meta.data.sheets.some(s => s.properties.title === TAB))
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }] } });

  const { cols, rows } = await fetchTable();
  await api.spreadsheets.values.clear({ spreadsheetId, range: TAB });
  await api.spreadsheets.values.update({ spreadsheetId, range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [cols, ...rows] } });
  return { rows: rows.length };
}

// Rapid saves are merged: if a sync is running, one more run is queued and picks up the latest data.
let running = null, queued = false;
exports.sync = async function sync() {
  if (running) { queued = true; return running; }
  running = write().finally(() => { running = null; });
  const result = await running;
  if (queued) { queued = false; exports.sync().catch(e => console.error('Sheet sync failed:', e.message)); }
  return result;
};
