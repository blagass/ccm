// Follow-up: approved leads their branch hasn't opened yet, and reminders Operators send about them.
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
const ids = {};
const today = new Date().toISOString().slice(0, 10);
const plus = n => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const groupFor = (f, to) => f.groups.find(g => g.to === to);

test.before(async () => {
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`; process.env.BASE_URL = base;
  await owner('POST', '/api/login', { password: 'owner-pass-123' });
  await owner('PUT', '/api/settings', { branches: ['Springfield', 'Bend', 'Medford', 'Boise'], branch_merges: { Portland: 'Springfield' }, branch_owners: { Boise: 'John Carter', Bend: 'Scott' } });
  for (const [email, role, branch, name, who] of [['opal@x.com', 'operator', null, 'Opal Ops', opal], ['john@x.com', 'manager', 'Boise', 'John Carter', john], ['rita@x.com', 'rep', null, 'Rita Rep', rita]]) {
    const inv = await owner('POST', '/api/users/invite', { email, role, branch });
    await who('POST', `/api/invites/${token(inv.body.link)}/accept`, { name, password: 'a-good-password-1' });
  }
  await owner('POST', '/api/pipeline/scan', { week: '2026-11-16', opportunities: [
    { business: 'Crave Kitchen & Bar', branch: 'Boise', priority: 'Hot' },
    { business: 'Rare Steakhouse', branch: 'Boise', priority: 'Warm', deadline: plus(3) },
    { business: 'Barrel Room', branch: 'Boise', priority: 'Watch' },
    { business: "M's Bakery", branch: 'Bend', priority: 'Hot' },
    { business: 'Still Pending Cafe', branch: 'Boise', priority: 'Hot' },
  ] });
  const q = (await opal('GET', '/api/review')).body.leads;
  for (const o of q) ids[o.business] = o.id;
  await opal('POST', '/api/review/approve', { items: q.filter(o => o.business !== 'Still Pending Cafe').map(o => ({ id: o.id })) });
});
test.after(() => server.close());

test('approved leads show as not looked at, grouped by branch and person, with urgency', async () => {
  const f = (await opal('GET', `/api/followup?today=${plus(5)}`)).body;
  const boise = groupFor(f, 'John Carter');
  assert.equal(boise.branch, 'Boise');
  assert.deepEqual(boise.leads.map(l => l.business), ['Crave Kitchen & Bar', 'Rare Steakhouse', 'Barrel Room'], 'urgent first');
  assert.deepEqual(boise.leads.map(l => l.urgency), ['red', 'red', ''], 'Hot after 3 days, and a deadline inside a week, are red');
  assert.equal(boise.leads[0].days, 5);
  assert.equal(boise.hot, 1);
  assert.equal(groupFor(f, 'Scott').leads.length, 1);
  assert.ok(!f.groups.flatMap(g => g.leads).some(l => l.business === 'Still Pending Cafe'), 'leads still in review are not counted');
  assert.equal(f.stats.untouched, 4);
  assert.equal((await opal('GET', `/api/followup?today=${plus(9)}`)).body.groups[0].leads.find(l => l.business === 'Barrel Room').urgency, 'orange');
  assert.equal((await john('GET', '/api/followup')).status, 403);
  assert.equal((await rita('GET', '/api/followup')).status, 403);
});

test('operators opening a lead does not count; the branch manager opening it does', async () => {
  await opal('GET', `/api/opportunities/${ids['Crave Kitchen & Bar']}`);
  await owner('GET', `/api/opportunities/${ids['Crave Kitchen & Bar']}`);
  await rita('GET', `/api/opportunities/${ids['Crave Kitchen & Bar']}`);
  assert.equal(groupFor((await opal('GET', '/api/followup')).body, 'John Carter').leads.length, 3);
  const o = (await john('GET', `/api/opportunities/${ids['Crave Kitchen & Bar']}`)).body;
  assert.equal(o.touched_by, 'John Carter');
  assert.match(o.activity[0].summary, /^First opened by John Carter/);
  assert.deepEqual(groupFor((await opal('GET', '/api/followup')).body, 'John Carter').leads.map(l => l.business), ['Rare Steakhouse', 'Barrel Room']);
  // A rep working a lead (here: a note) counts, even when it isn't assigned to them
  await rita('POST', `/api/opportunities/${ids["M's Bakery"]}/notes`, { text: 'Called, left a voicemail' });
  assert.equal(groupFor((await opal('GET', '/api/followup')).body, 'Scott'), undefined);
});

test('moving a lead to another branch starts the clock over for the new branch', async () => {
  await opal('POST', `/api/opportunities/${ids['Crave Kitchen & Bar']}/branch`, { branch: 'Bend' });
  const f = (await opal('GET', '/api/followup')).body;
  assert.deepEqual(groupFor(f, 'Scott').leads.map(l => l.business), ['Crave Kitchen & Bar']);
  await opal('POST', `/api/opportunities/${ids['Crave Kitchen & Bar']}/branch`, { branch: 'Boise' });
});

test('operators send reminders; only the recipient sees them, and they clear once the leads are opened', async () => {
  const lead_ids = [ids['Crave Kitchen & Bar'], ids['Rare Steakhouse'], ids['Barrel Room']];
  assert.equal((await john('POST', '/api/reminders', { to_name: 'Rita Rep', message: 'hi', lead_ids })).status, 403);
  assert.equal((await opal('POST', '/api/reminders', { to_name: 'John Carter', message: '', lead_ids })).status, 400);
  const r = await opal('POST', '/api/reminders', { to_name: 'John Carter', branch: 'Boise', message: 'Hi John, a quick nudge on 3 Boise leads.', lead_ids });
  assert.equal(r.status, 201);
  assert.equal(r.body.from_name, 'Opal Ops');

  let mine = (await john('GET', '/api/reminders/mine')).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].remaining, 3);
  assert.equal(mine[0].message, 'Hi John, a quick nudge on 3 Boise leads.');
  assert.equal((await rita('GET', '/api/reminders/mine')).body.length, 0);
  assert.equal((await rita('POST', `/api/reminders/${r.body.id}/dismiss`)).status, 403);

  const w = (await john('GET', `/api/welcome?today=${today}&hour=9`)).body;
  assert.match(w.wins[0].text, /^Opal sent a reminder \(.+\): 3 leads waiting to be opened, starting with Crave Kitchen & Bar\.$/);
  assert.equal(w.wins[0].href, '#/branch/Boise?tab=unopened');

  let last = groupFor((await opal('GET', '/api/followup')).body, 'John Carter').last_reminder;
  assert.equal(last.from, 'Opal Ops'); assert.equal(last.leads, 3); assert.equal(last.opened_since, 0);

  await john('GET', `/api/opportunities/${ids['Crave Kitchen & Bar']}`);
  await john('PATCH', `/api/opportunities/${ids['Barrel Room']}`, { status: 'Not interested' });
  mine = (await john('GET', '/api/reminders/mine')).body;
  assert.equal(mine[0].remaining, 1);
  last = groupFor((await opal('GET', '/api/followup')).body, 'John Carter').last_reminder;
  assert.equal(last.opened_since, 2);

  await john('GET', `/api/opportunities/${ids['Rare Steakhouse']}`);
  assert.equal((await john('GET', '/api/reminders/mine')).body.length, 0, 'clears itself once everything is opened');
});

test('recipients can dismiss a reminder, and operators get a nudge when leads sit unopened', async () => {
  await opal('POST', '/api/review/approve', { items: [{ id: ids['Still Pending Cafe'] }] });
  const r = (await opal('POST', '/api/reminders', { to_name: 'John Carter', message: 'Nudge', lead_ids: [ids['Still Pending Cafe']] })).body;
  assert.equal((await john('GET', '/api/reminders/mine')).body.length, 1);
  assert.equal((await john('POST', `/api/reminders/${r.id}/dismiss`)).status, 200);
  assert.equal((await john('GET', '/api/reminders/mine')).body.length, 0);
  const w = (await opal('GET', `/api/welcome?today=${plus(5)}&hour=9`)).body;
  assert.ok(w.wins.some(x => x.href === '#/followup' && /^1 approved lead hasn't been opened by its branch after 3\+ days/.test(x.text)), JSON.stringify(w.wins));
});
