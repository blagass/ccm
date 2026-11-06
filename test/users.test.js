// Team accounts: invites, roles, password resets, disabling, and the owner login.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'owner-pass-123';
delete process.env.SMTP_HOST;

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let base, server;
function client() {
  let cookie = null;
  return async function req(method, path, body) {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const tokenOf = link => link.split('/#/accept/')[1];

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
});
test.after(() => server.close());

const owner = client(), dana = client(), sam = client(), stranger = client();
let danaInvite, samId;

test('owner signs in with the admin password (email blank)', async () => {
  assert.equal((await owner('POST', '/api/login', { password: 'nope' })).status, 401);
  const r = await owner('POST', '/api/login', { password: 'owner-pass-123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
  assert.equal((await owner('GET', '/api/me')).body.user.name, 'Owner');
});

test('admin invites a rep; link works once and creates the account', async () => {
  assert.equal((await owner('POST', '/api/users/invite', { email: 'bad' })).status, 400);
  const r = await owner('POST', '/api/users/invite', { email: 'Dana@Curtis.com', role: 'rep' });
  assert.equal(r.status, 201);
  assert.match(r.body.link, /\/#\/accept\/[\w-]{20,}$/);
  assert.equal(r.body.emailed, false, 'no SMTP configured');
  danaInvite = tokenOf(r.body.link);
  assert.equal((await owner('GET', '/api/users')).body.invites.length, 1);

  const info = await stranger('GET', `/api/invites/${danaInvite}`);
  assert.deepEqual([info.body.email, info.body.role, info.body.kind], ['dana@curtis.com', 'rep', 'invite']);
  assert.equal((await stranger('POST', `/api/invites/${danaInvite}/accept`, { name: 'Dana', password: 'short' })).status, 400);
  const acc = await dana('POST', `/api/invites/${danaInvite}/accept`, { name: 'Dana Rep', password: 'correct-horse-1' });
  assert.equal(acc.status, 200);
  assert.equal((await dana('GET', '/api/me')).body.user.name, 'Dana Rep', 'signed in right away');
  assert.equal((await stranger('POST', `/api/invites/${danaInvite}/accept`, { name: 'X', password: 'another-pass-1' })).status, 410, 'single use');
  assert.equal((await stranger('GET', '/api/invites/not-a-real-token')).status, 410);
  assert.equal((await owner('POST', '/api/users/invite', { email: 'dana@curtis.com' })).status, 409, 'already a user');
});

test('users sign in with email + password', async () => {
  const d2 = client();
  assert.equal((await d2('POST', '/api/login', { email: 'dana@curtis.com', password: 'wrong-password' })).status, 401);
  assert.equal((await d2('POST', '/api/login', { email: 'DANA@curtis.com', password: 'correct-horse-1' })).status, 200);
});

test('reps work the pipeline but cannot manage users or settings', async () => {
  assert.equal((await dana('GET', '/api/opportunities')).status, 200);
  assert.equal((await dana('GET', '/api/users')).status, 403);
  assert.equal((await dana('POST', '/api/users/invite', { email: 'x@y.com' })).status, 403);
  assert.equal((await dana('PUT', '/api/settings', { company_name: 'Hacked' })).status, 403);
  assert.equal((await dana('GET', '/api/me')).body.default_password, undefined, 'admin-only info hidden');
  // Work is attributed to the person
  const o = await dana('POST', '/api/opportunities', { business: 'Taco Spot', priority: 'Hot' });
  await dana('PATCH', `/api/opportunities/${o.body.id}`, { status: 'Contacted' });
  await dana('POST', `/api/opportunities/${o.body.id}/notes`, { text: 'Called the owner' });
  const act = (await dana('GET', `/api/opportunities/${o.body.id}`)).body.activity;
  assert.ok(act.find(a => a.summary === 'Called the owner' && a.user_name === 'Dana Rep'));
  assert.ok(act.find(a => a.summary === 'Status: New → Contacted' && a.user_name === 'Dana Rep'));
  assert.ok((await dana('GET', '/api/pipeline/meta')).body.reps.includes('Dana Rep'), 'users appear in the assign list');
});

test('admin invites another admin, changes roles, resets passwords, disables', async () => {
  const inv = await owner('POST', '/api/users/invite', { email: 'sam@curtis.com', role: 'admin' });
  await sam('POST', `/api/invites/${tokenOf(inv.body.link)}/accept`, { name: 'Sam', password: 'sam-password-1' });
  samId = (await sam('GET', '/api/me')).body.user.id;
  assert.equal((await sam('GET', '/api/users')).status, 200, 'new admin can manage users');
  assert.equal((await sam('PATCH', `/api/users/${samId}`, { role: 'rep' })).status, 400, 'cannot demote yourself');

  const list = (await owner('GET', '/api/users')).body.users;
  const danaId = list.find(u => u.email === 'dana@curtis.com').id;
  assert.equal((await owner('PATCH', `/api/users/${danaId}`, { role: 'superuser' })).status, 400);

  // Password reset link
  const reset = await owner('POST', `/api/users/${danaId}/reset`);
  const info = await stranger('GET', `/api/invites/${tokenOf(reset.body.link)}`);
  assert.equal(info.body.kind, 'reset');
  const d3 = client();
  assert.equal((await d3('POST', `/api/invites/${tokenOf(reset.body.link)}/accept`, { password: 'brand-new-pass-9' })).status, 200);
  assert.equal((await client()('POST', '/api/login', { email: 'dana@curtis.com', password: 'correct-horse-1' })).status, 401, 'old password gone');
  assert.equal((await client()('POST', '/api/login', { email: 'dana@curtis.com', password: 'brand-new-pass-9' })).status, 200);

  // Disabling cuts off existing sessions immediately
  await owner('PATCH', `/api/users/${danaId}`, { disabled: true });
  assert.equal((await d3('GET', '/api/opportunities')).status, 401);
  assert.equal((await client()('POST', '/api/login', { email: 'dana@curtis.com', password: 'brand-new-pass-9' })).status, 401);
  await owner('PATCH', `/api/users/${danaId}`, { disabled: false });
  assert.equal((await d3('GET', '/api/opportunities')).status, 200);

  // Revoke a pending invite
  const pend = await owner('POST', '/api/users/invite', { email: 'temp@curtis.com' });
  const pid = (await owner('GET', '/api/users')).body.invites.find(i => i.email === 'temp@curtis.com').id;
  await owner('DELETE', `/api/users/invites/${pid}`);
  assert.equal((await stranger('GET', `/api/invites/${tokenOf(pend.body.link)}`)).status, 410);
});

test('repeated failed logins are throttled', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/login', { email: 'nobody@x.com', password: 'wrong-wrong' });
  assert.equal(last.status, 429);
});
