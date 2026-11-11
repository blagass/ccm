// Calendar: people's tasks plus dated items pulled from the pipeline
// (hard deadlines, dates in the weekly focus list, and the Monday lead scan).
const { db, parse } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due_date TEXT NOT NULL,                    -- YYYY-MM-DD
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  assigned_to TEXT DEFAULT '',               -- a team member's name ('' = anyone)
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  done INTEGER DEFAULT 0,
  done_at TEXT,
  done_by TEXT,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
`);

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z'));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const SELECT = `SELECT t.*, o.business AS opportunity, o.priority AS opportunity_priority
  FROM tasks t LEFT JOIN opportunities o ON o.id = t.opportunity_id`;
function get(id) { return db.prepare(`${SELECT} WHERE t.id = ?`).get(id); }

function clean(input, partial) {
  const out = {};
  if (input.due_date !== undefined || !partial) { if (!isDate(input.due_date)) throw err('Pick a date'); out.due_date = input.due_date; }
  if (input.title !== undefined || !partial) { const t = String(input.title || '').trim(); if (!t) throw err('Enter what needs to be done'); out.title = t.slice(0, 300); }
  if (input.notes !== undefined) out.notes = String(input.notes || '').slice(0, 5000);
  if (input.assigned_to !== undefined) out.assigned_to = String(input.assigned_to || '').trim();
  if (input.opportunity_id !== undefined) {
    const id = input.opportunity_id === '' || input.opportunity_id === null ? null : Number(input.opportunity_id);
    if (id !== null && !db.prepare('SELECT 1 FROM opportunities WHERE id = ?').get(id)) throw err('That lead no longer exists');
    out.opportunity_id = id;
  }
  return out;
}

function create(input, by = '') {
  const t = clean(input, false);
  const cols = Object.keys(t);
  const info = db.prepare(`INSERT INTO tasks (${cols.join(', ')}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(...cols.map(c => t[c]), by);
  if (t.opportunity_id) logOnLead(t.opportunity_id, `Task for ${t.due_date}: ${t.title}`, by);
  return get(info.lastInsertRowid);
}

function update(id, input, by = '') {
  const cur = get(id);
  if (!cur) return null;
  const t = clean(input, true);
  if (input.done !== undefined) {
    t.done = input.done ? 1 : 0;
    t.done_at = input.done ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null;
    t.done_by = input.done ? by : null;
    if (input.done && !cur.done && cur.opportunity_id) logOnLead(cur.opportunity_id, `Done: ${cur.title}`, by);
  }
  const cols = Object.keys(t);
  if (cols.length) db.prepare(`UPDATE tasks SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => t[c]), id);
  return get(id);
}
function remove(id) { db.prepare('DELETE FROM tasks WHERE id = ?').run(id); }

function logOnLead(oppId, summary, by) {
  db.prepare('INSERT INTO opp_activities (opportunity_id, type, summary, user_name) VALUES (?, ?, ?, ?)').run(oppId, 'task', summary, by || null);
}

function forLead(oppId) { return db.prepare(`${SELECT} WHERE t.opportunity_id = ? ORDER BY t.done, t.due_date`).all(oppId); }

// "Price to GCs by Nov 12 (bid Nov 17)" → 2026-11-12 (first month/day mentioned; year from the report week,
// rolling into next year when the month is earlier than the week's month).
function looseDate(text, weekOf) {
  const m = String(text || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  if (!m) { if (/\bdec(ember)?\s*31\b/i.test(text || '')) return `${weekOf.slice(0, 4)}-12-31`; return null; }
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  let year = Number(m[3] || weekOf.slice(0, 4));
  if (!m[3] && month < Number(weekOf.slice(5, 7)) - 1) year++;
  const d = `${year}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isDate(d) ? d : null;
}

function mondaysBetween(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  for (; d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 7)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// Everything on the calendar between two dates (inclusive). `mine` filters tasks to one person
// (plus unassigned ones); pipeline items are filtered to leads assigned to them or to nobody.
function calendar({ from, to, mine, today, branch }) {
  if (!isDate(from) || !isDate(to) || from > to) throw err('from/to must be dates');
  const taskRows = db.prepare(`${SELECT} WHERE t.due_date BETWEEN ? AND ? ${mine ? "AND (t.assigned_to = ? OR t.assigned_to = '')" : ''} ORDER BY t.done, t.due_date, t.id`)
    .all(...(mine ? [from, to, mine] : [from, to]));
  // Unfinished tasks from earlier days roll forward onto today so nothing gets lost.
  const overdue = today && today >= from && today <= to
    ? db.prepare(`${SELECT} WHERE t.done = 0 AND t.due_date < ? ${mine ? "AND (t.assigned_to = ? OR t.assigned_to = '')" : ''} ORDER BY t.due_date`).all(...(mine ? [today, mine] : [today]))
    : [];

  const events = [];
  const repFilter = mine ? "AND (assigned_rep = ? OR assigned_rep = '' OR assigned_rep IS NULL)" : '';
  for (const o of db.prepare(`SELECT id, business, priority, branch, stage, assigned_rep, status, deadline FROM opportunities
      WHERE deadline BETWEEN ? AND ? AND status NOT IN ${require('./pipeline').CLOSED_SQL} ${repFilter}`).all(...(mine ? [from, to, mine] : [from, to]))) {
    if (branch && !require('./branch').inBranch(o, branch)) continue;
    events.push({ date: o.deadline, kind: 'deadline', title: `${o.business}: ${o.stage || 'deadline'}`, priority: o.priority, opportunity_id: o.id, assigned_rep: o.assigned_rep, branch: o.branch });
  }
  // Dated actions from each week's executive focus list.
  const pipeline = require('./pipeline');
  for (const r of db.prepare('SELECT week_of, focus FROM weekly_reports').all().map(parse)) {
    for (const f of pipeline.enrichFocus(r.focus)) {
      const d = looseDate(f.deadline, r.week_of) || (f.opp && f.opp.deadline) || null;
      if (d && d >= from && d <= to) events.push({ date: d, kind: 'focus', title: f.label || f.action, branch: f.branch, detail: f.deadline, week_of: r.week_of, opportunity_id: f.opportunity_id });
    }
  }
  if (branch) {
    // Branch managers only see their branch: tasks on other branches' leads and their focus items drop out.
    const { inBranch } = require('./branch');
    const pipeline = require('./pipeline');
    const ok = t => !t.opportunity_id || (o => o && inBranch(o, branch))(pipeline.get(t.opportunity_id));
    for (const list of [taskRows, overdue]) for (let i = list.length - 1; i >= 0; i--) if (!ok(list[i])) list.splice(i, 1);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'focus' && e.opportunity_id && !ok({ opportunity_id: e.opportunity_id })) events.splice(i, 1);
    }
  }
  for (const m of mondaysBetween(from, to)) events.push({ date: m, kind: 'scan', title: 'Weekly lead scan arrives (5:39am)', week_of: m });
  return { from, to, tasks: taskRows, overdue, events };
}

module.exports = { get, create, update, remove, forLead, calendar, looseDate };
