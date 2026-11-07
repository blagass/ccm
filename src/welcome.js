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

function briefing(user, { today, hour }) {
  const isOwner = user.id === 0;
  const me = isOwner ? null : user.name;
  const first = me ? me.split(' ')[0] : null;
  const isAdmin = user.role === 'admin';
  const seed = [...String(today)].reduce((a, c) => a + c.charCodeAt(0), 0) + (user.id || 0);

  const mineSql = me ? "AND (assigned_to = ? OR assigned_to = '')" : '';
  const mineArgs = me ? [me] : [];
  const overdue = db.prepare(`SELECT t.*, o.business FROM tasks t LEFT JOIN opportunities o ON o.id = t.opportunity_id WHERE done = 0 AND due_date < ? ${mineSql} ORDER BY due_date`).all(today, ...mineArgs);
  const todayTasks = db.prepare(`SELECT t.*, o.business FROM tasks t LEFT JOIN opportunities o ON o.id = t.opportunity_id WHERE done = 0 AND due_date = ? ${mineSql} ORDER BY id`).all(today, ...mineArgs);
  const repSql = me ? "AND (assigned_rep = ? OR assigned_rep = '' OR assigned_rep IS NULL)" : '';
  const soon = db.prepare(`SELECT * FROM opportunities WHERE status NOT IN ${CLOSED} AND deadline BETWEEN ? AND ? ${repSql} ORDER BY deadline`).all(today, addDays(today, 7), ...mineArgs);
  const myHotNew = me ? db.prepare(`SELECT * FROM opportunities WHERE status = 'New' AND priority = 'Hot' AND assigned_rep = ? ORDER BY deadline IS NULL, deadline, deal_high DESC`).all(me) : [];
  const unassignedHot = isAdmin ? db.prepare(`SELECT COUNT(*) n FROM opportunities WHERE priority = 'Hot' AND status NOT IN ${CLOSED} AND (assigned_rep IS NULL OR assigned_rep = '')`).get().n : 0;
  const week = pipeline.weeks()[0];
  const sum = week ? pipeline.summary(week) : null;

  // Quick wins: small, concrete, most time-sensitive first. At most one per lead.
  const wins = [];
  const used = new Set();
  const add = w => { if (wins.length < 3 && !(w.opportunity_id && used.has(w.opportunity_id))) { wins.push(w); if (w.opportunity_id) used.add(w.opportunity_id); } };
  if (overdue.length) add({ icon: '✔', text: overdue.length === 1 ? `Clear one carried-over task: “${overdue[0].title}”` : `Clear ${overdue.length} carried-over tasks, starting with “${overdue[0].title}”`, href: `#/calendar?d=${today}`, opportunity_id: overdue.length === 1 ? overdue[0].opportunity_id : null });
  const deadlineWin = o => {
    const days = Math.round((new Date(o.deadline) - new Date(today)) / 864e5);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${dayName(o.deadline)}`;
    add({ icon: '⏰', text: `${shortName(o.business)} has a deadline ${when} (${shortDate(o.deadline)}). ${o.next_step ? o.next_step.replace(/\.$/, '') + '.' : 'A quick check-in keeps it moving.'}`, href: `#/pipeline/${o.id}`, opportunity_id: o.id });
  };
  if (soon[0]) deadlineWin(soon[0]);
  // Admins: getting Hot leads into someone's hands unblocks everyone else.
  if (unassignedHot) add({ icon: '👥', text: `Hand out ${plural(unassignedHot, 'Hot lead')} nobody has picked up yet. It only takes a minute.`, href: '#/pipeline?priority=Hot&rep=__none&open=true' });
  if (soon[1]) deadlineWin(soon[1]);
  if (todayTasks.length) add({ icon: '☐', text: todayTasks.length === 1 ? `One task on today's list: “${todayTasks[0].title}”` : `${todayTasks.length} tasks on today's list, starting with “${todayTasks[0].title}”`, href: `#/calendar?d=${today}`, opportunity_id: todayTasks.length === 1 ? todayTasks[0].opportunity_id : null });
  for (const o of myHotNew.slice(0, 2)) add({ icon: '🔥', text: `Make a first hello to ${shortName(o.business)}. It's Hot and still at “New”.`, href: `#/pipeline/${o.id}`, opportunity_id: o.id });
  const topFocus = sum?.report.focus?.[0] || sum?.suggested_focus?.[0];
  if (topFocus) add({ icon: '★', text: `This week's #1 focus: ${topFocus.label || topFocus.action}`, href: topFocus.opportunity_id ? `#/pipeline/${topFocus.opportunity_id}` : '#/', opportunity_id: topFocus.opportunity_id });
  if (!wins.length) add({ icon: '☕', text: 'Your list is clear. Browse the pipeline and pick a lead to warm up.', href: '#/pipeline' });

  // Tone: how much is going on, said calmly.
  const load = overdue.length + todayTasks.length + soon.length + myHotNew.length + (unassignedHot ? 1 : 0);
  const hot = sum?.tiles.hot_leads || 0, newLeads = sum?.tiles.new_leads || 0;
  const busy = load >= 6 || hot >= 6;
  const greeting = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${first ? ', ' + first : ''}!`;
  const intro = busy
    ? pick([`It's a busy stretch for the industry${newLeads ? `, with ${plural(newLeads, 'new lead')} this week` : ''}. No need to tackle it all at once. Let's start with a few quick wins.`,
            `There's a lot happening out there${hot ? `, including ${plural(hot, 'Hot lead')}` : ''}. Let's keep it simple and knock out a few quick wins first.`], seed)
    : load >= 2
      ? pick([`You've got a steady week ahead. Here's where a little effort goes a long way.`, `A good, manageable week. These are the best places to start.`], seed)
      : pick([`It's a lighter week, which makes it a great time to get ahead.`, `Things are calm today. Here are a couple of easy ways to build momentum.`], seed);
  const month = Number(today.slice(5, 7));
  const tip = month >= 10
    ? 'Tip: the year-end equipment tax deadline (in service by Dec 31) is a friendly reason to follow up on any open quote.'
    : pick(['Tip: a two-line check-in email often beats a perfect one sent next week.', 'Tip: logging a quick note after each call keeps the whole team in the loop.'], seed);
  const closing = pick(["Small steps add up. You've got this.", 'One win at a time. Have a great day!', "Thanks for everything you do. Let's make it a good one."], seed);

  return {
    greeting, intro, wins, tip, closing,
    stats: { overdue: overdue.length, today: todayTasks.length, deadlines: soon.length, hot_new: myHotNew.length, unassigned_hot: unassignedHot, week, new_leads: newLeads, hot_leads: hot },
  };
}

module.exports = { briefing };
