// End-to-end tests against a real server on an in-memory database.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-pass';
delete process.env.SMTP_HOST;

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const automation = require('../src/automation');
const { db } = require('../src/db');

let base, cookie, server;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, path, body, { auth = true, headers = {}, redirect = 'follow' } = {}) {
  const res = await fetch(base + path, {
    method, redirect,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
});
test.after(() => { automation.stop(); server.close(); });

test('auth is required for admin API and login works', async () => {
  assert.equal((await req('GET', '/api/contacts', null, { auth: false })).status, 401);
  assert.equal((await req('POST', '/api/login', { password: 'nope' })).status, 401);
  const r = await req('POST', '/api/login', { password: 'test-pass' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('GET', '/api/contacts')).status, 200);
});

let form, template, workflow;

test('create form, template and an automation workflow', async () => {
  const f = await req('POST', '/api/forms', {
    name: 'Ebook download',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'first_name', label: 'First name', type: 'text', required: true },
      { name: 'role', label: 'Role', type: 'select', options: ['Marketing', 'Sales'] },
    ],
    settings: { add_tags: 'ebook, inbound', set_stage: 'lead', success_message: 'Check your inbox!' },
  });
  assert.equal(f.status, 201);
  form = f.body;
  assert.match(form.public_id, /^[0-9a-f]{12}$/);

  assert.equal((await req('POST', '/api/forms', { name: 'Bad', fields: [{ name: 'x' }] })).status, 400, 'email field required');

  const t = await req('POST', '/api/templates', { name: 'Ebook', subject: 'Your ebook, {{first_name|friend}}', body: 'Hi {{first_name}}, download: https://example.com/ebook.pdf' });
  template = t.body;

  const w = await req('POST', '/api/workflows', {
    name: 'Ebook nurture', active: true,
    trigger: { type: 'form_submitted', form_id: form.id },
    steps: [
      { type: 'send_email', template_id: template.id },
      { type: 'adjust_score', amount: 5 },
      { type: 'condition', field: 'property', key: 'role', op: '', value: 'Marketing' },
      { type: 'add_tag', tag: 'marketer' },
      { type: 'wait', amount: 2, unit: 'days' },
      { type: 'set_stage', stage: 'sql' },
    ],
  });
  assert.equal(w.status, 201);
  workflow = w.body;
  assert.equal((await req('POST', '/api/workflows', { name: 'x', trigger: { type: 'nope' }, steps: [] })).status, 400);
});

test('public form: definition, validation errors, honeypot, CORS', async () => {
  const def = await req('GET', `/api/public/forms/${form.public_id}`, null, { auth: false });
  assert.equal(def.status, 200);
  assert.equal(def.body.fields.length, 3);
  assert.equal(def.body.settings.notify_email, undefined, 'internal settings not exposed');

  const bad = await req('POST', `/api/public/forms/${form.public_id}/submit`, { email: 'not-an-email', role: 'Hacker' }, { auth: false });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.email && bad.body.errors.first_name && bad.body.errors.role);

  const spam = await req('POST', `/api/public/forms/${form.public_id}/submit`, { email: 'bot@spam.com', first_name: 'x', _hp: 'gotcha' }, { auth: false });
  assert.equal(spam.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contacts WHERE email = 'bot@spam.com'").get().n, 0);

  const pre = await fetch(`${base}/api/public/forms/${form.public_id}/submit`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

let contactId;
test('submission creates a lead, tags it, scores it, and runs the workflow', async () => {
  const r = await req('POST', `/api/public/forms/${form.public_id}/submit`, {
    email: 'Jane@Acme.com', first_name: 'Jane', role: 'Marketing',
    _meta: { page_url: 'https://acme.com/ebook', utm_source: 'linkedin', utm_campaign: 'q4' },
  }, { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, 'Check your inbox!');
  await sleep(150); // let the workflow run its immediate steps

  const { body: list } = await req('GET', '/api/contacts?q=jane');
  assert.equal(list.total, 1);
  contactId = list.rows[0].id;
  const { body: c } = await req('GET', `/api/contacts/${contactId}`);
  assert.equal(c.email, 'jane@acme.com');
  assert.equal(c.stage, 'lead');
  assert.deepEqual(c.tags.sort(), ['ebook', 'inbound', 'marketer']);
  assert.equal(c.score, 15, '10 for submit + 5 from workflow');
  assert.equal(c.properties.role, 'Marketing');
  assert.equal(c.properties.utm_source, 'linkedin');
  assert.equal(c.submissions.length, 1);
  assert.equal(c.emails.length, 1);
  assert.equal(c.emails[0].subject, 'Your ebook, Jane');
  assert.equal(c.runs[0].status, 'active', 'paused on the wait step');
  assert.equal(c.runs[0].step_index, 5);
});

test('wait step resumes when due and completes the workflow', async () => {
  db.prepare("UPDATE workflow_runs SET next_run_at = datetime('now', '-1 minute')").run();
  await automation.tick();
  const { body: c } = await req('GET', `/api/contacts/${contactId}`);
  assert.equal(c.stage, 'sql');
  assert.equal(c.runs[0].status, 'completed');
});

test('condition step exits contacts that do not match', async () => {
  await req('POST', `/api/public/forms/${form.public_id}/submit`, { email: 'bob@acme.com', first_name: 'Bob', role: 'Sales' }, { auth: false });
  await sleep(150);
  const { body: list } = await req('GET', '/api/contacts?q=bob');
  const { body: c } = await req('GET', `/api/contacts/${list.rows[0].id}`);
  assert.equal(c.runs[0].status, 'exited');
  assert.ok(!c.tags.includes('marketer'));
});

test('re-submitting does not re-enroll by default, and does not duplicate the contact', async () => {
  await req('POST', `/api/public/forms/${form.public_id}/submit`, { email: 'jane@acme.com', first_name: 'Janet' }, { auth: false });
  await sleep(100);
  const { body: c } = await req('GET', `/api/contacts/${contactId}`);
  assert.equal(c.first_name, 'Janet');
  assert.equal(c.runs.length, 1);
  assert.equal(c.submissions.length, 2);
  assert.equal(c.stage, 'sql', 'form stage never moves a contact backwards');
});

test('email open + click tracking, open redirect protection, unsubscribe', async () => {
  const send = db.prepare('SELECT * FROM email_sends WHERE contact_id = ? ORDER BY id LIMIT 1').get(contactId);
  assert.match(send.html, /\/t\/o\/[0-9a-f]+\.gif/);
  assert.match(send.html, /Unsubscribe/);
  const before = (await req('GET', `/api/contacts/${contactId}`)).body.score;

  const px = await fetch(`${base}/t/o/${send.token}.gif`);
  assert.equal(px.headers.get('content-type'), 'image/gif');

  const evil = await req('GET', `/t/c/${send.token}?u=${encodeURIComponent('https://evil.com')}`, null, { redirect: 'manual' });
  assert.equal(evil.status, 400);
  const click = await req('GET', `/t/c/${send.token}?u=${encodeURIComponent('https://example.com/ebook.pdf')}`, null, { redirect: 'manual' });
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://example.com/ebook.pdf');

  const { body: c } = await req('GET', `/api/contacts/${contactId}`);
  assert.equal(c.score, before + 2 + 5);
  assert.ok(c.emails.find(e => e.opened_at && e.clicked_at));

  await fetch(`${base}/u/${send.token}`, { method: 'POST' });
  const r = await req('POST', `/api/contacts/${contactId}/email`, { template_id: template.id });
  assert.equal(r.body.status, 'skipped_unsubscribed');
});

test('lead score threshold auto-promotes to MQL', async () => {
  const { body: c } = await req('POST', '/api/contacts', { email: 'hot@lead.com' });
  await req('PATCH', `/api/contacts/${c.id}`, { score: 60 });
  const { body: after } = await req('GET', `/api/contacts/${c.id}`);
  assert.equal(after.stage, 'mql');
});

test('tag-triggered workflow fires from a manual tag change', async () => {
  await req('POST', '/api/workflows', { name: 'Demo request alert', active: true, trigger: { type: 'tag_added', tag: 'demo' }, steps: [{ type: 'notify', email: 'sales@me.com' }, { type: 'set_stage', stage: 'opportunity' }] });
  const { body: c } = await req('POST', '/api/contacts', { email: 'demo@co.com' });
  await req('PATCH', `/api/contacts/${c.id}`, { tags: ['demo'] });
  await sleep(150);
  assert.equal((await req('GET', `/api/contacts/${c.id}`)).body.stage, 'opportunity');
});

test('import, filter by tag, CSV export, broadcast', async () => {
  const imp = await req('POST', '/api/contacts/import', { rows: [{ email: 'a@x.com', first_name: 'A' }, { email: 'b@x.com', company: '=HYPERLINK()' }, { email: 'bad' }], tags: ['webinar'] });
  assert.deepEqual([imp.body.created, imp.body.updated, imp.body.errors.length], [2, 0, 1]);
  const { body: tagged } = await req('GET', '/api/contacts?tag=webinar');
  assert.equal(tagged.total, 2);

  const csv = await req('GET', '/api/contacts/export.csv?tag=webinar');
  assert.match(csv.body, /^email,first_name/);
  assert.match(csv.body, /'=HYPERLINK\(\)/, 'CSV formula injection neutralised');

  const pv = await req('POST', '/api/broadcasts/preview', { filter: { tag: 'webinar' } });
  assert.equal(pv.body.recipients, 2);
  const b = await req('POST', '/api/broadcasts', { template_id: template.id, filter: { tag: 'webinar' } });
  assert.equal(b.body.queued, 2);
  await sleep(150);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM email_sends WHERE source = 'broadcast'").get().n, 2);
});

test('dashboard and hosted form page render', async () => {
  const d = await req('GET', '/api/dashboard');
  assert.ok(d.body.stats.contacts >= 5);
  assert.ok(d.body.stats.submissions_30d >= 3);
  const page = await req('GET', `/f/${form.public_id}`, null, { auth: false });
  assert.match(page.body, /data-leadflow-form/);
  const plain = await fetch(`${base}/api/public/forms/${form.public_id}/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: 'email=html%40form.com&first_name=Html',
  });
  assert.equal(plain.status, 200);
  assert.match(await plain.text(), /Check your inbox/);
});
