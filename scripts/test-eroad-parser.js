/**
 * Local tests for parsers/eroad.js — not wired to email import.
 * Run: node scripts/test-eroad-parser.js
 */
var assert = require('assert');
var eroad = require('../parsers/eroad');

var MONRO_USER = '59dd8c6a-1146-4245-978b-6550095ea6c8';

var SAMPLE_CSV = [
  'EROAD Fleet Summary Report,25/08/2026 - 25/08/2026',
  'id,Type,Name,Rego/Plate,Asset Code,Distance (km),RUC Purchased ($),Running Time %,Running Time (hours),Stop Time (hours),Total Idle Time Minutes,Low Idle Events,Medium Idle Events,High Idle Events,Site Visits,Average Speed (km/h),Ehubo/Odo (km)',
  '1,Truck,Globy (262),ABC123,262,142.5,85.00,45,6.2,2.1,355,1,0,0,3,62.0,248901.2',
  '2,Truck,Volvo F12 (263),DEF456,263,0,0,0,0,0,0,0,0,0,0,0,312450.0',
  '3,Truck,Volvo FH520 Log(273),GHI789,,88.0,40.00,30,4.0,1.0,120,0,1,0,1,55.0,198776.5',
  '4,Truck,Unknown Rig (999),ZZZ999,999,10,5,10,1,0,60,0,0,0,0,40,1000',
  'Totals,,Totals,,,240.5,130.00,,,,,535,,,,,,',
].join('\n');

var ASSETS = [
  { id: 201, asset_name: 'Globy (262)', current_odometer: 248000 },
  { id: 202, asset_name: 'Volvo F12 (263)', current_odometer: 312000 },
  { id: 203, asset_name: 'Volvo FH520 Log(273)', current_odometer: 198000 },
];

function testDetection() {
  console.log('\n=== Detection (title + headers) ===');
  assert.strictEqual(eroad.isEroadCsv(SAMPLE_CSV), true);
  assert.strictEqual(eroad.isEroadCsv('Vehicle,ActivityDate,ActualDistance\nx,1,1'), false);
  assert.strictEqual(
    eroad.isEroadTitleRow(SAMPLE_CSV.split('\n')[0].split(',')),
    true
  );
  console.log('✓ isEroadCsv detects title + header layout');
}

function testSkipTitleAndTotals() {
  console.log('\n=== Title row + Totals row excluded ===');
  var parsed = eroad.parseEroadRows(SAMPLE_CSV);
  console.log('  titleLine:', parsed.titleLine);
  console.log('  vehicle rows:', parsed.rows.length);
  parsed.rows.forEach(function(r) {
    console.log('   ', r.Name, '| Asset Code=' + JSON.stringify(r['Asset Code']), '| Distance=' + r['Distance (km)'], '| IdleMin=' + r['Total Idle Time Minutes']);
  });
  assert.strictEqual(parsed.rows.length, 4, '4 vehicles (Totals excluded)');
  assert.strictEqual(
    parsed.rows.filter(function(r) { return /totals/i.test(r.Name); }).length,
    0
  );
  assert.ok(parsed.titleLine.toLowerCase().indexOf('eroad fleet summary') !== -1);
  console.log('✓ title + Totals excluded; 4 vehicle rows kept');
}

function testIdleMinutesConversion() {
  console.log('\n=== Idle MINUTES → hours (critical unit conversion) ===');
  var cases = [
    [355, 355 / 60],
    [120, 2],
    [0, 0],
    [60, 1],
  ];
  cases.forEach(function(c) {
    var got = eroad.idleMinutesToHours(c[0]);
    console.log('  ' + c[0] + ' min → ' + got + ' h (expect ' + c[1] + ')');
    assert.strictEqual(got, c[1]);
  });
  // Explicit eyeball for Globy
  assert.strictEqual(eroad.idleMinutesToHours(355), 5.916666666666667);
  console.log('✓ 355 minutes → 5.916666666666667 hours');
}

function testDateExtraction() {
  console.log('\n=== Report date from title ===');
  var d = eroad.extractEroadReportDate(
    'EROAD Fleet Summary Report,25/08/2026 - 25/08/2026',
    null,
    null
  );
  console.log('  extracted:', d);
  assert.strictEqual(d, '2026-08-25');
  console.log('✓ title date range → 2026-08-25');
}

function testEndToEnd() {
  console.log('\n=== End-to-end mock upsert ===');
  return Promise.resolve().then(async function() {
    var upserted = [];
    var assetUpdates = [];
    var warnings = [];
    var origWarn = console.warn;
    console.warn = function() {
      warnings.push(Array.prototype.slice.call(arguments).join(' '));
      origWarn.apply(console, arguments);
    };

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
              if (table === 'assets') {
                assetUpdates.push({ payload: payload, filters: filters.slice() });
              }
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    }

    var result = await eroad.parseEroadReport({ from: mockFrom }, {
      userId: MONRO_USER,
      importId: 'imp-eroad-1',
      rawCsv: SAMPLE_CSV,
      filename: 'eroad_2026-08-25.csv',
      receivedAt: '2026-08-26T04:00:00Z',
    });
    console.warn = origWarn;

    console.log('  result:', JSON.stringify({
      ok: result.ok,
      recordDate: result.recordDate,
      recordsUpserted: result.recordsUpserted,
      unmatched: result.unmatched,
      odometerUpdated: result.odometerUpdated,
      rucNotStored: result.rucNotStored,
    }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.recordDate, '2026-08-25');
    assert.strictEqual(result.recordsUpserted, 3, '3 matched; Unknown Rig unmatched');
    assert.strictEqual(result.unmatched, 1);
    assert.ok(result.rucNotStored >= 1, 'RUC present but not stored');

    var tel = upserted.filter(function(u) { return u.table === 'telematics_records'; })[0];
    assert.ok(tel);
    console.log('\n  telematics_records upserts:');
    tel.rows.forEach(function(r) {
      console.log(
        '   ',
        'asset_id=' + r.asset_id,
        'date=' + r.record_date,
        'daily_distance_km=' + r.daily_distance_km,
        'idle_hours=' + r.idle_hours
      );
      assert.strictEqual(r.record_date, '2026-08-25');
    });

    var byId = {};
    tel.rows.forEach(function(r) { byId[r.asset_id] = r; });

    // Globy — distance + idle minutes conversion
    assert.strictEqual(byId[201].daily_distance_km, 142.5);
    assert.strictEqual(byId[201].idle_hours, 355 / 60);

    // Volvo F12 — ZERO activity stored (not skipped)
    assert.strictEqual(byId[202].daily_distance_km, 0);
    assert.strictEqual(byId[202].idle_hours, 0);
    console.log('✓ zero-activity Volvo F12 (263) stored as 0 / 0 (not skipped)');

    // Volvo FH520 — null Asset Code still matched by Name
    assert.strictEqual(byId[203].daily_distance_km, 88.0);
    assert.strictEqual(byId[203].idle_hours, 2);
    console.log('✓ null Asset Code row matched by Name (Volvo FH520 Log(273))');

    // Totals not imported
    assert.strictEqual(tel.rows.length, 3);

    console.log('\n  assets.current_odometer overwrites:');
    assetUpdates.forEach(function(u) {
      console.log('   ', u.filters, '→', u.payload);
    });
    var odoByAsset = {};
    assetUpdates.forEach(function(u) {
      var idf = u.filters.filter(function(f) { return f.col === 'id'; })[0];
      odoByAsset[idf.val] = u.payload.current_odometer;
    });
    assert.strictEqual(odoByAsset[201], 248901.2);
    assert.strictEqual(odoByAsset[202], 312450.0);
    assert.strictEqual(odoByAsset[203], 198776.5);
    console.log('✓ current_odometer overwritten (not incremented)');

    var unmatchedWarn = warnings.filter(function(w) { return w.indexOf('unmatched vehicle') !== -1; });
    assert.ok(unmatchedWarn.length >= 1);
    console.log('✓ unmatched vehicle logged');

    var rucWarn = warnings.filter(function(w) { return w.indexOf('RUC Purchased') !== -1; });
    assert.ok(rucWarn.length >= 1);
    console.log('✓ RUC flagged as not stored');

    console.log('\n✓ end-to-end eROAD parse OK');
  });
}

testDetection();
testSkipTitleAndTotals();
testIdleMinutesConversion();
testDateExtraction();
testEndToEnd().then(function() {
  console.log('\n════════════════════════════════════════');
  console.log('All eROAD parser tests passed.');
  console.log('NOT wired into email-inbound / bulk-import parse dispatch.');
  console.log('classifyUnknownCsv keywords updated for quarantine labelling.');
  console.log('RUC Purchased ($): NO storage column yet — needs schema decision.');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
