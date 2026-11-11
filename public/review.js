/* Operator review queue (#/review): new leads wait here until an Operator or Admin approves them. */
'use strict';
routes.unshift([/^\/review$/, reviewView, 'review']);

async function refreshReviewBadge() {
  if (!ME || !['admin', 'operator'].includes(ME.role)) return;
  try { const r = await GET('/review'); const el = $('#review-count'); if (el) { el.textContent = r.leads.length || ''; el.classList.toggle('hidden', !r.leads.length); } } catch { /* ignore */ }
}

async function reviewView(q) {
  if (!['admin', 'operator'].includes(ME?.role)) { view.innerHTML = '<div class="card empty">Only Operators and Admins review new leads.</div>'; return; }
  const [r, m] = await Promise.all([GET('/review'), pmeta(true)]);   // fresh branch list (merges, owners)
  let leads = r.leads;
  const pri = q.get('priority') || '', br = q.get('branch') || '';
  const short = s => esc(String(s || '').split(/\s[–(]/)[0]);
  const suggested = o => currentBranchOf(o, m);

  function rows() {
    const list = leads.filter(o => (!pri || o.priority === pri) && (!br || suggested(o) === br));
    return list.length ? list.map(o => `<tr data-rid="${o.id}" class="pri-${o.priority}">
      <td><input type="checkbox" class="rsel" data-id="${o.id}"></td>
      <td>${priPill(o.priority)}<div class="muted small">${LIST_SHORT[o.list_type]}</div></td>
      <td><a href="#/pipeline/${o.id}"><b>${esc(o.business)}</b></a><div class="muted small">${esc(o.location)}</div>
        <div class="small rwhat">${esc((o.whats_happening || '').slice(0, 220))}${(o.whats_happening || '').length > 220 ? '…' : ''}</div>
        ${o.review_note ? `<div class="pill warn" style="margin-top:4px">Needs info: ${esc(o.review_note)}</div>` : ''}
        ${o.source ? `<div class="small"><a href="${esc(o.source)}" target="_blank" rel="noopener">Source${o.source_date ? ` (${esc(o.source_date)})` : ''}</a></div>` : ''}</td>
      <td class="small">${esc(o.stage)}<div class="muted">${esc((o.deal_size || '').split(' (')[0])}</div>${o.deadline ? `<span class="pill ${daysUntil(o.deadline) <= 7 ? 'bad' : 'warn'}">due ${esc(o.deadline.slice(5))}</span>` : ''}</td>
      <td><select class="rbranch" data-id="${o.id}">${suggested(o) ? '' : `<option value="">${esc(o.branch || 'Pick a branch')}</option>`}${m.branches.map(b => `<option value="${esc(b)}" ${b === suggested(o) ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        <div class="muted small">→ ${esc(owner(suggested(o)) || 'no owner set')}</div></td>
      <td class="ract"><button class="btn sm primary" data-approve="${o.id}">Approve</button>
        <button class="btn sm" data-rclose="${o.id}" data-st="Already a customer" title="Already a customer: close it; the scan will skip it">✓ Customer</button>
        <button class="btn sm" data-rclose="${o.id}" data-st="Not interested" title="Not interested: close it; the scan will skip it">✕ Not interested</button>
        <button class="btn sm" data-rnote="${o.id}">Needs info</button></td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">${leads.length ? 'Nothing matches these filters.' : 'All caught up. New leads from the Monday scan will show up here.'}</td></tr>`;
  }
  const owner = b => (m.branch_owners || {})[b] || '';
  const link = (k, v) => { const p = new URLSearchParams(q); v ? p.set(k, v) : p.delete(k); return '#/review?' + p; };

  view.innerHTML = `<div class="head"><div><h1>To review <span class="muted" style="font-size:20px" id="rcount">(${leads.length})</span></h1>
      <div class="muted">New leads from the weekly scan wait here. Approving sends each one to its branch and that branch's manager; nothing reaches the branches until it's approved.</div></div>
    <div class="row no-print" style="flex:0 0 auto"><button class="btn" id="approve-sel" disabled>Approve selected</button><button class="btn primary" id="approve-all">Approve all as shown</button></div></div>
  <div class="card">
    <div class="row" style="margin-bottom:10px;justify-content:flex-start">
      <div class="seg-toggle">${[['', 'All'], ['Hot', 'Hot'], ['Warm', 'Warm'], ['Watch', 'Watch']].map(([v, l]) => `<a href="${link('priority', v)}" class="${pri === v ? 'on' : ''}">${l}</a>`).join('')}</div>
      <div class="seg-toggle">${[['', 'All branches'], ...m.branches.map(b => [b, b])].map(([v, l]) => `<a href="${link('branch', v)}" class="${br === v ? 'on' : ''}">${esc(l)}</a>`).join('')}</div>
    </div>
    <div style="overflow-x:auto"><table class="opps review"><thead><tr><th><input type="checkbox" id="rall" title="Select all"></th><th>Priority</th><th>Lead</th><th>Stage · deal</th><th class="gold">Send to branch</th><th></th></tr></thead>
      <tbody id="rbody">${rows()}</tbody></table></div>
  </div>`;

  const done = ids => {
    leads = leads.filter(o => !ids.includes(o.id));
    $('#rbody').innerHTML = rows(); wire();
    $('#rcount').textContent = `(${leads.length})`;
    refreshReviewBadge();
  };
  const approveItems = async items => {
    if (!items.length) return;
    try {
      const r2 = await POST('/review/approve', { items });
      const per = {}; for (const o of r2.leads) { const b = currentBranchOf(o, m) || 'no branch'; per[b] = (per[b] || 0) + 1; }
      toast(`Approved ${r2.approved}: ${Object.entries(per).map(([b, n]) => `${n} to ${b}`).join(', ')}`);
      done(r2.leads.map(o => o.id));
    } catch (err) { toast(err.message, true); }
  };
  const itemFor = id => ({ id, branch: $(`.rbranch[data-id="${id}"]`)?.value || null });

  function wire() {
    $$('[data-approve]').forEach(b => b.onclick = () => approveItems([itemFor(Number(b.dataset.approve))]));
    $$('[data-rclose]').forEach(b => b.onclick = async () => {
      try { await PATCH('/opportunities/' + b.dataset.rclose, { status: b.dataset.st }); toast(`Marked "${b.dataset.st}". The weekly scan will skip it.`); done([Number(b.dataset.rclose)]); }
      catch (err) { toast(err.message, true); }
    });
    $$('[data-rnote]').forEach(b => b.onclick = async () => {
      const note = prompt('What needs checking before this goes to a branch?');
      if (!note) return;
      try { const o = await POST(`/opportunities/${b.dataset.rnote}/review-note`, { note }); const i = leads.findIndex(x => x.id === o.id); leads[i] = o; $('#rbody').innerHTML = rows(); wire(); toast('Note saved; it stays in the queue'); }
      catch (err) { toast(err.message, true); }
    });
    $$('.rbranch').forEach(sel => sel.onchange = () => { sel.nextElementSibling.textContent = '→ ' + (owner(sel.value) || 'no owner set'); });
    const sync = () => { const n = $$('.rsel:checked').length; $('#approve-sel').disabled = !n; $('#approve-sel').textContent = n ? `Approve selected (${n})` : 'Approve selected'; };
    $$('.rsel').forEach(c => c.onchange = sync); sync();
  }
  wire();
  $('#rall').onchange = e => { $$('.rsel').forEach(c => { c.checked = e.target.checked; }); $$('.rsel')[0]?.dispatchEvent(new Event('change')); };
  $('#approve-sel').onclick = () => approveItems($$('.rsel:checked').map(c => itemFor(Number(c.dataset.id))));
  $('#approve-all').onclick = () => {
    const shown = $$('.rsel').map(c => Number(c.dataset.id));
    const missing = shown.filter(id => !$(`.rbranch[data-id="${id}"]`).value).length;
    if (!shown.length) return;
    if (!confirm(`Approve ${shown.length} lead${shown.length === 1 ? '' : 's'} as shown?${missing ? `\n\n${missing} have no branch picked and will stay unassigned.` : ''}`)) return;
    approveItems(shown.map(itemFor));
  };
}
