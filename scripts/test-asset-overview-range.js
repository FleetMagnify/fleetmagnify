/**
 * Asset overview date range. "Today" is injected, so nothing here reads the clock.
 * Invented machine: Excavator 12. No customer data.
 *
 *   node scripts/test-asset-overview-range.js
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var FCM = require('../js/fleet-cost-model');
var AOR = require('../js/asset-overview-range');

var pass = true;
function check(label, fn) {
  try {
    fn();
    console.log('[PASS] ' + label);
  } catch (err) {
    pass = false;
    console.log('[FAIL] ' + label + ' — ' + err.message);
  }
}

var page = fs.readFileSync(path.join(__dirname, '..', 'asset-overview.html'), 'utf8');
var analystPage = fs.readFileSync(path.join(__dirname, '..', 'utilisation-analyst.html'), 'utf8');
var model = fs.readFileSync(path.join(__dirname, '..', 'js', 'fleet-cost-model.js'), 'utf8');

function analystDateFns() {
  var start = analystPage.indexOf('function calendarDaysInRange');
  var end = analystPage.indexOf('function updateSparseDataNote');
  assert.ok(start !== -1 && end > start);
  var src = analystPage.slice(start, end);
  return new Function(src + '\nreturn { calendarDaysInRange: calendarDaysInRange, isRangeSignificantlyWiderThanData: isRangeSignificantlyWiderThanData };')();
}

var analyst = analystDateFns();
var NORMAL = '2026-11-12';

check('each preset on a normal date is inclusive and matches the calendar', function() {
  var month = AOR.presetRange('this-month', NORMAL);
  assert.deepStrictEqual(month, { from: '2026-11-01', to: '2026-11-12' });

  var previous = AOR.presetRange('last-month', NORMAL);
  assert.deepStrictEqual(previous, { from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(AOR.inclusiveDays(previous.from, previous.to), 31);

  var last30 = AOR.presetRange('last-30', NORMAL);
  assert.strictEqual(last30.to, NORMAL);
  assert.strictEqual(last30.from, FCM.addDaysISO(NORMAL, -29));
  assert.strictEqual(AOR.inclusiveDays(last30.from, last30.to), 30);

  var last7 = AOR.presetRange('last-7', NORMAL);
  assert.strictEqual(last7.to, NORMAL);
  assert.strictEqual(last7.from, FCM.addDaysISO(NORMAL, -6));
  assert.strictEqual(AOR.inclusiveDays(last7.from, last7.to), 7);
});

check('last month in January is December of the previous year', function() {
  assert.deepStrictEqual(AOR.presetRange('last-month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepStrictEqual(AOR.presetRange('last-month', '2026-01-01'), { from: '2025-12-01', to: '2025-12-31' });
});

check('last month in March covers 28 days, or 29 in a leap year', function() {
  var plain = AOR.presetRange('last-month', '2026-03-10');
  assert.deepStrictEqual(plain, { from: '2026-02-01', to: '2026-02-28' });
  assert.strictEqual(AOR.inclusiveDays(plain.from, plain.to), 28);
  var leap = AOR.presetRange('last-month', '2024-03-10');
  assert.deepStrictEqual(leap, { from: '2024-02-01', to: '2024-02-29' });
  assert.strictEqual(AOR.inclusiveDays(leap.from, leap.to), 29);
});

check('the default is This month on the 8th and Last 30 days on the 7th and the 1st', function() {
  assert.strictEqual(AOR.defaultPreset('2026-11-08'), 'this-month');
  assert.strictEqual(AOR.defaultPreset('2026-11-07'), 'last-30');
  assert.strictEqual(AOR.defaultPreset('2026-11-01'), 'last-30');
  assert.deepStrictEqual(
    AOR.presetRange(AOR.defaultPreset('2026-11-08'), '2026-11-08'),
    { from: '2026-11-01', to: '2026-11-08' }
  );
  var early = AOR.presetRange(AOR.defaultPreset('2026-11-01'), '2026-11-01');
  assert.strictEqual(early.to, '2026-11-01');
  assert.strictEqual(AOR.inclusiveDays(early.from, early.to), 30);
});

check('custom dates reject from-after-to, a future end, a span over 366 days, and malformed text', function() {
  assert.deepStrictEqual(AOR.validateCustomRange('2026-11-10', '2026-11-01', NORMAL), { ok: false, message: 'From is after to.' });
  assert.deepStrictEqual(AOR.validateCustomRange('2026-11-01', '2026-11-20', NORMAL), { ok: false, message: 'To is after today.' });
  assert.strictEqual(AOR.validateCustomRange('2024-01-01', '2024-12-31', NORMAL).ok, true);
  assert.strictEqual(AOR.inclusiveDays('2024-01-01', '2024-12-31'), 366);
  assert.deepStrictEqual(AOR.validateCustomRange('2024-01-01', '2025-01-01', NORMAL), { ok: false, message: 'Range is longer than 366 days.' });
  ['nope', '2026-02-31', '2026-11-2', '', '2026/11/01'].forEach(function(bad) {
    var result = AOR.validateCustomRange(bad, NORMAL, NORMAL);
    assert.strictEqual(result.ok, false, bad);
    assert.strictEqual(result.message, 'Enter valid dates.');
  });
});

check('URL dates win over the remembered preset, and bad dates are ignored', function() {
  var lastMonthUrl = AOR.resolveInitialRange('?asset=12&from=2026-10-01&to=2026-10-31', 'last-7', NORMAL);
  assert.strictEqual(lastMonthUrl.preset, 'last-month');
  assert.deepStrictEqual({ from: lastMonthUrl.from, to: lastMonthUrl.to }, { from: '2026-10-01', to: '2026-10-31' });

  var custom = AOR.resolveInitialRange('?asset=12&from=2026-10-05&to=2026-10-20', 'this-month', NORMAL);
  assert.strictEqual(custom.preset, 'custom');
  assert.strictEqual(custom.from, '2026-10-05');
  assert.strictEqual(custom.to, '2026-10-20');

  var assetOnly = AOR.resolveInitialRange('?asset=12', 'last-30', NORMAL);
  assert.strictEqual(assetOnly.preset, 'last-30');
  assert.deepStrictEqual(
    { from: assetOnly.from, to: assetOnly.to },
    AOR.presetRange('last-30', NORMAL)
  );

  var none = AOR.resolveInitialRange('', null, '2026-11-08');
  assert.strictEqual(none.preset, 'this-month');
  var first = AOR.resolveInitialRange('?asset=12', null, '2026-11-01');
  assert.strictEqual(first.preset, 'last-30');

  assert.strictEqual(AOR.resolveInitialRange('?from=2026-11-20&to=2026-11-01', 'last-7', NORMAL).preset, 'last-7');
  assert.strictEqual(AOR.resolveInitialRange('?from=2026-11-01&to=2026-12-01', 'this-month', NORMAL).preset, 'this-month');
  assert.strictEqual(AOR.resolveInitialRange('?from=2024-01-01&to=2025-01-01', 'last-7', NORMAL).preset, 'last-7');
  assert.strictEqual(AOR.resolveInitialRange('?from=nope&to=2026-11-01', 'last-30', NORMAL).preset, 'last-30');
  assert.strictEqual(AOR.resolveInitialRange('?from=2026-11-01', 'last-7', NORMAL).preset, 'last-7');
  assert.strictEqual(AOR.resolveInitialRange('?asset=12&from=2026-11-01&to=2026-11-12', 'custom', NORMAL).preset, 'this-month');
});

check('the range label names the dates and the preset', function() {
  assert.strictEqual(AOR.rangeLabel('2026-11-01', '2026-11-02', 'this-month'), '1 Nov to 2 Nov (this month)');
  assert.strictEqual(AOR.rangeLabel('2026-10-01', '2026-10-31', 'last-month'), '1 Oct to 31 Oct (last month)');
  assert.strictEqual(AOR.rangeLabel('2026-10-14', '2026-11-12', 'last-30'), '14 Oct to 12 Nov (last 30 days)');
  assert.strictEqual(AOR.rangeLabel('2026-11-06', '2026-11-12', 'last-7'), '6 Nov to 12 Nov (last 7 days)');
  assert.strictEqual(AOR.rangeLabel('2026-10-05', '2026-10-20', 'custom'), '5 Oct to 20 Oct (custom)');
  assert.strictEqual(AOR.shortLabel('2026-11-01', '2026-11-02'), '1 Nov to 2 Nov');
  ['this-month', 'last-month', 'last-30', 'last-7'].forEach(function(preset) {
    var range = AOR.presetRange(preset, NORMAL);
    var label = AOR.rangeLabel(range.from, range.to, preset);
    assert.ok(label.indexOf(AOR.shortLabel(range.from, range.to)) === 0, preset);
    assert.ok(/\([a-z0-9 ]+\)$/.test(label), label);
  });
});

check('switching machine keeps from and to in the address', function() {
  var from = '2026-10-01';
  var to = '2026-10-31';
  assert.strictEqual(AOR.overviewQuery('machine-a', from, to), '?asset=machine-a&from=2026-10-01&to=2026-10-31');
  assert.strictEqual(AOR.overviewQuery('machine-b', from, to), '?asset=machine-b&from=2026-10-01&to=2026-10-31');
  assert.ok(page.indexOf('AOR.overviewQuery(id, currentRange.from, currentRange.to)') !== -1);
  assert.ok(page.indexOf('history.replaceState') !== -1);
  assert.ok(page.indexOf('asset-overview.html?asset=') === -1);
});

check('utilisation matches the Analyst window rule for a partial-data fixture', function() {
  var hoursPerWeek = 40;
  var workingHours = 16;
  var wideFrom = '2026-10-01';
  var wideTo = '2026-10-31';
  var dataFrom = '2026-10-10';
  var dataTo = '2026-10-12';
  assert.strictEqual(
    AOR.isRangeSignificantlyWiderThanData(wideFrom, wideTo, dataFrom, dataTo),
    analyst.isRangeSignificantlyWiderThanData(wideFrom, wideTo, dataFrom, dataTo)
  );
  assert.strictEqual(AOR.isRangeSignificantlyWiderThanData(wideFrom, wideTo, dataFrom, dataTo), true);
  var wide = AOR.utilisationForSelection({
    from: wideFrom,
    to: wideTo,
    dataFrom: dataFrom,
    dataTo: dataTo,
    hoursPerWeek: hoursPerWeek,
    workingHours: workingHours
  });
  var dataDays = analyst.calendarDaysInRange(dataFrom, dataTo);
  var dataAvailable = hoursPerWeek * dataDays / 7;
  var dataRate = workingHours / dataAvailable * 100;
  assert.strictEqual(wide.usedDataWindow, true);
  assert.ok(Math.abs(wide.available - dataAvailable) < 1e-9);
  assert.ok(Math.abs(wide.rate - dataRate) < 1e-9);

  var fullFrom = '2026-10-01';
  var fullTo = '2026-10-10';
  var fullDataTo = '2026-10-08';
  assert.strictEqual(
    AOR.isRangeSignificantlyWiderThanData(fullFrom, fullTo, fullFrom, fullDataTo),
    analyst.isRangeSignificantlyWiderThanData(fullFrom, fullTo, fullFrom, fullDataTo)
  );
  assert.strictEqual(AOR.isRangeSignificantlyWiderThanData(fullFrom, fullTo, fullFrom, fullDataTo), false);
  var full = AOR.utilisationForSelection({
    from: fullFrom,
    to: fullTo,
    dataFrom: fullFrom,
    dataTo: fullDataTo,
    hoursPerWeek: hoursPerWeek,
    workingHours: workingHours
  });
  var selDays = analyst.calendarDaysInRange(fullFrom, fullTo);
  var selAvailable = hoursPerWeek * selDays / 7;
  var selRate = workingHours / selAvailable * 100;
  assert.strictEqual(full.usedDataWindow, false);
  assert.ok(Math.abs(full.available - selAvailable) < 1e-9);
  assert.ok(Math.abs(full.rate - selRate) < 1e-9);
  assert.ok(Math.abs(wide.rate - full.rate) > 1);

  assert.strictEqual(AOR.calendarDaysInRange('2026-09-20', '2026-10-04'), analyst.calendarDaysInRange('2026-09-20', '2026-10-04'));
  assert.strictEqual(AOR.isRangeSignificantlyWiderThanData('2026-10-01', '2026-10-25', '2026-10-01', '2026-10-20'), false);
  assert.strictEqual(AOR.isRangeSignificantlyWiderThanData('2026-10-01', '2026-10-26', '2026-10-01', '2026-10-20'), true);
  assert.strictEqual(AOR.isRangeSignificantlyWiderThanData('2026-06-01', '2026-09-21', '2026-06-01', '2026-09-08'), false);
  assert.strictEqual(AOR.isRangeSignificantlyWiderThanData('2026-06-01', '2026-09-22', '2026-06-01', '2026-09-08'), true);
  assert.strictEqual(analyst.isRangeSignificantlyWiderThanData('2026-06-01', '2026-09-22', '2026-06-01', '2026-09-08'), true);

  assert.ok(analystPage.indexOf('var utilisationRate = dataPeriodAvailable > 0 ? (totalActual / dataPeriodAvailable) * 100 : 0;') !== -1);
  assert.ok(page.indexOf('AOR.utilisationForSelection(') !== -1);
  assert.ok(page.indexOf('workingHours: workingHours') !== -1);
  assert.ok(page.indexOf('FCM.hoursAgainstTarget(workingKnown, available, target)') !== -1);
  assert.ok(page.indexOf("statBlock('Working hours'") !== -1);
  assert.ok(model.indexOf('function utilisationForSelection') === -1);
});

check('freshness is judged against today, so a finished month is not stale by itself', function() {
  var today = '2026-11-08';
  var lastMonth = AOR.presetRange('last-month', today);
  assert.ok(lastMonth.to < '2026-11-07');
  assert.strictEqual(AOR.isReportStale('2026-11-07', today), false);
  assert.strictEqual(AOR.reportIsToday('2026-11-07', today), false);
  assert.strictEqual(AOR.isReportStale('2026-11-03', today), true);
  assert.strictEqual(AOR.reportIsToday(today, today), true);
  assert.strictEqual(AOR.isReportStale(today, today), false);
  assert.ok(page.indexOf('AOR.isReportStale(latestDate, today)') !== -1);
  assert.ok(page.indexOf('AOR.reportIsToday(latestDate, today)') !== -1);
  assert.ok(page.indexOf('var today = FCM.nzTodayISO();') !== -1);
  assert.ok(page.indexOf('latestDate === currentRange.to') === -1);
  assert.ok(page.indexOf('daySpan(latestDate') === -1);
  assert.ok(page.indexOf('>Data to<') !== -1);
  assert.strictEqual(page.indexOf('Last report'), -1);
});

check('a period with no telematics rows stays unknown and names the latest record', function() {
  assert.strictEqual(AOR.chartEmptyMessage('2026-11-01'), 'No records in this period. Last record: 1 Nov 2026.');
  assert.strictEqual(AOR.chartEmptyMessage(''), 'No records yet');
  assert.strictEqual(AOR.chartEmptyMessage(null), 'No records yet');
  assert.ok(page.indexOf("hasTel ? 'No run hours recorded in this period.' : AOR.chartEmptyMessage(latestDate)") !== -1);
  assert.ok(page.indexOf('var workingKnown = hasTel ? workingHours : null;') !== -1);
  assert.ok(page.indexOf("unknownStat('Working hours'") !== -1);
  assert.ok(page.indexOf("unknownStat('Utilisation'") !== -1);
  assert.ok(page.indexOf("unknownStat(label, title)") !== -1 || page.indexOf("statBlock(label, '—'") !== -1);
  assert.ok(page.indexOf('No rows in this period means the hours are unknown.') !== -1);
});

check('the page exposes the period control, remembers the preset only, and follows the range', function() {
  assert.ok(page.indexOf('id="period-select"') !== -1);
  assert.ok(page.indexOf('value="this-month">This month<') !== -1);
  assert.ok(page.indexOf('value="last-month">Last month<') !== -1);
  assert.ok(page.indexOf('value="last-30">Last 30 days<') !== -1);
  assert.ok(page.indexOf('value="last-7">Last 7 days<') !== -1);
  assert.ok(page.indexOf('value="custom">Custom<') !== -1);
  assert.ok(page.indexOf('id="date-from"') !== -1);
  assert.ok(page.indexOf('id="date-to"') !== -1);
  assert.ok(page.indexOf('id="apply-range"') !== -1);
  assert.ok(page.indexOf('<label for="asset-select">Machine</label>') !== -1);
  assert.ok(page.indexOf('<label for="period-select">Period</label>') !== -1);
  assert.ok(page.indexOf('<label for="date-from">From</label>') !== -1);
  assert.ok(page.indexOf('<label for="date-to">To</label>') !== -1);
  assert.ok(page.indexOf('@media (max-width: 390px)') !== -1);
  assert.ok(page.indexOf('fm_asset_overview_period') !== -1);
  assert.ok(page.indexOf('if (!AOR.isNamedPreset(preset)) return;') !== -1);
  assert.strictEqual(AOR.isNamedPreset('custom'), false);
  assert.ok(page.indexOf('AOR.resolveInitialRange(window.location.search, readPeriod(), FCM.nzTodayISO())') !== -1);
  assert.ok(page.indexOf('try { return localStorage.getItem(PERIOD_KEY); } catch (e) { return null; }') !== -1);
  assert.ok(page.indexOf('A range is at most 366 days, so one machine\'s rows stay within the 1,000-row page limit.') !== -1);
  assert.ok(page.indexOf(".gte('record_date', currentRange.from)") !== -1);
  assert.ok(page.indexOf(".lte('record_date', currentRange.to)") !== -1);
  assert.ok(page.indexOf('loadJobRows(asset.id, currentRange.from, currentRange.to)') !== -1);
  assert.ok(page.indexOf('AOR.presetRange(AOR.defaultPreset(today), today)') !== -1);
  assert.ok(page.indexOf('not limited to the selected period') !== -1);
  assert.ok(page.indexOf('needs 3 days of Fleet Fuel data') !== -1);
  var fuelIdx = page.indexOf(".not('working_fuel_litres', 'is', null)");
  var limitIdx = page.indexOf('.limit(120)', fuelIdx);
  var between = page.slice(fuelIdx, limitIdx);
  assert.ok(between.indexOf('.gte(') === -1);
  assert.ok(between.indexOf('currentRange') === -1);
  assert.ok(page.toLowerCase().indexOf('month to date') === -1);
  assert.ok(page.indexOf('month-to-date') === -1);
  assert.ok(page.indexOf('Jobs in this period') !== -1);
  assert.ok(page.indexOf('no run hours in this period') !== -1);
  assert.ok(page.indexOf('>Period</th>') !== -1);
  assert.ok(page.indexOf('selected period will show here') !== -1);
  assert.ok(page.indexOf("'. Each card links to the full analyst for this machine.'") !== -1);
  assert.ok(model.indexOf('function nzTodayISO') !== -1);
  assert.ok(model.indexOf('function calcWorkingCostPerHour') !== -1);
});

if (!pass) process.exit(1);
console.log('All asset overview range checks passed.');
