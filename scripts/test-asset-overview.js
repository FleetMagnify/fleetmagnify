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

check('module ratios are null when run hours are zero, never NaN or Infinity', function() {
  assert.strictEqual(FCM.fuelPerRunHour(100, 0), null);
  assert.strictEqual(FCM.fuelPerRunHour(100, null), null);
  assert.strictEqual(FCM.fuelPerRunHour(0, 10), 0);
  assert.strictEqual(FCM.idleShareOfRunTime(0, 0), null);
  assert.strictEqual(FCM.idleShareOfRunTime(24, null), null);
  assert.strictEqual(FCM.idleShareOfRunTime(null, 120), null);
  assert.ok(Math.abs(FCM.idleShareOfRunTime(24, 96) - 0.2) < 1e-12);
  assert.ok(Math.abs(FCM.idleShareOfRunTime(1.0, 4.8) - (1.0 / 5.8)) < 1e-12);
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

  var workingHours = 96;
  var run = FCM.runHours(workingHours, idleHours);
  assert.strictEqual(run, 120);
  var operating = FCM.calcOperatingHourCosts(excavator, run, 1000);
  var onWorkingOnly = FCM.calcOperatingHourCosts(excavator, workingHours, 1000);
  assert.ok(operating.depreciation > onWorkingOnly.depreciation);
  var breakdownTotal = workingPart + idlePart + operating.depreciation + operating.servicing + operating.maintenance;
  var perHour = FCM.costPerRunHour(breakdownTotal, run);
  assert.ok(Math.abs(perHour * run - breakdownTotal) < 1e-6);

  var idleCost = FCM.calcIdleHourCosts(excavator, idleHours, price, idleRate, 1000, true);
  assert.strictEqual(idleCost.hasMissing, false);
  assert.ok(idleCost.total != null);
  assert.ok(Math.abs(idleCost.total - ((idleCost.fuel || 0) + (idleCost.depreciation || 0) + (idleCost.servicing || 0) + (idleCost.maintenance || 0))) < 1e-6);
});

check('run hours are working hours plus idle, and unknown stays null', function() {
  assert.strictEqual(FCM.runHours(4.8, 1.0), 5.8);
  assert.strictEqual(FCM.runHours(4.8, null), 4.8);
  assert.strictEqual(FCM.runHours(4.8, ''), 4.8);
  assert.strictEqual(FCM.runHours(0, 0), 0);
  assert.strictEqual(FCM.runHours(null, 1), null);
  assert.strictEqual(FCM.runHours(null, null), null);
  assert.strictEqual(FCM.runHours('', 1), null);
  assert.strictEqual(FCM.runHours(4.8, 'nope'), null);
});

check('hour meter case: working 4.757 plus idle 0.95 is 5.707 run hours', function() {
  var run = FCM.runHours(4.757, 0.95);
  assert.ok(Math.abs(run - 5.707) < 1e-9);
  assert.ok(Math.abs(FCM.idleShareOfRunTime(0.95, 4.757) - (0.95 / 5.707)) < 1e-9);
  assert.strictEqual(FCM.idleShareOfRunTime(0.95, null), null);
});

check('invented day: working rate, run hours, idle share, and idle burn', function() {
  var working = 4.8;
  var idle = 1.0;
  var workingFuel = 100;
  var idleFuel = 4;
  var run = FCM.runHours(working, idle);
  assert.ok(Math.abs(run - 5.8) < 1e-12);
  assert.ok(Math.abs(workingFuel / working - (100 / 4.8)) < 1e-12);
  assert.strictEqual(Math.round((workingFuel / working) * 100) / 100, 20.83);
  assert.ok(Math.abs(FCM.idleShareOfRunTime(idle, working) - (1.0 / 5.8)) < 1e-12);
  assert.strictEqual(idleFuel / idle, 4);
  var rows = [];
  ['2026-06-01', '2026-06-02', '2026-06-03'].forEach(function(date) {
    rows.push({
      record_date: date,
      operating_hours: working,
      idle_hours: idle,
      working_fuel_litres: workingFuel,
      idle_fuel_litres: idleFuel
    });
  });
  var measured = FCM.measuredWorkingRate(rows);
  assert.strictEqual(measured.rate, 20.83);
  assert.ok(Math.abs(measured.workingHours - 14.4) < 1e-9);
});

check('fixed costs on the asset overview basis are charged on run hours', function() {
  var working = 4.8;
  var idle = 1.0;
  var run = FCM.runHours(working, idle);
  var onRun = FCM.calcOperatingHourCosts(excavator, run, 1000);
  var onWorking = FCM.calcOperatingHourCosts(excavator, working, 1000);
  var depr = FCM.calcDepreciationPerHour(excavator, 1000);
  var serv = FCM.getServicingPerHour(excavator);
  var maint = FCM.calcMaintenancePerHour(excavator);
  assert.ok(Math.abs(onRun.depreciation - run * depr.value) < 1e-6);
  assert.ok(Math.abs(onRun.servicing - run * serv.value) < 1e-6);
  assert.ok(Math.abs(onRun.maintenance - run * maint.value) < 1e-6);
  assert.ok(onRun.depreciation > onWorking.depreciation);
  assert.ok(onRun.servicing > onWorking.servicing);
  assert.ok(onRun.maintenance > onWorking.maintenance);

  var price = 2.5;
  var workingFuelCost = 100 * price;
  var idleFuelCost = 4 * price;
  var breakdownTotal = workingFuelCost + idleFuelCost + onRun.depreciation + onRun.servicing + onRun.maintenance;
  var perHour = FCM.costPerRunHour(breakdownTotal, run);
  assert.ok(Math.abs(perHour * run - breakdownTotal) < 1e-6);
  var perWorking = FCM.costPerRunHour(breakdownTotal, working);
  assert.ok(perHour < perWorking);
});

var page = fs.readFileSync(path.join(__dirname, '..', 'asset-overview.html'), 'utf8');
var model = fs.readFileSync(path.join(__dirname, '..', 'js', 'fleet-cost-model.js'), 'utf8');
var sidebar = fs.readFileSync(path.join(__dirname, '..', 'js', 'sidebar-nav.js'), 'utf8');
var sidebarCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'sidebar.css'), 'utf8');
var mobileNav = fs.readFileSync(path.join(__dirname, '..', 'js', 'mobile-nav.js'), 'utf8');

check('asset overview charges run hours and labels working hours on the utilisation card', function() {
  assert.ok(page.indexOf('var periodRunHours = FCM.runHours(workingHours, idleHours);') !== -1);
  assert.ok(page.indexOf('FCM.calcOperatingHourCosts(asset, periodRunHours, totalEngineHours)') !== -1);
  assert.ok(page.indexOf('FCM.fuelPerRunHour(litresKnown, runForRates)') !== -1);
  assert.ok(page.indexOf('FCM.co2ForPeriod(litresKnown, asset.fuel_type, runForRates)') !== -1);
  assert.ok(page.indexOf('FCM.costPerRunHour(periodTotal, runForRates)') !== -1);
  assert.ok(page.indexOf('FCM.hoursAgainstTarget(workingKnown, available, target)') !== -1);
  assert.ok(page.indexOf('FCM.idleShareOfRunTime(idleHours, workingHours)') !== -1);
  assert.ok(page.indexOf("statBlock('Working hours'") !== -1);
  assert.ok(page.indexOf("unknownStat('Working hours'") !== -1);
  assert.strictEqual(page.indexOf("statBlock('Run hours'"), -1);
  assert.strictEqual(page.indexOf('bucket.operating - bucket.idle'), -1);
  assert.ok(page.indexOf('workingSeries.push(Math.round(bucket.working * 10) / 10)') !== -1);
  assert.ok(page.indexOf('Daily run hours') !== -1);
  assert.ok(page.indexOf('Fuel per run hour') !== -1);
  assert.ok(page.indexOf('Cost per run hour') !== -1);
  assert.ok(page.indexOf('Per run hour') !== -1);
  assert.ok(page.indexOf('AOR.utilisationForSelection(') !== -1);
  assert.ok(page.indexOf('workingHours: workingHours') !== -1);
  assert.ok(model.indexOf('operating_hours = working hours') !== -1);
  assert.ok(model.indexOf('function runHours(operatingHours, idleHours)') !== -1);
});

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
  assert.ok(page.indexOf('Operating cost, month to date') === -1);
  assert.ok(page.indexOf("'Operating cost, ' + AOR.shortLabel") !== -1);
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
  assert.ok(page.indexOf('>Data to<') !== -1);
  assert.ok(page.indexOf('Last report') === -1);
  assert.ok(page.indexOf('What stands out') === -1);
  assert.ok(page.indexOf('id="callout"') === -1);
  assert.ok(page.indexOf('assetOverviewCallout') === -1);
  assert.strictEqual(FCM.assetOverviewCallout, undefined);
  assert.ok(model.indexOf('function assetOverviewCallout') === -1);
  assert.ok(model.indexOf('function calloutMoney') === -1);
  assert.ok(model.indexOf('function calloutPercent') === -1);
});

check('Idle Cost Analyst top row is three tiles and does not query working fuel', function() {
  var analyst = fs.readFileSync(path.join(__dirname, '..', 'idle-cost-analyst.html'), 'utf8');
  assert.ok(analyst.indexOf('Cost per working hour') === -1);
  assert.ok(analyst.indexOf('setKpiWorkingHour') === -1);
  assert.ok(analyst.indexOf('kpi-working-hour') === -1);
  assert.ok(analyst.indexOf('working_fuel_litres') === -1);
  var topStart = analyst.indexOf('<div class="kpi-row">');
  var topEnd = analyst.indexOf('kpi-row-components', topStart);
  var top = analyst.slice(topStart, topEnd);
  assert.strictEqual((top.match(/class="kpi-card"/g) || []).length, 3);
  assert.ok(top.indexOf('Total Idle Hours') !== -1);
  assert.ok(top.indexOf('Cost per idle hour') !== -1);
  assert.ok(top.indexOf('Total Cost of Idling') !== -1);
  assert.ok(analyst.indexOf('grid-template-columns: repeat(3, 1fr)') !== -1);
  assert.ok(analyst.indexOf('grid-template-columns: repeat(4, 1fr)') !== -1);
  assert.ok(model.indexOf('function measuredWorkingRate') !== -1);
  assert.ok(model.indexOf('function calcWorkingCostPerHour') !== -1);
});

check('sign-in and sign-up use the landing page mobile menu', function() {
  ['login.html', 'signup.html'].forEach(function(file) {
    var text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(text.indexOf('<nav>') !== -1, file);
    assert.ok(text.indexOf('class="nav-inner"') !== -1, file);
    assert.ok(text.indexOf('class="nav-links"') !== -1, file);
    assert.ok(text.indexOf('js/mobile-nav.js') !== -1, file);
    assert.ok(text.indexOf('<header>') === -1, file);
  });
  assert.ok(mobileNav.indexOf("document.querySelector('nav .nav-inner')") !== -1);
  assert.ok(mobileNav.indexOf("btn.className = 'mobile-menu-btn'") !== -1);
  var css = fs.readFileSync(path.join(__dirname, '..', 'css', 'mobile-responsive.css'), 'utf8');
  assert.ok(css.indexOf('.nav-inner > .nav-links') !== -1);
  assert.ok(css.indexOf('min-height: 44px') !== -1);
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
