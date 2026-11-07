// Marketing automation engine.
//
// A workflow = trigger + ordered list of steps. When a trigger event fires for a
// contact, the contact is enrolled (a workflow_run row). Runs execute steps in order
// until they hit a `wait` (which schedules next_run_at) or finish. A background
// ticker resumes waiting runs when they come due. State lives in SQLite, so runs
// survive restarts.
const { db, parse } = require('./db');
const bus = require('./events');
const contacts = require('./contacts');
const mailer = require('./mailer');

const TRIGGERS = ['form_submitted', 'tag_added', 'stage_changed', 'contact_created', 'email_opened', 'email_clicked'];
const STEP_TYPES = ['send_email', 'wait', 'add_tag', 'remove_tag', 'set_stage', 'adjust_score', 'condition', 'notify', 'webhook'];
const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };

function sqlTime(date) { return date.toISOString().replace('T', ' ').slice(0, 19); }

function validate(wf) {
  if (!wf.name || !String(wf.name).trim()) throw Object.assign(new Error('Workflow name is required'), { status: 400 });
  if (!wf.trigger || !TRIGGERS.includes(wf.trigger.type)) throw Object.assign(new Error('Invalid trigger'), { status: 400 });
  if (!Array.isArray(wf.steps)) throw Object.assign(new Error('steps must be an array'), { status: 400 });
  for (const s of wf.steps) if (!STEP_TYPES.includes(s.type)) throw Object.assign(new Error(`Unknown step type: ${s.type}`), { status: 400 });
}

function triggerMatches(trigger, event, payload) {
  if (trigger.type !== event) return false;
  switch (event) {
    case 'form_submitted': return !trigger.form_id || Number(trigger.form_id) === Number(payload.formId);
    case 'tag_added': return !trigger.tag || String(trigger.tag).toLowerCase() === payload.tag;
    case 'stage_changed': return !trigger.stage || trigger.stage === payload.stage;
    default: return true;
  }
}

function enroll(workflowId, contactId, { force = false } = {}) {
  const wf = parse(db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId));
  if (!wf) return null;
  if (!force && !wf.trigger.reenroll) {
    const existing = db.prepare('SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?').get(workflowId, contactId);
    if (existing) return null;
  } else {
    // Never run the same workflow twice concurrently for one contact.
    const active = db.prepare("SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ? AND status IN ('active','running')").get(workflowId, contactId);
    if (active) return null;
  }
  const info = db.prepare('INSERT INTO workflow_runs (workflow_id, contact_id, next_run_at) VALUES (?, ?, ?)')
    .run(workflowId, contactId, sqlTime(new Date()));
  contacts.logActivity(contactId, 'workflow', `Enrolled in workflow "${wf.name}"`, { workflowId });
  const runId = Number(info.lastInsertRowid);
  setImmediate(() => processRun(runId).catch(err => console.error('[automation]', err)));
  return runId;
}

function evalCondition(step, c) {
  const v = step.value;
  switch (step.field) {
    case 'tag': return step.op === 'not' ? !c.tags.includes(String(v).toLowerCase()) : c.tags.includes(String(v).toLowerCase());
    case 'stage': return step.op === 'not' ? c.stage !== v : c.stage === v;
    case 'score': {
      const n = Number(v);
      return step.op === 'lt' ? c.score < n : step.op === 'eq' ? c.score === n : c.score >= n;
    }
    case 'opened_email': {
      const row = db.prepare('SELECT 1 FROM email_sends WHERE contact_id = ? AND opened_at IS NOT NULL' + (v ? ' AND template_id = ?' : '') + ' LIMIT 1')
        .get(...(v ? [c.id, Number(v)] : [c.id]));
      return step.op === 'not' ? !row : !!row;
    }
    case 'clicked_email': {
      const row = db.prepare('SELECT 1 FROM email_sends WHERE contact_id = ? AND clicked_at IS NOT NULL' + (v ? ' AND template_id = ?' : '') + ' LIMIT 1')
        .get(...(v ? [c.id, Number(v)] : [c.id]));
      return step.op === 'not' ? !row : !!row;
    }
    case 'property': {
      const pv = c.properties?.[step.key] ?? c[step.key];
      if (step.op === 'exists') return pv !== undefined && pv !== '';
      if (step.op === 'not') return String(pv ?? '') !== String(v);
      if (step.op === 'contains') return String(pv ?? '').toLowerCase().includes(String(v).toLowerCase());
      return String(pv ?? '') === String(v);
    }
    default: return false;
  }
}

async function runStep(step, contact, wf) {
  switch (step.type) {
    case 'send_email': {
      const r = await mailer.sendToContact(contact.id, { templateId: step.template_id, source: `workflow:${wf.id}` });
      return `send_email → ${r.status}`;
    }
    case 'add_tag': contacts.addTag(contact.id, step.tag); return `add_tag ${step.tag}`;
    case 'remove_tag': contacts.removeTag(contact.id, step.tag); return `remove_tag ${step.tag}`;
    case 'set_stage': contacts.setStage(contact.id, step.stage); return `set_stage ${step.stage}`;
    case 'adjust_score': contacts.adjustScore(contact.id, step.amount, `workflow "${wf.name}"`); return `adjust_score ${step.amount}`;
    case 'notify': {
      const c = contacts.get(contact.id);
      const rows = Object.entries({ email: c.email, name: `${c.first_name} ${c.last_name}`.trim(), company: c.company, phone: c.phone, stage: c.stage, score: c.score, ...c.properties })
        .map(([k, v]) => `<tr><td><b>${mailer.escapeHtml(k)}</b></td><td>${mailer.escapeHtml(v)}</td></tr>`).join('');
      await mailer.sendInternal(step.email, mailer.merge(step.subject || 'Lead alert: {{email}}', c),
        `<p>Workflow "${mailer.escapeHtml(wf.name)}" flagged this contact.</p><table>${rows}</table><p><a href="${mailer.BASE_URL()}/#/contacts/${c.id}">Open in My Curtis</a></p>`);
      return `notify ${step.email}`;
    }
    case 'webhook': {
      const res = await fetch(step.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'workflow_step', workflow: { id: wf.id, name: wf.name }, contact: contacts.get(contact.id) }),
        signal: AbortSignal.timeout(10000),
      });
      return `webhook ${step.url} → ${res.status}`;
    }
    default: return `skipped unknown step ${step.type}`;
  }
}

async function processRun(runId) {
  // Atomically claim the run so the ticker and event handlers never double-process.
  const claim = db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ? AND status = 'active'").run(runId);
  if (claim.changes !== 1) return;
  const run = parse(db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId));
  const wf = parse(db.prepare('SELECT * FROM workflows WHERE id = ?').get(run.workflow_id));
  const log = run.log;
  const save = (fields) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`);
    db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')}, log = ? WHERE id = ?`).run(...Object.values(fields), JSON.stringify(log.slice(-100)), runId);
  };

  if (!wf || !wf.active) { log.push({ at: sqlTime(new Date()), msg: 'Workflow inactive; run paused' }); return save({ status: 'paused' }); }

  let i = run.step_index;
  try {
    while (i < wf.steps.length) {
      const step = wf.steps[i];
      const contact = contacts.get(run.contact_id);
      if (!contact) return save({ status: 'cancelled' });

      if (step.type === 'wait') {
        const ms = (Number(step.amount) || 0) * (UNIT_MS[step.unit] || UNIT_MS.days);
        i++;
        log.push({ at: sqlTime(new Date()), msg: `wait ${step.amount} ${step.unit}` });
        return save({ status: 'active', step_index: i, next_run_at: sqlTime(new Date(Date.now() + ms)) });
      }
      if (step.type === 'condition') {
        const ok = evalCondition(step, contact);
        log.push({ at: sqlTime(new Date()), msg: `condition ${step.field} ${step.op || 'is'} ${step.value ?? ''} → ${ok}` });
        if (!ok) { contacts.logActivity(contact.id, 'workflow', `Exited workflow "${wf.name}" (condition not met)`); return save({ status: 'exited', step_index: i }); }
        i++; continue;
      }
      const msg = await runStep(step, contact, wf);
      log.push({ at: sqlTime(new Date()), msg });
      i++;
      save({ status: 'running', step_index: i });
    }
    contacts.logActivity(run.contact_id, 'workflow', `Completed workflow "${wf.name}"`);
    save({ status: 'completed', step_index: i });
  } catch (err) {
    log.push({ at: sqlTime(new Date()), msg: `error at step ${i + 1}: ${err.message}` });
    save({ status: 'failed', step_index: i });
  }
}

async function tick() {
  const due = db.prepare("SELECT id FROM workflow_runs WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 100")
    .all(sqlTime(new Date()));
  for (const r of due) await processRun(r.id).catch(err => console.error('[automation]', err));
}

let timer;
function start(intervalMs = 5000) {
  // Runs interrupted mid-step by a crash/restart are resumed from their saved step.
  db.prepare("UPDATE workflow_runs SET status = 'active' WHERE status = 'running'").run();
  timer = setInterval(() => tick().catch(e => console.error('[automation]', e)), intervalMs);
  timer.unref?.();
}
function stop() { clearInterval(timer); }

// When a workflow is (re)activated, resume its paused runs.
function resumePaused(workflowId) {
  db.prepare("UPDATE workflow_runs SET status = 'active' WHERE workflow_id = ? AND status = 'paused'").run(workflowId);
}

for (const event of TRIGGERS) {
  bus.on(event, (payload) => {
    const wfs = db.prepare('SELECT * FROM workflows WHERE active = 1').all().map(parse);
    for (const wf of wfs) if (triggerMatches(wf.trigger, event, payload)) enroll(wf.id, payload.contactId);
  });
}

module.exports = { TRIGGERS, STEP_TYPES, validate, enroll, processRun, tick, start, stop, resumePaused };
