/**
 * Smoke-test Navman mileage/idle parsers against real Aug 2026 sample CSVs.
 * Run: node scripts/test-navman-parsers.js
 */
var assert = require('assert');
var { parseNavmanDate, parseNavmanDatetime, parseNumeric } = require('../parsers/parser-utils');
var {
  isNavmanMileageCsv,
  parseNavmanMileageRows,
} = require('../parsers/navman-mileage');
var {
  isNavmanIdleCsv,
  parseNavmanIdleRows,
} = require('../parsers/navman-idle');

var MILEAGE_CSV = [
  'Vehicle,Registration,VehicleGroup,ActivityDate,ActualDistance,Units',
  'LV1 Hire Bucket,LJU519,Independent Line Services,8-25-2026,42.0,km',
  'LV2 Crane Truck,MHA395,Independent Line Services,8-25-2026,0.1,km',
  'T10 Service Truck,GYY449,Independent Line Services,8-25-2026,39.6,km',
  'T12 Tipper,DWG975,Default,8-25-2026,58.2,km',
  'T21 Lrg Crane Truck,RLN601,Independent Line Services,8-25-2026,148.7,km',
  'T34 Civils Truck,PDN185,Independent Line Services,8-25-2026,36.6,km',
].join('\n');

var IDLE_CSV = [
  'Vehicle,Registration,VehicleGroup,IdleStart,IdleEnd,Duration,Unit,Location',
  'LV1 Hire Bucket,LJU519,Independent Line Services,8-25-2026 5:07 AM,8-25-2026 5:21 AM,14,min,"[ILS Depot], 700 Russley Rd, Harewood, Christchurch 8051, New Zealand"',
  'LV2 Crane Truck,MHA395,Independent Line Services,8-25-2026 8:57 AM,8-25-2026 9:06 AM,10,min,"[ILS Depot], 700 Russley Rd, Harewood, Christchurch 8051, New Zealand"',
  'T21 Lrg Crane Truck,RLN601,Independent Line Services,8-25-2026 4:22 AM,8-25-2026 5:33 AM,72,min,"[ILS Depot], Russley Rd, Harewood, Christchurch 8051, New Zealand"',
  'T34 Civils Truck,PDN185,Independent Line Services,8-25-2026 5:37 AM,8-25-2026 5:52 AM,15,min,"[ILS Depot], 700 Russley Rd, Harewood, Christchurch 8051, New Zealand"',
].join('\n');

function testDateParsing() {
  assert.strictEqual(parseNavmanDate('8-25-2026'), '2026-08-25', 'MM-DD-YYYY hyphen');
  assert.strictEqual(parseNavmanDate('08-25-2026'), '2026-08-25', 'zero-padded MM-DD');
  assert.strictEqual(parseNavmanDate('8/25/2026'), '2026-08-25', 'MM/DD/YYYY slash');
  // Legacy unambiguous DD-MM still accepted
  assert.strictEqual(parseNavmanDate('25-08-2026'), '2026-08-25', 'legacy DD-MM-YYYY');
  // Must NOT shift +1 day
  assert.notStrictEqual(parseNavmanDate('8-25-2026'), '2026-08-26', 'no UTC day-shift');
  assert.notStrictEqual(parseNavmanDate('8-25-2026'), '2026-08-24', 'no UTC day-shift back');

  var dt = parseNavmanDatetime('8-25-2026 5:07 AM');
  assert.ok(dt, 'datetime parses');
  assert.strictEqual(dt.dateIso, '2026-08-25');
  var end = parseNavmanDatetime('8-25-2026 5:21 AM');
  assert.strictEqual(Math.round((end.ms - dt.ms) / 60000), 14, '5:07→5:21 = 14 min');

  var crane = parseNavmanDatetime('8-25-2026 4:22 AM');
  var craneEnd = parseNavmanDatetime('8-25-2026 5:33 AM');
  assert.strictEqual(Math.round((craneEnd.ms - crane.ms) / 60000), 71, '4:22→5:33 ≈ 71 min (CSV says 72)');

  console.log('✓ date parsing');
}

function testMileageDetectionAndRows() {
  assert.strictEqual(isNavmanMileageCsv(MILEAGE_CSV), true, 'detect mileage');
  assert.strictEqual(isNavmanIdleCsv(MILEAGE_CSV), false, 'mileage is not idle');

  var rows = parseNavmanMileageRows(MILEAGE_CSV);
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(rows[0].Vehicle, 'LV1 Hire Bucket');
  assert.strictEqual(rows[0].Registration, 'LJU519');
  assert.strictEqual(rows[0].VehicleGroup, 'Independent Line Services');
  assert.strictEqual(rows[0].ActivityDate, '8-25-2026');
  assert.strictEqual(parseNavmanDate(rows[0].ActivityDate), '2026-08-25');
  assert.strictEqual(parseNumeric(rows[0].ActualDistance), 42);

  // Default VehicleGroup row still parses; matching uses Vehicle name only
  var tipper = rows.filter(function(r) { return r.Vehicle === 'T12 Tipper'; })[0];
  assert.ok(tipper);
  assert.strictEqual(tipper.VehicleGroup, 'Default');
  assert.strictEqual(parseNavmanDate(tipper.ActivityDate), '2026-08-25');
  assert.strictEqual(parseNumeric(tipper.ActualDistance), 58.2);

  // Simulate build of records (all assets known)
  var records = rows.map(function(r, idx) {
    return {
      asset_id: idx + 1,
      record_date: parseNavmanDate(r.ActivityDate),
      daily_distance_km: parseNumeric(r.ActualDistance),
    };
  }).filter(function(r) { return r.daily_distance_km > 0; });
  assert.strictEqual(records.length, 6);
  records.forEach(function(r) {
    assert.strictEqual(r.record_date, '2026-08-25');
  });
  assert.strictEqual(records[4].daily_distance_km, 148.7);

  console.log('✓ mileage detection + rows → date 2026-08-25, distances intact');
}

function testIdleDetectionAndRows() {
  assert.strictEqual(isNavmanIdleCsv(IDLE_CSV), true, 'detect idle');
  assert.strictEqual(isNavmanMileageCsv(IDLE_CSV), false, 'idle is not mileage');

  var rows = parseNavmanIdleRows(IDLE_CSV);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].Vehicle, 'LV1 Hire Bucket');
  assert.strictEqual(rows[0].IdleStart, '8-25-2026 5:07 AM');
  assert.strictEqual(parseNavmanDate(rows[0].IdleStart), '2026-08-25');
  assert.strictEqual(parseNumeric(rows[0].Duration), 14);
  assert.ok(rows[0].Location.indexOf('ILS Depot') !== -1);

  // Aggregate like the parser does
  var daily = {};
  rows.forEach(function(r) {
    var dateStr = parseNavmanDate(r.IdleStart);
    var dur = parseNumeric(r.Duration);
    var key = r.Vehicle + '|' + dateStr;
    daily[key] = (daily[key] || 0) + dur;
  });
  assert.strictEqual(daily['LV1 Hire Bucket|2026-08-25'], 14);
  assert.strictEqual(daily['T21 Lrg Crane Truck|2026-08-25'], 72);
  assert.strictEqual(Object.keys(daily).every(function(k) {
    return k.indexOf('2026-08-25') !== -1;
  }), true);

  console.log('✓ idle detection + rows → date 2026-08-25, durations intact');
}

function testEndToEndWithMockSupabase() {
  return Promise.resolve().then(async function() {
    var mileage = require('../parsers/navman-mileage');
    var idle = require('../parsers/navman-idle');

    var assets = [
      { id: 1, asset_name: 'LV1 Hire Bucket', current_odometer: null },
      { id: 2, asset_name: 'LV2 Crane Truck', current_odometer: null },
      { id: 3, asset_name: 'T10 Service Truck', current_odometer: null },
      { id: 4, asset_name: 'T12 Tipper', current_odometer: null },
      { id: 5, asset_name: 'T21 Lrg Crane Truck', current_odometer: null },
      { id: 6, asset_name: 'T34 Civils Truck', current_odometer: null },
    ];
    var upserted = [];

    function mockFrom(table) {
      return {
        select: function() {
          return {
            eq: function() {
              return Promise.resolve({
                data: table === 'assets' ? assets : [],
                error: null,
              });
            },
          };
        },
        upsert: function(rows) {
          upserted.push({ table: table, rows: rows });
          return Promise.resolve({ error: null });
        },
        update: function() {
          return {
            eq: function() { return Promise.resolve({ error: null }); },
          };
        },
      };
    }

    var supabase = { from: mockFrom };

    upserted = [];
    var mResult = await mileage.parseNavmanMileageReport(supabase, {
      userId: 'user-1',
      importId: 'imp-m',
      rawCsv: MILEAGE_CSV,
    });
    assert.strictEqual(mResult.ok, true);
    assert.strictEqual(mResult.recordsUpserted, 6);
    var mRows = upserted.filter(function(u) { return u.table === 'telematics_records'; })[0].rows;
    assert.strictEqual(mRows.length, 6);
    mRows.forEach(function(r) {
      assert.strictEqual(r.record_date, '2026-08-25');
      assert.ok(r.daily_distance_km > 0);
    });
    var tipper = mRows.filter(function(r) { return r.asset_id === 4; })[0];
    assert.strictEqual(tipper.daily_distance_km, 58.2);

    upserted = [];
    var iResult = await idle.parseNavmanIdleReport(supabase, {
      userId: 'user-1',
      importId: 'imp-i',
      rawCsv: IDLE_CSV,
    });
    assert.strictEqual(iResult.ok, true);
    assert.strictEqual(iResult.recordsUpserted, 4);
    var iRows = upserted.filter(function(u) { return u.table === 'telematics_records'; })[0].rows;
    assert.strictEqual(iRows.length, 4);
    iRows.forEach(function(r) {
      assert.strictEqual(r.record_date, '2026-08-25');
      assert.ok(r.idle_hours > 0);
    });
    var lv1 = iRows.filter(function(r) { return r.asset_id === 1; })[0];
    assert.strictEqual(lv1.idle_hours, 14 / 60);

    console.log('✓ end-to-end mock upsert: mileage + idle on 2026-08-25');
  });
}

testDateParsing();
testMileageDetectionAndRows();
testIdleDetectionAndRows();
testEndToEndWithMockSupabase().then(function() {
  console.log('\nAll Navman parser tests passed.');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
