/**
 * Cost per working hour. Invented asset names and figures only.
 *   node scripts/test-working-cost-per-hour.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var FCM = require('../js/fleet-cost-model');

var IDLE_RATE = 4;
var WORKING_RATE = 14;
var PRICE = 2.5;

var excavator = {
  asset_name: 'Excavator 12',
  asset_type: 'Excavator',
  current_value: 180000,
  estimated_end_of_life_value: 20000,
  expected_life_hours: 8000,
  service_cost_per_hour: 12,
  estimated_annual_repair_cost: 10400,
  available_hours_per_week: 40,
  target_utilisation_percent: 50
};

function row(date, operating, idle, litres) {
  return {
    record_date: date,
    operating_hours: operating,
    idle_hours: idle,
    working_fuel_litres: litres
  };
}

function working(asset, price, rate, engineHours, fuelOk) {
  return FCM.calcWorkingCostPerHour(asset, price, rate, engineHours, fuelOk);
}

function idle(asset, price, rate, engineHours, fuelOk) {
  return FCM.calcIdleCostPerHour(asset, price, rate, engineHours, fuelOk);
}

var weightedRows = [
  row('2026-01-03', 2, 1, 20),
  row('2026-01-01', 9, 1, 40),
  row('2026-01-02', 2, 1, 20)
];
var weighted = FCM.measuredWorkingRate(weightedRows);
var ratioAverage = ((40 / 8) + (20 / 1) + (20 / 1)) / 3;
assert.strictEqual(weighted.rate, 8);
assert.strictEqual(weighted.days, 3);
assert.strictEqual(weighted.workingHours, 10);
assert.notStrictEqual(weighted.rate, ratioAverage);
console.log('✓ weighted working rate is 8.00 L/hr, not the average of daily ratios (' + ratioAverage + ')');

var twoDays = FCM.measuredWorkingRate([
  row('2026-02-01', 12, 1, 80),
  row('2026-02-02', 12, 1, 80)
]);
assert.strictEqual(twoDays.rate, null);
assert.strictEqual(twoDays.days, 2);
assert.strictEqual(twoDays.reason, 'not enough data');
console.log('✓ fewer than 3 qualifying days returns null');

var shortHours = FCM.measuredWorkingRate([
  row('2026-03-01', 4, 1, 30),
  row('2026-03-02', 4, 1, 30),
  row('2026-03-03', 4, 1, 30)
]);
assert.strictEqual(shortHours.rate, null);
assert.strictEqual(shortHours.days, 3);
assert.strictEqual(shortHours.workingHours, undefined);
assert.strictEqual(shortHours.reason, 'not enough data');
console.log('✓ under 10 working hours returns null');

var tooLow = FCM.measuredWorkingRate([
  row('2026-04-01', 5, 1, 8),
  row('2026-04-02', 5, 1, 8),
  row('2026-04-03', 5, 1, 8)
]);
assert.strictEqual(tooLow.rate, null);
assert.strictEqual(tooLow.days, 3);
assert.strictEqual(tooLow.reason, 'implausible');
var tooHigh = FCM.measuredWorkingRate([
  row('2026-04-04', 5, 1, 700),
  row('2026-04-05', 5, 1, 700),
  row('2026-04-06', 5, 1, 700)
]);
assert.strictEqual(tooHigh.rate, null);
assert.strictEqual(tooHigh.reason, 'implausible');
console.log('✓ rates below 3 or above 150 L/hr are implausible');

var atFloor = FCM.measuredWorkingRate([
  row('2026-04-11', 5, 1, 12),
  row('2026-04-12', 5, 1, 12),
  row('2026-04-13', 5, 1, 12)
]);
assert.strictEqual(atFloor.rate, 3);
var atCeiling = FCM.measuredWorkingRate([
  row('2026-04-14', 5, 1, 600),
  row('2026-04-15', 5, 1, 600),
  row('2026-04-16', 5, 1, 600)
]);
assert.strictEqual(atCeiling.rate, 150);
var justUnderHours = FCM.measuredWorkingRate([
  row('2026-04-21', 4.33, 1, 33.3),
  row('2026-04-22', 4.33, 1, 33.3),
  row('2026-04-23', 4.33, 1, 33.3)
]);
assert.strictEqual(justUnderHours.rate, null);
assert.strictEqual(justUnderHours.reason, 'not enough data');
console.log('✓ 3 and 150 L/hr are kept, and 9.99 working hours is not enough');

var withJunk = weightedRows.concat([
  row('2026-01-04', 20, 0, null),
  row('2026-01-05', 20, 0, -10),
  row('2026-01-06', 1.05, 1, 500),
  row('2026-01-07', 0.04, 0, 500),
  { record_date: '2026-01-08', operating_hours: null, idle_hours: 0, working_fuel_litres: 80 },
  { record_date: '2026-01-09', operating_hours: 12, idle_hours: 'nope', working_fuel_litres: 80 }
]);
var ignored = FCM.measuredWorkingRate(withJunk);
assert.strictEqual(ignored.rate, 8);
assert.strictEqual(ignored.days, 3);
assert.strictEqual(ignored.workingHours, 10);
console.log('✓ null litres, negative litres, and working hours of 0.05 or less are ignored');

var withZero = FCM.measuredWorkingRate(weightedRows.concat([
  row('2026-01-10', 11, 1, 0)
]));
assert.strictEqual(withZero.rate, 4);
assert.strictEqual(withZero.days, 4);
assert.strictEqual(withZero.workingHours, 20);
console.log('✓ a zero-litre working day is kept and pulls the weighted rate down');

var asStrings = FCM.measuredWorkingRate([
  row('2026-01-01', '9', '1', '40'),
  row('2026-01-02', '2', '1', '20'),
  row('2026-01-03', '2', '1', '20')
]);
assert.strictEqual(asStrings.rate, weighted.rate);
console.log('✓ numeric strings from the telematics API count as numbers');

function dayOffset(n) {
  var d = new Date(Date.UTC(2024, 0, 1 + n));
  return d.toISOString().slice(0, 10);
}
var many = [];
for (var i = 0; i < 130; i++) {
  var newest = i >= 10;
  many.push(row(dayOffset(i), 5, 1, newest ? 40 : 400));
}
for (var s = many.length - 1; s > 0; s--) {
  var swap = (s * 17) % (s + 1);
  var tmp = many[s];
  many[s] = many[swap];
  many[swap] = tmp;
}
var recent = FCM.measuredWorkingRate(many);
assert.strictEqual(recent.days, 120);
assert.strictEqual(recent.workingHours, 480);
assert.strictEqual(recent.rate, 10);
console.log('✓ only the 120 newest qualifying days are used, even when the input is unsorted');

var rounded = FCM.measuredWorkingRate([
  row('2026-05-01', 5, 1, 100 / 3),
  row('2026-05-02', 5, 1, 100 / 3),
  row('2026-05-03', 5, 1, 100 / 3)
]);
assert.strictEqual(rounded.rate, 8.33);
assert.strictEqual(rounded.workingHours, 12);
console.log('✓ the working rate is rounded to 2 decimals');

var depr = (180000 - 20000) / 8000;
var servicing = 12;
var annualHours = 40 * 52 * (50 / 100);
var maintenance = 10400 / annualHours;
var fuel = WORKING_RATE * PRICE;
var expected = depr + servicing + maintenance + fuel;
assert.strictEqual(expected, 77);

var full = working(excavator, PRICE, WORKING_RATE, 1000, true);
assert.strictEqual(full.value, expected);
assert.strictEqual(full.hasMissing, false);
var fullIdle = idle(excavator, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(full.value - fullIdle.value, (WORKING_RATE - IDLE_RATE) * PRICE);
console.log('✓ excavator working hour is $77.00, and working minus idle equals the fuel-rate gap times price');

var noTarget = Object.assign({}, excavator);
delete noTarget.target_utilisation_percent;
var partial = working(noTarget, PRICE, WORKING_RATE, 1000, true);
var partialIdle = idle(noTarget, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(partial.hasMissing, true);
assert.strictEqual(partial.value, depr + servicing + fuel);
assert.deepStrictEqual(partial.missing.maintenanceMissing, ['Target Utilisation Percent']);
assert.strictEqual(
  FCM.formatMissingMessage(partial.missing.maintenanceMissing),
  'Cannot calculate — missing: Target Utilisation Percent'
);
assert.strictEqual(partial.value - partialIdle.value, (WORKING_RATE - IDLE_RATE) * PRICE);
console.log('✓ missing target utilisation is a partial working rate with that missing text');

var noFuel = working(excavator, PRICE, WORKING_RATE, 1000, false);
assert.strictEqual(noFuel.hasMissing, true);
assert.deepStrictEqual(noFuel.missing.fuelMissing, ['Fuel records for selected period']);
assert.strictEqual(noFuel.value, depr + servicing + maintenance);
assert.strictEqual(noFuel.value - idle(excavator, PRICE, IDLE_RATE, 1000, false).value, 0);
console.log('✓ missing fuel pricing omits the fuel part and flags it');

[null, undefined, 0, -2, NaN].forEach(function(badRate) {
  var missingRate = working(excavator, PRICE, badRate, 1000, true);
  assert.strictEqual(missingRate.value, null);
  assert.strictEqual(missingRate.hasMissing, true);
  assert.deepStrictEqual(
    missingRate.missing.fuelMissing,
    ['Measured working fuel burn (needs at least 3 days of Fleet Fuel data)']
  );
  assert.notStrictEqual(missingRate.value, fullIdle.value);
});
console.log('✓ a null working rate stays null with the 3-day message and never uses a default');

var truck = {
  asset_name: 'Unit 7',
  asset_type: 'Rigid Truck',
  current_value: 90000,
  estimated_end_of_life_value: 15000,
  expected_life_km: 500000,
  service_cost_per_km: 0.08,
  estimated_annual_repair_cost: 6000,
  estimated_annual_km: 40000
};
var truckResult = working(truck, PRICE, WORKING_RATE, 1000, true);
assert.strictEqual(truckResult.value, null);
assert.strictEqual(truckResult.hasMissing, false);
assert.strictEqual(truckResult.missing.fuelMissing, null);
console.log('✓ an on-road asset returns null');

var overLife = working(excavator, PRICE, WORKING_RATE, 20000, true);
var overLifeIdle = idle(excavator, PRICE, IDLE_RATE, 20000, true);
assert.strictEqual(overLife.missing.depreciationLifeExceeded, overLifeIdle.missing.depreciationLifeExceeded);
assert.strictEqual(overLife.missing.depreciationLifeNearLimit, overLifeIdle.missing.depreciationLifeNearLimit);
assert.strictEqual(overLife.hasMissing, overLifeIdle.hasMissing);
console.log('✓ life-exceeded and near-limit flags match the idle per-hour cost');

function assertNewestLimitedQuery(html, label) {
  var marker = "select('record_date, operating_hours, idle_hours, working_fuel_litres')";
  var idx = html.indexOf(marker);
  assert.ok(idx !== -1, label + ' selects the working-fuel columns');
  var slice = html.slice(idx, idx + 450);
  assert.ok(slice.indexOf(".not('working_fuel_litres', 'is', null)") !== -1, label + ' skips null litres');
  assert.ok(slice.indexOf('ascending: false') !== -1, label + ' orders newest first');
  assert.ok(slice.indexOf('.limit(120)') !== -1, label + ' limits to 120');
  assert.strictEqual(slice.indexOf('dateFrom'), -1, label + ' is not date-filtered');
  assert.strictEqual(slice.indexOf(".gte('record_date'"), -1, label + ' has no date lower bound');
}

var home = fs.readFileSync(path.join(__dirname, '../home.html'), 'utf8');
assert.ok(home.indexOf('Cost per hour by machine') !== -1);
assert.ok(home.indexOf('Idle cost per hour') !== -1);
assert.ok(home.indexOf('Working cost per hour') !== -1);
assert.ok(home.indexOf('Fuel burn basis') !== -1);
assert.ok(home.indexOf('Promise.all(machines.map') !== -1);
assert.ok(home.indexOf('!FCM.isOnRoad(asset)') !== -1);
assert.ok(home.indexOf("+ extra + ' more machines'") !== -1);
assert.ok(home.indexOf("select('asset_id, idle_hours, operating_hours, total_engine_hours, litres_consumed, record_date')") !== -1);
assert.strictEqual(home.split('working_fuel_litres').length - 1, 2);
assertNewestLimitedQuery(home, 'Overview');
var topAt = home.indexOf('Top 5 Most Expensive Assets This Month');
var cardAt = home.indexOf('Cost per hour by machine');
assert.ok(topAt !== -1 && cardAt > topAt);
console.log('✓ Overview card queries each machine for its newest 120 Fleet Fuel rows');

console.log('ALL WORKING COST PER HOUR TESTS PASSED');
