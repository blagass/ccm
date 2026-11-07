// Branch owners: new and unassigned leads route to whoever owns the branch; placeholder first names
// ("John") switch to the person's full name when they join.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'owner-pass-123';
delete process.env.SMTP_HOST;

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let base, server;
function client() {
  let cookie = null;
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const owner = client();
const get = async id => (await owner('GET', `/api/opportunities/${id}`)).body;

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
  await owner('POST', '/api/login', { password: 'owner-pass-123' });
});
test.after(() => server.close());

let before;
test('existing unassigned leads can be routed by branch in one step', async () => {
  before = {
    boise: (await owner('POST', '/api/opportunities', { business: 'Crave Kitchen & Bar', branch: 'Boise', priority: 'Hot' })).body.id,
    bendBoise: (await owner('POST', '/api/opportunities', { business: 'Cascade KB', branch: 'Boise / Bend', priority: 'Hot' })).body.id,
    portland: (await owner('POST', '/api/opportunities', { business: 'Corbett SD', branch: 'Portland', priority: 'Hot' })).body.id,
    all: (await owner('POST', '/api/opportunities', { business: 'Dutch Bros', branch: 'All branches' })).body.id,
    taken: (await owner('POST', '/api/opportunities', { business: 'Taken Already', branch: 'Medford', assigned_rep: 'Dana' })).body.id,
    won: (await owner('POST', '/api/opportunities', { business: 'Done Deal', branch: 'Medford' })).body.id,
  };
  await owner('PATCH', `/api/opportunities/${before.won}`, { status: 'Won' });
  await owner('PUT', '/api/settings', { branch_owners: { Boise: 'John', Bend: 'Scott', Springfield: 'Nyles', Medford: 'Kevin' } });
  const r = await owner('POST', '/api/pipeline/assign-by-branch');
  assert.deepEqual(r.body.assigned, { John: 2 });
  assert.equal((await get(before.boise)).assigned_rep, 'John');
  assert.equal((await get(before.bendBoise)).assigned_rep, 'John', '"Boise / Bend" counts as Boise, like the spreadsheet');
  assert.equal((await get(before.portland)).assigned_rep, '', 'no Portland owner set');
  assert.equal((await get(before.all)).assigned_rep, '');
  assert.equal((await get(before.taken)).assigned_rep, 'Dana', 'never overrides a rep');
  assert.equal((await get(before.won)).assigned_rep, '', 'closed leads left alone');
  assert.ok((await get(before.boise)).activity.some(a => a.summary === 'Assigned to John (Boise branch owner)'));
});

test('new leads (manual and weekly scan) go to the branch owner automatically', async () => {
  const m = (await owner('POST', '/api/opportunities', { business: "Fitti's Pizza", branch: 'Springfield (Eugene)' })).body;
  assert.equal(m.assigned_rep, 'Nyles');
  const chosen = (await owner('POST', '/api/opportunities', { business: 'Chosen Rep Cafe', branch: 'Bend', assigned_rep: 'Dana' })).body;
  assert.equal(chosen.assigned_rep, 'Dana', 'an explicit choice wins');
  await owner('POST', '/api/pipeline/scan', { week: '2026-11-09', opportunities: [
    { business: "Jay's on 4th", branch: 'Medford', priority: 'Hot' },
    { business: "M's Bakery", branch: 'Bend', priority: 'Hot' },
    { business: 'Corbett SD', branch: 'Portland', stage: 'Bid closes Nov 17' },
  ] });
  const list = (await owner('GET', '/api/opportunities?week=2026-11-09')).body;
  const rep = n => list.find(o => o.business === n).assigned_rep;
  assert.deepEqual([rep("Jay's on 4th"), rep("M's Bakery"), rep('Corbett SD')], ['Kevin', 'Scott', '']);
  // Reps can't change routing.
  const inv = await owner('POST', '/api/users/invite', { email: 'rep@x.com', role: 'rep' });
  const rc = client();
  await rc('POST', `/api/invites/${inv.body.link.split('/#/accept/')[1]}/accept`, { name: 'Rita Rep', password: 'rita-password-1' });
  assert.equal((await rc('POST', '/api/pipeline/assign-by-branch')).status, 403);
  assert.equal((await rc('PUT', '/api/settings', { branch_owners: { Boise: 'Rita' } })).status, 403);
});

test('when John joins as "John Carter", his leads, tasks and branch switch to his full name', async () => {
  await owner('POST', '/api/tasks', { title: 'Walk Crave site', due_date: '2026-11-10', assigned_to: 'John', opportunity_id: before.boise });
  const inv = await owner('POST', '/api/users/invite', { email: 'john@curtisresteq.com', role: 'rep' });
  const john = client();
  await john('POST', `/api/invites/${inv.body.link.split('/#/accept/')[1]}/accept`, { name: 'John Carter', password: 'john-password-1' });
  assert.equal((await get(before.boise)).assigned_rep, 'John Carter');
  assert.equal((await owner('GET', '/api/settings')).body.branch_owners.Boise, 'John Carter');
  const mine = (await john('GET', '/api/calendar?from=2026-11-01&to=2026-11-30&mine=1')).body;
  assert.deepEqual(mine.tasks.map(t => t.title), ['Walk Crave site'], 'his tasks show under Mine');
  const w = (await john('GET', '/api/welcome?today=2026-11-09&hour=9')).body;
  assert.equal(w.greeting, 'Good morning, John!');
  assert.ok(w.wins.some(x => /Crave Kitchen/.test(x.text)), 'his Hot lead shows up in his quick wins');
  // A new Boise lead now goes to the full name.
  assert.equal((await owner('POST', '/api/opportunities', { business: 'New Boise Spot', branch: 'Boise' })).body.assigned_rep, 'John Carter');
  // Someone named John who is NOT a branch owner placeholder doesn't grab anything.
  const inv2 = await owner('POST', '/api/users/invite', { email: 'other@x.com', role: 'rep' });
  await client()('POST', `/api/invites/${inv2.body.link.split('/#/accept/')[1]}/accept`, { name: 'John Smith', password: 'john-smith-pass-1' });
  assert.equal((await get(before.boise)).assigned_rep, 'John Carter');
});
