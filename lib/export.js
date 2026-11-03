const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { admin } = require('./db');

// Rebuilds the whole workbook from the database (database = single source of truth)
async function fetchTable() {
  const { data, error } = await admin.from('signals').select(
    '*, unit:units(name), equipment(tag, location), hops:signal_hops(seq, jb_tag, jb:junction_boxes(jb_number, type, location))'
  );
  if (error) throw error;
  data.sort((a, b) => (a.unit?.name || '').localeCompare(b.unit?.name || '') || a.io_number.localeCompare(b.io_number));

  const maxHops = Math.max(1, ...data.map(s => s.hops.length));
  const cols = ['Unit', 'Equipment tag', 'I/O panel', 'I/O number', 'Signal type', 'Description', 'Tag inside equipment', 'Equipment location', 'Signal code', 'Terminal group', 'Terminal no', 'Last changed by', 'Last changed at'];
  for (let i = 1; i <= maxHops; i++) cols.push(`JB${i} number`, `JB${i} cable tag`, `JB${i} location`);
  const rows = data.map(s => {
    const row = [s.unit?.name, s.equipment?.tag, s.io_panel, s.io_number, s.signal_type, s.description, s.equipment_terminal, s.equipment?.location, s.signal_code, s.ter_grp, s.ter_no, s.updated_by, s.updated_at ? s.updated_at.slice(0, 16).replace('T', ' ') : ''];
    s.hops.sort((a, b) => a.seq - b.seq).forEach(h => row.push(h.jb?.jb_number, h.jb_tag, h.jb?.location));
    return row.map(v => v ?? '');
  });
  return { cols, rows };
}

async function exportExcel(file = path.join(__dirname, '..', 'exports', 'signals.xlsx')) {
  const { cols, rows } = await fetchTable();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Signals', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(cols).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2DC' } };
  rows.forEach(r => ws.addRow(r));
  ws.columns.forEach(c => (c.width = 20));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return { file, rows: rows.length };
}

module.exports = exportExcel;
module.exports.fetchTable = fetchTable;
