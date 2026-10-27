/**
 * Local tests for parsers/visionlink.js — not wired to email import.
 * Run: node scripts/test-visionlink-parser.js
 */
var assert = require('assert');
var visionlink = require('../parsers/visionlink');
var { parseNumeric, parseVisionLinkFilenameRange, utcTimestampToLocalDate } = require('../parsers/parser-utils');

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
  console.log('\n=== Date token parsing (non-instant strings) ===');
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
  // The helper reads the written calendar token. Z instants are converted
  // separately by utcTimestampToLocalDate (see testUtcToNzDate).
  console.log('✓ non-instant date tokens keep the written calendar date');
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
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'idle_fuel_litres'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'working_fuel_litres'), false);
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
    var fallbackWarn = warnings.filter(function(w) {
      return w.indexOf('fallback record_date') !== -1;
    });
    assert.strictEqual(fallbackWarn.length, 1, 'no filename uses the timestamp fallback');
    console.log('✓ unmatched asset logged via console.warn');
    console.log('✓ no filename logged the NZ-local fallback warning');
    console.log('✓ Callouts persisted on data_quality_notes (asset 102)');

    console.log('\n✓ end-to-end VisionLink parse OK');
  });
}

var NZ_HEADER = [
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
  'Power Generated (kWh)',
  'Average Daily Load (%)',
  'Power Per Unit of Fuel (kWh/L)',
  'Gross Revenue From Power (USD)',
].join(',');

// Anonymised one-day Utilization export. EQ000002's Z timestamp is the
// next calendar day in Pacific/Auckland; a one-day filename must still
// pin every row to the filename date.
var NZ_CSV = [
  NZ_HEADER,
  ',EQ000001,AAA00001,CAT,538LL,8000.1000,2026-10-27T10:43:58Z,2026-10-27T10:43:58Z,+13:00,Pacific/Auckland,NZDT,9.5,1.2,8.3,12.6000,200.5000,21.1000,,,,',
  ',EQ000002,AAA00002,CAT,558GF,9000.2000,2026-10-27T17:21:16Z,2026-10-27T17:21:16Z,+13:00,Pacific/Auckland,NZDT,10.2,1.0,9.2,9.8000,350.0000,34.3000,,,,',
  'Insufficient runtime meter precision for valid calculation,EQ000003,AAA00003,CAT,326FL,4800.3000,2026-10-27T10:37:34Z,2026-10-27T10:37:34Z,+13:00,Pacific/Auckland,NZDT,7.0,2.4,4.6,34.3000,120.0000,17.1000,,,,',
].join('\n');

var NZ_ASSETS = [
  { id: 1, asset_name: 'Cat 538LL (EQ000001)', visionlink_serial: 'AAA00001', current_hours: 100 },
  { id: 2, asset_name: 'Cat 558GF (EQ000002)', visionlink_serial: 'AAA00002', current_hours: 100 },
  { id: 3, asset_name: 'Cat 326FL (EQ000003)', visionlink_serial: 'AAA00003', current_hours: 100 },
];

var ONE_DAY_MESSAGE_7 =
  "VisionLink report covers 7 days (2026-08-17 to 2026-08-23). FleetMagnify needs a one-day report: schedule it Daily with Report Duration 'Previous day'.";

function createMock(assets) {
  var upserted = [];
  var assetUpdates = [];
  var importUpdates = [];
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

function testFilenameRange() {
  console.log('\n=== Filename date range ===');
  var dmy = parseVisionLinkFilenameRange(
    'Fleet_Utilization_27-10-2026_27-10-2026_28-10-2026.csv'
  );
  assert.deepStrictEqual(dmy, {
    start: '2026-10-27',
    end: '2026-10-27',
    generated: '2026-10-28',
  });

  var dmyCase = parseVisionLinkFilenameRange(
    'inbox/fleet_utilization_27-10-2026_27-10-2026_28-10-2026.CSV'
  );
  assert.deepStrictEqual(dmyCase, dmy);

  var mdy = parseVisionLinkFilenameRange(
    'Fleet_Utilization_10-27-2026_10-27-2026_10-28-2026.csv'
  );
  assert.deepStrictEqual(mdy, {
    start: '2026-10-27',
    end: '2026-10-27',
    generated: '2026-10-28',
  });

  var trailing = parseVisionLinkFilenameRange(
    'Fleet_Utilization_08-17-2026_08-17-2026_08-18-2026_1.xlsx'
  );
  assert.deepStrictEqual(trailing, {
    start: '2026-08-17',
    end: '2026-08-17',
    generated: '2026-08-18',
  });

  var multi = parseVisionLinkFilenameRange(
    'Fleet_Utilization_08-17-2026_08-23-2026_08-24-2026_1.xlsx'
  );
  assert.deepStrictEqual(multi, {
    start: '2026-08-17',
    end: '2026-08-23',
    generated: '2026-08-24',
  });

  // 02-03 is both 2 Mar (DD-MM) and 3 Feb (MM-DD). receivedAt's NZ date
  // picks the end date within 7 days.
  var ambiguousName = 'Fleet_Utilization_02-03-2026_02-03-2026_02-04-2026.csv';
  var asMdy = parseVisionLinkFilenameRange(ambiguousName, '2026-02-03T20:00:00Z');
  assert.deepStrictEqual(asMdy, {
    start: '2026-02-03',
    end: '2026-02-03',
    generated: '2026-02-04',
  });
  var asDmy = parseVisionLinkFilenameRange(ambiguousName, '2026-03-02T20:00:00Z');
  assert.deepStrictEqual(asDmy, {
    start: '2026-03-02',
    end: '2026-03-02',
    generated: '2026-04-02',
  });
  assert.strictEqual(
    parseVisionLinkFilenameRange(ambiguousName, '2026-06-15T02:00:00Z'),
    null
  );
  assert.strictEqual(parseVisionLinkFilenameRange(ambiguousName), null);

  assert.deepStrictEqual(
    parseVisionLinkFilenameRange('Fleet_Utilization_10-10-2026_10-10-2026_10-10-2026.csv'),
    { start: '2026-10-10', end: '2026-10-10', generated: '2026-10-10' }
  );
  assert.strictEqual(parseVisionLinkFilenameRange('manual-upload.csv'), null);
  assert.strictEqual(parseVisionLinkFilenameRange(null), null);
  console.log('✓ DD-MM, MM-DD, trailing _1, ambiguous receivedAt, and non-matches');
}

function testUtcToNzDate() {
  console.log('\n=== UTC instant → Pacific/Auckland date ===');
  assert.strictEqual(
    utcTimestampToLocalDate('2026-10-27T17:21:16Z', 'Pacific/Auckland'),
    '2026-10-28'
  );
  assert.strictEqual(
    utcTimestampToLocalDate('2026-10-27T10:43:58Z', 'Pacific/Auckland'),
    '2026-10-27'
  );
  assert.strictEqual(utcTimestampToLocalDate('2026-10-27T17:21:16Z', ''), '2026-10-28');
  assert.strictEqual(utcTimestampToLocalDate('2026-10-27T17:21:16Z', 'Not/AZone'), '2026-10-28');
  assert.strictEqual(utcTimestampToLocalDate('', 'Pacific/Auckland'), null);
  console.log('✓ 17:21Z → 28 Oct, 10:43Z → 27 Oct; blank/invalid zone defaults to Auckland');
}

function runNzReport(filename, receivedAt) {
  var warnings = [];
  var origWarn = console.warn;
  console.warn = function() {
    warnings.push(Array.prototype.slice.call(arguments).join(' '));
    origWarn.apply(console, arguments);
  };
  var mock = createMock(NZ_ASSETS);
  return visionlink.parseVisionLinkReport(mock.supabase, {
    userId: MONRO_USER,
    importId: 'imp-vl-nz',
    rawCsv: NZ_CSV,
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

function datesByAsset(mock) {
  var tel = mock.upserted.filter(function(u) { return u.table === 'telematics_records'; })[0];
  var byId = {};
  (tel ? tel.rows : []).forEach(function(r) { byId[r.asset_id] = r; });
  return { tel: tel, byId: byId };
}

function testOneDayGuardAndNzDates() {
  console.log('\n=== One-day filename guard + NZ fallback dates ===');
  return runNzReport('Fleet_Utilization_27-10-2026_27-10-2026_28-10-2026.csv').then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordsUpserted, 3);
    var parsed = datesByAsset(out.mock);
    assert.strictEqual(parsed.byId[1].record_date, '2026-10-27');
    assert.strictEqual(parsed.byId[2].record_date, '2026-10-27');
    assert.strictEqual(parsed.byId[3].record_date, '2026-10-27');
    assert.strictEqual(parsed.byId[1].operating_hours, 8.3);
    assert.strictEqual(parsed.byId[1].litres_consumed, 200.5);
    assert.strictEqual(
      parsed.byId[3].data_quality_notes,
      'Insufficient runtime meter precision for valid calculation'
    );
    parsed.tel.rows.forEach(function(r) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'idle_fuel_litres'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'working_fuel_litres'), false);
    });
    assert.strictEqual(
      out.warnings.filter(function(w) { return w.indexOf('fallback record_date') !== -1; }).length,
      0
    );
    console.log('✓ DD-MM single-day filename pins every row to 2026-10-27');

    return runNzReport('Fleet_Utilization_10-27-2026_10-27-2026_10-28-2026.csv');
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    var parsed = datesByAsset(out.mock);
    assert.strictEqual(parsed.byId[1].record_date, '2026-10-27');
    assert.strictEqual(parsed.byId[2].record_date, '2026-10-27');
    console.log('✓ MM-DD single-day filename pins every row to 2026-10-27');

    return runNzReport('Fleet_Utilization_08-17-2026_08-23-2026_08-24-2026_1.xlsx');
  }).then(function(out) {
    assert.ok(out.error);
    assert.strictEqual(out.error.message, ONE_DAY_MESSAGE_7);
    assert.strictEqual(out.mock.upserted.length, 0, 'multi-day file must not write');
    assert.strictEqual(out.mock.assetUpdates.length, 0);
    assert.strictEqual(out.mock.importUpdates.length, 1);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'failed');
    assert.strictEqual(out.mock.importUpdates[0].payload.error_message, ONE_DAY_MESSAGE_7);
    console.log('✓ multi-day filename rejected with no writes');

    return runNzReport(
      'Fleet_Utilization_02-03-2026_02-03-2026_02-04-2026.csv',
      '2026-02-03T20:00:00Z'
    );
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    var parsed = datesByAsset(out.mock);
    assert.strictEqual(parsed.byId[1].record_date, '2026-02-03');
    assert.strictEqual(parsed.byId[2].record_date, '2026-02-03');
    assert.strictEqual(parsed.byId[3].record_date, '2026-02-03');
    console.log('✓ ambiguous filename resolved to MM-DD via receivedAt');

    return runNzReport(null, null);
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    var parsed = datesByAsset(out.mock);
    assert.strictEqual(parsed.byId[1].record_date, '2026-10-27', '10:43Z is still 27 Oct in Auckland');
    assert.strictEqual(parsed.byId[2].record_date, '2026-10-28', '17:21Z is 28 Oct in Auckland');
    assert.strictEqual(parsed.byId[3].record_date, '2026-10-27');
    assert.ok(out.warnings.some(function(w) { return w.indexOf('fallback record_date') !== -1; }));
    console.log('✓ no filename falls back to NZ-local dates (27 Oct and 28 Oct)');
  });
}

testDateParsing();
testDetectionAndRows();
testMatching();
testFilenameRange();
testUtcToNzDate();
testEndToEndMock().then(function() {
  return testOneDayGuardAndNzDates();
}).then(function() {
  console.log('\n════════════════════════════════════════');
  console.log('All VisionLink parser tests passed.');
  console.log('Wired into email-inbound + bulk-import (isVisionLinkCsv).');
  console.log('Callouts → telematics_records.data_quality_notes');
  console.log('Fuel → telematics_records.litres_consumed');
  console.log('One-day filename guard + NZ-local fallback dates');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
