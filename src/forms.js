// Forms: definition, validation, submission handling, and the public renderer
// used by both the hosted page (/f/:id) and the embed script (/embed.js).
const crypto = require('crypto');
const { db, parse, getSettings } = require('./db');
const contacts = require('./contacts');
const bus = require('./events');
const mailer = require('./mailer');

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'number', 'hidden'];

function get(id) { return parse(db.prepare('SELECT * FROM forms WHERE id = ?').get(id)); }
function getPublic(publicId) { return parse(db.prepare('SELECT * FROM forms WHERE public_id = ?').get(publicId)); }

function normalize(input) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Form name is required'), { status: 400 });
  const fields = (Array.isArray(input.fields) ? input.fields : []).map(f => ({
    name: String(f.name || '').trim().replace(/[^\w]/g, '_').toLowerCase(),
    label: String(f.label || f.name || ''),
    type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
    required: !!f.required,
    placeholder: String(f.placeholder || ''),
    options: Array.isArray(f.options) ? f.options.map(String).filter(Boolean) : [],
    value: f.type === 'hidden' ? String(f.value || '') : undefined,
  })).filter(f => f.name);
  if (!fields.some(f => f.name === 'email')) {
    throw Object.assign(new Error('Forms must include a field named "email"'), { status: 400 });
  }
  const names = fields.map(f => f.name);
  if (new Set(names).size !== names.length) throw Object.assign(new Error('Field names must be unique'), { status: 400 });
  const s = input.settings || {};
  const settings = {
    submit_label: String(s.submit_label || 'Submit'),
    success_message: String(s.success_message || 'Thanks! We\'ll be in touch.'),
    redirect_url: String(s.redirect_url || ''),
    add_tags: (Array.isArray(s.add_tags) ? s.add_tags : String(s.add_tags || '').split(',')).map(t => t.trim().toLowerCase()).filter(Boolean),
    set_stage: contacts.STAGES.includes(s.set_stage) ? s.set_stage : '',
    notify_email: String(s.notify_email || ''),
    accent_color: /^#[0-9a-f]{3,8}$/i.test(s.accent_color || '') ? s.accent_color : '#4f46e5',
  };
  return { name, fields, settings };
}

function create(input) {
  const f = normalize(input);
  const publicId = crypto.randomBytes(6).toString('hex');
  const info = db.prepare('INSERT INTO forms (public_id, name, fields, settings) VALUES (?, ?, ?, ?)')
    .run(publicId, f.name, JSON.stringify(f.fields), JSON.stringify(f.settings));
  return get(info.lastInsertRowid);
}

function update(id, input) {
  const f = normalize(input);
  db.prepare('UPDATE forms SET name = ?, fields = ?, settings = ? WHERE id = ?')
    .run(f.name, JSON.stringify(f.fields), JSON.stringify(f.settings), id);
  return get(id);
}

function list() {
  return db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count
    FROM forms f ORDER BY f.id DESC`).all().map(parse);
}

// Validate a raw submission against the form definition. Returns { data, errors }.
function validateSubmission(form, raw) {
  const data = {}; const errors = {};
  for (const f of form.fields) {
    let v = raw[f.name];
    if (f.type === 'hidden') v = v || f.value;
    if (f.type === 'checkbox') v = v === true || v === 'true' || v === 'on' || v === '1' || v === 'yes';
    else v = v === undefined || v === null ? '' : String(v).trim().slice(0, 5000);
    if (f.required && (v === '' || v === false)) { errors[f.name] = `${f.label || f.name} is required`; continue; }
    if (f.type === 'email' && v && !contacts.isEmail(v)) errors[f.name] = 'Enter a valid email address';
    if (f.type === 'number' && v !== '' && isNaN(Number(v))) errors[f.name] = 'Enter a number';
    if (f.type === 'select' && v && f.options.length && !f.options.includes(v)) errors[f.name] = 'Invalid choice';
    if (v !== '') data[f.name] = v;
  }
  if (!data.email) errors.email = errors.email || 'Email is required';
  return { data, errors };
}

async function submit(form, raw, meta = {}) {
  // Honeypot: bots fill every field. Pretend success, store nothing.
  if (raw._hp) return { ok: true, spam: true };
  const { data, errors } = validateSubmission(form, raw);
  if (Object.keys(errors).length) return { ok: false, errors };

  // UTM / attribution travels in the meta and is saved as contact properties on first touch.
  const attribution = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) if (meta[k]) attribution[k] = String(meta[k]).slice(0, 200);

  const existing = contacts.getByEmail(data.email);
  const props = existing ? {} : attribution;
  const { contact, created } = contacts.upsert({ ...props, ...data }, { source: `form:${form.name}` });

  const info = db.prepare('INSERT INTO submissions (form_id, contact_id, data, meta) VALUES (?, ?, ?, ?)')
    .run(form.id, contact.id, JSON.stringify(data), JSON.stringify(meta));
  contacts.logActivity(contact.id, 'form', `Submitted form "${form.name}"`, { formId: form.id, submissionId: Number(info.lastInsertRowid), page: meta.page_url });

  const s = form.settings;
  for (const t of s.add_tags || []) contacts.addTag(contact.id, t);
  if (s.set_stage) {
    // Only move contacts forward in the lifecycle from a form, never backward.
    const order = contacts.STAGES;
    const cur = contacts.get(contact.id).stage;
    if (order.indexOf(s.set_stage) > order.indexOf(cur) || cur === 'other') contacts.setStage(contact.id, s.set_stage);
  }
  const { score_form_submit } = getSettings();
  contacts.adjustScore(contact.id, score_form_submit, `submitted "${form.name}"`);

  if (s.notify_email) {
    const rows = Object.entries(data).map(([k, v]) => `<tr><td><b>${mailer.escapeHtml(k)}</b></td><td>${mailer.escapeHtml(v)}</td></tr>`).join('');
    mailer.sendInternal(s.notify_email, `New submission: ${form.name}`,
      `<table>${rows}</table><p><a href="${mailer.BASE_URL()}/#/contacts/${contact.id}">View contact</a></p>`)
      .catch(err => console.error('[forms] notify failed', err.message));
  }

  bus.emit('form_submitted', { contactId: contact.id, formId: form.id });
  return { ok: true, contactId: contact.id, created, message: s.success_message, redirect_url: s.redirect_url };
}

module.exports = { FIELD_TYPES, get, getPublic, create, update, list, submit, validateSubmission };
