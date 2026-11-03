const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async url => { const r = await fetch(url); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
let signals = [];

async function loadUnits() {
  const units = await api('/api/units');
  $('unit').innerHTML = units.map(u => `<option>${esc(u)}</option>`).join('');
  $('empty').textContent = units.length ? '' : 'No units yet. An admin can add signals on the Admin page.';
  if (units.length) loadSignals();
}

async function loadSignals() {
  signals = await api('/api/signals?unit=' + encodeURIComponent($('unit').value));
  $('rows').innerHTML = signals.map((s, i) => `<tr data-i="${i}"><td>${esc(s.io_number)}</td><td>${esc(s.io_panel)}</td><td>${esc(s.equipment?.tag)}</td><td>${esc(s.equipment_terminal)}</td><td>${esc(s.signal_type)}</td><td>${s.hops.length}</td></tr>`).join('');
  $('eqlist').innerHTML = [...new Set(signals.map(s => s.equipment?.tag))].map(t => `<option value="${esc(t)}">`).join('');
}

async function trace() {
  $('status').className = 'msg'; $('status').textContent = 'Loading…';
  try {
    const { equipment, signal } = await api(`/api/path?equipment=${encodeURIComponent($('eq').value.trim())}&io=${encodeURIComponent($('io').value.trim())}`);
    $('status').textContent = [signal.signal_code, signal.description].filter(Boolean).join(' – ');
    draw([
      { kind: 'io', title: signal.io_number, lines: [signal.io_panel || 'I/O module', `Ter Grp ${signal.ter_grp || '—'} / No ${signal.ter_no || '—'}`, signal.signal_type || ''] },
      ...signal.hops.map(h => ({ kind: 'jb', title: h.jb.jb_number, lines: [h.jb.type, 'Tag: ' + (h.jb_tag || '—')], loc: h.jb.location })),
      { kind: 'eq', title: equipment.tag, lines: [equipment.description || '', 'Tag: ' + (signal.equipment_terminal || '—')], loc: equipment.location }
    ]);
  } catch (e) { $('status').className = 'msg err'; $('status').textContent = e.message; $('diagram').innerHTML = ''; }
}

// The drawing is built purely from the data: N hops in the database = N+2 boxes.
const wrap = (t, n) => {
  if (!t) return [];
  const out = []; let cur = '';
  for (const w of ('Location: ' + t).split(' ')) { if ((cur + ' ' + w).trim().length > n) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  out.push(cur); return out.slice(0, 4);
};

function draw(nodes) {
  nodes.forEach(n => (n.locLines = wrap(n.loc, 26)));
  const W = 200, G = 70, P = 16, H = 116 + 16 * Math.max(0, ...nodes.map(n => n.locLines.length)), color = { io: 'var(--io)', jb: 'var(--jb)', eq: 'var(--eq)' };
  const label = { io: 'I/O MODULE', jb: 'JUNCTION BOX', eq: 'EQUIPMENT' };
  let svg = `<svg width="${P * 2 + nodes.length * W + (nodes.length - 1) * G}" height="${H + P * 2}" role="img" aria-label="Cable path">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--mute)"/></marker></defs>`;
  nodes.forEach((n, i) => {
    const x = P + i * (W + G), y = P;
    if (i) svg += `<line x1="${x - G}" y1="${y + H / 2}" x2="${x - 2}" y2="${y + H / 2}" stroke="var(--mute)" stroke-width="2" marker-end="url(#a)"/>`;
    svg += `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="4" fill="var(--panel)" stroke="${color[n.kind]}" stroke-width="2.5"/>
      <rect x="${x}" y="${y}" width="${W}" height="22" rx="4" fill="${color[n.kind]}"/>
      <text x="${x + 8}" y="${y + 15}" font-size="11" font-weight="600" style="fill:#fff">${label[n.kind]}</text>
      <text x="${x + 8}" y="${y + 46}" font-size="16" font-weight="600">${esc(n.title)}</text>
      ${n.lines.map((l, k) => `<text x="${x + 8}" y="${y + 66 + k * 16}" font-size="12" style="fill:var(--mute)">${esc(l)}</text>`).join('')}
      ${n.locLines.map((l, k) => `<text x="${x + 8}" y="${y + 66 + (n.lines.length + k) * 16}" font-size="12" font-weight="600">${esc(l)}</text>`).join('')}`;
  });
  $('diagram').innerHTML = svg + '</svg>';
}

$('go').onclick = trace;
[$('eq'), $('io')].forEach(el => el.addEventListener('keydown', e => e.key === 'Enter' && trace()));
$('unit').onchange = loadSignals;
$('rows').onclick = e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const s = signals[tr.dataset.i]; $('eq').value = s.equipment.tag; $('io').value = s.io_number; trace(); scrollTo({ top: 0, behavior: 'smooth' });
};
loadUnits().catch(e => ($('empty').textContent = e.message));
