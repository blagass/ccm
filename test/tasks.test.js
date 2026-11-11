// Calendar & tasks: CRUD, overdue roll-forward, "mine" filter, pipeline deadlines and focus dates.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'owner-pass-123';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const tasks = require('../src/tasks');

let base, server, cookie;
async function req(method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await req('POST', '/api/login', { password: 'owner-pass-123' });
});
test.after(() => server.close());

test('focus-list deadline text becomes a date', () => {
  assert.equal(tasks.looseDate('Price to GCs by Nov 12 (bid Nov 17)', '2026-11-02'), '2026-11-12');
  assert.equal(tasks.looseDate('Dec 31', '2026-11-02'), '2026-12-31');
  assert.equal(tasks.looseDate('Jan 5', '2026-11-30'), '2027-01-05', 'rolls into next year');
  assert.equal(tasks.looseDate('Order window closes in ~2–3 weeks', '2026-11-02'), null);
});

let leadId;
test('tasks: create, validate, complete, move, delete; linked to a lead', async () => {
  leadId = (await req('POST', '/api/opportunities', { business: 'Corbett School District', priority: 'Hot', stage: 'Open bid – closes Nov 17, 2026', deadline: '2026-11-17', assigned_rep: 'Owner' })).body.id;
  assert.equal((await req('POST', '/api/tasks', { title: 'x', due_date: 'tomorrow' })).status, 400);
  assert.equal((await req('POST', '/api/tasks', { title: '  ', due_date: '2026-11-10' })).status, 400);
  assert.equal((await req('POST', '/api/tasks', { title: 'x', due_date: '2026-11-10', opportunity_id: 9999 })).status, 404, 'unknown lead');
  const t = await req('POST', '/api/tasks', { title: 'Send pricing to GCs', due_date: '2026-11-12', assigned_to: 'Owner', opportunity_id: leadId });
  assert.equal(t.status, 201);
  assert.equal(t.body.opportunity, 'Corbett School District');
  assert.equal(t.body.created_by, 'Owner');
  const done = await req('PATCH', `/api/tasks/${t.body.id}`, { done: true });
  assert.equal(done.body.done, 1);
  assert.equal(done.body.done_by, 'Owner');
  const lead = (await req('GET', `/api/opportunities/${leadId}`)).body;
  assert.ok(lead.activity.some(a => a.summary === 'Task for 2026-11-12: Send pricing to GCs'));
  assert.ok(lead.activity.some(a => a.summary === 'Done: Send pricing to GCs'));
  assert.equal((await req('GET', `/api/opportunities/${leadId}/tasks`)).body.length, 1);
  const moved = await req('PATCH', `/api/tasks/${t.body.id}`, { due_date: '2026-11-13', done: false });
  assert.deepEqual([moved.body.due_date, moved.body.done, moved.body.done_by], ['2026-11-13', 0, null]);
  await req('DELETE', `/api/tasks/${t.body.id}`);
  assert.equal((await req('GET', `/api/opportunities/${leadId}/tasks`)).body.length, 0);
});

test('calendar combines tasks, deadlines, focus actions and Monday scans; overdue rolls to today', async () => {
  await req('POST', '/api/tasks', { title: 'Call Derek', due_date: '2026-11-05', assigned_to: 'Owner' });     // overdue
  await req('POST', '/api/tasks', { title: 'Visit Darling', due_date: '2026-11-09', assigned_to: 'Dana' });  // someone else's
  await req('POST', '/api/tasks', { title: 'Team task', due_date: '2026-11-09' });                            // anyone
  await req('PUT', '/api/pipeline/reports/2026-11-02', { focus: [{ action: 'Corbett bid: price to GCs', branch: 'Portland', deadline: 'Price to GCs by Nov 12 (bid Nov 17)' }] });

  const all = (await req('GET', '/api/calendar?from=2026-11-01&to=2026-11-30&today=2026-11-07')).body;
  assert.equal(all.tasks.length, 3);
  assert.deepEqual(all.overdue.map(t => t.title), ['Call Derek']);
  const ev = k => all.events.filter(e => e.kind === k);
  assert.deepEqual(ev('deadline').map(e => [e.date, e.priority, e.opportunity_id]), [['2026-11-17', 'Hot', leadId]]);
  assert.deepEqual(ev('focus').map(e => e.date), ['2026-11-12']);
  assert.deepEqual(ev('scan').map(e => e.date), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);

  const mine = (await req('GET', '/api/calendar?from=2026-11-01&to=2026-11-30&today=2026-11-07&mine=1')).body;
  assert.deepEqual(mine.tasks.map(t => t.title).sort(), ['Call Derek', 'Team task'], "mine = my tasks + unassigned, not Dana's");

  // Closed leads drop off the calendar.
  await req('PATCH', `/api/opportunities/${leadId}`, { status: 'Won' });
  const after = (await req('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).body;
  assert.equal(after.events.filter(e => e.kind === 'deadline').length, 0);
  assert.equal(after.overdue.length, 0, 'no overdue list without a today param');
  assert.equal((await req('GET', '/api/calendar?from=2026-11-30&to=2026-11-01')).status, 400);
});
