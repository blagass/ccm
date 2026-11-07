// Welcome popup content: greeting, calm intro, up to three quick wins drawn from the person's own work.
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
const owner = client(), brandon = client();

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
  await owner('POST', '/api/login', { password: 'owner-pass-123' });
  const inv = await owner('POST', '/api/users/invite', { email: 'brandon@curtisresteq.com', role: 'rep' });
  await brandon('POST', `/api/invites/${inv.body.link.split('/#/accept/')[1]}/accept`, { name: 'Brandon Lagasse', password: 'a-good-password-1' });
});
test.after(() => server.close());

test('requires sign-in', async () => {
  assert.equal((await client()('GET', '/api/welcome')).status, 401);
});

test('quiet day: friendly greeting and a gentle suggestion', async () => {
  const w = (await brandon('GET', '/api/welcome?today=2026-11-09&hour=8')).body;
  assert.equal(w.greeting, 'Good morning, Brandon!');
  assert.ok(w.wins.length >= 1 && w.wins.length <= 3);
  assert.match(w.tip, /Dec 31/, 'year-end tip in November');
  assert.doesNotMatch(JSON.stringify(w), /undefined|null/);
});

test('busy day: quick wins come from my overdue tasks, near deadlines and Hot leads at New', async () => {
  const mk = b => owner('POST', '/api/opportunities', b);
  const bid = (await mk({ business: 'Corbett School District – CTE kitchen', priority: 'Hot', deadline: '2026-11-11', assigned_rep: 'Brandon Lagasse', next_step: 'Send pricing to every GC.' })).body;
  await mk({ business: 'Crave Kitchen & Bar (2nd location)', priority: 'Hot', assigned_rep: 'Brandon Lagasse' });
  await mk({ business: 'Someone Else Diner', priority: 'Hot', assigned_rep: 'Dana', deadline: '2026-11-10' });
  for (let i = 0; i < 6; i++) await mk({ business: `Unassigned Hot ${i}`, priority: 'Hot' });
  await brandon('POST', '/api/tasks', { title: 'Call Derek Hood', due_date: '2026-11-06', assigned_to: 'Brandon Lagasse' });
  await brandon('POST', '/api/tasks', { title: "Dana's thing", due_date: '2026-11-05', assigned_to: 'Dana' });

  const w = (await brandon('GET', '/api/welcome?today=2026-11-09&hour=14')).body;
  assert.equal(w.greeting, 'Good afternoon, Brandon!');
  assert.match(w.intro, /quick wins/i, 'busy weeks are framed calmly around quick wins');
  assert.equal(w.wins.length, 3);
  assert.match(w.wins[0].text, /Call Derek Hood/, 'my overdue task first');
  assert.match(w.wins[1].text, /^Corbett School District has a deadline on Wednesday \(Wed, Nov 11\)\. Send pricing to every GC\.$/);
  assert.equal(w.wins[1].href, `#/pipeline/${bid.id}`);
  assert.match(w.wins[2].text, /Crave Kitchen & Bar/);
  assert.ok(!JSON.stringify(w.wins).includes("Dana's thing") && !JSON.stringify(w.wins).includes('Someone Else'), "other people's work stays out");
  assert.equal(w.stats.unassigned_hot, 0, 'reps are not nagged about assignment');
});

test('admins are nudged to hand out unassigned Hot leads', async () => {
  const w = (await owner('GET', '/api/welcome?today=2026-11-09&hour=19')).body;
  assert.equal(w.greeting, 'Good evening!', 'owner login has no personal name');
  assert.ok(w.stats.unassigned_hot >= 6);
  assert.ok(w.wins.some(x => /Hand out \d+ Hot leads/.test(x.text)));
});
