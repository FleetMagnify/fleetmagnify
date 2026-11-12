/**
 * Machine owning and operating cost per hour.
 * The worked example uses invented figures. No network.
 *
 *   node scripts/test-operating-cost.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var machineOperatingCost = require('../js/operating-cost');

function money(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function burn(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

var example = {
  purchasePrice: 250000,
  resaleValue: 100000,
  hoursPerYear: 1500,
  yearsKept: 5,
  workingBurnLph: 14,
  fuelPrice: 2,
  servicingPerHour: 12,
  interestRatePercent: 8,
  insurancePerYear: 4500,
  tracksCost: 20000,
  tracksHours: 4000,
  idleSharePercent: 20,
  idleBurnLph: 4
};

var result = machineOperatingCost(example);
assert.strictEqual(result.error, undefined);
assert.strictEqual(money(result.depreciationPerHour), '20.00');
assert.strictEqual(money(result.financePerHour), '9.33');
assert.strictEqual(money(result.insurancePerHour), '3.00');
assert.strictEqual(money(result.owningPerHour), '32.33');
assert.strictEqual(burn(result.averageBurnLph), '12.0');
assert.strictEqual(money(result.fuelPerHour), '24.00');
assert.strictEqual(money(result.idleFuelPerHour), '1.60');
assert.strictEqual(money(result.servicingPerHour), '12.00');
assert.strictEqual(money(result.tracksPerHour), '5.00');
assert.strictEqual(money(result.operatingPerHour), '41.00');
assert.strictEqual(money(result.totalPerHour), '73.33');
assert.strictEqual(result.idleHoursPerYear, 300);
assert.strictEqual(result.idleLitresPerYear, 1200);
assert.strictEqual(result.idleFuelPerYear, 2400);
console.log('[PASS] worked example displays as $73.33 per hour');

var basic = machineOperatingCost({
  purchasePrice: 250000,
  resaleValue: 100000,
  hoursPerYear: 1500,
  yearsKept: 5,
  workingBurnLph: 14,
  fuelPrice: 2,
  servicingPerHour: 12
});
assert.strictEqual(basic.error, undefined);
assert.strictEqual(money(basic.depreciationPerHour), '20.00');
assert.strictEqual(money(basic.fuelPerHour), '28.00');
assert.strictEqual(money(basic.servicingPerHour), '12.00');
assert.strictEqual(money(basic.totalPerHour), '60.00');
assert.strictEqual(basic.financePerHour, 0);
assert.strictEqual(basic.operatorPerHour, 0);
console.log('[PASS] main inputs alone total $60.00 per hour');

var noHours = machineOperatingCost({
  purchasePrice: 250000,
  resaleValue: 100000,
  hoursPerYear: 0,
  yearsKept: 5,
  workingBurnLph: 14,
  fuelPrice: 2,
  servicingPerHour: 12
});
assert.ok(noHours && typeof noHours === 'object' && noHours.error);
assert.strictEqual(JSON.stringify(noHours).indexOf('NaN'), -1);
assert.strictEqual(JSON.stringify(noHours).indexOf('Infinity'), -1);
console.log('[PASS] zero hours per year returns an error');

var blankOperator = machineOperatingCost(example);
assert.strictEqual(blankOperator.operatorPerHour, 0);
assert.strictEqual(money(blankOperator.totalPerHour), '73.33');
console.log('[PASS] a blank operator cost counts as 0');

var noIdle = machineOperatingCost(Object.assign({}, example, { idleSharePercent: 0 }));
assert.strictEqual(money(noIdle.fuelPerHour), '28.00');
assert.strictEqual(burn(noIdle.averageBurnLph), '14.0');
console.log('[PASS] idle share of 0% uses the working burn rate');

var page = fs.readFileSync(path.join(__dirname, '..', 'machine-operating-cost-per-hour.html'), 'utf8');
[
  '$20.00/h',
  '$9.33/h',
  '$3.00/h',
  '$32.33/h',
  '12.0 L/h',
  '$24.00/h',
  '$1.60/h',
  '$12.00/h',
  '$5.00/h',
  '$41.00/h',
  '$73.33/h',
  '300 hours and 1,200 litres a year, which is $2,400'
].forEach(function(figure) {
  assert.ok(page.indexOf(figure) !== -1, 'page is missing ' + figure);
});
assert.ok(page.indexOf('Fill with the example') !== -1);
assert.ok(page.indexOf('made-up numbers, not a benchmark') !== -1);
console.log('[PASS] the worked-example table shows the same figures');

console.log('\nAll operating cost tests passed.');
