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
          var chain = {
            eq: function() { return chain; },
            in: function() { return chain; },
            then: function(resolve) {
              resolve({
                data: table === 'assets' ? ASSETS : [],
                error: null,
              });
            },
          };
          return chain;
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

function createMock(assets, options) {
  options = options || {};
  var ignored = options.ignored || [];
  var telematics = options.telematics || [];
  var upserted = [];
  var assetUpdates = [];
  var importUpdates = [];
  function mockFrom(table) {
    return {
      select: function() {
        var chain = {
          eq: function() { return chain; },
          in: function() { return chain; },
          then: function(resolve) {
            var data = [];
            if (table === 'assets') data = assets;
            else if (table === 'ignored_assets') data = ignored;
            else if (table === 'telematics_records') data = telematics;
            resolve({ data: data, error: null });
          },
        };
        return chain;
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

function utilCsv(lines) {
  return [HEADER].concat(lines).join('\n');
}

var ACTIVITY_TAIL = ',2026-10-27T10:00:00Z,2026-10-27T10:00:00Z,+13:00,Pacific/Auckland,NZDT,9,1,8,10,20,2';
var EMPTY_TAIL = ',2026-10-27T10:00:00Z,2026-10-27T10:00:00Z,+13:00,Pacific/Auckland,NZDT,,,,,';

function runUtil(csv, filename, receivedAt, assets, options) {
  var warnings = [];
  var logs = [];
  var origWarn = console.warn;
  var origLog = console.log;
  console.warn = function() {
    warnings.push(Array.prototype.slice.call(arguments).join(' '));
    origWarn.apply(console, arguments);
  };
  console.log = function() {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
    origLog.apply(console, arguments);
  };
  var mock = createMock(assets, options);
  return visionlink.parseVisionLinkReport(mock.supabase, {
    userId: MONRO_USER,
    importId: 'imp-vl-stage',
    rawCsv: csv,
    filename: filename,
    receivedAt: receivedAt,
  }).then(function(result) {
    console.warn = origWarn;
    console.log = origLog;
    return { result: result, warnings: warnings, logs: logs, mock: mock, error: null };
  }, function(err) {
    console.warn = origWarn;
    console.log = origLog;
    return { result: null, warnings: warnings, logs: logs, mock: mock, error: err };
  });
}

function pendingUpserts(mock) {
  return mock.upserted.filter(function(u) { return u.table === 'pending_assets'; });
}

function telematicsUpsert(mock) {
  return mock.upserted.filter(function(u) { return u.table === 'telematics_records'; })[0] || null;
}

function assertPendingShape(entry, expected) {
  assert.strictEqual(entry.opts.onConflict, 'user_id,asset_name');
  assert.strictEqual(entry.opts.ignoreDuplicates, true);
  var row = entry.rows;
  assert.strictEqual(row.user_id, MONRO_USER);
  assert.strictEqual(row.asset_name, expected.name);
  assert.strictEqual(row.asset_type, expected.type);
  assert.strictEqual(row.registration, null);
  assert.strictEqual(row.source, 'visionlink');
  assert.deepStrictEqual(row.raw_data, {
    assetId: expected.assetId,
    serial: expected.serial,
    make: expected.make,
    model: expected.model,
    productFamily: null,
    source: 'visionlink',
  });
}

function testAssetTypeMapping() {
  console.log('\n=== visionLinkAssetType ===');
  var cases = [
    ['Forestry Excavator', '', 'Excavator'],
    ['Medium Hydraulic Excavator', '326FL', 'Excavator'],
    ['Wheel Loader', '', 'Wheel Loader'],
    ['Skidder', '', 'Skidder'],
    ['Dozer', '', 'Bulldozer'],
    ['Track-Type Tractor', '', 'Bulldozer'],
    ['Motor Grader', '', 'Motor Grader'],
    ['Cat Compact', 'C7.1', 'Compactor'],
    ['Compactor', '', 'Compactor'],
    ['Forklift', '', 'Forklift'],
    ['Telehandler', '', 'Forklift'],
    ['Crane', '', 'Crane'],
    ['Articulated Truck', '', 'Dump Truck'],
    ['Dump Truck', '', 'Dump Truck'],
    ['Generator', 'C7.1', 'Other'],
    ['', '326FL', 'Other'],
    ['', 'C7.1', 'Other'],
    ['', 'Excavator', 'Excavator'],
    [null, null, 'Other'],
  ];
  cases.forEach(function(c) {
    assert.strictEqual(visionlink.visionLinkAssetType(c[0], c[1]), c[2], JSON.stringify(c));
  });
  assert.strictEqual(
    visionlink.visionLinkMachineName({
      Make: 'CAT  ',
      Model: '  558GF',
      'Asset ID': 'EQ000002',
      'Asset Serial Number': 'AAA00002',
    }),
    'CAT 558GF (EQ000002)'
  );
  assert.strictEqual(
    visionlink.visionLinkMachineName({
      'Make Display Name': 'CAT',
      Model: '558GF',
      'Asset ID': 'EQ000002',
      'Asset Serial Number': 'AAA00002',
    }),
    'CAT 558GF (EQ000002)'
  );
  assert.strictEqual(
    visionlink.visionLinkMachineName({
      Make: 'CAT',
      Model: '326FL',
      'Asset ID': '',
      'Asset Serial Number': 'AAA00008',
    }),
    'CAT 326FL (AAA00008)'
  );
  console.log('✓ product family mappings, unknown → Other, shared name format');
}

function testStageAndHourGuard() {
  console.log('\n=== Stage unknown machines + hour meter guard ===');
  var known = { id: 11, asset_name: 'CAT 538LL (EQ000001)', visionlink_serial: 'AAA00001', current_hours: 100 };
  var day = 'Fleet_Utilization_27-10-2026_27-10-2026_28-10-2026.csv';
  var hourAssets = [
    { id: 31, asset_name: 'CAT 538LL (EQ000031)', visionlink_serial: 'AAA00031', current_hours: 5000 },
    { id: 32, asset_name: 'CAT 558GF (EQ000032)', visionlink_serial: 'AAA00032', current_hours: 6000 },
    { id: 33, asset_name: 'CAT 326FL (EQ000033)', visionlink_serial: 'AAA00033', current_hours: 1000 },
  ];
  var stored = [
    { asset_id: 31, record_date: '2026-10-27' },
    { asset_id: 32, record_date: '2026-10-01' },
    { asset_id: 32, record_date: '2026-10-27' },
  ];
  var mixed = utilCsv([
    ',EQ000001,AAA00001,CAT,538LL,8000' + ACTIVITY_TAIL,
    ',EQ000002,AAA00002,CAT,558GF,9000' + ACTIVITY_TAIL,
    ',EQ000003,AAA00003,CAT,326FL,4800' + ACTIVITY_TAIL,
  ]);
  return runUtil(mixed, day, null, [known]).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordsUpserted, 1);
    assert.strictEqual(out.result.pendingStaged, 2);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'processed');
    assert.strictEqual(out.mock.importUpdates[0].payload.error_message, null);
    var tel = telematicsUpsert(out.mock);
    assert.ok(tel);
    assert.strictEqual(tel.rows.length, 1);
    assert.strictEqual(tel.rows[0].asset_id, 11);
    var pending = pendingUpserts(out.mock);
    assert.strictEqual(pending.length, 2);
    var byName = {};
    pending.forEach(function(p) { byName[p.rows.asset_name] = p; });
    assertPendingShape(byName['CAT 558GF (EQ000002)'], {
      name: 'CAT 558GF (EQ000002)',
      type: 'Other',
      assetId: 'EQ000002',
      serial: 'AAA00002',
      make: 'CAT',
      model: '558GF',
    });
    assertPendingShape(byName['CAT 326FL (EQ000003)'], {
      name: 'CAT 326FL (EQ000003)',
      type: 'Other',
      assetId: 'EQ000003',
      serial: 'AAA00003',
      make: 'CAT',
      model: '326FL',
    });
    assert.ok(out.logs.some(function(l) {
      return l.indexOf('staged pending asset "CAT 558GF (EQ000002)"') !== -1;
    }));
    assert.ok(out.logs.some(function(l) { return l.indexOf('staged 2 machine(s) for approval') !== -1; }));
    console.log('✓ known machine written, two unknown machines staged');

    return runUtil(utilCsv([
      ',EQ000002,AAA00002,CAT,558GF,9000' + ACTIVITY_TAIL,
      ',EQ000003,AAA00003,CAT,326FL,4800' + ACTIVITY_TAIL,
    ]), day, null, []);
  }).then(function(out) {
    assert.strictEqual(out.error, null, 'all-unknown must not throw (no failure alert)');
    assert.strictEqual(out.result.recordsUpserted, 0);
    assert.strictEqual(out.result.pendingStaged, 2);
    assert.strictEqual(telematicsUpsert(out.mock), null);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'processed');
    assert.strictEqual(
      out.mock.importUpdates[0].payload.error_message,
      'No known machines yet: 2 machine(s) waiting for approval on the Assets page.'
    );
    console.log('✓ all unknown: processed with the waiting note, nothing thrown');

    return runUtil(utilCsv([
      ',EQ000001,AAA00001,CAT,538LL,8000' + ACTIVITY_TAIL,
      ',EQ000099,AAA00099,CAT,999,100' + ACTIVITY_TAIL,
    ]), day, null, [known], {
      ignored: [{ asset_name: 'CAT 999 (EQ000099)' }],
    });
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.recordsUpserted, 1);
    assert.strictEqual(out.result.pendingStaged, 0);
    assert.strictEqual(out.result.pendingIgnored, 1);
    assert.strictEqual(pendingUpserts(out.mock).length, 0);
    console.log('✓ ignored name is not staged');

    return runUtil(utilCsv([
      ',EQ000099,AAA00099,CAT,999,100' + ACTIVITY_TAIL,
    ]), day, null, [], {
      ignored: [{ asset_name: 'CAT 999 (EQ000099)' }],
    });
  }).then(function(out) {
    assert.strictEqual(out.error, null, 'ignored-only file must not throw');
    assert.strictEqual(out.result.recordsUpserted, 0);
    assert.strictEqual(out.result.pendingStaged, 0);
    assert.strictEqual(out.result.pendingIgnored, 1);
    assert.strictEqual(pendingUpserts(out.mock).length, 0);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'processed');
    assert.strictEqual(
      out.mock.importUpdates[0].payload.error_message,
      'No known machines yet: 0 machine(s) waiting for approval on the Assets page.'
    );
    console.log('✓ ignored-only file is processed, not failed');

    return runUtil(utilCsv([
      ',EQ000001,AAA00001,CAT,538LL,8000' + ACTIVITY_TAIL,
      ',EQ000008,AAA00008,CAT,320,100' + EMPTY_TAIL,
    ]), day, null, [known]);
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.skippedEmpty, 1);
    assert.strictEqual(out.result.pendingStaged, 1);
    assert.strictEqual(pendingUpserts(out.mock)[0].rows.asset_name, 'CAT 320 (EQ000008)');
    assert.strictEqual(telematicsUpsert(out.mock).rows.length, 1);
    assert.strictEqual(telematicsUpsert(out.mock).rows[0].asset_id, 11);
    console.log('✓ empty-activity unknown machine is staged and not written');

    return runUtil(utilCsv([
      ',EQ000001,AAA00001,CAT,538LL,8000' + ACTIVITY_TAIL,
      ',,AAA00008,CAT,326FL,100' + ACTIVITY_TAIL,
      ',,,CAT,Mystery,100' + ACTIVITY_TAIL,
    ]), day, null, [known]);
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    var names = pendingUpserts(out.mock).map(function(p) { return p.rows.asset_name; });
    assert.deepStrictEqual(names, ['CAT 326FL (AAA00008)']);
    assert.ok(out.warnings.some(function(w) {
      return w.indexOf('no Asset ID and no serial') !== -1;
    }));
    console.log('✓ serial-only name uses the serial; blank id and serial is skipped');

    return runUtil(utilCsv([
      ',EQ000002,AAA00002,CAT,558GF,9000' + ACTIVITY_TAIL,
    ]), 'Fleet_Utilization_08-17-2026_08-23-2026_08-24-2026_1.xlsx', null, []);
  }).then(function(out) {
    assert.ok(out.error);
    assert.strictEqual(out.error.message, ONE_DAY_MESSAGE_7);
    assert.strictEqual(out.mock.upserted.length, 0);
    assert.strictEqual(out.mock.importUpdates[0].payload.status, 'failed');
    console.log('✓ multi-day file fails and stages nothing');

    return runUtil(utilCsv([
      ',EQ000031,AAA00031,CAT,538LL,5100' + ACTIVITY_TAIL,
      ',EQ000033,AAA00033,CAT,326FL,1100' + ACTIVITY_TAIL,
    ]), 'Fleet_Utilization_20-10-2026_20-10-2026_21-10-2026.csv', null, hourAssets, {
      telematics: stored,
    });
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    var tel = telematicsUpsert(out.mock);
    assert.strictEqual(tel.rows.length, 2);
    var byId = {};
    tel.rows.forEach(function(r) { byId[r.asset_id] = r; });
    assert.strictEqual(byId[31].record_date, '2026-10-20');
    assert.strictEqual(byId[31].total_engine_hours, 5100);
    assert.strictEqual(byId[33].total_engine_hours, 1100);
    var hours = {};
    out.mock.assetUpdates.forEach(function(u) {
      var idFilter = u.filters.filter(function(f) { return f.col === 'id'; })[0];
      hours[idFilter.val] = u.payload.current_hours;
    });
    assert.strictEqual(hours[31], undefined);
    assert.strictEqual(hours[33], 1100);
    assert.ok(out.logs.some(function(l) {
      return l === 'visionlink: skipping current_hours update for asset 31 (file date 2026-10-20 is older than newest stored 2026-10-27)';
    }));
    console.log('✓ older file keeps current_hours and still upserts telematics');

    return runUtil(utilCsv([
      ',EQ000032,AAA00032,CAT,558GF,6100' + ACTIVITY_TAIL,
      ',EQ000031,AAA00031,CAT,538LL,5200' + ACTIVITY_TAIL,
    ]), 'Fleet_Utilization_28-10-2026_28-10-2026_29-10-2026.csv', null, hourAssets, {
      telematics: stored,
    });
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    var hours = {};
    out.mock.assetUpdates.forEach(function(u) {
      var idFilter = u.filters.filter(function(f) { return f.col === 'id'; })[0];
      hours[idFilter.val] = u.payload.current_hours;
    });
    assert.strictEqual(hours[32], 6100);
    assert.strictEqual(hours[31], 5200);
    console.log('✓ newer file updates current_hours');

    return runUtil(utilCsv([
      ',EQ000031,AAA00031,CAT,538LL,5150' + ACTIVITY_TAIL,
    ]), 'Fleet_Utilization_27-10-2026_27-10-2026_28-10-2026.csv', null, hourAssets, {
      telematics: stored,
    });
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.mock.assetUpdates[0].payload.current_hours, 5150);
    console.log('✓ file date equal to the newest stored day still updates current_hours');

    var firstAssets = [known];
    var approveCsv = utilCsv([
      ',EQ000010,AAA00010,CAT,320,50' + ACTIVITY_TAIL,
    ]);
    return runUtil(approveCsv, day, null, firstAssets).then(function(first) {
      assert.strictEqual(first.result.pendingStaged, 1);
      assert.strictEqual(pendingUpserts(first.mock)[0].rows.asset_name, 'CAT 320 (EQ000010)');
      var approved = firstAssets.concat([{
        id: 40,
        asset_name: 'CAT 320 (EQ000010)',
        visionlink_serial: 'AAA00010',
        current_hours: 40,
      }]);
      return runUtil(approveCsv, day, null, approved);
    });
  }).then(function(out) {
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.result.pendingStaged, 0);
    assert.strictEqual(pendingUpserts(out.mock).length, 0);
    assert.strictEqual(telematicsUpsert(out.mock).rows[0].asset_id, 40);
    assert.strictEqual(visionlink.extractBracketAssetId('CAT 320 (EQ000010)'), 'EQ000010');
    console.log('✓ approved bracket id matches on the next file and is not staged');
  });
}

function testConfirmedPayloadCarriesSerial() {
  console.log('\n=== Approval payload carries visionlink_serial ===');
  var fs = require('fs');
  var path = require('path');
  var html = fs.readFileSync(path.join(__dirname, '../assets.html'), 'utf8');
  var start = html.indexOf('function buildConfirmedAssetPayload');
  var end = html.indexOf('async function confirmPendingAsset');
  assert.ok(start !== -1 && end > start);
  var src = html.slice(start, end);
  var build = new Function('effectiveAccountId', src + '\nreturn buildConfirmedAssetPayload;')(
    '00000000-0000-4000-8000-0000000000c1'
  );
  var payload = build({
    registration: 'ABC123',
    raw_data: { serial: ' AAA00001 ', cardNumber: ' 999 ', assetId: 'EQ000001' },
  }, 'CAT 558GF (EQ000001)', 'Excavator');
  assert.strictEqual(payload.visionlink_serial, 'AAA00001');
  assert.strictEqual(payload.bp_card_number, '999');
  assert.strictEqual(payload.registration, 'ABC123');
  assert.strictEqual(payload.asset_name, 'CAT 558GF (EQ000001)');
  var blank = build({ raw_data: { serial: '   ' } }, 'CAT 320 (EQ000010)', 'Other');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(blank, 'visionlink_serial'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(blank, 'bp_card_number'), false);
  console.log('✓ visionlink_serial is copied from raw_data.serial; blank serial is omitted');
}

testDateParsing();
testDetectionAndRows();
testMatching();
testFilenameRange();
testUtcToNzDate();
testAssetTypeMapping();
testConfirmedPayloadCarriesSerial();
testEndToEndMock().then(function() {
  return testOneDayGuardAndNzDates();
}).then(function() {
  return testStageAndHourGuard();
}).then(function() {
  console.log('\n════════════════════════════════════════');
  console.log('All VisionLink parser tests passed.');
  console.log('Wired into email-inbound + bulk-import (isVisionLinkCsv).');
  console.log('Callouts → telematics_records.data_quality_notes');
  console.log('Fuel → telematics_records.litres_consumed');
  console.log('One-day filename guard + NZ-local fallback dates');
  console.log('Unknown machines staged in pending_assets; hour meter guarded');
}).catch(function(err) {
  console.error('\nFAILED:', err);
  process.exit(1);
});
