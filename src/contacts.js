// Contact (lead) domain logic: upsert, tags, lifecycle stage, scoring, activity timeline.
// Every meaningful change emits an event on the bus so automations can react.
const { db, parse, getSettings } = require('./db');
const bus = require('./events');

const STAGES = ['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'other'];
const CORE_FIELDS = ['first_name', 'last_name', 'phone', 'company'];

function get(id) { return parse(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)); }
function getByEmail(email) { return parse(db.prepare('SELECT * FROM contacts WHERE email = ?').get(String(email).trim())); }

function logActivity(contactId, type, summary, detail = {}) {
  db.prepare('INSERT INTO activities (contact_id, type, summary, detail) VALUES (?, ?, ?, ?)')
    .run(contactId, type, summary, JSON.stringify(detail));
}

function isEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }

// Create or update a contact by email. Non-core keys go into `properties`.
// Existing non-empty values are only overwritten when a new non-empty value is provided.
function upsert(input, { source = '' } = {}) {
  const email = String(input.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw Object.assign(new Error('A valid email is required'), { status: 400 });

  const core = {}; const props = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'email' || v === undefined || v === null || v === '') continue;
    if (CORE_FIELDS.includes(k)) core[k] = String(v);
    else if (!['id', 'tags', 'stage', 'score', 'source', 'unsubscribed', 'created_at', 'updated_at', 'properties'].includes(k)) props[k] = v;
  }
  if (input.properties && typeof input.properties === 'object') Object.assign(props, input.properties);

  let contact = getByEmail(email);
  let created = false;
  if (!contact) {
    const stage = STAGES.includes(input.stage) ? input.stage : 'subscriber';
    const info = db.prepare(`INSERT INTO contacts (email, first_name, last_name, phone, company, stage, source, properties)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(email, core.first_name || '', core.last_name || '', core.phone || '',
      core.company || '', stage, source || input.source || '', JSON.stringify(props));
    contact = get(info.lastInsertRowid);
    created = true;
    logActivity(contact.id, 'created', `Contact created${source ? ` via ${source}` : ''}`);
  } else {
    const merged = { ...contact.properties, ...props };
    const sets = [], vals = [];
    for (const k of CORE_FIELDS) if (core[k] !== undefined) { sets.push(`${k} = ?`); vals.push(core[k]); }
    sets.push('properties = ?', "updated_at = datetime('now')"); vals.push(JSON.stringify(merged));
    db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, contact.id);
    contact = get(contact.id);
  }

  if (Array.isArray(input.tags)) for (const t of input.tags) addTag(contact.id, t);
  if (!created && input.stage && input.stage !== contact.stage) setStage(contact.id, input.stage);
  if (created) bus.emit('contact_created', { contactId: contact.id });
  return { contact: get(contact.id), created };
}

function update(id, input) {
  const c = get(id);
  if (!c) return null;
  const sets = [], vals = [];
  for (const k of CORE_FIELDS) if (input[k] !== undefined) { sets.push(`${k} = ?`); vals.push(String(input[k])); }
  if (input.email !== undefined) {
    if (!isEmail(input.email)) throw Object.assign(new Error('Invalid email'), { status: 400 });
    sets.push('email = ?'); vals.push(input.email.trim().toLowerCase());
  }
  if (input.properties && typeof input.properties === 'object') { sets.push('properties = ?'); vals.push(JSON.stringify(input.properties)); }
  if (input.unsubscribed !== undefined) { sets.push('unsubscribed = ?'); vals.push(input.unsubscribed ? 1 : 0); }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  if (input.stage !== undefined && input.stage !== c.stage) setStage(id, input.stage);
  if (Array.isArray(input.tags)) {
    const cur = get(id).tags;
    for (const t of cur) if (!input.tags.includes(t)) removeTag(id, t);
    for (const t of input.tags) addTag(id, t);
  }
  if (input.score !== undefined && Number(input.score) !== c.score) adjustScore(id, Number(input.score) - c.score, 'Manual adjustment');
  return get(id);
}

function addTag(id, tag) {
  tag = String(tag || '').trim().toLowerCase();
  if (!tag) return;
  const c = get(id);
  if (!c || c.tags.includes(tag)) return;
  db.prepare("UPDATE contacts SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify([...c.tags, tag]), id);
  logActivity(id, 'tag', `Tag added: ${tag}`);
  bus.emit('tag_added', { contactId: id, tag });
}

function removeTag(id, tag) {
  tag = String(tag || '').trim().toLowerCase();
  const c = get(id);
  if (!c || !c.tags.includes(tag)) return;
  db.prepare("UPDATE contacts SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(c.tags.filter(t => t !== tag)), id);
  logActivity(id, 'tag', `Tag removed: ${tag}`);
}

function setStage(id, stage) {
  if (!STAGES.includes(stage)) throw Object.assign(new Error(`Unknown stage: ${stage}`), { status: 400 });
  const c = get(id);
  if (!c || c.stage === stage) return;
  db.prepare("UPDATE contacts SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(stage, id);
  logActivity(id, 'stage', `Lifecycle stage: ${c.stage} → ${stage}`);
  bus.emit('stage_changed', { contactId: id, stage, from: c.stage });
}

function adjustScore(id, delta, reason) {
  delta = Number(delta) || 0;
  if (!delta) return;
  const c = get(id);
  if (!c) return;
  const score = c.score + delta;
  db.prepare("UPDATE contacts SET score = ?, updated_at = datetime('now') WHERE id = ?").run(score, id);
  logActivity(id, 'score', `Score ${delta > 0 ? '+' : ''}${delta} (${reason}) → ${score}`);
  // Auto-promote early-stage contacts to MQL when they cross the threshold.
  const { mql_threshold } = getSettings();
  if (mql_threshold && c.score < mql_threshold && score >= mql_threshold && ['subscriber', 'lead'].includes(c.stage)) {
    setStage(id, 'mql');
  }
}

// Filtered listing used by the contacts table, broadcasts, and CSV export.
function buildFilter({ q, stage, tag, min_score } = {}) {
  const where = [], vals = [];
  if (q) {
    where.push('(email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR company LIKE ?)');
    vals.push(...Array(4).fill(`%${q}%`));
  }
  if (stage) { where.push('stage = ?'); vals.push(stage); }
  if (tag) { where.push('EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)'); vals.push(String(tag).toLowerCase()); }
  if (min_score !== undefined && min_score !== '') { where.push('score >= ?'); vals.push(Number(min_score)); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', vals };
}

function list(filter = {}, { limit = 50, offset = 0, sort = 'created_at', dir = 'desc' } = {}) {
  const { sql, vals } = buildFilter(filter);
  const sortCol = ['created_at', 'updated_at', 'score', 'email', 'stage'].includes(sort) ? sort : 'created_at';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) n FROM contacts ${sql}`).get(...vals).n;
  const rows = db.prepare(`SELECT * FROM contacts ${sql} ORDER BY ${sortCol} ${sortDir}, id DESC LIMIT ? OFFSET ?`)
    .all(...vals, Number(limit), Number(offset)).map(parse);
  return { total, rows };
}

function timeline(id) {
  return db.prepare('SELECT * FROM activities WHERE contact_id = ? ORDER BY id DESC LIMIT 200').all(id).map(parse);
}

module.exports = { STAGES, get, getByEmail, upsert, update, addTag, removeTag, setStage, adjustScore, logActivity, list, buildFilter, timeline, isEmail };
