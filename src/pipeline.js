// Sales pipeline: prospect businesses surfaced by the weekly lead scan
// (This Week's Leads / Switch Prospects / Chain & Franchisee Accounts),
// rep follow-up, and the live numbers behind the Executive Summary.
const { db, parse, getSettings } = require('./db');

const LIST_TYPES = { lead: "This Week's Leads", switch: 'Switch Prospects', chain: 'Chain & Franchisee Accounts' };
const PRIORITIES = ['Hot', 'Warm', 'Watch'];
const STATUSES = ['New', 'Contacted', 'Meeting set', 'Quoted', 'Won', 'Lost', 'Not a fit', 'Already a customer', 'Not interested'];
// Leads marked with these are left alone by the weekly scan: no updates, never re-added.
const SKIP_STATUSES = ['Already a customer', 'Not interested'];
const CLOSED = ['Won', 'Lost', 'Not a fit', ...SKIP_STATUSES];
const CLOSED_SQL = `(${CLOSED.map(s => `'${s}'`).join(',')})`;

// The 23 spreadsheet columns, in order. `rep: true` = gold "rep to confirm/complete" column.
const COLUMNS = [
  ['priority', 'Priority'], ['branch', 'Branch'], ['business', 'Business'], ['location', 'Location'], ['stage', 'Stage'],
  ['whats_happening', "What's happening"], ['deal_size', 'Est. deal size'], ['decision_timeline', 'Decision timeline'],
  ['target_list', 'Target list'], ['persona', 'Persona'], ['objection', 'Likely objection → response'],
  ['hooks', 'Hooks (conversation starters)'], ['rebate_flag', 'Rebate flag'], ['how_to_reach', 'How to reach (first try)'],
  ['backup_contacts', "Backup contacts (if you can't reach them)"], ['current_supplier', 'Who they currently buy from', true],
  ['mutual_connections', 'Mutual connections', true], ['curtis_relationship', 'Existing relationship with Curtis', true],
  ['next_step', 'Next step'], ['source', 'Source'], ['source_date', 'Source date'], ['assigned_rep', 'Assigned rep', true],
  ['status', 'Status', true],
].map(([key, label, rep]) => ({ key, label, rep: !!rep }));
const REP_FIELDS = COLUMNS.filter(c => c.rep).map(c => c.key);
const EDITABLE = [...COLUMNS.map(c => c.key), 'list_type', 'deal_low', 'deal_high', 'deadline',
  'outreach_to', 'outreach_channel', 'outreach_subject', 'outreach_body'];

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

// "Papa Murphy's – 3 Bend stores (ownership change)" and "Papa Murphy's – Bend stores
// (new franchisee)" are the same business: compare on the name before any dash/parenthesis.
function businessKey(name) {
  return String(name || '').split(/\s[–—-]\s|\s?\(/)[0].toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

// "$250K–$500K (…)" → [250000, 500000]; "$5K–$25K/yr" → [5000, 25000]; "$0 now" → [0, 0];
// "Varies" → [null, null]. Uses the first dollar range in the text.
function parseDeal(text) {
  const nums = [];
  const re = /\$\s?([\d,.]+)\s*([KkMm])?/g;
  let m;
  while ((m = re.exec(String(text || ''))) && nums.length < 2) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (/k/i.test(m[2] || '')) n *= 1e3;
    if (/m/i.test(m[2] || '')) n *= 1e6;
    // "$1M–$2M" style ranges: second number inherits nothing; each carries its own unit.
    nums.push(Math.round(n));
    // Only treat as a range if the next $ follows within a few characters ("–", "to").
    const rest = String(text).slice(re.lastIndex, re.lastIndex + 6);
    if (!/^\s*(–|—|-|to)\s*\$/.test(rest)) break;
  }
  if (!nums.length) return [null, null];
  return [nums[0], nums[1] ?? nums[0]];
}

// Branch matching mirrors the spreadsheet's COUNTIF("Boise*") prefix rule.
// Merged branches (settings.branch_merges, e.g. { Portland: 'Springfield' }) keep their own name in the
// lead's Branch text but count toward the branch they were merged into.
function branchAliases(branch) {
  const merges = getSettings().branch_merges || {};
  return [branch, ...Object.entries(merges).filter(([, to]) => to === branch).map(([from]) => from)];
}
function primaryBranch(branchText) {
  const { branches } = getSettings();
  const merges = getSettings().branch_merges || {};
  const t = String(branchText || '').toLowerCase();
  const direct = branches.find(b => t.startsWith(b.toLowerCase()));
  if (direct) return direct;
  const merged = Object.keys(merges).find(from => t.startsWith(from.toLowerCase()));
  return merged ? merges[merged] : null;
}

function mondayOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function get(id) { return parse(db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id)); }

// ---------- Branch owners: new and unassigned leads go to whoever owns the branch ----------
function branchOwner(branchText) {
  const b = primaryBranch(branchText);
  return (b && (getSettings().branch_owners || {})[b]) || '';
}
function autoAssign(id, actor) {
  const o = get(id);
  if (!o || o.assigned_rep) return false;
  const owner = branchOwner(o.branch);
  if (!owner) return false;
  db.prepare("UPDATE opportunities SET assigned_rep = ?, updated_at = datetime('now') WHERE id = ?").run(owner, id);
  log(id, 'assign', `Assigned to ${owner} (${primaryBranch(o.branch)} branch owner)`, actor && !/^scan |^manual$/.test(actor) ? actor : null);
  return true;
}
// Make someone the owner of a branch (used when a Branch Manager joins or is assigned). Leads that were
// sitting with the previous owner's placeholder or nobody move to the new manager.
function setBranchOwner(branch, name) {
  const owners = { ...(getSettings().branch_owners || {}) };
  const prev = owners[branch];
  owners[branch] = name;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('branch_owners', JSON.stringify(owners));
  // A first-name placeholder for this branch ("Kevin") hands its leads over to the manager.
  if (prev && prev !== name && !prev.includes(' ')) {
    const rows = db.prepare("SELECT id, branch FROM opportunities WHERE assigned_rep = ?").all(prev);
    for (const r of rows) if (primaryBranch(r.branch) === branch) {
      db.prepare("UPDATE opportunities SET assigned_rep = ? WHERE id = ?").run(name, r.id);
      log(r.id, 'assign', `Assigned to ${name} (${branch} branch manager)`);
    }
  }
  assignByBranch(name);
}

try { db.exec('ALTER TABLE opportunities ADD COLUMN branch_locked INTEGER DEFAULT 0'); } catch { /* exists */ }
// Move a lead to another branch: it goes to that branch's owner, and the weekly scan won't move it back.
function moveToBranch(id, branch, actor) {
  const o = get(id);
  if (!o) return null;
  const target = (getSettings().branches || []).find(b => b.toLowerCase() === String(branch || '').toLowerCase());
  if (!target) throw err('Pick one of the branches');
  const owner = (getSettings().branch_owners || {})[target] || '';
  const from = primaryBranch(o.branch) || o.branch || 'no branch';
  db.prepare("UPDATE opportunities SET branch = ?, assigned_rep = ?, branch_locked = 1, updated_at = datetime('now') WHERE id = ?").run(target, owner, id);
  if (from !== target) log(id, 'move', `Moved from ${from} to ${target}${owner ? ` (now with ${owner})` : ''}`, actor || null);
  return get(id);
}

// Apply branch owners to every open lead that has nobody yet. Returns counts per owner.
function assignByBranch(actor) {
  const out = {};
  for (const o of db.prepare(`SELECT id FROM opportunities WHERE (assigned_rep IS NULL OR assigned_rep = '') AND status NOT IN ${CLOSED_SQL}`).all()) {
    if (autoAssign(o.id, actor)) { const who = get(o.id).assigned_rep; out[who] = (out[who] || 0) + 1; }
  }
  return out;
}
// Owners are often set by first name before the person has an account ("John"). When John accepts his
// invite as "John Carter", his leads, tasks and branch-owner entries switch to the full name.
function claimPlaceholderName(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  if (!first || first.toLowerCase() === String(fullName).trim().toLowerCase()) return 0;
  const settings = getSettings();
  const owners = { ...(settings.branch_owners || {}) };
  let changed = false;
  for (const [b, n] of Object.entries(owners)) if (String(n).trim().toLowerCase() === first.toLowerCase()) { owners[b] = fullName; changed = true; }
  if (!changed) return 0;   // only claim names an admin set up as branch owners
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('branch_owners', JSON.stringify(owners));
  const n = db.prepare("UPDATE opportunities SET assigned_rep = ? WHERE lower(trim(assigned_rep)) = lower(?)").run(fullName, first).changes;
  try { db.prepare("UPDATE tasks SET assigned_to = ? WHERE lower(trim(assigned_to)) = lower(?)").run(fullName, first); } catch { /* tasks table not created yet */ }
  return n;
}
try { db.exec('ALTER TABLE opp_activities ADD COLUMN user_name TEXT'); } catch { /* column exists */ }
function log(id, type, summary, user = null) { db.prepare('INSERT INTO opp_activities (opportunity_id, type, summary, user_name) VALUES (?, ?, ?, ?)').run(id, type, summary, user); }

function clean(input) {
  const out = {};
  for (const k of EDITABLE) if (input[k] !== undefined) out[k] = input[k] === null ? null : (['deal_low', 'deal_high'].includes(k) ? (input[k] === '' ? null : Number(input[k])) : String(input[k]).trim());
  if (out.list_type !== undefined && !LIST_TYPES[out.list_type]) throw err('list_type must be lead, switch or chain');
  if (out.priority !== undefined && !PRIORITIES.includes(out.priority)) throw err(`Priority must be one of ${PRIORITIES.join(', ')}`);
  if (out.status !== undefined && !STATUSES.includes(out.status)) throw err(`Status must be one of ${STATUSES.join(', ')}`);
  if (out.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(out.deadline)) throw err('deadline must be YYYY-MM-DD');
  if (out.deadline === '') out.deadline = null;
  return out;
}

function create(input, { week, actor = 'manual' } = {}) {
  const data = clean(input);
  if (!data.business) throw err('Business name is required');
  const key = businessKey(data.business);
  const dupe = db.prepare('SELECT id, business, list_type FROM opportunities WHERE business_key = ?').get(key);
  if (dupe) throw Object.assign(err(`"${dupe.business}" is already on ${LIST_TYPES[dupe.list_type]} (each business appears on one list only)`, 409), { existing_id: dupe.id });
  if (data.deal_low === undefined && data.deal_size) [data.deal_low, data.deal_high] = parseDeal(data.deal_size);
  week = week || mondayOf();
  const row = { list_type: 'lead', priority: 'Warm', status: 'New', ...data, business_key: key, first_seen_week: week, last_seen_week: week };
  const cols = Object.keys(row);
  const info = db.prepare(`INSERT INTO opportunities (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c] ?? null));
  log(info.lastInsertRowid, 'created', `Added to ${LIST_TYPES[row.list_type]}${/^scan |^manual$/.test(actor) ? ` (${actor})` : ''}`, /^scan |^manual$/.test(actor) ? null : actor);
  if (!row.assigned_rep) autoAssign(Number(info.lastInsertRowid), actor);
  return get(info.lastInsertRowid);
}

function update(id, input, { actor = 'rep' } = {}) {
  const cur = get(id);
  if (!cur) return null;
  const data = clean(input);
  if (data.business && businessKey(data.business) !== cur.business_key) {
    const key = businessKey(data.business);
    const dupe = db.prepare('SELECT business FROM opportunities WHERE business_key = ? AND id != ?').get(key, id);
    if (dupe) throw err(`"${dupe.business}" already exists`, 409);
    data.business_key = key;
  }
  if (data.deal_size !== undefined && data.deal_low === undefined && data.deal_size !== cur.deal_size) [data.deal_low, data.deal_high] = parseDeal(data.deal_size);
  const changed = Object.keys(data).filter(k => (data[k] ?? '') !== (cur[k] ?? ''));
  const who = /^scan /.test(actor) ? null : actor;
  if (!changed.length) return cur;
  db.prepare(`UPDATE opportunities SET ${changed.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...changed.map(k => data[k] ?? null), id);
  for (const k of changed) {
    if (k === 'status') log(id, 'status', `Status: ${cur.status} → ${data.status}`, who);
    else if (k === 'assigned_rep') log(id, 'assign', data.assigned_rep ? `Assigned to ${data.assigned_rep}` : 'Unassigned', who);
    else if (k === 'priority') log(id, 'priority', `Priority: ${cur.priority} → ${data.priority}`, who);
    else if (k === 'list_type') log(id, 'move', `Moved to ${LIST_TYPES[data.list_type]}`, who);
  }
  const other = changed.filter(k => !['status', 'assigned_rep', 'priority', 'list_type', 'business_key'].includes(k));
  const NICE = { outreach_to: 'email recipient', outreach_channel: 'email channel', outreach_subject: 'email subject', outreach_body: 'email draft', deal_low: 'est. low $', deal_high: 'est. high $', deadline: 'deadline' };
  const names = [...new Set(other.map(k => NICE[k] || COLUMNS.find(c => c.key === k)?.label || k))];
  if (other.length) log(id, 'edit', `Updated ${names.join(', ')}${who ? '' : ` (${actor})`}`, who);
  return get(id);
}

// Weekly scan import: create new businesses, refresh scan-owned fields on ones we already
// track, and never overwrite what a rep has filled in (assigned rep, status, relationship intel).
function upsertFromScan(input, week) {
  const key = businessKey(input.business);
  const existing = parse(db.prepare('SELECT * FROM opportunities WHERE business_key = ?').get(key));
  if (!existing) return { action: 'created', row: create(input, { week, actor: `scan ${week}` }) };
  if (SKIP_STATUSES.includes(existing.status)) return { action: 'skipped', row: existing, note: `${existing.business} is marked "${existing.status}"` };
  if (existing.list_type !== (input.list_type || existing.list_type) && existing.last_seen_week === week) {
    return { action: 'duplicate', row: existing, note: `${input.business} is already on ${LIST_TYPES[existing.list_type]} this week` };
  }
  const data = { ...input };
  for (const f of REP_FIELDS) if (existing[f] && existing[f] !== 'New') delete data[f];
  if (existing.branch_locked) delete data.branch;   // a person moved it to another branch; keep that
  if (existing.status && existing.status !== 'New') delete data.status;
  for (const k of ['outreach_to', 'outreach_subject', 'outreach_body', 'outreach_channel']) if (!data[k]) delete data[k];
  const row = update(existing.id, data, { actor: `scan ${week}` });
  if (!get(existing.id).assigned_rep) autoAssign(existing.id, `scan ${week}`);
  if (week > existing.last_seen_week) db.prepare('UPDATE opportunities SET last_seen_week = ? WHERE id = ?').run(week, existing.id);
  return { action: 'updated', row: get(existing.id) };
}

function list({ list_type, priority, branch, status, rep, week, q, open } = {}) {
  const where = [], vals = [];
  if (list_type) { where.push('list_type = ?'); vals.push(list_type); }
  if (priority) { where.push('priority = ?'); vals.push(priority); }
  if (branch) {
    const names = branchAliases(branch);
    where.push(`(${names.map(() => 'branch LIKE ?').join(' OR ')})`); vals.push(...names.map(n => `${n}%`));
  }
  if (status) { where.push('status = ?'); vals.push(status); }
  if (rep === '__none') where.push("(assigned_rep IS NULL OR assigned_rep = '')");
  else if (rep) { where.push('assigned_rep = ?'); vals.push(rep); }
  if (week) { where.push('last_seen_week = ?'); vals.push(week); }
  if (open === 'true' || open === true) where.push(`status NOT IN (${CLOSED.map(() => '?').join(',')})`), vals.push(...CLOSED);
  if (q) { where.push('(business LIKE ? OR location LIKE ? OR whats_happening LIKE ? OR assigned_rep LIKE ?)'); vals.push(...Array(4).fill(`%${q}%`)); }
  return db.prepare(`SELECT * FROM opportunities ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE priority WHEN 'Hot' THEN 0 WHEN 'Warm' THEN 1 ELSE 2 END, id`).all(...vals).map(parse);
}

function weeks() {
  return db.prepare('SELECT DISTINCT last_seen_week w FROM opportunities UNION SELECT week_of FROM weekly_reports ORDER BY w DESC').all().map(r => r.w);
}

function getReport(week) {
  return parse(db.prepare('SELECT * FROM weekly_reports WHERE week_of = ?').get(week)) ||
    { week_of: week, headline: '', focus: [], plays: [], risks: [], sources: [], source: null };
}
// ---------- Focus list: each item points at a prospect when it's about one ----------
// Stored item: { opportunity_id?, action, why, deadline } — linked items take branch/deal/priority/rep/status
// live from the prospect; general items (no prospect) keep their own branch and deal text.
function resolveFocus(items) {
  return items.map(f => {
    f = f || {};
    let id = f.opportunity_id ? Number(f.opportunity_id) : null;
    if (!id && f.business) id = db.prepare('SELECT id FROM opportunities WHERE business_key = ?').get(businessKey(f.business))?.id || null;
    if (id && !db.prepare('SELECT 1 FROM opportunities WHERE id = ?').get(id)) id = null;
    const out = { action: String(f.action || '').trim(), why: String(f.why || '').trim(), deadline: String(f.deadline || '').trim() };
    if (id) out.opportunity_id = id;
    else { out.branch = String(f.branch || '').trim(); out.deal = String(f.deal || '').trim(); }
    return out;
  }).filter(f => f.action || f.opportunity_id);
}

// Older focus items (imported from a spreadsheet) are plain text. Link them when the text names exactly
// one tracked business: its full name, or a distinctive first word ("Corbett SD …" → Corbett School District).
function autoLink(text, opps) {
  const t = ' ' + businessKey(String(text || '').split(':')[0]) + ' ';
  if (t.trim().length < 3) return null;
  let hits = opps.filter(o => o.business_key && t.includes(' ' + o.business_key + ' '));
  if (!hits.length) {
    hits = opps.filter(o => { const w = o.business_key.split(' ')[0]; return w.length >= 5 && t.includes(' ' + w + ' '); });
    // the first word must also be unique among tracked businesses
    hits = hits.filter(o => opps.filter(x => x.business_key.split(' ')[0] === o.business_key.split(' ')[0]).length === 1);
  }
  return hits.length === 1 ? hits[0].id : null;
}

// Place names and generic words that must never count as a business name on their own.
const STOP = new Set(['city', 'the', 'new', 'old', 'portland', 'salem', 'keizer', 'eugene', 'springfield', 'medford', 'boise', 'bend', 'redmond',
  'meridian', 'nampa', 'caldwell', 'eagle', 'ashland', 'grants', 'grants pass', 'sisters', 'sunriver', 'idaho', 'oregon', 'school', 'district',
  'public', 'restaurant', 'restaurants', 'kitchen', 'cafe', 'bar', 'grill', 'senior', 'living', 'state', 'county', 'national', 'every', 'open']);
// All tracked businesses named anywhere in a piece of text: by full name, or by a distinctive first one or two
// words when no other tracked business starts the same way ("Handel's", "Glisan Station", "UN/COMMON").
function mentions(text, opps) {
  const t = ' ' + businessKey(String(text || '').replace(/[()]/g, ' ')) + ' ';
  const hits = [];
  for (const o of opps) {
    const words = (o.business_key || '').split(' ').filter(Boolean);
    if (!words.length) continue;
    const cands = [words.join(' ')];
    const two = words.slice(0, 2).join(' '), one = words[0];
    // A short form only counts if no other tracked business uses those words anywhere in its name.
    const uniq = pre => opps.filter(x => (' ' + x.business_key + ' ').includes(' ' + pre + ' ')).length === 1;
    if (words.length > 2 && two.replace(' ', '').length >= 6 && !STOP.has(two) && uniq(two)) cands.push(two);
    if (words.length > 1 && one.length >= 5 && !STOP.has(one) && uniq(one)) cands.push(one);
    let at = -1;
    for (const c of cands) { const i = t.indexOf(' ' + c + ' '); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at >= 0) hits.push({ o, at });
  }
  return hits.sort((a, b) => a.at - b.at).map(h => h.o);
}

function shortDeadline(o) {
  if (o.deadline) return new Date(o.deadline + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return o.decision_timeline || '';
}

function enrichFocus(items) {
  const opps = db.prepare('SELECT * FROM opportunities').all();
  const byId = Object.fromEntries(opps.map(o => [o.id, o]));
  return (items || []).map(f => {
    let id = f.opportunity_id && byId[f.opportunity_id] ? f.opportunity_id : autoLink(f.action, opps);
    if (!id && !f.opportunity_id) {
      const named = mentions(f.action, opps);
      if (named.length === 1) id = named[0].id;
      else if (named.length > 1) {
        const mini = o => ({ id: o.id, business: o.business, priority: o.priority, status: o.status, assigned_rep: o.assigned_rep, list_type: o.list_type, branch: o.branch, deal_size: o.deal_size, deadline: o.deadline, next_step: o.next_step });
        return { ...f, note: f.deadline || '', opportunity_id: null, opp: null, opps: named.map(mini), label: f.action };
      }
    }
    const o = id ? byId[id] : null;
    if (!o) return { ...f, note: f.deadline || '', opportunity_id: null, opp: null, opps: [], label: f.action };
    const action = f.action || o.next_step || 'Make first contact';
    // Spreadsheet text often starts with the business name; don't repeat it next to the prospect link.
    const stripped = action.includes(':') && autoLink(action.split(':')[0], [o]) === o.id ? action.slice(action.indexOf(':') + 1).trim() : action;
    return {
      ...f, note: f.deadline || '', opportunity_id: o.id, opps: [], action: stripped,
      label: `${o.business.split(/\s[–(]/)[0]}: ${stripped}`,
      branch: o.branch, deal: (o.deal_size || '').split(' (')[0], deadline: f.deadline || shortDeadline(o),
      opp: { id: o.id, business: o.business, priority: o.priority, status: o.status, assigned_rep: o.assigned_rep, list_type: o.list_type, branch: o.branch, deal_size: o.deal_size, deadline: o.deadline, decision_timeline: o.decision_timeline },
    };
  });
}

// source: 'manual' (edited in the app), 'import' (from a weekly .xlsx) or 'scan' (automated research).
function saveReport(week, input, { source = 'manual' } = {}) {
  const cur = getReport(week);
  const r = { ...cur, ...input };
  for (const k of ['focus', 'plays', 'risks', 'sources']) if (!Array.isArray(r[k])) throw err(`${k} must be a list`);
  if (input.focus) r.focus = resolveFocus(input.focus);
  db.prepare(`INSERT INTO weekly_reports (week_of, headline, focus, plays, risks, sources, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(week_of) DO UPDATE SET headline = excluded.headline, focus = excluded.focus, plays = excluded.plays,
    risks = excluded.risks, sources = excluded.sources, source = excluded.source, updated_at = excluded.updated_at`)
    .run(week, String(r.headline || ''), JSON.stringify(r.focus), JSON.stringify(r.plays), JSON.stringify(r.risks), JSON.stringify(r.sources), source);
  return getReport(week);
}

// Everything the Executive Summary shows, computed the same way as the spreadsheet formulas.
function summary(week) {
  week = week || weeks()[0] || mondayOf();
  const rows = list({ week });
  const by = t => rows.filter(r => r.list_type === t);
  const leads = by('lead'), sw = by('switch'), chains = by('chain');
  const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
  const { branches } = getSettings();
  const branchRows = branches.map(b => {
    const inB = r => primaryBranch(r.branch) === b;
    const nonChain = rows.filter(r => r.list_type !== 'chain' && inB(r));
    return {
      branch: b, leads: leads.filter(inB).length, hot: leads.filter(r => inB(r) && r.priority === 'Hot').length,
      switch: sw.filter(inB).length, low: sum(nonChain, 'deal_low'), high: sum(nonChain, 'deal_high'),
    };
  });
  // Suggested focus when nobody has written one: Hot, still-open items, nearest hard deadline first, then biggest deal.
  const suggested = rows.filter(r => r.priority === 'Hot' && !CLOSED.includes(r.status) && r.list_type !== 'chain')
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || (b.deal_high || 0) - (a.deal_high || 0)).slice(0, 6)
    .map(r => ({ opportunity_id: r.id, action: r.next_step || 'Make first contact', why: r.stage }));
  const all = db.prepare('SELECT status, list_type, deal_low, deal_high, assigned_rep, priority FROM opportunities').all();
  const openAll = all.filter(r => !CLOSED.includes(r.status));
  const reps = {};
  for (const r of openAll) { const k = r.assigned_rep || '(unassigned)'; reps[k] = reps[k] || { rep: k, open: 0, hot: 0, low: 0, high: 0 }; reps[k].open++; if (r.priority === 'Hot') reps[k].hot++; if (r.list_type !== 'chain') { reps[k].low += r.deal_low || 0; reps[k].high += r.deal_high || 0; } }
  return {
    week,
    weeks: weeks(),
    tiles: {
      new_leads: leads.length, hot_leads: leads.filter(r => r.priority === 'Hot').length, switch_prospects: sw.length, chain_accounts: chains.length,
      pipeline_low: sum(leads, 'deal_low'), pipeline_high: sum(leads, 'deal_high'),
      hot_unassigned: leads.filter(r => r.priority === 'Hot' && !r.assigned_rep).length,
      still_new: leads.filter(r => r.status === 'New').length,
    },
    branches: branchRows,
    status_funnel: STATUSES.map(s => ({ status: s, n: all.filter(r => r.status === s).length })),
    reps: Object.values(reps).sort((a, b) => b.hot - a.hot || b.open - a.open),
    totals: { open: openAll.length, won: all.filter(r => r.status === 'Won').length, open_low: sum(openAll.filter(r => r.list_type !== 'chain'), 'deal_low'), open_high: sum(openAll.filter(r => r.list_type !== 'chain'), 'deal_high') },
    hot: rows.filter(r => r.priority === 'Hot').map(r => ({ id: r.id, business: r.business, list_type: r.list_type, branch: r.branch, assigned_rep: r.assigned_rep, status: r.status, deal_size: r.deal_size, deadline: r.deadline })),
    suggested_focus: enrichFocus(suggested),
    report: (r => ({ ...r, focus: enrichFocus(r.focus) }))(getReport(week)),
  };
}

// Personas
function personas() { return db.prepare('SELECT * FROM personas ORDER BY id').all(); }
function upsertPersona(p) {
  if (!p.name || !String(p.name).trim()) throw err('Persona name is required');
  const f = ['titles', 'description', 'cares_about', 'objections', 'message', 'channels', 'materials'];
  db.prepare(`INSERT INTO personas (name, ${f.join(', ')}) VALUES (?, ${f.map(() => '?').join(', ')})
    ON CONFLICT(name) DO UPDATE SET ${f.map(k => `${k} = excluded.${k}`).join(', ')}`).run(String(p.name).trim(), ...f.map(k => String(p[k] || '')));
  return db.prepare('SELECT * FROM personas WHERE name = ?').get(String(p.name).trim());
}
// "Franchisee; Multi-Unit Ops Director (construction…)" → matching persona records.
function personasFor(text) {
  const all = personas();
  return String(text || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(part => all.find(p => part.toLowerCase().startsWith(p.name.toLowerCase()))).filter(Boolean)
    .filter((p, i, arr) => arr.indexOf(p) === i);
}

function activity(id) { return db.prepare('SELECT * FROM opp_activities WHERE opportunity_id = ? ORDER BY id DESC').all(id); }

module.exports = {
  CLOSED, CLOSED_SQL, SKIP_STATUSES,
  LIST_TYPES, PRIORITIES, STATUSES, COLUMNS, REP_FIELDS, businessKey, parseDeal, primaryBranch, mondayOf,
  get, create, update, upsertFromScan, list, weeks, summary, getReport, saveReport, enrichFocus, autoLink, mentions, branchOwner, autoAssign, assignByBranch, claimPlaceholderName, branchAliases, setBranchOwner, moveToBranch, personas, upsertPersona, personasFor, activity, log,
};
