const express = require('express');
const path = require('path');
const { admin, anon } = require('./lib/db');
const exportExcel = require('./lib/export');
const sheets = require('./lib/sheets');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.message }));
const fail = (status, message) => Object.assign(new Error(message), { status });

/* ---------- audit log ---------- */
async function audit(user, action, item, summary, details = null, signalId = null) {
  const { error } = await admin.from('audit_log').insert({ user_id: user?.id || null, user_email: user?.email || 'unknown', action, item, summary, details, signal_id: signalId });
  if (error) console.error('Audit log failed:', error.message);   // never block the admin's work because logging failed
}
async function flatSignal(id) {   // one signal in the same flat shape the admin form uses
  const { data: s } = await admin.from('signals')
    .select('*, unit:units(name), equipment(tag, description, location), hops:signal_hops(seq, jb_tag, jb:junction_boxes(jb_number, type, location))')
    .eq('id', id).maybeSingle();
  if (!s) return null;
  s.hops.sort((a, b) => a.seq - b.seq);
  return {
    id: s.id, unit: s.unit?.name, equipment_tag: s.equipment?.tag, equipment_desc: s.equipment?.description, equipment_location: s.equipment?.location,
    io_panel: s.io_panel, io_number: s.io_number, equipment_terminal: s.equipment_terminal,
    signal_type: s.signal_type, description: s.description, signal_code: s.signal_code, ter_grp: s.ter_grp, ter_no: s.ter_no,
    hops: s.hops.map(h => ({ jb_type: h.jb?.type, jb_number: h.jb?.jb_number, jb_tag: h.jb_tag, jb_location: h.jb?.location }))
  };
}
function diff(a, b) {
  const ch = {};
  for (const k of Object.keys(b)) if (k !== 'id' && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) ch[k] = [a[k] ?? null, b[k] ?? null];
  return ch;
}
const short = v => (v == null || v === '' ? '—' : String(v).slice(0, 40));
const summarize = ch => Object.entries(ch).map(([k, [o, n]]) => (k === 'hops' ? 'route changed' : `${k}: ${short(o)} → ${short(n)}`)).join('; ');

/* ---------- auth ---------- */
async function requireAdmin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) throw fail(401, 'Please sign in again.');
    const { data: row } = await admin.from('admin_users').select('user_id').eq('user_id', data.user.id).maybeSingle();
    if (!row) throw fail(403, 'This account is not an admin.');
    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}

app.post('/api/login', wrap(async (req, res) => {
  const { data, error } = await anon.auth.signInWithPassword(req.body);
  if (error) throw fail(401, error.message);
  await audit({ id: data.user.id, email: data.user.email }, 'login', null, 'Signed in');
  res.json({ token: data.session.access_token });
}));

/* ---------- public read ---------- */
app.get('/api/units', wrap(async (req, res) => {
  const { data, error } = await admin.from('units').select('name').order('name');
  if (error) throw error;
  res.json(data.map(u => u.name));
}));

app.get('/api/signals', wrap(async (req, res) => {
  let q = admin.from('signals').select('id, io_panel, io_number, signal_code, ter_grp, ter_no, signal_type, description, equipment_terminal, unit:units!inner(name), equipment(tag), hops:signal_hops(seq)').order('io_number');
  if (req.query.unit) q = q.eq('unit.name', req.query.unit);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
}));

// Everything the drawing needs for one signal, ordered I/O -> JBs -> equipment
app.get('/api/path', wrap(async (req, res) => {
  const { equipment, io } = req.query;
  const { data: eq } = await admin.from('equipment').select('id, tag, description, location').ilike('tag', equipment || '').maybeSingle();
  if (!eq) throw fail(404, `No equipment with tag "${equipment}".`);
  const { data: s, error } = await admin.from('signals')
    .select('*, hops:signal_hops(seq, jb_tag, jb:junction_boxes(jb_number, type, location))')
    .eq('equipment_id', eq.id).ilike('io_number', io || '').maybeSingle();
  if (error) throw error;
  if (!s) throw fail(404, `${eq.tag} has no signal with I/O number "${io}".`);
  s.hops.sort((a, b) => a.seq - b.seq);
  res.json({ equipment: eq, signal: s });
}));

/* ---------- admin write ---------- */
async function ensure(table, key, row) {
  const { data, error } = await admin.from(table).upsert(row, { onConflict: key }).select().single();
  if (error) throw error;
  return data;
}

app.post('/api/admin/signal', requireAdmin, wrap(async (req, res) => {
  const b = req.body;
  if (!b.unit || !b.equipment_tag || !b.io_number) throw fail(400, 'Unit, equipment tag and I/O number are required.');
  const unit = await ensure('units', 'name', { name: b.unit.trim() });
  const eq = await ensure('equipment', 'tag', { tag: b.equipment_tag.trim(), unit_id: unit.id, ...(b.equipment_desc ? { description: b.equipment_desc } : {}), ...(b.equipment_location ? { location: b.equipment_location } : {}) });
  const row = {
    unit_id: unit.id, equipment_id: eq.id, io_number: b.io_number.trim(), io_panel: b.io_panel || null,
    equipment_terminal: b.equipment_terminal || null, signal_type: b.signal_type || null, description: b.description || null,
    signal_code: b.signal_code || null, ter_grp: b.ter_grp || null, ter_no: b.ter_no || null,
    updated_at: new Date().toISOString(), updated_by: req.user.email
  };
  let before = b.id ? await flatSignal(b.id) : null;
  if (!before && !b.id) {
    const { data: ex } = await admin.from('signals').select('id').eq('equipment_id', eq.id).ilike('io_number', b.io_number.trim()).maybeSingle();
    if (ex) before = await flatSignal(ex.id);
  }
  let sig;
  if (b.id) {   // editing an existing signal: update that row, even if its tag / I/O number changed
    const { data, error } = await admin.from('signals').update(row).eq('id', b.id).select().single();
    if (error) throw error;
    sig = data;
  } else sig = await ensure('signals', 'equipment_id,io_number', row);
  await admin.from('signal_hops').delete().eq('signal_id', sig.id);
  const hops = [];
  for (const [i, h] of (b.hops || []).filter(h => h.jb_number).entries()) {
    const jb = await ensure('junction_boxes', 'jb_number', { jb_number: h.jb_number.trim(), type: h.jb_type || 'IJB', ...(h.jb_location ? { location: h.jb_location } : {}) });
    hops.push({ signal_id: sig.id, seq: i + 1, jb_id: jb.id, jb_tag: h.jb_tag || null });
  }
  if (hops.length) { const { error } = await admin.from('signal_hops').insert(hops); if (error) throw error; }
  const after = await flatSignal(sig.id), label = `${after.equipment_tag} / ${after.io_number}`;
  if (!before) await audit(req.user, 'create', label, 'New signal', after, sig.id);
  else { const ch = diff(before, after); if (Object.keys(ch).length) await audit(req.user, 'update', label, summarize(ch), ch, sig.id); }
  afterChange();
  res.json({ ok: true, id: sig.id });
}));

app.delete('/api/admin/signal/:id', requireAdmin, wrap(async (req, res) => {
  const before = await flatSignal(req.params.id);
  const { error } = await admin.from('signals').delete().eq('id', req.params.id);
  if (error) throw error;
  if (before) await audit(req.user, 'delete', `${before.equipment_tag} / ${before.io_number}`, 'Signal deleted', before, before.id);
  afterChange();
  res.json({ ok: true });
}));

app.post('/api/admin/export', requireAdmin, wrap(async (req, res) => res.json(await exportExcel())));
app.get('/api/admin/export/download', requireAdmin, wrap(async (req, res) => {
  const { file } = await exportExcel();   // always fresh
  await audit(req.user, 'export', null, 'Downloaded Excel');
  res.download(file, 'signals.xlsx');
}));

// Runs after every admin save/delete: keeps Google Sheet live (and Excel too if AUTO_EXPORT=true)
function afterChange() {
  if (process.env.AUTO_EXPORT === 'true') exportExcel().catch(e => console.error('Excel export failed:', e.message));
  if (sheets.enabled()) sheets.sync().catch(e => console.error('Sheet sync failed:', e.message));
}

app.get('/api/admin/signal/:id', requireAdmin, wrap(async (req, res) => {
  const s = await flatSignal(req.params.id);
  if (!s) throw fail(404, 'Signal not found.');
  res.json(s);
}));

// Full list for the admin screen, including who last changed each signal (kept off the public API)
app.get('/api/admin/signals', requireAdmin, wrap(async (req, res) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('signals')
      .select('id, io_panel, io_number, signal_type, equipment_terminal, updated_at, updated_by, unit:units(name), equipment(tag), hops:signal_hops(seq)')
      .order('io_number').range(from, from + 999);
    if (error) throw error;
    out.push(...data); if (data.length < 1000) break;
  }
  res.json(out);
}));

app.get('/api/admin/audit', requireAdmin, wrap(async (req, res) => {
  let q = admin.from('audit_log').select('*').order('at', { ascending: false }).limit(Math.min(+req.query.limit || 100, 500));
  if (req.query.user) q = q.ilike('user_email', `%${req.query.user}%`);
  if (req.query.action) q = q.eq('action', req.query.action);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
}));

app.post('/api/admin/sheet-sync', requireAdmin, wrap(async (req, res) => {
  if (!sheets.enabled()) throw fail(400, 'Google Sheets is not configured. Set GOOGLE_SHEET_ID and the service account in .env.');
  const r = await sheets.sync();
  await audit(req.user, 'sheet_sync', null, `Manual sync, ${r.rows} signals`);
  res.json(r);
}));

app.listen(process.env.PORT || 3000, () => console.log('Signal Tracer running on http://localhost:' + (process.env.PORT || 3000)));
