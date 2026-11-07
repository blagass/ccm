// Sales pipeline: weekly workbook import, rep updates carrying over, executive summary math, export.
// Uses a synthetic workbook in the same layout as the weekly lead file (no real customer data).
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const app = require('../src/server');
const pipeline = require('../src/pipeline');

let base, cookie, server;
async function req(method, path, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(base + path, {
    method, headers: { ...(body && !isBuf ? { 'content-type': 'application/json' } : {}), ...(isBuf ? { 'content-type': 'application/octet-stream' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: isBuf ? body : body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const HEAD = pipeline.COLUMNS.map(c => c.label);
function leadRow(o) { return pipeline.COLUMNS.map(c => o[c.key] ?? ''); }

async function makeWorkbook(weekLabel, { leads = [], switches = [], chains = [], extraSheets = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ex = wb.addWorksheet('Executive Summary');
  ex.getCell('B1').value = 'Executive Summary — Sales Pipeline';
  ex.getCell('B2').value = `Acme Equipment  •  Leads file for week of ${weekLabel}`;
  ex.getCell('B3').value = 'Headline: Two bids close soon. Win those first.';
  ex.getCell('B5').value = 'WHERE TO FOCUS THIS WEEK (IN ORDER)';
  ['#', 'Action', 'Branch', 'Deadline', 'Est. deal', 'Why it matters'].forEach((h, i) => ex.getRow(6).getCell(i + 2).value = h);
  [1, 'Bid A: price to GCs', 'Portland', 'Nov 12', '$50K–$150K', 'Hard deadline'].forEach((v, i) => ex.getRow(7).getCell(i + 2).value = v);
  ex.getCell('B9').value = 'BIGGER PLAYS TO START NOW (MULTI-MONTH)';
  ex.getCell('B10').value = 'Big Chain'; ex.getCell('D10').value = 'Remodel program through 2028.';
  ex.getCell('B12').value = 'RISKS, GAPS AND DECISIONS NEEDED';
  ex.getCell('B13').value = '•  Liquor-license data is blocked.';
  for (const [name, rows, title] of [["This Week's Leads", leads, `Weekly Lead Scan — week of ${weekLabel}`], ['Switch Prospects', switches, 'Switch'], ['Chain & Franchisee Accounts', chains, 'Chains']]) {
    const ws = wb.addWorksheet(name);
    ws.getCell('A1').value = title;
    ws.getRow(4).values = HEAD;
    rows.forEach((r, i) => { ws.getRow(5 + i).values = leadRow(r); });
  }
  if (extraSheets) {
    const ps = wb.addWorksheet('Personas');
    ps.getRow(4).values = ['Persona', 'Typical titles', "What they're like", 'What they care about', 'Common objections', 'Message that works', 'Best channels', 'Go-to materials'];
    ps.getRow(5).values = ['Owner-Operator', 'Owner / GM', 'Wears every hat', 'Cash flow', '"Too expensive"', 'Monthly payment', 'Phone', 'Financing chart'];
    ps.getRow(6).values = ['Procurement Officer', 'Buyer', 'Rules-driven', 'Compliance', '"Use the portal"', 'Be on the bidders list', 'Portal', 'Spec sheets'];
    const od = wb.addWorksheet('Outreach Drafts');
    [['EMAIL 1', 'Bistro One (new location)'], ['Persona', 'Owner-Operator'], ['Channel', 'Email'], ['To', 'Pat Owner'], ['Subject', 'Your new kitchen'],
      ['Body', 'Hi Pat,'], [null, 'Congrats on the new spot. We can help with layout:'], [null, '    •  Review the layout'], [null, '    •  Firm install timeline'],
      [null, 'Do you have 20 minutes?'], [null, 'Best regards,'], [null, '[Rep name]']].forEach((r, i) => { od.getRow(4 + i).values = r; });
    const sg = wb.addWorksheet('Sources & Gaps');
    sg.getRow(4).values = ['Source', 'Reachable?', 'Notes'];
    sg.getRow(5).values = ['Local food news', 'Yes', 'Most leads come from here.'];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const L = (business, extra = {}) => ({ priority: 'Hot', branch: 'Portland', business, stage: 'Announced', deal_size: '$100K–$200K (rough)', persona: 'Owner-Operator', status: 'New', ...extra });

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await req('POST', '/api/login', { password: 'test-pass' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(() => server.close());

test('deal size, business key and branch helpers', () => {
  assert.deepEqual(pipeline.parseDeal('$250K–$500K (8,539 sq ft)'), [250000, 500000]);
  assert.deepEqual(pipeline.parseDeal('$5K–$25K/yr (supplies)'), [5000, 25000]);
  assert.deepEqual(pipeline.parseDeal('$100K–$200K per unit × 10 (≈$1M–$2M)'), [100000, 200000]);
  assert.deepEqual(pipeline.parseDeal('$1.2M to $2M'), [1200000, 2000000]);
  assert.deepEqual(pipeline.parseDeal('$0 now; future build-out'), [0, 0]);
  assert.deepEqual(pipeline.parseDeal('Varies'), [null, null]);
  assert.equal(pipeline.businessKey("Papa Murphy's – 3 Bend stores (ownership change)"), pipeline.businessKey("Papa Murphy's – Bend stores (new franchisee)"));
  assert.equal(pipeline.primaryBranch('Springfield (Eugene)'), 'Springfield');
  assert.equal(pipeline.primaryBranch('All Oregon branches'), null);
});

test('import requires auth and a real xlsx', async () => {
  const saved = cookie; cookie = null;
  assert.equal((await req('POST', '/api/pipeline/import', Buffer.from('x'))).status, 401);
  cookie = saved;
  assert.equal((await req('POST', '/api/pipeline/import', Buffer.from('not a spreadsheet'))).status, 400);
});

test('weekly import: lists, personas, drafts, exec notes, one-list-per-business rule', async () => {
  const buf = await makeWorkbook('Nov 2, 2026', {
    leads: [
      L('Bistro One (new location)', { branch: 'Boise', deal_size: '$250K–$500K' }),
      L('City Kitchen Bid', { persona: 'Procurement Officer', stage: 'Open bid – closes Nov 18, 2026', deal_size: '$40K–$120K' }),
      L("Steak House (sale to group)", { priority: 'Warm', branch: 'Springfield (Eugene)', deal_size: '$20K–$100K' }),
    ],
    switches: [
      L('School District – kitchen program', { list_type: 'switch', branch: 'Springfield (Eugene)', deal_size: '$300K–$1M+' }),
      L('Steak House (new local owners)', { priority: 'Warm' }),
    ],
    chains: [L('Burger Chain Franchisee', { branch: 'All branches', deal_size: '$100K–$200K per unit' })],
  });
  const r = await req('POST', '/api/pipeline/import', buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.week, '2026-11-02');
  assert.equal(r.body.created, 5);
  assert.equal(r.body.duplicates.length, 1, 'Steak House kept on one list only');
  assert.equal(r.body.personas, 2);
  assert.equal(r.body.drafts, 1);

  const { body: s } = await req('GET', '/api/pipeline/summary?week=2026-11-02');
  assert.deepEqual(
    [s.tiles.new_leads, s.tiles.hot_leads, s.tiles.switch_prospects, s.tiles.chain_accounts, s.tiles.pipeline_low, s.tiles.pipeline_high, s.tiles.hot_unassigned, s.tiles.still_new],
    [3, 2, 1, 1, 310000, 720000, 2, 3]);
  const spr = s.branches.find(b => b.branch === 'Springfield');
  assert.deepEqual([spr.leads, spr.hot, spr.switch, spr.low, spr.high], [1, 0, 1, 320000, 1100000]);
  assert.equal(s.report.headline, 'Two bids close soon. Win those first.');
  assert.equal(s.report.focus[0].action, 'Bid A: price to GCs');
  assert.equal(s.report.plays[0].title, 'Big Chain');
  assert.equal(s.report.risks[0], 'Liquor-license data is blocked.');
  assert.equal(s.report.sources.length, 1);

  const bid = (await req('GET', '/api/opportunities?q=City Kitchen')).body[0];
  assert.equal(bid.deadline, '2026-11-18', 'bid closing date extracted');
  const bistro = (await req('GET', '/api/opportunities?q=Bistro')).body[0];
  assert.match(bistro.outreach_body, /^Hi Pat,\n\nCongrats/);
  assert.match(bistro.outreach_body, /layout:\n•  Review the layout\n•  Firm install timeline\n\nDo you have/);
  assert.match(bistro.outreach_body, /Best regards,\n\[Rep name\]$/);
  const detail = (await req('GET', `/api/opportunities/${bistro.id}`)).body;
  assert.equal(detail.personas[0].name, 'Owner-Operator');
});

test("reps' updates carry over when next week's file is imported", async () => {
  const bistro = (await req('GET', '/api/opportunities?q=Bistro')).body[0];
  await req('PATCH', `/api/opportunities/${bistro.id}`, { assigned_rep: 'Dana', status: 'Meeting set', current_supplier: 'Competitor Co' });
  await req('POST', `/api/opportunities/${bistro.id}/notes`, { text: 'Met the owner on site' });

  const buf = await makeWorkbook('Nov 9, 2026', {
    leads: [
      L('Bistro One (new location)', { branch: 'Boise', stage: 'Permit approved', deal_size: '$300K–$600K', assigned_rep: '', status: 'New', current_supplier: 'Unknown – ask' }),
      L('Brand New Cafe', { priority: 'Warm' }),
    ],
    extraSheets: false,
  });
  const r = await req('POST', '/api/pipeline/import', buf);
  assert.deepEqual([r.body.week, r.body.created, r.body.updated], ['2026-11-09', 1, 1]);

  const o = (await req('GET', `/api/opportunities/${bistro.id}`)).body;
  assert.equal(o.stage, 'Permit approved', 'scan fields refresh');
  assert.equal(o.deal_high, 600000);
  assert.equal(o.assigned_rep, 'Dana', 'rep fields preserved');
  assert.equal(o.status, 'Meeting set');
  assert.equal(o.current_supplier, 'Competitor Co');
  assert.equal(o.first_seen_week, '2026-11-02');
  assert.equal(o.last_seen_week, '2026-11-09');
  assert.ok(o.activity.some(a => a.summary === 'Met the owner on site'));
  assert.ok(o.activity.some(a => a.summary === 'Status: New → Meeting set'));
  assert.match(o.outreach_body, /Hi Pat/, 'existing draft kept when the new file has none');

  const { body: s } = await req('GET', '/api/pipeline/summary?week=2026-11-09');
  assert.equal(s.tiles.new_leads, 2);
  assert.deepEqual(s.weeks, ['2026-11-09', '2026-11-02']);
  assert.equal(s.report.focus[0].action, 'Bid A: price to GCs', 'written focus list imported for the new week');
  // Suggestions rank open Hot items: hard deadline first, then biggest deal.
  assert.equal(s.suggested_focus[0].opp.business, 'Bistro One (new location)');
});

test('manual add, duplicate guard, validation, weekly report edits', async () => {
  const c = await req('POST', '/api/opportunities', { business: 'Taco Spot', priority: 'Hot', branch: 'Bend', deal_size: '$10K–$40K' });
  assert.equal(c.status, 201);
  assert.equal(c.body.deal_low, 10000);
  assert.equal((await req('POST', '/api/opportunities', { business: 'Taco Spot (second unit)' })).status, 409);
  assert.equal((await req('PATCH', `/api/opportunities/${c.body.id}`, { status: 'Maybe' })).status, 400);
  assert.equal((await req('PATCH', `/api/opportunities/${c.body.id}`, { priority: 'Lukewarm' })).status, 400);
  const rep = await req('PUT', '/api/pipeline/reports/2026-11-09', { headline: 'Close the bids', focus: [{ action: 'Call Taco Spot', branch: 'Bend', deadline: 'Fri', deal: '$40K', why: 'Fast' }] });
  assert.equal(rep.body.focus[0].action, 'Call Taco Spot');
  assert.equal((await req('PUT', '/api/pipeline/reports/2026-11-09', { risks: 'nope' })).status, 400);
  const open = (await req('GET', '/api/opportunities?open=true&rep=__none')).body;
  assert.ok(open.every(o => !o.assigned_rep));
});

test('Excel export rebuilds the workbook and re-imports cleanly', async () => {
  const r = await req('GET', '/api/pipeline/export.xlsx?week=2026-11-02');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /Curtis_Weekly_Leads_2026-11-02\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body);
  const names = wb.worksheets.map(w => w.name);
  for (const n of ['Executive Summary', "This Week's Leads", 'Switch Prospects', 'Chain & Franchisee Accounts', 'Personas', 'Outreach Drafts', 'Sources & Gaps']) assert.ok(names.includes(n), n);
  assert.ok(names.some(n => n.startsWith('Brief – City Kitchen')), 'brief tab per Hot lead');
  const leads = wb.getWorksheet("This Week's Leads");
  assert.equal(leads.getCell('A4').value, 'Priority');
  assert.equal(leads.getCell('V4').fill.fgColor.argb, 'FFB7791F', 'rep columns are gold');
  assert.ok(leads.getCell('W5').dataValidation.formulae[0].includes('Meeting set'));
  const ex = wb.getWorksheet('Executive Summary');
  const cells = []; ex.eachRow(row => row.eachCell(c => cells.push(c.value)));
  assert.ok(cells.some(v => v && v.formula && v.formula.startsWith('COUNTA(')), 'live formulas');

  // Round trip into a fresh in-memory database via the module (not the server's DB).
  const before = (await req('GET', '/api/pipeline/summary?week=2026-11-02')).body.tiles;
  const again = await req('POST', '/api/pipeline/import?week=2026-11-02', r.body);
  assert.equal(again.body.created, 0);
  const after = (await req('GET', '/api/pipeline/summary?week=2026-11-02')).body.tiles;
  assert.deepEqual(after, before, 're-importing our own export changes nothing');
});

test('prospect can be linked to a marketing contact', async () => {
  const o = (await req('GET', '/api/opportunities?q=Bistro')).body[0];
  const c = await req('POST', `/api/opportunities/${o.id}/contact`, { email: 'pat@bistro.com', first_name: 'Pat' });
  assert.equal(c.body.company, 'Bistro One (new location)');
  assert.ok(c.body.tags.includes('pipeline'));
});

test('JSON scan endpoint (used by the scheduled weekly research) merges like the Excel import', async () => {
  const bistro = (await req('GET', '/api/opportunities?q=Bistro')).body[0];
  assert.equal((await req('POST', '/api/pipeline/scan', { week: 'nope', opportunities: [] })).status, 400);
  const r = await req('POST', '/api/pipeline/scan', {
    week: '2026-11-16',
    opportunities: [
      { list_type: 'lead', priority: 'Hot', branch: 'Medford', business: 'Fresh Diner', stage: 'Open bid – closes Dec 1, 2026', deal_size: '$30K–$90K', deadline: '2026-12-01' },
      { list_type: 'lead', priority: 'Warm', business: 'Bistro One (new location)', stage: 'Opening soon', assigned_rep: '', status: 'New' },
      { list_type: 'switch', priority: 'Warm', business: 'Fresh Diner (ownership change)' },
      { list_type: 'lead', priority: 'Scorching', business: 'Bad Row' },
    ],
    personas: [{ name: 'Facilities Manager', message: 'Uptime' }],
    report: { headline: 'Scan headline', focus: [{ action: 'Call Fresh Diner' }], plays: [], risks: [], sources: [] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.created, r.body.updated, r.body.duplicates.length, r.body.errors.length, r.body.personas, r.body.report], [1, 1, 1, 1, 1, true]);
  const o = (await req('GET', `/api/opportunities/${bistro.id}`)).body;
  assert.equal(o.assigned_rep, 'Dana', 'rep assignment survives the automated scan');
  assert.equal(o.status, 'Meeting set');
  assert.equal(o.last_seen_week, '2026-11-16');
  assert.equal((await req('GET', '/api/pipeline/summary?week=2026-11-16')).body.report.headline, 'Scan headline');
});

test('API key auth works for automation', async () => {
  const saved = cookie; cookie = null;
  assert.equal((await req('GET', '/api/opportunities', null, { authorization: 'Bearer wrong' })).status, 401);
  cookie = saved;
});

test('automated scans never overwrite imported or hand-edited weekly notes', async () => {
  // 2026-11-02 notes came from the imported workbook.
  const r = await req('POST', '/api/pipeline/scan', { week: '2026-11-02', opportunities: [], report: { headline: 'Scan headline', focus: [], plays: [], risks: [], sources: [] } });
  assert.match(String(r.body.report), /^kept/);
  assert.equal((await req('GET', '/api/pipeline/summary?week=2026-11-02')).body.report.headline, 'Two bids close soon. Win those first.');
  // A week the scan wrote itself can be refreshed by the next scan…
  await req('POST', '/api/pipeline/scan', { week: '2026-11-23', opportunities: [], report: { headline: 'First', focus: [], plays: [], risks: [], sources: [] } });
  const again = await req('POST', '/api/pipeline/scan', { week: '2026-11-23', opportunities: [], report: { headline: 'Second', focus: [], plays: [], risks: [], sources: [] } });
  assert.equal(again.body.report, true);
  // …until someone edits it in the app.
  await req('PUT', '/api/pipeline/reports/2026-11-23', { headline: 'Edited by the sales manager' });
  const third = await req('POST', '/api/pipeline/scan', { week: '2026-11-23', opportunities: [], report: { headline: 'Third', focus: [], plays: [], risks: [], sources: [] } });
  assert.match(String(third.body.report), /edited by hand/);
  assert.equal((await req('GET', '/api/pipeline/summary?week=2026-11-23')).body.report.headline, 'Edited by the sales manager');
});

test('focus list items link to prospects', async () => {
  const bid = (await req('GET', '/api/opportunities?q=City Kitchen')).body[0];
  const bistro = (await req('GET', '/api/opportunities?q=Bistro')).body[0];
  // Plain-text items from a spreadsheet are matched to the business they name.
  await req('PUT', '/api/pipeline/reports/2026-11-30', { focus: [
    { action: 'City Kitchen Bid: price to every GC', branch: 'x', deal: 'y', deadline: 'Price to GCs by Nov 12', why: 'Hard deadline' },
    { action: 'Every open quote: push the Dec 31 tax deadline', branch: 'All', deal: '—', why: 'Year-end' },
  ] });
  let f = (await req('GET', '/api/pipeline/summary?week=2026-11-30')).body.report.focus;
  assert.equal(f[0].opportunity_id, bid.id);
  assert.equal(f[0].action, 'price to every GC', 'business name not repeated next to the link');
  assert.equal(f[0].branch, bid.branch, 'branch comes live from the prospect');
  assert.equal(f[0].deadline, 'Price to GCs by Nov 12', 'written do-by note kept');
  assert.equal(f[0].opp.status, bid.status);
  assert.equal(f[1].opportunity_id, null, 'general items stay general');
  assert.equal(f[1].branch, 'All');

  // Saving with explicit links; changes on the prospect show up immediately.
  await req('PUT', '/api/pipeline/reports/2026-11-30', { focus: [{ opportunity_id: bistro.id, action: 'Site visit', why: 'Order window' }, ...f] });
  await req('PATCH', `/api/opportunities/${bistro.id}`, { assigned_rep: 'Alex', status: 'Quoted' });
  f = (await req('GET', '/api/pipeline/summary?week=2026-11-30')).body.report.focus;
  assert.deepEqual([f[0].opp.business, f[0].opp.assigned_rep, f[0].opp.status, f[0].action], ['Bistro One (new location)', 'Alex', 'Quoted', 'Site visit']);
  assert.equal(f.length, 3);

  // Add straight from a prospect; no duplicates.
  const added = await req('POST', '/api/pipeline/reports/2026-12-07/focus', { opportunity_id: bid.id });
  assert.equal(added.status, 201);
  assert.equal((await req('POST', '/api/pipeline/reports/2026-12-07/focus', { opportunity_id: bid.id })).status, 409);
  assert.equal((await req('POST', '/api/pipeline/reports/2026-12-07/focus', { opportunity_id: 99999 })).status, 404);
  // A scan may refer to a business by name instead of id.
  await req('POST', '/api/pipeline/scan', { week: '2026-12-14', opportunities: [], report: { headline: 'h', focus: [{ business: 'Bistro One (new location)', action: 'Call the owner' }], plays: [], risks: [], sources: [] } });
  assert.equal((await req('GET', '/api/pipeline/summary?week=2026-12-14')).body.report.focus[0].opportunity_id, bistro.id);
  // Excel export writes the business name with the action.
  const x = await req('GET', '/api/pipeline/export.xlsx?week=2026-11-30');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
  const cells = []; wb.getWorksheet('Executive Summary').eachRow(r => r.eachCell(c => cells.push(String(c.value))));
  assert.ok(cells.includes('Bistro One: Site visit'));
});
