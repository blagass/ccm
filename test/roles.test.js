// Branch managers see only their branch; operators run the whole pipeline; closed-out leads are skipped by the scan.
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
const owner = client(), john = client(), opal = client();
const token = l => l.split('/#/accept/')[1];
let ids;

test.before(async () => {
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`; process.env.BASE_URL = base;
  await owner('POST', '/api/login', { password: 'owner-pass-123' });
  await owner('PUT', '/api/settings', { branches: ['Springfield', 'Bend', 'Medford', 'Boise'], branch_merges: { Portland: 'Springfield' }, branch_owners: { Boise: 'John', Medford: 'Kevin' } });
  await owner('POST', '/api/pipeline/scan', { week: '2026-11-09', opportunities: [
    { business: 'Crave Kitchen & Bar', branch: 'Boise', priority: 'Hot', deadline: '2026-11-20' },
    { business: 'Rare Steakhouse', branch: 'Boise', priority: 'Hot' },
    { business: "Jay's on 4th", branch: 'Medford', priority: 'Hot', deadline: '2026-11-18' },
    { business: 'Corbett SD', branch: 'Portland', priority: 'Hot' },
  ] });
  const all = (await owner('GET', '/api/opportunities')).body;
  ids = Object.fromEntries(all.map(o => [o.business, o.id]));
  await owner('POST', '/api/tasks', { title: 'Call Jay', due_date: '2026-11-12', opportunity_id: ids["Jay's on 4th"] });
  await owner('POST', '/api/tasks', { title: 'Walk Crave', due_date: '2026-11-12', opportunity_id: ids['Crave Kitchen & Bar'] });
  let inv = await owner('POST', '/api/users/invite', { email: 'john@curtisresteq.com', role: 'manager', branch: 'Boise' });
  await john('POST', `/api/invites/${token(inv.body.link)}/accept`, { name: 'John Carter', password: 'john-password-1' });
  inv = await owner('POST', '/api/users/invite', { email: 'opal@curtisresteq.com', role: 'operator' });
  await opal('POST', `/api/invites/${token(inv.body.link)}/accept`, { name: 'Opal Ops', password: 'opal-password-1' });
});
test.after(() => server.close());

test('a branch manager only sees their branch', async () => {
  const list = (await john('GET', '/api/opportunities')).body.map(o => o.business).sort();
  assert.deepEqual(list, ['Crave Kitchen & Bar', 'Rare Steakhouse']);
  assert.deepEqual((await john('GET', '/api/opportunities?branch=Medford')).body.map(o => o.business).sort(), ['Crave Kitchen & Bar', 'Rare Steakhouse'], 'branch filter cannot widen it');
  assert.equal((await john('GET', `/api/opportunities/${ids["Jay's on 4th"]}`)).status, 404);
  assert.equal((await john('PATCH', `/api/opportunities/${ids["Jay's on 4th"]}`, { status: 'Contacted' })).status, 404);
  assert.equal((await john('POST', `/api/opportunities/${ids["Jay's on 4th"]}/notes`, { text: 'hi' })).status, 404);
  assert.equal((await john('POST', '/api/tasks', { title: 'x', due_date: '2026-11-12', opportunity_id: ids["Jay's on 4th"] })).status, 404);
  assert.equal((await john('GET', `/api/opportunities/${ids['Crave Kitchen & Bar']}`)).status, 200);
  assert.equal((await john('GET', '/api/pipeline/summary')).status, 403, 'no company-wide Executive Summary');
  assert.equal((await john('GET', '/api/pipeline/export.xlsx')).status, 403);
  assert.equal((await john('GET', '/api/branches/Medford')).status, 403);
  assert.equal((await john('GET', '/api/branches/Boise')).status, 200);
  const cal = (await john('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).body;
  assert.deepEqual(cal.tasks.map(t => t.title), ['Walk Crave'], "other branches' tasks hidden");
  assert.deepEqual(cal.events.filter(e => e.kind === 'deadline').map(e => e.opportunity_id), [ids['Crave Kitchen & Bar']]);
  const made = (await john('POST', '/api/opportunities', { business: 'Sneaky Medford Cafe', branch: 'Medford' })).body;
  assert.equal(made.branch, 'Boise', "a manager's new leads land in their branch");
  assert.equal((await john('GET', '/api/pipeline/meta')).body.only_branch, 'Boise');
});

test('an operator sees everything and routes leads, but cannot manage users or settings', async () => {
  assert.equal((await opal('GET', '/api/pipeline/summary')).status, 200);
  assert.equal((await opal('GET', '/api/opportunities')).body.length >= 5, true);
  const moved = await opal('POST', `/api/opportunities/${ids['Corbett SD']}/branch`, { branch: 'Boise' });
  assert.deepEqual([moved.body.branch, moved.body.assigned_rep], ['Boise', 'John Carter']);
  assert.equal((await opal('POST', '/api/pipeline/assign-by-branch')).status, 200);
  assert.equal((await opal('GET', '/api/users')).status, 403);
  assert.equal((await opal('PUT', '/api/settings', { company_name: 'x' })).status, 403);
  assert.equal((await opal('GET', '/api/branches/Medford')).status, 200);
  const w = (await opal('GET', '/api/welcome?today=2026-11-10&hour=9')).body;
  assert.equal(w.role, 'admin', 'operators get the team-picture welcome');
  assert.equal(w.greeting, 'Good morning, Opal!');
  // the moved lead now shows up for John
  assert.ok((await john('GET', '/api/opportunities')).body.some(o => o.business === 'Corbett SD'));
});

test('"Already a customer" and "Not interested" close the lead and the scan skips it', async () => {
  await john('PATCH', `/api/opportunities/${ids['Rare Steakhouse']}`, { status: 'Already a customer' });
  await owner('PATCH', `/api/opportunities/${ids["Jay's on 4th"]}`, { status: 'Not interested' });
  const open = (await owner('GET', '/api/opportunities?open=true')).body.map(o => o.business);
  assert.ok(!open.includes('Rare Steakhouse') && !open.includes("Jay's on 4th"), 'off the open lists');
  const r = (await owner('POST', '/api/pipeline/scan', { week: '2026-11-16', opportunities: [
    { business: 'Rare Steakhouse', branch: 'Boise', priority: 'Hot', stage: 'Opening January' },
    { business: "Jay's on 4th (food plex)", branch: 'Medford', stage: 'Open now' },
  ] })).body;
  assert.equal(r.created, 0); assert.equal(r.updated, 0);
  assert.equal(r.skipped.length, 2);
  const rare = (await owner('GET', `/api/opportunities/${ids['Rare Steakhouse']}`)).body;
  assert.deepEqual([rare.status, rare.last_seen_week, rare.stage === 'Opening January'], ['Already a customer', '2026-11-09', false], 'untouched by the scan');
  const boise = (await john('GET', '/api/branches/Boise?week=2026-11-09')).body;
  assert.equal(boise.leads.find(o => o.business === 'Rare Steakhouse').status, 'Already a customer');
  assert.ok(!boise.reps.some(x => x.open > 0 && x.rep === 'John Carter' && x.hot > 2));
  // Undo: back to Contacted → the scan updates it again
  await owner('PATCH', `/api/opportunities/${ids['Rare Steakhouse']}`, { status: 'Contacted' });
  const r2 = (await owner('POST', '/api/pipeline/scan', { week: '2026-11-16', opportunities: [{ business: 'Rare Steakhouse', branch: 'Boise', stage: 'Opening January' }] })).body;
  assert.equal(r2.updated, 1);
});
