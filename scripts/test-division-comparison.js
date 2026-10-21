/**
 * Division filter identity and comparison totals.
 *
 *   node scripts/test-division-comparison.js
 */
var assert = require('assert');
require('../js/fleet-cost-model');
var filter = require('../js/division-filter');
var compare = require('../js/division-comparison');
var FCM = require('../js/fleet-cost-model');

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

var divisions = [
  { id: 10, name: 'North' },
  { id: 20, name: 'South' }
];

console.log('\n=== Division filter ===');

var owner = { hasDivisions: true, isDivisionManager: false, divisions: divisions };
var noDivisions = { hasDivisions: false, isDivisionManager: false, divisions: [] };
var manager = { hasDivisions: true, isDivisionManager: true, divisions: [divisions[0]] };
check('Owner with divisions sees the filter', filter.shouldShow(owner) === true);
check('Account with no divisions hides the filter', filter.shouldShow(noDivisions) === false);
check('Divisional manager does not get the owner filter', filter.shouldShow(manager) === false);

var assets = [
  { id: 1, division_id: 10, asset_name: 'North truck' },
  { id: 2, division_id: 20, asset_name: 'South machine' },
  { id: 3, division_id: null, asset_name: 'Spare' }
];
check('All returns the same array', filter.filterAssets(assets, '') === assets);
check('The word all returns the same array', filter.filterAssets(assets, 'all') === assets);
check('Null selection returns the same array', filter.filterAssets(assets, null) === assets);

var north = filter.filterAssets(assets, '10');
check('A division keeps only its assets', north.length === 1 && north[0].id === 1);
check('A division filter is a new array', north !== assets);
var unassigned = filter.filterAssets(assets, 'unassigned');
check('Unassigned keeps assets with no division', unassigned.length === 1 && unassigned[0].id === 3);

check('Unknown division id is treated as All', filter.normaliseSelection('999', divisions) === '');
check('Blank and all normalise to All', filter.normaliseSelection(' all ', divisions) === '');
check('Unassigned normalises', filter.normaliseSelection('Unassigned', divisions) === 'unassigned');

var memory = {
  value: null,
  getItem: function() { return this.value; },
  setItem: function(key, value) { this.value = value; },
  removeItem: function() { this.value = null; }
};
check(
  'A division link is stored',
  filter.selectionFromStorage(memory, divisions, '10') === '10' && memory.value === '10'
);
check(
  'Stored choice is read on the next page',
  filter.selectionFromStorage(memory, divisions, undefined) === '10'
);
memory.value = '10';
check(
  'All from a link clears the stored choice',
  filter.selectionFromStorage(memory, divisions, '') === '' && memory.value === null
);

var throwing = {
  getItem: function() { throw new Error('denied'); },
  setItem: function() { throw new Error('denied'); },
  removeItem: function() { throw new Error('denied'); }
};
check('Blocked storage reads as All', filter.selectionFromStorage(throwing, divisions, undefined) === '');
check('Blocked storage still accepts a known link', filter.selectionFromStorage(throwing, divisions, '20') === '20');

var idSet = { '2': true };
var jobRows = [
  { job_id: 7, asset_id: 2 },
  { job_id: 8, asset_id: 1 }
];
check('No id set leaves job rows untouched', filter.restrictByAssetId(jobRows, null) === jobRows);
var kept = filter.restrictByAssetId(jobRows, idSet);
check('Job rows can be limited to the filtered assets', kept.length === 1 && kept[0].job_id === 7);
var touched = filter.touchingJobIds(jobRows, idSet);
check('Jobs touching the division are listed', touched['7'] === true && !touched['8']);
check('All does not list a job subset', filter.touchingJobIds(jobRows, null) === null);

console.log('\n=== Comparison totals ===');

var truck = {
  id: 1,
  division_id: 10,
  asset_name: 'Tipper',
  asset_type: 'Rigid Truck',
  current_value: 100000,
  estimated_end_of_life_value: 20000,
  expected_life_km: 500000,
  current_odometer: 10000,
  service_cost_per_km: 0.05,
  estimated_annual_repair_cost: 5000,
  estimated_annual_km: 50000,
  available_hours_per_week: 40,
  fuel_type: 'Diesel'
};
var machine = {
  id: 2,
  division_id: 20,
  asset_name: 'Excavator',
  asset_type: 'Excavator',
  current_value: 80000,
  estimated_end_of_life_value: 8000,
  expected_life_hours: 10000,
  service_cost_per_hour: 5,
  estimated_annual_repair_cost: 4000,
  available_hours_per_week: 40,
  target_utilisation_percent: 80,
  fuel_type: 'Diesel'
};
var spare = {
  id: 3,
  division_id: null,
  asset_name: 'Spare excavator',
  asset_type: 'Excavator',
  current_value: 40000,
  estimated_end_of_life_value: 4000,
  expected_life_hours: 8000,
  service_cost_per_hour: 4,
  estimated_annual_repair_cost: 2000,
  available_hours_per_week: 40,
  target_utilisation_percent: 50,
  fuel_type: 'Diesel'
};

var input = {
  assets: [truck, machine, spare],
  divisions: divisions,
  machineryCpl: 2,
  dateFrom: '2026-10-01',
  dateTo: '2026-10-14',
  telRows: [
    { asset_id: 1, operating_hours: 10, idle_hours: 2, daily_distance_km: 100, litres_consumed: 5, total_engine_hours: 4000, record_date: '2026-10-02' },
    { asset_id: 2, operating_hours: 8, idle_hours: 2, daily_distance_km: 0, litres_consumed: 40, total_engine_hours: 1200, record_date: '2026-10-03' },
    { asset_id: 3, operating_hours: 4, idle_hours: 1, daily_distance_km: 0, litres_consumed: 10, total_engine_hours: 600, record_date: '2026-10-04' }
  ],
  latestTelRows: [
    { asset_id: 1, total_engine_hours: 4000, record_date: '2026-10-02' },
    { asset_id: 2, total_engine_hours: 1200, record_date: '2026-10-03' },
    { asset_id: 3, total_engine_hours: 600, record_date: '2026-10-04' }
  ],
  purchaseRows: [
    { vehicle_id: 1, litres: 100, cost_nzd: 250, purchase_date: '2026-10-02' }
  ],
  jobRows: [
    { job_id: 70, asset_id: 1, work_date: '2026-10-02' },
    { job_id: 70, asset_id: 2, work_date: '2026-10-03' },
    { job_id: 71, asset_id: 3, work_date: '2026-09-01' }
  ]
};

var built = compare.buildDivisionComparison(input);
var northRow = built.rows.filter(function(row) { return String(row.id) === '10'; })[0];
var southRow = built.rows.filter(function(row) { return String(row.id) === '20'; })[0];
var spareRow = built.rows.filter(function(row) { return row.kind === 'unassigned'; })[0];
var account = built.account;

check('Every division is a row', !!northRow && !!southRow);
check('Unassigned is always a row', !!spareRow && spareRow.name === 'Unassigned');
check('Asset counts add up', northRow.assetCount + southRow.assetCount + spareRow.assetCount === account.assetCount);
check('Account asset count is the whole fleet', account.assetCount === 3);

function sum(key) {
  return northRow[key] + southRow[key] + spareRow[key];
}
check('Fuel litres add up to the account', Math.abs(sum('litres') - account.litres) < 1e-9);
check('Fuel cost adds up to the account', Math.abs(sum('fuelCost') - account.fuelCost) < 1e-9);
check('Running cost adds up to the account', Math.abs(sum('runningCost') - account.runningCost) < 1e-9);
check('Operating hours add up', Math.abs(sum('operatingHours') - account.operatingHours) < 1e-9);

var truckFuel = FCM.assetFuelTotals(truck, { purchaseRows: input.purchaseRows, telRows: [], machineryCpl: 2 });
var expectedRunning = FCM.calcRunningCostPerKm(truck, truckFuel.cost / 100, truck.current_odometer);
check('Truck fuel uses invoice totals', truckFuel.litres === 100 && truckFuel.cost === 250 && northRow.litres === 100);
check('Cost per km uses calcRunningCostPerKm', expectedRunning.total != null && Math.abs(northRow.costPerKm - expectedRunning.total) < 1e-9);

var machineFuel = FCM.assetFuelTotals(machine, {
  telRows: input.telRows.filter(function(row) { return row.asset_id === 2; }),
  machineryCpl: 2
});
check('Machinery fuel uses telematics litres times the bulk price', machineFuel.litres === 40 && machineFuel.cost === 80 && southRow.litres === 40);

var depr = FCM.calcDepreciationPerHour(machine, 1200);
var serv = FCM.getServicingPerHour(machine);
var maint = FCM.calcMaintenancePerHour(machine);
var expectedHour = machineFuel.cost + (depr.value + serv.value + maint.value) * 8;
check('Cost per operating hour uses the hourly cost model', depr.ok && serv.ok && maint.ok);
check('South cost per hour matches the model', Math.abs(southRow.costPerHour - (expectedHour / 8)) < 1e-6);

check('A shared job is counted in each division', northRow.jobs === 1 && southRow.jobs === 1);
check('Account jobs are the distinct set', account.jobs === 1);
check('A job outside the period is not counted', spareRow.jobs === 0);

check('Truck division opens cost per km', northRow.href.indexOf('cost-per-km-analyst.html?division=10') === 0);
check('Machinery division opens fuel analyst', southRow.href.indexOf('fuel-analyst.html?division=20') === 0);
check(
  'A machinery-only unassigned row opens fuel analyst',
  spareRow.href.indexOf('fuel-analyst.html?division=unassigned') === 0
);
check(
  'A mixed division opens the overview',
  compare.analystHref({ truckCount: 1, machineCount: 1, kind: 'division', id: 5 }).indexOf('home.html?division=5') === 0
);

var rates = built.rows.map(function(row) { return row.fuelPerAsset; }).filter(function(value) { return value != null; });
var lowest = Math.min.apply(null, rates);
var highest = Math.max.apply(null, rates);
var lowRow = built.rows.filter(function(row) { return row.marks.fuelPerAsset === 'lowest'; })[0];
var highRow = built.rows.filter(function(row) { return row.marks.fuelPerAsset === 'highest'; })[0];
check('Lowest and highest are marked on a normalised rate', !!lowRow && !!highRow && lowRow !== highRow);
check('Lowest mark is the smaller fuel cost per asset', lowRow.fuelPerAsset === lowest && highRow.fuelPerAsset === highest);
check('The account total is not marked', !account.marks.fuelPerAsset);

var same = compare.buildDivisionComparison({
  assets: [
    { id: 1, division_id: 10, asset_type: 'Excavator', available_hours_per_week: 40 },
    { id: 2, division_id: 20, asset_type: 'Excavator', available_hours_per_week: 40 }
  ],
  divisions: divisions,
  telRows: [],
  latestTelRows: [],
  purchaseRows: [],
  jobRows: [],
  machineryCpl: 0,
  dateFrom: '2026-10-01',
  dateTo: '2026-10-07'
});
check('Equal rates are not marked', same.rows.every(function(row) { return !row.marks.fuelPerAsset; }));

console.log('\nAll division comparison tests passed.');
