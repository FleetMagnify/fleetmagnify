/**
 * Confirms the shared fuel model: trucks = fuel_purchases + fuel_records
 * (additive); machinery = telematics_records.litres_consumed × bulk $/L only.
 *
 *   node scripts/test-fuel-source-consolidation.js
 *
 * Local FCM asserts always run. Live ILS / Demo checks require:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
 */
var assert = require('assert');
var { createClient } = require('@supabase/supabase-js');
var FCM = require('../js/fleet-cost-model');

var ILS_USER_ID = 'd2ed89c3-dcaf-48b3-826a-f73802e4cf74';
var DEMO_USER_ID = '023182a8-1563-46dd-a7c3-1430fbfad5df';
var MONRO_USER_ID = '59dd8c6a-1146-4245-978b-6550095ea6c8';
var DEMO_EXCAVATOR_ID = 1414;
var TEST_SUPPLIER = 'fuel-source-consolidation-test';

var truck = { id: 1, asset_name: 'T21', asset_type: 'Rigid Truck' };
var machine = { id: 1414, asset_name: 'Hitachi ZX350 Excavator', asset_type: 'Excavator' };

function testLocalModel() {
  console.log('\n=== Local FCM.assetFuelTotals ===');

  var purchases = [
    { litres: 100, cost_nzd: 185 },
    { litres: 50, cost_nzd: 92.5 }
  ];
  var invoicesOnly = FCM.truckFuelFromInvoices(purchases);
  var noRecords = FCM.assetFuelTotals(truck, { purchaseRows: purchases, fuelRecordRows: [] });
  assert.strictEqual(noRecords.litres, invoicesOnly.litres);
  assert.strictEqual(noRecords.cost, invoicesOnly.cost);
  console.log('  truck with no fuel_records matches invoices-only ✓');

  var records = [{ litres: 40, total_cost: 60.8 }];
  var combined = FCM.assetFuelTotals(truck, {
    purchaseRows: purchases,
    fuelRecordRows: records
  });
  assert.strictEqual(combined.litres, invoicesOnly.litres + 40);
  assert.strictEqual(combined.cost, invoicesOnly.cost + 60.8);
  console.log('  truck purchases + fuel_records is additive ✓');

  var telRows = [
    { litres_consumed: 48.3 },
    { litres_consumed: 22.0 }
  ];
  var staleRecords = [];
  for (var i = 0; i < 65; i++) staleRecords.push({ litres: 10, total_cost: 15.2 });
  var machinery = FCM.assetFuelTotals(machine, {
    telRows: telRows,
    machineryCpl: 1.52,
    fuelRecordRows: staleRecords,
    purchaseRows: purchases
  });
  var fromTel = FCM.machineryFuelFromTelematics(telRows, 1.52);
  assert.strictEqual(machinery.litres, fromTel.litres);
  assert.strictEqual(machinery.cost, fromTel.cost);
  assert.strictEqual(machinery.litres, 70.3);
  assert.ok(Math.abs(machinery.cost - 70.3 * 1.52) < 1e-9);
  console.log('  machinery ignores fuel_records / purchases ✓');
}

function createClientFromEnv() {
  var url = process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY — live ILS/Demo checks skipped.');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function summarizeLitresSequence(rows) {
  var litres = rows.map(function(r) { return parseFloat(r.litres_consumed) || 0; });
  var nonzero = litres.filter(function(n) { return n > 0; });
  var unique = {};
  nonzero.forEach(function(n) { unique[String(n)] = true; });
  var uniqueCount = Object.keys(unique).length;
  var longestRepeat = 1;
  var cur = 1;
  for (var i = 1; i < litres.length; i++) {
    if (litres[i] > 0 && litres[i] === litres[i - 1]) {
      cur += 1;
      if (cur > longestRepeat) longestRepeat = cur;
    } else {
      cur = 1;
    }
  }
  return {
    days: rows.length,
    nonzeroDays: nonzero.length,
    uniqueNonzero: uniqueCount,
    longestIdenticalRun: longestRepeat,
    sample: litres.slice(0, 14)
  };
}

// Job-cost does not apportion litres_consumed (uses record_date === work_date).
// That call was made from the VisionLink parser's "one activity row per report
// date" behaviour — NOT from real customer machinery data. As of 2026-09-13,
// ILS and Matt Monro have zero telematics_records.litres_consumed rows.
// When Maugers' (or any) real VisionLink data lands, run this probe for real:
// if the same litres value repeats across consecutive days, job-cost needs
// hours-style weekly apportionment. Do not treat a green local FCM assert
// as proof of daily resolution.
async function probeLitresResolution(supabase, userId, label) {
  var assets = await supabase
    .from('assets')
    .select('id, asset_name, asset_type, is_on_road, telematics_provider')
    .eq('user_id', userId)
    .eq('is_ignored', false);
  if (assets.error) throw new Error(assets.error.message);
  var machinery = (assets.data || []).filter(function(a) { return !FCM.isOnRoad(a); });
  if (!machinery.length) {
    console.log('  ' + label + ': no machinery assets');
    return null;
  }

  var best = null;
  for (var i = 0; i < machinery.length; i++) {
    var asset = machinery[i];
    var tel = await supabase
      .from('telematics_records')
      .select('record_date, litres_consumed')
      .eq('user_id', userId)
      .eq('asset_id', asset.id)
      .not('litres_consumed', 'is', null)
      .gt('litres_consumed', 0)
      .order('record_date')
      .limit(40);
    if (tel.error) throw new Error(tel.error.message);
    var rows = tel.data || [];
    if (rows.length < 5) continue;
    var summary = summarizeLitresSequence(rows);
    summary.asset = asset;
    if (!best || summary.nonzeroDays > best.nonzeroDays) best = summary;
  }

  if (!best) {
    console.log('  ' + label + ': no machinery with 5+ litres_consumed days');
    return null;
  }

  console.log(
    '  ' + label + ' ' + best.asset.asset_name +
    ' (id ' + best.asset.id + ', provider=' + (best.asset.telematics_provider || 'unset') + ')' +
    ': days=' + best.days +
    ' uniqueNonzero=' + best.uniqueNonzero +
    ' longestIdenticalRun=' + best.longestIdenticalRun +
    ' sample=' + JSON.stringify(best.sample)
  );
  // Daily resolution: values vary. Weekly-copied: same number repeats across days.
  assert.ok(
    best.uniqueNonzero >= 2 || best.longestIdenticalRun < 3,
    label + ' litres_consumed looks like a weekly total copied onto consecutive days — job-cost would need apportionment'
  );
  return best;
}

async function testLiveIlsTruck(supabase) {
  console.log('\n=== Live ILS truck (purchases unchanged when no fuel_records) ===');
  var purchases = await supabase
    .from('fuel_purchases')
    .select('vehicle_id, purchase_date, litres, cost_nzd, source')
    .eq('user_id', ILS_USER_ID)
    .order('purchase_date', { ascending: false })
    .limit(200);
  if (purchases.error) throw new Error(purchases.error.message);
  var rows = purchases.data || [];
  assert.ok(rows.length > 0, 'ILS has live fuel_purchases');

  var counts = {};
  rows.forEach(function(r) {
    counts[r.vehicle_id] = (counts[r.vehicle_id] || 0) + 1;
  });
  var vehicleId = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; })[0];
  var asset = await supabase
    .from('assets')
    .select('*')
    .eq('user_id', ILS_USER_ID)
    .eq('id', Number(vehicleId))
    .maybeSingle();
  if (asset.error) throw new Error(asset.error.message);
  assert.ok(asset.data, 'ILS truck asset ' + vehicleId + ' exists');
  assert.ok(FCM.isOnRoad(asset.data), 'chosen ILS asset is on-road');

  var assetPurchases = rows.filter(function(r) { return Number(r.vehicle_id) === Number(vehicleId); });
  var dateFrom = assetPurchases[assetPurchases.length - 1].purchase_date;
  var dateTo = assetPurchases[0].purchase_date;
  var windowPurchases = assetPurchases.filter(function(r) {
    return r.purchase_date >= dateFrom && r.purchase_date <= dateTo;
  });

  var existingRecords = await supabase
    .from('fuel_records')
    .select('id, record_date, litres, total_cost')
    .eq('user_id', ILS_USER_ID)
    .eq('asset_id', Number(vehicleId))
    .gte('record_date', dateFrom)
    .lte('record_date', dateTo);
  if (existingRecords.error) throw new Error(existingRecords.error.message);
  var realRecords = existingRecords.data || [];

  var invoices = FCM.truckFuelFromInvoices(windowPurchases);
  var before = FCM.assetFuelTotals(asset.data, {
    purchaseRows: windowPurchases,
    fuelRecordRows: realRecords
  });
  if (realRecords.length === 0) {
    assert.strictEqual(before.litres, invoices.litres);
    assert.strictEqual(before.cost, invoices.cost);
    console.log(
      '  ' + asset.data.asset_name + ' ' + dateFrom + '–' + dateTo +
      ': ' + invoices.litres.toFixed(1) + ' L / $' + invoices.cost.toFixed(2) +
      ' unchanged with empty fuel_records ✓'
    );
  } else {
    console.log(
      '  ' + asset.data.asset_name + ' already has ' + realRecords.length +
      ' fuel_records in window — invoices-only baseline still computed separately'
    );
    var invoicesOnly = FCM.assetFuelTotals(asset.data, {
      purchaseRows: windowPurchases,
      fuelRecordRows: []
    });
    assert.strictEqual(invoicesOnly.litres, invoices.litres);
    assert.strictEqual(invoicesOnly.cost, invoices.cost);
  }

  var anchor = windowPurchases[0];
  var synthLitres = 12.5;
  var synthCost = 19.0;
  var insert = await supabase.from('fuel_records').insert({
    user_id: ILS_USER_ID,
    asset_id: Number(vehicleId),
    record_date: anchor.purchase_date,
    litres: synthLitres,
    total_cost: synthCost,
    cost_per_litre: synthCost / synthLitres,
    supplier: TEST_SUPPLIER
  }).select('id').single();
  if (insert.error) throw new Error('insert synthetic fuel_records: ' + insert.error.message);
  var synthId = insert.data.id;

  try {
    var afterRows = await supabase
      .from('fuel_records')
      .select('id, record_date, litres, total_cost')
      .eq('user_id', ILS_USER_ID)
      .eq('asset_id', Number(vehicleId))
      .gte('record_date', dateFrom)
      .lte('record_date', dateTo);
    if (afterRows.error) throw new Error(afterRows.error.message);
    var after = FCM.assetFuelTotals(asset.data, {
      purchaseRows: windowPurchases,
      fuelRecordRows: afterRows.data || []
    });
    assert.ok(Math.abs(after.litres - (before.litres + synthLitres)) < 1e-6);
    assert.ok(Math.abs(after.cost - (before.cost + synthCost)) < 1e-6);
    console.log(
      '  synthetic fuel_records on ' + anchor.purchase_date +
      ' added ' + synthLitres + ' L / $' + synthCost.toFixed(2) +
      ' → combined ' + after.litres.toFixed(1) + ' L / $' + after.cost.toFixed(2) + ' ✓'
    );
  } finally {
    var del = await supabase
      .from('fuel_records')
      .delete()
      .eq('id', synthId)
      .eq('user_id', ILS_USER_ID)
      .eq('supplier', TEST_SUPPLIER);
    if (del.error) throw new Error('cleanup synthetic fuel_records: ' + del.error.message);
    console.log('  cleaned up synthetic fuel_records row ' + synthId);
  }
}

async function testLiveDemoMachinery(supabase) {
  console.log('\n=== Live Demo machinery 1414 (ignore leftover fuel_records) ===');
  var asset = await supabase
    .from('assets')
    .select('*')
    .eq('user_id', DEMO_USER_ID)
    .eq('id', DEMO_EXCAVATOR_ID)
    .maybeSingle();
  if (asset.error) throw new Error(asset.error.message);
  assert.ok(asset.data, 'Demo asset 1414 exists');
  assert.ok(!FCM.isOnRoad(asset.data), 'asset 1414 is machinery');

  var settings = await supabase
    .from('user_settings')
    .select('machinery_fuel_cost_per_litre')
    .eq('user_id', DEMO_USER_ID)
    .maybeSingle();
  if (settings.error) throw new Error(settings.error.message);
  var cpl = settings.data && settings.data.machinery_fuel_cost_per_litre != null
    ? parseFloat(settings.data.machinery_fuel_cost_per_litre)
    : 1.52;

  var tel = await supabase
    .from('telematics_records')
    .select('asset_id, record_date, litres_consumed')
    .eq('user_id', DEMO_USER_ID)
    .eq('asset_id', DEMO_EXCAVATOR_ID);
  if (tel.error) throw new Error(tel.error.message);
  var telRows = tel.data || [];
  assert.ok(telRows.some(function(r) { return (parseFloat(r.litres_consumed) || 0) > 0; }),
    'asset 1414 has litres_consumed');

  var leftover = await supabase
    .from('fuel_records')
    .select('id, litres, total_cost')
    .eq('user_id', DEMO_USER_ID)
    .eq('asset_id', DEMO_EXCAVATOR_ID);
  if (leftover.error) throw new Error(leftover.error.message);
  var leftoverRows = leftover.data || [];
  console.log('  leftover fuel_records rows: ' + leftoverRows.length);

  var expected = FCM.machineryFuelFromTelematics(telRows, cpl);
  var actual = FCM.assetFuelTotals(asset.data, {
    telRows: telRows,
    machineryCpl: cpl,
    fuelRecordRows: leftoverRows
  });
  assert.strictEqual(actual.litres, expected.litres);
  assert.strictEqual(actual.cost, expected.cost);
  if (leftoverRows.length) {
    var leftoverLitres = leftoverRows.reduce(function(s, r) { return s + (parseFloat(r.litres) || 0); }, 0);
    assert.notStrictEqual(actual.litres, leftoverLitres);
    assert.ok(actual.litres !== expected.litres + leftoverLitres);
  }
  console.log(
    '  Hitachi ZX350: ' + actual.litres.toFixed(1) + ' L / $' + actual.cost.toFixed(2) +
    ' from litres_consumed only (ignored ' + leftoverRows.length + ' fuel_records) ✓'
  );
}

async function main() {
  testLocalModel();

  var supabase = createClientFromEnv();
  await testLiveIlsTruck(supabase);
  await testLiveDemoMachinery(supabase);

  console.log('\n=== VisionLink litres_consumed resolution (job-cost apportionment check) ===');
  await probeLitresResolution(supabase, ILS_USER_ID, 'ILS');
  await probeLitresResolution(supabase, MONRO_USER_ID, 'Monro');

  console.log('\nALL FUEL-SOURCE CONSOLIDATION TESTS PASSED');
}

main().catch(function(err) {
  console.error('\nFAIL: ' + err.message);
  process.exit(1);
});
