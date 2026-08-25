/**
 * Local tests for parsers/visionlink.js — not wired to email import.
 * Run: node scripts/test-visionlink-parser.js
 */
var assert = require('assert');
var visionlink = require('../parsers/visionlink');
var { parseNumeric } = require('../parsers/parser-utils');

var HEADER = [
  'Callouts',
  'Asset ID',
  'Asset Serial Number',
  'Make',
  'Model',
  'Hour Meter (Hours)',
  'Hour Meter Last Reported Time',
  'Latest Utilization Report',
  'Timezone Offset',
  'Time Zone',
  'Timezone Display Name',
  'Runtime (Hours)',
  'Idle Time (Hours)',
  'Working Time (Hours)',
  'Idle %',
  'Total Fuel Burned (L)',
  'Total Fuel Burn Rate (L/Hour)',
].join(',');

// Realistic Monro-style sample (synthetic values, real column layout)
var SAMPLE_CSV = [
  HEADER,
  // Matched by Asset ID in asset_name brackets
  '"",EQ030992,CAT320FL001,CAT,320FL,8483,2026-08-18 06:00:00+12:00,2026-08-18 00:00:00+12:00,+12:00,Pacific/Auckland,NZT,6.2,1.5,4.7,24.2,48.3,7.8',
  // Empty activity — MUST be skipped (no zero-fill)
  '"",EQ030991,CAT324DL001,CAT,324DL,9120,2026-08-18 06:00:00+12:00,2026-08-18 00:00:00+12:00,+12:00,Pacific/Auckland,NZT,,,,,',
  // NULL Asset ID → fall back to Serial Number (Cat 324DL case)
  '"Insufficient runtime meter precision for valid calculation",,GPK00327,CAT,324DL,7765,8/18/2026 6:00:00 AM,8/18/2026 12:00:00 AM,+12:00,Pacific/Auckland,NZT,3.1,0.8,2.3,25.8,22.0,7.1',
  // Unmatched — should warn, not invent an asset
  '"",EQ999999,UNKNOWN999,CAT,999,100,2026-08-18 00:00:00+12:00,2026-08-18 00:00:00+12:00,+12:00,Pacific/Auckland,NZT,1.0,0.2,0.8,20,5.0,5.0',
  // US-style date with activity
  '"",EQ041100,HITACHI001,HITACHI,ZX350,5520,8/18/2026 5:30:00 AM,8/18/2026 12:00:00 AM,+12:00,Pacific/Auckland,NZT,8.0,2.0,6.0,25,60.5,7.56',
].join('\n');

var MONRO_USER = '59dd8c6a-1146-4245-978b-6550095ea6c8';

var ASSETS = [
  { id: 101, asset_name: 'Cat 320FL (EQ030992)', visionlink_serial: 'CAT320FL001', current_hours: 8400 },
  { id: 102, asset_name: 'Cat 324DL', visionlink_serial: 'GPK00327', current_hours: 7700 },
  { id: 103, asset_name: 'Hitachi ZX350 (EQ041100)', visionlink_serial: 'HITACHI001', current_hours: 5500 },
  // EQ030991 exists but its sample row is empty-activity → skipped
  { id: 104, asset_name: 'Cat 324DL Spare (EQ030991)', visionlink_serial: 'CAT324DL001', current_hours: 9100 },
];

function testDateParsing() {
  console.log('\n=== Date parsing (NO day-shift) ===');
  var cases = [
    ['2026-08-18 00:00:00+12:00', '2026-08-18'],
    ['2026-08-18T06:00:00+12:00', '2026-08-18'],
    ['8/18/2026 12:00:00 AM', '2026-08-18'],
    ['8/18/2026 6:00:00 AM', '2026-08-18'],
    ['18/08/2026', '2026-08-18'], // unambiguous day-first
  ];
  cases.forEach(function(c) {
    var got = visionlink.parseVisionLinkDate(c[0]);
    console.log('  parseVisionLinkDate(' + JSON.stringify(c[0]) + ') →', got,
      got === c[1] ? '✓' : '✗ expected ' + c[1]);
    assert.strictEqual(got, c[1]);
    assert.notStrictEqual(got, '2026-08-17');
    assert.notStrictEqual(got, '2026-08-19');
  });
  console.log('✓ timezone/date: NZ local calendar date, no ±1 day shift');
}

function testDetectionAndRows() {
  console.log('\n=== Detection + row parse ===');
  assert.strictEqual(visionlink.isVisionLinkCsv(SAMPLE_CSV), true);
  assert.strictEqual(visionlink.isVisionLinkCsv('Vehicle,ActivityDate,ActualDistance\nX,1,1'), false);

  var rows = visionlink.parseVisionLinkRows(SAMPLE_CSV);
  assert.strictEqual(rows.length, 5);
  console.log('  rows parsed:', rows.length);
  rows.forEach(function(r, i) {
    console.log(
      '  #' + (i + 1),
      'Asset ID=' + JSON.stringify(r['Asset ID']),
      'Serial=' + r['Asset Serial Number'],
      'Runtime=' + JSON.stringify(r['Runtime (Hours)']),
      'Idle=' + JSON.stringify(r['Idle Time (Hours)']),
      'Fuel=' + JSON.stringify(r['Total Fuel Burned (L)']),
      'emptyActivity=' + visionlink.isEmptyActivityRow(r)
    );
  });
  assert.strictEqual(visionlink.isEmptyActivityRow(rows[1]), true);
  assert.strictEqual(visionlink.isEmptyActivityRow(rows[0]), false);
  console.log('✓ empty-activity row (#2 EQ030991) flagged for skip');
}

function testMatching() {
  console.log('\n=== Asset matching ===');
  var maps = { byAssetId: {}, bySerial: {}, byName: {} };
  ASSETS.forEach(function(a) {
    maps.byName[a.asset_name] = a;
    var bid = visionlink.extractBracketAssetId(a.asset_name);
    if (bid) maps.byAssetId[bid] = a;
    if (a.visionlink_serial) maps.bySerial[a.visionlink_serial] = a;
  });

  assert.strictEqual(visionlink.extractBracketAssetId('Cat 320FL (EQ030992)'), 'EQ030992');

  var rows = visionlink.parseVisionLinkRows(SAMPLE_CSV);
  var m0 = visionlink.matchAsset(rows[0], maps);
  console.log('  EQ030992 →', m0 && m0.asset.asset_name, 'via', m0 && m0.method);
  assert.ok(m0);
  assert.strictEqual(m0.method, 'asset_id');
  assert.strictEqual(m0.asset.id, 101);

  var m2 = visionlink.matchAsset(rows[2], maps); // NULL Asset ID, serial GPK00327
  console.log('  (null Asset ID) serial GPK00327 →', m2 && m2.asset.asset_name, 'via', m2 && m2.method);
  assert.ok(m2);
  assert.strictEqual(m2.method, 'serial');
  assert.strictEqual(m2.asset.id, 102);

  var m3 = visionlink.matchAsset(rows[3], maps);
  console.log('  EQ999999 unmatched →', m3);
  assert.strictEqual(m3, null);

  console.log('✓ Asset ID bracket match + Serial Number fallback');
}

function testEndToEndMock() {
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
                assetUpdates.push({
                  table: table,
                  payload: payload,
                  filters: filters.slice(),
                });
              }
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    }

    var supabase = { from: mockFrom };
    var result = await visionlink.parseVisionLinkReport(supabase, {
      userId: MONRO_USER,
      importId: 'imp-vl-1',
      rawCsv: SAMPLE_CSV,
    });
    console.warn = origWarn;

    console.log('  result:', JSON.stringify({
      ok: result.ok,
      recordsUpserted: result.recordsUpserted,
      skippedEmpty: result.skippedEmpty,
      unmatched: result.unmatched,
      hoursUpdated: result.hoursUpdated,
      calloutsLogged: result.calloutsLogged,
    }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skippedEmpty, 1, 'one empty-activity row skipped');
    assert.strictEqual(result.unmatched, 1, 'EQ999999 unmatched');
    assert.strictEqual(result.recordsUpserted, 3, '320FL + serial-fallback 324DL + Hitachi');

    var tel = upserted.filter(function(u) { return u.table === 'telematics_records'; })[0];
    assert.ok(tel);
    console.log('\n  telematics_records upserts:');
    tel.rows.forEach(function(r) {
      console.log(
        '   ',
        'asset_id=' + r.asset_id,
        'date=' + r.record_date,
        'operating_hours=' + r.operating_hours,
        'idle_hours=' + r.idle_hours,
        'total_engine_hours=' + r.total_engine_hours,
        'litres_consumed=' + r.litres_consumed,
        'data_quality_notes=' + JSON.stringify(r.data_quality_notes)
      );
      assert.strictEqual(r.record_date, '2026-08-18');
      assert.strictEqual(r.user_id, MONRO_USER);
    });

    // No zero-filled row for empty EQ030991
    assert.strictEqual(
      tel.rows.filter(function(r) { return r.asset_id === 104; }).length,
      0,
      'empty-activity asset must not be inserted'
    );

    var byId = {};
    tel.rows.forEach(function(r) { byId[r.asset_id] = r; });

    // EQ030992
    assert.strictEqual(byId[101].operating_hours, 4.7);
    assert.strictEqual(byId[101].idle_hours, 1.5);
    assert.strictEqual(byId[101].total_engine_hours, 8483);
    assert.strictEqual(byId[101].litres_consumed, 48.3);
    assert.strictEqual(byId[101].data_quality_notes, null);

    // Serial fallback GPK00327 → asset 102 — Callouts persisted
    assert.strictEqual(byId[102].operating_hours, 2.3);
    assert.strictEqual(byId[102].idle_hours, 0.8);
    assert.strictEqual(byId[102].total_engine_hours, 7765);
    assert.strictEqual(byId[102].litres_consumed, 22.0);
    assert.strictEqual(
      byId[102].data_quality_notes,
      'Insufficient runtime meter precision for valid calculation'
    );

    // Hitachi
    assert.strictEqual(byId[103].operating_hours, 6.0);
    assert.strictEqual(byId[103].litres_consumed, 60.5);
    assert.strictEqual(byId[103].data_quality_notes, null);

    console.log('\n  assets.current_hours overwrites:');
    assetUpdates.forEach(function(u) {
      console.log('   ', u.filters, '→', u.payload);
    });
    assert.ok(assetUpdates.length >= 3);
    var hoursByAsset = {};
    assetUpdates.forEach(function(u) {
      var idFilter = u.filters.filter(function(f) { return f.col === 'id'; })[0];
      hoursByAsset[idFilter.val] = u.payload.current_hours;
    });
    // Overwrite (not increment): 8483 not 8400+delta
    assert.strictEqual(hoursByAsset[101], 8483);
    assert.strictEqual(hoursByAsset[102], 7765);
    assert.strictEqual(hoursByAsset[103], 5520);
    console.log('✓ current_hours overwritten (8483 / 7765 / 5520), not incremented');

    var unmatchedWarn = warnings.filter(function(w) {
      return w.indexOf('unmatched asset') !== -1;
    });
    assert.ok(unmatchedWarn.length >= 1);
    console.log('✓ unmatched asset logged via console.warn');
    console.log('✓ Callouts persisted on data_quality_notes (asset 102)');

    console.log('\n✓ end-to-end VisionLink parse OK');
  });
}

testDateParsing();
testDetectionAndRows();
testMatching();
testEndToEndMock().then(function() {
  console.log('\n════════════════════════════════════════');
  console.log('All VisionLink parser tests passed.');
  console.log('Wired into email-inbound + bulk-import (isVisionLinkCsv).');
  console.log('Callouts → telematics_records.data_quality_notes');
  console.log('Fuel → telematics_records.litres_consumed');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
