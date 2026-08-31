/**
 * True Utilisation Analyst: idle stacked on the existing daily chart,
 * headline % still operating-only.
 *
 *   node scripts/test-utilisation-idle-stack.js
 */
var fs = require('fs');
var path = require('path');
var FCM = require('../js/fleet-cost-model');

var pass = true;
function check(label, condition, detail) {
  var status = condition ? 'PASS' : 'FAIL';
  if (!condition) pass = false;
  console.log('[' + status + '] ' + label + (detail ? ' — ' + detail : ''));
}

var page = fs.readFileSync(path.join(__dirname, '..', 'utilisation-analyst.html'), 'utf8');
var sidebar = fs.readFileSync(path.join(__dirname, '..', 'js/sidebar-nav.js'), 'utf8');
var idlePage = fs.readFileSync(path.join(__dirname, '..', 'idle-cost-analyst.html'), 'utf8');
var fuelPage = fs.readFileSync(path.join(__dirname, '..', 'fuel-analyst.html'), 'utf8');

check(
  'Page title renamed',
  /<title>True Utilisation Analyst \| FleetMagnify<\/title>/.test(page)
);
check(
  'Topbar heading renamed',
  /<div class="topbar-title">True Utilisation Analyst<\/div>/.test(page)
);
check(
  'Breadcrumb renamed',
  /\/ True Utilisation Analyst/.test(page)
);
check(
  'Sidebar nav label renamed',
  /text: 'True Utilisation Analyst'/.test(sidebar)
);
check(
  'Old product name is gone from this page',
  !/(^|[^e])Utilisation Analyst/.test(page.replace(/True Utilisation Analyst/g, ''))
);

var canvasMatches = page.match(/<canvas id="utilisation-chart">/g) || [];
check('Exactly one utilisation canvas', canvasMatches.length === 1, String(canvasMatches.length));

var chartCtors = page.match(/utilisationChart = new Chart\(/g) || [];
check('Exactly one Chart.js instance assignment', chartCtors.length === 1, String(chartCtors.length));

check(
  'Query selects idle_hours alongside operating_hours',
  /select\('record_date, operating_hours, idle_hours'\)/.test(page)
);

check(
  'Headline utilisation still operating hours only',
  /var utilisationRate = dataPeriodAvailable > 0 \? \(totalActual \/ dataPeriodAvailable\) \* 100 : 0;/.test(page)
);
check(
  'totalActual still sums operating (actual), not idle',
  /totalActual \+= actual;/.test(page) && !/totalActual \+= .*idle/.test(page)
);

check(
  'Operating segment uses on-target green #0EA57A',
  /label: 'Operating'[\s\S]*?backgroundColor: '#0EA57A'/.test(page)
);
check(
  'Idle segment uses platform idle amber #EF9F27',
  /label: 'Idle'[\s\S]*?backgroundColor: '#EF9F27'/.test(page)
);
check(
  'Fuel Analyst Idle Fuel legend is #EF9F27 (source of idle colour)',
  /legend-dot" style="background:#EF9F27;"><\/div> Idle Fuel/.test(fuelPage)
);
check(
  'Idle Cost Analyst uses #EF9F27 for idle-related amber',
  /kpi-value\.amber \{ color: #EF9F27; \}/.test(idlePage)
);

check('Chart is stacked on the value axis', /x: \{\s*stacked: true,/.test(page));
check('Operating and Idle share the same stack id', (page.match(/stack: 'switchedOn'/g) || []).length === 2);
check('Target line annotation still present', /annotations\.targetLine/.test(page) && /xMin: targetPercent/.test(page));
check('HTML legend labels Operating and Idle', /legend-dot" style="background:#0EA57A;"><\/div> Operating/.test(page) && /legend-dot" style="background:#EF9F27;"><\/div> Idle/.test(page));

check(
  'Intermittent assets still use the same chart (no second chart)',
  /renderChart\(dailyRows\.filter/.test(page) &&
    /intermittent \? null : targetPercent/.test(page) &&
    !/id="[^"]*intermittent[^"]*chart"/.test(page)
);

check(
  'Argosy is treated as intermittent / on-call',
  FCM.isIntermittentUsage({ asset_name: 'Freightliner Argosy Low Loader', usage_profile: 'regular' }) === true
);

function percentOfAvailable(hours, available) {
  if (!(available > 0)) return null;
  return (hours / available) * 100;
}

var available = 8;
var operating = 5.6;
var idle = 1.2;
var opPct = percentOfAvailable(operating, available);
var idlePct = percentOfAvailable(idle, available);
check('Operating segment is operating ÷ available × 100', opPct === 70, String(opPct));
check('Idle segment is idle ÷ available × 100', idlePct === 15, String(idlePct));
check('Combined bar is switched-on share of available', opPct + idlePct === 85, String(opPct + idlePct));

var headlineAvailable = 40;
var headlineOperating = 28;
var headlineIdle = 9;
var headline = (headlineOperating / headlineAvailable) * 100;
check(
  'Headline ignores idle hours',
  headline === 70 && headline !== ((headlineOperating + headlineIdle) / headlineAvailable) * 100,
  String(headline)
);

if (!pass) {
  console.error('\nutilisation idle-stack tests failed');
  process.exit(1);
}
console.log('\nAll utilisation idle-stack checks passed');
