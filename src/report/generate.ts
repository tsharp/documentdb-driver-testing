#!/usr/bin/env ts-node
/**
 * Aggregates one or more MatrixJsonReporter output files into a self-contained
 * HTML report with two interactive views:
 *
 *   Overview  — heatmap grid (servers × drivers) showing % pass per cell.
 *               Click any cell to drill into that server+driver in the Matrix.
 *
 *   Matrix    — filterable feature compatibility table.
 *               Filter by server(s) and/or driver(s), group columns by either
 *               axis, filter rows by status, collapse scenario sections.
 *
 * Usage:
 *   ts-node src/report/generate.ts [--output out/report.html] out/results-*.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import fg from 'fast-glob';
import type { MatrixRunFile } from '../reporters/MatrixJsonReporter';

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string: ['output'],
  default: { output: 'out/report.html' },
});

const outputPath = resolve(String(argv['output']));
const inputPatterns: string[] = (argv['_'].length ? argv['_'] : ['out/results-*.json']).map(
  (p: string) => p.replace(/\\/g, '/'),
);

// ── Load data ─────────────────────────────────────────────────────────────────

const inputFiles = fg.sync(inputPatterns, { absolute: true });
if (inputFiles.length === 0) {
  console.error(`No result files found matching: ${inputPatterns.join(', ')}`);
  process.exit(1);
}

const runs: MatrixRunFile[] = inputFiles.map((f) =>
  JSON.parse(readFileSync(f, 'utf-8')) as MatrixRunFile,
);

// ── Build normalised data model ───────────────────────────────────────────────

interface Server { id: string; label: string; }
interface Driver { id: string; label: string; }
interface Test   { id: string; scenario: string; name: string; }
interface Cell   { status: 'pass' | 'fail' | 'skip'; message?: string; }
interface Stats  { pass: number; fail: number; skip: number; total: number; }

const serverMap = new Map<string, Server>();
const driverMap = new Map<string, Driver>();
const testMap   = new Map<string, Test>();
const cellMap   = new Map<string, Cell>();   // key: serverId|driverId|testId

for (const run of runs) {
  const { target, targetVersion } = run.meta;
  const sid = `${target}@${targetVersion}`;
  if (!serverMap.has(sid)) {
    serverMap.set(sid, { id: sid, label: `${target} v${targetVersion}` });
  }
  for (const r of run.results) {
    const did = `${r.adapter}@${r.adapterVersion}`;
    if (!driverMap.has(did)) {
      driverMap.set(did, { id: did, label: `${r.adapter} v${r.adapterVersion}` });
    }
    const tid = `${r.scenario}\x00${r.test}`;
    if (!testMap.has(tid)) {
      testMap.set(tid, { id: tid, scenario: r.scenario, name: r.test });
    }
    cellMap.set(`${sid}|${did}|${tid}`, {
      status: r.status,
      ...(r.message ? { message: r.message } : {}),
    });
  }
}

const servers  = [...serverMap.values()].sort((a, b) => a.id.localeCompare(b.id));
const drivers  = [...driverMap.values()].sort((a, b) => a.id.localeCompare(b.id));
const tests    = [...testMap.values()].sort((a, b) => {
  const sc = a.scenario.localeCompare(b.scenario);
  return sc !== 0 ? sc : a.name.localeCompare(b.name);
});
const scenarios = [...new Set(tests.map((t) => t.scenario))];

// Pre-compute stats[serverId][driverId]
const stats: Record<string, Record<string, Stats>> = {};
for (const s of servers) {
  stats[s.id] = {};
  for (const d of drivers) {
    let pass = 0, fail = 0, skip = 0;
    for (const t of tests) {
      const c = cellMap.get(`${s.id}|${d.id}|${t.id}`);
      if (c) { if (c.status === 'pass') pass++; else if (c.status === 'fail') fail++; else skip++; }
    }
    stats[s.id][d.id] = { pass, fail, skip, total: pass + fail + skip };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Embed DATA ────────────────────────────────────────────────────────────────

const DATA = {
  servers:   servers.map((s) => ({ id: s.id, label: s.label })),
  drivers:   drivers.map((d) => ({ id: d.id, label: d.label })),
  scenarios,
  tests:     tests.map((t) => ({ id: t.id, scenario: t.scenario, name: t.name })),
  cells:     Object.fromEntries(cellMap.entries()),
  stats,
  generated: new Date().toUTCString(),
  timestamps: runs.map((r) => r.meta.timestamp),
};

// Escape </script> in the embedded JSON to avoid breaking the HTML parser.
const dataJson = JSON.stringify(DATA).replace(/<\/script>/gi, '<\\/script>');

// ── HTML template ─────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Driver Compatibility Matrix</title>
<style>
:root {
  --pass:#22c55e; --fail:#ef4444; --skip:#f59e0b; --miss:#e2e8f0;
  --head:#1e293b; --head2:#334155; --bg:#f1f5f9; --bd:#e2e8f0;
  --text:#0f172a; --sub:#64748b; --r:6px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font:13px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--text)}
a{color:inherit}

/* ── Header ── */
header{background:var(--head);color:#fff;padding:16px 24px}
header h1{font-size:1.25rem;font-weight:700}
header p{font-size:.75rem;color:#94a3b8;margin-top:3px}

/* ── Tabs ── */
.tabs{background:#fff;border-bottom:1px solid var(--bd);padding:0 24px;display:flex}
.tab-btn{border:none;background:none;padding:11px 18px;cursor:pointer;font-size:.82rem;font-weight:600;color:var(--sub);border-bottom:3px solid transparent;transition:.1s}
.tab-btn.active{color:var(--head);border-bottom-color:#3b82f6}

/* ── Filter bar ── */
.filter-bar{background:#fff;border-bottom:1px solid var(--bd);padding:8px 24px;display:flex;flex-direction:column;gap:6px}
.filter-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.filter-row-label{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--sub);min-width:56px}
.pill{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--bd);border-radius:20px;padding:3px 10px;cursor:pointer;font-size:.75rem;transition:.1s;user-select:none}
.pill.active{background:var(--head);color:#fff;border-color:var(--head)}
.pill input{display:none}
.btn-grp{display:flex;border:1px solid var(--bd);border-radius:var(--r);overflow:hidden}
.btn-grp button{border:none;border-left:1px solid var(--bd);background:#fff;padding:4px 11px;cursor:pointer;font-size:.75rem;color:var(--sub)}
.btn-grp button:first-child{border-left:none}
.btn-grp button.active{background:var(--head);color:#fff}
.sep{width:1px;background:var(--bd);margin:0 6px}

/* ── Tab panels ── */
.tab-panel{display:none;padding:20px 24px}
.tab-panel.active{display:block}

/* ── Heatmap ── */
.hm-wrap{overflow-x:auto}
.hm-intro{color:var(--sub);font-size:.8rem;margin-bottom:12px}
.hm-table{border-collapse:collapse}
.hm-corner{background:var(--head);color:#fff;padding:8px 14px;text-align:left;font-size:.78rem;min-width:180px;position:sticky;left:0;z-index:2}
.hm-dh{background:var(--head2);color:#fff;padding:8px 12px;white-space:nowrap;font-size:.75rem;text-align:center;border:1px solid #475569;min-width:110px}
.hm-sh{background:#fff;font-weight:700;padding:10px 14px;white-space:nowrap;border:1px solid var(--bd);font-size:.8rem;position:sticky;left:0;z-index:1}
.hm-cell{padding:0;text-align:center;cursor:pointer;border:1px solid rgba(255,255,255,.15);transition:filter .1s}
.hm-cell:hover{filter:brightness(.88)}
.hm-inner{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 14px;gap:2px}
.hm-pct{font-size:1.15rem;font-weight:700}
.hm-det{font-size:.68rem;opacity:.85}
.hm-no{font-size:.8rem;color:#94a3b8}

/* ── Matrix ── */
.mx-wrap{overflow:auto;max-height:calc(100vh - 290px);margin-top:14px;border-radius:var(--r);border:1px solid var(--bd)}
.mx-empty{color:var(--sub);text-align:center;padding:48px;font-size:.9rem}
.mx-table{border-collapse:collapse;min-width:100%}
.mx-table thead tr:first-child th{background:var(--head);color:#fff;padding:6px 10px;white-space:nowrap;text-align:center;border:1px solid #475569;font-size:.82rem;position:sticky;top:0;z-index:5}
.mx-table thead tr:nth-child(2) th{background:var(--head2);color:#fff;padding:5px 8px;font-size:.72rem;font-weight:500;text-align:center;border:1px solid #475569;white-space:nowrap;position:sticky;top:33px;z-index:5}
.mx-corner{text-align:left !important;min-width:200px;position:sticky;left:0;z-index:10 !important}
.mx-table tbody tr:hover td{background:#f8fafc}
.sc-hdr td{background:#e8edf3;font-weight:700;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--sub);padding:4px 10px;cursor:pointer;user-select:none;border-bottom:1px solid #cbd5e1}
.sc-hdr:hover td{background:#dde3ec}
.sc-arrow{font-size:.6rem}
.sc-pct{font-size:.68rem;padding:2px 6px;border-radius:10px;margin-left:4px;font-weight:700}
.test-row td{border-bottom:1px solid #f1f5f9}
.mx-name{text-align:left;padding:5px 10px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;background:#fff;position:sticky;left:0;z-index:2;border-right:1px solid var(--bd);font-size:.8rem}
.mx-cell{text-align:center;padding:4px 5px;border-right:1px solid var(--bd)}
.mx-foot td{background:var(--head);color:#fff;font-weight:700;font-size:.72rem;padding:5px 8px;text-align:center;border-right:1px solid #475569;position:sticky;bottom:0;z-index:4}
.mx-foot .mx-corner{z-index:10 !important}

/* ── Cell icons ── */
.ci{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;font-size:.82rem;font-weight:700}
.ci-pass{background:var(--pass);color:#fff}
.ci-fail{background:var(--fail);color:#fff;cursor:help;position:relative}
.ci-skip{background:var(--skip);color:#fff;cursor:help;position:relative}
.ci-miss{background:var(--miss);color:#94a3b8}
.ci-fail[title]:hover::after,.ci-skip[title]:hover::after{content:attr(title);position:absolute;z-index:20;left:50%;top:26px;transform:translateX(-50%);background:#1e293b;color:#fff;font-size:.7rem;padding:5px 8px;border-radius:5px;width:max-content;max-width:300px;white-space:pre-wrap;word-break:break-word;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:none}

/* ── Legend ── */
.legend{display:flex;gap:10px;align-items:center;margin-left:auto}
.leg{display:flex;align-items:center;gap:4px;font-size:.75rem}
</style>
</head>
<body>

<header>
  <h1>Driver Compatibility Matrix</h1>
  <p id="meta-line">Loading…</p>
</header>

<nav class="tabs">
  <button class="tab-btn active" data-tab="overview" onclick="switchTab('overview')">Overview</button>
  <button class="tab-btn" data-tab="matrix" onclick="switchTab('matrix')">Matrix</button>
</nav>

<div class="filter-bar">
  <div class="filter-row">
    <span class="filter-row-label">Servers</span>
    <span id="filter-servers"></span>
    <span class="sep"></span>
    <div class="legend">
      <div class="leg"><span class="ci ci-pass">✓</span>Pass</div>
      <div class="leg"><span class="ci ci-fail">✗</span>Fail</div>
      <div class="leg"><span class="ci ci-skip">–</span>Skip</div>
      <div class="leg"><span class="ci ci-miss">·</span>Not run</div>
    </div>
  </div>
  <div class="filter-row">
    <span class="filter-row-label">Drivers</span>
    <span id="filter-drivers"></span>
    <span class="sep"></span>
    <span class="filter-row-label" style="min-width:auto">Group by</span>
    <div class="btn-grp">
      <button class="groupby-btn active" data-mode="server" onclick="setGroupBy('server')">Server</button>
      <button class="groupby-btn" data-mode="driver" onclick="setGroupBy('driver')">Driver</button>
    </div>
    <span class="sep"></span>
    <span class="filter-row-label" style="min-width:auto">Show</span>
    <div class="btn-grp">
      <button class="status-btn active" data-f="all"  onclick="setStatusFilter('all')">All</button>
      <button class="status-btn" data-f="fail" onclick="setStatusFilter('fail')">Failures</button>
      <button class="status-btn" data-f="skip" onclick="setStatusFilter('skip')">Skips</button>
      <button class="status-btn" data-f="pass" onclick="setStatusFilter('pass')">Passes</button>
    </div>
  </div>
</div>

<div id="tab-overview" class="tab-panel active"></div>
<div id="tab-matrix"   class="tab-panel">
  <div id="mx-wrap-outer"></div>
</div>

<script>
var D = ${dataJson};

// ── State ────────────────────────────────────────────────────────────────────
var activeTab = 'overview';
var selServers = new Set(D.servers.map(function(s){return s.id;}));
var selDrivers = new Set(D.drivers.map(function(d){return d.id;}));
var groupBy = 'server';
var statusFilter = 'all';
var collapsed = new Set();

// ── Utilities ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function pct(pass, total) { return total ? Math.round(pass/total*100) : null; }
function pctBg(p) {
  if (p === null) return '#e2e8f0';
  if (p >= 100) return '#22c55e'; if (p >= 80) return '#86efac';
  if (p >= 60) return '#fde047'; if (p >= 40) return '#fb923c';
  return '#ef4444';
}
function pctFg(p) {
  if (p === null) return '#94a3b8';
  if (p >= 80) return '#14532d'; if (p >= 60) return '#713f12';
  return '#7f1d1d';
}
function getStats(sid, did) {
  return (D.stats[sid] && D.stats[sid][did]) || {pass:0,fail:0,skip:0,total:0};
}
function getCell(sid, did, tid) { return D.cells[sid+'|'+did+'|'+tid]; }
function ciHtml(cell) {
  if (!cell) return '<span class="ci ci-miss">·</span>';
  var msg = cell.message ? esc(cell.message) : '';
  if (cell.status==='pass') return '<span class="ci ci-pass">✓</span>';
  if (cell.status==='fail') return '<span class="ci ci-fail" title="'+msg+'">✗</span>';
  if (cell.status==='skip') return '<span class="ci ci-skip" title="'+msg+'">–</span>';
  return '<span class="ci ci-miss">·</span>';
}

// ── Filters ──────────────────────────────────────────────────────────────────
function renderFilterBar() {
  var sh = '';
  D.servers.forEach(function(s) {
    var on = selServers.has(s.id);
    sh += '<label class="pill'+(on?' active':'')+'"><input type="checkbox"'+(on?' checked':'')+
          ' data-id="'+s.id+'" onchange="toggleServer(this.dataset.id)"> '+esc(s.label)+'</label> ';
  });
  document.getElementById('filter-servers').innerHTML = sh;

  var dh = '';
  D.drivers.forEach(function(d) {
    var on = selDrivers.has(d.id);
    dh += '<label class="pill'+(on?' active':'')+'"><input type="checkbox"'+(on?' checked':'')+
          ' data-id="'+d.id+'" onchange="toggleDriver(this.dataset.id)"> '+esc(d.label)+'</label> ';
  });
  document.getElementById('filter-drivers').innerHTML = dh;
}

function toggleServer(id) {
  if (selServers.has(id)) selServers.delete(id); else selServers.add(id);
  renderFilterBar(); render();
}
function toggleDriver(id) {
  if (selDrivers.has(id)) selDrivers.delete(id); else selDrivers.add(id);
  renderFilterBar(); render();
}
function setGroupBy(mode) {
  groupBy = mode;
  document.querySelectorAll('.groupby-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===mode);});
  render();
}
function setStatusFilter(f) {
  statusFilter = f;
  document.querySelectorAll('.status-btn').forEach(function(b){b.classList.toggle('active',b.dataset.f===f);});
  render();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===tab);});
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.toggle('active',p.id==='tab-'+tab);});
  render();
}

// ── Overview (heatmap) ────────────────────────────────────────────────────────
function renderOverview() {
  var aServers = D.servers.filter(function(s){return selServers.has(s.id);});
  var aDrivers = D.drivers.filter(function(d){return selDrivers.has(d.id);});
  if (!aServers.length || !aDrivers.length) {
    document.getElementById('tab-overview').innerHTML = '<p class="mx-empty">Select at least one server and one driver.</p>';
    return;
  }
  var h = '<div class="hm-wrap">';
  h += '<p class="hm-intro">Click a cell to drill into that server + driver in the Matrix view.</p>';
  h += '<table class="hm-table"><thead><tr>';
  h += '<th class="hm-corner">Server \\ Driver</th>';
  aDrivers.forEach(function(d){h+='<th class="hm-dh">'+esc(d.label)+'</th>';});
  h += '</tr></thead><tbody>';
  aServers.forEach(function(s) {
    h += '<tr><td class="hm-sh">'+esc(s.label)+'</td>';
    aDrivers.forEach(function(d) {
      var st = getStats(s.id, d.id);
      var p = pct(st.pass, st.total);
      var bg = pctBg(p); var fg = pctFg(p);
      var tip = esc(s.label)+' / '+esc(d.label)+': '+(p!==null?st.pass+'/'+st.total+' passed ('+p+'%)':'No data');
      h += '<td class="hm-cell" style="background:'+bg+'" title="'+tip+'" data-sid="'+s.id+'" data-did="'+d.id+'" onclick="drillDown(this.dataset.sid,this.dataset.did)">';
      if (p !== null) {
        h += '<div class="hm-inner" style="color:'+fg+'">';
        h += '<span class="hm-pct">'+p+'%</span>';
        h += '<span class="hm-det">'+st.pass+'/'+st.total+'</span></div>';
      } else {
        h += '<div class="hm-inner"><span class="hm-no">–</span></div>';
      }
      h += '</td>';
    });
    h += '</tr>';
  });
  h += '</tbody></table></div>';
  document.getElementById('tab-overview').innerHTML = h;
}

function drillDown(sid, did) {
  selServers.clear(); selServers.add(sid);
  selDrivers.clear(); selDrivers.add(did);
  renderFilterBar(); switchTab('matrix');
}

// ── Matrix ────────────────────────────────────────────────────────────────────
function buildCols() {
  var aServers = D.servers.filter(function(s){return selServers.has(s.id);});
  var aDrivers = D.drivers.filter(function(d){return selDrivers.has(d.id);});
  var cols = [];
  if (groupBy === 'server') {
    aServers.forEach(function(s){aDrivers.forEach(function(d){cols.push({primary:s.id,primaryLabel:s.label,secondary:d.id,secondaryLabel:d.label,sid:s.id,did:d.id});});});
  } else {
    aDrivers.forEach(function(d){aServers.forEach(function(s){cols.push({primary:d.id,primaryLabel:d.label,secondary:s.id,secondaryLabel:s.label,sid:s.id,did:d.id});});});
  }
  return cols;
}

function testVisible(test, cols) {
  if (statusFilter === 'all') return true;
  return cols.some(function(col){
    var c = getCell(col.sid, col.did, test.id);
    return c && c.status === statusFilter;
  });
}

function renderMatrix() {
  var cols = buildCols();
  var el = document.getElementById('mx-wrap-outer');
  if (!cols.length) { el.innerHTML = '<p class="mx-empty">Select at least one server and one driver.</p>'; return; }

  // Primary group headers
  var groups = [];
  cols.forEach(function(col) {
    var last = groups[groups.length-1];
    if (last && last.id === col.primary) last.count++;
    else groups.push({id:col.primary,label:col.primaryLabel,count:1});
  });

  var h = '<div class="mx-wrap"><table class="mx-table"><thead>';
  h += '<tr><th class="mx-corner" rowspan="2">Feature / Test</th>';
  groups.forEach(function(g){h+='<th colspan="'+g.count+'">'+esc(g.label)+'</th>';});
  h += '</tr><tr>';
  cols.forEach(function(col){h+='<th>'+esc(col.secondaryLabel)+'</th>';});
  h += '</tr></thead><tbody>';

  D.scenarios.forEach(function(sc) {
    var scTests = D.tests.filter(function(t){return t.scenario===sc && testVisible(t,cols);});
    if (!scTests.length) return;
    var isCollapsed = collapsed.has(sc);
    var scPass=0, scTotal=0;
    scTests.forEach(function(t){cols.forEach(function(col){var c=getCell(col.sid,col.did,t.id);if(c){scTotal++;if(c.status==='pass')scPass++;}});});
    var p = pct(scPass, scTotal);
    var scPctHtml = p!==null?'<span class="sc-pct" style="background:'+pctBg(p)+';color:'+pctFg(p)+'">'+p+'%</span>':'';
    var arrowEsc = isCollapsed ? '▶' : '▼';
    h += '<tr class="sc-hdr" data-sc="'+sc+'" onclick="toggleSc(this.dataset.sc)">'+'<td colspan="'+(cols.length+1)+'">';
    h += '<span class="sc-arrow">'+arrowEsc+'</span> '+esc(sc)+scPctHtml+'</td></tr>';
    if (!isCollapsed) {
      scTests.forEach(function(t) {
        h += '<tr class="test-row"><td class="mx-name" title="'+esc(t.name)+'">'+esc(t.name)+'</td>';
        cols.forEach(function(col){h+='<td class="mx-cell">'+ciHtml(getCell(col.sid,col.did,t.id))+'</td>';});
        h += '</tr>';
      });
    }
  });

  h += '</tbody><tfoot class="mx-foot"><tr><td class="mx-corner">Total (pass/total)</td>';
  cols.forEach(function(col){
    var st=getStats(col.sid,col.did);
    h+='<td title="pass '+st.pass+' / fail '+st.fail+' / skip '+st.skip+'">'+st.pass+'/'+st.total+'</td>';
  });
  h += '</tr></tfoot></table></div>';
  el.innerHTML = h;
}

function toggleSc(name) {
  if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
  renderMatrix();
}

// ── Main render dispatch ──────────────────────────────────────────────────────
function render() {
  if (activeTab === 'overview') renderOverview();
  else renderMatrix();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('meta-line').textContent =
  'Generated: ' + D.generated + '  ·  ' + D.servers.length + ' server(s)  ·  ' + D.drivers.length + ' driver(s)  ·  ' + D.tests.length + ' tests';
renderFilterBar();
render();
</script>
</body>
</html>`;

writeFileSync(outputPath, html, 'utf-8');
console.log(`Report written to ${outputPath}`);
