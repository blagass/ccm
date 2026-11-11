// Operator review queue: scan leads wait for review; nobody else sees them until they're approved.
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
const owner = client(), opal = client(), john = client(), rita = client();
const token = l => l.split('/#/accept/')[1];
const byName = async (c, n) => (await c('GET', '/api/opportunities')).body.find(o => o.business === n);

test.before(async () => {
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`; process.env.BASE_URL = base;
  await owner('POST', '/api/login', { password: 'owner-pass-123' });
  await owner('PUT', '/api/settings', { branches: ['Springfield', 'Bend', 'Medford', 'Boise'], branch_merges: { Portland: 'Springfield' }, branch_owners: { Boise: 'John Carter', Bend: 'Scott' } });
  for (const [email, role, branch, name, who] of [['opal@x.com', 'operator', null, 'Opal Ops', opal], ['john@x.com', 'manager', 'Boise', 'John Carter', john], ['rita@x.com', 'rep', null, 'Rita Rep', rita]]) {
    const inv = await owner('POST', '/api/users/invite', { email, role, branch });
    await who('POST', `/api/invites/${token(inv.body.link)}/accept`, { name, password: 'a-good-password-1' });
  }
});
test.after(() => server.close());

test('new scan leads wait in the review queue, unrouted and hidden from managers and reps', async () => {
  const r = (await owner('POST', '/api/pipeline/scan', { week: '2026-11-16', opportunities: [
    { business: 'Crave Kitchen & Bar', branch: 'Boise', priority: 'Hot', deadline: '2026-11-20' },
    { business: 'Rare Steakhouse', branch: 'Boise', priority: 'Warm' },
    { business: "M's Bakery", branch: 'Bend', priority: 'Hot' },
  ] })).body;
  assert.equal(r.created, 3);
  const q = (await opal('GET', '/api/review')).body.leads;
  assert.deepEqual(q.map(o => o.business), ["Crave Kitchen & Bar", "M's Bakery", 'Rare Steakhouse'], 'Hot first');
  assert.ok(q.every(o => !o.assigned_rep), 'not routed yet');
  assert.equal((await john('GET', '/api/opportunities')).body.length, 0);
  assert.equal((await rita('GET', '/api/opportunities')).body.length, 0);
  assert.equal((await john('GET', '/api/branches/Boise')).body.leads.length, 0);
  assert.equal((await owner('GET', '/api/branches/Boise')).body.pending_review, 2);
  assert.equal((await john('GET', `/api/opportunities/${q[0].id}`)).status, 404);
  assert.equal((await john('GET', '/api/review')).status, 403);
  assert.equal((await rita('GET', '/api/review')).status, 403);
  const cal = (await john('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).body;
  assert.equal(cal.events.filter(e => e.kind === 'deadline').length, 0);
  const w = (await opal('GET', '/api/welcome?today=2026-11-16&hour=8')).body;
  assert.match(w.wins[0].text, /^Review 3 new leads \(2 Hot\)/);
  // Re-sending a pending lead keeps it pending and unrouted
  await owner('POST', '/api/pipeline/scan', { week: '2026-11-16', opportunities: [{ business: 'Crave Kitchen & Bar', branch: 'Boise', stage: 'Design' }] });
  assert.equal((await opal('GET', '/api/review')).body.leads.length, 3);
  // and the "assign unassigned leads" button leaves pending ones alone
  await opal('POST', '/api/pipeline/assign-by-branch');
  assert.ok((await opal('GET', '/api/review')).body.leads.every(o => !o.assigned_rep));
});

test('approve sends a lead to its branch (or another one); close-outs and notes work from the queue', async () => {
  const crave = await byName(opal, 'Crave Kitchen & Bar'), bakery = await byName(opal, "M's Bakery"), rare = await byName(opal, 'Rare Steakhouse');
  assert.equal((await rita('POST', '/api/review/approve', { items: [{ id: crave.id }] })).status, 403);
  const a = (await opal('POST', '/api/review/approve', { items: [{ id: crave.id }, { id: bakery.id, branch: 'Boise' }] })).body;
  assert.equal(a.approved, 2);
  const c2 = await byName(owner, 'Crave Kitchen & Bar'), b2 = await byName(owner, "M's Bakery");
  assert.deepEqual([c2.review_status, c2.assigned_rep], ['approved', 'John Carter']);
  assert.deepEqual([b2.branch, b2.assigned_rep], ['Boise', 'John Carter'], 'approved into a different branch');
  assert.deepEqual((await john('GET', '/api/opportunities')).body.map(o => o.business).sort(), ['Crave Kitchen & Bar', "M's Bakery"]);
  assert.ok((await owner('GET', `/api/opportunities/${crave.id}`)).body.activity.some(x => x.summary === 'Approved for Boise (now with John Carter)' && x.user_name === 'Opal Ops'));
  // Needs more info keeps it in the queue with a note
  const n = await opal('POST', `/api/opportunities/${rare.id}/review-note`, { note: 'Confirm the Caldwell address' });
  assert.equal(n.body.review_note, 'Confirm the Caldwell address');
  assert.equal((await opal('GET', '/api/review')).body.leads.length, 1);
  // Not interested from the queue closes it and empties the queue
  await opal('PATCH', `/api/opportunities/${rare.id}`, { status: 'Not interested' });
  assert.equal((await opal('GET', '/api/review')).body.leads.length, 0);
});

test('reset puts every open lead back in review; turning review off restores direct routing', async () => {
  assert.equal((await opal('POST', '/api/review/reset-open')).status, 403, 'admins only');
  const r = (await owner('POST', '/api/review/reset-open')).body;
  assert.equal(r.moved, 2, 'closed leads stay closed');
  assert.equal((await john('GET', '/api/opportunities')).body.length, 0);
  assert.ok((await opal('GET', '/api/review')).body.leads.every(o => !o.assigned_rep));
  await owner('PUT', '/api/settings', { review_new_leads: false });
  await owner('POST', '/api/pipeline/scan', { week: '2026-11-23', opportunities: [{ business: 'Auto Routed Cafe', branch: 'Boise' }] });
  assert.equal((await byName(owner, 'Auto Routed Cafe')).assigned_rep, 'John Carter');
});
