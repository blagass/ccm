/* Calendar: what needs doing each day (tasks + pipeline deadlines + focus actions), and adding tasks. */
'use strict';
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const longDay = s => fromYmd(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = s => fromYmd(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

routes.unshift([/^\/calendar$/, calendarView, 'calendar']);

async function calendarView(q) {
  const today = ymd(new Date());
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : today;
  const month = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : sel.slice(0, 7);
  const mine = q.get('mine') !== '0';
  const first = fromYmd(month + '-01');
  const gridStart = addDays(first, -first.getDay());                       // Sunday on/before the 1st
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const gridEnd = addDays(last, 6 - last.getDay());                         // Saturday on/after month end
  const [cal, m, opps] = await Promise.all([
    GET(`/calendar?from=${ymd(gridStart)}&to=${ymd(gridEnd)}&today=${today}&mine=${mine ? 1 : 0}`),
    pmeta(), GET('/opportunities?open=true'),
  ]);

  const byDay = {};
  const push = (d, item) => (byDay[d] = byDay[d] || []).push(item);
  cal.tasks.forEach(t => push(t.due_date, { type: 'task', ...t }));
  cal.events.forEach(e => push(e.date, { type: e.kind, ...e }));
  const link = (k, v) => { const p = new URLSearchParams(q); p.set(k, v); return '#/calendar?' + p; };
  const monthShift = n => { const d = new Date(first.getFullYear(), first.getMonth() + n, 1); return ymd(d).slice(0, 7); };

  const chip = it => {
    if (it.type === 'task') return `<div class="chip task${it.done ? ' done' : ''}" title="${esc(it.title)}">${it.done ? '☑' : '☐'} ${esc(it.title)}</div>`;
    if (it.type === 'deadline') return `<div class="chip deadline pri-${esc(it.priority)}" title="${esc(it.title)}">⏰ ${esc(it.title)}</div>`;
    if (it.type === 'focus') return `<div class="chip focus" title="${esc(it.title)}">★ ${esc(it.title)}</div>`;
    return `<div class="chip scan" title="${esc(it.title)}">↻ Lead scan</div>`;
  };
  const days = [];
  for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 1)) days.push(ymd(d));
  const dayItems = d => (byDay[d] || []).sort((a, b) => ({ deadline: 0, focus: 1, task: 2, scan: 3 }[a.type] - { deadline: 0, focus: 1, task: 2, scan: 3 }[b.type]) || (a.done || 0) - (b.done || 0));

  const agenda = dayItems(sel);
  const selTasks = agenda.filter(i => i.type === 'task');
  const overdue = sel === today ? cal.overdue : [];
  const taskRow = t => `<li class="trow${t.done ? ' done' : ''}">
      <input type="checkbox" data-done="${t.id}" ${t.done ? 'checked' : ''} title="Mark done">
      <div class="grow"><div class="ttl">${esc(t.title)}</div>
        <div class="muted small">${t.assigned_to ? esc(t.assigned_to) : 'Anyone'}${t.opportunity ? ` · <a href="#/pipeline/${t.opportunity_id}">${esc(t.opportunity)}</a>` : ''}${t.due_date !== sel ? ` · <span class="pill bad">due ${shortDay(t.due_date)}</span>` : ''}${t.done && t.done_by ? ` · done by ${esc(t.done_by)}` : ''}</div>
        ${t.notes ? `<div class="small" style="white-space:pre-wrap;margin-top:2px">${esc(t.notes)}</div>` : ''}</div>
      <div class="tact"><button class="btn sm" data-tomorrow="${t.id}" data-due="${t.due_date}" title="Push to the next day">→</button><button class="btn sm danger" data-deltask="${t.id}" title="Delete">✕</button></div></li>`;

  view.innerHTML = `
  <div class="head"><div><h1>Calendar</h1><div class="muted">What needs doing each day: your tasks, bid and order deadlines, and the week's focus actions.</div></div>
    <div class="row" style="flex:0 0 auto">
      <div class="seg-toggle"><a href="${link('mine', '1')}" class="${mine ? 'on' : ''}">Mine</a><a href="${link('mine', '0')}" class="${mine ? '' : 'on'}">Everyone</a></div>
      <a class="btn" href="${link('m', monthShift(-1))}">‹</a>
      <a class="btn" href="#/calendar?d=${today}&mine=${mine ? 1 : 0}">Today</a>
      <a class="btn" href="${link('m', monthShift(1))}">›</a>
    </div></div>
  <div class="cal-layout">
    <div class="card cal">
      <div class="cal-title">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
      <div class="cal-grid">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('')}
        ${days.map(d => {
          const items = dayItems(d), open = items.filter(i => i.type === 'task' && !i.done).length;
          const cls = [d.slice(0, 7) !== month ? 'other' : '', d === today ? 'today' : '', d === sel ? 'sel' : '', d < today ? 'past' : ''].join(' ');
          return `<a class="day ${cls}" href="${link('d', d)}">
            <div class="dnum"><span>${fromYmd(d).getDate()}</span>${d === today && cal.overdue.length ? `<span class="pill bad" title="Overdue tasks">${cal.overdue.length} overdue</span>` : open ? `<span class="count">${open}</span>` : ''}</div>
            ${items.slice(0, 3).map(chip).join('')}${items.length > 3 ? `<div class="more">+${items.length - 3} more</div>` : ''}</a>`;
        }).join('')}
      </div>
      <div class="legend muted small"><span class="chip deadline pri-Hot">⏰ Deadline</span><span class="chip focus">★ Focus action</span><span class="chip task">☐ Task</span><span class="chip scan">↻ Lead scan</span></div>
    </div>

    <div class="agenda">
      <div class="card">
        <h2 style="margin-bottom:4px">${longDay(sel)}</h2>
        <div class="muted small" style="margin-bottom:12px">${sel === today ? 'Today' : sel < today ? 'Past day' : ''}</div>
        ${overdue.length ? `<h3 class="agenda-h bad">Overdue (${overdue.length})</h3><ul class="tasks">${overdue.map(taskRow).join('')}</ul>` : ''}
        ${agenda.filter(i => i.type === 'deadline').length ? `<h3 class="agenda-h">Deadlines</h3><ul class="plain">${agenda.filter(i => i.type === 'deadline').map(e => `<li><span class="pill ${e.priority === 'Hot' ? 'bad' : 'warn'}">${esc(e.priority)}</span> <a href="#/pipeline/${e.opportunity_id}">${esc(e.title)}</a><div class="muted small">${esc(e.branch || '')}${e.assigned_rep ? ' · ' + esc(e.assigned_rep) : ' · unassigned'}</div></li>`).join('')}</ul>` : ''}
        ${agenda.filter(i => i.type === 'focus').length ? `<h3 class="agenda-h">This week's focus</h3><ul class="plain">${agenda.filter(i => i.type === 'focus').map(e => `<li>★ ${esc(e.title)}<div class="muted small">${esc(e.branch || '')}${e.detail ? ' · ' + esc(e.detail) : ''} · <a href="#/?week=${e.week_of}">Executive Summary</a></div></li>`).join('')}</ul>` : ''}
        <h3 class="agenda-h">Tasks</h3>
        ${selTasks.length ? `<ul class="tasks">${selTasks.map(taskRow).join('')}</ul>` : '<div class="muted small" style="margin-bottom:8px">No tasks for this day.</div>'}
        ${agenda.some(i => i.type === 'scan') ? `<div class="muted small" style="margin-top:8px">↻ The weekly lead scan runs this morning — new leads show up on the <a href="#/">Executive Summary</a>.</div>` : ''}
      </div>
      <form class="card" id="addtask">
        <h2>Add a task</h2>
        <div class="field"><label class="f">What needs to be done</label><input name="title" required placeholder="e.g. Call Derek Hood about the Meridian layout"></div>
        <div class="row"><div class="field"><label class="f">Date</label><input type="date" name="due_date" value="${sel}" required></div>
          <div class="field"><label class="f">Assigned to</label><input name="assigned_to" list="cal-reps" value="${esc(ME?.id ? ME.name : '')}" placeholder="Anyone"></div></div>
        <div class="field"><label class="f">Lead (optional)</label><input name="lead" list="cal-leads" placeholder="Start typing a business…"></div>
        <div class="field"><label class="f">Notes</label><textarea name="notes" style="min-height:56px"></textarea></div>
        <button class="btn primary">Add task</button>
      </form>
      <datalist id="cal-reps">${m.reps.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
      <datalist id="cal-leads">${opps.map(o => `<option value="${esc(o.business)}">`).join('')}</datalist>
    </div>
  </div>`;

  $('#addtask').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, leadName = f.lead.value.trim();
    const opp = leadName ? opps.find(o => o.business === leadName) : null;
    if (leadName && !opp) return toast('Pick a lead from the list (or leave it blank)', true);
    try {
      await POST('/tasks', { title: f.title.value, due_date: f.due_date.value, assigned_to: f.assigned_to.value, notes: f.notes.value, opportunity_id: opp ? opp.id : null });
      toast('Task added');
      const p = new URLSearchParams(q); p.set('d', f.due_date.value); p.set('m', f.due_date.value.slice(0, 7));
      if (location.hash === '#/calendar?' + p) route(); else location.hash = '#/calendar?' + p;
    } catch (err) { toast(err.message, true); }
  };
  wireTaskButtons(route);
}

function wireTaskButtons(refresh) {
  $$('[data-done]').forEach(cb => cb.onchange = async () => { await PATCH('/tasks/' + cb.dataset.done, { done: cb.checked }); refresh(); });
  $$('[data-deltask]').forEach(b => b.onclick = async () => { if (confirm('Delete this task?')) { await DEL('/tasks/' + b.dataset.deltask); refresh(); } });
  // Push a task to the next day; overdue tasks go to tomorrow.
  $$('[data-tomorrow]').forEach(b => b.onclick = async () => {
    const today = ymd(new Date()), due = b.dataset.due;
    const next = ymd(addDays(fromYmd(due < today ? today : due), 1));
    await PATCH('/tasks/' + b.dataset.tomorrow, { due_date: next });
    toast('Moved to ' + shortDay(next)); refresh();
  });
}

// Tasks section on a lead's brief page.
async function renderLeadTasks(el, opp) {
  const list = await GET(`/opportunities/${opp.id}/tasks`);
  const today = ymd(new Date());
  el.innerHTML = `<h2>Tasks</h2>
    ${list.length ? `<ul class="tasks">${list.map(t => `<li class="trow${t.done ? ' done' : ''}"><input type="checkbox" data-done="${t.id}" ${t.done ? 'checked' : ''}>
      <div class="grow"><div class="ttl">${esc(t.title)}</div><div class="muted small"><a href="#/calendar?d=${t.due_date}">${shortDay(t.due_date)}</a>${!t.done && t.due_date < today ? ' <span class="pill bad">overdue</span>' : ''} · ${t.assigned_to ? esc(t.assigned_to) : 'Anyone'}</div></div>
      <div class="tact"><button class="btn sm danger" data-deltask="${t.id}">✕</button></div></li>`).join('')}</ul>` : '<div class="muted small">No tasks yet.</div>'}
    <form class="row" id="lead-task" style="margin-top:10px"><input name="title" placeholder="Follow-up task…" required><input type="date" name="due_date" class="auto" style="width:150px" value="${ymd(addDays(new Date(), 1))}" required>
      <input name="assigned_to" class="auto" style="width:150px" list="reps" placeholder="Assigned to" value="${esc(opp.assigned_rep || ME?.name || '')}"><button class="btn auto">Add</button></form>`;
  $('#lead-task', el).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try { await POST('/tasks', { title: f.title.value, due_date: f.due_date.value, assigned_to: f.assigned_to.value, opportunity_id: opp.id }); toast('Task added'); renderLeadTasks(el, opp); }
    catch (err) { toast(err.message, true); }
  };
  wireTaskButtons(() => renderLeadTasks(el, opp));
}
