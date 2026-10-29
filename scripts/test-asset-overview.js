/**
 * Asset overview: operating-hour cost split, the "what stands out" sentences,
 * and static checks that the page and sidebar stay account-scoped.
 * Invented machine: Excavator 12. No customer data.
 *
 *   node scripts/test-asset-overview.js
 */
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var FCM = require('../js/fleet-cost-model');

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

var excavator = {
  asset_name: 'Excavator 12',
  asset_type: 'Excavator',
  registration: 'EQ000001',
  current_value: 200000,
  estimated_end_of_life_value: 20000,
  expected_life_hours: 10000,
  service_cost_per_hour: 8,
  estimated_annual_repair_cost: 12000,
  available_hours_per_week: 40,
  target_utilisation_percent: 75,
  idle_burn_rate_lph: 4,
  idle_rate_source: 'set'
};

check('operating-hour costs match the per-hour rates times run hours', function() {
  var hours = 120;
  var engineHours = 1000;
  var costs = FCM.calcOperatingHourCosts(excavator, hours, engineHours);
  var depr = FCM.calcDepreciationPerHour(excavator, engineHours);
  var serv = FCM.getServicingPerHour(excavator);
  var maint = FCM.calcMaintenancePerHour(excavator);
  assert.strictEqual(depr.ok, true);
  assert.strictEqual(costs.depreciation, hours * depr.value);
  assert.strictEqual(costs.servicing, hours * serv.value);
  assert.strictEqual(costs.maintenance, hours * maint.value);
  assert.strictEqual(costs.hasMissing, false);
  assert.strictEqual(costs.depreciation, 2160);
  assert.strictEqual(costs.servicing, 960);
});

check('zero operating hours gives zero amounts when the fields are set', function() {
  var costs = FCM.calcOperatingHourCosts(excavator, 0, 1000);
  assert.strictEqual(costs.depreciation, 0);
  assert.strictEqual(costs.servicing, 0);
  assert.strictEqual(costs.maintenance, 0);
  assert.strictEqual(costs.hasMissing, false);
});

check('missing fields use the same wording helpers as the other pages', function() {
  var bare = { asset_name: 'Excavator 12', asset_type: 'Excavator' };
  var costs = FCM.calcOperatingHourCosts(bare, 10, null);
  assert.deepStrictEqual(costs.depreciationMissing, FCM.getMissingDepreciationFields(bare));
  assert.deepStrictEqual(costs.servicingMissing, FCM.getMissingServicingFields(bare));
  assert.deepStrictEqual(costs.maintenanceMissing, FCM.getMissingMaintenanceFields(bare));
  assert.strictEqual(costs.depreciation, null);
  assert.strictEqual(costs.servicing, null);
  assert.strictEqual(costs.maintenance, null);
  assert.strictEqual(
    FCM.formatMissingMessage(costs.depreciationMissing),
    'Cannot calculate — missing: Current Value, Estimated End of Life Value, Expected Total Life (hours)'
  );
  assert.strictEqual(
    FCM.formatMissingMessage(costs.maintenanceMissing),
    'Cannot calculate — missing: Estimated Annual Repair Cost, Available Hours Per Week, Target Utilisation Percent'
  );
});

check('life-exceeded and near-limit flags pass through from the hourly helper', function() {
  var costs = FCM.calcOperatingHourCosts(excavator, 10, 999999);
  var idle = FCM.calcIdleHourCosts(excavator, 10, 2.5, 4, 999999, true);
  var hourly = FCM.calcDepreciationPerHour(excavator, 999999);
  assert.strictEqual(costs.depreciationLifeExceeded, !!hourly.lifeExceeded);
  assert.strictEqual(costs.depreciationLifeNearLimit, !!hourly.lifeNearLimit);
  assert.strictEqual(costs.depreciationLifeExceeded, idle.depreciationLifeExceeded);
  assert.strictEqual(costs.depreciationLifeNearLimit, idle.depreciationLifeNearLimit);
});

check('an on-road asset returns null amounts', function() {
  var truck = {
    asset_name: 'Tipper 4',
    asset_type: 'Rigid Truck',
    current_value: 80000,
    estimated_eol_value: 10000,
    expected_total_life_km: 500000,
    servicing_cost_per_km: 0.08,
    annual_repair_maintenance_cost: 4000,
    estimated_annual_km: 40000
  };
  var costs = FCM.calcOperatingHourCosts(truck, 40, null);
  assert.strictEqual(costs.depreciation, null);
  assert.strictEqual(costs.servicing, null);
  assert.strictEqual(costs.maintenance, null);
  assert.strictEqual(costs.depreciationMissing, null);
  assert.strictEqual(costs.hasMissing, false);
});

check('fuel idle plus fuel working equals total fuel, and fixed costs match the working-hour rate', function() {
  var price = 2.5;
  var idleRate = 4;
  var workingRate = 14;
  var idleHours = 24;
  var operatingHours = 120;
  var litres = 1800;
  var totalFuel = litres * price;
  var idleFuel = idleHours * idleRate * price;
  var workingFuel = Math.max(0, totalFuel - idleFuel);
  assert.strictEqual(idleFuel + workingFuel, totalFuel);

  var operating = FCM.calcOperatingHourCosts(excavator, operatingHours, 1000);
  var working = FCM.calcWorkingCostPerHour(excavator, price, workingRate, 1000, true);
  var fuelPart = workingRate * price;
  var fixed = operating.depreciation + operating.servicing + operating.maintenance;
  assert.ok(Math.abs(fixed - operatingHours * (working.value - fuelPart)) < 1e-6);
});

var calloutInput = {
  partial: false,
  idleHours: 24,
  operatingHours: 120,
  idleCost: 700,
  totalCost: 10000,
  workingPerHour: 140,
  idlePerHour: 43,
  workingRate: 10,
  idleRate: 4,
  pricePerLitre: 2
};

check('the callout is shown only when every input exists', function() {
  var shown = FCM.assetOverviewCallout(calloutInput);
  assert.strictEqual(shown.show, true);
  assert.strictEqual(
    shown.sentences[0],
    'Idle time is 20% of this machine\'s run hours but only 7% of its cost, because most of an idle hour\'s cost is fixed (depreciation, servicing, maintenance), not fuel.'
  );
  assert.strictEqual(
    shown.sentences[1],
    'A working hour costs $97 more than an idle hour, of which $12 is fuel.'
  );
  var missing = Object.assign({}, calloutInput, { pricePerLitre: null });
  assert.deepStrictEqual(FCM.assetOverviewCallout(missing), { show: false, sentences: [] });
});

check('sentence 1 is absent when idle cost share is not below the idle hours share', function() {
  var result = FCM.assetOverviewCallout(Object.assign({}, calloutInput, { idleCost: 5000 }));
  assert.strictEqual(result.sentences.length, 1);
  assert.ok(result.sentences[0].indexOf('working hour') !== -1);
});

check('sentence 2 is absent when a working hour does not cost more than an idle hour', function() {
  var result = FCM.assetOverviewCallout(Object.assign({}, calloutInput, { workingPerHour: 43 }));
  assert.strictEqual(result.sentences.length, 1);
  assert.ok(result.sentences[0].indexOf('Idle time is') === 0);
});

check('partial data hides the callout', function() {
  var result = FCM.assetOverviewCallout(Object.assign({}, calloutInput, { partial: true }));
  assert.deepStrictEqual(result, { show: false, sentences: [] });
  var neither = FCM.assetOverviewCallout(Object.assign({}, calloutInput, { idleCost: 8000, workingPerHour: 40 }));
  assert.strictEqual(neither.show, false);
});

check('module ratios are null when run hours are zero, never NaN or Infinity', function() {
  assert.strictEqual(FCM.fuelPerRunHour(100, 0), null);
  assert.strictEqual(FCM.fuelPerRunHour(100, null), null);
  assert.strictEqual(FCM.fuelPerRunHour(0, 10), 0);
  assert.strictEqual(FCM.idleShareOfRunTime(24, 0), null);
  assert.strictEqual(FCM.idleShareOfRunTime(24, 120), 0.2);
  assert.strictEqual(FCM.costPerRunHour(1440, 0), null);
  assert.strictEqual(FCM.costPerRunHour(null, 12), null);
  var co2None = FCM.co2ForPeriod(100, 'Diesel', 0);
  assert.strictEqual(co2None.kgPerRunHour, null);
  assert.ok(Number.isFinite(co2None.tonnes));
  [FCM.fuelPerRunHour(10, 4), FCM.costPerRunHour(80, 4), FCM.co2ForPeriod(10, 'Diesel', 4).kgPerRunHour].forEach(function(value) {
    assert.ok(Number.isFinite(value));
  });
});

check('hours against target is short, ahead, or no target', function() {
  assert.deepStrictEqual(FCM.hoursAgainstTarget(120, 154, null), { state: 'none', hours: null });
  var short = FCM.hoursAgainstTarget(120, 154, 80);
  assert.strictEqual(short.state, 'short');
  assert.ok(Math.abs(short.hours - 3.2) < 1e-9);
  var ahead = FCM.hoursAgainstTarget(130, 154, 80);
  assert.strictEqual(ahead.state, 'ahead');
  assert.ok(Math.abs(ahead.hours - 6.8) < 1e-9);
  assert.strictEqual(FCM.hoursAgainstTarget(0, 40, 50).state, 'short');
  assert.ok(Number.isFinite(FCM.hoursAgainstTarget(0, 40, 50).hours));
});

check('CO2 uses the fuel factor, and an unknown fuel type uses diesel', function() {
  var diesel = FCM.co2ForPeriod(1000, 'Diesel', 10);
  assert.strictEqual(diesel.tonnes, 2.68);
  assert.strictEqual(diesel.kgPerRunHour, 268);
  var petrol = FCM.co2ForPeriod(1000, 'Petrol', 10);
  assert.strictEqual(petrol.tonnes, 2.31);
  assert.strictEqual(FCM.co2ForPeriod(1000, 'Unknown', 10).tonnes, 2.68);
  assert.deepStrictEqual(FCM.co2ForPeriod(null, 'Diesel', 10), { tonnes: null, kgPerRunHour: null });
});

check('fuel cost equals the two breakdown fuel rows, and cost per run hour scales back to the total', function() {
  var workingFuel = 10287;
  var idleFuel = 240;
  assert.strictEqual(FCM.breakdownFuelCost(workingFuel, idleFuel), workingFuel + idleFuel);
  assert.strictEqual(FCM.breakdownFuelCost(null, idleFuel), null);

  var price = 2.5;
  var idleRate = 4;
  var idleHours = 24;
  var litres = 1800;
  var totalFuel = litres * price;
  var idlePart = idleHours * idleRate * price;
  var workingPart = Math.max(0, totalFuel - idlePart);
  assert.strictEqual(FCM.breakdownFuelCost(workingPart, idlePart), totalFuel);

  var operatingHours = 120;
  var operating = FCM.calcOperatingHourCosts(excavator, operatingHours, 1000);
  var breakdownTotal = workingPart + idlePart + operating.depreciation + operating.servicing + operating.maintenance;
  var perHour = FCM.costPerRunHour(breakdownTotal, operatingHours);
  assert.ok(Math.abs(perHour * operatingHours - breakdownTotal) < 1e-6);

  var idleCost = FCM.calcIdleHourCosts(excavator, idleHours, price, idleRate, 1000, true);
  assert.strictEqual(idleCost.hasMissing, false);
  assert.ok(idleCost.total != null);
  assert.ok(Math.abs(idleCost.total - ((idleCost.fuel || 0) + (idleCost.depreciation || 0) + (idleCost.servicing || 0) + (idleCost.maintenance || 0))) < 1e-6);
});

var page = fs.readFileSync(path.join(__dirname, '..', 'asset-overview.html'), 'utf8');
var sidebar = fs.readFileSync(path.join(__dirname, '..', 'js', 'sidebar-nav.js'), 'utf8');
var sidebarCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'sidebar.css'), 'utf8');
var mobileNav = fs.readFileSync(path.join(__dirname, '..', 'js', 'mobile-nav.js'), 'utf8');

check('the sidebar entry is a child of Overview and stays hidden until the account has machinery', function() {
  var overviewAt = sidebar.indexOf("href: 'home.html'");
  var childAt = sidebar.indexOf("href: 'asset-overview.html'");
  assert.ok(overviewAt !== -1 && childAt > overviewAt);
  assert.ok(sidebar.indexOf("text: 'Asset overview', child: true, requiresMachinery: true") !== -1);
  assert.ok(sidebar.indexOf('nav-child') !== -1);
  assert.ok(sidebar.indexOf('parent-active') !== -1);
  assert.ok(sidebar.indexOf('data-machinery-nav') !== -1);
  assert.ok(sidebar.indexOf('composition.hasMachinery') !== -1);
  assert.ok(sidebarCss.indexOf('.nav-child') !== -1);
  assert.ok(sidebarCss.indexOf('.nav-item.parent-active') !== -1);
});

check('the phone drawer closes when a sidebar link, including the new entry, is tapped', function() {
  assert.ok(mobileNav.indexOf("sidebar.querySelectorAll('a, button')") !== -1);
  assert.ok(mobileNav.indexOf('closeMenu') !== -1);
  assert.ok(sidebar.indexOf("'<a class=\"' + cls + '\" href=\"' + item.href") !== -1);
});

check('the page applies the division filter and scopes every query by user_id', function() {
  assert.ok(page.indexOf('FleetMagnifyDivisionFilter.apply') !== -1);
  assert.ok(page.indexOf('FleetMagnifyDivisionFilter.mount') !== -1);
  var fromCount = (page.match(/\.from\('/g) || []).length;
  var userCount = (page.match(/\.eq\('user_id', effectiveAccountId\)/g) || []).length;
  assert.ok(fromCount >= 5);
  assert.strictEqual(fromCount, userCount);
  assert.ok(page.indexOf(".not('working_fuel_litres', 'is', null)") !== -1);
  assert.ok(page.indexOf('.limit(120)') !== -1);
  assert.ok(page.indexOf("order('record_date', { ascending: false })") !== -1);
  assert.ok(page.indexOf('fm_asset_overview_last') !== -1);
  assert.ok(page.indexOf('localStorage.getItem') !== -1);
  assert.ok(page.indexOf('try { return localStorage.getItem') !== -1);
  assert.ok(page.indexOf('history.replaceState') !== -1);
  assert.ok(page.indexOf('Asset overview is for machinery for now') !== -1);
  assert.ok(page.indexOf('FCM.isOnRoad') !== -1);
  assert.ok(page.indexOf('.range(') !== -1);
  assert.ok(page.indexOf('Operating cost, month to date') !== -1);
  assert.ok(page.indexOf('Module summaries') !== -1);
  assert.ok(page.indexOf('Fuel burn') === -1);
  assert.ok(page.indexOf('Go deeper') === -1);
  assert.ok(page.indexOf('job-cost-analyst.html?asset') === -1);
  assert.ok(page.indexOf("moduleCard('job-cost-analyst.html'") !== -1);
  assert.ok(page.indexOf('if (jobRows.length)') !== -1);
  assert.ok(page.indexOf(".from('job_assets')") !== -1);
  assert.ok(page.indexOf(".eq('asset_id', assetId)") !== -1);
  assert.ok(page.indexOf(".gte('work_date', from)") !== -1);
  assert.ok(page.indexOf(".lte('work_date', to)") !== -1);
  assert.ok(page.indexOf('Idle hours only. The breakdown above charges fixed costs on all run hours.') !== -1);
});

var analysts = ['idle-cost-analyst.html', 'fuel-analyst.html', 'utilisation-analyst.html', 'emissions-intelligence.html'];
check('the four analyst pages preselect ?asset= when that machine is in the list', function() {
  analysts.forEach(function(file) {
    var text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(text.indexOf("new URLSearchParams(window.location.search).get('asset')") !== -1, file);
  });
});

if (!pass) process.exit(1);
console.log('All asset overview checks passed.');
