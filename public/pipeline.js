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
// "Assigned branch" control: a dropdown for admins/managers, plain text for reps. The person shows underneath.
const canMoveLeads = () => ME && ['admin', 'operator', 'manager'].includes(ME.role);
// "Already a customer" / "Not interested": close the lead; the weekly scan then leaves it alone.
const CLOSE_OUTCOMES = [['Already a customer', '✓ Customer', 'Already a customer: we\'ll stop tracking it as a lead'], ['Not interested', '✕ Not interested', 'Not interested: the weekly scan will skip it']];
function closeButtons(o) {
  if (['Won', 'Lost', 'Not a fit', 'Already a customer', 'Not interested'].includes(o.status)) return '';
  return `<div class="close-btns no-print">${CLOSE_OUTCOMES.map(([st, label, title]) => `<button class="btn sm" data-close-id="${o.id}" data-close-status="${esc(st)}" title="${esc(title)}">${label}</button>`).join('')}</div>`;
}
function wireCloseButtons(root, onDone) {
  $$('[data-close-id]', root).forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const st = btn.dataset.closeStatus;
    if (!confirm(`Mark this lead "${st}"? It will drop off the open lists, and the weekly scan will skip it. You can change the status back later.`)) return;
    try { const o = await PATCH('/opportunities/' + btn.dataset.closeId, { status: st }); toast(`Marked "${st}". The weekly scan will skip it.`); onDone && onDone(o); }
    catch (err) { toast(err.message, true); }
  });
}
function currentBranchOf(o, m) {
  const t = String(o.branch || '').toLowerCase();
  const direct = m.branches.find(b => t.startsWith(b.toLowerCase()));
  if (direct) return direct;
  const merged = Object.keys(m.branch_merges || {}).find(f => t.startsWith(f.toLowerCase()));
  return merged ? m.branch_merges[merged] : '';
}
function branchCell(o, m) {
  const cur = currentBranchOf(o, m);
  const who = `<div class="muted small">→ ${o.assigned_rep ? esc(o.assigned_rep) : '<span class="pill bad">no one yet</span>'}</div>`;
  if (!canMoveLeads()) return `<div class="small"><b>${esc(cur || o.branch || '—')}</b></div>${who}`;
  return `<select class="inline branch-move" data-move-id="${o.id}">
    ${cur ? '' : `<option value="" selected>${esc(o.branch || 'No branch')}</option>`}
    ${m.branches.map(b => `<option value="${esc(b)}" ${b === cur ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>${who}`;
}
function wireBranchMoves(root, onMoved) {
  $$('.branch-move', root).forEach(sel => sel.onchange = async () => {
    try {
      const o = await POST(`/opportunities/${sel.dataset.moveId}/branch`, { branch: sel.value });
      toast(`Moved to ${sel.value}${o.assigned_rep ? ` (${o.assigned_rep})` : ''}`);
      onMoved && onMoved(o);
    } catch (err) { toast(err.message, true); }
  });
}

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

// One row of the "Where to focus" table. Linked rows show live prospect details; general rows are free text.
function focusRow(f, i, n) {
  const ed = (k, val, ph) => `<td contenteditable="true" class="editable" data-k="${k}" data-ph="${esc(ph || '')}">${esc(val || '')}</td>`;
  const o = f.opp;
  const moves = `<button class="btn sm" data-move="-1" data-i="${i}" ${i ? '' : 'disabled'} title="Move up">↑</button><button class="btn sm" data-move="1" data-i="${i}" ${i < n - 1 ? '' : 'disabled'} title="Move down">↓</button><button class="btn sm danger" data-rm="${i}" title="Remove">✕</button>`;
  if (o) {
    const derived = o.deadline ? fmtShortDate(o.deadline) : (o.decision_timeline || '');
    return `<tr data-i="${i}" data-opp="${o.id}"><td><b>${i + 1}</b></td>
      <td class="prospect">${priPill(o.priority)} <a href="#/pipeline/${o.id}"><b>${esc(o.business)}</b></a><div class="muted small">${LIST_SHORT[o.list_type] || ''}</div></td>
      ${ed('action', f.action, 'What to do')}
      <td class="small">${esc(o.branch)}</td>
      <td class="small">${o.deadline ? `<span class="pill ${daysUntil(o.deadline) <= 7 ? 'bad' : 'warn'}">${esc(fmtShortDate(o.deadline))}</span>` : ''}<div contenteditable="true" class="editable" data-k="note" data-ph="${esc(o.deadline ? 'add a do-by note' : derived || 'add a date')}">${esc(f.note)}</div></td>
      <td class="small">${esc((o.deal_size || '').split(' (')[0])}</td>
      <td class="small">${o.assigned_rep ? esc(o.assigned_rep) : '<span class="pill bad">unassigned</span>'}<div class="muted">${esc(o.status)}</div></td>
      ${ed('why', f.why, 'Why it matters')}
      <td class="no-print" style="white-space:nowrap">${moves}</td></tr>`;
  }
  if (f.opps && f.opps.length > 1) {
    // One item that names several leads: show each lead, with a one-click split into separate items.
    return `<tr data-i="${i}" data-group="${f.opps.map(x => x.id).join(',')}"><td><b>${i + 1}</b></td>
      <td class="prospect">${f.opps.map(x => `<div class="grp-opp">${priPill(x.priority)} <a href="#/pipeline/${x.id}"><b>${esc(x.business.split(/\s[–(]/)[0])}</b></a>
        <div class="muted small">${x.assigned_rep ? esc(x.assigned_rep) : '<span class="pill bad">unassigned</span>'} · ${esc(x.status)}${x.deadline ? ` · <span class="pill ${daysUntil(x.deadline) <= 7 ? 'bad' : 'warn'}">${esc(fmtShortDate(x.deadline))}</span>` : ''}</div></div>`).join('')}
        <button class="btn sm no-print" data-split="${i}" title="Make one focus item per lead">Split into ${f.opps.length} items</button></td>
      ${ed('action', f.action, 'What to do')}${ed('branch', f.branch, 'Branch')}
      <td class="small"><div contenteditable="true" class="editable" data-k="note" data-ph="add a date">${esc(f.note ?? f.deadline)}</div></td>
      <td class="small muted">${f.opps.length} leads</td><td class="small muted">see each lead</td>${ed('why', f.why, 'Why it matters')}
      <td class="no-print" style="white-space:nowrap">${moves}</td></tr>`;
  }
  return `<tr data-i="${i}"><td><b>${i + 1}</b></td>
    <td class="prospect"><span class="pill">General</span> <button class="btn sm no-print link-toggle" data-linktoggle="${i}" title="Link this item to a prospect">＋ Link</button><input class="no-print link-in hidden" list="focus-opps" data-link="${i}" placeholder="Type a business…"></td>
    ${ed('action', f.action, 'What to do')}${ed('branch', f.branch, 'Branch')}
    <td class="small"><div contenteditable="true" class="editable" data-k="note" data-ph="add a date">${esc(f.note ?? f.deadline)}</div></td>
    ${ed('deal', f.deal, '—')}<td class="small muted">—</td>${ed('why', f.why, 'Why it matters')}
    <td class="no-print" style="white-space:nowrap">${moves}</td></tr>`;
}
const fmtShortDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------- Executive Summary ----------
async function execSummary(q) {
  if (ME && ME.role === 'manager' && ME.branch) return location.replace('#/branch/' + encodeURIComponent(ME.branch));
  const m = await pmeta();
  const [s, openOpps] = await Promise.all([GET('/pipeline/summary' + (q.get('week') ? '?week=' + q.get('week') : '')), GET('/opportunities?open=true')]);
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

  <h3 class="band">Where to focus this week (in order) ${rep.focus.length ? '' : '<span class="pill warn" style="font-weight:400;font-family:var(--sans);letter-spacing:0;text-transform:none">suggested — Hot prospects by deadline, then deal size</span>'}</h3>
  <div class="card"><table id="focus" class="focus"><thead><tr><th>#</th><th>Prospect</th><th>Action</th><th>Branch</th><th>Deadline</th><th>Est. deal</th><th>Owner · status</th><th>Why it matters</th><th class="no-print"></th></tr></thead><tbody>
    ${focus.map((f, i) => focusRow(f, i, focus.length)).join('') || '<tr><td colspan="9" class="muted">Nothing on the focus list yet.</td></tr>'}
  </tbody></table>
  <div class="row no-print focus-add">
    <input id="focus-pick" list="focus-opps" placeholder="Add a prospect to the focus list — start typing a business…">
    <button class="btn sm primary auto" id="addfocus-opp">Add prospect</button>
    <button class="btn sm auto" id="addfocus-general">+ General item</button>
    ${rep.focus.length ? '<button class="btn sm auto" id="resetfocus">Replace with suggestions</button>' : ''}
    <span class="muted small auto">Edits save automatically.</span>
  </div>
  <datalist id="focus-opps">${openOpps.map(o => `<option value="${esc(o.business)}">${esc(o.priority)} · ${esc(o.branch)}</option>`).join('')}</datalist>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Pipeline by branch (new leads + switch prospects)</h2><table><tr><th>Branch</th><th>Leads</th><th>Hot</th><th>Switch</th><th>Est. low</th><th>Est. high</th></tr>
      ${s.branches.map(b => `<tr class="click" data-href="#/branch/${encodeURIComponent(b.branch)}?week=${s.week}" title="Open the ${esc(b.branch)} branch page"><td><b>${esc(b.branch)}</b></td><td>${b.leads}</td><td>${b.hot}</td><td>${b.switch}</td><td>${money$(b.low)}</td><td>${money$(b.high)}</td></tr>`).join('')}</table>
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
  // Focus list: rows carry their prospect id; branch, deal, owner and status come from the prospect.
  const readFocus = () => $$('#focus tbody tr[data-i]').map(tr => {
    const v = k => ($(`[data-k=${k}]`, tr)?.innerText || '').trim();
    const item = { action: v('action'), why: v('why'), deadline: v('note') };
    if (tr.dataset.opp) item.opportunity_id = Number(tr.dataset.opp); else { item.branch = v('branch'); item.deal = v('deal'); }
    return item;
  });
  const saveFocus = async (list, { quiet } = {}) => {
    await PUT('/pipeline/reports/' + s.week, { focus: list });
    toast(rep.focus.length ? 'Focus list saved' : "Saved — this week's focus list is now yours to edit");
    if (!quiet || !rep.focus.length) route();
  };
  $$('#focus [contenteditable]').forEach(el => {
    el.dataset.orig = el.innerText.trim();
    el.onblur = () => { if (el.innerText.trim() !== el.dataset.orig) { el.dataset.orig = el.innerText.trim(); saveFocus(readFocus(), { quiet: true }); } };
    el.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); } };
  });
  $$('[data-move]').forEach(b => b.onclick = () => {
    const f = readFocus(), i = Number(b.dataset.i), j = i + Number(b.dataset.move);
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]]; saveFocus(f);
  });
  $$('[data-rm]').forEach(b => b.onclick = () => { const f = readFocus(); f.splice(Number(b.dataset.rm), 1); saveFocus(f); });
  $$('[data-link]').forEach(inp => inp.onchange = () => {
    const o = openOpps.find(x => x.business === inp.value.trim());
    if (!o) return toast('Pick a prospect from the list', true);
    const f = readFocus(), i = Number(inp.dataset.link);
    f[i] = { opportunity_id: o.id, action: f[i].action, why: f[i].why, deadline: f[i].deadline };
    saveFocus(f);
  });
  $$('[data-linktoggle]').forEach(b => b.onclick = () => { const inp = $(`[data-link="${b.dataset.linktoggle}"]`); inp.classList.remove('hidden'); b.classList.add('hidden'); inp.focus(); });
  $$('[data-split]').forEach(b => b.onclick = () => {
    const f = readFocus(), i = Number(b.dataset.split);
    const row = $(`#focus tbody tr[data-i="${i}"]`);
    const ids = row.dataset.group.split(',').map(Number);
    const items = ids.map(id => { const o = openOpps.find(x => x.id === id); return { opportunity_id: id, action: (o && o.next_step) || f[i].action, why: f[i].why }; });
    f.splice(i, 1, ...items);
    saveFocus(f);
  });
  $('#addfocus-opp').onclick = () => {
    const name = $('#focus-pick').value.trim();
    const o = openOpps.find(x => x.business === name);
    if (!o) return toast('Pick a prospect from the list', true);
    const f = readFocus();
    if (f.some(x => x.opportunity_id === o.id)) return toast(`${o.business} is already on the list`, true);
    f.push({ opportunity_id: o.id, action: o.next_step || 'Make first contact', why: o.stage || '' });
    saveFocus(f);
  };
  $('#focus-pick').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#addfocus-opp').click(); } };
  $('#addfocus-general').onclick = () => { const f = readFocus(); f.push({ action: 'New action', branch: '', deal: '', why: '' }); saveFocus(f); };
  if ($('#resetfocus')) $('#resetfocus').onclick = () => confirm('Replace the written focus list with automatic suggestions?') && saveFocus([]);
  const readReport = () => ({
    headline: $('#headline').innerText.trim(),
    plays: $$('#plays .play').map(p => ({ title: $('[data-k=title]', p).innerText.trim(), detail: $('[data-k=detail]', p).innerText.trim() })).filter(p => p.title),
    risks: $$('#risks li').map(li => li.innerText.trim()).filter(Boolean),
  });
  $('#savereport').onclick = async () => { await PUT('/pipeline/reports/' + s.week, readReport()); toast('Saved'); };
  $('#headline').onblur = () => { const h = $('#headline').innerText.trim(); if (h !== (rep.headline || '')) PUT('/pipeline/reports/' + s.week, { headline: h }); };
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
  <div class="head"><h1>Pipeline</h1><div class="row" style="flex:0 0 auto">
    <a class="btn" href="/api/pipeline/export.xlsx?${q.get('week') ? 'week=' + q.get('week') : 'scope=open'}">Export to Excel</a></div></div>
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
    ${rows.length ? `<div style="overflow-x:auto"><table class="opps"><thead><tr><th>Priority</th><th>Business</th><th>Stage</th><th>Est. deal</th><th>Timeline</th><th class="gold">Assigned branch</th><th class="gold">Status</th></tr></thead><tbody>
      ${rows.map(o => `<tr class="click pri-${o.priority}" data-href="#/pipeline/${o.id}">
        <td>${priPill(o.priority)}${!listType ? `<div class="muted small">${LIST_SHORT[o.list_type]}</div>` : ''}</td>
        <td><b>${esc(o.business)}</b><div class="muted small">${esc(o.location)}${o.branch && !m.branches.some(b => o.branch === b) ? ` · ${esc(o.branch)}` : ''}</div></td><td class="small">${esc(o.stage)}</td>
        <td class="small">${esc((o.deal_size || '').split(' (')[0])}</td>
        <td class="small">${o.deadline ? `<span class="pill ${daysUntil(o.deadline) <= 7 ? 'bad' : 'warn'}">${daysUntil(o.deadline) < 0 ? 'past due' : 'due in ' + daysUntil(o.deadline) + 'd'}</span> ` : ''}${esc(o.decision_timeline || '')}</td>
        <td>${branchCell(o, m)}</td>
        <td><select class="inline" data-id="${o.id}" data-f="status">${opts(m.statuses, o.status)}</select>${closeButtons(o)}</td></tr>`).join('')}
    </tbody></table></div><p class="muted small">${rows.length} shown. ${canMoveLeads() ? 'Assigned branch and ' : ''}Status save${canMoveLeads() ? '' : 's'} as soon as you change them. Moving a lead to another branch hands it to that branch's owner.</p>`
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
  $$('.inline:not(.branch-move)').forEach(el => el.onchange = async () => {
    try { await PATCH('/opportunities/' + el.dataset.id, { [el.dataset.f]: el.value }); toast('Saved'); if (el.dataset.f === 'assigned_rep') pmeta(true); }
    catch (err) { toast(err.message, true); }
  });
  wireBranchMoves(view, () => route());
  wireCloseButtons(view, () => route());
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
    <div class="row" style="flex:0 0 auto">${ME && ME.role === 'manager' ? '' : `<button class="btn" id="add-focus">★ Add to this week's focus</button>`}<button class="btn" onclick="print()">Print brief</button><button class="btn" id="toggle-edit">Edit all fields</button><button class="btn danger" id="del">Delete</button></div></div>
  <div class="card brief">
    <div class="brief-title"><div><h1>${esc(o.business)}</h1><div class="muted">${esc(o.location)} • Branch: ${esc(o.branch)} • ${esc(m.list_types[o.list_type])} • first seen week of ${fmtWeek(o.first_seen_week)}${o.last_seen_week !== o.first_seen_week ? `, last seen ${fmtWeek(o.last_seen_week)}` : ''}</div></div>
      <span class="pill ${PRI_CLASS[o.priority]}" style="font-size:15px;padding:4px 12px">${esc(o.priority.toUpperCase())} ${o.list_type === 'switch' ? 'SWITCH PROSPECT' : o.list_type === 'chain' ? 'ACCOUNT' : 'LEAD'}</span></div>
    <div class="row quick">
      <label>Assigned branch<div class="qb">${branchCell(o, m)}</div></label>
      ${closeButtons(o) ? `<label>Close out${closeButtons(o)}</label>` : ''}
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
  <div class="card no-print" id="lead-tasks" style="margin-top:16px"></div>
  <div class="card no-print" style="margin-top:16px"><h2>Activity & notes</h2>
    <div class="row" style="margin-bottom:10px"><textarea id="note" placeholder="Log a call, visit or email…" style="min-height:56px"></textarea><button class="btn auto" id="addnote">Add note</button></div>
    <ul class="timeline">${o.activity.map(a => `<li><span class="t">${fmt(a.created_at)}</span><span class="${a.type === 'note' ? 'note' : ''}">${a.user_name ? `<b>${esc(a.user_name)}:</b> ` : ''}${esc(a.summary)}</span></li>`).join('')}</ul></div>`;

  wireBranchMoves(view, () => route());
  wireCloseButtons(view, () => route());
  $$('[data-q]').forEach(el => el.onchange = async () => {
    try { await PATCH('/opportunities/' + id, { [el.dataset.q]: el.value }); toast('Saved'); if (['priority', 'status'].includes(el.dataset.q)) route(); }
    catch (err) { toast(err.message, true); }
  });
  if (typeof renderLeadTasks === 'function') renderLeadTasks($('#lead-tasks'), o);
  if ($('#add-focus')) $('#add-focus').onclick = async () => {
    const week = m.weeks[0] || m.current_week;
    try { await POST(`/pipeline/reports/${week}/focus`, { opportunity_id: o.id }); toast(`Added to the focus list for the week of ${fmtWeek(week)}`); }
    catch (err) { toast(err.message, true); }
  };
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
