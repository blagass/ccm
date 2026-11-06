// Seeds demo data: a form, templates, a nurture workflow and ~40 leads with history.
// Usage: npm run seed   (uses the same DB_PATH as the server)
const { db } = require('../src/db');
const forms = require('../src/forms');
const contacts = require('../src/contacts');
require('../src/automation');

(async () => {
  if (db.prepare('SELECT COUNT(*) n FROM forms').get().n) { console.log('Database already has data; skipping seed.'); return; }

  const t1 = db.prepare('INSERT INTO templates (name, subject, body) VALUES (?, ?, ?)').run('Ebook delivery', 'Your guide is here, {{first_name|there}} 📘',
    'Hi {{first_name|there}},\n\nThanks for downloading "The Inbound Playbook". Grab it here: https://example.com/playbook.pdf\n\nOver the next week I\'ll send two short tips on putting it into practice.\n\n— Sam at {{company_name}}').lastInsertRowid;
  const t2 = db.prepare('INSERT INTO templates (name, subject, body) VALUES (?, ?, ?)').run('Nurture #2 — case study', 'How Acme doubled demo requests',
    'Hi {{first_name|there}},\n\nQuick story: Acme rebuilt their forms and nurture flow and doubled demo requests in 60 days. Read it: https://example.com/acme\n\nWant the same? Book 20 minutes: https://example.com/demo').lastInsertRowid;

  const ebook = forms.create({
    name: 'Ebook: The Inbound Playbook',
    fields: [
      { name: 'first_name', label: 'First name', type: 'text', required: true },
      { name: 'email', label: 'Work email', type: 'email', required: true },
      { name: 'company', label: 'Company', type: 'text' },
      { name: 'team_size', label: 'Team size', type: 'select', options: ['1-10', '11-50', '51-200', '200+'] },
    ],
    settings: { add_tags: ['ebook'], set_stage: 'lead', submit_label: 'Get the ebook', success_message: 'Check your inbox — the playbook is on its way!' },
  });
  const demo = forms.create({
    name: 'Request a demo',
    fields: [
      { name: 'first_name', label: 'First name', type: 'text', required: true },
      { name: 'last_name', label: 'Last name', type: 'text', required: true },
      { name: 'email', label: 'Work email', type: 'email', required: true },
      { name: 'company', label: 'Company', type: 'text', required: true },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'message', label: 'What are you hoping to solve?', type: 'textarea' },
    ],
    settings: { add_tags: ['demo-request'], set_stage: 'sql', submit_label: 'Book my demo' },
  });

  const wf = (name, trigger, steps) => db.prepare('INSERT INTO workflows (name, trigger, steps, active) VALUES (?, ?, ?, 1)').run(name, JSON.stringify(trigger), JSON.stringify(steps));
  wf('Ebook nurture', { type: 'form_submitted', form_id: ebook.id }, [
    { type: 'send_email', template_id: t1 },
    { type: 'wait', amount: 3, unit: 'days' },
    { type: 'send_email', template_id: t2 },
    { type: 'wait', amount: 2, unit: 'days' },
    { type: 'condition', field: 'clicked_email', op: '', value: '' },
    { type: 'adjust_score', amount: 20 },
    { type: 'notify', email: 'sales@example.com', subject: 'Engaged lead: {{email}}' },
  ]);
  wf('Demo request → sales handoff', { type: 'form_submitted', form_id: demo.id }, [
    { type: 'adjust_score', amount: 30 },
    { type: 'notify', email: 'sales@example.com', subject: 'Demo request from {{company}}' },
  ]);

  const first = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Isla', 'Lucas', 'Aria', 'Mason', 'Nora', 'Leo', 'Ruby', 'Owen', 'Ivy', 'Kai', 'Elena', 'Omar', 'Priya', 'Chen'];
  const cos = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Stark', 'Wayne', 'Wonka', 'Soylent'];
  const sources = ['google', 'linkedin', 'newsletter', 'twitter', ''];
  for (let i = 0; i < 40; i++) {
    const fn = first[i % first.length], co = cos[i % cos.length];
    const email = `${fn.toLowerCase()}.${i}@${co.toLowerCase()}.com`;
    const f = i % 5 === 0 ? demo : ebook;
    await forms.submit(f, { first_name: fn, last_name: 'Demo', email, company: co, team_size: ['1-10', '11-50', '51-200', '200+'][i % 4], message: 'Looking to replace our current tool.' },
      { page_url: 'https://example.com/landing', utm_source: sources[i % sources.length] });
    // Backdate so the dashboard chart has a spread.
    const daysAgo = Math.floor(Math.random() * 28);
    const c = contacts.getByEmail(email);
    db.prepare(`UPDATE contacts SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${daysAgo} days`, c.id);
    db.prepare(`UPDATE submissions SET created_at = datetime('now', ?) WHERE contact_id = ?`).run(`-${daysAgo} days`, c.id);
    if (i % 7 === 0) contacts.setStage(c.id, 'customer');
  }
  await new Promise(r => setTimeout(r, 500));
  console.log('Seeded demo data: 2 forms, 2 templates, 2 workflows, 40 contacts.');
})();
