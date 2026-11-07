// Import/export of the weekly lead workbook (Curtis_Weekly_Leads_YYYY-MM-DD.xlsx layout).
const ExcelJS = require('exceljs');
const pipeline = require('./pipeline');

const SHEETS = { "This Week's Leads": 'lead', 'Switch Prospects': 'switch', 'Chain & Franchisee Accounts': 'chain' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const norm = s => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

function text(cell) {
  if (!cell || (cell.isMerged && cell.master !== cell)) return '';
  let v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) v = v.richText.map(t => t.text).join('');
    else if (v.text !== undefined) v = typeof v.text === 'object' && v.text.richText ? v.text.richText.map(t => t.text).join('') : v.text;
    else if (v.formula !== undefined || v.sharedFormula !== undefined) v = v.result ?? '';
    else if (v.error) v = '';
  }
  return String(v ?? '').trim();
}
const rowTexts = row => { const out = []; row.eachCell({ includeEmpty: false }, c => { const t = text(c); if (t) out.push(t); }); return out; };

// "Nov 18, 2026" / "November 18, 2026" → "2026-11-18"
function parseDate(s) {
  const m = String(s || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
// Hard deadlines worth ranking on: bid closings, "closes", "due".
function findDeadline(...fields) {
  for (const f of fields) {
    const m = String(f || '').match(/(?:closes?|due|deadline|bid)\D{0,12}((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
    if (m) return parseDate(m[1]);
  }
  return null;
}

async function importWorkbook(buffer, { week } = {}) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw Object.assign(new Error('Not a readable .xlsx file'), { status: 400 }); }
  const report = { week: null, created: 0, updated: 0, duplicates: [], personas: 0, drafts: 0, unmatched_drafts: [], sheets: [] };

  // Week: "... week of Nov 2, 2026" in any title row.
  if (!week) {
    for (const ws of wb.worksheets) {
      for (let r = 1; r <= 3 && !week; r++) { const m = rowTexts(ws.getRow(r)).join(' ').match(/week of ([A-Za-z]+\.? \d{1,2},? \d{4})/i); if (m) week = parseDate(m[1]); }
      if (week) break;
    }
  }
  report.week = week = week || pipeline.mondayOf();

  // Personas first so lead rows can reference them.
  const pws = wb.getWorksheet('Personas');
  if (pws) {
    let header = null;
    pws.eachRow((row, i) => {
      const t = text(row.getCell(1));
      if (!header) { if (norm(t) === 'persona') header = i; return; }
      if (!t) return;
      const c = n => text(row.getCell(n));
      pipeline.upsertPersona({ name: t, titles: c(2), description: c(3), cares_about: c(4), objections: c(5), message: c(6), channels: c(7), materials: c(8) });
      report.personas++;
    });
  }

  // Lead lists. Columns are matched by header label, so column order can change.
  const labelToKey = Object.fromEntries(pipeline.COLUMNS.map(c => [norm(c.label), c.key]));
  for (const [name, type] of Object.entries(SHEETS)) {
    const ws = wb.worksheets.find(w => norm(w.name) === norm(name));
    if (!ws) continue;
    let map = null, count = 0;
    ws.eachRow((row, i) => {
      if (!map) {
        if (norm(text(row.getCell(1))) === 'priority') {
          map = {};
          row.eachCell((c, col) => { const k = labelToKey[norm(text(c))]; if (k) map[col] = k; });
        }
        return;
      }
      const data = { list_type: type };
      for (const [col, key] of Object.entries(map)) { const t = text(row.getCell(Number(col))); if (t) data[key] = t; }
      if (!data.business) return;
      if (data.priority && !pipeline.PRIORITIES.includes(data.priority)) data.priority = pipeline.PRIORITIES.find(p => norm(p) === norm(data.priority)) || 'Watch';
      if (data.status && !pipeline.STATUSES.includes(data.status)) delete data.status;
      const dl = findDeadline(data.stage, data.decision_timeline);
      if (dl) data.deadline = dl;
      const res = pipeline.upsertFromScan(data, week);
      if (res.action === 'created') report.created++;
      else if (res.action === 'updated') report.updated++;
      else report.duplicates.push(res.note);
      count++;
    });
    report.sheets.push({ sheet: ws.name, rows: count });
  }

  // Outreach drafts: blocks that start with "EMAIL n | Business".
  const ows = wb.getWorksheet('Outreach Drafts');
  if (ows) {
    const drafts = []; let cur = null, inBody = false;
    ows.eachRow(row => {
      const a = text(row.getCell(1)), b = text(row.getCell(2));
      if (/^email\s*\d+/i.test(a)) { cur = { business: b, body: [] }; drafts.push(cur); inBody = false; return; }
      if (!cur) return;
      const label = norm(a);
      if (label === 'persona') return;
      if (label === 'channel') cur.channel = b;
      else if (label === 'to') cur.to = b;
      else if (label === 'subject') cur.subject = b;
      else if (label === 'body') { inBody = true; cur.body.push(b); }
      else if (inBody) cur.body.push(b);
    });
    for (const d of drafts) {
      const key = pipeline.businessKey(d.business);
      const opp = pipeline.list().find(o => o.business_key === key);
      // Drop trailing blank lines but keep paragraph breaks.
      while (d.body.length && !d.body.at(-1)) d.body.pop();
      if (!opp) { report.unmatched_drafts.push(d.business); continue; }
      pipeline.update(opp.id, { outreach_to: d.to || '', outreach_channel: d.channel || '', outreach_subject: d.subject || '', outreach_body: joinBody(d.body) }, { actor: `scan ${week}` });
      report.drafts++;
    }
  }

  // Executive summary: the hand-written parts (headline, focus list, bigger plays, risks).
  const ews = wb.getWorksheet('Executive Summary');
  const rep = { headline: '', focus: [], plays: [], risks: [], sources: [] };
  if (ews) {
    let section = null;
    ews.eachRow(row => {
      const cells = rowTexts(row);
      if (!cells.length) return;
      const first = cells[0];
      if (/^headline:/i.test(first)) { rep.headline = first.replace(/^headline:\s*/i, ''); return; }
      if (/^where to focus/i.test(first)) { section = 'focus'; return; }
      if (/^bigger plays/i.test(first)) { section = 'plays'; return; }
      if (/^risks/i.test(first)) { section = 'risks'; return; }
      if (/^(pipeline by branch|this week at a glance)/i.test(first) || first === 'Tab') { section = null; return; }
      if (section === 'focus' && /^\d+$/.test(first) && cells.length >= 2) {
        const [, action, branch = '', deadline = '', deal = '', why = ''] = cells;
        rep.focus.push({ action, branch, deadline, deal, why });
      } else if (section === 'plays' && cells.length >= 2) rep.plays.push({ title: cells[0], detail: cells.slice(1).join(' ') });
      else if (section === 'risks') rep.risks.push(first.replace(/^[•\-\s]+/, ''));
    });
  }
  const sws = wb.getWorksheet('Sources & Gaps');
  if (sws) {
    let started = false;
    sws.eachRow(row => {
      const [s, r, n] = [1, 2, 3].map(i => text(row.getCell(i)));
      if (!started) { started = norm(s) === 'source' && norm(r).startsWith('reachable'); return; }
      if (s) rep.sources.push({ source: s, reachable: r, notes: n });
    });
  }
  if (rep.headline || rep.focus.length || rep.plays.length || rep.risks.length || rep.sources.length) pipeline.saveReport(week, rep, { source: 'import' });
  return report;
}

// Body rows in the sheet are one line each; blank-looking gaps become paragraph breaks.
function joinBody(lines) {
  const out = [];
  let inSignature = false;
  lines.forEach((l, i) => {
    const prev = lines[i - 1] || '';
    const isBullet = /^\s*[•\-]/.test(l), prevBullet = /^\s*[•\-]/.test(prev);
    // Signature blocks are runs of short lines ("Best regards," / "[Rep name]" / "[phone]").
    if (/^(best|kind|warm)?\s*(regards|thanks|thank you|cheers|sincerely|best),?$/i.test(prev.trim())) inSignature = true;
    const signature = inSignature && l.length < 60;
    if (i && !(isBullet && (prevBullet || /:$/.test(prev))) && !signature && !(isBullet && /we'd be glad to:|to:$/i.test(prev))) out.push('');
    out.push(l);
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------- Export ----------------
const NAVY = 'FF1F3A5F', GOLD = 'FFB7791F', LIGHT = 'FFEAF1F8';
const FILL = { Hot: 'FFF8D7DA', Warm: 'FFFFF3CD', Watch: 'FFE2E3E5' };
const WIDTHS = [9, 14, 28, 28, 22, 52, 26, 30, 20, 22, 45, 45, 30, 30, 55, 36, 40, 40, 40, 38, 13, 14, 13];
const font = (o = {}) => ({ name: 'Arial', size: 10, ...o });
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const fmtWeek = w => new Date(w + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const money = n => n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `$${Math.round(n / 1e3)}K`;
const safeSheet = s => s.replace(/[[\]:*?\/\\]/g, '').slice(0, 31).trim();

async function exportWorkbook(week, { company = 'Curtis Restaurant Equipment', scope = 'week' } = {}) {
  const sum = pipeline.summary(week);
  week = sum.week;
  const rows = scope === 'open' ? pipeline.list({ open: true }) : pipeline.list({ week });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'My Curtis';
  const exec = wb.addWorksheet('Executive Summary', { properties: { tabColor: { argb: NAVY } }, pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, paperSize: 1 } });
  const listSheets = {};
  for (const [name, type] of Object.entries(SHEETS)) {
    const blurbs = {
      lead: "Gold headers = rep to confirm/complete (current supplier, mutual connections, Curtis relationship, assigned rep). Deal sizes are rough estimates for prioritizing, not quotes. Reps: fill in 'Assigned rep' and update 'Status' (dropdown). Verify names and dates before reaching out.",
      switch: "Same layout as This Week's Leads. 'Stage' shows the switch signal. Gold headers = rep to confirm/complete. Deal sizes are rough estimates, not quotes.",
      chain: "Same layout as This Week's Leads. Chains rarely post vendor RFPs; these are public signals of expansion or remodel spending in your territory. Gold headers = rep to confirm/complete.",
    };
    const titles = { lead: `Curtis Weekly Lead Scan — week of ${fmtWeek(week)}`, switch: 'Switch Prospects — customers who may replace their design or equipment supplier', chain: 'Chain & Franchisee Accounts — regional and national opportunities' };
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 3, ySplit: 4 }] });
    ws.columns = WIDTHS.map(width => ({ width }));
    ws.getCell('A1').value = titles[type]; ws.getCell('A1').font = font({ bold: true, size: 14, color: { argb: NAVY } });
    ws.mergeCells('A2:W2'); ws.getCell('A2').value = blurbs[type]; ws.getCell('A2').font = font({ italic: true, size: 9, color: { argb: 'FF555555' } });
    ws.getCell('A2').alignment = { wrapText: true, vertical: 'top' }; ws.getRow(2).height = 30;
    const hdr = ws.getRow(4);
    pipeline.COLUMNS.forEach((c, i) => {
      const cell = hdr.getCell(i + 1);
      cell.value = c.label; cell.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); cell.fill = fill(c.rep ? GOLD : NAVY);
      cell.alignment = { wrapText: true, vertical: 'middle' };
    });
    hdr.height = 32;
    const items = rows.filter(r => r.list_type === type);
    items.forEach((r, i) => {
      const row = ws.getRow(5 + i);
      pipeline.COLUMNS.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        cell.value = r[c.key] || (c.key === 'status' ? 'New' : null);
        cell.font = font({ bold: j === 0 || j === 2 });
        cell.fill = fill(FILL[r.priority] || FILL.Watch);
        cell.alignment = { wrapText: true, vertical: 'top' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
      });
    });
    const last = Math.max(5, 4 + items.length);
    for (let r = 5; r <= last; r++) ws.getCell(`W${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${pipeline.STATUSES.join(',')}"`] };
    ws.autoFilter = { from: 'A4', to: `W${last}` };
    listSheets[type] = { name, first: 5, last };
  }

  // Executive Summary — live formulas over the list tabs, with computed results cached.
  const ref = (t, col) => `'${listSheets[t].name.replace(/'/g, "''")}'!$${col}$${listSheets[t].first}:$${col}$${listSheets[t].last}`;
  exec.columns = [{ width: 3 }, ...Array(9).fill({ width: 15 }), { width: 3 }, { width: 3 }, { width: 8 }, { width: 40 }, { width: 22 }, { width: 8 }, { width: 12 }, { width: 12 }];
  let r = 1;
  const put = (addr, value, f = {}, opts = {}) => { const c = exec.getCell(addr); c.value = value; c.font = font(f); if (opts.fill) c.fill = fill(opts.fill); c.alignment = { wrapText: true, vertical: 'top', ...(opts.align || {}) }; return c; };
  const band = (title) => { r += 1; exec.mergeCells(`B${r}:J${r}`); put(`B${r}`, title, { bold: true, color: { argb: 'FFFFFFFF' } }, { fill: NAVY }); r++; };
  exec.mergeCells('B1:J1'); put('B1', 'Executive Summary — Sales Pipeline', { bold: true, size: 16, color: { argb: NAVY } });
  exec.mergeCells('B2:J2'); put('B2', `${company}  •  Leads file for week of ${fmtWeek(week)}`, { italic: true, size: 9, color: { argb: 'FF555555' } });
  r = 3;
  if (sum.report.headline) { exec.mergeCells(`B${r}:J${r}`); put(`B${r}`, `Headline: ${sum.report.headline}`, { bold: true, color: { argb: 'FF9B1C1C' } }, { fill: FILL.Hot }); exec.getRow(r).height = 32; }
  r++;
  band('THIS WEEK AT A GLANCE');
  const t = sum.tiles;
  const tiles = [
    ['New leads', `COUNTA(${ref('lead', 'C')})`, t.new_leads], ['Hot leads', `COUNTIF(${ref('lead', 'A')},"Hot")`, t.hot_leads],
    ['Switch prospects', `COUNTA(${ref('switch', 'C')})`, t.switch_prospects], ['Chain accounts', `COUNTA(${ref('chain', 'C')})`, t.chain_accounts],
    ['Est. pipeline – new leads (low)', null, t.pipeline_low], ['Est. pipeline – new leads (high)', null, t.pipeline_high],
    ['Hot leads not yet assigned', `COUNTIFS(${ref('lead', 'A')},"Hot",${ref('lead', 'V')},"")`, t.hot_unassigned], ["Leads still at 'New'", `COUNTIF(${ref('lead', 'W')},"New")`, t.still_new],
  ];
  // Hidden pipeline table (cols M–R) that the money tiles sum, like the original workbook.
  const tableStart = 70;
  const tableRows = rows.map(o => ({ tab: { lead: 'Leads', switch: 'Switch', chain: 'Chain' }[o.list_type], o }));
  ['Tab', 'Business', 'Branch', 'Priority', 'Low $', 'High $'].forEach((h, i) => put(`${'MNOPQR'[i]}${tableStart - 1}`, h, { bold: true, size: 8 }));
  tableRows.forEach(({ tab, o }, i) => {
    const rr = tableStart + i;
    [tab, o.business, o.branch, o.priority, o.deal_low || 0, o.deal_high || 0].forEach((v, j) => put(`${'MNOPQR'[j]}${rr}`, v, { size: 8, color: { argb: 'FF888888' } }));
  });
  const tEnd = tableStart + Math.max(tableRows.length, 1) - 1;
  const T = col => `$${col}$${tableStart}:$${col}$${tEnd}`;
  tiles[4][1] = `SUMIFS(${T('Q')},${T('M')},"Leads")`; tiles[5][1] = `SUMIFS(${T('R')},${T('M')},"Leads")`;
  for (let half = 0; half < 2; half++) {
    const set = tiles.slice(half * 4, half * 4 + 4);
    set.forEach(([label, formula, result], i) => {
      const col = 'BDFH'[i], col2 = 'CEGI'[i];
      const accent = (label.startsWith('Hot') ? FILL.Hot : LIGHT);
      exec.mergeCells(`${col}${r}:${col2}${r}`); put(`${col}${r}`, label, { bold: true, size: 8, color: { argb: 'FF555555' } }, { fill: accent });
      exec.mergeCells(`${col}${r + 1}:${col2}${r + 1}`);
      const c = put(`${col}${r + 1}`, formula ? { formula, result } : result, { bold: true, size: 20, color: { argb: NAVY } }, { fill: accent });
      if (label.startsWith('Est.')) c.numFmt = '$#,##0';
    });
    exec.getRow(r + 1).height = 30;
    r += 2;
  }
  exec.mergeCells(`B${r}:J${r}`); put(`B${r}`, 'Pipeline figures add up the rough deal-size ranges (estimates, not quotes). Counts update as reps fill in Assigned rep and Status.', { italic: true, size: 8, color: { argb: 'FF555555' } }); r++;

  band('WHERE TO FOCUS THIS WEEK (IN ORDER)');
  const focus = sum.report.focus.length ? sum.report.focus : sum.suggested_focus;
  ['#', 'Action', '', '', 'Branch', 'Deadline', '', 'Est. deal', 'Why it matters'].forEach((h, i) => h && put(`${'BCDEFGHIJ'[i]}${r}`, h, { bold: true, size: 9 }, { fill: LIGHT }));
  r++;
  focus.forEach((f, i) => {
    exec.mergeCells(`C${r}:E${r}`); exec.mergeCells(`G${r}:H${r}`);
    put(`B${r}`, i + 1, { bold: true }); put(`C${r}`, f.action, { size: 9 }); put(`F${r}`, f.branch, { size: 9 }); put(`G${r}`, f.deadline, { size: 9 });
    put(`I${r}`, f.deal, { size: 9 }); put(`J${r}`, f.why, { size: 9 });
    exec.getRow(r).height = 36; r++;
  });

  band('PIPELINE BY BRANCH (NEW LEADS + SWITCH PROSPECTS)');
  ['Branch', 'Leads', 'Hot leads', 'Switch prospects', 'Est. low', 'Est. high'].forEach((h, i) => put(`${'BCDEFG'[i]}${r}`, h, { bold: true, size: 9 }, { fill: LIGHT }));
  r++;
  for (const b of sum.branches) {
    const p = `"${b.branch}*"`;
    put(`B${r}`, b.branch, { bold: true, size: 9 });
    put(`C${r}`, { formula: `COUNTIF(${ref('lead', 'B')},${p})`, result: b.leads }, { size: 9 });
    put(`D${r}`, { formula: `COUNTIFS(${ref('lead', 'B')},${p},${ref('lead', 'A')},"Hot")`, result: b.hot }, { size: 9 });
    put(`E${r}`, { formula: `COUNTIF(${ref('switch', 'B')},${p})`, result: b.switch }, { size: 9 });
    put(`F${r}`, { formula: `SUMIFS(${T('Q')},${T('O')},${p},${T('M')},"<>Chain")`, result: b.low }, { size: 9 }).numFmt = '$#,##0';
    put(`G${r}`, { formula: `SUMIFS(${T('R')},${T('O')},${p},${T('M')},"<>Chain")`, result: b.high }, { size: 9 }).numFmt = '$#,##0';
    r++;
  }
  if (sum.report.plays.length) {
    band('BIGGER PLAYS TO START NOW (MULTI-MONTH)');
    for (const p of sum.report.plays) { exec.mergeCells(`B${r}:C${r}`); exec.mergeCells(`D${r}:J${r}`); put(`B${r}`, p.title, { bold: true, size: 9 }); put(`D${r}`, p.detail, { size: 9 }); exec.getRow(r).height = 28; r++; }
  }
  if (sum.report.risks.length) {
    band('RISKS, GAPS AND DECISIONS NEEDED');
    for (const k of sum.report.risks) { exec.mergeCells(`B${r}:J${r}`); put(`B${r}`, `•  ${k}`, { size: 9 }); exec.getRow(r).height = 26; r++; }
  }
  // Keep the helper table off the printed page.
  for (const col of ['M', 'N', 'O', 'P', 'Q', 'R']) exec.getColumn(col).hidden = true;
  exec.pageSetup.printArea = `A1:J${r}`;

  // Personas
  const ps = wb.addWorksheet('Personas');
  ps.columns = [22, 30, 34, 34, 34, 40, 30, 34].map(width => ({ width }));
  ps.getCell('A1').value = 'Marketing Personas'; ps.getCell('A1').font = font({ bold: true, size: 14, color: { argb: NAVY } });
  ps.getCell('A2').value = 'Definitions for every persona named in the Persona column. Match the message, channel and materials to the persona.'; ps.getCell('A2').font = font({ italic: true, size: 9 });
  ['Persona', 'Typical titles', "What they're like", 'What they care about', 'Common objections', 'Message that works', 'Best channels', 'Go-to materials']
    .forEach((h, i) => { const c = ps.getRow(4).getCell(i + 1); c.value = h; c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = fill(NAVY); });
  pipeline.personas().forEach((p, i) => {
    const row = ps.getRow(5 + i);
    [p.name, p.titles, p.description, p.cares_about, p.objections, p.message, p.channels, p.materials].forEach((v, j) => {
      const c = row.getCell(j + 1); c.value = v; c.font = font({ bold: j === 0, size: 9 }); c.alignment = { wrapText: true, vertical: 'top' };
    });
  });

  // Outreach drafts — one line per row so it pastes cleanly into an email.
  const od = wb.addWorksheet('Outreach Drafts');
  od.columns = [{ width: 12 }, { width: 110 }];
  od.getCell('A1').value = 'Outreach Drafts (Hot leads)'; od.getCell('A1').font = font({ bold: true, size: 14, color: { argb: NAVY } });
  od.getCell('A2').value = 'Select the body cells in column B, copy, and paste into a new email. Fill in the [brackets] and personalize before sending.'; od.getCell('A2').font = font({ italic: true, size: 9 });
  let orow = 4, n = 0;
  for (const o of rows.filter(o => o.priority === 'Hot' && o.outreach_body)) {
    n++;
    const hdr = od.getRow(orow++); hdr.getCell(1).value = `EMAIL ${n}`; hdr.getCell(2).value = o.business + (o.list_type === 'switch' ? ' (Switch prospect)' : '');
    [1, 2].forEach(i => { hdr.getCell(i).font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); hdr.getCell(i).fill = fill(NAVY); });
    for (const [k, v] of [['Persona', o.persona], ['Channel', o.outreach_channel], ['To', o.outreach_to], ['Subject', o.outreach_subject]]) {
      const row = od.getRow(orow++); row.getCell(1).value = k; row.getCell(1).font = font({ bold: true, size: 9 }); row.getCell(2).value = v || ''; row.getCell(2).font = font({ size: 9 });
    }
    o.outreach_body.split('\n').filter((l, i, a) => l || (a[i - 1] && a[i + 1])).forEach((line, i) => {
      const row = od.getRow(orow++); if (i === 0) { row.getCell(1).value = 'Body'; row.getCell(1).font = font({ bold: true, size: 9 }); }
      row.getCell(2).value = line; row.getCell(2).font = font({ size: 10 }); row.getCell(2).alignment = { wrapText: true };
    });
    orow++;
  }

  // One-page brief per Hot new lead.
  const used = new Set(wb.worksheets.map(w => w.name));
  for (const o of rows.filter(o => o.priority === 'Hot' && o.list_type === 'lead')) {
    let nm = safeSheet(`Brief – ${o.business.split(/\s[–(]/)[0]}`); while (used.has(nm)) nm = safeSheet(nm.slice(0, 28) + ' ' + used.size);
    used.add(nm);
    const ws = wb.addWorksheet(nm, { pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
    ws.columns = [{ width: 26 }, { width: 90 }];
    let br = 1;
    const line = (a, b, f = {}) => { const row = ws.getRow(br++); row.getCell(1).value = a; row.getCell(1).font = font({ bold: true, size: 9, ...f }); row.getCell(2).value = b ?? ''; row.getCell(2).font = font({ size: 9 }); row.getCell(2).alignment = { wrapText: true, vertical: 'top' }; return row; };
    const head = t => { const row = ws.getRow(++br); row.getCell(1).value = t; [1, 2].forEach(i => { row.getCell(i).fill = fill(NAVY); row.getCell(i).font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); }); br++; };
    ws.getCell('A1').value = o.business; ws.getCell('A1').font = font({ bold: true, size: 14, color: { argb: NAVY } }); ws.getCell('B1').value = `${o.priority.toUpperCase()} LEAD`; ws.getCell('B1').font = font({ bold: true, color: { argb: 'FF9B1C1C' } });
    br = 2; line('', `${o.location}  •  Branch: ${o.branch}  •  Sales handoff brief, week of ${fmtWeek(week)}`, {});
    line('Assigned rep', o.assigned_rep || '[unassigned]'); line('Status', o.status);
    head('SNAPSHOT');
    for (const [k, v] of [['Stage', o.stage], ['Est. deal size', o.deal_size], ['Decision timeline', o.decision_timeline], ['Target list', o.target_list], ['Persona', o.persona], ['Rebate flag', o.rebate_flag]]) line(k, v);
    head("WHAT'S HAPPENING"); line('', o.whats_happening);
    const ps2 = pipeline.personasFor(o.persona);
    if (ps2.length) { head("WHO YOU'RE TALKING TO – PERSONA QUICK READ"); for (const p of ps2) { line('Persona', p.name); line('What they care about', p.cares_about); line('Message that works', p.message); } }
    line('Likely objection → response', o.objection);
    head('CONVERSATION STARTERS'); line('', o.hooks);
    head('CONTACTS'); line('First try', o.how_to_reach); line('Backups (in order)', o.backup_contacts);
    head('RELATIONSHIP INTEL (REP TO CONFIRM)'); line('Who they buy from now', o.current_supplier); line('Mutual connections', o.mutual_connections); line('Existing relationship with Curtis', o.curtis_relationship);
    head('NEXT STEPS');
    for (const s of [o.next_step, 'Check NetSuite/AutoQuotes for an existing account', 'Send the outreach email below, personalized', 'Log the contact and update Status in My Curtis'].filter(Boolean)) line('☐', s);
    if (o.outreach_body) { head('OUTREACH EMAIL'); line('To', o.outreach_to); line('Subject', o.outreach_subject); line('', o.outreach_body); }
    head('SOURCE'); line('', `${o.source}${o.source_date ? `  (published ${o.source_date})` : ''}`);
  }

  if (sum.report.sources.length) {
    const ss = wb.addWorksheet('Sources & Gaps');
    ss.columns = [{ width: 60 }, { width: 14 }, { width: 90 }];
    ss.getCell('A1').value = 'Where these leads come from'; ss.getCell('A1').font = font({ bold: true, size: 14, color: { argb: NAVY } });
    ['Source', 'Reachable?', 'Notes'].forEach((h, i) => { const c = ss.getRow(4).getCell(i + 1); c.value = h; c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } }); c.fill = fill(NAVY); });
    sum.report.sources.forEach((s, i) => { const row = ss.getRow(5 + i); [s.source, s.reachable, s.notes].forEach((v, j) => { row.getCell(j + 1).value = v; row.getCell(j + 1).font = font({ size: 9 }); row.getCell(j + 1).alignment = { wrapText: true, vertical: 'top' }; }); });
  }

  return { buffer: await wb.xlsx.writeBuffer(), filename: `Curtis_Weekly_Leads_${week}.xlsx` };
}

module.exports = { importWorkbook, exportWorkbook, parseDate, findDeadline, money };
