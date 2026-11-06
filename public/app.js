/* LeadFlow admin UI — dependency-free SPA with hash routing. */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
let META = { stages: [], field_types: [], triggers: [], step_types: [] };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const name = c => esc(`${c.first_name || ''} ${c.last_name || ''}`.trim() || '—');
const STAGE_LABEL = { subscriber: 'Subscriber', lead: 'Lead', mql: 'MQL', sql: 'SQL', opportunity: 'Opportunity', customer: 'Customer', other: 'Other' };
const opts = (list, sel, labels = {}) => list.map(v => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(labels[v] ?? v)}</option>`).join('');

function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.className = 'toast', 2600);
}

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Unauthorized'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; throw e; }
  return data;
}
const GET = p => api('GET', p), POST = (p, b) => api('POST', p, b || {}), PUT = (p, b) => api('PUT', p, b), PATCH = (p, b) => api('PATCH', p, b), DEL = p => api('DELETE', p);

// Nested-path setter used by the editors' two-way bindings ("fields.2.label").
function setPath(obj, path, val) {
  const keys = path.split('.'); let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys.at(-1)] = val;
}
function bind(root, state, onChange) {
  root.oninput = e => {
    const p = e.target.dataset.bind; if (!p) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.dataset.type === 'list') v = v.split(',').map(s => s.trim()).filter(Boolean);
    if (e.target.dataset.type === 'lines') v = v.split('\n').map(s => s.trim()).filter(Boolean);
    setPath(state, p, v);
    onChange?.(e.target.tagName === 'SELECT' || e.target.type === 'checkbox' || e.target.dataset.rerender !== undefined, e.target);
  };
}

// ---------- Auth ----------
let ME = null;
function showLogin() { $('#shell').classList.add('hidden'); $('#accept').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await POST('/login', { email: e.target.email.value, password: e.target.password.value }); boot(); }
  catch (err) { $('#login-err').textContent = err.message; }
});
$('#logout').addEventListener('click', async e => { e.preventDefault(); await POST('/logout'); showLogin(); });

async function boot() {
  const acceptMatch = location.hash.match(/^#\/accept\/([\w-]+)/);
  if (acceptMatch) return acceptInvite(acceptMatch[1]);
  const me = await GET('/me');
  if (!me.authenticated) return showLogin();
  ME = me.user;
  $('#login').classList.add('hidden'); $('#accept').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', ME.role !== 'admin'));
  $('#whoami').innerHTML = `${esc(ME.name)}<div>${ME.role === 'admin' ? 'Admin' : 'Rep'}${ME.email ? ' · ' + esc(ME.email) : ''}</div>`;
  if (me.default_password && !sessionStorage.lfWarned) { sessionStorage.lfWarned = 1; setTimeout(() => toast('Security: the owner password is still "admin". Set ADMIN_PASSWORD in Railway.', true), 800); }
  META = await GET('/meta');
  route();
}

// ---------- Router ----------
const routes = [
  [/^\/$/, dashboard, 'dashboard'],
  [/^\/contacts$/, contactsList, 'contacts'],
  [/^\/contacts\/(\d+)$/, contactDetail, 'contacts'],
  [/^\/forms$/, formsList, 'forms'],
  [/^\/forms\/(new|\d+)$/, formEditor, 'forms'],
  [/^\/workflows$/, workflowsList, 'workflows'],
  [/^\/workflows\/(new|\d+)$/, workflowEditor, 'workflows'],
  [/^\/emails$/, emailsList, 'emails'],
  [/^\/emails\/(new|\d+)$/, templateEditor, 'emails'],
  [/^\/outbox\/(\d+)$/, outboxView, 'emails'],
  [/^\/broadcasts$/, broadcasts, 'broadcasts'],
  [/^\/settings$/, settingsView, 'settings'],
  [/^\/users$/, usersView, 'users'],
  [/^\/accept\/([\w-]+)$/, acceptInvite, ''],
];
async function route() {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  for (const [re, fn, nav] of routes) {
    const m = path.match(re);
    if (m) {
      $$('.side a').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
      view.onclick = view.oninput = null; // editors install their own handlers
      view.innerHTML = '<div class="empty">Loading…</div>';
      try { await fn(...m.slice(1), new URLSearchParams(query)); }
      catch (err) { if (err.message !== 'Unauthorized') view.innerHTML = `<div class="card err">${esc(err.message)}</div>`; }
      return;
    }
  }
  view.innerHTML = '<div class="empty">Not found</div>';
}
window.addEventListener('hashchange', route);

// ---------- Dashboard ----------
async function dashboard() {
  const d = await GET('/dashboard');
  const s = d.stats;
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  const days = []; for (let i = 29; i >= 0; i--) { const dt = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push([dt, d.daily.find(x => x.d === dt)?.n || 0]); }
  const max = Math.max(1, ...days.map(x => x[1]));
  const stageMax = Math.max(1, ...d.stages.map(x => x.n));
  view.innerHTML = `
  <div class="head"><h1>Dashboard</h1><span class="muted">Last 30 days</span></div>
  <div class="grid g4">
    ${[['Total contacts', s.contacts], ['New contacts', s.new_contacts_30d], ['Form submissions', s.submissions_30d], ['Emails sent', s.emails_sent_30d],
       ['Open rate', pct(s.opened_30d, s.emails_sent_30d)], ['Click rate', pct(s.clicked_30d, s.emails_sent_30d)], ['Active workflows', s.active_workflows], ['Contacts in workflows', s.active_runs]]
      .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Form submissions per day</h2><div class="bars">${days.map(([dt, n]) => `<div style="height:${n / max * 100}%" data-tip="${dt}: ${n}"></div>`).join('')}</div></div>
    <div class="card funnel"><h2>Lifecycle funnel</h2>${META.stages.map(st => { const n = d.stages.find(x => x.stage === st)?.n || 0;
      return `<div class="r"><span class="lbl">${STAGE_LABEL[st]}</span><div class="bar" style="width:${Math.max(n / stageMax * 70, 0.5)}%"></div><b>${n}</b></div>`; }).join('')}</div>
    <div class="card"><h2>Hottest leads</h2>${d.hot.length ? `<table>${d.hot.map(c => `<tr class="click" data-href="#/contacts/${c.id}"><td>${name(c)}<div class="muted">${esc(c.email)}</div></td><td>${esc(c.company)}</td><td><span class="pill brand">${STAGE_LABEL[c.stage]}</span></td><td><b>${c.score}</b></td></tr>`).join('')}</table>` : '<div class="empty">No contacts yet</div>'}</div>
    <div class="card"><h2>Top forms</h2>${d.topForms.length ? `<table>${d.topForms.map(f => `<tr class="click" data-href="#/forms/${f.id}"><td>${esc(f.name)}</td><td>${f.n} submissions</td></tr>`).join('')}</table>` : '<div class="empty">No forms yet — <a href="#/forms/new">create one</a></div>'}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Recent activity</h2><ul class="timeline">${d.recent.map(a => `<li><span class="t">${fmt(a.created_at)}</span><span><a href="#/contacts/${a.contact_id}">${esc(a.email)}</a> — ${esc(a.summary)}</span></li>`).join('') || '<div class="empty">Nothing yet</div>'}</ul></div>`;
}
view.addEventListener('click', e => { const tr = e.target.closest('[data-href]'); if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href; });

// ---------- Contacts ----------
async function contactsList(q) {
  const params = new URLSearchParams(q);
  const page = Number(params.get('page') || 0), limit = 50;
  params.set('limit', limit); params.set('offset', page * limit);
  const [data, tags] = await Promise.all([GET('/contacts?' + params), GET('/tags')]);
  const filterQs = new URLSearchParams(q); filterQs.delete('page');
  view.innerHTML = `
  <div class="head"><h1>Contacts <span class="muted" style="font-weight:400">(${data.total})</span></h1>
    <div class="row" style="flex:0 0 auto">
      <a class="btn" href="/api/contacts/export.csv?${filterQs}">Export CSV</a>
      <label class="btn">Import CSV<input type="file" id="import" accept=".csv,text/csv" hidden></label>
      <button class="btn primary" id="add">+ Add contact</button>
    </div></div>
  <div class="card">
    <form class="row" id="filters" style="margin-bottom:12px">
      <input name="q" placeholder="Search name, email, company" value="${esc(q.get('q'))}">
      <select name="stage" class="auto" style="width:160px"><option value="">All stages</option>${opts(META.stages, q.get('stage'), STAGE_LABEL)}</select>
      <select name="tag" class="auto" style="width:160px"><option value="">All tags</option>${opts(tags.map(t => t.tag), q.get('tag'))}</select>
      <input name="min_score" type="number" class="auto" style="width:120px" placeholder="Min score" value="${esc(q.get('min_score'))}">
      <button class="btn auto">Filter</button>
    </form>
    <div id="addform" class="hidden card" style="margin-bottom:12px;background:#fcfcfd">
      <div class="row"><input id="n-email" placeholder="Email *"><input id="n-first" placeholder="First name"><input id="n-last" placeholder="Last name"><input id="n-company" placeholder="Company"><button class="btn primary auto" id="n-save">Save</button></div>
    </div>
    ${data.rows.length ? `<table><thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Stage</th><th>Score</th><th>Tags</th><th>Created</th></tr></thead><tbody>
    ${data.rows.map(c => `<tr class="click" data-href="#/contacts/${c.id}"><td>${name(c)}</td><td>${esc(c.email)}${c.unsubscribed ? ' <span class="pill bad">unsub</span>' : ''}</td><td>${esc(c.company)}</td>
      <td><span class="pill brand">${STAGE_LABEL[c.stage] || esc(c.stage)}</span></td><td><b>${c.score}</b></td><td>${c.tags.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</td><td class="muted">${fmt(c.created_at)}</td></tr>`).join('')}
    </tbody></table>
    <div class="pager"><span class="muted">${page * limit + 1}–${page * limit + data.rows.length} of ${data.total}</span>
      ${page > 0 ? `<a class="btn sm" href="#/contacts?${filterQs}&page=${page - 1}">← Prev</a>` : ''}
      ${(page + 1) * limit < data.total ? `<a class="btn sm" href="#/contacts?${filterQs}&page=${page + 1}">Next →</a>` : ''}</div>`
    : '<div class="empty">No contacts match. Contacts are created automatically when someone submits a form.</div>'}
  </div>`;
  $('#filters').addEventListener('submit', e => {
    e.preventDefault();
    const p = new URLSearchParams(); for (const [k, v] of new FormData(e.target)) if (v) p.set(k, v);
    location.hash = '#/contacts?' + p;
  });
  $('#add').onclick = () => $('#addform').classList.toggle('hidden');
  $('#n-save').onclick = async () => {
    try {
      const c = await POST('/contacts', { email: $('#n-email').value, first_name: $('#n-first').value, last_name: $('#n-last').value, company: $('#n-company').value });
      location.hash = '#/contacts/' + c.id;
    } catch (err) { toast(err.message, true); }
  };
  $('#import').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const rows = parseCSV(await file.text());
    if (!rows.length) return toast('No rows found', true);
    const tag = prompt(`Import ${rows.length} rows. Optional tag to apply to all imported contacts:`, 'imported');
    if (tag === null) return;
    const r = await POST('/contacts/import', { rows, tags: tag ? [tag] : [] });
    toast(`Imported: ${r.created} new, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} errors` : ''}`, r.errors.length > 0);
    route();
  };
}

// Minimal RFC4180 CSV parser; header row maps to contact fields (case-insensitive, spaces → _).
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(c => c.trim()));
  if (!head) return [];
  const keys = head.map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/^e-?mail(_address)?$/, 'email').replace(/^first$/, 'first_name').replace(/^last$/, 'last_name'));
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

async function contactDetail(id) {
  const [c, templates, workflows] = await Promise.all([GET('/contacts/' + id), GET('/templates'), GET('/workflows')]);
  const props = Object.entries(c.properties || {});
  view.innerHTML = `
  <div class="head"><div><a href="#/contacts" class="muted">← Contacts</a><h1>${name(c)}</h1><div class="muted">${esc(c.email)}</div></div>
    <div class="row" style="flex:0 0 auto"><span class="pill brand" style="font-size:14px">${STAGE_LABEL[c.stage]}</span><span class="pill" style="font-size:14px">Score ${c.score}</span>
    ${c.unsubscribed ? '<span class="pill bad" style="font-size:14px">Unsubscribed</span>' : ''}<button class="btn danger sm" id="del">Delete</button></div></div>
  <div class="grid g-side">
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Properties</h2>
        ${[['email', 'Email'], ['first_name', 'First name'], ['last_name', 'Last name'], ['company', 'Company'], ['phone', 'Phone']].map(([k, l]) =>
          `<div class="field"><label class="f">${l}</label><input data-k="${k}" value="${esc(c[k])}"></div>`).join('')}
        <div class="field"><label class="f">Lifecycle stage</label><select data-k="stage">${opts(META.stages, c.stage, STAGE_LABEL)}</select></div>
        <div class="field"><label class="f">Lead score</label><input type="number" data-k="score" value="${c.score}"></div>
        <div class="field"><label class="f">Tags (comma-separated)</label><input data-k="tags" value="${esc(c.tags.join(', '))}"></div>
        <div class="field"><label class="f"><input type="checkbox" data-k="unsubscribed" style="width:auto" ${c.unsubscribed ? 'checked' : ''}> Unsubscribed from email</label></div>
        ${props.length ? `<h2 style="margin-top:18px">Custom properties</h2><table>${props.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
        <div class="muted" style="margin-top:10px;font-size:12px">Source: ${esc(c.source || '—')} · Created ${fmt(c.created_at)}</div>
        <button class="btn primary" id="save" style="margin-top:12px">Save changes</button>
      </div>
      <div class="card"><h2>Send email</h2><div class="row"><select id="tpl">${templates.length ? opts(templates.map(t => t.id), '', Object.fromEntries(templates.map(t => [t.id, t.name]))) : '<option value="">No templates</option>'}</select><button class="btn auto" id="send">Send</button></div></div>
      <div class="card"><h2>Enroll in workflow</h2><div class="row"><select id="wf">${workflows.length ? opts(workflows.map(w => w.id), '', Object.fromEntries(workflows.map(w => [w.id, w.name + (w.active ? '' : ' (inactive)')]))) : '<option value="">No workflows</option>'}</select><button class="btn auto" id="enroll">Enroll</button></div></div>
    </div>
    <div class="card">
      <div class="tabs"><a data-tab="timeline" class="active">Timeline</a><a data-tab="subs">Form submissions (${c.submissions.length})</a><a data-tab="emails">Emails (${c.emails.length})</a><a data-tab="runs">Workflows (${c.runs.length})</a></div>
      <div data-pane="timeline">
        <div class="row" style="margin-bottom:12px"><textarea id="note" placeholder="Add a note…" style="min-height:60px"></textarea><button class="btn auto" id="addnote">Add note</button></div>
        <ul class="timeline">${c.timeline.map(a => `<li><span class="t">${fmt(a.created_at)}</span><span class="${a.type === 'note' ? 'note' : ''}">${esc(a.summary)}</span></li>`).join('')}</ul>
      </div>
      <div data-pane="subs" class="hidden">${c.submissions.map(s => `<div class="step"><b>${esc(s.form_name)}</b> <span class="muted">${fmt(s.created_at)}</span>
        <table>${Object.entries(s.data).map(([k, v]) => `<tr><td class="muted" style="width:160px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
        ${s.meta.page_url ? `<tr><td class="muted">page</td><td>${esc(s.meta.page_url)}</td></tr>` : ''}${['utm_source', 'utm_medium', 'utm_campaign'].filter(k => s.meta[k]).map(k => `<tr><td class="muted">${k}</td><td>${esc(s.meta[k])}</td></tr>`).join('')}</table></div>`).join('') || '<div class="empty">No submissions</div>'}</div>
      <div data-pane="emails" class="hidden">${c.emails.length ? `<table><tr><th>Subject</th><th>Status</th><th>Opened</th><th>Clicked</th><th>Sent</th></tr>${c.emails.map(e => `<tr class="click" data-href="#/outbox/${e.id}"><td>${esc(e.subject)}</td><td>${statusPill(e.status)}</td><td>${e.opened_at ? '✓' : ''}</td><td>${e.clicked_at ? '✓' : ''}</td><td class="muted">${fmt(e.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">No emails</div>'}</div>
      <div data-pane="runs" class="hidden">${c.runs.length ? `<table><tr><th>Workflow</th><th>Status</th><th>Step</th><th>Next action</th></tr>${c.runs.map(r => `<tr class="click" data-href="#/workflows/${r.workflow_id}"><td>${esc(r.workflow_name)}</td><td>${statusPill(r.status)}</td><td>${r.step_index}</td><td class="muted">${r.status === 'active' ? fmt(r.next_run_at) : ''}</td></tr>`).join('')}</table>` : '<div class="empty">Not enrolled in any workflow</div>'}</div>
    </div>
  </div>`;
  tabs(view);
  $('#save').onclick = async () => {
    const body = {};
    $$('[data-k]').forEach(i => { const k = i.dataset.k; body[k] = i.type === 'checkbox' ? i.checked : i.value; });
    body.tags = body.tags.split(',').map(s => s.trim()).filter(Boolean);
    body.score = Number(body.score);
    try { await PATCH('/contacts/' + id, body); toast('Saved'); route(); } catch (err) { toast(err.message, true); }
  };
  $('#del').onclick = async () => { if (confirm('Delete this contact and all its history?')) { await DEL('/contacts/' + id); location.hash = '#/contacts'; } };
  $('#addnote').onclick = async () => { const t = $('#note').value.trim(); if (!t) return; await POST(`/contacts/${id}/notes`, { text: t }); route(); };
  $('#send').onclick = async () => { if (!$('#tpl').value) return; const r = await POST(`/contacts/${id}/email`, { template_id: Number($('#tpl').value) }); toast('Email: ' + r.status, r.status === 'failed'); route(); };
  $('#enroll').onclick = async () => { if (!$('#wf').value) return; try { await POST(`/contacts/${id}/enroll`, { workflow_id: Number($('#wf').value) }); toast('Enrolled'); setTimeout(route, 300); } catch (err) { toast(err.message, true); } };
}

function tabs(root) {
  $$('.tabs a', root).forEach(a => a.onclick = () => {
    $$('.tabs a', root).forEach(x => x.classList.toggle('active', x === a));
    $$('[data-pane]', root).forEach(p => p.classList.toggle('hidden', p.dataset.pane !== a.dataset.tab));
  });
}
function statusPill(s) {
  const cls = { completed: 'ok', sent: 'ok', sent_dev: 'ok', active: 'brand', running: 'brand', failed: 'bad', exited: 'warn', paused: 'warn', skipped_unsubscribed: 'warn', cancelled: 'warn' }[s] || '';
  return `<span class="pill ${cls}">${esc(s === 'sent_dev' ? 'sent (dev)' : s)}</span>`;
}

// ---------- Forms ----------
async function formsList() {
  const forms = await GET('/forms');
  view.innerHTML = `<div class="head"><h1>Forms</h1><a class="btn primary" href="#/forms/new">+ New form</a></div>
  <div class="card">${forms.length ? `<table><tr><th>Name</th><th>Fields</th><th>Submissions</th><th>Created</th><th></th></tr>
    ${forms.map(f => `<tr class="click" data-href="#/forms/${f.id}"><td><b>${esc(f.name)}</b></td><td>${f.fields.length}</td><td>${f.submission_count}</td><td class="muted">${fmt(f.created_at)}</td><td><a href="/f/${f.public_id}" target="_blank">View live ↗</a></td></tr>`).join('')}</table>`
    : '<div class="empty">No forms yet. Create one to start capturing leads.</div>'}</div>`;
}

const FORM_TEMPLATE = () => ({
  name: 'Contact us',
  fields: [
    { name: 'first_name', label: 'First name', type: 'text', required: true, placeholder: '', options: [] },
    { name: 'last_name', label: 'Last name', type: 'text', required: false, placeholder: '', options: [] },
    { name: 'email', label: 'Work email', type: 'email', required: true, placeholder: 'you@company.com', options: [] },
    { name: 'company', label: 'Company', type: 'text', required: false, placeholder: '', options: [] },
    { name: 'message', label: 'How can we help?', type: 'textarea', required: false, placeholder: '', options: [] },
  ],
  settings: { submit_label: 'Send', success_message: "Thanks! We'll be in touch shortly.", redirect_url: '', add_tags: [], set_stage: 'lead', notify_email: '', accent_color: '#4f46e5' },
});

async function formEditor(id) {
  const isNew = id === 'new';
  const form = isNew ? FORM_TEMPLATE() : await GET('/forms/' + id);
  const subs = isNew ? [] : await GET(`/forms/${id}/submissions`);
  const base = location.origin;

  function preview() {
    return form.fields.filter(f => f.type !== 'hidden').map(f => {
      const lbl = esc(f.label) + (f.required ? ' *' : '');
      if (f.type === 'checkbox') return `<div class="field"><label><input type="checkbox" style="width:auto"> ${lbl}</label></div>`;
      const input = f.type === 'textarea' ? `<textarea placeholder="${esc(f.placeholder)}"></textarea>`
        : f.type === 'select' ? `<select><option>${esc(f.placeholder || 'Select…')}</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
        : `<input type="${esc(f.type)}" placeholder="${esc(f.placeholder)}">`;
      return `<div class="field"><label class="f">${lbl}</label>${input}</div>`;
    }).join('') + `<button class="btn primary" style="background:${esc(form.settings.accent_color)};border-color:${esc(form.settings.accent_color)}">${esc(form.settings.submit_label)}</button>`;
  }

  function render() {
    view.innerHTML = `
    <div class="head"><div><a href="#/forms" class="muted">← Forms</a><h1>${isNew ? 'New form' : esc(form.name)}</h1></div>
      <div class="row" style="flex:0 0 auto">${isNew ? '' : `<a class="btn" href="/f/${form.public_id}" target="_blank">View live ↗</a><button class="btn danger" id="del">Delete</button>`}<button class="btn primary" id="save">Save form</button></div></div>
    <div class="tabs"><a data-tab="build" class="active">Build</a>${isNew ? '' : `<a data-tab="share">Share &amp; embed</a><a data-tab="subs">Submissions (${subs.length})</a>`}</div>
    <div data-pane="build" class="grid g2">
      <div>
        <div class="card" style="margin-bottom:16px"><div class="field"><label class="f">Form name</label><input data-bind="name" value="${esc(form.name)}" data-rerender></div></div>
        <div class="card" style="margin-bottom:16px"><h2>Fields</h2>
          <p class="muted" style="margin-top:-8px">Fields named <code>email</code>, <code>first_name</code>, <code>last_name</code>, <code>company</code>, <code>phone</code> map to contact properties; anything else is saved as a custom property.</p>
          ${form.fields.map((f, i) => `<div class="step">
            <div class="row"><input data-bind="fields.${i}.label" value="${esc(f.label)}" placeholder="Label" data-rerender>
              <input data-bind="fields.${i}.name" value="${esc(f.name)}" placeholder="field_name" class="auto" style="width:140px">
              <select data-bind="fields.${i}.type" class="auto" style="width:110px">${opts(META.field_types, f.type)}</select></div>
            <div class="row" style="margin-top:8px">
              ${f.type === 'hidden' ? `<input data-bind="fields.${i}.value" value="${esc(f.value || '')}" placeholder="Hidden value">` : `<input data-bind="fields.${i}.placeholder" value="${esc(f.placeholder)}" placeholder="Placeholder" data-rerender>`}
              <label class="auto"><input type="checkbox" style="width:auto" data-bind="fields.${i}.required" ${f.required ? 'checked' : ''}> Required</label>
              <button class="btn sm auto" data-act="up" data-i="${i}">↑</button><button class="btn sm auto" data-act="down" data-i="${i}">↓</button><button class="btn sm danger auto" data-act="rm" data-i="${i}">✕</button></div>
            ${f.type === 'select' ? `<div style="margin-top:8px"><textarea data-bind="fields.${i}.options" data-type="lines" placeholder="One option per line" style="min-height:60px" data-rerender>${esc(f.options.join('\n'))}</textarea></div>` : ''}
          </div>`).join('')}
          <button class="btn" data-act="add">+ Add field</button>
        </div>
        <div class="card"><h2>After submission</h2>
          <div class="field"><label class="f">Submit button label</label><input data-bind="settings.submit_label" value="${esc(form.settings.submit_label)}" data-rerender></div>
          <div class="field"><label class="f">Success message</label><input data-bind="settings.success_message" value="${esc(form.settings.success_message)}"></div>
          <div class="field"><label class="f">Redirect URL (optional, overrides message)</label><input data-bind="settings.redirect_url" value="${esc(form.settings.redirect_url)}" placeholder="https://yoursite.com/thank-you"></div>
          <div class="field"><label class="f">Tag contacts with (comma-separated)</label><input data-bind="settings.add_tags" data-type="list" value="${esc(form.settings.add_tags.join(', '))}"></div>
          <div class="field"><label class="f">Set lifecycle stage (only moves forward)</label><select data-bind="settings.set_stage"><option value="">Don't change</option>${opts(META.stages, form.settings.set_stage, STAGE_LABEL)}</select></div>
          <div class="field"><label class="f">Email notification to (optional)</label><input data-bind="settings.notify_email" value="${esc(form.settings.notify_email)}" placeholder="sales@yourco.com"></div>
          <div class="field"><label class="f">Button color</label><input type="color" data-bind="settings.accent_color" value="${esc(form.settings.accent_color)}" style="height:38px;width:80px" data-rerender></div>
        </div>
      </div>
      <div><div class="card" style="position:sticky;top:20px"><h2>Preview</h2><div class="preview" id="preview">${preview()}</div></div></div>
    </div>
    ${isNew ? '' : `<div data-pane="share" class="hidden card">
      <h2>Hosted page</h2><p><a href="/f/${form.public_id}" target="_blank">${esc(base)}/f/${form.public_id}</a></p>
      <h2 style="margin-top:20px">Embed on your website (recommended)</h2>
      <pre class="embed">${esc(`<div data-leadflow-form="${form.public_id}"></div>\n<script src="${base}/embed.js" async></script>`)}</pre>
      <p class="muted">Captures page URL, referrer and UTM parameters automatically. Listen for the <code>leadflow:submitted</code> DOM event to fire your own analytics.</p>
      <h2 style="margin-top:20px">Plain HTML form / your own form</h2>
      <pre class="embed">${esc(`<form action="${base}/api/public/forms/${form.public_id}/submit" method="POST">\n${form.fields.map(f => `  <input name="${f.name}" type="${f.type === 'textarea' ? 'text' : f.type}"${f.required ? ' required' : ''}>`).join('\n')}\n  <button>Submit</button>\n</form>`)}</pre>
      <h2 style="margin-top:20px">API</h2>
      <pre class="embed">${esc(`curl -X POST ${base}/api/public/forms/${form.public_id}/submit \\\n  -H 'content-type: application/json' \\\n  -d '{"email":"jane@acme.com","first_name":"Jane"}'`)}</pre>
    </div>
    <div data-pane="subs" class="hidden card">${subs.length ? `<table><tr><th>Contact</th>${form.fields.filter(f => f.name !== 'email').slice(0, 4).map(f => `<th>${esc(f.label)}</th>`).join('')}<th>Source</th><th>Date</th></tr>
      ${subs.map(s => `<tr class="click" data-href="#/contacts/${s.contact_id}"><td>${esc(s.email || s.data.email)}</td>${form.fields.filter(f => f.name !== 'email').slice(0, 4).map(f => `<td>${esc(s.data[f.name])}</td>`).join('')}<td class="muted">${esc(s.meta.utm_source || '')}</td><td class="muted">${fmt(s.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">No submissions yet</div>'}</div>`}`;
    tabs(view);
    wire();
  }
  function wire() {
    $('#save').onclick = async () => {
      try {
        const saved = isNew ? await POST('/forms', form) : await PUT('/forms/' + id, form);
        toast('Form saved');
        if (isNew) location.hash = '#/forms/' + saved.id;
      } catch (err) { toast(err.message, true); }
    };
    if ($('#del')) $('#del').onclick = async () => { if (confirm('Delete this form and its submissions?')) { await DEL('/forms/' + id); location.hash = '#/forms'; } };
  }
  view.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const i = Number(b.dataset.i), F = form.fields;
    if (b.dataset.act === 'add') F.push({ name: 'field_' + (F.length + 1), label: 'New field', type: 'text', required: false, placeholder: '', options: [] });
    if (b.dataset.act === 'rm') F.splice(i, 1);
    if (b.dataset.act === 'up' && i > 0) [F[i - 1], F[i]] = [F[i], F[i - 1]];
    if (b.dataset.act === 'down' && i < F.length - 1) [F[i + 1], F[i]] = [F[i], F[i + 1]];
    render();
  };
  bind(view, form, (structural, el) => {
    // Field-type changes rebuild the editor; text edits only refresh the preview (keeps focus).
    if (el.tagName === 'SELECT' && el.dataset.bind.endsWith('.type')) render(); else $('#preview').innerHTML = preview();
  });
  render();
}

// ---------- Workflows ----------
const TRIGGER_LABEL = { form_submitted: 'Form is submitted', tag_added: 'Tag is added', stage_changed: 'Lifecycle stage changes', contact_created: 'Contact is created', email_opened: 'Email is opened', email_clicked: 'Email link is clicked' };
const STEP_LABEL = { send_email: 'Send email', wait: 'Wait', add_tag: 'Add tag', remove_tag: 'Remove tag', set_stage: 'Set lifecycle stage', adjust_score: 'Adjust lead score', condition: 'Continue only if…', notify: 'Notify team by email', webhook: 'Send webhook' };

async function workflowsList() {
  const wfs = await GET('/workflows');
  view.innerHTML = `<div class="head"><h1>Workflows</h1><a class="btn primary" href="#/workflows/new">+ New workflow</a></div>
  <div class="card">${wfs.length ? `<table><tr><th>Name</th><th>Trigger</th><th>Steps</th><th>Status</th><th>Enrolled</th><th>In progress</th><th>Completed</th></tr>
  ${wfs.map(w => `<tr class="click" data-href="#/workflows/${w.id}"><td><b>${esc(w.name)}</b></td><td>${esc(TRIGGER_LABEL[w.trigger.type])}</td><td>${w.steps.length}</td><td>${w.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Draft</span>'}</td><td>${w.enrolled}</td><td>${w.in_progress}</td><td>${w.completed}</td></tr>`).join('')}</table>`
  : '<div class="empty">No workflows yet. Workflows nurture leads automatically — e.g. "when someone downloads the ebook, send 3 follow-up emails over a week, then alert sales if they clicked."</div>'}</div>`;
}

async function workflowEditor(id) {
  const isNew = id === 'new';
  const [templates, formsAll, tags] = await Promise.all([GET('/templates'), GET('/forms'), GET('/tags')]);
  const wf = isNew ? { name: 'New workflow', trigger: { type: 'form_submitted', form_id: '', reenroll: false }, steps: [{ type: 'send_email', template_id: templates[0]?.id || '' }], active: false, runs: [] }
    : await GET('/workflows/' + id);
  wf.active = !!wf.active;
  const tplOpts = sel => `<option value="">Choose template…</option>` + opts(templates.map(t => t.id), sel, Object.fromEntries(templates.map(t => [t.id, t.name])));
  const tagList = `<datalist id="taglist">${tags.map(t => `<option value="${esc(t.tag)}">`).join('')}</datalist>`;

  function triggerConfig() {
    const t = wf.trigger;
    if (t.type === 'form_submitted') return `<select data-bind="trigger.form_id"><option value="">Any form</option>${opts(formsAll.map(f => f.id), t.form_id, Object.fromEntries(formsAll.map(f => [f.id, f.name])))}</select>`;
    if (t.type === 'tag_added') return `<input data-bind="trigger.tag" list="taglist" value="${esc(t.tag || '')}" placeholder="Tag (blank = any)">`;
    if (t.type === 'stage_changed') return `<select data-bind="trigger.stage"><option value="">Any stage</option>${opts(META.stages, t.stage, STAGE_LABEL)}</select>`;
    return '';
  }
  function stepConfig(s, i) {
    const b = k => `data-bind="steps.${i}.${k}"`;
    switch (s.type) {
      case 'send_email': return `<select ${b('template_id')}>${tplOpts(s.template_id)}</select>`;
      case 'wait': return `<input type="number" min="0" ${b('amount')} value="${esc(s.amount ?? 1)}" class="auto" style="width:90px"><select ${b('unit')} class="auto" style="width:120px">${opts(['minutes', 'hours', 'days'], s.unit || 'days')}</select>`;
      case 'add_tag': case 'remove_tag': return `<input ${b('tag')} list="taglist" value="${esc(s.tag || '')}" placeholder="tag">`;
      case 'set_stage': return `<select ${b('stage')}>${opts(META.stages, s.stage || 'lead', STAGE_LABEL)}</select>`;
      case 'adjust_score': return `<input type="number" ${b('amount')} value="${esc(s.amount ?? 10)}" placeholder="+/- points">`;
      case 'notify': return `<input ${b('email')} value="${esc(s.email || '')}" placeholder="sales@yourco.com"><input ${b('subject')} value="${esc(s.subject || 'Lead alert: {{email}}')}" placeholder="Subject">`;
      case 'webhook': return `<input ${b('url')} value="${esc(s.url || '')}" placeholder="https://hooks.example.com/…">`;
      case 'condition': {
        const field = s.field || 'tag';
        const ops = { tag: [['', 'has tag'], ['not', 'does not have tag']], stage: [['', 'is'], ['not', 'is not']], score: [['', '≥'], ['lt', '<'], ['eq', '=']],
          opened_email: [['', 'opened'], ['not', 'did not open']], clicked_email: [['', 'clicked'], ['not', 'did not click']], property: [['', 'equals'], ['not', 'not equals'], ['contains', 'contains'], ['exists', 'is set']] }[field];
        const val = field === 'stage' ? `<select ${b('value')}>${opts(META.stages, s.value, STAGE_LABEL)}</select>`
          : field === 'opened_email' || field === 'clicked_email' ? `<select ${b('value')}><option value="">any email</option>${opts(templates.map(t => t.id), s.value, Object.fromEntries(templates.map(t => [t.id, t.name])))}</select>`
          : field === 'tag' ? `<input ${b('value')} list="taglist" value="${esc(s.value || '')}">`
          : s.op === 'exists' ? '' : `<input ${b('value')} value="${esc(s.value ?? '')}">`;
        return `<select ${b('field')} class="auto" style="width:150px">${opts(['tag', 'stage', 'score', 'opened_email', 'clicked_email', 'property'], field, { tag: 'Tag', stage: 'Stage', score: 'Score', opened_email: 'Email opened', clicked_email: 'Email clicked', property: 'Property' })}</select>
          ${field === 'property' ? `<input ${b('key')} value="${esc(s.key || '')}" placeholder="property name" class="auto" style="width:140px">` : ''}
          <select ${b('op')} class="auto" style="width:150px">${ops.map(([v, l]) => `<option value="${v}" ${(s.op || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${val}
          <div class="muted" style="flex-basis:100%;font-size:12px">If not met, the contact exits the workflow.</div>`;
      }
    }
    return '';
  }
  function render() {
    view.innerHTML = `${tagList}
    <div class="head"><div><a href="#/workflows" class="muted">← Workflows</a><h1>${esc(wf.name)}</h1></div>
      <div class="row" style="flex:0 0 auto"><label class="btn"><input type="checkbox" style="width:auto" data-bind="active" ${wf.active ? 'checked' : ''}> Active</label>
      ${isNew ? '' : '<button class="btn danger" id="del">Delete</button>'}<button class="btn primary" id="save">Save workflow</button></div></div>
    <div class="grid g2">
      <div class="card">
        <div class="field"><label class="f">Workflow name</label><input data-bind="name" value="${esc(wf.name)}"></div>
        <div class="step trigger"><b>Trigger:</b> when
          <div class="row" style="margin-top:8px"><select data-bind="trigger.type">${opts(META.triggers, wf.trigger.type, TRIGGER_LABEL)}</select>${triggerConfig()}</div>
          <label style="display:block;margin-top:8px;font-size:13px"><input type="checkbox" style="width:auto" data-bind="trigger.reenroll" ${wf.trigger.reenroll ? 'checked' : ''}> Allow contacts to re-enroll after finishing</label></div>
        ${wf.steps.map((s, i) => `<div class="step-arrow">↓</div><div class="step">
          <div class="row" style="margin-bottom:8px"><span class="auto"><span class="num">${i + 1}</span><b>${esc(STEP_LABEL[s.type])}</b></span><span></span>
            <button class="btn sm auto" data-act="up" data-i="${i}">↑</button><button class="btn sm auto" data-act="down" data-i="${i}">↓</button><button class="btn sm danger auto" data-act="rm" data-i="${i}">✕</button></div>
          <div class="row">${stepConfig(s, i)}</div></div>`).join('')}
        <div class="step-arrow">↓</div>
        <div class="row"><select id="newstep">${opts(META.step_types, 'send_email', STEP_LABEL)}</select><button class="btn auto" data-act="add">+ Add step</button></div>
      </div>
      <div class="card"><h2>Enrollment history</h2>${wf.runs?.length ? `<table><tr><th>Contact</th><th>Status</th><th>Step</th><th>Last log</th></tr>
        ${wf.runs.map(r => `<tr class="click" data-href="#/contacts/${r.contact_id}"><td>${esc(r.email)}</td><td>${statusPill(r.status)}</td><td>${r.step_index}/${wf.steps.length}${r.status === 'active' ? `<div class="muted" style="font-size:12px">next: ${fmt(r.next_run_at)}</div>` : ''}</td><td class="muted" style="font-size:12px">${esc(r.log.at(-1)?.msg || '')}</td></tr>`).join('')}</table>`
        : '<div class="empty">No contacts enrolled yet. Activate the workflow — contacts enroll when the trigger fires from then on.</div>'}</div>
    </div>`;
    $('#save').onclick = async () => {
      const body = { name: wf.name, trigger: wf.trigger, steps: wf.steps, active: wf.active };
      try {
        const saved = isNew ? await POST('/workflows', body) : await PUT('/workflows/' + id, body);
        toast('Workflow saved' + (wf.active ? ' & active' : ' (inactive)'));
        if (isNew) location.hash = '#/workflows/' + saved.id;
      } catch (err) { toast(err.message, true); }
    };
    if ($('#del')) $('#del').onclick = async () => { if (confirm('Delete workflow? Contacts currently in it will stop.')) { await DEL('/workflows/' + id); location.hash = '#/workflows'; } };
  }
  view.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const i = Number(b.dataset.i), S = wf.steps;
    if (b.dataset.act === 'add') {
      const type = $('#newstep').value;
      S.push({ type, ...(type === 'wait' ? { amount: 1, unit: 'days' } : type === 'condition' ? { field: 'tag', op: '', value: '' } : {}) });
    }
    if (b.dataset.act === 'rm') S.splice(i, 1);
    if (b.dataset.act === 'up' && i > 0) [S[i - 1], S[i]] = [S[i], S[i - 1]];
    if (b.dataset.act === 'down' && i < S.length - 1) [S[i + 1], S[i]] = [S[i], S[i + 1]];
    render();
  };
  bind(view, wf, structural => { if (structural) render(); });
  render();
}

// ---------- Emails ----------
async function emailsList() {
  const [templates, outbox] = await Promise.all([GET('/templates'), GET('/outbox')]);
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  view.innerHTML = `<div class="head"><h1>Emails</h1><a class="btn primary" href="#/emails/new">+ New template</a></div>
  <div class="tabs"><a data-tab="t" class="active">Templates</a><a data-tab="o">Outbox (${outbox.length})</a></div>
  <div data-pane="t" class="card">${templates.length ? `<table><tr><th>Name</th><th>Subject</th><th>Sent</th><th>Open rate</th><th>Click rate</th></tr>
    ${templates.map(t => `<tr class="click" data-href="#/emails/${t.id}"><td><b>${esc(t.name)}</b></td><td>${esc(t.subject)}</td><td>${t.sent}</td><td>${pct(t.opened, t.sent)}</td><td>${pct(t.clicked, t.sent)}</td></tr>`).join('')}</table>`
    : '<div class="empty">No templates yet. Templates are used by workflows, broadcasts and one-off sends.</div>'}</div>
  <div data-pane="o" class="card hidden">${outbox.length ? `<table><tr><th>To</th><th>Subject</th><th>Source</th><th>Status</th><th>Opened</th><th>Clicked</th><th>Date</th></tr>
    ${outbox.map(e => `<tr class="click" data-href="#/outbox/${e.id}"><td>${esc(e.email)}</td><td>${esc(e.subject)}</td><td class="muted">${esc(e.source)}</td><td>${statusPill(e.status)}${e.error ? `<div class="err">${esc(e.error)}</div>` : ''}</td><td>${e.opened_at ? '✓' : ''}</td><td>${e.clicked_at ? '✓' : ''}</td><td class="muted">${fmt(e.created_at)}</td></tr>`).join('')}</table>`
    : '<div class="empty">No emails sent yet</div>'}</div>`;
  tabs(view);
}

async function outboxView(id) {
  const e = await GET('/outbox/' + id);
  view.innerHTML = `<div class="head"><div><a href="#/emails" class="muted">← Emails</a><h1>${esc(e.subject)}</h1><div class="muted">${statusPill(e.status)} ${fmt(e.created_at)} · ${esc(e.source)}</div></div></div>
  <div class="card"><iframe class="email" sandbox="" id="frame"></iframe></div>`;
  $('#frame').srcdoc = e.html || '<p>(not rendered)</p>';
}

async function templateEditor(id) {
  const isNew = id === 'new';
  const t = isNew ? { name: 'Welcome email', subject: 'Welcome, {{first_name|there}}!', body: 'Hi {{first_name|there}},\n\nThanks for reaching out to {{company_name}}. Here is the guide you asked for: https://example.com/guide\n\nCheers,\nThe team' } : (await GET('/templates')).find(x => x.id === Number(id));
  if (!t) throw new Error('Template not found');
  const sample = { first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.com', company: 'Acme', company_name: 'My Company', unsubscribe_url: '#' };
  const merge = s => String(s).replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_, k, fb) => esc(sample[k] ?? fb ?? ''));
  const toHtml = b => /<[a-z][\s\S]*>/i.test(b) ? b : b.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');
  view.innerHTML = `<div class="head"><div><a href="#/emails" class="muted">← Emails</a><h1>${isNew ? 'New template' : esc(t.name)}</h1></div>
    <div class="row" style="flex:0 0 auto">${isNew ? '' : '<button class="btn danger" id="del">Delete</button>'}<button class="btn primary" id="save">Save template</button></div></div>
  <div class="grid g2">
    <div class="card">
      <div class="field"><label class="f">Internal name</label><input id="t-name" value="${esc(t.name)}"></div>
      <div class="field"><label class="f">Subject</label><input id="t-subject" value="${esc(t.subject)}"></div>
      <div class="field"><label class="f">Body (plain text or HTML)</label><textarea id="t-body" class="code">${esc(t.body)}</textarea></div>
      <p class="muted" style="font-size:12px">Merge tags: <code>{{first_name}}</code> <code>{{last_name}}</code> <code>{{email}}</code> <code>{{company}}</code> <code>{{company_name}}</code> <code>{{unsubscribe_url}}</code>, any custom property like <code>{{message}}</code>, with fallbacks: <code>{{first_name|there}}</code>. An unsubscribe footer is added automatically if you don't include <code>{{unsubscribe_url}}</code>. Links are click-tracked.</p>
    </div>
    <div class="card"><h2>Preview</h2><div class="muted" id="pv-subject" style="margin-bottom:8px"></div><iframe class="email" sandbox="" id="pv"></iframe></div>
  </div>`;
  const upd = () => { $('#pv-subject').innerHTML = '<b>Subject:</b> ' + merge($('#t-subject').value); $('#pv').srcdoc = `<div style="font-family:sans-serif">${merge(toHtml($('#t-body').value))}</div>`; };
  ['#t-subject', '#t-body'].forEach(s => $(s).addEventListener('input', upd)); upd();
  $('#save').onclick = async () => {
    const body = { name: $('#t-name').value, subject: $('#t-subject').value, body: $('#t-body').value };
    try { const s = isNew ? await POST('/templates', body) : await PUT('/templates/' + id, body); toast('Template saved'); if (isNew) location.hash = '#/emails/' + s.id; }
    catch (err) { toast(err.message, true); }
  };
  if ($('#del')) $('#del').onclick = async () => { if (confirm('Delete template?')) { await DEL('/templates/' + id); location.hash = '#/emails'; } };
}

// ---------- Broadcasts ----------
async function broadcasts() {
  const [templates, tags] = await Promise.all([GET('/templates'), GET('/tags')]);
  view.innerHTML = `<div class="head"><h1>Broadcasts</h1></div>
  <div class="card" style="max-width:640px"><h2>Send a one-off email to a segment</h2>
    <div class="field"><label class="f">Template</label><select id="b-tpl"><option value="">Choose…</option>${opts(templates.map(t => t.id), '', Object.fromEntries(templates.map(t => [t.id, t.name])))}</select></div>
    <div class="field"><label class="f">Lifecycle stage</label><select id="b-stage" class="seg"><option value="">Any</option>${opts(META.stages, '', STAGE_LABEL)}</select></div>
    <div class="field"><label class="f">Tag</label><select id="b-tag" class="seg"><option value="">Any</option>${opts(tags.map(t => t.tag), '')}</select></div>
    <div class="field"><label class="f">Minimum score</label><input id="b-score" type="number" class="seg"></div>
    <p><b id="b-count">…</b> recipients <span class="muted">(unsubscribed contacts are excluded)</span></p>
    <button class="btn primary" id="b-send">Send broadcast</button>
  </div>`;
  const filter = () => ({ stage: $('#b-stage').value, tag: $('#b-tag').value, min_score: $('#b-score').value });
  const count = async () => { $('#b-count').textContent = (await POST('/broadcasts/preview', { filter: filter() })).recipients; };
  $$('.seg').forEach(i => i.addEventListener('change', count)); count();
  $('#b-send').onclick = async () => {
    if (!$('#b-tpl').value) return toast('Choose a template', true);
    if (!confirm(`Send to ${$('#b-count').textContent} contacts?`)) return;
    const r = await POST('/broadcasts', { template_id: Number($('#b-tpl').value), filter: filter() });
    toast(`Sending to ${r.queued} contacts — see Emails → Outbox`);
  };
}

// ---------- Settings ----------
async function settingsView() {
  const s = await GET('/settings');
  view.innerHTML = `<div class="head"><h1>Settings</h1></div>
  <div class="grid g2">
    <div class="card"><h2>General</h2>
      <div class="field"><label class="f">Company name (used in email footers)</label><input data-s="company_name" value="${esc(s.company_name)}"></div>
      <div class="field"><label class="f">From address</label><input data-s="from_email" value="${esc(s.from_email)}"></div>
      <p class="muted">Email delivery: ${s.smtp_configured ? '<span class="pill ok">SMTP configured</span>' : '<span class="pill warn">Dev mode — set SMTP_HOST to deliver</span>'}<br>Public URL: <code>${esc(s.base_url)}</code> (set BASE_URL for tracking links)</p>
    </div>
    <div class="card"><h2>Lead scoring</h2>
      <div class="field"><label class="f">Points per form submission</label><input type="number" data-s="score_form_submit" value="${s.score_form_submit}"></div>
      <div class="field"><label class="f">Points per email open</label><input type="number" data-s="score_email_open" value="${s.score_email_open}"></div>
      <div class="field"><label class="f">Points per email click</label><input type="number" data-s="score_email_click" value="${s.score_email_click}"></div>
      <div class="field"><label class="f">Auto-promote to MQL at score (0 = off)</label><input type="number" data-s="mql_threshold" value="${s.mql_threshold}"></div>
      <p class="muted" style="font-size:12px">Use the "Adjust lead score" workflow step for custom rules (e.g. +20 when tagged "pricing-page").</p>
    </div>
  </div>
  <button class="btn primary" id="s-save" style="margin-top:16px">Save settings</button>`;
  $('#s-save').onclick = async () => {
    const body = {}; $$('[data-s]').forEach(i => body[i.dataset.s] = i.type === 'number' ? Number(i.value) : i.value);
    await PUT('/settings', body); toast('Settings saved');
  };
}

// ---------- Accept invite / reset password ----------
async function acceptInvite(token) {
  $('#login').classList.add('hidden'); $('#shell').classList.add('hidden');
  const box = $('#accept'); box.classList.remove('hidden');
  const r = await fetch('/api/invites/' + encodeURIComponent(token)); const inv = await r.json();
  if (!r.ok) { box.innerHTML = `<div class="card" style="width:380px"><h1>LeadFlow</h1><p class="err">${esc(inv.error)}</p><a href="/">Go to sign in</a></div>`; return; }
  const reset = inv.kind === 'reset';
  box.innerHTML = `<form class="card" id="accept-form" style="width:380px;display:grid;gap:12px">
    <h1 style="margin:0">${reset ? 'Choose a new password' : `Join ${esc(inv.company)}`}</h1>
    <p class="muted" style="margin:0">${reset ? 'For' : 'You were invited as'} <b>${esc(inv.email)}</b>${reset ? '' : ` (${inv.role === 'admin' ? 'Admin' : 'Rep'})`}.</p>
    ${reset ? '' : '<input name="name" placeholder="Your name (shown on leads you work)" required autofocus>'}
    <input type="password" name="password" placeholder="Password (10+ characters)" minlength="10" required autocomplete="new-password">
    <input type="password" name="confirm" placeholder="Repeat password" required autocomplete="new-password">
    <button class="btn primary">${reset ? 'Save password' : 'Create my account'}</button><div class="err" id="accept-err"></div></form>`;
  $('#accept-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.confirm.value) return $('#accept-err').textContent = "Passwords don't match";
    const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name?.value, password: f.password.value }) });
    const j = await res.json();
    if (!res.ok) return $('#accept-err').textContent = j.error;
    history.replaceState(null, '', '/#/'); boot();
  };
}

// ---------- Users (admins) ----------
async function usersView() {
  const d = await GET('/users');
  const roleSel = (id, role) => `<select data-role="${id}" style="width:auto">${opts(['rep', 'admin'], role, { rep: 'Rep', admin: 'Admin' })}</select>`;
  view.innerHTML = `<div class="head"><div><h1>Users</h1><div class="muted">Admins manage users and settings. Reps can do everything else.</div></div></div>
  <div class="grid g-side">
    <div class="card" style="align-self:start"><h2>Invite someone</h2>
      <form id="inv" style="display:grid;gap:10px">
        <input name="email" type="email" placeholder="name@curtisresteq.com" required>
        <select name="role">${opts(['rep', 'admin'], 'rep', { rep: 'Rep', admin: 'Admin' })}</select>
        <button class="btn primary">Create invite link</button>
      </form>
      <div id="inv-result"></div>
      <p class="muted small">Links work once and expire after ${d.invite_days} days. ${'If email is set up, the invite is also emailed.'}</p>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Team</h2>${d.users.length ? `<table><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr>
        ${d.users.map(u => `<tr${u.disabled ? ' style="opacity:.5"' : ''}><td><b>${esc(u.name)}</b>${u.disabled ? ' <span class="pill bad">disabled</span>' : ''}${u.id === ME.id ? ' <span class="pill">you</span>' : ''}</td><td>${esc(u.email)}</td>
          <td>${roleSel(u.id, u.role)}</td><td class="muted small">${u.last_login_at ? fmt(u.last_login_at) : 'never'}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-reset="${u.id}">Reset password</button> <button class="btn sm" data-toggle="${u.id}" data-disabled="${u.disabled}">${u.disabled ? 'Enable' : 'Disable'}</button> <button class="btn sm danger" data-del="${u.id}" data-name="${esc(u.name)}">Remove</button></td></tr>`).join('')}</table>`
        : '<div class="empty">No team members yet. Invite your reps on the left.</div>'}</div>
      <div class="card"><h2>Pending invites</h2>${d.invites.length ? `<table><tr><th>Email</th><th>Type</th><th>Role</th><th>Invited by</th><th>Expires</th><th></th></tr>
        ${d.invites.map(i => `<tr><td>${esc(i.email)}</td><td>${i.kind === 'reset' ? 'Password reset' : 'Invite'}</td><td>${esc(i.role)}</td><td>${esc(i.invited_by)}</td><td class="muted small">${fmt(i.expires_at)}</td><td><button class="btn sm danger" data-revoke="${i.id}">Revoke</button></td></tr>`).join('')}</table>`
        : '<div class="muted">None.</div>'}</div>
    </div>
  </div>`;
  const showLink = (r, label) => {
    $('#inv-result').innerHTML = `<div class="card" style="margin-top:12px;background:#f0fdf4;border-color:#bbf7d0">
      <b>${label} for ${esc(r.email)}</b>${r.emailed ? ' — emailed to them.' : r.email_error ? ` — <span class="err">email failed: ${esc(r.email_error)}</span>` : ' — send them this link:'}
      <input id="inv-link" readonly value="${esc(r.link)}" style="margin-top:8px"><button class="btn sm" id="copy-link" style="margin-top:6px">Copy link</button></div>`;
    $('#copy-link').onclick = () => navigator.clipboard.writeText(r.link).then(() => toast('Link copied'), () => { $('#inv-link').select(); toast('Press Ctrl/Cmd+C to copy'); });
  };
  $('#inv').onsubmit = async e => {
    e.preventDefault();
    try { const r = await POST('/users/invite', { email: e.target.email.value, role: e.target.role.value }); await usersView(); showLink(r, 'Invite created'); }
    catch (err) { toast(err.message, true); }
  };
  $$('[data-reset]').forEach(b => b.onclick = async () => { try { const r = await POST(`/users/${b.dataset.reset}/reset`); await usersView(); showLink(r, 'Password reset link'); } catch (err) { toast(err.message, true); } });
  $$('[data-toggle]').forEach(b => b.onclick = async () => { try { await PATCH('/users/' + b.dataset.toggle, { disabled: b.dataset.disabled !== '1' }); usersView(); } catch (err) { toast(err.message, true); } });
  $$('[data-role]').forEach(sel => sel.onchange = async () => { try { await PATCH('/users/' + sel.dataset.role, { role: sel.value }); toast('Role updated'); } catch (err) { toast(err.message, true); usersView(); } });
  $$('[data-del]').forEach(b => b.onclick = async () => { if (confirm(`Remove ${b.dataset.name}? Their name stays on past activity.`)) { try { await DEL('/users/' + b.dataset.del); usersView(); } catch (err) { toast(err.message, true); } } });
  $$('[data-revoke]').forEach(b => b.onclick = async () => { await DEL('/users/invites/' + b.dataset.revoke); usersView(); });
}

window.addEventListener('DOMContentLoaded', boot);
