// Branch Manager role: invite for a branch, becomes its owner, branch-focused popup and landing page.
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
const owner = client(), kevin = client();
const token = link => link.split('/#/accept/')[1];

test.before(async () => {
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`; process.env.BASE_URL = base;
  await owner('POST', '/api/login', { password: 'owner-pass-123' });
  await owner('PUT', '/api/settings', { branches: ['Springfield', 'Bend', 'Medford', 'Boise'], branch_merges: { Portland: 'Springfield' }, branch_owners: { Medford: 'Kevin', Boise: 'John' } });
  await owner('POST', '/api/pipeline/scan', { week: '2026-11-09', opportunities: [
    { business: "Jay's on 4th", branch: 'Medford', priority: 'Hot', deadline: '2026-11-12', stage: 'Opening' },
    { business: 'Rogue Salad Co.', branch: 'Medford (Grants Pass)', priority: 'Warm' },
    { business: 'Dave\'s Hot Chicken', branch: 'Medford', priority: 'Hot' },
    { business: 'Crave Kitchen & Bar', branch: 'Boise', priority: 'Hot' },
  ] });
});
test.after(() => server.close());

test('inviting a Branch Manager needs a real branch', async () => {
  assert.equal((await owner('POST', '/api/users/invite', { email: 'kevin@curtisresteq.com', role: 'manager' })).status, 400);
  assert.equal((await owner('POST', '/api/users/invite', { email: 'kevin@curtisresteq.com', role: 'manager', branch: 'Atlantis' })).status, 400);
  assert.equal((await owner('POST', '/api/users/invite', { email: 'kevin@curtisresteq.com', role: 'boss' })).status, 400);
});

test('Kevin accepts as Medford manager: owner of Medford, his leads follow him', async () => {
  const inv = await owner('POST', '/api/users/invite', { email: 'kevin@curtisresteq.com', role: 'manager', branch: 'medford' });
  assert.equal(inv.status, 201);
  assert.deepEqual([inv.body.role, inv.body.branch], ['manager', 'Medford']);
  const info = await client()('GET', `/api/invites/${token(inv.body.link)}`);
  assert.deepEqual([info.body.role, info.body.branch], ['manager', 'Medford']);
  await kevin('POST', `/api/invites/${token(inv.body.link)}/accept`, { name: 'Kevin Moore', password: 'kevin-password-1' });
  const me = (await kevin('GET', '/api/me')).body.user;
  assert.deepEqual([me.role, me.branch], ['manager', 'Medford']);
  assert.equal((await owner('GET', '/api/settings')).body.branch_owners.Medford, 'Kevin Moore');
  const leads = (await owner('GET', '/api/opportunities?branch=Medford')).body;
  assert.ok(leads.length === 3 && leads.every(o => o.assigned_rep === 'Kevin Moore'), 'placeholder "Kevin" leads moved to Kevin Moore');
  assert.deepEqual((await kevin('GET', '/api/pipeline/meta')).body.my_branches, ['Medford']);
  assert.equal((await kevin('GET', '/api/users')).status, 403, 'managers do not manage users');
  assert.equal((await kevin('PUT', '/api/settings', { company_name: 'x' })).status, 403);
  const list = (await owner('GET', '/api/users')).body.users;
  assert.equal(list.find(u => u.email === 'kevin@curtisresteq.com').branch, 'Medford');
});

test("Kevin's welcome is about Medford", async () => {
  const w = (await kevin('GET', '/api/welcome?today=2026-11-10&hour=8')).body;
  assert.equal(w.role, 'manager');
  assert.equal(w.greeting, 'Good morning, Kevin!');
  assert.match(w.intro, /^Medford has 3 open leads, 2 Hot, and 3 new this week\./);
  const text = w.wins.map(x => x.text).join(' | ');
  assert.match(text, /Jay's on 4th has a deadline on Thursday/);
  assert.doesNotMatch(text, /Crave/, 'other branches stay out');
  assert.match(w.closing, /Medford/);
});

test('changing roles: manager of another branch, then back to rep', async () => {
  const id = (await owner('GET', '/api/users')).body.users.find(u => u.email === 'kevin@curtisresteq.com').id;
  assert.equal((await owner('PATCH', `/api/users/${id}`, { role: 'manager', branch: 'Narnia' })).status, 400);
  const r = await owner('PATCH', `/api/users/${id}`, { role: 'manager', branch: 'Bend' });
  assert.equal(r.body.branch, 'Bend');
  assert.equal((await owner('GET', '/api/settings')).body.branch_owners.Bend, 'Kevin Moore');
  const r2 = await owner('PATCH', `/api/users/${id}`, { role: 'rep' });
  assert.deepEqual([r2.body.role, r2.body.branch], ['rep', null]);
  assert.equal((await kevin('GET', '/api/welcome?today=2026-11-10&hour=8')).body.role, 'rep');
});
