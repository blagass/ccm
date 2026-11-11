// Branch executive page: the high-level picture for one branch (e.g. Boise for John).
// A lead belongs to a branch when its Branch text names it anywhere, so shared rows like
// "Boise / Bend" show on both pages; "All branches" rows are counted separately as company-wide.
const { db, parse, getSettings } = require('./db');
const pipeline = require('./pipeline');
require('./tasks'); // ensures the tasks table exists

const CLOSED = ['Won', 'Lost', 'Not a fit'];
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

function resolveBranch(name) {
  const n = String(name || '').toLowerCase();
  const b = getSettings().branches.find(x => x.toLowerCase() === n);
  if (b) return b;
  const merges = getSettings().branch_merges || {};
  const from = Object.keys(merges).find(x => x.toLowerCase() === n);   // /branch/Portland → Springfield
  if (from) return merges[from];
  throw err(`Unknown branch: ${name}`, 404);
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const branchRe = b => new RegExp(`\\b(${pipeline.branchAliases(b).map(esc).join('|')})\\b`, 'i');
const inBranch = (o, b) => branchRe(b).test(o.branch || '');

function branchSummary(name, { week, today } = {}) {
  const branch = resolveBranch(name);
  week = week || pipeline.weeks()[0] || pipeline.mondayOf();
  today = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? today : new Date().toISOString().slice(0, 10);
  const owner = (getSettings().branch_owners || {})[branch] || '';

  const all = db.prepare('SELECT * FROM opportunities').all().map(parse);
  const mine = all.filter(o => inBranch(o, branch));
  const open = mine.filter(o => !CLOSED.includes(o.status));
  const nonChain = open.filter(o => o.list_type !== 'chain');
  const sum = (arr, k) => arr.reduce((a, o) => a + (o[k] || 0), 0);
  const companyWide = all.filter(o => /^all\b/i.test(o.branch || '') && !CLOSED.includes(o.status)).length;

  const tiles = {
    open: open.length,
    hot: open.filter(o => o.priority === 'Hot').length,
    new_this_week: mine.filter(o => o.first_seen_week === week).length,
    pipeline_low: sum(nonChain, 'deal_low'), pipeline_high: sum(nonChain, 'deal_high'),
    hot_unassigned: open.filter(o => o.priority === 'Hot' && !o.assigned_rep).length,
    still_new: open.filter(o => o.status === 'New').length,
    deadlines_14d: open.filter(o => o.deadline && o.deadline >= today && o.deadline <= addDays(today, 14)).length,
    won: mine.filter(o => o.status === 'Won').length,
    lost: mine.filter(o => o.status === 'Lost').length,
  };

  // Who's working what in this branch.
  const reps = {};
  for (const o of open) {
    const k = o.assigned_rep || '(unassigned)';
    reps[k] = reps[k] || { rep: k, open: 0, hot: 0, low: 0, high: 0, new: 0 };
    reps[k].open++; if (o.priority === 'Hot') reps[k].hot++; if (o.status === 'New') reps[k].new++;
    if (o.list_type !== 'chain') { reps[k].low += o.deal_low || 0; reps[k].high += o.deal_high || 0; }
  }
  const statusFunnel = pipeline.STATUSES.map(s => ({ status: s, n: mine.filter(o => o.status === s).length }));

  // This week's company focus list, narrowed to this branch.
  const report = pipeline.getReport(week);
  const focus = [];
  for (const f of pipeline.enrichFocus(report.focus)) {
    if (f.opp) { if (inBranch(f.opp, branch)) focus.push(f); }
    else if (f.opps && f.opps.length) {
      const here = f.opps.filter(x => inBranch(x, branch));
      if (here.length) focus.push({ ...f, opps: here });
    } else if (branchRe(branch).test(f.branch || '') || /^all\b/i.test(f.branch || '')) focus.push(f);
  }
  // Suggested when the company list has nothing for this branch: Hot open leads by deadline, then size.
  const suggested = focus.length ? [] : pipeline.enrichFocus(open.filter(o => o.priority === 'Hot')
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || (b.deal_high || 0) - (a.deal_high || 0)).slice(0, 5)
    .map(o => ({ opportunity_id: o.id, action: o.next_step || 'Make first contact', why: o.stage })));

  // Coming up in the next three weeks: hard deadlines, tasks on this branch's leads or for the owner, scan days.
  const ids = new Set(mine.map(o => o.id));
  const until = addDays(today, 21);
  const upcoming = [];
  for (const o of open) if (o.deadline && o.deadline >= today && o.deadline <= until) upcoming.push({ date: o.deadline, kind: 'deadline', title: `${o.business}: ${o.stage || 'deadline'}`, opportunity_id: o.id, priority: o.priority, assigned_rep: o.assigned_rep });
  const taskRows = db.prepare(`SELECT t.*, o.business FROM tasks t LEFT JOIN opportunities o ON o.id = t.opportunity_id
    WHERE t.done = 0 AND t.due_date <= ? ORDER BY t.due_date`).all(until)
    .filter(t => (t.opportunity_id && ids.has(t.opportunity_id)) || (owner && t.assigned_to === owner));
  const overdue = taskRows.filter(t => t.due_date < today);
  for (const t of taskRows.filter(t => t.due_date >= today)) upcoming.push({ date: t.due_date, kind: 'task', title: t.title, opportunity_id: t.opportunity_id, business: t.business, assigned_to: t.assigned_to, task_id: t.id });
  for (let d = today; d <= until; d = addDays(d, 1)) if (new Date(d + 'T00:00:00Z').getUTCDay() === 1) upcoming.push({ date: d, kind: 'scan', title: 'Weekly lead scan arrives (5:39am)' });
  upcoming.sort((a, b) => a.date.localeCompare(b.date) || ({ deadline: 0, task: 1, scan: 2 }[a.kind] - { deadline: 0, task: 1, scan: 2 }[b.kind]));

  const activity = mine.length ? db.prepare(`SELECT a.*, o.business FROM opp_activities a JOIN opportunities o ON o.id = a.opportunity_id
    WHERE a.opportunity_id IN (${[...ids].join(',')}) ORDER BY a.id DESC LIMIT 20`).all() : [];

  return {
    branch, owner, includes: pipeline.branchAliases(branch).slice(1), week, weeks: pipeline.weeks(), today, tiles, company_wide_open: companyWide,
    reps: Object.values(reps).sort((a, b) => (a.rep === '(unassigned)') - (b.rep === '(unassigned)') || b.hot - a.hot || b.open - a.open),
    status_funnel: statusFunnel, focus, suggested_focus: suggested, upcoming, overdue, activity,
    leads: mine.sort((a, b) => ['Hot', 'Warm', 'Watch'].indexOf(a.priority) - ['Hot', 'Warm', 'Watch'].indexOf(b.priority) || (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.id - b.id),
  };
}

// Which branches a person owns (for "My branch" links).
function branchesOwnedBy(name, managerOf) {
  const owners = getSettings().branch_owners || {};
  const out = Object.entries(owners).filter(([, n]) => n && name && n.toLowerCase() === String(name).toLowerCase()).map(([b]) => b)
    .filter(b => (getSettings().branches || []).includes(b));
  if (managerOf && !out.includes(managerOf)) out.unshift(managerOf);
  else if (managerOf) { out.splice(out.indexOf(managerOf), 1); out.unshift(managerOf); }
  return out;
}

module.exports = { branchSummary, branchesOwnedBy, resolveBranch };
