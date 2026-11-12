/* Not looked at yet (#/followup): approved leads nobody in their branch has opened, and reminders to send. */
'use strict';
routes.unshift([/^\/followup$/, followupView, 'followup']);

async function refreshFollowupBadge() {
  if (!ME || !['admin', 'operator'].includes(ME.role)) return;
  try {
    const f = await GET('/followup?today=' + ymd(new Date()));
    const el = $('#followup-count'); if (el) { el.textContent = f.stats.red || ''; el.classList.toggle('hidden', !f.stats.red); }
  } catch { /* ignore */ }
}

async function followupView(q) {
  if (!['admin', 'operator'].includes(ME?.role)) { view.innerHTML = '<div class="card empty">Only Operators and Admins see this page.</div>'; return; }
  const f = await GET('/followup?today=' + ymd(new Date()));
  const urgentOnly = q.get('show') === 'urgent';
  const first = n => String(n || '').trim().split(/\s+/)[0];
  const short = s => String(s || '').split(/\s[–(]/)[0];
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const fmtDay = d => fromYmd(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const when = ts => { const d = new Date(String(ts).replace(' ', 'T') + 'Z'); return ymd(d) === ymd(new Date()) ? 'today' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
  const groups = f.groups.map(g => ({ ...g, shown: urgentOnly ? g.leads.filter(l => l.urgency === 'red') : g.leads })).filter(g => g.shown.length);

  // The reminder itself: friendly, specific, and short enough to read on a phone.
  function draft(g, leads) {
    const hot = leads.filter(l => l.priority === 'Hot').length;
    const where = g.branch ? `${g.branch} ` : '';
    const lines = leads.slice(0, 6).map(l => {
      const bits = [l.priority];
      if (l.deadline) bits.push(`due ${fmtDay(l.deadline)}`);
      const why = (l.next_step || l.decision_timeline || l.stage || '').replace(/\s+/g, ' ').trim();
      return `• ${short(l.business)} (${bits.join(', ')})${why ? `: ${why.length > 90 ? why.slice(0, 88) + '…' : why}` : ''}`;
    });
    if (leads.length > 6) lines.push(`• …and ${leads.length - 6} more`);
    const link = g.branch ? `${location.origin}/#/branch/${encodeURIComponent(g.branch)}?tab=unopened` : `${location.origin}/#/pipeline`;
    return `Hi ${first(g.to) || 'there'}, a quick nudge on ${plural(leads.length, `${where}lead`)} that ${leads.length === 1 ? "hasn't" : "haven't"} been opened yet${hot ? `, ${hot === leads.length && hot > 1 ? 'all' : hot} of them Hot` : ''}:\n\n${lines.join('\n')}\n\nOpen your list: ${link}\n\nThanks!\n${first(ME.name) || ''}`.trim();
  }

  const lastLine = r => r ? `<div class="small fu-last ${when(r.at) === 'today' ? 'today' : 'muted'}">Last reminded ${esc(when(r.at))} by ${esc(r.from || 'an Operator')} · ${r.opened_since} of ${r.leads} opened since</div>` : '<div class="muted small fu-last">No reminders sent yet</div>';
  const card = (g, i) => `<div class="card fu-group" data-g="${i}">
    <div class="fu-head"><div><h2>${esc(g.branch || 'No branch')} · ${g.to ? esc(g.to) : '<span class="pill bad">no owner</span>'}</h2>
        <div class="muted small">${plural(g.leads.length, 'lead')} not opened${g.hot ? ` · ${g.hot} Hot` : ''}${g.red ? ` · <b style="color:var(--bad)">${g.red} urgent</b>` : ''} · oldest ${plural(g.oldest, 'day')}</div>${g.to ? lastLine(g.last_reminder) : ''}</div>
      <div class="no-print">${g.to ? `<button class="btn primary" data-build="${i}">Build reminder</button>` : `<a class="btn" href="#/settings">Set a branch owner</a>`}</div></div>
    <div style="overflow-x:auto"><table class="opps"><thead><tr><th class="no-print"><input type="checkbox" class="fu-all" checked title="Include all"></th><th>Priority</th><th>Lead</th><th>Waiting</th><th>Deadline</th><th>Stage</th></tr></thead><tbody>
      ${g.shown.map(l => `<tr class="pri-${esc(l.priority)}">
        <td class="no-print"><input type="checkbox" class="fu-sel" data-id="${l.id}" checked></td>
        <td>${priPill(l.priority)}</td>
        <td><a href="#/pipeline/${l.id}"><b>${esc(l.business)}</b></a><div class="muted small">${esc(l.location || '')}</div></td>
        <td><span class="pill ${l.urgency === 'red' ? 'bad' : l.urgency === 'orange' ? 'warn' : ''}">${l.days === 0 ? 'today' : plural(l.days, 'day')}</span></td>
        <td class="small">${l.deadline ? esc(fmtDay(l.deadline)) : '<span class="muted">none</span>'}</td>
        <td class="small">${esc(l.stage || '')}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="fu-draft hidden no-print"><textarea aria-label="Reminder message"></textarea>
      <div class="row"><button class="btn cta" data-send="${i}">Send in My Curtis</button><button class="btn" data-copy="${i}">Copy</button>
        <span class="muted small">${esc(first(g.to))} will see it at the top of the welcome popup and ${g.branch ? `the ${esc(g.branch)} branch page` : 'their pages'}. It clears once the leads are opened.</span></div></div>
  </div>`;

  view.innerHTML = `<div class="head"><div><h1>Not looked at yet <span class="muted" style="font-size:20px">(${f.stats.untouched})</span></h1>
      <div class="muted">Approved leads nobody in their branch has opened. A lead counts as looked at once its branch manager or the person it's assigned to opens it, or anyone on the team updates it. Moving a lead to another branch starts the clock over.</div></div>
    <div class="row no-print" style="flex:0 0 auto">${groups.some(g => g.to) ? '<button class="btn" id="build-all">Build all reminders</button>' : ''}</div></div>
  <div class="row no-print" style="justify-content:flex-start;margin-bottom:12px">
    <div class="seg-toggle"><a href="#/followup" class="${urgentOnly ? '' : 'on'}">All (${f.stats.untouched})</a><a href="#/followup?show=urgent" class="${urgentOnly ? 'on' : ''}">Urgent only (${f.stats.red})</a></div>
    <span class="muted small"><span class="pill bad">red</span> Hot and waiting 3+ days, or a deadline within a week · <span class="pill warn">orange</span> waiting more than a week</span>
  </div>
  ${groups.length ? groups.map(card).join('') : `<div class="card empty">${f.stats.untouched ? 'Nothing urgent right now.' : 'Every approved lead has been opened by its branch. Nice work, team!'}</div>`}`;

  const picked = i => { const el = $(`.fu-group[data-g="${i}"]`); const ids = $$('.fu-sel:checked', el).map(c => Number(c.dataset.id)); return groups[i].shown.filter(l => ids.includes(l.id)); };
  const redraft = i => { const box = $(`.fu-group[data-g="${i}"] .fu-draft textarea`); if (box && !box.dataset.edited) box.value = draft(groups[i], picked(i)); };
  const open = i => { const el = $(`.fu-group[data-g="${i}"] .fu-draft`); el.classList.remove('hidden'); redraft(i); };

  $$('.fu-group').forEach(el => {
    const i = Number(el.dataset.g);
    $$('.fu-sel', el).forEach(c => c.onchange = () => redraft(i));
    const all = $('.fu-all', el); if (all) all.onchange = () => { $$('.fu-sel', el).forEach(c => { c.checked = all.checked; }); redraft(i); };
    const box = $('.fu-draft textarea', el); if (box) box.oninput = () => { box.dataset.edited = '1'; };
  });
  $$('[data-build]').forEach(b => b.onclick = () => { open(Number(b.dataset.build)); $(`.fu-group[data-g="${b.dataset.build}"] textarea`).focus(); });
  if ($('#build-all')) $('#build-all').onclick = () => groups.forEach((g, i) => g.to && open(i));
  $$('[data-copy]').forEach(b => b.onclick = async () => {
    const box = $(`.fu-group[data-g="${b.dataset.copy}"] textarea`);
    try { await navigator.clipboard.writeText(box.value); toast('Copied. Paste it into Outlook or Teams.'); } catch { box.select(); toast('Press Ctrl+C to copy'); }
  });
  $$('[data-send]').forEach(b => b.onclick = async () => {
    const i = Number(b.dataset.send), g = groups[i], leads = picked(i);
    const message = $(`.fu-group[data-g="${i}"] textarea`).value.trim();
    if (!leads.length) return toast('Tick at least one lead', true);
    if (g.last_reminder && when(g.last_reminder.at) === 'today' && !confirm(`${first(g.to)} already got a reminder today. Send another?`)) return;
    try {
      await POST('/reminders', { to_name: g.to, branch: g.branch, message, lead_ids: leads.map(l => l.id) });
      toast(`Reminder sent to ${first(g.to)}`);
      followupView(q); refreshFollowupBadge();
    } catch (err) { toast(err.message, true); }
  });
}
