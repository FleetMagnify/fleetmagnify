/**
 * Cost per idle hour. Invented asset names and figures only.
 *   node scripts/test-idle-cost-per-hour.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var FCM = require('../js/fleet-cost-model');

var IDLE_RATE = 4;
var PRICE = 2.5;
var HOURS = 6.5;

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

function perHour(asset, price, rate, engineHours, fuelOk) {
  return FCM.calcIdleCostPerHour(asset, price, rate, engineHours, fuelOk);
}

function costs(asset, idleHours, price, rate, engineHours, fuelOk) {
  return FCM.calcIdleHourCosts(asset, idleHours, price, rate, engineHours, fuelOk);
}

var depr = (180000 - 20000) / 8000;
var servicing = 12;
var annualHours = 40 * 52 * (50 / 100);
var maintenance = 10400 / annualHours;
var fuel = IDLE_RATE * PRICE;
var expected = depr + servicing + maintenance + fuel;

assert.strictEqual(depr, 20);
assert.strictEqual(annualHours, 1040);
assert.strictEqual(maintenance, 10);
assert.strictEqual(fuel, 10);
assert.strictEqual(expected, 52);

var full = perHour(excavator, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(full.value, expected);
assert.strictEqual(full.hasMissing, false);
console.log('✓ excavator with all fields is $52.00 per idle hour');

var period = costs(excavator, HOURS, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(full.value * HOURS, period.total);
console.log('✓ per-hour value × idle hours equals calcIdleHourCosts total');

var noTarget = Object.assign({}, excavator);
delete noTarget.target_utilisation_percent;
var partialMaint = perHour(noTarget, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(partialMaint.hasMissing, true);
assert.strictEqual(partialMaint.value, depr + servicing + fuel);
assert.deepStrictEqual(partialMaint.missing.maintenanceMissing, ['Target Utilisation Percent']);
assert.strictEqual(
  FCM.formatMissingMessage(partialMaint.missing.maintenanceMissing),
  'Cannot calculate — missing: Target Utilisation Percent'
);
console.log('✓ missing target utilisation is a partial rate with that missing text');

var noFuel = perHour(excavator, PRICE, IDLE_RATE, 1000, false);
assert.strictEqual(noFuel.hasMissing, true);
assert.deepStrictEqual(noFuel.missing.fuelMissing, ['Fuel records for selected period']);
assert.strictEqual(noFuel.value, depr + servicing + maintenance);
var noFuelPeriod = costs(excavator, HOURS, PRICE, IDLE_RATE, 1000, false);
assert.strictEqual(noFuel.value * HOURS, noFuelPeriod.total);
console.log('✓ missing fuel pricing omits the fuel part and still matches the period total');

var quiet = perHour(excavator, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(quiet.value, expected);
var zeroPeriod = costs(excavator, 0, PRICE, IDLE_RATE, 1000, true);
assert.strictEqual(quiet.value * 0, zeroPeriod.total);
console.log('✓ zero idle hours still returns the per-hour value');

var truck = {
  asset_name: 'Unit 7',
  asset_type: 'Rigid Truck',
  current_value: 90000,
  estimated_end_of_life_value: 15000,
  expected_life_km: 500000,
  service_cost_per_km: 0.08,
  estimated_annual_repair_cost: 6000,
  estimated_annual_km: 40000,
  is_on_road: false
};
assert.strictEqual(perHour(truck, PRICE, 2.5, 1000, true).value, null);
console.log('✓ an on-road asset returns null');

var overLife = perHour(excavator, PRICE, IDLE_RATE, 20000, true);
var overLifeCosts = costs(excavator, 4, PRICE, IDLE_RATE, 20000, true);
assert.strictEqual(overLife.missing.depreciationLifeExceeded, overLifeCosts.depreciationLifeExceeded);
assert.strictEqual(overLife.missing.depreciationLifeNearLimit, overLifeCosts.depreciationLifeNearLimit);
assert.strictEqual(overLife.hasMissing, overLifeCosts.hasMissing);
console.log('✓ life-exceeded and near-limit flags match calcIdleHourCosts');

var page = fs.readFileSync(path.join(__dirname, '../idle-cost-analyst.html'), 'utf8');
assert.ok(page.indexOf('Cost per idle hour') !== -1);
assert.ok(page.indexOf('kpi-row-components') !== -1);
assert.ok(page.indexOf('fuel + depreciation + servicing + maintenance') !== -1);
assert.ok(page.indexOf('calcIdleCostPerHour') !== -1);
console.log('✓ Idle Cost Analyst page has the per-hour tile');

console.log('ALL IDLE COST PER HOUR TESTS PASSED');
