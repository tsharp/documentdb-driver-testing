#!/usr/bin/env ts-node
/**
 * Aggregates one or more MatrixJsonReporter output files into a single
 * self-contained HTML report showing a feature × driver/target matrix.
 *
 * Usage:
 *   ts-node src/report/generate.ts [--output report.html] results-*.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import fg from 'fast-glob';
import type { MatrixRunFile, MatrixTestResult } from '../reporters/MatrixJsonReporter';

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string: ['output'],
  default: { output: 'report.html' },
});

const outputPath = resolve(String(argv['output']));
const inputPatterns: string[] = (argv['_'].length ? argv['_'] : ['results-*.json']).map(
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

// ── Build column index ────────────────────────────────────────────────────────
// A column = unique (target, targetVersion, adapter, adapterVersion) tuple.

interface Column {
  key: string;
  target: string;
  targetVersion: string;
  adapter: string;
  adapterVersion: string;
  label: string;
  subLabel: string;
}

const columnMap = new Map<string, Column>();

for (const run of runs) {
  const { target, targetVersion } = run.meta;
  for (const r of run.results) {
    const key = `${target}@${targetVersion}|${r.adapter}@${r.adapterVersion}`;
    if (!columnMap.has(key)) {
      columnMap.set(key, {
        key,
        target,
        targetVersion,
        adapter: r.adapter,
        adapterVersion: r.adapterVersion,
        label: `${target} v${targetVersion}`,
        subLabel: `${r.adapter} v${r.adapterVersion}`,
      });
    }
  }
}

const columns = [...columnMap.values()].sort((a, b) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
);

// ── Build row index ───────────────────────────────────────────────────────────
// A row = unique (scenario, test) pair.

interface Row {
  scenario: string;
  test: string;
  rowKey: string;
}

const rowMap = new Map<string, Row>();

for (const run of runs) {
  for (const r of run.results) {
    const rowKey = `${r.scenario}\x00${r.test}`;
    if (!rowMap.has(rowKey)) {
      rowMap.set(rowKey, { scenario: r.scenario, test: r.test, rowKey });
    }
  }
}

// Sort rows: by scenario then test alphabetically.
const rows = [...rowMap.values()].sort((a, b) => {
  const sc = a.scenario.localeCompare(b.scenario);
  return sc !== 0 ? sc : a.test.localeCompare(b.test);
});

// ── Build cell lookup ─────────────────────────────────────────────────────────
// cellMap[rowKey][colKey] = MatrixTestResult

const cellMap = new Map<string, Map<string, MatrixTestResult>>();

for (const run of runs) {
  const { target, targetVersion } = run.meta;
  for (const r of run.results) {
    const colKey = `${target}@${targetVersion}|${r.adapter}@${r.adapterVersion}`;
    const rowKey = `${r.scenario}\x00${r.test}`;
    if (!cellMap.has(rowKey)) cellMap.set(rowKey, new Map());
    cellMap.get(rowKey)!.set(colKey, r);
  }
}

// ── Compute summary stats ─────────────────────────────────────────────────────

interface ColStats {
  pass: number;
  fail: number;
  skip: number;
  total: number;
}

const colStats = new Map<string, ColStats>();
for (const col of columns) {
  colStats.set(col.key, { pass: 0, fail: 0, skip: 0, total: 0 });
}

for (const row of rows) {
  const cells = cellMap.get(row.rowKey);
  if (!cells) continue;
  for (const [colKey, r] of cells.entries()) {
    const s = colStats.get(colKey);
    if (!s) continue;
    s.total++;
    if (r.status === 'pass') s.pass++;
    else if (r.status === 'fail') s.fail++;
    else if (r.status === 'skip') s.skip++;
  }
}

// ── Collect unique scenarios (for grouping) ───────────────────────────────────

const scenarios = [...new Set(rows.map((r) => r.scenario))];

// ── Render HTML ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusIcon(status: 'pass' | 'fail' | 'skip' | 'missing'): string {
  switch (status) {
    case 'pass':
      return '<span class="cell pass" title="Pass">✓</span>';
    case 'fail':
      return '<span class="cell fail" title="Fail">✗</span>';
    case 'skip':
      return '<span class="cell skip" title="Skipped">–</span>';
    default:
      return '<span class="cell missing" title="Not run">·</span>';
  }
}

function cellHtml(row: Row, col: Column): string {
  const r = cellMap.get(row.rowKey)?.get(col.key);
  if (!r) return statusIcon('missing');
  const icon = statusIcon(r.status);
  if (r.message) {
    return `<span class="has-tooltip">${icon}<span class="tooltip">${esc(r.message)}</span></span>`;
  }
  return icon;
}

// Group columns by target label for the top-level header row.
const targetGroups: { label: string; cols: Column[] }[] = [];
for (const col of columns) {
  const last = targetGroups[targetGroups.length - 1];
  if (last && last.label === col.label) {
    last.cols.push(col);
  } else {
    targetGroups.push({ label: col.label, cols: [col] });
  }
}

const generatedAt = new Date().toUTCString();
const runTimestamps = runs.map((r) => r.meta.timestamp).join(', ');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Driver Test Matrix</title>
<style>
  :root {
    --pass:   #22c55e;
    --fail:   #ef4444;
    --skip:   #f59e0b;
    --miss:   #cbd5e1;
    --bg:     #f8fafc;
    --border: #e2e8f0;
    --head:   #1e293b;
    --head2:  #334155;
    --text:   #0f172a;
    --sub:    #64748b;
    --radius: 6px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 13px; }

  header { background: var(--head); color: #fff; padding: 18px 24px; }
  header h1 { font-size: 1.3rem; font-weight: 700; }
  header p  { font-size: 0.78rem; color: #94a3b8; margin-top: 4px; }

  .toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 24px; background: #fff; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .toolbar label { font-weight: 600; font-size: 0.8rem; color: var(--sub); }
  .filter-btn { border: 1px solid var(--border); background: #fff; border-radius: var(--radius); padding: 4px 10px; cursor: pointer; font-size: 0.78rem; }
  .filter-btn.active { background: var(--head); color: #fff; border-color: var(--head); }
  .spacer { flex: 1; }
  .legend { display: flex; gap: 12px; align-items: center; }
  .leg { display: flex; align-items: center; gap: 4px; font-size: 0.78rem; }

  .wrap { overflow-x: auto; padding: 8px 24px 24px; }

  table { border-collapse: collapse; min-width: 100%; }

  thead tr th { background: var(--head); color: #fff; font-weight: 600; padding: 6px 10px; white-space: nowrap; text-align: center; border: 1px solid #475569; }
  thead tr:first-child th.target-group { background: var(--head); border-bottom: 2px solid #475569; font-size: 0.85rem; }
  thead tr:nth-child(2) th { background: var(--head2); font-size: 0.75rem; font-weight: 500; }
  th.row-label { text-align: left; background: var(--head); min-width: 260px; }

  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr:hover { background: #f1f5f9; }
  tbody tr.scenario-header td { background: #e2e8f0; font-weight: 700; font-size: 0.78rem; color: var(--sub); text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 10px; border-bottom: 1px solid #cbd5e1; }
  tbody td { padding: 4px 6px; text-align: center; border-right: 1px solid var(--border); }
  tbody td.test-name { text-align: left; padding: 5px 10px; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; border-right: 1px solid var(--border); }

  tfoot tr td { background: var(--head); color: #fff; font-weight: 700; padding: 5px 8px; text-align: center; font-size: 0.75rem; border-right: 1px solid #475569; }
  tfoot tr td.row-label { text-align: left; padding: 5px 10px; }

  .cell { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; font-size: 0.85rem; font-weight: 700; }
  .cell.pass    { background: var(--pass); color: #fff; }
  .cell.fail    { background: var(--fail); color: #fff; }
  .cell.skip    { background: var(--skip); color: #fff; }
  .cell.missing { background: var(--miss); color: #94a3b8; }

  .has-tooltip { position: relative; cursor: pointer; }
  .tooltip { display: none; position: absolute; z-index: 10; left: 50%; top: 28px; transform: translateX(-50%); background: #1e293b; color: #fff; font-size: 0.72rem; padding: 6px 8px; border-radius: 5px; width: max-content; max-width: 320px; white-space: pre-wrap; word-break: break-word; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  .has-tooltip:hover .tooltip { display: block; }

  .summary-bar { display: flex; gap: 16px; padding: 10px 24px; background: #fff; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .stat { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; }
  .stat-dot { width: 10px; height: 10px; border-radius: 50%; }

  tr[data-status~="pass"]  { }
  tr[data-status~="fail"]  { }
  tr[data-status~="skip"]  { }

  .pct { font-size: 0.7rem; color: #94a3b8; margin-left: 1px; }
</style>
</head>
<body>

<header>
  <h1>Driver Compatibility Matrix</h1>
  <p>Generated: ${esc(generatedAt)} &nbsp;·&nbsp; Run timestamps: ${esc(runTimestamps)}</p>
</header>

<div class="summary-bar">
${columns
  .map((col) => {
    const s = colStats.get(col.key)!;
    const pct = s.total ? Math.round((s.pass / s.total) * 100) : 0;
    return `  <div class="stat"><span class="stat-dot" style="background:var(--pass)"></span><strong>${esc(col.label)}</strong> / ${esc(col.subLabel)}: ${s.pass}/${s.total} passed <span class="pct">(${pct}%)</span></div>`;
  })
  .join('\n')}
</div>

<div class="toolbar">
  <label>Filter:</label>
  <button class="filter-btn active" data-filter="all"    onclick="setFilter('all')">All</button>
  <button class="filter-btn"        data-filter="fail"   onclick="setFilter('fail')">Failures</button>
  <button class="filter-btn"        data-filter="skip"   onclick="setFilter('skip')">Skips</button>
  <button class="filter-btn"        data-filter="pass"   onclick="setFilter('pass')">Passes</button>
  <div class="spacer"></div>
  <div class="legend">
    <div class="leg"><span class="cell pass">✓</span> Pass</div>
    <div class="leg"><span class="cell fail">✗</span> Fail</div>
    <div class="leg"><span class="cell skip">–</span> Skip</div>
    <div class="leg"><span class="cell missing">·</span> Not run</div>
  </div>
</div>

<div class="wrap">
<table id="matrix">
<thead>
  <tr>
    <th class="row-label target-group" rowspan="2">Feature / Test</th>
    ${targetGroups.map((g) => `<th class="target-group" colspan="${g.cols.length}">${esc(g.label)}</th>`).join('\n    ')}
  </tr>
  <tr>
    ${columns.map((col) => `<th>${esc(col.subLabel)}</th>`).join('\n    ')}
  </tr>
</thead>
<tbody>
${scenarios
  .map((scenario) => {
    const scenarioRows = rows.filter((r) => r.scenario === scenario);
    const scenarioRowsHtml = scenarioRows
      .map((row) => {
        const statuses = columns.map((col) => {
          const r = cellMap.get(row.rowKey)?.get(col.key);
          return r ? r.status : 'missing';
        });
        const hasAny = (s: string) => statuses.some((x) => x === s);
        const dataStatus = [
          hasAny('pass') ? 'pass' : '',
          hasAny('fail') ? 'fail' : '',
          hasAny('skip') ? 'skip' : '',
          hasAny('missing') ? 'missing' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          `  <tr data-status="${esc(dataStatus)}">\n` +
          `    <td class="test-name" title="${esc(row.test)}">${esc(row.test)}</td>\n` +
          columns.map((col) => `    <td>${cellHtml(row, col)}</td>`).join('\n') +
          `\n  </tr>`
        );
      })
      .join('\n');

    return (
      `  <tr class="scenario-header"><td colspan="${columns.length + 1}">${esc(scenario)}</td></tr>\n` +
      scenarioRowsHtml
    );
  })
  .join('\n')}
</tbody>
<tfoot>
  <tr>
    <td class="row-label">Total</td>
    ${columns
      .map((col) => {
        const s = colStats.get(col.key)!;
        return `<td title="pass ${s.pass} / fail ${s.fail} / skip ${s.skip}">${s.pass}/${s.total}</td>`;
      })
      .join('\n    ')}
  </tr>
</tfoot>
</table>
</div>

<script>
function setFilter(filter) {
  document.querySelectorAll('.filter-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  document.querySelectorAll('#matrix tbody tr:not(.scenario-header)').forEach(function(tr) {
    if (filter === 'all') { tr.hidden = false; return; }
    var statuses = (tr.dataset.status || '').split(' ');
    tr.hidden = !statuses.includes(filter);
  });
  // Hide scenario headers with no visible rows
  document.querySelectorAll('#matrix tbody tr.scenario-header').forEach(function(hdr) {
    var sibling = hdr.nextElementSibling;
    var hasVisible = false;
    while (sibling && !sibling.classList.contains('scenario-header')) {
      if (!sibling.hidden) { hasVisible = true; break; }
      sibling = sibling.nextElementSibling;
    }
    hdr.hidden = !hasVisible;
  });
}
</script>
</body>
</html>`;

writeFileSync(outputPath, html, 'utf-8');
console.log(`Report written to ${outputPath}`);
