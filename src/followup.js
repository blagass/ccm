// Follow-up: approved leads nobody in their branch has opened yet, and the reminders Operators send about them.
// A lead counts as "looked at" once its branch manager or assigned person opens its brief, or anyone
// outside the Operator/Admin team works it (status, note, task). Moving it to another branch starts over.
const { db, parse, getSettings } = require('./db');
const pipeline = require('./pipeline');

db.exec(`
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_name TEXT NOT NULL,
  branch TEXT DEFAULT '',
  from_name TEXT DEFAULT '',
  message TEXT NOT NULL,
  lead_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  dismissed_at TEXT
);
`);

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== '';
const isOps = u => u && (u.role === 'admin' || u.role === 'operator');
const ymd = s => String(s || '').slice(0, 10);
const daysBetween = (from, to) => Math.max(0, Math.floor((new Date(ymd(to) + 'T00:00:00Z') - new Date(ymd(from) + 'T00:00:00Z')) / 864e5));
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const OPEN = `status NOT IN ${pipeline.CLOSED_SQL} AND (review_status IS NULL OR review_status != 'pending')`;

// Record the first time someone in the branch opens ('view') or works ('work') a lead.
function touch(id, user, kind = 'view') {
  if (!user || !user.name) return false;
  const o = pipeline.get(Number(id));
  if (!o || o.touched_at || o.review_status === 'pending') return false;
  const assigned = same(user.name, o.assigned_rep);
  const counts = kind === 'view' ? (user.role === 'manager' || assigned) : (!isOps(user) || assigned);
  if (!counts) return false;
  db.prepare("UPDATE opportunities SET touched_at = datetime('now'), touched_by = ? WHERE id = ? AND touched_at IS NULL").run(user.name, o.id);
  pipeline.log(o.id, 'seen', `First ${kind === 'view' ? 'opened' : 'worked'} by ${user.name}`, user.name);
  return true;
}

// Red: Hot and waiting more than 3 days, or a deadline inside a week. Orange: waiting more than 7 days.
function urgency(o, days, today) {
  if ((o.priority === 'Hot' && days > 3) || (o.deadline && o.deadline <= addDays(today, 7))) return 'red';
  if (days > 7) return 'orange';
  return '';
}

function lastReminder(to) {
  const r = db.prepare('SELECT * FROM reminders WHERE lower(to_name) = lower(?) ORDER BY id DESC LIMIT 1').get(to);
  if (!r) return null;
  const ids = JSON.parse(r.lead_ids || '[]');
  const opened = ids.filter(id => { const o = pipeline.get(id); return !o || o.touched_at || pipeline.CLOSED.includes(o.status); }).length;
  return { id: r.id, at: r.created_at, from: r.from_name, leads: ids.length, opened_since: opened };
}

// Everything the Operator page needs, grouped by branch and the person each lead is with.
function untouched({ today } = {}) {
  today = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? today : new Date().toISOString().slice(0, 10);
  const owners = getSettings().branch_owners || {};
  const rows = db.prepare(`SELECT * FROM opportunities WHERE ${OPEN} AND touched_at IS NULL`).all().map(parse);
  const groups = new Map();
  for (const o of rows) {
    const branch = pipeline.primaryBranch(o.branch) || '';
    const to = o.assigned_rep || owners[branch] || '';
    const days = daysBetween(o.routed_at || o.created_at, today);
    const key = `${branch}|${to.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { branch, to, leads: [] });
    groups.get(key).leads.push({ id: o.id, business: o.business, location: o.location, priority: o.priority, stage: o.stage, status: o.status,
      deadline: o.deadline, next_step: o.next_step, decision_timeline: o.decision_timeline, list_type: o.list_type, days, urgency: urgency(o, days, today) });
  }
  const rank = { red: 0, orange: 1, '': 2 }, pri = { Hot: 0, Warm: 1, Watch: 2 };
  const out = [...groups.values()].map(g => {
    g.leads.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (pri[a.priority] ?? 3) - (pri[b.priority] ?? 3) || b.days - a.days);
    return { ...g, hot: g.leads.filter(l => l.priority === 'Hot').length, red: g.leads.filter(l => l.urgency === 'red').length,
      oldest: Math.max(...g.leads.map(l => l.days)), last_reminder: g.to ? lastReminder(g.to) : null };
  }).sort((a, b) => (!a.to) - (!b.to) || b.red - a.red || b.leads.length - a.leads.length);
  const all = out.flatMap(g => g.leads);
  return { today, groups: out, stats: { untouched: all.length, red: all.filter(l => l.urgency === 'red').length, over_3: all.filter(l => l.days > 3).length, over_7: all.filter(l => l.days > 7).length } };
}

function create(input, fromName) {
  const to = String(input.to_name || '').trim();
  const message = String(input.message || '').trim();
  if (!to) throw err('Pick who the reminder is for');
  if (!message) throw err('Write a short message');
  const ids = [...new Set((Array.isArray(input.lead_ids) ? input.lead_ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))]
    .filter(id => pipeline.get(id));
  if (!ids.length) throw err('Pick at least one lead');
  const info = db.prepare('INSERT INTO reminders (to_name, branch, from_name, message, lead_ids) VALUES (?, ?, ?, ?, ?)')
    .run(to, String(input.branch || '').trim(), fromName || '', message.slice(0, 4000), JSON.stringify(ids));
  for (const id of ids) pipeline.log(id, 'reminder', `Reminder sent to ${to}`, fromName || null);
  return get(info.lastInsertRowid);
}
function get(id) { const r = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id); return r && { ...r, lead_ids: JSON.parse(r.lead_ids || '[]') }; }

// Active reminders for the signed-in person. Each clears itself once every lead in it is opened, closed or gone.
function forUser(user, canSee = () => true) {
  if (!user || !user.name) return [];
  return db.prepare('SELECT * FROM reminders WHERE lower(to_name) = lower(?) AND dismissed_at IS NULL ORDER BY id DESC').all(user.name).map(r => {
    const leads = JSON.parse(r.lead_ids || '[]').map(id => pipeline.get(id))
      .filter(o => o && o.review_status !== 'pending' && canSee(o))
      .map(o => ({ id: o.id, business: o.business, priority: o.priority, status: o.status, deadline: o.deadline, done: !!o.touched_at || pipeline.CLOSED.includes(o.status) }));
    return { id: r.id, from_name: r.from_name, branch: r.branch, message: r.message, created_at: r.created_at, leads, remaining: leads.filter(l => !l.done).length };
  }).filter(r => r.remaining > 0);
}
function dismiss(id, user) {
  const r = get(id);
  if (!r) return null;
  if (!same(r.to_name, user.name) && !isOps(user)) throw err('That reminder is for someone else', 403);
  db.prepare("UPDATE reminders SET dismissed_at = datetime('now') WHERE id = ?").run(id);
  return get(id);
}

module.exports = { touch, untouched, create, forUser, dismiss, get };
