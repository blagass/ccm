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
const users = require('./users');
const tasks = require('./tasks');
const welcome = require('./welcome');
const branchPage = require('./branch');

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
// Sessions are "<userId>.<expiry>.<hmac>". userId 0 is the built-in owner login (ADMIN_PASSWORD),
// which always works so the account can't be locked out. Disabled users lose access immediately.
const ownerUser = () => ({ id: 0, name: getSettings().owner_name || 'Owner', email: '', role: 'admin' });
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function makeSession(uid) { const v = `${uid}.${Date.now() + 7 * 86400e3}`; return `${v}.${sign(v)}`; }
function sessionUser(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = sign(`${uid}.${exp}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) || Number(exp) < Date.now()) return null;
  if (uid === '0') return ownerUser();
  const u = users.get(Number(uid));
  return u && !u.disabled ? u : null;
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setSession(req, res, uid) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `lf_session=${makeSession(uid)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
}
function requireAuth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (API_KEY && bearer && bearer.length === API_KEY.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(API_KEY))) {
    req.user = { id: 0, name: 'Automated scan', email: '', role: 'admin' };
    return next();
  }
  const u = sessionUser(cookie(req, 'lf_session'));
  if (u) { req.user = u; return next(); }
  res.status(401).json({ error: 'Unauthorized' });
}
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Only admins can do that' });
}

// Brute-force protection: 10 failed logins per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) { const now = Date.now(); const a = (failures.get(ip) || []).filter(t => now - t < 900e3); failures.set(ip, a); return a.length >= 10; }
function recordFailure(ip) { failures.get(ip)?.push(Date.now()) ?? failures.set(ip, [Date.now()]); if (failures.size > 10000) failures.clear(); }

app.post('/api/login', (req, res) => {
  if (tooManyFailures(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const email = String(req.body.email || '').trim();
  const pw = String(req.body.password || '');
  let user = null;
  if (email) user = users.authenticate(email, pw);
  else if (pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD))) user = ownerUser();
  if (!user) { recordFailure(req.ip); return res.status(401).json({ error: email ? 'Wrong email or password' : 'Wrong password' }); }
  setSession(req, res, user.id);
  res.json({ ok: true, user });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'lf_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const user = sessionUser(cookie(req, 'lf_session'));
  res.json({ authenticated: !!user, user, ...(user?.role === 'admin' ? { default_password: ADMIN_PASSWORD === 'admin' } : {}) });
});

// Invite / password-reset links (public: the token is the credential).
app.get('/api/invites/:token', (req, res) => {
  const { invite, error } = users.findInvite(req.params.token);
  if (error) return res.status(410).json({ error });
  res.json({ email: invite.email, role: invite.role, branch: invite.branch, kind: invite.kind, company: getSettings().company_name });
});
app.post('/api/invites/:token/accept', (req, res) => {
  if (tooManyFailures(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  try {
    const user = users.acceptInvite(req.params.token, req.body || {});
    pipeline.claimPlaceholderName(user.name);
    if (user.role === 'manager' && user.branch) pipeline.setBranchOwner(user.branch, user.name);
    setSession(req, res, user.id);
    res.json({ ok: true, user });
  } catch (e) { if (e.status === 410) recordFailure(req.ip); throw e; }
});

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
  branches: getSettings().branches, reps: [...new Set([...(getSettings().reps || []), ...users.names(), ...db.prepare("SELECT DISTINCT assigned_rep r FROM opportunities WHERE assigned_rep != ''").all().map(r => r.r)])].sort(),
  weeks: pipeline.weeks(), current_week: pipeline.mondayOf(),
  branch_owners: getSettings().branch_owners || {}, my_branches: branchPage.branchesOwnedBy(req.user.name, req.user.role === 'manager' ? req.user.branch : null),
}));
api.get('/pipeline/summary', (req, res) => res.json(pipeline.summary(req.query.week)));
api.get('/branches/:branch', (req, res) => res.json(branchPage.branchSummary(req.params.branch, { week: req.query.week, today: req.query.today })));
api.put('/pipeline/reports/:week', (req, res) => res.json(pipeline.saveReport(req.params.week, req.body)));
api.post('/pipeline/assign-by-branch', requireAdmin, (req, res) => res.json({ assigned: pipeline.assignByBranch(req.user.name) }));
api.post('/pipeline/reports/:week/focus', (req, res) => {
  const o = pipeline.get(Number(req.body.opportunity_id));
  if (!o) return res.status(404).json({ error: 'Prospect not found' });
  const cur = pipeline.getReport(req.params.week).focus || [];
  if (cur.some(f => Number(f.opportunity_id) === o.id)) return res.status(409).json({ error: `${o.business} is already on this week's focus list` });
  const saved = pipeline.saveReport(req.params.week, { focus: [...cur, { opportunity_id: o.id, action: String(req.body.action || o.next_step || 'Make first contact'), why: String(req.body.why || o.stage || '') }] });
  pipeline.log(o.id, 'focus', `Added to the focus list for the week of ${req.params.week}`, req.user.name);
  res.status(201).json(saved);
});
api.get('/opportunities', (req, res) => res.json(pipeline.list(req.query)));
api.post('/opportunities', (req, res) => res.status(201).json(pipeline.create(req.body, { week: req.body.week, actor: req.user.name })));
api.get('/opportunities/:id', (req, res) => {
  const o = pipeline.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json({ ...o, personas: pipeline.personasFor(o.persona), activity: pipeline.activity(o.id) });
});
api.patch('/opportunities/:id', (req, res) => {
  const o = pipeline.update(Number(req.params.id), req.body, { actor: req.user.name });
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});
api.delete('/opportunities/:id', (req, res) => { db.prepare('DELETE FROM opportunities WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
api.post('/opportunities/:id/notes', (req, res) => {
  const t = String(req.body.text || '').trim();
  if (!t || !pipeline.get(req.params.id)) return res.status(400).json({ error: 'Note text required' });
  pipeline.log(Number(req.params.id), 'note', t, req.user.name);
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
api.post('/pipeline/import', requireAdmin, express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
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
  // Never let automated research overwrite notes a person imported or edited for that week.
  if (report && typeof report === 'object') {
    const existing = pipeline.getReport(week);
    if (existing.source && existing.source !== 'scan') out.report = `kept: this week's notes were ${existing.source === 'import' ? 'imported from a file' : 'edited by hand'}`;
    else { pipeline.saveReport(week, report, { source: 'scan' }); out.report = true; }
  }
  res.json(out);
});
api.get('/pipeline/export.xlsx', wrap(async (req, res) => {
  const { buffer, filename } = await xlsx.exportWorkbook(req.query.week, { company: getSettings().company_name, scope: req.query.scope });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"` }).send(Buffer.from(buffer));
}));

// Settings
const APP_VERSION = require('../package.json').version;
api.get('/settings', (req, res) => res.json({ ...getSettings(), smtp_configured: !!process.env.SMTP_HOST, base_url: mailer.BASE_URL(), app_version: APP_VERSION }));
api.put('/settings', requireAdmin, (req, res) => res.json(setSettings(req.body)));

// Daily welcome popup
api.get('/welcome', (req, res) => {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : new Date().toISOString().slice(0, 10);
  const hour = Math.min(23, Math.max(0, Number(req.query.hour) || 9));
  res.json(welcome.briefing(req.user, { today, hour }));
});

// ---------- Calendar & tasks ----------
api.get('/calendar', (req, res) => res.json(tasks.calendar({ from: req.query.from, to: req.query.to, today: req.query.today, mine: req.query.mine === '1' ? req.user.name : null })));
api.post('/tasks', (req, res) => res.status(201).json(tasks.create(req.body || {}, req.user.name)));
api.patch('/tasks/:id', (req, res) => { const t = tasks.update(Number(req.params.id), req.body || {}, req.user.name); t ? res.json(t) : res.status(404).json({ error: 'Not found' }); });
api.delete('/tasks/:id', (req, res) => { tasks.remove(Number(req.params.id)); res.json({ ok: true }); });
api.get('/opportunities/:id/tasks', (req, res) => res.json(tasks.forLead(Number(req.params.id))));

// ---------- Team (admins only) ----------
api.get('/users', requireAdmin, (req, res) => res.json({ users: users.list(), invites: users.pendingInvites(), invite_days: users.INVITE_DAYS }));
function inviteLink(token) { return `${mailer.BASE_URL()}/#/accept/${token}`; }
async function emailLink(inv, link, byName) {
  if (!process.env.SMTP_HOST) return false;
  const company = mailer.escapeHtml(getSettings().company_name);
  const what = inv.kind === 'reset' ? 'reset your My Curtis password' : `join ${company} on My Curtis${inv.role === 'manager' && inv.branch ? ` as the ${mailer.escapeHtml(inv.branch)} branch manager` : ''}`;
  await mailer.sendInternal(inv.email, inv.kind === 'reset' ? 'Reset your My Curtis password' : `${byName} invited you to My Curtis`,
    `<p>Hi,</p><p>${mailer.escapeHtml(byName)} has invited you to ${what}.</p><p><a href="${link}">${inv.kind === 'reset' ? 'Choose a new password' : 'Accept the invite'}</a></p><p style="color:#888;font-size:12px">This link expires in ${users.INVITE_DAYS} days and can be used once.</p>`);
  return true;
}
api.post('/users/invite', requireAdmin, wrap(async (req, res) => {
  const inv = users.createInvite(req.body || {}, req.user.name);
  const link = inviteLink(inv.token);
  let emailed = false, email_error = null;
  try { emailed = await emailLink(inv, link, req.user.name); } catch (e) { email_error = e.message; }
  res.status(201).json({ link, email: inv.email, role: inv.role, branch: inv.branch, expires_at: inv.expires_at, emailed, email_error });
}));
api.post('/users/:id/reset', requireAdmin, wrap(async (req, res) => {
  const inv = users.createReset(Number(req.params.id), req.user.name);
  const link = inviteLink(inv.token);
  let emailed = false, email_error = null;
  try { emailed = await emailLink(inv, link, req.user.name); } catch (e) { email_error = e.message; }
  res.json({ link, email: inv.email, expires_at: inv.expires_at, emailed, email_error });
}));
api.delete('/users/invites/:id', requireAdmin, (req, res) => { users.revokeInvite(Number(req.params.id)); res.json({ ok: true }); });
api.patch('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id && (req.body.role === 'rep' || req.body.disabled)) return res.status(400).json({ error: "You can't demote or disable your own account" });
  const u = users.update(id, req.body || {});
  if (u && req.body?.name) pipeline.claimPlaceholderName(u.name);
  if (u && u.role === 'manager' && u.branch && (req.body?.role || req.body?.branch)) pipeline.setBranchOwner(u.branch, u.name);
  u ? res.json(u) : res.status(404).json({ error: 'Not found' });
});
api.delete('/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  users.remove(Number(req.params.id)); res.json({ ok: true });
});

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
    console.log(`My Curtis running at ${mailer.BASE_URL()}`);
    if (ADMIN_PASSWORD === 'admin') console.warn('⚠  Using default password "admin" — set ADMIN_PASSWORD before deploying.');
    if (!process.env.SMTP_HOST) console.warn('ℹ  SMTP_HOST not set — emails are recorded in the Outbox but not delivered.');
  });
}
