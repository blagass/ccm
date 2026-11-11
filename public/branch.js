/* Branch executive pages (#/branch/Boise): the high-level picture for one branch. */
'use strict';
routes.unshift(
  [/^\/branch$/, branchHome, 'branch'],
  [/^\/branch\/([\w-]+)$/, branchView, 'branch'],
);

// "Branches" in the sidebar opens your own branch if you own one, otherwise the first.
async function branchHome() {
  const m = await pmeta(true);
  location.replace('#/branch/' + encodeURIComponent(m.my_branches[0] || m.branches[0]));
}

async function branchView(name, q) {
  const m = await pmeta();
  const today = ymd(new Date());
  const params = new URLSearchParams({ today });
  if (q.get('week')) params.set('week', q.get('week'));
  const b = await GET(`/branches/${encodeURIComponent(name)}?${params}`);
  const t = b.tiles;
  const tab = q.get('tab') || 'open';
  const isClosed = o => ['Won', 'Lost', 'Not a fit', 'Already a customer', 'Not interested'].includes(o.status);
  const tabs = {
    open: ['Open', o => !isClosed(o)],
    hot: ['Hot', o => o.priority === 'Hot' && !isClosed(o)],
    new: ['New this week', o => o.first_seen_week === b.week],
    switch: ['Switch prospects', o => o.list_type === 'switch' && !isClosed(o)],
    chain: ['Chain & franchise', o => o.list_type === 'chain' && !isClosed(o)],
    closed: ['Closed', isClosed],
  };
  const leads = b.leads.filter(tabs[tab]?.[1] || tabs.open[1]);
  const link = (k, v) => { const p = new URLSearchParams(q); p.set(k, v); return `#/branch/${encodeURIComponent(b.branch)}?${p}`; };
  const short = s => esc(String(s || '').split(/\s[–(]/)[0]);
  const focus = b.focus.length ? b.focus : b.suggested_focus;
  const dayLabel = d => d === today ? 'Today' : fromYmd(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const reps = `<datalist id="reps">${m.reps.map(r => `<option value="${esc(r)}">`).join('')}</datalist>`;

  view.innerHTML = `${reps}
  <div class="branch-tabs no-print">${(m.only_branch ? [m.only_branch] : m.branches).map(x => `<a href="#/branch/${encodeURIComponent(x)}${q.get('week') ? '?week=' + q.get('week') : ''}" class="${x === b.branch ? 'on' : ''}">${esc(x)}${m.my_branches.includes(x) ? ' <span class="mine">★</span>' : ''}</a>`).join('')}</div>
  <div class="head"><div><h1>${esc(b.branch)} Branch${b.includes.length ? ` <span class="incl">incl. ${b.includes.map(esc).join(', ')}</span>` : ''}</h1>
      <div class="muted">${b.owner ? `Branch owner: <b>${esc(b.owner)}</b>` : '<span class="pill warn">No branch owner yet</span> <a href="#/settings">set one in Settings</a>'} · Week of ${fmtWeek(b.week)}</div></div>
    <div class="row no-print" style="flex:0 0 auto">
      <select id="bweek" style="width:auto">${b.weeks.map(w => `<option value="${w}" ${w === b.week ? 'selected' : ''}>Week of ${fmtWeek(w)}</option>`).join('')}</select>
      <a class="btn" href="#/pipeline?branch=${encodeURIComponent(b.branch)}&open=true">Open in Pipeline</a><button class="btn" onclick="print()">Print</button></div></div>

  <div class="no-print branch-glance">
  <h3 class="band">${esc(b.branch)} at a glance</h3>
  <div class="grid g4">
    ${[['Open leads', t.open, link('tab', 'open')], ['Hot', t.hot, link('tab', 'hot'), t.hot ? 'hot' : ''], ['New this week', t.new_this_week, link('tab', 'new')], ['Est. pipeline (open)', `${money$(t.pipeline_low)}–${money$(t.pipeline_high)}`]].map(tile).join('')}
    ${[['Hot with no rep', t.hot_unassigned, `#/pipeline?branch=${encodeURIComponent(b.branch)}&priority=Hot&rep=__none&open=true`, t.hot_unassigned ? 'hot' : ''], ["Still at 'New'", t.still_new, `#/pipeline?branch=${encodeURIComponent(b.branch)}&status=New&open=true`], ['Deadlines, next 14 days', t.deadlines_14d], ['Won / lost', `${t.won} / ${t.lost}`, link('tab', 'closed')]].map(tile).join('')}
  </div>
  <p class="muted small">Pipeline adds up rough deal-size ranges on open leads in this branch (chain accounts excluded). Shared rows such as "Boise / Bend" count on both branch pages.${b.company_wide_open ? ` ${b.company_wide_open} company-wide accounts ("All branches") are on the <a href="#/pipeline?open=true">Pipeline</a>.` : ''}</p>
  </div>

  <div class="grid g2" style="margin-top:8px">
    <div class="card"><h2>${b.focus.length ? `This week's focus for ${esc(b.branch)}` : `Suggested focus for ${esc(b.branch)}`}</h2>
      ${focus.length ? `<ol class="bfocus">${focus.map(f => `<li>${f.opp
        ? `${priPill(f.opp.priority)} <a href="#/pipeline/${f.opp.id}"><b>${short(f.opp.business)}</b></a>: ${esc(f.action)}<div class="muted small">${f.opp.assigned_rep ? esc(f.opp.assigned_rep) : '<span class="pill bad">unassigned</span>'} · ${esc(f.opp.status)}${f.deadline ? ' · ' + esc(f.deadline) : ''}</div>`
        : f.opps && f.opps.length ? `${esc(f.action)}<div class="small">${f.opps.map(o => `${priPill(o.priority)} <a href="#/pipeline/${o.id}">${short(o.business)}</a>`).join(' ')}</div>`
        : `<span class="pill">General</span> ${esc(f.action)}`}</li>`).join('')}</ol>`
        : '<div class="muted">No Hot leads in this branch right now.</div>'}
      ${b.focus.length ? '' : '<p class="muted small">Nothing on the company focus list for this branch this week, so these are its Hot leads by deadline, then size.</p>'}
    </div>
    <div class="card"><h2>Coming up (next 3 weeks)</h2>
      ${b.overdue.length ? `<div class="agenda-h bad" style="margin-top:0">Overdue (${b.overdue.length})</div><ul class="plain">${b.overdue.map(x => `<li><span class="pill bad">${esc(dayLabel(x.due_date))}</span> ${esc(x.title)}${x.business ? ` · <a href="#/pipeline/${x.opportunity_id}">${short(x.business)}</a>` : ''}</li>`).join('')}</ul>` : ''}
      ${b.upcoming.length ? `<ul class="plain upcoming">${b.upcoming.map(u => `<li><span class="when">${esc(dayLabel(u.date))}</span>
          ${u.kind === 'deadline' ? `<span class="chip deadline pri-${esc(u.priority)}" style="display:inline-block">⏰ Deadline</span> <a href="#/pipeline/${u.opportunity_id}">${esc(u.title)}</a>${u.assigned_rep ? '' : ' <span class="pill bad">unassigned</span>'}`
          : u.kind === 'task' ? `<span class="chip task" style="display:inline-block">☐ Task</span> ${esc(u.title)}${u.business ? ` · <a href="#/pipeline/${u.opportunity_id}">${short(u.business)}</a>` : ''}${u.assigned_to ? ` <span class="muted small">(${esc(u.assigned_to)})</span>` : ''}`
          : `<span class="chip scan" style="display:inline-block">↻</span> <span class="muted">${esc(u.title)}</span>`}</li>`).join('')}</ul>` : '<div class="muted">Nothing scheduled.</div>'}
      <a class="btn sm no-print" href="#/calendar?mine=0" style="margin-top:10px">Open the calendar</a>
    </div>
  </div>

  <h3 class="band">${esc(b.branch)} leads</h3>
  <div class="card print-flow">
    <div class="tabs no-print" style="margin-top:-6px">${Object.entries(tabs).map(([k, [label, fn]]) => `<a href="${link('tab', k)}" data-btab="${k}" class="${k === tab ? 'active' : ''}">${label} (${b.leads.filter(fn).length})</a>`).join('')}</div>
    <div id="branch-leads">${leadsTable(leads)}</div>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Who's working what</h2>${b.reps.length ? `<table><tr><th>Rep</th><th>Open</th><th>Hot</th><th>Still New</th><th>Est. pipeline</th></tr>
      ${b.reps.map(r => `<tr class="click" data-href="#/pipeline?branch=${encodeURIComponent(b.branch)}&open=true&rep=${encodeURIComponent(r.rep === '(unassigned)' ? '__none' : r.rep)}"><td>${r.rep === '(unassigned)' ? '<span class="pill bad">unassigned</span>' : esc(r.rep)}</td><td>${r.open}</td><td>${r.hot}</td><td>${r.new}</td><td>${money$(r.low)}–${money$(r.high)}</td></tr>`).join('')}</table>` : '<div class="muted">No open leads.</div>'}</div>
    <div class="card funnel"><h2>Status</h2>${b.status_funnel.map(f => `<div class="r"><span class="lbl">${esc(f.status)}</span><div class="bar" style="width:${Math.max(f.n / Math.max(1, ...b.status_funnel.map(x => x.n)) * 70, .5)}%"></div><b>${f.n}</b></div>`).join('')}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Recent activity</h2>
    ${b.activity.length ? `<ul class="timeline">${b.activity.map(a => `<li><span class="t">${fmt(a.created_at)}</span><span><a href="#/pipeline/${a.opportunity_id}">${short(a.business)}</a>: ${a.user_name ? `<b>${esc(a.user_name)}:</b> ` : ''}${esc(a.summary)}</span></li>`).join('')}</ul>` : '<div class="muted">No activity yet.</div>'}</div>`;

  // Switching tabs only redraws the table and updates the address, so the page doesn't jump.
  $$('[data-btab]').forEach(el => el.onclick = e => {
    e.preventDefault();
    const k = el.dataset.btab;
    $$('[data-btab]').forEach(x => x.classList.toggle('active', x === el));
    $('#branch-leads').innerHTML = leadsTable(b.leads.filter(tabs[k][1]));
    history.replaceState(null, '', link('tab', k));
    wireInline();
  });
  $$('.side a').forEach(a => a.classList.toggle('active', a.dataset.nav === 'branch'));
  $('#bweek').onchange = e => location.hash = link('week', e.target.value);
  function wireInline() {
    // Moving a lead out of this branch takes it off this page.
    wireBranchMoves($('#branch-leads'), moved => {
      const i = b.leads.findIndex(x => x.id === moved.id);
      if (i >= 0) { if (currentBranchOf(moved, m) === b.branch) b.leads[i] = moved; else b.leads.splice(i, 1); }
      const active = $('[data-btab].active')?.dataset.btab || 'open';
      $('#branch-leads').innerHTML = leadsTable(b.leads.filter(tabs[active][1]));
      $$('[data-btab]').forEach(x => { const [label, fn] = tabs[x.dataset.btab]; x.textContent = `${label} (${b.leads.filter(fn).length})`; });
      wireInline();
    });
    wireCloseButtons($('#branch-leads'), closed => {
      const o = b.leads.find(x => x.id === closed.id); if (o) o.status = closed.status;
      const active = $('[data-btab].active')?.dataset.btab || 'open';
      $('#branch-leads').innerHTML = leadsTable(b.leads.filter(tabs[active][1]));
      $$('[data-btab]').forEach(x => { const [label, fn] = tabs[x.dataset.btab]; x.textContent = `${label} (${b.leads.filter(fn).length})`; });
      wireInline();
    });
    $$('#branch-leads .inline:not(.branch-move)').forEach(el => el.onchange = async () => {
      try {
        await PATCH('/opportunities/' + el.dataset.id, { [el.dataset.f]: el.value });
        const o = b.leads.find(x => x.id === Number(el.dataset.id)); if (o) o[el.dataset.f] = el.value;   // keep tab counts honest
        toast('Saved');
      } catch (err) { toast(err.message, true); }
    });
  }
  wireInline();

  function leadsTable(list) {
    return list.length ? `<div style="overflow-x:auto"><table class="opps"><thead><tr><th>Priority</th><th>Business</th><th>Stage</th><th>Est. deal</th><th>Timeline</th><th class="gold">Assigned branch</th><th class="gold">Status</th></tr></thead><tbody>
      ${list.map(o => `<tr class="click pri-${o.priority}" data-href="#/pipeline/${o.id}">
        <td>${priPill(o.priority)}<div class="muted small">${LIST_SHORT[o.list_type]}</div></td>
        <td><b>${esc(o.business)}</b><div class="muted small">${esc(o.location)}${o.branch !== b.branch ? ` · ${esc(o.branch)}` : ''}</div></td>
        <td class="small">${esc(o.stage)}</td><td class="small">${esc((o.deal_size || '').split(' (')[0])}</td>
        <td class="small">${o.deadline ? `<span class="pill ${daysUntil(o.deadline) <= 7 ? 'bad' : 'warn'}">${daysUntil(o.deadline) < 0 ? 'past due' : 'due in ' + daysUntil(o.deadline) + 'd'}</span> ` : ''}${esc(o.decision_timeline || '')}</td>
        <td>${branchCell(o, m)}</td>
        <td><select class="inline" data-id="${o.id}" data-f="status">${opts(m.statuses, o.status)}</select>${closeButtons(o)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No leads here.</div>';
  }

  function tile([label, n, href, cls]) {
    return `<${href ? `a href="${href}"` : 'div'} class="card stat ${cls || ''}"><div class="n">${n}</div><div class="l">${label}</div></${href ? 'a' : 'div'}>`;
  }
}
