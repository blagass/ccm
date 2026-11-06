// HTTP server: admin API (auth required), public form/tracking endpoints, static UI.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, parse, getSettings, setSettings } = require('./db');
const contacts = require('./contacts');
const forms = require('./forms');
const mailer = require('./mailer');
const automation = require('./automation');
const bus = require('./events');
const pipeline = require('./pipeline');
const xlsx = require('./xlsx');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const API_KEY = process.env.API_KEY || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('leadflow:' + ADMIN_PASSWORD).digest('hex');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Auth ----------
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function makeSession() { const exp = String(Date.now() + 7 * 86400e3); return `${exp}.${sign(exp)}`; }
function validSession(tok) {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function requireAuth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (API_KEY && bearer && bearer.length === API_KEY.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(API_KEY))) return next();
  if (validSession(cookie(req, 'lf_session'))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  const pw = String(req.body.password || '');
  const ok = pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `lf_session=${makeSession()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'lf_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ authenticated: validSession(cookie(req, 'lf_session')), default_password: ADMIN_PASSWORD === 'admin' }));

// ---------- Public endpoints (no auth, CORS open so forms work on any site) ----------
const pub = express.Router();
pub.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Basic in-memory rate limit for submissions: 20 per IP per 10 minutes.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 600e3);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 10000) hits.clear();
  return arr.length > 20;
}

pub.get('/forms/:publicId', (req, res) => {
  const f = forms.getPublic(req.params.publicId);
  if (!f) return res.status(404).json({ error: 'Form not found' });
  res.json({ id: f.public_id, name: f.name, fields: f.fields, settings: { submit_label: f.settings.submit_label, accent_color: f.settings.accent_color } });
});

pub.post('/forms/:publicId/submit', wrap(async (req, res) => {
  const f = forms.getPublic(req.params.publicId);
  if (!f) return res.status(404).json({ error: 'Form not found' });
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many submissions, try again later' });
  const raw = { ...req.body };
  const meta = { ...(raw._meta && typeof raw._meta === 'object' ? raw._meta : {}), ip: req.ip, user_agent: req.headers['user-agent'] || '' };
  delete raw._meta;
  for (const k of Object.keys(raw)) if (k.startsWith('utm_')) { meta[k] = raw[k]; delete raw[k]; }
  const result = await forms.submit(f, raw, meta);
  // Plain HTML <form> posts (no JS) get a redirect or a simple thank-you page.
  if (req.is('application/x-www-form-urlencoded') && req.accepts(['html', 'json']) === 'html') {
    if (!result.ok) return res.status(400).send(`<p>${Object.values(result.errors).map(mailer.escapeHtml).join('<br>')}</p><p><a href="javascript:history.back()">Go back</a></p>`);
    if (f.settings.redirect_url) return res.redirect(303, f.settings.redirect_url);
    return res.send(`<!doctype html><meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;padding:2rem">${mailer.escapeHtml(f.settings.success_message)}</p>`);
  }
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, message: f.settings.success_message, redirect_url: f.settings.redirect_url || null });
}));
app.use('/api/public', pub);

// Hosted form page
app.get('/f/:publicId', (req, res) => {
  const f = forms.getPublic(req.params.publicId);
  if (!f) return res.status(404).send('Form not found');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${mailer.escapeHtml(f.name)}</title><style>body{font-family:system-ui,sans-serif;background:#f6f7fb;margin:0;padding:40px 16px}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 20px}</style></head>
<body><div class="card"><h1>${mailer.escapeHtml(f.name)}</h1><div data-leadflow-form="${f.public_id}"></div></div>
<script src="/embed.js" async></script></body></html>`);
});

// Email tracking: open pixel, click redirect, unsubscribe
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/t/o/:token.gif', (req, res) => {
  const s = mailer.getSend(req.params.token);
  if (s && !s.opened_at && s.contact_id) {
    db.prepare("UPDATE email_sends SET opened_at = datetime('now') WHERE id = ?").run(s.id);
    contacts.logActivity(s.contact_id, 'email_open', `Opened email "${s.subject}"`, { token: s.token });
    contacts.adjustScore(s.contact_id, getSettings().score_email_open, 'email open');
    bus.emit('email_opened', { contactId: s.contact_id, templateId: s.template_id });
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(PIXEL);
});
app.get('/t/c/:token', (req, res) => {
  const url = String(req.query.u || '');
  if (!/^https?:\/\//i.test(url)) return res.status(400).send('Bad link');
  const s = mailer.getSend(req.params.token);
  if (!s) return res.status(404).send('Link expired');
  if (s.contact_id) {
    if (!s.opened_at) db.prepare("UPDATE email_sends SET opened_at = datetime('now') WHERE id = ?").run(s.id);
    // Only follow URLs that actually appear in the email, so this isn't an open redirect.
    if (!s.html || !s.html.includes(`u=${encodeURIComponent(url)}`)) return res.status(400).send('Bad link');
    contacts.logActivity(s.contact_id, 'email_click', `Clicked ${url} in "${s.subject}"`, { token: s.token, url });
    if (!s.clicked_at) {
      db.prepare("UPDATE email_sends SET clicked_at = datetime('now') WHERE id = ?").run(s.id);
      contacts.adjustScore(s.contact_id, getSettings().score_email_click, 'email click');
      bus.emit('email_clicked', { contactId: s.contact_id, templateId: s.template_id });
    }
  }
  res.redirect(302, url);
});
app.get('/u/:token', (req, res) => {
  const s = mailer.getSend(req.params.token);
  if (!s || !s.contact_id) return res.status(404).send('Link not found');
  const c = contacts.get(s.contact_id);
  res.send(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2rem;max-width:480px;margin:auto">
  <h2>Unsubscribe</h2><p>Stop receiving marketing emails at <b>${mailer.escapeHtml(c?.email)}</b>?</p>
  <form method="post"><button style="padding:10px 18px">Unsubscribe</button></form></body>`);
});
app.post('/u/:token', (req, res) => {
  const s = mailer.getSend(req.params.token);
  if (!s || !s.contact_id) return res.status(404).send('Link not found');
  db.prepare("UPDATE contacts SET unsubscribed = 1, updated_at = datetime('now') WHERE id = ?").run(s.contact_id);
  contacts.logActivity(s.contact_id, 'unsubscribe', 'Unsubscribed from emails');
  res.send('<!doctype html><body style="font-family:sans-serif;padding:2rem"><h2>You have been unsubscribed.</h2></body>');
});

// ---------- Admin API ----------
const api = express.Router();
api.use(requireAuth);

api.get('/dashboard', (req, res) => {
  const one = (sql, ...v) => db.prepare(sql).get(...v);
  const stats = {
    contacts: one('SELECT COUNT(*) n FROM contacts').n,
    new_contacts_30d: one("SELECT COUNT(*) n FROM contacts WHERE created_at >= datetime('now','-30 days')").n,
    submissions_30d: one("SELECT COUNT(*) n FROM submissions WHERE created_at >= datetime('now','-30 days')").n,
    emails_sent_30d: one("SELECT COUNT(*) n FROM email_sends WHERE status IN ('sent','sent_dev') AND created_at >= datetime('now','-30 days')").n,
    opened_30d: one("SELECT COUNT(*) n FROM email_sends WHERE opened_at IS NOT NULL AND created_at >= datetime('now','-30 days')").n,
    clicked_30d: one("SELECT COUNT(*) n FROM email_sends WHERE clicked_at IS NOT NULL AND created_at >= datetime('now','-30 days')").n,
    active_workflows: one('SELECT COUNT(*) n FROM workflows WHERE active = 1').n,
    active_runs: one("SELECT COUNT(*) n FROM workflow_runs WHERE status IN ('active','running')").n,
  };
  const stages = db.prepare('SELECT stage, COUNT(*) n FROM contacts GROUP BY stage').all();
  const daily = db.prepare(`SELECT date(created_at) d, COUNT(*) n FROM submissions WHERE created_at >= date('now','-29 days') GROUP BY d ORDER BY d`).all();
  const topForms = db.prepare(`SELECT f.id, f.name, COUNT(s.id) n FROM forms f LEFT JOIN submissions s ON s.form_id = f.id AND s.created_at >= datetime('now','-30 days') GROUP BY f.id ORDER BY n DESC LIMIT 5`).all();
  const recent = db.prepare(`SELECT a.*, c.email FROM activities a JOIN contacts c ON c.id = a.contact_id ORDER BY a.id DESC LIMIT 15`).all();
  const hot = db.prepare(`SELECT id, email, first_name, last_name, company, score, stage FROM contacts ORDER BY score DESC LIMIT 5`).all();
  res.json({ stats, stages, daily, topForms, recent, hot });
});

// Contacts
api.get('/contacts', (req, res) => {
  const { q, stage, tag, min_score, limit = 50, offset = 0, sort, dir } = req.query;
  res.json(contacts.list({ q, stage, tag, min_score }, { limit: Math.min(Number(limit) || 50, 500), offset, sort, dir }));
});
api.get('/contacts/export.csv', (req, res) => {
  const { q, stage, tag, min_score } = req.query;
  const { rows } = contacts.list({ q, stage, tag, min_score }, { limit: 1e9 });
  const propKeys = [...new Set(rows.flatMap(r => Object.keys(r.properties || {})))];
  const cols = ['email', 'first_name', 'last_name', 'phone', 'company', 'stage', 'score', 'source', 'tags', 'unsubscribed', 'created_at', ...propKeys];
  const esc = v => { let s = Array.isArray(v) ? v.join(';') : String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(','), ...rows.map(r => cols.map(c => esc(c in r && c !== 'properties' ? r[c] : r.properties?.[c])).join(','))];
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="contacts.csv"' }).send(lines.join('\n'));
});
api.post('/contacts/import', (req, res) => {
  // Accepts { rows: [{email, first_name, ...}], tags: [] } — the UI parses CSV client-side.
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  let created = 0, updated = 0; const errors = [];
  rows.forEach((r, i) => {
    try {
      const { created: c } = contacts.upsert({ ...r, tags: [...(req.body.tags || []), ...(r.tags ? String(r.tags).split(/[;,]/) : [])] }, { source: 'import' });
      c ? created++ : updated++;
    } catch (e) { errors.push({ row: i + 1, error: e.message }); }
  });
  res.json({ created, updated, errors: errors.slice(0, 50) });
});
api.post('/contacts', (req, res) => {
  const { contact, created } = contacts.upsert(req.body, { source: req.body.source || 'manual' });
  res.status(created ? 201 : 200).json(contact);
});
api.get('/contacts/:id', (req, res) => {
  const c = contacts.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const submissions = db.prepare('SELECT s.*, f.name form_name FROM submissions s JOIN forms f ON f.id = s.form_id WHERE contact_id = ? ORDER BY s.id DESC').all(c.id).map(parse);
  const runs = db.prepare('SELECT r.id, r.status, r.step_index, r.next_run_at, r.created_at, w.name workflow_name, w.id workflow_id FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE contact_id = ? ORDER BY r.id DESC').all(c.id);
  const emails = db.prepare('SELECT id, subject, status, opened_at, clicked_at, created_at FROM email_sends WHERE contact_id = ? ORDER BY id DESC LIMIT 50').all(c.id);
  res.json({ ...c, timeline: contacts.timeline(c.id), submissions, runs, emails });
});
api.patch('/contacts/:id', (req, res) => {
  const c = contacts.update(Number(req.params.id), req.body);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});
api.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
api.post('/contacts/:id/notes', (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text || !contacts.get(req.params.id)) return res.status(400).json({ error: 'Note text required' });
  contacts.logActivity(Number(req.params.id), 'note', text);
  res.json({ ok: true });
});
api.post('/contacts/:id/email', wrap(async (req, res) => {
  res.json(await mailer.sendToContact(Number(req.params.id), { templateId: req.body.template_id, subject: req.body.subject, body: req.body.body, source: 'manual' }));
}));
api.post('/contacts/:id/enroll', (req, res) => {
  const runId = automation.enroll(Number(req.body.workflow_id), Number(req.params.id), { force: true });
  if (!runId) return res.status(409).json({ error: 'Contact is already running this workflow' });
  res.json({ ok: true, run_id: runId });
});
api.get('/tags', (req, res) => {
  res.json(db.prepare('SELECT value tag, COUNT(*) n FROM contacts, json_each(contacts.tags) GROUP BY value ORDER BY n DESC').all());
});
api.get('/meta', (req, res) => res.json({ stages: contacts.STAGES, field_types: forms.FIELD_TYPES, triggers: automation.TRIGGERS, step_types: automation.STEP_TYPES }));

// Forms
api.get('/forms', (req, res) => res.json(forms.list()));
api.post('/forms', (req, res) => res.status(201).json(forms.create(req.body)));
api.get('/forms/:id', (req, res) => { const f = forms.get(req.params.id); f ? res.json(f) : res.status(404).json({ error: 'Not found' }); });
api.put('/forms/:id', (req, res) => { if (!forms.get(req.params.id)) return res.status(404).json({ error: 'Not found' }); res.json(forms.update(Number(req.params.id), req.body)); });
api.delete('/forms/:id', (req, res) => { db.prepare('DELETE FROM forms WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
api.get('/forms/:id/submissions', (req, res) => {
  res.json(db.prepare(`SELECT s.*, c.email FROM submissions s LEFT JOIN contacts c ON c.id = s.contact_id WHERE form_id = ? ORDER BY s.id DESC LIMIT 500`).all(req.params.id).map(parse));
});

// Email templates
api.get('/templates', (req, res) => res.json(db.prepare(`SELECT t.*,
  (SELECT COUNT(*) FROM email_sends e WHERE e.template_id = t.id AND e.status IN ('sent','sent_dev')) sent,
  (SELECT COUNT(*) FROM email_sends e WHERE e.template_id = t.id AND e.opened_at IS NOT NULL) opened,
  (SELECT COUNT(*) FROM email_sends e WHERE e.template_id = t.id AND e.clicked_at IS NOT NULL) clicked
  FROM templates t ORDER BY id DESC`).all()));
function checkTemplate(b) { if (!b.name || !b.subject || !b.body) throw Object.assign(new Error('name, subject and body are required'), { status: 400 }); }
api.post('/templates', (req, res) => {
  checkTemplate(req.body);
  const info = db.prepare('INSERT INTO templates (name, subject, body) VALUES (?, ?, ?)').run(req.body.name, req.body.subject, req.body.body);
  res.status(201).json(db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid));
});
api.put('/templates/:id', (req, res) => {
  checkTemplate(req.body);
  db.prepare('UPDATE templates SET name = ?, subject = ?, body = ? WHERE id = ?').run(req.body.name, req.body.subject, req.body.body, req.params.id);
  res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id));
});
api.delete('/templates/:id', (req, res) => { db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
api.get('/outbox', (req, res) => res.json(db.prepare(`SELECT e.id, e.subject, e.status, e.error, e.source, e.opened_at, e.clicked_at, e.created_at, c.email, c.id contact_id
  FROM email_sends e LEFT JOIN contacts c ON c.id = e.contact_id ORDER BY e.id DESC LIMIT 200`).all()));
api.get('/outbox/:id', (req, res) => { const e = db.prepare('SELECT * FROM email_sends WHERE id = ?').get(req.params.id); e ? res.json(e) : res.status(404).json({ error: 'Not found' }); });

// Broadcasts: one-off send of a template to a segment.
api.post('/broadcasts/preview', (req, res) => {
  const { sql, vals } = contacts.buildFilter(req.body.filter || {});
  const where = sql ? `${sql} AND unsubscribed = 0` : 'WHERE unsubscribed = 0';
  res.json({ recipients: db.prepare(`SELECT COUNT(*) n FROM contacts ${where}`).get(...vals).n });
});
api.post('/broadcasts', wrap(async (req, res) => {
  const tpl = db.prepare('SELECT id FROM templates WHERE id = ?').get(req.body.template_id);
  if (!tpl) return res.status(400).json({ error: 'Pick a template' });
  const { sql, vals } = contacts.buildFilter(req.body.filter || {});
  const where = sql ? `${sql} AND unsubscribed = 0` : 'WHERE unsubscribed = 0';
  const ids = db.prepare(`SELECT id FROM contacts ${where}`).all(...vals).map(r => r.id);
  res.json({ queued: ids.length });
  // Send in the background so large lists don't block the request.
  (async () => { for (const id of ids) await mailer.sendToContact(id, { templateId: tpl.id, source: 'broadcast' }); })()
    .catch(e => console.error('[broadcast]', e));
}));

// Workflows
api.get('/workflows', (req, res) => res.json(db.prepare(`SELECT w.*,
  (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id) enrolled,
  (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id AND r.status IN ('active','running')) in_progress,
  (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id AND r.status = 'completed') completed
  FROM workflows w ORDER BY id DESC`).all().map(parse)));
api.post('/workflows', (req, res) => {
  automation.validate(req.body);
  const info = db.prepare('INSERT INTO workflows (name, trigger, steps, active) VALUES (?, ?, ?, ?)')
    .run(req.body.name, JSON.stringify(req.body.trigger), JSON.stringify(req.body.steps), req.body.active ? 1 : 0);
  res.status(201).json(parse(db.prepare('SELECT * FROM workflows WHERE id = ?').get(info.lastInsertRowid)));
});
api.get('/workflows/:id', (req, res) => {
  const w = parse(db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  w.runs = db.prepare('SELECT r.*, c.email FROM workflow_runs r JOIN contacts c ON c.id = r.contact_id WHERE workflow_id = ? ORDER BY r.id DESC LIMIT 200').all(w.id).map(parse);
  res.json(w);
});
api.put('/workflows/:id', (req, res) => {
  automation.validate(req.body);
  db.prepare('UPDATE workflows SET name = ?, trigger = ?, steps = ?, active = ? WHERE id = ?')
    .run(req.body.name, JSON.stringify(req.body.trigger), JSON.stringify(req.body.steps), req.body.active ? 1 : 0, req.params.id);
  if (req.body.active) automation.resumePaused(Number(req.params.id));
  res.json(parse(db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)));
});
api.delete('/workflows/:id', (req, res) => { db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

// ---------- Sales pipeline (weekly lead scan, switch prospects, chain accounts) ----------
api.get('/pipeline/meta', (req, res) => res.json({
  list_types: pipeline.LIST_TYPES, priorities: pipeline.PRIORITIES, statuses: pipeline.STATUSES, columns: pipeline.COLUMNS,
  branches: getSettings().branches, reps: [...new Set([...(getSettings().reps || []), ...db.prepare("SELECT DISTINCT assigned_rep r FROM opportunities WHERE assigned_rep != ''").all().map(r => r.r)])].sort(),
  weeks: pipeline.weeks(), current_week: pipeline.mondayOf(),
}));
api.get('/pipeline/summary', (req, res) => res.json(pipeline.summary(req.query.week)));
api.put('/pipeline/reports/:week', (req, res) => res.json(pipeline.saveReport(req.params.week, req.body)));
api.get('/opportunities', (req, res) => res.json(pipeline.list(req.query)));
api.post('/opportunities', (req, res) => res.status(201).json(pipeline.create(req.body, { week: req.body.week })));
api.get('/opportunities/:id', (req, res) => {
  const o = pipeline.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json({ ...o, personas: pipeline.personasFor(o.persona), activity: pipeline.activity(o.id) });
});
api.patch('/opportunities/:id', (req, res) => {
  const o = pipeline.update(Number(req.params.id), req.body);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});
api.delete('/opportunities/:id', (req, res) => { db.prepare('DELETE FROM opportunities WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
api.post('/opportunities/:id/notes', (req, res) => {
  const t = String(req.body.text || '').trim();
  if (!t || !pipeline.get(req.params.id)) return res.status(400).json({ error: 'Note text required' });
  pipeline.log(Number(req.params.id), 'note', t);
  res.json({ ok: true });
});
// Turn a prospect into a marketing contact so workflows/emails can run against them.
api.post('/opportunities/:id/contact', (req, res) => {
  const o = pipeline.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const { contact } = contacts.upsert({ ...req.body, company: o.business, properties: { branch: o.branch, opportunity_id: o.id } }, { source: 'pipeline' });
  contacts.addTag(contact.id, 'pipeline');
  pipeline.log(o.id, 'contact', `Linked contact ${contact.email}`);
  res.json(contacts.get(contact.id));
});
api.get('/personas', (req, res) => res.json(pipeline.personas()));
api.post('/personas', (req, res) => res.json(pipeline.upsertPersona(req.body)));
api.delete('/personas/:id', (req, res) => { db.prepare('DELETE FROM personas WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
api.post('/pipeline/import', express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'Upload an .xlsx file' });
  res.json(await xlsx.importWorkbook(req.body, { week: req.query.week || undefined }));
}));
// Automated weekly scan: same merge rules as the Excel import, but JSON in.
// Body: { week, opportunities: [...], personas?: [...], report?: {headline, focus, plays, risks, sources} }
api.post('/pipeline/scan', (req, res) => {
  const { week, opportunities = [], personas = [], report } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week || ''))) return res.status(400).json({ error: 'week must be YYYY-MM-DD (the Monday of the scan week)' });
  if (!Array.isArray(opportunities)) return res.status(400).json({ error: 'opportunities must be a list' });
  const out = { week, created: 0, updated: 0, duplicates: [], errors: [], personas: 0, report: false };
  for (const p of personas) { try { pipeline.upsertPersona(p); out.personas++; } catch (e) { out.errors.push({ persona: p?.name, error: e.message }); } }
  opportunities.forEach((o, i) => {
    try {
      const r = pipeline.upsertFromScan(o, week);
      if (r.action === 'created') out.created++; else if (r.action === 'updated') out.updated++; else out.duplicates.push(r.note);
    } catch (e) { out.errors.push({ row: i, business: o?.business, error: e.message }); }
  });
  if (report && typeof report === 'object') { pipeline.saveReport(week, report); out.report = true; }
  res.json(out);
});
api.get('/pipeline/export.xlsx', wrap(async (req, res) => {
  const { buffer, filename } = await xlsx.exportWorkbook(req.query.week, { company: getSettings().company_name, scope: req.query.scope });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"` }).send(Buffer.from(buffer));
}));

// Settings
api.get('/settings', (req, res) => res.json({ ...getSettings(), smtp_configured: !!process.env.SMTP_HOST, base_url: mailer.BASE_URL() }));
api.put('/settings', (req, res) => res.json(setSettings(req.body)));

app.use('/api', api);

// Static admin UI + embed script
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
});

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  automation.start();
  app.listen(port, () => {
    console.log(`LeadFlow running at ${mailer.BASE_URL()}`);
    if (ADMIN_PASSWORD === 'admin') console.warn('⚠  Using default password "admin" — set ADMIN_PASSWORD before deploying.');
    if (!process.env.SMTP_HOST) console.warn('ℹ  SMTP_HOST not set — emails are recorded in the Outbox but not delivered.');
  });
}
