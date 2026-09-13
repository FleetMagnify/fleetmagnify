/**
 * Local tests for parsers/everlink-clarity.js — not wired to email import.
 * Run: node scripts/test-everlink-clarity-parser.js
 *
 * Requires the real Maugers Aug 2026 export at
 * scripts/fixtures/everlink-clarity-sample.xlsx
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var everlink = require('../parsers/everlink-clarity');
var { parseNumeric } = require('../parsers/parser-utils');

var FIXTURE = path.join(__dirname, 'fixtures', 'everlink-clarity-sample.xlsx');
var SAMPLE_USER = '00000000-0000-4000-8000-000000000001';

function round2(n) {
  return Math.round(n * 100) / 100;
}

function loadFixtureBuffer() {
  assert.ok(fs.existsSync(FIXTURE), 'copy Maugers_Monthly_Report.xlsx to ' + FIXTURE);
  return fs.readFileSync(FIXTURE);
}

function createChain(result) {
  var chain = {
    select: function() { return chain; },
    eq: function() { return chain; },
    not: function() { return chain; },
    in: function() { return chain; },
    maybeSingle: function() { return Promise.resolve(result); },
    single: function() { return Promise.resolve(result); },
    then: function(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return chain;
}

function mockSupabase(opts) {
  opts = opts || {};
  var assets = opts.assets || [];
  var settings = opts.settings || [];
  var calls = { upserts: [], updates: [] };

  return {
    calls: calls,
    from: function(table) {
      return {
        select: function() {
          var data = [];
          if (table === 'assets') data = assets;
          if (table === 'user_settings') data = settings;
          return createChain({ data: data, error: null });
        },
        upsert: function(rows, upsertOpts) {
          calls.upserts.push({ table: table, rows: rows, opts: upsertOpts });
          return Promise.resolve({ error: null });
        },
        update: function(payload) {
          return {
            eq: function() {
              calls.updates.push({ table: table, payload: payload });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function summarize(rows) {
  var out = {
    total: rows.length,
    totalLitres: 0,
    excludedBulkTank: { n: 0, litres: 0 },
    excludedAlliedTanker: { n: 0, litres: 0 },
    excludedHired: { n: 0, litres: 0 },
    included: { n: 0, litres: 0 },
    includedAssetNos: {},
    byAsset: {},
  };

  rows.forEach(function(row) {
    var litres = parseNumeric(row.FillTotal) || 0;
    out.totalLitres += litres;
    var cat = everlink.classifyEverlinkGroup(row.Group);
    if (cat === 'excluded_bulk_tank') {
      out.excludedBulkTank.n++;
      out.excludedBulkTank.litres += litres;
      return;
    }
    if (cat === 'excluded_allied_tanker') {
      out.excludedAlliedTanker.n++;
      out.excludedAlliedTanker.litres += litres;
      return;
    }
    if (cat === 'excluded_hired') {
      out.excludedHired.n++;
      out.excludedHired.litres += litres;
      return;
    }
    out.included.n++;
    out.included.litres += litres;
    out.includedAssetNos[row.AssetNo] = true;
    if (!out.byAsset[row.AssetNo]) {
      out.byAsset[row.AssetNo] = { n: 0, litres: 0, names: {}, locations: {} };
    }
    var entry = out.byAsset[row.AssetNo];
    entry.n++;
    entry.litres += litres;
    entry.names[row['Equipment Name']] = true;
    entry.locations[row.LocationName] = true;
  });

  return out;
}

function testDetection() {
  console.log('\n=== Detection ===');
  var buf = loadFixtureBuffer();
  assert.strictEqual(everlink.isEverlinkClarityXlsx(buf), true);
  assert.strictEqual(everlink.isEverlinkClarityXlsx(Buffer.from('not-an-xlsx')), false);
  assert.strictEqual(everlink.isEverlinkClarityXlsx(null), false);
  console.log('✓ isEverlinkClarityXlsx detects the Maugers fixture');
}

function testDateParsing() {
  console.log('\n=== TimeStamp date parsing (NZ local, no day-shift) ===');
  // Confirmed shapes from the real fixture (see parser comment).
  assert.strictEqual(everlink.parseEverlinkDate('07/08/2026 07:16:46 AM'), '2026-08-07');
  assert.strictEqual(everlink.parseEverlinkDate('25/08/2026 07:13:30 AM'), '2026-08-25');
  assert.strictEqual(everlink.parseEverlinkDate(46241.30331018518), '2026-08-07');
  assert.strictEqual(everlink.parseEverlinkDate(46259.301041666666), '2026-08-25');
  assert.strictEqual(everlink.parseEverlinkDate('2026-08-07 07:16:46'), '2026-08-07');
  var local = new Date(2026, 7, 7, 7, 16, 46);
  assert.strictEqual(everlink.parseEverlinkDate(local), '2026-08-07');
  assert.notStrictEqual(everlink.parseEverlinkDate('07/08/2026 07:16:46 AM'), '2026-07-08');
  assert.notStrictEqual(everlink.parseEverlinkDate('07/08/2026 07:16:46 AM'), '2026-08-06');
  assert.notStrictEqual(everlink.parseEverlinkDate('07/08/2026 07:16:46 AM'), '2026-08-08');
  console.log('✓ formatted DD/MM/YYYY, Excel serial, and Date → 2026-08-07 (not 8 July, no ±1 day)');
}

function testFixtureCounts() {
  console.log('\n=== Fixture row / litre counts ===');
  var rows = everlink.parseEverlinkClarityXlsRows(loadFixtureBuffer());
  var stats = summarize(rows);

  console.log('  total rows:', stats.total);
  console.log('  total litres:', round2(stats.totalLitres));
  console.log('  FUE:', stats.excludedBulkTank.n, round2(stats.excludedBulkTank.litres));
  console.log('  TAN:', stats.excludedAlliedTanker.n, round2(stats.excludedAlliedTanker.litres));
  console.log('  hired:', stats.excludedHired.n, round2(stats.excludedHired.litres));
  console.log('  included:', stats.included.n, round2(stats.included.litres));
  console.log('  distinct included AssetNo:', Object.keys(stats.includedAssetNos).length);

  assert.strictEqual(rows.length, 435);
  assert.strictEqual(round2(stats.totalLitres), 70006.77);
  assert.strictEqual(stats.excludedBulkTank.n, 10);
  assert.strictEqual(round2(stats.excludedBulkTank.litres), 1950.59);
  assert.strictEqual(stats.excludedAlliedTanker.n, 9);
  assert.strictEqual(round2(stats.excludedAlliedTanker.litres), 8565.54);
  assert.strictEqual(stats.excludedHired.n, 9);
  assert.strictEqual(round2(stats.excludedHired.litres), 1091.01);
  assert.strictEqual(
    stats.excludedBulkTank.n + stats.excludedAlliedTanker.n + stats.excludedHired.n,
    28
  );
  assert.strictEqual(stats.included.n, 407);
  assert.strictEqual(round2(stats.included.litres), 58399.63);
  assert.strictEqual(Object.keys(stats.includedAssetNos).length, 89);
  console.log('✓ 435 / 70,006.77 L; 28 excluded; 407 included / 58,399.63 L; 89 assets');
}

function testMultiLocationRollup() {
  console.log('\n=== Multi-location rollup by AssetNo ===');
  var rows = everlink.parseEverlinkClarityXlsRows(loadFixtureBuffer());
  var stats = summarize(rows);

  var p270 = stats.byAsset.P270;
  assert.ok(p270, 'P270 present');
  assert.strictEqual(Object.keys(p270.names).length, 1);
  assert.ok(Object.keys(p270.names)[0].indexOf('JOHN DEERE EXCAVATOR 350DLC') !== -1);
  assert.ok(Object.keys(p270.locations).length >= 3, 'P270 appears at 3 locations');
  assert.strictEqual(p270.n, 13);
  assert.strictEqual(round2(p270.litres), 3616.68);
  console.log('  P270', p270.n, 'rows', round2(p270.litres), 'L @', Object.keys(p270.locations).join(', '));

  var p367 = stats.byAsset.P367;
  assert.ok(p367, 'P367 present');
  assert.ok(Object.keys(p367.names)[0].indexOf('CATERPILLAR D5K DOZER') !== -1);
  assert.ok(Object.keys(p367.locations).length >= 2);
  assert.strictEqual(p367.n, 16);
  assert.strictEqual(round2(p367.litres), 1743.90);
  console.log('  P367', p367.n, 'rows', round2(p367.litres), 'L @', Object.keys(p367.locations).join(', '));
  console.log('✓ LocationName is not an ownership key; rollup is by AssetNo');
}

function testAssetNoNotNamePrefix() {
  console.log('\n=== AssetNo vs Equipment Name prefix ===');
  var rows = everlink.parseEverlinkClarityXlsRows(loadFixtureBuffer());

  var fuelTank = rows.filter(function(r) { return r['Equipment Name'] === 'P345 FUEL TANK'; });
  assert.ok(fuelTank.length >= 1, 'P345 FUEL TANK present');
  fuelTank.forEach(function(r) {
    assert.strictEqual(r.AssetNo, 'F345');
    assert.strictEqual(everlink.classifyEverlinkGroup(r.Group), 'excluded_bulk_tank');
  });

  var navara = rows.filter(function(r) { return r.AssetNo === 'P345'; });
  assert.ok(navara.length >= 1, 'P345 Navara present');
  navara.forEach(function(r) {
    assert.notStrictEqual(r.AssetNo, 'F345');
    assert.ok(r['Equipment Name'].indexOf('P345') === 0);
    assert.strictEqual(everlink.classifyEverlinkGroup(r.Group), 'included');
  });

  assert.strictEqual(everlink.classifyEverlinkGroup('UTE '), 'included');
  assert.strictEqual(everlink.classifyEverlinkGroup(''), 'excluded_hired');
  assert.strictEqual(everlink.normalizeRego('No Rego'), null);
  assert.strictEqual(everlink.normalizeRego('NGH449'), 'NGH449');
  console.log('✓ P345 FUEL TANK is F345/excluded; P345 Navara stays included; UTE trailing space kept');
}

function testEmptyAccountEndToEnd() {
  console.log('\n=== End-to-end empty account (expected today) ===');
  return Promise.resolve().then(async function() {
    var supabase = mockSupabase();
    var result = await everlink.parseEverlinkClarityReport(supabase, {
      userId: SAMPLE_USER,
      importId: 'imp-everlink-1',
      fileBuffer: loadFixtureBuffer(),
    });

    console.log('  result:', JSON.stringify({
      ok: result.ok,
      recordsUpserted: result.recordsUpserted,
      pendingAdded: result.pendingAdded,
      excludedBulkTank: result.excludedBulkTank,
      excludedAlliedTanker: result.excludedAlliedTanker,
      excludedHired: result.excludedHired,
      rowsSkipped: result.rowsSkipped,
      missingFuelPriceSetting: result.missingFuelPriceSetting,
    }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.recordsUpserted, 0, 'no assets matched — no fuel_purchases');
    assert.strictEqual(result.pendingAdded, 89);
    assert.strictEqual(result.excludedBulkTank, 10);
    assert.strictEqual(result.excludedAlliedTanker, 9);
    assert.strictEqual(result.excludedHired, 9);
    assert.strictEqual(result.missingFuelPriceSetting, false);

    var fuelUpserts = supabase.calls.upserts.filter(function(u) { return u.table === 'fuel_purchases'; });
    assert.strictEqual(fuelUpserts.length, 0, 'must not invent fuel_purchases rows');

    var pendingUpserts = supabase.calls.upserts.filter(function(u) { return u.table === 'pending_assets'; });
    assert.strictEqual(pendingUpserts.length, 1, 'pending_assets must be one batch, not per-row');
    assert.strictEqual(pendingUpserts[0].rows.length, 89);
    assert.strictEqual(pendingUpserts[0].opts.onConflict, 'user_id,asset_name');
    pendingUpserts[0].rows.forEach(function(row) {
      assert.strictEqual(row.source, 'everlink-clarity');
      assert.ok(row.asset_name);
      assert.ok(row.raw_data);
      if (row.registration) assert.notStrictEqual(row.registration, 'No Rego');
    });

    var p270Pending = pendingUpserts[0].rows.filter(function(r) {
      return r.raw_data && r.raw_data.AssetNo === 'P270';
    })[0];
    assert.ok(p270Pending);
    assert.ok(p270Pending.asset_name.indexOf('JOHN DEERE EXCAVATOR 350DLC') !== -1);
    assert.strictEqual(p270Pending.asset_type, 'Excavator');

    var processed = supabase.calls.updates.filter(function(u) {
      return u.table === 'email_imports' && u.payload.status === 'processed';
    });
    assert.strictEqual(processed.length, 1);
    console.log('✓ recordsUpserted=0, pendingAdded=89 (correct empty-register state)');
  });
}

function testMatchedAssetUsesRateOrNull() {
  console.log('\n=== Matched asset: rate used when set, null when missing ===');
  return Promise.resolve().then(async function() {
    var noRate = mockSupabase({
      assets: [{ id: 501, everlink_asset_no: 'P270' }],
    });
    var noRateResult = await everlink.parseEverlinkClarityReport(noRate, {
      userId: SAMPLE_USER,
      importId: 'imp-everlink-2',
      fileBuffer: loadFixtureBuffer(),
    });
    assert.strictEqual(noRateResult.ok, true);
    assert.ok(noRateResult.recordsUpserted > 0);
    assert.strictEqual(noRateResult.pendingAdded, 88);
    assert.strictEqual(noRateResult.missingFuelPriceSetting, true);
    var noRateFuel = noRate.calls.upserts.filter(function(u) { return u.table === 'fuel_purchases'; })[0];
    assert.ok(noRateFuel);
    noRateFuel.rows.forEach(function(r) {
      assert.strictEqual(r.vehicle_id, 501);
      assert.strictEqual(r.source, 'everlink-clarity');
      assert.strictEqual(r.cost_nzd, null);
      assert.ok(r.litres > 0);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.purchase_date));
    });
    var noRateLitres = noRateFuel.rows.reduce(function(sum, r) { return sum + r.litres; }, 0);
    assert.strictEqual(round2(noRateLitres), 3616.68);
    console.log('✓ unmatched stay pending; matched P270 inserts litres with cost_nzd null');

    var withRate = mockSupabase({
      assets: [{ id: 501, everlink_asset_no: 'P270' }],
      settings: [{ machinery_fuel_cost_per_litre: 1.85 }],
    });
    var withRateResult = await everlink.parseEverlinkClarityReport(withRate, {
      userId: SAMPLE_USER,
      importId: 'imp-everlink-3',
      fileBuffer: loadFixtureBuffer(),
    });
    assert.strictEqual(withRateResult.missingFuelPriceSetting, false);
    var priced = withRate.calls.upserts.filter(function(u) { return u.table === 'fuel_purchases'; })[0];
    priced.rows.forEach(function(r) {
      assert.strictEqual(r.cost_nzd, r.litres * 1.85);
    });
    console.log('✓ cost_nzd = litres * machinery_fuel_cost_per_litre when set');
  });
}

testDetection();
testDateParsing();
testFixtureCounts();
testMultiLocationRollup();
testAssetNoNotNamePrefix();
testEmptyAccountEndToEnd()
  .then(testMatchedAssetUsesRateOrNull)
  .then(function() {
    console.log('\n════════════════════════════════════════');
    console.log('All Everlink Clarity parser tests passed.');
    console.log('Not wired into email-inbound or admin upload.');
  })
  .catch(function(err) {
    console.error('\nFAILED:', err);
    process.exit(1);
  });
