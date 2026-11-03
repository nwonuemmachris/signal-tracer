const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FIELDS = ['unit', 'equipment_tag', 'equipment_desc', 'equipment_location', 'equipment_terminal', 'io_panel', 'io_number', 'signal_code', 'ter_grp', 'ter_no', 'signal_type', 'description'];
let token = sessionStorage.getItem('token'), editingId = null, all = [];

const call = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); if (r.status === 401) logout(); throw new Error(j.error || r.statusText); }
  return r;
};
const say = (id, text, err) => { $(id).className = 'msg' + (err ? ' err' : ''); $(id).textContent = text; };
const show = () => { $('login').hidden = !!token; $('app').hidden = !token; if (token) loadList(); };
function logout() { token = null; sessionStorage.removeItem('token'); show(); }

$('signin').onclick = async () => {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('pw').value }) });
  const j = await r.json();
  if (!r.ok) return ($('lmsg').textContent = j.error);
  token = j.token; sessionStorage.setItem('token', token); $('lmsg').textContent = ''; show();
};

function addHop(h = {}) {
  const d = document.createElement('div'); d.className = 'hop';
  d.innerHTML = `<select aria-label="JB type"><option>IJB</option><option>CJB</option></select>
    <input placeholder="JB number (e.g. IJB-12)" aria-label="JB number"><input placeholder="Cable tag in this JB" aria-label="Cable tag in JB"><input placeholder="JB location (e.g. Pipe rack 3, near pump P-12)" aria-label="JB location">
    <button class="ghost" type="button">Remove</button>`;
  d.children[0].value = h.jb_type || 'IJB'; d.children[1].value = h.jb_number || ''; d.children[2].value = h.jb_tag || ''; d.children[3].value = h.jb_location || '';
  d.children[4].onclick = () => d.remove(); $('hops').append(d);
}
$('addhop').onclick = () => addHop();

function resetForm() {
  editingId = null; FIELDS.forEach(k => ($(k).value = k === 'signal_type' ? 'AI' : ''));
  $('hops').innerHTML = ''; addHop(); $('formtitle').textContent = 'Add a signal'; $('cancel').hidden = true; say('smsg', '');
}
$('cancel').onclick = resetForm;

async function loadList() {
  try {
    all = await (await call('/api/admin/signals')).json(); renderList(); loadLog();
  } catch (e) { say('lmsg2', e.message, true); }
}
function renderList() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = all.filter(s => !q || [s.unit?.name, s.equipment?.tag, s.io_number, s.equipment_terminal, s.io_panel].join(' ').toLowerCase().includes(q));
  $('list').innerHTML = rows.map(s => `<tr style="cursor:default"><td>${esc(s.unit?.name)}</td><td>${esc(s.equipment?.tag)}</td><td>${esc(s.io_number)}</td><td>${esc(s.equipment_terminal)}</td><td>${s.hops.length}</td><td>${esc(s.updated_by || '—')}<br><span class="msg">${s.updated_at ? esc(new Date(s.updated_at).toLocaleString()) : ''}</span></td>
    <td><button class="ghost" data-edit="${s.id}">Edit</button> <button class="ghost" data-del="${s.id}" data-name="${esc(s.equipment?.tag)} / ${esc(s.io_number)}">Delete</button></td></tr>`).join('');
  say('lmsg2', rows.length ? `${rows.length} signal${rows.length > 1 ? 's' : ''}` : 'No signals match. Add one above.');
}
$('filter').oninput = renderList;

$('list').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.edit) {
      const s = await (await call('/api/admin/signal/' + b.dataset.edit)).json();
      FIELDS.forEach(k => ($(k).value = s[k] ?? '')); $('hops').innerHTML = ''; (s.hops.length ? s.hops : [{}]).forEach(addHop);
      editingId = s.id; $('formtitle').textContent = `Editing ${s.equipment_tag} / ${s.io_number}`; $('cancel').hidden = false;
      say('smsg', ''); scrollTo({ top: 0, behavior: 'smooth' });
    } else if (b.dataset.del && confirm(`Delete ${b.dataset.name}? This removes its whole route.`)) {
      await call('/api/admin/signal/' + b.dataset.del, { method: 'DELETE' });
      if (editingId === b.dataset.del) resetForm();
      await loadList();
    }
  } catch (err) { say('lmsg2', err.message, true); }
};

$('save').onclick = async () => {
  const body = { id: editingId, hops: [...$('hops').children].map(d => ({ jb_type: d.children[0].value, jb_number: d.children[1].value, jb_tag: d.children[2].value, jb_location: d.children[3].value })) };
  FIELDS.forEach(k => (body[k] = $(k).value));
  say('smsg', 'Saving…');
  try {
    await call('/api/admin/signal', { method: 'POST', body: JSON.stringify(body) });
    const keep = editingId ? 'Changes saved.' : 'Saved.'; resetForm(); say('smsg', keep); await loadList();
  } catch (e) { say('smsg', e.message, true); }
};

$('export').onclick = async () => {
  say('emsg', 'Building…');
  try {
    const blob = await (await call('/api/admin/export/download')).blob();
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'signals.xlsx' }).click();
    say('emsg', 'Downloaded.');
  } catch (e) { say('emsg', e.message, true); }
};
$('sheet').onclick = async () => {
  say('emsg', 'Syncing…');
  try { const r = await (await call('/api/admin/sheet-sync', { method: 'POST' })).json(); say('emsg', `Google Sheet updated (${r.rows} signals).`); }
  catch (e) { say('emsg', e.message, true); }
};
async function loadLog() {
  try {
    const qs = new URLSearchParams({ user: $('loguser').value.trim(), action: $('logaction').value });
    const rows = await (await call('/api/admin/audit?' + qs)).json();
    $('log').innerHTML = rows.map(r => `<tr style="cursor:default"><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.user_email)}</td><td>${esc(r.action)}</td><td>${esc(r.item)}</td><td>${esc(r.summary)}</td></tr>`).join('');
    say('logmsg', rows.length ? `Latest ${rows.length} actions` : 'No activity recorded yet.');
  } catch (e) { say('logmsg', e.message, true); }
}
$('loguser').onchange = loadLog; $('logaction').onchange = loadLog; $('logrefresh').onclick = loadLog;
resetForm(); show();
