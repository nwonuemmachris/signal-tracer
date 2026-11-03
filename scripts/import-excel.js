// Bulk-load the master datasheet without duplicating or damaging manual entries.
//   node scripts/import-excel.js master.xlsx --dry-run            (preview only, writes nothing)
//   node scripts/import-excel.js master.xlsx --unit "Packing plant" [--sheet "Sheet1"] [--overwrite]
//
// Matching key = equipment tag (case-insensitive) + PLCRef (case-insensitive), the same key the admin form uses.
// So a signal you already typed by hand is UPDATED in place, never duplicated.
// Safe by default: only EMPTY fields are filled from Excel. Hand-typed values are kept (use --overwrite to let Excel win).
// JB routes, JB locations and equipment locations are never touched by this script.
const ExcelJS = require('exceljs');
const { admin } = require('../lib/db');
const sheets = require('../lib/sheets');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : undefined; };
const file = args.find(a => /\.xls[xm]$/i.test(a));
const DRY = args.includes('--dry-run'), OVER = args.includes('--overwrite');
const UNIT = opt('unit') || 'Unassigned';
const ACTOR = process.env.IMPORT_ACTOR || 'import-script', NOW = new Date().toISOString();
if (!file) { console.error('Usage: node scripts/import-excel.js master.xlsx [--unit "Name"] [--sheet "Name"] [--dry-run] [--overwrite]'); process.exit(1); }

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const txt = c => { let v = c?.value ?? ''; if (v && typeof v === 'object') v = v.result ?? v.text ?? (v.richText || []).map(r => r.text).join(''); return clean(v); };
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS = {
  code: ['signalcode', 'code', 'signal', 'signaltag'], plc: ['plcref', 'plcreference', 'plcaddress'],
  obj: ['objectdescription', 'objectdesc', 'object'], desc: ['signaldescription', 'signaldesc', 'description'],
  type: ['iotype', 'io', 'type', 'signaltype'], panel: ['panel', 'iopanel'],
  grp: ['tergrp', 'terminalgroup', 'tgroup'], no: ['terno', 'terminalno', 'terminalnumber']
};

async function readRecords() {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const ws = opt('sheet') ? wb.getWorksheet(opt('sheet')) : wb.worksheets[0];
  if (!ws) throw new Error('Sheet not found. Available: ' + wb.worksheets.map(w => w.name).join(', '));
  let col, hr;
  for (let r = 1; r <= 20 && !hr; r++) {           // find the header row
    const m = {}, used = new Set();
    ws.getRow(r).eachCell((c, n) => { const h = norm(txt(c)); for (const k in ALIAS) if (!m[k] && !used.has(n) && ALIAS[k].includes(h)) { m[k] = n; used.add(n); } });
    if (m.code && m.plc) { col = m; hr = r; }
  }
  if (!hr) throw new Error('Could not find a header row with a signal code column and a PLCRef column in the first 20 rows.');
  console.log(`Sheet "${ws.name}", header row ${hr}. Columns found: ` + Object.entries(col).map(([k, n]) => `${k}=${n}`).join(', '));
  const missing = Object.keys(ALIAS).filter(k => !col[k]); if (missing.length) console.log('Not found (will be left empty): ' + missing.join(', '));
  const recs = [], skipped = [];
  for (let r = hr + 1; r <= ws.rowCount; r++) {
    const g = k => (col[k] ? txt(ws.getRow(r).getCell(col[k])) : '');
    const rec = { row: r, code: g('code'), io: g('plc'), obj: g('obj'), desc: g('desc'), type: g('type').toUpperCase(), panel: g('panel'), grp: g('grp'), no: g('no') };
    if (!rec.code && !rec.io) continue;                                   // blank row
    if (!rec.code || !rec.io) { skipped.push(`row ${r}: missing ${rec.code ? 'PLCRef' : 'signal code'}`); continue; }
    rec.tag = rec.code.split('_')[0];                                     // K309_NEW_PWR_ON -> K309
    recs.push(rec);
  }
  return { recs, skipped };
}

async function fetchAll(table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select(select).order('id').range(from, from + 999);
    if (error) throw error; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const must = ({ data, error }) => { if (error) throw error; return data; };

(async () => {
  const { recs, skipped } = await readRecords();
  const [units, eqs, sigs] = await Promise.all([fetchAll('units', 'id, name'), fetchAll('equipment', 'id, tag, description, unit_id'), fetchAll('signals', 'id, equipment_id, io_number, signal_code, io_panel, ter_grp, ter_no, signal_type, description')]);

  let unit = units.find(u => u.name.toLowerCase() === UNIT.toLowerCase());
  const unitIsNew = !unit;
  if (unitIsNew && !DRY) unit = must(await admin.from('units').insert({ name: UNIT }).select('id, name').single());
  const unitId = unit?.id ?? null;

  const eqMap = new Map(eqs.map(e => [e.tag.toLowerCase(), e]));
  const sigMap = new Map(sigs.map(s => [s.equipment_id + '|' + s.io_number.toLowerCase(), s]));
  const newEq = new Map(), eqPatch = [], newSigs = [], sigPatch = [], conflicts = [], dupes = [], seen = new Map();
  let unchanged = 0;

  for (const r of recs) {
    const ek = r.tag.toLowerCase(), key = ek + '|' + r.io.toLowerCase();
    if (seen.has(key)) { dupes.push(`row ${r.row} repeats row ${seen.get(key)} (${r.tag} / ${r.io}); ignored`); continue; }
    seen.set(key, r.row);
    const fields = { signal_code: r.code, io_panel: r.panel, ter_grp: r.grp, ter_no: r.no, signal_type: r.type, description: r.desc };

    const eq = eqMap.get(ek);
    if (!eq) { if (!newEq.has(ek)) newEq.set(ek, { tag: r.tag, description: r.obj || null, unit_id: unitId }); }
    else {
      const p = {};
      if (r.obj && (!eq.description || (OVER && eq.description !== r.obj))) p.description = r.obj;
      if (!eq.unit_id && unitId) p.unit_id = unitId;
      if (Object.keys(p).length) eqPatch.push({ id: eq.id, p });
    }

    const ex = eq && sigMap.get(eq.id + '|' + r.io.toLowerCase());
    if (!ex) { newSigs.push({ ek, io_number: r.io, unit_id: eq?.unit_id || unitId, ...fields }); continue; }
    const p = {};
    for (const [k, nv] of Object.entries(fields)) {
      if (!nv) continue;
      if (!ex[k]) p[k] = nv;
      else if (ex[k] !== nv) { if (OVER) p[k] = nv; else conflicts.push(`${r.tag} / ${r.io}: ${k} kept "${ex[k]}" (Excel says "${nv}")`); }
    }
    Object.keys(p).length ? sigPatch.push({ id: ex.id, p }) : unchanged++;
  }

  if (!DRY) {
    for (const c of chunks([...newEq.values()], 500)) must(await admin.from('equipment').insert(c).select('id, tag, unit_id')).forEach(e => eqMap.set(e.tag.toLowerCase(), e));
    for (const { id, p } of eqPatch) must(await admin.from('equipment').update(p).eq('id', id).select('id'));
    const rows = newSigs.map(({ ek, ...s }) => ({ ...s, equipment_id: eqMap.get(ek).id, updated_by: ACTOR, updated_at: NOW }));
    for (const c of chunks(rows, 500)) must(await admin.from('signals').upsert(c, { onConflict: 'equipment_id,io_number', ignoreDuplicates: true }).select('id'));
    for (const c of chunks(sigPatch, 10)) await Promise.all(c.map(async ({ id, p }) => must(await admin.from('signals').update({ ...p, updated_by: ACTOR, updated_at: NOW }).eq('id', id).select('id'))));
  }

  if (!DRY) await admin.from('audit_log').insert({ user_email: ACTOR, action: 'import', item: require('path').basename(file), summary: `${newSigs.length} new signals, ${sigPatch.length} updated, ${newEq.size} new equipment`, details: { unit: UNIT, overwrite: OVER, conflicts_kept: conflicts.length } });
  const show = (t, a) => a.length && console.log(`\n${t} (${a.length}):\n  ` + a.slice(0, 20).join('\n  ') + (a.length > 20 ? `\n  …and ${a.length - 20} more` : ''));
  console.log(`\n${DRY ? 'DRY RUN, nothing written. ' : 'Done. '}Rows read: ${recs.length}`);
  console.log(`  New equipment: ${newEq.size}   Equipment updated: ${eqPatch.length}${unitIsNew ? `   New unit: "${UNIT}"` : ''}`);
  console.log(`  New signals: ${newSigs.length}   Existing signals filled/updated: ${sigPatch.length}   Already identical: ${unchanged}`);
  show('Skipped rows', skipped); show('Duplicates inside the Excel file', dupes); show(`Manual values kept (use --overwrite to replace)`, conflicts);
  if (!DRY && sheets.enabled()) { await sheets.sync(); console.log('\nGoogle Sheet refreshed.'); }
})().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
