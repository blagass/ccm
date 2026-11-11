// Daily welcome briefing: a short, upbeat note with up to three quick wins for the signed-in person.
// Rule-based on purpose, so every number and name it mentions comes straight from the data.
const { db } = require('./db');
const pipeline = require('./pipeline');
require('./tasks'); // ensures the tasks table exists

const CLOSED = "('Won','Lost','Not a fit')";
const dayName = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const shortDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const shortName = b => String(b || '').split(/\s[–(]/)[0];
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// "brandon lagasse" → "Brandon"; "V. Reeves" → "V."; generic owner/automation names → no name.
function firstName(name) {
  const n = String(name || '').trim();
  if (!n || /^(owner|automated scan)$/i.test(n)) return null;
  const w = n.split(/\s+/)[0];
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// Branch managers get their branch's picture (e.g. Kevin → Medford).
function managerBriefing(user, { today, hour }) {
  const { branchSummary } = require('./branch');
  const b = branchSummary(user.branch, { today });
  const first = firstName(user.name);
  const seed = [...String(today)].reduce((a, c) => a + c.charCodeAt(0), 0) + (user.id || 0);
  const t = b.tiles, br = b.branch;
  const mineOverdue = db.prepare("SELECT * FROM tasks WHERE done = 0 AND due_date < ? AND assigned_to = ? ORDER BY due_date").all(today, user.name);
  const teamOverdue = b.overdue.filter(x => x.assigned_to !== user.name).length;
  const hotNew = b.leads.filter(o => o.priority === 'Hot' && o.status === 'New');
  const soon = b.upcoming.filter(u => u.kind === 'deadline' && u.date <= addDays(today, 7));
  const page = `#/branch/${encodeURIComponent(br)}`;

  const wins = [];
  const used = new Set();
  const add = w => { if (wins.length < 3 && !(w.opportunity_id && used.has(w.opportunity_id))) { wins.push(w); if (w.opportunity_id) used.add(w.opportunity_id); } };
  if (mineOverdue.length) add({ icon: '✔', text: mineOverdue.length === 1 ? `Clear one carried-over task: “${mineOverdue[0].title}”` : `Clear ${mineOverdue.length} carried-over tasks, starting with “${mineOverdue[0].title}”`, href: `#/calendar?d=${today}`, opportunity_id: mineOverdue.length === 1 ? mineOverdue[0].opportunity_id : null });
  if (t.hot_unassigned) add({ icon: '👥', text: `Hand out ${plural(t.hot_unassigned, `Hot ${br} lead`)} that ${t.hot_unassigned === 1 ? "doesn't" : "don't"} have a rep yet.`, href: `#/pipeline?branch=${encodeURIComponent(br)}&priority=Hot&rep=__none&open=true` });
  if (soon[0]) {
    const o = soon[0], days = Math.round((new Date(o.date) - new Date(today)) / 864e5);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${dayName(o.date)}`;
    add({ icon: '⏰', text: `${shortName(o.title.split(':')[0])} has a deadline ${when} (${shortDate(o.date)}). ${o.assigned_rep && o.assigned_rep !== user.name ? `${o.assigned_rep.split(' ')[0]} has it, so a quick check-in helps.` : 'It’s on your plate.'}`, href: `#/pipeline/${o.opportunity_id}`, opportunity_id: o.opportunity_id });
  }
  if (t.new_this_week) add({ icon: '📬', text: `This week's scan brought ${plural(t.new_this_week, `new ${br} lead`)}. A quick look keeps your team on the best ones.`, href: `${page}?tab=new` });
  if (hotNew.length) add({ icon: '🔥', text: `${plural(hotNew.length, `Hot ${br} lead`)} ${hotNew.length === 1 ? 'is' : 'are'} still at “New”${hotNew.length === 1 ? `: ${shortName(hotNew[0].business)}` : ''}. A first hello gets ${hotNew.length === 1 ? 'it' : 'them'} moving.`, href: hotNew.length === 1 ? `#/pipeline/${hotNew[0].id}` : `#/pipeline?branch=${encodeURIComponent(br)}&priority=Hot&status=New&open=true`, opportunity_id: hotNew.length === 1 ? hotNew[0].id : null });
  if (teamOverdue) add({ icon: '🗓', text: `Your ${br} team has ${plural(teamOverdue, 'carried-over task')}. Worth a quick look.`, href: page });
  const top = (b.focus[0] || b.suggested_focus[0]);
  if (top) {
    // A shared item ("Fitti's, Quack Shack, Jay's on 4th: walk in") names only this branch's leads.
    const label = top.opps && top.opps.length
      ? `${top.opps.map(o => shortName(o.business)).join(', ')}: ${(top.action.includes(':') ? top.action.slice(top.action.indexOf(':') + 1) : top.action).trim()}`
      : (top.label || top.action);
    const id = top.opportunity_id || (top.opps && top.opps.length === 1 ? top.opps[0].id : null);
    add({ icon: '★', text: `${br}'s #1 focus: ${label}`, href: id ? `#/pipeline/${id}` : page, opportunity_id: id });
  }
  if (!wins.length) add({ icon: '☕', text: `${br} is all caught up. A great moment to check in with a customer you haven't talked to lately.`, href: page });

  const busy = t.hot >= 5 || t.new_this_week >= 10 || mineOverdue.length + teamOverdue >= 4;
  const greeting = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${first ? ', ' + first : ''}!`;
  const snapshot = `${br} has ${plural(t.open, 'open lead')}${t.hot ? `, ${t.hot} Hot` : ''}${t.new_this_week ? `, and ${t.new_this_week} new this week` : ''}.`;
  const intro = `${snapshot} ${busy
    ? pick(["It's a busy stretch, so let's start with the moves that keep your team rolling.", 'Plenty going on. Here are a few quick wins to point everyone in the right direction.'], seed)
    : pick(["A steady week. Here's where a little steering goes a long way.", 'A good, manageable week for the branch. These are the best places to start.'], seed)}`;
  const month = Number(today.slice(5, 7));
  const tip = month >= 10
    ? `Tip: ask your team to mention the year-end equipment tax deadline (in service by Dec 31) on every open ${br} quote.`
    : pick(['Tip: a two-minute Monday huddle on the Hot list keeps everyone on the same page.', 'Tip: a quick note after each call keeps the whole branch in the loop.'], seed);
  const closing = pick([`Thanks for leading the ${br} team.`, `${br} is in good hands. Have a great day!`], seed);
  return {
    greeting, intro, wins, tip, closing, role: 'manager', branch: br,
    stats: { open: t.open, hot: t.hot, new_this_week: t.new_this_week, hot_unassigned: t.hot_unassigned, overdue: mineOverdue.length, team_overdue: teamOverdue, deadlines_7d: soon.length },
  };
}

function briefing(user, { today, hour }) {
  if (user.role === 'manager' && user.branch) return managerBriefing(user, { today, hour });
  const first = firstName(user.name);
  const me = first ? user.name : null;              // whose tasks/leads are "mine"
  const isAdmin = user.role === 'admin';
  const seed = [...String(today)].reduce((a, c) => a + c.charCodeAt(0), 0) + (user.id || 0);

  const mineSql = me ? "AND (assigned_to = ? OR assigned_to = '')" : '';
  const mineArgs = me ? [me] : [];
  const taskSql = `SELECT t.*, o.business FROM tasks t LEFT JOIN opportunities o ON o.id = t.opportunity_id WHERE done = 0`;
  const overdue = db.prepare(`${taskSql} AND due_date < ? ${mineSql} ORDER BY due_date`).all(today, ...mineArgs);
  const todayTasks = db.prepare(`${taskSql} AND due_date = ? ${mineSql} ORDER BY id`).all(today, ...mineArgs);
  const repSql = me && !isAdmin ? "AND (assigned_rep = ? OR assigned_rep = '' OR assigned_rep IS NULL)" : '';
  const soon = db.prepare(`SELECT * FROM opportunities WHERE status NOT IN ${CLOSED} AND deadline BETWEEN ? AND ? ${repSql} ORDER BY deadline`)
    .all(today, addDays(today, 7), ...(repSql ? mineArgs : []));
  const myHotNew = me ? db.prepare(`SELECT * FROM opportunities WHERE status = 'New' AND priority = 'Hot' AND assigned_rep = ? ORDER BY deadline IS NULL, deadline, deal_high DESC`).all(me) : [];
  const week = pipeline.weeks()[0];
  const sum = week ? pipeline.summary(week) : null;
  const hot = sum?.tiles.hot_leads || 0, newLeads = sum?.tiles.new_leads || 0;

  // Team-level numbers for admins (marketing / SDR lead): what needs routing and who might need a nudge.
  const unassignedHot = isAdmin ? db.prepare(`SELECT COUNT(*) n FROM opportunities WHERE priority = 'Hot' AND status NOT IN ${CLOSED} AND (assigned_rep IS NULL OR assigned_rep = '')`).get().n : 0;
  const teamOverdue = isAdmin ? db.prepare(`SELECT COUNT(*) n FROM tasks WHERE done = 0 AND due_date < ? ${me ? 'AND assigned_to != ?' : ''}`).get(today, ...mineArgs).n : 0;
  const hotStillNew = isAdmin ? db.prepare(`SELECT COUNT(*) n FROM opportunities WHERE priority = 'Hot' AND status = 'New' AND assigned_rep != '' AND assigned_rep IS NOT NULL`).get().n : 0;
  const weekIsFresh = week && (new Date(today) - new Date(week)) / 864e5 < 7;

  const wins = [];
  const used = new Set();
  const add = w => { if (wins.length < 3 && !(w.opportunity_id && used.has(w.opportunity_id))) { wins.push(w); if (w.opportunity_id) used.add(w.opportunity_id); } };
  const deadlineWin = o => {
    const days = Math.round((new Date(o.deadline) - new Date(today)) / 864e5);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${dayName(o.deadline)}`;
    const who = isAdmin ? (o.assigned_rep ? ` ${o.assigned_rep.split(' ')[0]} has it.` : ' It still needs an owner.') : '';
    add({ icon: '⏰', text: `${shortName(o.business)} has a deadline ${when} (${shortDate(o.deadline)}).${who} ${o.next_step ? o.next_step.replace(/\.$/, '') + '.' : 'A quick check-in keeps it moving.'}`, href: `#/pipeline/${o.id}`, opportunity_id: o.id });
  };
  const overdueWin = () => overdue.length && add({ icon: '✔', text: overdue.length === 1 ? `Clear one carried-over task: “${overdue[0].title}”` : `Clear ${overdue.length} carried-over tasks, starting with “${overdue[0].title}”`, href: `#/calendar?d=${today}`, opportunity_id: overdue.length === 1 ? overdue[0].opportunity_id : null });
  const topFocus = sum?.report.focus?.[0] || sum?.suggested_focus?.[0];

  if (isAdmin) {
    overdueWin();
    if (unassignedHot) add({ icon: '👥', text: `Route ${plural(unassignedHot, 'Hot lead')} that ${unassignedHot === 1 ? "doesn't" : "don't"} have an owner yet, so reps can get moving.`, href: '#/pipeline?priority=Hot&rep=__none&open=true' });
    if (soon[0]) deadlineWin(soon[0]);
    if (weekIsFresh && newLeads) add({ icon: '📬', text: `This week's scan brought ${plural(newLeads, 'new lead')}${hot ? ` (${hot} Hot)` : ''}. A quick review keeps the focus list sharp.`, href: `#/?week=${week}` });
    if (hotStillNew) add({ icon: '🔥', text: `${plural(hotStillNew, 'Hot lead')} assigned to reps ${hotStillNew === 1 ? 'is' : 'are'} still at “New”. A friendly nudge could help.`, href: '#/pipeline?priority=Hot&status=New&open=true' });
    if (teamOverdue) add({ icon: '🗓', text: `The team has ${plural(teamOverdue, 'carried-over task')}. Worth a quick look on the calendar.`, href: `#/calendar?d=${today}&mine=0` });
    if (topFocus) add({ icon: '★', text: `This week's #1 focus: ${topFocus.label || topFocus.action}`, href: topFocus.opportunity_id ? `#/pipeline/${topFocus.opportunity_id}` : '#/', opportunity_id: topFocus.opportunity_id });
  } else {
    overdueWin();
    if (soon[0]) deadlineWin(soon[0]);
    if (soon[1]) deadlineWin(soon[1]);
    if (todayTasks.length) add({ icon: '☐', text: todayTasks.length === 1 ? `One task on today's list: “${todayTasks[0].title}”` : `${todayTasks.length} tasks on today's list, starting with “${todayTasks[0].title}”`, href: `#/calendar?d=${today}`, opportunity_id: todayTasks.length === 1 ? todayTasks[0].opportunity_id : null });
    for (const o of myHotNew.slice(0, 2)) add({ icon: '🔥', text: `Make a first hello to ${shortName(o.business)}. It's Hot and still at “New”.`, href: `#/pipeline/${o.id}`, opportunity_id: o.id });
    if (topFocus) add({ icon: '★', text: `This week's #1 focus: ${topFocus.label || topFocus.action}`, href: topFocus.opportunity_id ? `#/pipeline/${topFocus.opportunity_id}` : '#/', opportunity_id: topFocus.opportunity_id });
  }
  if (!wins.length) add({ icon: '☕', text: isAdmin ? 'Everything is routed and on track. A great moment to plan next week’s campaign.' : 'Your list is clear. Browse the pipeline and pick a lead to warm up.', href: isAdmin ? '#/' : '#/pipeline' });

  const load = overdue.length + todayTasks.length + soon.length + myHotNew.length + (unassignedHot ? 2 : 0) + (teamOverdue ? 1 : 0);
  const busy = load >= 6 || hot >= 6;
  const greeting = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${first ? ', ' + first : ''}!`;
  const intro = isAdmin
    ? (busy
      ? pick([`It's a busy stretch for the industry${newLeads ? `, with ${plural(newLeads, 'new lead')} this week` : ''}. You're steering the team, so let's start with the moves that unblock everyone else.`,
              `Lots happening out there${hot ? `, including ${plural(hot, 'Hot lead')}` : ''}. Here's the team picture, boiled down to a few quick wins.`], seed)
      : pick([`The team is in good shape this week. Here's where a little steering goes a long way.`, `A steady week for the team. These are the best places to point everyone.`], seed))
    : busy
      ? pick([`It's a busy stretch for the industry${newLeads ? `, with ${plural(newLeads, 'new lead')} this week` : ''}. No need to tackle it all at once. Let's start with a few quick wins.`,
              `There's a lot happening out there${hot ? `, including ${plural(hot, 'Hot lead')}` : ''}. Let's keep it simple and knock out a few quick wins first.`], seed)
      : load >= 2
        ? pick([`You've got a steady week ahead. Here's where a little effort goes a long way.`, `A good, manageable week. These are the best places to start.`], seed)
        : pick([`It's a lighter week, which makes it a great time to get ahead.`, `Things are calm today. Here are a couple of easy ways to build momentum.`], seed);
  const month = Number(today.slice(5, 7));
  const tip = isAdmin && month >= 10
    ? 'Tip: a short year-end email (equipment in service by Dec 31 for the tax deduction) is an easy campaign to send to every open quote.'
    : month >= 10
      ? 'Tip: the year-end equipment tax deadline (in service by Dec 31) is a friendly reason to follow up on any open quote.'
      : pick(['Tip: a two-line check-in email often beats a perfect one sent next week.', 'Tip: logging a quick note after each call keeps the whole team in the loop.'], seed);
  const closing = isAdmin
    ? pick(['Thanks for keeping everyone pointed in the right direction.', "The team's lucky to have you steering. Have a great day!"], seed)
    : pick(["Small steps add up. You've got this.", 'One win at a time. Have a great day!', "Thanks for everything you do. Let's make it a good one."], seed);

  return {
    greeting, intro, wins, tip, closing, role: isAdmin ? 'admin' : 'rep',
    stats: { overdue: overdue.length, today: todayTasks.length, deadlines: soon.length, hot_new: myHotNew.length, unassigned_hot: unassignedHot, team_overdue: teamOverdue, week, new_leads: newLeads, hot_leads: hot },
  };
}

module.exports = { briefing };
