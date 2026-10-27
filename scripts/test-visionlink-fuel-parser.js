/**
 * Local tests for parsers/visionlink-fuel.js.
 * Run: node scripts/test-visionlink-fuel-parser.js
 */
var assert = require('assert');
var fuel = require('../parsers/visionlink-fuel');
var visionlink = require('../parsers/visionlink');

var USER = '00000000-0000-4000-8000-0000000000f1';

var HEADER = [
  'Asset ID',
  'Asset Serial Number',
  'Model Year',
  'Make Display Name',
  'Model',
  'Product Family',
  'Idle Fuel Burn (L)',
  'Idle Time (Hours)',
  'Idle Fuel Burn Rate (L/Hour)',
  'Working Fuel Burn (L)',
  'Total Working Time (Hours)',
  'Working Fuel Burn Rate (L/Hour)',
  'Total Fuel Burned (L)',
  'Runtime (Hours)',
  'Total Fuel Burn Rate (L/Hour)',
  'Working Time %',
].join(',');

function fuelCsv(dateLine) {
  return [
    'Fleet Fuel Report',
    'Report Date Range',
    dateLine,
    HEADER,
    'EQ000001,AAA00001,2017,CAT,558GF,Forestry Excavator,5.2,1.2,4.5,357.2,9.9,35.9,362.5,11.1,32.7,89.6%',
    'EQ000002,AAA00002,2019,CAT,538LL,Forestry Excavator,3.3,0.8,4.1,217.7,8.9,24.4,221.0,9.7,22.7,91.8%',
    'EQ000003,AAA00003,2019,CAT,326FL,Medium Hydraulic Excavator,9.0,2.4,3.8,210.1,7.8,27.0,219.1,10.1,21.6,76.8%',
    'EQ000004,AAA00004,2020,CAT,C7.1,Cat Compact,-,-,-,-,-,-,-,-,-,-',
    'EQ000005,AAA00005,2018,CAT,320,Excavator,"1,234.5",1.0,4.0,"2,345.6",8.0,20.0,"3,580.1",9.0,22.0,80%',
    'EQ000006,AAA00006,2018,CAT,320,Excavator,8.5,1.0,4.0,-,8.0,-,-,-,-,-',
    ',AAA00007,2021,CAT,D6,Dozer,4.0,0.5,8.0,40.0,5.0,8.0,44.0,5.5,8.0,90%',
    'EQ000099,AAA00099,2022,CAT,X,Excavator,1.0,0.1,10,2.0,0.2,10,3.0,0.3,10,50%',
    '"",,,,,Total,17.5,4.4,4.0,785.0,26.6,29.5,802.6,30.9,26.0,86.1%',
  ].join('\n');
}

var SAMPLE = fuelCsv('27/10/2026 00:00 - 27/10/2026 23:59');

var UTIL_CSV = [
  'Callouts,Asset ID,Asset Serial Number,Make,Model,Hour Meter (Hours),Hour Meter Last Reported Time,Latest Utilization Report,Timezone Offset,Time Zone,Timezone Display Name,Runtime (Hours),Idle Time (Hours),Working Time (Hours),Idle %,Total Fuel Burned (L)',
  ',EQ000001,AAA00001,CAT,538LL,8000.1000,2026-10-27T10:43:58Z,2026-10-27T10:43:58Z,+13:00,Pacific/Auckland,NZDT,9.5,1.2,8.3,12.6000,200.5000',
].join('\n');

var ASSETS = [
  { id: 201, asset_name: 'Cat 558GF (EQ000001)', visionlink_serial: 'AAA00001', current_hours: 1 },
  { id: 202, asset_name: 'Cat 538LL (EQ000002)', visionlink_serial: 'AAA00002', current_hours: 1 },
  { id: 203, asset_name: 'Cat 326FL (EQ000003)', visionlink_serial: 'AAA00003', current_hours: 1 },
  { id: 205, asset_name: 'Cat 320 (EQ000005)', visionlink_serial: 'AAA00005', current_hours: 1 },
  { id: 206, asset_name: 'Cat 320 partial (EQ000006)', visionlink_serial: 'AAA00006', current_hours: 1 },
  { id: 207, asset_name: 'Serial only dozer', visionlink_serial: 'AAA00007', current_hours: 1 },
];

var FUEL_KEYS = [
  'asset_id',
  'idle_fuel_litres',
  'record_date',
  'user_id',
  'working_fuel_litres',
];

var ONE_DAY_3 =
  "VisionLink report covers 3 days (2026-10-27 to 2026-10-29). FleetMagnify needs a one-day report: schedule it Daily with Report Duration 'Previous day'.";

function createMock() {
  var upserted = [];
  var assetUpdates = [];
  var importUpdates = [];
  function mockFrom(table) {
    return {
      select: function() {
        return {
          eq: function() {
            return Promise.resolve({
              data: table === 'assets' ? ASSETS : [],
              error: null,
            });
          },
        };
      },
      upsert: function(rows, opts) {
        upserted.push({ table: table, rows: rows, opts: opts });
        return Promise.resolve({ error: null });
      },
      update: function(payload) {
        var filters = [];
        var chain = {
          eq: function(col, val) {
            filters.push({ col: col, val: val });
            return chain;
          },
          then: function(resolve) {
            var entry = { table: table, payload: payload, filters: filters.slice() };
            if (table === 'assets') assetUpdates.push(entry);
            if (table === 'email_imports') importUpdates.push(entry);
            resolve({ error: null });
          },
        };
        return chain;
      },
    };
  }
  return {
    supabase: { from: mockFrom },
    upserted: upserted,
    assetUpdates: assetUpdates,
    importUpdates: importUpdates,
  };
}

function runFuel(csv, filename, receivedAt) {
  var warnings = [];
  var origWarn = console.warn;
  console.warn = function() {
    warnings.push(Array.prototype.slice.call(arguments).join(' '));
    origWarn.apply(console, arguments);
  };
  var mock = createMock();
  return fuel.parseVisionLinkFuelReport(mock.supabase, {
    userId: USER,
    importId: 'imp-vl-fuel',
    rawCsv: csv,
    filename: filename,
    receivedAt: receivedAt,
  }).then(function(result) {
    console.warn = origWarn;
    return { result: result, warnings: warnings, mock: mock, error: null };
  }, function(err) {
    console.warn = origWarn;
    return { result: null, warnings: warnings, mock: mock, error: err };
  });
}

function rowsByAsset(mock) {
  var tel = mock.upserted.filter(function(u) { return u.table === 'telematics_records'; })[0];
  var byId = {};
  (tel ? tel.rows : []).forEach(function(r) { byId[r.asset_id] = r; });
  return { tel: tel, byId: byId };
}

function assertFuelPayload(row) {
  assert.deepStrictEqual(Object.keys(row).sort(), FUEL_KEYS);
  assert.strictEqual(row.user_id, USER);
}

function testDetection() {
  console.log('\n=== Detection ===');
  assert.strictEqual(fuel.isVisionLinkFuelCsv(SAMPLE), true);
  assert.strictEqual(fuel.isVisionLinkFuelCsv(UTIL_CSV), false);
  assert.strictEqual(visionlink.isVisionLinkCsv(UTIL_CSV), true);
  assert.strictEqual(visionlink.isVisionLinkCsv(SAMPLE), false);
  assert.strictEqual(fuel.isVisionLinkFuelCsv('Vehicle,ActivityDate\nX,1'), false);
  console.log('✓ fuel sample detected; Utilization sample stays on the Utilization parser');
}

function testDateParsing() {
  console.log('\n=== Fleet Fuel date range ===');
  assert.deepStrictEqual(
    fuel.parseFleetFuelDateRange('27/10/2026 00:00 - 27/10/2026 23:59'),
    { start: '2026-10-27', end: '2026-10-27' }
  );
  assert.deepStrictEqual(
    fuel.parseFleetFuelDateRange('10/27/2026 00:00 - 10/27/2026 23:59'),
    { start: '2026-10-27', end: '2026-10-27' }
  );
  assert.deepStrictEqual(
    fuel.parseFleetFuelDateRange(
      '02/03/2026 00:00 - 02/03/2026 23:59',
      '2026-02-03T20:00:00Z'
    ),
    { start: '2026-02-03', end: '2026-02-03' }
  );
  assert.deepStrictEqual(
    fuel.parseFleetFuelDateRange(
      '02/03/2026 00:00 - 02/03/2026 23:59',
      '2026-03-02T20:00:00Z'
    ),
    { start: '2026-03-02', end: '2026-03-02' }
  );
  assert.strictEqual(
    fuel.parseFleetFuelDateRange('02/03/2026 00:00 - 02/03/2026 23:59', '2026-06-15T02:00:00Z'),
    null
  );
  assert.deepStrictEqual(
    fuel.parseFleetFuelDateRange(SAMPLE),
    { start: '2026-10-27', end: '2026-10-27' }
  );
  assert.deepStrictEqual(
    fuel.parseFleetFuelDateRange(fuelCsv('27/10/2026 00:00 - 29/10/2026 23:59')),
    { start: '2026-10-27', end: '2026-10-29' }
  );
  console.log('✓ DD/MM, MM/DD, ambiguous receivedAt, and multi-day range');
}

function testEndToEnd() {
  console.log('\n=== End-to-end Fleet Fuel upsert ===');
  return runFuel(
    SAMPLE,
    'Fleet_Utilization_27-10-2026_27-10-2026_28-10-2026.csv',
    '2026-10-28T18:00:00Z'
  ).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.ok, true);
    assert.strictEqual(out.result.recordDate, '2026-10-27');
    assert.strictEqual(out.result.skippedTotal, 1);
    assert.strictEqual(out.result.skippedNoSplit, 1);
    assert.strictEqual(out.result.unmatched, 1);
    assert.strictEqual(out.result.recordsUpserted, 6);
    assert.strictEqual(out.mock.assetUpdates.length, 0, 'fuel parser must not touch assets');

    var parsed = rowsByAsset(out.mock);
    assert.ok(parsed.tel);
    assert.strictEqual(parsed.tel.opts.onConflict, 'asset_id,record_date');
    parsed.tel.rows.forEach(assertFuelPayload);

    assert.strictEqual(parsed.byId[201].idle_fuel_litres, 5.2);
    assert.strictEqual(parsed.byId[201].working_fuel_litres, 357.2);
    assert.strictEqual(parsed.byId[202].idle_fuel_litres, 3.3);
    assert.strictEqual(parsed.byId[202].working_fuel_litres, 217.7);
    assert.strictEqual(parsed.byId[203].idle_fuel_litres, 9);
    assert.strictEqual(parsed.byId[203].working_fuel_litres, 210.1);
    assert.strictEqual(parsed.byId[205].idle_fuel_litres, 1234.5);
    assert.strictEqual(parsed.byId[205].working_fuel_litres, 2345.6);
    assert.strictEqual(parsed.byId[206].idle_fuel_litres, 8.5);
    assert.strictEqual(parsed.byId[206].working_fuel_litres, null);
    assert.strictEqual(parsed.byId[207].idle_fuel_litres, 4);
    assert.strictEqual(parsed.byId[207].working_fuel_litres, 40);
    assert.strictEqual(parsed.byId[204], undefined, 'dash row EQ000004 must not be written');

    var eq4 = out.warnings.filter(function(w) { return w.indexOf('EQ000004') !== -1; });
    assert.strictEqual(eq4.length, 0, 'dash row is not an unmatched error');
    var unmatched = out.warnings.filter(function(w) { return w.indexOf('unmatched asset') !== -1; });
    assert.strictEqual(unmatched.length, 1);
    assert.ok(unmatched[0].indexOf('EQ000099') !== -1);

    var processed = out.mock.importUpdates.filter(function(u) {
      return u.table === 'email_imports' && u.payload.status === 'processed';
    });
    assert.strictEqual(processed.length, 1);
    console.log('✓ total skipped, dash skipped, thousands parsed, payload is five columns');

    return runFuel(fuelCsv('10/27/2026 00:00 - 10/27/2026 23:59'));
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordDate, '2026-10-27');
    console.log('✓ MM/DD report date is 2026-10-27');

    return runFuel(
      fuelCsv('02/03/2026 00:00 - 02/03/2026 23:59'),
      null,
      '2026-02-03T20:00:00Z'
    );
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordDate, '2026-02-03');
    rowsByAsset(out.mock).tel.rows.forEach(function(r) {
      assert.strictEqual(r.record_date, '2026-02-03');
    });
    console.log('✓ ambiguous 02/03 resolved to 2026-02-03 from receivedAt');

    return runFuel(
      fuelCsv('02/03/2026 00:00 - 02/03/2026 23:59'),
      null,
      '2026-03-02T20:00:00Z'
    );
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordDate, '2026-03-02');
    console.log('✓ ambiguous 02/03 resolved to 2026-03-02 from receivedAt');

    return runFuel(fuelCsv('27/10/2026 00:00 - 29/10/2026 23:59'));
  }).then(function(out) {
    assert.ok(out.error);
    assert.strictEqual(out.error.message, ONE_DAY_3);
    assert.strictEqual(out.mock.upserted.length, 0);
    assert.strictEqual(out.mock.assetUpdates.length, 0);
    assert.strictEqual(out.mock.importUpdates.length, 1);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'failed');
    assert.strictEqual(out.mock.importUpdates[0].payload.error_message, ONE_DAY_3);
    console.log('✓ multi-day body rejected with no writes');

    return runFuel(
      SAMPLE,
      'Fleet_Utilization_26-10-2026_26-10-2026_27-10-2026.csv'
    );
  }).then(function(out) {
    assert.ok(out.error);
    assert.strictEqual(out.mock.upserted.length, 0);
    assert.ok(out.error.message.indexOf('2026-10-26 to 2026-10-26') !== -1);
    assert.ok(out.error.message.indexOf('2026-10-27 to 2026-10-27') !== -1);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'failed');
    console.log('✓ filename range that disagrees with the report fails the import');

    return runFuel(SAMPLE, 'Fleet_Utilization_27-10-2026_29-10-2026_30-10-2026.csv');
  }).then(function(out) {
    assert.ok(out.error);
    assert.strictEqual(out.error.message, ONE_DAY_3);
    assert.strictEqual(out.mock.upserted.length, 0);
    console.log('✓ multi-day filename rejected even when the report body is one day');

    return runFuel(
      fuelCsv('02/03/2026 00:00 - 02/03/2026 23:59'),
      null,
      '2026-06-15T02:00:00Z'
    );
  }).then(function(out) {
    assert.ok(out.error);
    assert.strictEqual(out.error.message, fuel.FUEL_DATE_UNRESOLVED);
    assert.strictEqual(out.mock.upserted.length, 0);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'failed');
    console.log('✓ ambiguous date outside 7 days fails the import');
  });
}

function testDashOnlyIsNotAnError() {
  console.log('\n=== Dash-only file is not an error ===');
  var csv = [
    'Fleet Fuel Report',
    'Report Date Range',
    '27/10/2026 00:00 - 27/10/2026 23:59',
    HEADER,
    'EQ000004,AAA00004,2020,CAT,C7.1,Cat Compact,-,-,-,-,-,-,-,-,-,-',
  ].join('\n');
  return runFuel(csv).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordsUpserted, 0);
    assert.strictEqual(out.result.skippedNoSplit, 1);
    assert.strictEqual(out.mock.upserted.length, 0);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'processed');
    console.log('✓ all-dash file writes nothing and stays processed');
  });
}

testDetection();
testDateParsing();
testEndToEnd().then(function() {
  return testDashOnlyIsNotAnError();
}).then(function() {
  console.log('\n════════════════════════════════════════');
  console.log('All VisionLink Fleet Fuel parser tests passed.');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
