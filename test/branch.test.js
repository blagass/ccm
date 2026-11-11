// Branch executive pages.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'owner-pass-123';
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let base, server, cookie;
async function req(method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
test.before(async () => {
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await req('POST', '/api/login', { password: 'owner-pass-123' });
  await req('PUT', '/api/settings', { branch_owners: { Boise: 'John', Bend: 'Scott' } });
});
test.after(() => server.close());

test('a branch page shows only that branch, with live numbers', async () => {
  const mk = async b => (await req('POST', '/api/pipeline/scan', { week: '2026-11-09', opportunities: [b] })).body;
  await mk({ business: 'Crave Kitchen & Bar', branch: 'Boise', priority: 'Hot', deal_size: '$250K–$500K', deadline: '2026-11-20', stage: 'Design' });
  await mk({ business: 'Rare Steakhouse', branch: 'Boise', priority: 'Hot', deal_size: '$60K–$180K' });
  await mk({ business: 'Cascade KB', branch: 'Boise / Bend', list_type: 'chain', priority: 'Warm', deal_size: '$100K–$200K' });
  await mk({ business: "M's Bakery", branch: 'Bend', priority: 'Hot', deal_size: '$40K–$150K' });
  await mk({ business: 'Dutch Bros', branch: 'All branches', list_type: 'chain' });
  const all = (await req('GET', '/api/opportunities')).body;
  const id = n => all.find(o => o.business === n).id;
  await req('PATCH', `/api/opportunities/${id('Rare Steakhouse')}`, { assigned_rep: '', status: 'Contacted' });
  await req('POST', '/api/tasks', { title: 'Walk Crave site', due_date: '2026-11-12', opportunity_id: id('Crave Kitchen & Bar') });
  await req('POST', '/api/tasks', { title: 'Old follow-up', due_date: '2026-11-01', assigned_to: 'John' });
  await req('PUT', '/api/pipeline/reports/2026-11-09', { focus: [
    { opportunity_id: id('Crave Kitchen & Bar'), action: 'Meet Derek' },
    { opportunity_id: id("M's Bakery"), action: 'Oven package' },
    { action: 'Visit Crave Kitchen & Bar and M\'s Bakery this week', branch: 'Boise / Bend' },
    { action: 'Year-end tax push on every open quote', branch: 'All' },
  ] });

  const b = (await req('GET', '/api/branches/boise?week=2026-11-09&today=2026-11-10')).body;
  assert.equal(b.branch, 'Boise');
  assert.equal(b.owner, 'John');
  assert.deepEqual(b.leads.map(o => o.business).sort(), ['Cascade KB', 'Crave Kitchen & Bar', 'Rare Steakhouse'], 'shared "Boise / Bend" row included; Bend and all-branch rows excluded');
  assert.equal(b.tiles.open, 3);
  assert.equal(b.tiles.hot, 2);
  assert.equal(b.tiles.pipeline_low, 310000, 'chain accounts not in pipeline');
  assert.equal(b.tiles.hot_unassigned, 1);
  assert.equal(b.tiles.deadlines_14d, 1);
  assert.equal(b.company_wide_open, 1);
  assert.deepEqual(b.focus.map(f => f.opp ? f.opp.business : (f.opps?.length ? 'group:' + f.opps.map(o => o.business).join('+') : 'general')),
    ['Crave Kitchen & Bar', 'group:Crave Kitchen & Bar', 'general'], "Bend's item left out; group narrowed to Boise's lead");
  assert.deepEqual(b.upcoming.filter(u => u.kind !== 'scan').map(u => [u.date, u.kind]), [['2026-11-12', 'task'], ['2026-11-20', 'deadline']]);
  assert.deepEqual(b.overdue.map(t => t.title), ['Old follow-up'], "owner's overdue tasks show");
  assert.ok(b.reps.find(r => r.rep === 'John').hot >= 1);
  assert.ok(b.activity.length > 0);

  const bend = (await req('GET', '/api/branches/Bend?week=2026-11-09&today=2026-11-10')).body;
  assert.deepEqual(bend.leads.map(o => o.business).sort(), ['Cascade KB', "M's Bakery"]);
  assert.equal((await req('GET', '/api/branches/Atlantis')).status, 404);
});

test('meta tells a branch owner which branch is theirs', async () => {
  const inv = await req('POST', '/api/users/invite', { email: 'john@curtisresteq.com', role: 'rep' });
  const token = inv.body.link.split('/#/accept/')[1];
  const saved = cookie; cookie = null;
  await req('POST', `/api/invites/${token}/accept`, { name: 'John Carter', password: 'john-password-1' });
  assert.deepEqual((await req('GET', '/api/pipeline/meta')).body.my_branches, ['Boise']);
  cookie = saved;
});
