/* Sales pipeline UI: Executive Summary, lead lists, one-page briefs, personas.
 * Loaded after app.js and reuses its helpers ($, esc, api, toast, opts, route…). */
'use strict';
let PMETA = null;
async function pmeta(force) { if (!PMETA || force) PMETA = await GET('/pipeline/meta'); return PMETA; }
const LIST_SHORT = { lead: 'New leads', switch: 'Switch prospects', chain: 'Chain & franchisee' };
const PRI_CLASS = { Hot: 'bad', Warm: 'warn', Watch: '' };
const money$ = n => n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 2 : 0).replace(/\.?0+$/, '')}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;
const fmtWeek = w => w ? new Date(w + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
const daysUntil = d => d ? Math.ceil((new Date(d + 'T23:59:59') - Date.now()) / 864e5) : null;
const priPill = p => `<span class="pill ${PRI_CLASS[p] || ''}">${esc(p)}</span>`;
const multiline = s => esc(s).replace(/\n/g, '<br>');

routes.unshift(
  [/^\/$/, execSummary, 'exec'],
  [/^\/pipeline$/, pipelineList, 'pipeline'],
  [/^\/pipeline\/(new|\d+)$/, opportunityBrief, 'pipeline'],
  [/^\/personas$/, personasView, 'personas'],
  [/^\/marketing$/, dashboard, 'dashboard'],
);

function importButton() {
  return `<label class="btn no-print">Import weekly file<input type="file" id="xlsx-import" accept=".xlsx" hidden></label>`;
}
function wireImport() {
  const el = $('#xlsx-import'); if (!el) return;
  el.onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    toast('Importing…');
    const r = await fetch('/api/pipeline/import', { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });
    const j = await r.json();
    if (!r.ok) return toast(j.error || 'Import failed', true);
    await pmeta(true);
    alert(`Imported week of ${fmtWeek(j.week)}\n\n• ${j.created} new businesses\n• ${j.updated} already tracked (rep updates kept)\n• ${j.drafts} outreach drafts, ${j.personas} personas` +
      (j.duplicates.length ? `\n\nSkipped (already on another list):\n- ${j.duplicates.join('\n- ')}` : '') +
      (j.unmatched_drafts.length ? `\n\nDrafts with no matching business:\n- ${j.unmatched_drafts.join('\n- ')}` : ''));
    location.hash = '#/?week=' + j.week; route();
  };
}

// ---------- Executive Summary ----------
async function execSummary(q) {
  const m = await pmeta();
  const s = await GET('/pipeline/summary' + (q.get('week') ? '?week=' + q.get('week') : ''));
  const t = s.tiles, rep = s.report;
  if (!s.weeks.length) {
    view.innerHTML = `<div class="head"><h1>Executive Summary</h1>${importButton()}</div>
      <div class="card empty">No pipeline data yet. Import a weekly lead file (.xlsx), or <a href="#/pipeline/new">add a lead</a> by hand.</div>`;
    return wireImport();
  }
  const focus = rep.focus.length ? rep.focus : s.suggested_focus;
  view.innerHTML = `
  <div class="head"><div><h1>Executive Summary — Sales Pipeline</h1><div class="muted">Leads file for week of ${fmtWeek(s.week)}</div></div>
    <div class="row no-print" style="flex:0 0 auto">
      <select id="week" style="width:auto">${s.weeks.map(w => `<option value="${w}" ${w === s.week ? 'selected' : ''}>Week of ${fmtWeek(w)}</option>`).join('')}</select>
      ${importButton()}<a class="btn" href="/api/pipeline/export.xlsx?week=${s.week}">Export to Excel</a><button class="btn" onclick="print()">Print</button></div></div>
  <div class="card headline"><b>Headline:</b> <span id="headline" contenteditable="true" class="editable" data-ph="Click to write this week's headline…">${esc(rep.headline)}</span></div>
  <h3 class="band">This week at a glance</h3>
  <div class="grid g4">
    ${[['New leads', t.new_leads, '#/pipeline?list=lead&week=' + s.week], ['Hot leads', t.hot_leads, '#/pipeline?list=lead&priority=Hot&week=' + s.week, 'hot'],
       ['Switch prospects', t.switch_prospects, '#/pipeline?list=switch&week=' + s.week], ['Chain accounts', t.chain_accounts, '#/pipeline?list=chain&week=' + s.week],
       ['Est. pipeline – new leads (low)', money$(t.pipeline_low)], ['Est. pipeline – new leads (high)', money$(t.pipeline_high)],
       ['Hot leads not yet assigned', t.hot_unassigned, '#/pipeline?list=lead&priority=Hot&rep=__none&week=' + s.week, t.hot_unassigned ? 'hot' : ''], ["Leads still at 'New'", t.still_new, '#/pipeline?list=lead&status=New&week=' + s.week]]
      .map(([l, n, href, cls]) => `<${href ? `a href="${href}"` : 'div'} class="card stat ${cls || ''}"><div class="n">${n}</div><div class="l">${l}</div></${href ? 'a' : 'div'}>`).join('')}
  </div>
  <p class="muted small">Pipeline figures add up the rough deal-size ranges on new leads (estimates, not quotes); chain accounts are longer-term and not included. Counts update as reps assign leads and change Status.</p>

  <h3 class="band">Where to focus this week (in order) ${rep.focus.length ? '' : '<span class="pill warn" style="font-weight:400">suggested — Hot items by deadline, then deal size</span>'}</h3>
  <div class="card"><table id="focus"><thead><tr><th>#</th><th>Action</th><th>Branch</th><th>Deadline</th><th>Est. deal</th><th>Why it matters</th><th class="no-print"></th></tr></thead><tbody>
    ${focus.map((f, i) => `<tr data-i="${i}"><td><b>${i + 1}</b></td>${['action', 'branch', 'deadline', 'deal', 'why'].map(k => `<td contenteditable="true" class="editable" data-k="${k}">${esc(f[k])}</td>`).join('')}
      <td class="no-print" style="white-space:nowrap">${f.id ? `<a class="btn sm" href="#/pipeline/${f.id}">Open</a>` : ''}<button class="btn sm danger" data-rm="${i}">✕</button></td></tr>`).join('')}
  </tbody></table>
  <div class="row no-print" style="margin-top:10px;justify-content:flex-start"><button class="btn sm auto" id="addfocus">+ Add focus item</button><button class="btn sm primary auto" id="savefocus">Save focus list</button>
  ${rep.focus.length ? '<button class="btn sm auto" id="resetfocus">Replace with suggestions</button>' : ''}</div></div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Pipeline by branch (new leads + switch prospects)</h2><table><tr><th>Branch</th><th>Leads</th><th>Hot</th><th>Switch</th><th>Est. low</th><th>Est. high</th></tr>
      ${s.branches.map(b => `<tr class="click" data-href="#/pipeline?branch=${encodeURIComponent(b.branch)}&week=${s.week}"><td><b>${esc(b.branch)}</b></td><td>${b.leads}</td><td>${b.hot}</td><td>${b.switch}</td><td>${money$(b.low)}</td><td>${money$(b.high)}</td></tr>`).join('')}</table>
      <p class="muted small">Multi-branch rows ("All branches") aren't counted in a single branch.</p></div>
    <div class="card"><h2>Hot this week</h2><table>${s.hot.map(h => `<tr class="click" data-href="#/pipeline/${h.id}"><td>${esc(h.business)}<div class="muted small">${LIST_SHORT[h.list_type]} · ${esc(h.branch)}</div></td>
      <td>${h.deadline ? `<span class="pill ${daysUntil(h.deadline) <= 7 ? 'bad' : 'warn'}">due ${esc(h.deadline.slice(5))}</span>` : ''}</td><td>${h.assigned_rep ? esc(h.assigned_rep) : '<span class="pill bad">unassigned</span>'}</td><td>${esc(h.status)}</td></tr>`).join('')}</table></div>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Bigger plays to start now (multi-month)</h2><div id="plays">${rep.plays.map((p, i) => `<div class="play" data-i="${i}"><b contenteditable="true" class="editable" data-k="title">${esc(p.title)}</b><div contenteditable="true" class="editable" data-k="detail">${esc(p.detail)}</div></div>`).join('') || '<div class="muted">None yet.</div>'}</div>
      <div class="row no-print" style="margin-top:8px;justify-content:flex-start"><button class="btn sm auto" id="addplay">+ Add</button></div></div>
    <div class="card"><h2>Risks, gaps and decisions needed</h2><ul id="risks" class="bullets">${rep.risks.map(r => `<li contenteditable="true" class="editable">${esc(r)}</li>`).join('') || ''}</ul>
      <div class="row no-print" style="margin-top:8px;justify-content:flex-start"><button class="btn sm auto" id="addrisk">+ Add</button></div></div>
  </div>
  <div class="row no-print" style="margin-top:12px;justify-content:flex-end"><button class="btn primary auto" id="savereport">Save headline, plays &amp; risks</button></div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Rep workload (all open opportunities)</h2><table><tr><th>Rep</th><th>Open</th><th>Hot</th><th>Est. pipeline</th></tr>
      ${s.reps.map(r => `<tr class="click" data-href="#/pipeline?open=true&rep=${encodeURIComponent(r.rep === '(unassigned)' ? '__none' : r.rep)}"><td>${esc(r.rep)}</td><td>${r.open}</td><td>${r.hot}</td><td>${money$(r.low)}–${money$(r.high)}</td></tr>`).join('')}</table>
      <p class="muted small">All weeks: ${s.totals.open} open, ${s.totals.won} won · open pipeline ${money$(s.totals.open_low)}–${money$(s.totals.open_high)} (excl. chains)</p></div>
    <div class="card funnel"><h2>Status (all weeks)</h2>${s.status_funnel.map(f => `<div class="r"><span class="lbl">${esc(f.status)}</span><div class="bar" style="width:${Math.max(f.n / Math.max(1, ...s.status_funnel.map(x => x.n)) * 70, .5)}%"></div><b>${f.n}</b></div>`).join('')}</div>
  </div>
  ${rep.sources.length ? `<div class="card" style="margin-top:16px"><h2>Where these leads come from</h2><table><tr><th>Source</th><th>Reachable?</th><th>Notes</th></tr>${rep.sources.map(x => `<tr><td>${esc(x.source)}</td><td>${esc(x.reachable)}</td><td class="small">${esc(x.notes)}</td></tr>`).join('')}</table></div>` : ''}`;

  wireImport();
  $('#week').onchange = e => location.hash = '#/?week=' + e.target.value;
  const readFocus = () => $$('#focus tbody tr').map(tr => Object.fromEntries($$('[data-k]', tr).map(td => [td.dataset.k, td.innerText.trim()]))).filter(f => f.action);
  const saveFocus = async focusList => { await PUT('/pipeline/reports/' + s.week, { focus: focusList }); toast('Focus list saved'); route(); };
  $('#savefocus').onclick = () => saveFocus(readFocus());
  $('#addfocus').onclick = () => { const f = readFocus(); f.push({ action: 'New action', branch: '', deadline: '', deal: '', why: '' }); saveFocus(f); };
  if ($('#resetfocus')) $('#resetfocus').onclick = () => confirm('Replace the written focus list with automatic suggestions?') && saveFocus([]);
  $$('[data-rm]').forEach(b => b.onclick = () => { const f = readFocus(); f.splice(Number(b.dataset.rm), 1); saveFocus(f); });
  const readReport = () => ({
    headline: $('#headline').innerText.trim(),
    plays: $$('#plays .play').map(p => ({ title: $('[data-k=title]', p).innerText.trim(), detail: $('[data-k=detail]', p).innerText.trim() })).filter(p => p.title),
    risks: $$('#risks li').map(li => li.innerText.trim()).filter(Boolean),
  });
  $('#savereport').onclick = async () => { await PUT('/pipeline/reports/' + s.week, readReport()); toast('Saved'); };
  $('#headline').onblur = () => PUT('/pipeline/reports/' + s.week, { headline: $('#headline').innerText.trim() });
  $('#addplay').onclick = async () => { const r = readReport(); r.plays.push({ title: 'New play', detail: 'Describe it' }); await PUT('/pipeline/reports/' + s.week, r); route(); };
  $('#addrisk').onclick = async () => { const r = readReport(); r.risks.push('New risk or decision'); await PUT('/pipeline/reports/' + s.week, r); route(); };
}

// ---------- Lead lists ----------
async function pipelineList(q) {
  const m = await pmeta();
  const params = new URLSearchParams(q);
  const listType = q.get('list') || '';
  if (!q.has('open') && !q.has('week') && !listType) params.set('open', 'true');
  const rows = await GET('/opportunities?' + params.toString().replace(/(^|&)list=/, '$1list_type='));
  const link = (k, v) => { const p = new URLSearchParams(q); v ? p.set(k, v) : p.delete(k); return '#/pipeline?' + p; };
  const repList = `<datalist id="reps">${m.reps.map(r => `<option value="${esc(r)}">`).join('')}</datalist>`;
  view.innerHTML = `${repList}
  <div class="head"><h1>Pipeline</h1><div class="row" style="flex:0 0 auto">${importButton()}
    <a class="btn" href="/api/pipeline/export.xlsx?${q.get('week') ? 'week=' + q.get('week') : 'scope=open'}">Export to Excel</a><a class="btn primary" href="#/pipeline/new">+ Add lead</a></div></div>
  <div class="tabs">${[['', 'All'], ['lead', "This Week's Leads"], ['switch', 'Switch Prospects'], ['chain', 'Chain & Franchisee']].map(([k, l]) => `<a href="${link('list', k)}" class="${listType === k ? 'active' : ''}">${l}</a>`).join('')}</div>
  <div class="card">
    <form class="row" id="pf" style="margin-bottom:12px">
      <input name="q" placeholder="Search business, location, rep…" value="${esc(q.get('q'))}">
      <select name="priority" class="auto" style="width:110px"><option value="">Priority</option>${opts(m.priorities, q.get('priority'))}</select>
      <select name="branch" class="auto" style="width:130px"><option value="">Branch</option>${opts(m.branches, q.get('branch'))}</select>
      <select name="status" class="auto" style="width:130px"><option value="">Status</option>${opts(m.statuses, q.get('status'))}</select>
      <select name="rep" class="auto" style="width:140px"><option value="">Any rep</option><option value="__none" ${q.get('rep') === '__none' ? 'selected' : ''}>Unassigned</option>${opts(m.reps, q.get('rep'))}</select>
      <select name="week" class="auto" style="width:150px"><option value="">All weeks</option>${m.weeks.map(w => `<option value="${w}" ${w === q.get('week') ? 'selected' : ''}>Week of ${fmtWeek(w)}</option>`).join('')}</select>
      <label class="auto small"><input type="checkbox" name="open" value="true" style="width:auto" ${params.get('open') === 'true' ? 'checked' : ''}> Open only</label>
      <button class="btn auto">Filter</button>
    </form>
    ${rows.length ? `<div style="overflow-x:auto"><table class="opps"><thead><tr><th>Priority</th><th>Business</th><th>Branch</th><th>Stage</th><th>Est. deal</th><th>Timeline</th><th class="gold">Assigned rep</th><th class="gold">Status</th></tr></thead><tbody>
      ${rows.map(o => `<tr class="click pri-${o.priority}" data-href="#/pipeline/${o.id}">
        <td>${priPill(o.priority)}${!listType ? `<div class="muted small">${LIST_SHORT[o.list_type]}</div>` : ''}</td>
        <td><b>${esc(o.business)}</b><div class="muted small">${esc(o.location)}</div></td><td>${esc(o.branch)}</td><td class="small">${esc(o.stage)}</td>
        <td class="small">${esc((o.deal_size || '').split(' (')[0])}</td>
        <td class="small">${o.deadline ? `<span class="pill ${daysUntil(o.deadline) <= 7 ? 'bad' : 'warn'}">${daysUntil(o.deadline) < 0 ? 'past due' : 'due in ' + daysUntil(o.deadline) + 'd'}</span> ` : ''}${esc(o.decision_timeline || '')}</td>
        <td><input list="reps" class="inline" data-id="${o.id}" data-f="assigned_rep" value="${esc(o.assigned_rep)}" placeholder="assign…"></td>
        <td><select class="inline" data-id="${o.id}" data-f="status">${opts(m.statuses, o.status)}</select></td></tr>`).join('')}
    </tbody></table></div><p class="muted small">${rows.length} shown. Assigned rep and Status save as soon as you change them.</p>`
    : '<div class="empty">Nothing matches these filters.</div>'}
  </div>`;
  wireImport();
  $('#pf').onsubmit = e => {
    e.preventDefault();
    const p = new URLSearchParams(); if (listType) p.set('list', listType);
    for (const [k, v] of new FormData(e.target)) if (v) p.set(k, v);
    if (!p.has('open')) p.set('open', 'false');
    location.hash = '#/pipeline?' + p;
  };
  $$('.inline').forEach(el => el.onchange = async () => {
    try { await PATCH('/opportunities/' + el.dataset.id, { [el.dataset.f]: el.value }); toast('Saved'); if (el.dataset.f === 'assigned_rep') pmeta(true); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------- One-page brief ----------
const FIELD_GROUPS = [
  ['Basics', ['business', 'location', 'branch', 'stage', 'deal_size', 'decision_timeline', 'target_list', 'persona', 'rebate_flag']],
  ["What's happening", ['whats_happening', 'objection', 'hooks']],
  ['Contacts', ['how_to_reach', 'backup_contacts']],
  ['Next step & source', ['next_step', 'source', 'source_date']],
];
async function opportunityBrief(id) {
  const m = await pmeta();
  const isNew = id === 'new';
  const o = isNew ? { list_type: 'lead', priority: 'Warm', status: 'New', personas: [], activity: [] } : await GET('/opportunities/' + id);
  const label = k => m.columns.find(c => c.key === k)?.label || k;
  const long = k => ['whats_happening', 'objection', 'hooks', 'backup_contacts', 'next_step'].includes(k);
  const field = k => `<div class="field"><label class="f">${esc(label(k))}</label>${long(k) ? `<textarea data-e="${k}">${esc(o[k])}</textarea>` : `<input data-e="${k}" value="${esc(o[k])}">`}</div>`;
  const editor = `
    <div class="grid g2">
      <div class="field"><label class="f">List</label><select data-e="list_type">${opts(Object.keys(m.list_types), o.list_type, m.list_types)}</select></div>
      <div class="field"><label class="f">Hard deadline (bid close / order-by date)</label><input type="date" data-e="deadline" value="${esc(o.deadline || '')}"></div>
      <div class="field"><label class="f">Est. low $ (auto from deal size)</label><input type="number" data-e="deal_low" value="${o.deal_low ?? ''}"></div>
      <div class="field"><label class="f">Est. high $</label><input type="number" data-e="deal_high" value="${o.deal_high ?? ''}"></div>
    </div>
    ${FIELD_GROUPS.map(([g, keys]) => `<h2 style="margin-top:12px">${g}</h2><div class="grid g2">${keys.map(field).join('')}</div>`).join('')}
    <h2 style="margin-top:12px">Outreach email</h2><div class="grid g2">${['outreach_to', 'outreach_channel'].map(k => `<div class="field"><label class="f">${k === 'outreach_to' ? 'To' : 'Channel'}</label><input data-e="${k}" value="${esc(o[k])}"></div>`).join('')}</div>
    <div class="field"><label class="f">Subject</label><input data-e="outreach_subject" value="${esc(o.outreach_subject)}"></div>
    <div class="field"><label class="f">Body</label><textarea data-e="outreach_body" class="code" style="min-height:220px">${esc(o.outreach_body)}</textarea></div>`;

  if (isNew) {
    view.innerHTML = `<div class="head"><div><a href="#/pipeline" class="muted">← Pipeline</a><h1>Add a lead</h1></div><button class="btn primary" id="save">Save</button></div>
    <div class="card"><div class="grid g2"><div class="field"><label class="f">Priority</label><select data-e="priority">${opts(m.priorities, 'Warm')}</select></div>
      <div class="field"><label class="f">Assigned rep</label><input data-e="assigned_rep" list="reps"></div></div>${editor}</div><datalist id="reps">${m.reps.map(r => `<option value="${esc(r)}">`).join('')}</datalist>`;
    $('#save').onclick = async () => {
      try { const r = await POST('/opportunities', collect()); location.hash = '#/pipeline/' + r.id; } catch (err) { toast(err.message, true); }
    };
    return;
  }

  const sec = (t, body, cls = '') => body ? `<div class="brief-sec ${cls}"><h3>${t}</h3>${body}</div>` : '';
  const kv = pairs => `<table class="kv">${pairs.filter(([, v]) => v).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${multiline(v)}</td></tr>`).join('')}</table>`;
  const dl = daysUntil(o.deadline);
  view.innerHTML = `<datalist id="reps">${m.reps.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
  <div class="head no-print"><a href="#/pipeline?list=${o.list_type}" class="muted">← ${esc(m.list_types[o.list_type])}</a>
    <div class="row" style="flex:0 0 auto"><button class="btn" onclick="print()">Print brief</button><button class="btn" id="toggle-edit">Edit all fields</button><button class="btn danger" id="del">Delete</button></div></div>
  <div class="card brief">
    <div class="brief-title"><div><h1>${esc(o.business)}</h1><div class="muted">${esc(o.location)} • Branch: ${esc(o.branch)} • ${esc(m.list_types[o.list_type])} • first seen week of ${fmtWeek(o.first_seen_week)}${o.last_seen_week !== o.first_seen_week ? `, last seen ${fmtWeek(o.last_seen_week)}` : ''}</div></div>
      <span class="pill ${PRI_CLASS[o.priority]}" style="font-size:15px;padding:4px 12px">${esc(o.priority.toUpperCase())} ${o.list_type === 'switch' ? 'SWITCH PROSPECT' : o.list_type === 'chain' ? 'ACCOUNT' : 'LEAD'}</span></div>
    <div class="row quick">
      <label>Assigned rep<input list="reps" data-q="assigned_rep" value="${esc(o.assigned_rep)}" placeholder="[unassigned]"></label>
      <label>Status<select data-q="status">${opts(m.statuses, o.status)}</select></label>
      <label>Priority<select data-q="priority">${opts(m.priorities, o.priority)}</select></label>
      ${o.deadline ? `<label>Deadline<div class="pill ${dl <= 7 ? 'bad' : 'warn'}" style="font-size:14px;padding:6px 10px">${esc(o.deadline)} (${dl < 0 ? 'past' : dl + ' days'})</div></label>` : ''}
    </div>
    ${sec('Snapshot', kv([['Stage', o.stage], ['Est. deal size', o.deal_size], ['Decision timeline', o.decision_timeline], ['Target list', o.target_list], ['Persona', o.persona], ['Rebate flag', o.rebate_flag]]))}
    ${sec("What's happening", `<p>${multiline(o.whats_happening)}</p>`)}
    ${sec("Who you're talking to – persona quick read", (o.personas.map(p => kv([['Persona', p.name], ['What they care about', p.cares_about], ['Message that works', p.message], ['Best channels', p.channels], ['Go-to materials', p.materials]])).join('<hr>') || '') + kv([['Likely objection → response', o.objection]]))}
    ${sec('Conversation starters', o.hooks ? `<p>${multiline(o.hooks)}</p>` : '')}
    ${sec('Contacts', kv([['First try', o.how_to_reach], ['Backups (in order)', (o.backup_contacts || '').replace(/\s(\d\))/g, '\n$1')]]))}
    <div class="brief-sec gold-sec"><h3>Relationship intel <span style="font-weight:400;opacity:.9;text-transform:none">(rep to confirm — saves automatically)</span></h3>
      ${['current_supplier', 'mutual_connections', 'curtis_relationship'].map(k => `<div class="field"><label class="f">${esc(label(k))}</label><textarea data-q="${k}" style="min-height:52px">${esc(o[k])}</textarea></div>`).join('')}</div>
    ${sec('Next steps', `<ul class="checks">${[o.next_step, 'Check NetSuite/AutoQuotes for an existing account', 'Send the outreach email below, personalized', 'Log the contact and update Status'].filter(Boolean).map(t => `<li>☐ ${esc(t)}</li>`).join('')}</ul>`)}
    ${o.outreach_body ? sec('Outreach email', `${kv([['To', o.outreach_to], ['Channel', o.outreach_channel], ['Subject', o.outreach_subject]])}<pre class="email-body" id="email-body">${esc(o.outreach_body)}</pre>
      <div class="row no-print" style="justify-content:flex-start"><button class="btn sm auto" id="copy-email">Copy email</button>${/@/.test(o.outreach_to) ? `<a class="btn sm auto" href="mailto:${encodeURIComponent((o.outreach_to.match(/[\w.+-]+@[\w.-]+/) || [''])[0])}?subject=${encodeURIComponent(o.outreach_subject)}&body=${encodeURIComponent(o.outreach_body)}">Open in mail app</a>` : ''}</div>`) : ''}
    ${sec('Source', o.source ? `<p class="small">${/^https?:\/\//.test(o.source) ? `<a href="${esc(o.source)}" target="_blank" rel="noopener">${esc(o.source)}</a>` : esc(o.source)}${o.source_date ? ` (published ${esc(o.source_date)})` : ''}</p>` : '')}
  </div>
  <div class="card no-print hidden" id="editor" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Edit all fields</h2><button class="btn primary auto" id="save">Save changes</button></div>${editor}</div>
  <div class="card no-print" style="margin-top:16px"><h2>Activity & notes</h2>
    <div class="row" style="margin-bottom:10px"><textarea id="note" placeholder="Log a call, visit or email…" style="min-height:56px"></textarea><button class="btn auto" id="addnote">Add note</button></div>
    <ul class="timeline">${o.activity.map(a => `<li><span class="t">${fmt(a.created_at)}</span><span class="${a.type === 'note' ? 'note' : ''}">${esc(a.summary)}</span></li>`).join('')}</ul></div>`;

  $$('[data-q]').forEach(el => el.onchange = async () => {
    try { await PATCH('/opportunities/' + id, { [el.dataset.q]: el.value }); toast('Saved'); if (['priority', 'status'].includes(el.dataset.q)) route(); }
    catch (err) { toast(err.message, true); }
  });
  $('#toggle-edit').onclick = () => { $('#editor').classList.toggle('hidden'); $('#editor').scrollIntoView({ behavior: 'smooth' }); };
  $('#save').onclick = async () => { try { await PATCH('/opportunities/' + id, collect()); toast('Saved'); route(); } catch (err) { toast(err.message, true); } };
  $('#del').onclick = async () => { if (confirm(`Delete ${o.business}?`)) { await DEL('/opportunities/' + id); location.hash = '#/pipeline'; } };
  $('#addnote').onclick = async () => { const t = $('#note').value.trim(); if (!t) return; await POST(`/opportunities/${id}/notes`, { text: t }); route(); };
  if ($('#copy-email')) $('#copy-email').onclick = async () => {
    await navigator.clipboard.writeText(`To: ${o.outreach_to}\nSubject: ${o.outreach_subject}\n\n${o.outreach_body}`).then(() => toast('Copied'), () => toast('Copy failed — select the text manually', true));
  };
}
function collect() {
  const out = {};
  $$('[data-e]').forEach(el => { out[el.dataset.e] = el.value; });
  if (out.deal_low === '') delete out.deal_low;
  if (out.deal_high === '') delete out.deal_high;
  return out;
}

// ---------- Personas ----------
async function personasView() {
  const ps = await GET('/personas');
  const F = [['titles', 'Typical titles'], ['description', "What they're like"], ['cares_about', 'What they care about'], ['objections', 'Common objections'], ['message', 'Message that works'], ['channels', 'Best channels'], ['materials', 'Go-to materials']];
  view.innerHTML = `<div class="head"><div><h1>Personas</h1><div class="muted">Match the message, channel and materials to the persona named on each lead.</div></div><button class="btn primary" id="addp">+ Add persona</button></div>
  <div class="grid g2">${ps.map(p => `<div class="card persona" data-id="${p.id}">
    <div class="row"><input data-p="name" value="${esc(p.name)}" style="font-weight:700;font-size:15px"><button class="btn sm danger auto" data-del="${p.id}">✕</button></div>
    ${F.map(([k, l]) => `<div class="field"><label class="f">${l}</label><textarea data-p="${k}" style="min-height:48px">${esc(p[k])}</textarea></div>`).join('')}
    <button class="btn sm" data-save>Save</button></div>`).join('') || '<div class="card empty">No personas yet — they come in with an imported weekly file, or add one.</div>'}</div>`;
  const save = async card => { const body = {}; $$('[data-p]', card).forEach(el => body[el.dataset.p] = el.value); await POST('/personas', body); toast('Saved'); };
  $$('[data-save]').forEach(b => b.onclick = () => save(b.closest('.persona')));
  $$('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete persona?')) { await DEL('/personas/' + b.dataset.del); route(); } });
  $('#addp').onclick = async () => { const name = prompt('Persona name'); if (name) { await POST('/personas', { name }); route(); } };
}
