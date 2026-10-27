/**
 * Measured VisionLink idle burn rate.
 * Run: node scripts/test-visionlink-idle-rate.js
 *
 * Invented asset ids and figures only.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var idleRates = require('../parsers/visionlink-idle-rate');
var fuel = require('../parsers/visionlink-fuel');
var visionlink = require('../parsers/visionlink');
var FCM = require('../js/fleet-cost-model');

// Columns that exist on public.assets. is_on_road is not one of them:
// assets.html drops it when PostgREST reports the column missing.
// usage_profile and gvm_tonnes exist, but FCM.isOnRoad does not read them.
var ASSET_COLUMNS = {
  id: true,
  user_id: true,
  asset_name: true,
  asset_type: true,
  division_id: true,
  is_ignored: true,
  created_at: true,
  fuel_type: true,
  make: true,
  model: true,
  year: true,
  registration: true,
  bp_card_number: true,
  mobil_card_number: true,
  idle_burn_rate_lph: true,
  idle_rate_source: true,
  idle_anomaly_confirmed: true,
  current_value: true,
  estimated_end_of_life_value: true,
  estimated_annual_repair_cost: true,
  expected_life_hours: true,
  expected_life_km: true,
  service_cost_per_hour: true,
  service_cost_per_km: true,
  current_hours: true,
  current_odometer: true,
  estimated_annual_km: true,
  available_hours_per_week: true,
  target_utilisation_percent: true,
  gvm_tonnes: true,
  ruc_rate_per_km: true,
  usage_profile: true,
  visionlink_serial: true,
  telematics_provider: true,
  eroad_machine_id: true,
  travel_rate_lpk: true,
  travel_rate_r2: true,
  last_calibrated_at: true
};

var TELEMATICS_COLUMNS = {
  user_id: true,
  asset_id: true,
  record_date: true,
  operating_hours: true,
  idle_hours: true,
  total_engine_hours: true,
  litres_consumed: true,
  data_quality_notes: true,
  idle_fuel_litres: true,
  working_fuel_litres: true,
  daily_distance_km: true,
  odometer_km: true
};

function columnListFor(table) {
  if (table === 'assets') return ASSET_COLUMNS;
  if (table === 'telematics_records') return TELEMATICS_COLUMNS;
  return null;
}

function parseSelectList(selectArg) {
  var parts = String(selectArg == null ? '' : selectArg).split(',');
  var cols = [];
  parts.forEach(function(part) {
    var col = part.trim().split(/\s+/)[0];
    if (col) cols.push(col);
  });
  if (!cols.length || cols.indexOf('*') !== -1) {
    throw new Error('select must name real columns');
  }
  return cols;
}

function assertKnownColumns(table, columns) {
  var allowed = columnListFor(table);
  if (!allowed) throw new Error('no column list for ' + table);
  (columns || []).forEach(function(col) {
    if (!allowed[col]) throw new Error('unknown ' + table + ' column: ' + col);
  });
}

function projectRow(row, columns) {
  var out = {};
  columns.forEach(function(col) {
    if (Object.prototype.hasOwnProperty.call(row, col)) out[col] = row[col];
  });
  return out;
}

var USER = '00000000-0000-4000-8000-0000000000aa';
var OTHER = '00000000-0000-4000-8000-0000000000bb';

function day(offset) {
  var d = new Date(Date.UTC(2025, 0, 1) + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

function rowsFor(assetId, spec) {
  return spec.map(function(r, i) {
    return {
      asset_id: assetId,
      user_id: r.user_id || USER,
      record_date: r.record_date || day(i + 1),
      idle_fuel_litres: r.litres,
      idle_hours: r.hours
    };
  });
}

function uniform(assetId, count, litres, hours, startOffset) {
  var spec = [];
  for (var i = 0; i < count; i++) {
    spec.push({
      record_date: day((startOffset || 0) + i),
      litres: litres,
      hours: hours
    });
  }
  return rowsFor(assetId, spec);
}

function createClient(assets, telematics, options) {
  options = options || {};
  var updates = [];
  var telQueries = [];
  var assetQueries = [];
  function applyEq(list, filters) {
    return list.filter(function(row) {
      for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        if (f.op !== 'eq') continue;
        if (String(row[f.col]) !== String(f.val)) return false;
      }
      return true;
    });
  }
  function from(table) {
    return {
      select: function(selectArg) {
        var columns = parseSelectList(selectArg);
        assertKnownColumns(table, columns);
        var filters = [];
        var order = null;
        var limitN = null;
        function useColumn(col) {
          assertKnownColumns(table, [col]);
        }
        var chain = {
          eq: function(col, val) {
            useColumn(col);
            filters.push({ op: 'eq', col: col, val: val });
            return chain;
          },
          not: function(col, op, val) {
            useColumn(col);
            filters.push({ op: 'not', col: col, notOp: op, val: val });
            return chain;
          },
          gt: function(col, val) {
            useColumn(col);
            filters.push({ op: 'gt', col: col, val: val });
            return chain;
          },
          order: function(col, opts) {
            useColumn(col);
            order = { col: col, ascending: !!(opts && opts.ascending) };
            return chain;
          },
          limit: function(n) {
            limitN = n;
            return chain;
          },
          then: function(resolve, reject) {
            return Promise.resolve(run()).then(resolve, reject);
          }
        };
        function run() {
          if (table === 'assets') {
            assetQueries.push({ filters: filters.slice(), columns: columns.slice() });
            var assetsFound = applyEq(assets, filters).map(function(row) {
              return projectRow(row, columns);
            });
            if (limitN != null) assetsFound = assetsFound.slice(0, limitN);
            return { data: assetsFound, error: null };
          }
          if (table === 'telematics_records') {
            telQueries.push({
              filters: filters.slice(),
              columns: columns.slice(),
              order: order,
              limit: limitN
            });
            var data = applyEq(telematics, filters).map(function(row) {
              return projectRow(row, columns);
            });
            if (order) {
              var col = order.col;
              var dir = order.ascending ? 1 : -1;
              data = data.slice().sort(function(a, b) {
                var av = String(a[col] || '');
                var bv = String(b[col] || '');
                if (av < bv) return -1 * dir;
                if (av > bv) return 1 * dir;
                return 0;
              });
            }
            if (limitN != null) data = data.slice(0, limitN);
            return { data: data, error: null };
          }
          return { data: [], error: null };
        }
        return chain;
      },
      update: function(payload) {
        assertKnownColumns(table, Object.keys(payload || {}));
        var filters = [];
        var chain = {
          eq: function(col, val) {
            assertKnownColumns(table, [col]);
            filters.push({ col: col, val: val });
            return chain;
          },
          then: function(resolve, reject) {
            var id = null;
            var userId = null;
            filters.forEach(function(f) {
              if (f.col === 'id') id = f.val;
              if (f.col === 'user_id') userId = f.val;
            });
            if (options.failIds && options.failIds[id]) {
              return Promise.resolve({ error: { message: 'db down' } }).then(resolve, reject);
            }
            updates.push({ payload: payload, id: id, userId: userId });
            assets.forEach(function(a) {
              if (Number(a.id) === Number(id) && String(a.user_id) === String(userId)) {
                Object.keys(payload).forEach(function(k) { a[k] = payload[k]; });
              }
            });
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
        };
        return chain;
      }
    };
  }
  return {
    supabase: { from: from },
    updates: updates,
    telQueries: telQueries,
    assetQueries: assetQueries
  };
}

function capture() {
  var logs = [];
  var warnings = [];
  var origLog = console.log;
  var origWarn = console.warn;
  console.log = function() {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
  };
  console.warn = function() {
    warnings.push(Array.prototype.slice.call(arguments).join(' '));
  };
  return {
    logs: logs,
    warnings: warnings,
    restore: function() {
      console.log = origLog;
      console.warn = origWarn;
    }
  };
}

function asset(id, extra) {
  var row = {
    id: id,
    user_id: USER,
    asset_name: 'DoNotLogThisName-' + id,
    asset_type: 'Excavator',
    is_on_road: false,
    idle_burn_rate_lph: null,
    idle_rate_source: null
  };
  if (extra) Object.keys(extra).forEach(function(k) { row[k] = extra[k]; });
  return row;
}

function assertNoName(cap, id) {
  var blob = cap.logs.concat(cap.warnings).join('\n');
  assert.ok(blob.indexOf('DoNotLogThisName-' + id) === -1, 'log leaked asset name');
}

function assertQueryShape(query, assetId) {
  assert.ok(query, 'expected a telematics query');
  assert.strictEqual(query.limit, 120);
  assert.ok(query.order && query.order.col === 'record_date' && query.order.ascending === false);
  function has(op, col) {
    return query.filters.some(function(f) { return f.op === op && f.col === col; });
  }
  assert.ok(has('eq', 'asset_id'));
  assert.ok(has('eq', 'user_id'));
  assert.ok(query.filters.some(function(f) {
    return f.op === 'not' && f.col === 'idle_fuel_litres' && f.notOp === 'is' && f.val === null;
  }));
  assert.ok(query.filters.some(function(f) {
    return f.op === 'not' && f.col === 'idle_hours' && f.notOp === 'is';
  }));
  assert.ok(query.filters.some(function(f) {
    return f.op === 'gt' && f.col === 'idle_hours' && f.val === 0;
  }));
  assert.ok(query.filters.some(function(f) {
    return f.op === 'eq' && f.col === 'asset_id' && Number(f.val) === Number(assetId);
  }));
  assert.ok(query.filters.some(function(f) {
    return f.op === 'eq' && f.col === 'user_id' && f.val === USER;
  }));
}

async function runCase(assets, rows) {
  var client = createClient(assets, rows);
  var cap = capture();
  var thrown = null;
  try {
    await idleRates.recomputeMeasuredIdleRates(client.supabase, USER, assets.map(function(a) { return a.id; }));
  } catch (err) {
    thrown = err;
  } finally {
    cap.restore();
  }
  return { client: client, cap: cap, thrown: thrown };
}

async function testWeighted() {
  var id = 101;
  var rows = rowsFor(id, [
    { litres: 10, hours: 1, record_date: day(10) },
    { litres: 10, hours: 1, record_date: day(11) },
    { litres: 2, hours: 4, record_date: day(12) }
  ]);
  var out = await runCase([asset(id)], rows);
  assert.strictEqual(out.thrown, null);
  assert.strictEqual(out.client.updates.length, 1);
  assert.strictEqual(out.client.updates[0].payload.idle_burn_rate_lph, 3.67);
  assert.strictEqual(out.client.updates[0].payload.idle_rate_source, 'measured');
  assert.strictEqual(out.client.updates[0].userId, USER);
  assert.strictEqual(Number(out.client.updates[0].id), id);
  assert.deepStrictEqual(out.client.assetQueries[0].columns, [
    'id', 'asset_type', 'idle_burn_rate_lph', 'idle_rate_source'
  ]);
  assert.deepStrictEqual(out.client.telQueries[0].columns, [
    'record_date', 'idle_fuel_litres', 'idle_hours'
  ]);
  assert.deepStrictEqual(Object.keys(out.client.updates[0].payload).sort(), [
    'idle_burn_rate_lph', 'idle_rate_source'
  ]);
  assertQueryShape(out.client.telQueries[0], id);
  assertNoName(out.cap, id);
  console.log('✓ weighted SUM/SUM is 3.67, not the average of daily ratios');
}

async function testTooFewDays() {
  var id = 102;
  var rows = rowsFor(id, [
    { litres: 8, hours: 2, record_date: day(1) },
    { litres: 8, hours: 2, record_date: day(2) }
  ]);
  var out = await runCase([asset(id)], rows);
  assert.strictEqual(out.client.updates.length, 0);
  assert.ok(out.cap.logs.some(function(line) {
    return line.indexOf('not enough measured idle data yet') !== -1 && line.indexOf(String(id)) !== -1;
  }));
  assertNoName(out.cap, id);
  console.log('✓ fewer than 3 days does not write');
}

async function testTooFewHours() {
  var id = 103;
  var rows = rowsFor(id, [
    { litres: 1, hours: 0.5, record_date: day(1) },
    { litres: 1, hours: 0.5, record_date: day(2) },
    { litres: 1, hours: 0.5, record_date: day(3) }
  ]);
  var out = await runCase([asset(id)], rows);
  assert.strictEqual(out.client.updates.length, 0);
  assert.ok(out.cap.logs.some(function(line) {
    return line.indexOf('not enough measured idle data yet') !== -1 && line.indexOf(String(id)) !== -1;
  }));
  assertNoName(out.cap, id);
  console.log('✓ idle hours below 3 do not write');
}

async function testImplausible() {
  var high = 104;
  var low = 105;
  var rows = uniform(high, 3, 40, 1, 20).concat(uniform(low, 3, 0.2, 1, 20));
  var out = await runCase([asset(high), asset(low)], rows);
  assert.strictEqual(out.client.updates.length, 0);
  assert.ok(out.cap.warnings.some(function(line) {
    return line.indexOf(String(high)) !== -1 && line.indexOf('40') !== -1;
  }));
  assert.ok(out.cap.warnings.some(function(line) {
    return line.indexOf(String(low)) !== -1 && line.indexOf('0.2') !== -1;
  }));
  assertNoName(out.cap, high);
  assertNoName(out.cap, low);
  console.log('✓ implausible rates do not write');
}

async function testBoundsInclusive() {
  var low = 106;
  var high = 107;
  var rows = uniform(low, 3, 0.5, 1, 30).concat(uniform(high, 3, 25, 1, 30));
  var out = await runCase([asset(low), asset(high)], rows);
  assert.strictEqual(out.client.updates.length, 2);
  var byId = {};
  out.client.updates.forEach(function(u) { byId[u.id] = u.payload.idle_burn_rate_lph; });
  assert.strictEqual(byId[low], 0.5);
  assert.strictEqual(byId[high], 25);
  console.log('✓ 0.5 and 25 L/h are accepted');
}

async function testProtectedSources() {
  var setId = 108;
  var calId = 109;
  var rows = uniform(setId, 4, 6, 1, 40).concat(uniform(calId, 4, 6, 1, 40));
  var out = await runCase([
    asset(setId, { idle_rate_source: ' Set ', idle_burn_rate_lph: 2.2 }),
    asset(calId, { idle_rate_source: 'CALIBRATED', idle_burn_rate_lph: 3.1 })
  ], rows);
  assert.strictEqual(out.client.updates.length, 0);
  assert.strictEqual(out.client.telQueries.length, 0);
  console.log('✓ owner set and calibrated rates are not overwritten');
}

async function testTrucksSkipped() {
  var types = [
    ['Light Vehicle', 110],
    ['Rigid Truck', 111],
    ['Semi Trailer', 112],
    ['Truck & Trailer', 113],
    ['Truck and Trailer / B-Train', 114]
  ];
  var excavator = 115;
  var dump = 116;
  var assets = types.map(function(pair) {
    return asset(pair[1], { asset_type: pair[0] });
  });
  // The fixture may carry is_on_road, but that column is not selected or stored.
  assets.push(asset(excavator, { asset_type: 'Excavator', is_on_road: true }));
  assets.push(asset(dump, { asset_type: 'Dump Truck' }));
  var rows = [];
  assets.forEach(function(a) {
    rows = rows.concat(uniform(a.id, 4, 6, 1, 50));
  });
  var out = await runCase(assets, rows);
  var updated = out.client.updates.map(function(u) { return Number(u.id); });
  updated.sort(function(a, b) { return a - b; });
  assert.deepStrictEqual(updated, [excavator, dump]);
  assert.strictEqual(out.client.telQueries.length, 2);
  out.client.updates.forEach(function(u) {
    assert.strictEqual(u.payload.idle_burn_rate_lph, 6);
  });
  console.log('✓ on-road types are skipped from asset_type alone');
}

function testIsOnRoadFromAssetType() {
  ['Light Vehicle', 'Rigid Truck', 'Semi Trailer', 'Truck & Trailer', 'Truck and Trailer / B-Train'].forEach(function(t) {
    assert.strictEqual(FCM.isOnRoad({ asset_type: t }), true, t);
    assert.strictEqual(FCM.isOnRoad({ asset_type: '  ' + t + ' ' }), true, t);
  });
  assert.strictEqual(FCM.isOnRoad({ asset_type: 'Excavator' }), false);
  assert.strictEqual(FCM.isOnRoad({ asset_type: 'Dump Truck' }), false);
  console.log('✓ FCM.isOnRoad recognises trucks from asset_type alone');
}

function testSchemaColumnLists() {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ASSET_COLUMNS, 'is_on_road'), false);
  assert.throws(function() {
    assertKnownColumns('assets', ['id', 'is_on_road']);
  }, /unknown assets column: is_on_road/);
  assert.throws(function() {
    assertKnownColumns('telematics_records', ['record_date', 'not_a_column']);
  }, /unknown telematics_records column: not_a_column/);
  assertKnownColumns('assets', ['id', 'asset_type', 'idle_burn_rate_lph', 'idle_rate_source']);
  assertKnownColumns('telematics_records', ['record_date', 'idle_fuel_litres', 'idle_hours', 'user_id', 'asset_id']);

  var src = fs.readFileSync(path.join(__dirname, '../parsers/visionlink-idle-rate.js'), 'utf8');
  var selects = 0;
  var selectRe = /\.from\(\s*'([^']+)'\s*\)[\s\S]*?\.select\(\s*'([^']*)'\s*\)/g;
  var m;
  while ((m = selectRe.exec(src))) {
    selects++;
    assertKnownColumns(m[1], parseSelectList(m[2]));
  }
  assert.strictEqual(selects, 2);

  var updates = 0;
  var updateRe = /\.from\(\s*'([^']+)'\s*\)[\s\S]*?\.update\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = updateRe.exec(src))) {
    updates++;
    var keys = [];
    var keyRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
    var km;
    while ((km = keyRe.exec(m[2]))) keys.push(km[1]);
    assert.deepStrictEqual(keys, ['idle_burn_rate_lph', 'idle_rate_source']);
    assertKnownColumns(m[1], keys);
  }
  assert.strictEqual(updates, 1);

  var table = null;
  var filters = 0;
  var callRe = /\.(from|eq|not|gt|order)\(\s*'([^']+)'/g;
  while ((m = callRe.exec(src))) {
    if (m[1] === 'from') {
      table = m[2];
      assert.ok(columnListFor(table), 'query on unlisted table ' + table);
      continue;
    }
    assert.ok(table, 'filter before from()');
    assertKnownColumns(table, [m[2]]);
    filters++;
  }
  assert.ok(filters >= 8, 'expected asset and telematics filters, saw ' + filters);
  console.log('✓ helper queries only name real assets and telematics columns');
}

async function testMockRejectsUnknownColumns() {
  var client = createClient([asset(1)], []);
  var selectErr = null;
  try {
    await client.supabase.from('assets').select('id, is_on_road').limit(1);
  } catch (err) {
    selectErr = err;
  }
  assert.ok(selectErr && selectErr.message.indexOf('unknown assets column: is_on_road') !== -1);

  var telErr = null;
  try {
    await client.supabase.from('telematics_records').select('record_date, not_a_column').limit(1);
  } catch (err) {
    telErr = err;
  }
  assert.ok(telErr && telErr.message.indexOf('unknown telematics_records column: not_a_column') !== -1);

  var updateErr = null;
  try {
    await client.supabase.from('assets').update({ is_on_road: true }).eq('id', 1);
  } catch (err) {
    updateErr = err;
  }
  assert.ok(updateErr && updateErr.message.indexOf('unknown assets column: is_on_road') !== -1);
  console.log('✓ mock database rejects unknown columns in select and update');
}

async function testMeasuredUpdateAndSkip() {
  var id = 113;
  var rows = rowsFor(id, [
    { litres: 10, hours: 1, record_date: day(1) },
    { litres: 10, hours: 1, record_date: day(2) },
    { litres: 2, hours: 4, record_date: day(3) }
  ]);
  var same = await runCase([
    asset(id, { idle_burn_rate_lph: 3.67, idle_rate_source: 'Measured' })
  ], rows);
  assert.strictEqual(same.client.updates.length, 0);

  var changedRows = rows.concat(rowsFor(id, [
    { litres: 8, hours: 2, record_date: day(4) }
  ]));
  var changed = await runCase([
    asset(id, { idle_burn_rate_lph: 3.67, idle_rate_source: 'measured' })
  ], changedRows);
  assert.strictEqual(changed.client.updates.length, 1);
  assert.strictEqual(changed.client.updates[0].payload.idle_burn_rate_lph, 3.75);
  assert.strictEqual(changed.client.updates[0].payload.idle_rate_source, 'measured');
  console.log('✓ identical measured value is skipped and a changed value is updated');
}

async function testIgnoredRowsAndWindow() {
  var id = 114;
  var good = uniform(id, 120, 4, 1, 20);
  var ancient = uniform(id, 10, 100, 1, 0);
  var junk = rowsFor(id, [
    { litres: null, hours: 100, record_date: day(200) },
    { litres: 10000, hours: 0, record_date: day(201) },
    { litres: 9, hours: 1, record_date: day(202), user_id: OTHER }
  ]);
  var out = await runCase([asset(id)], ancient.concat(good).concat(junk));
  assert.strictEqual(out.client.updates.length, 1);
  assert.strictEqual(out.client.updates[0].payload.idle_burn_rate_lph, 4);
  assertQueryShape(out.client.telQueries[0], id);
  assertNoName(out.cap, id);
  console.log('✓ null litres, zero hours, other users, and days older than 120 are ignored');
}

async function testOneFailureDoesNotStopTheNext() {
  var bad = 115;
  var good = 116;
  var rows = uniform(bad, 4, 5, 1, 10).concat(uniform(good, 4, 7, 1, 10));
  var client = createClient(
    [asset(bad), asset(good)],
    rows,
    { failIds: { 115: true } }
  );
  var cap = capture();
  var thrown = null;
  try {
    await idleRates.recomputeMeasuredIdleRates(client.supabase, USER, [bad, good]);
  } catch (err) {
    thrown = err;
  } finally {
    cap.restore();
  }
  assert.strictEqual(thrown, null);
  assert.strictEqual(client.updates.length, 1);
  assert.strictEqual(Number(client.updates[0].id), good);
  assert.strictEqual(client.updates[0].payload.idle_burn_rate_lph, 7);
  assert.ok(cap.warnings.some(function(line) {
    return line.indexOf(String(bad)) !== -1 && line.indexOf('db down') !== -1;
  }));
  console.log('✓ a failing update does not stop the next asset');
}

function loadIdleRateSourceForSave() {
  var html = fs.readFileSync(path.join(__dirname, '../assets.html'), 'utf8');
  var start = html.indexOf('function idleRateSourceForSave(');
  assert.ok(start > 0, 'idleRateSourceForSave missing from assets.html');
  var end = html.indexOf('\n  function ', start + 10);
  assert.ok(end > start);
  var src = html.slice(start, end);
  return new Function(src + '\nreturn idleRateSourceForSave;')();
}

function testPayloadRule() {
  var decide = loadIdleRateSourceForSave();
  assert.strictEqual(decide(4.5, 'measured', 4.5), 'measured');
  assert.strictEqual(decide(4.5, 'measured', '4.50'), 'measured');
  assert.strictEqual(decide(4.5, ' Measured ', 4.5), 'measured');
  assert.strictEqual(decide(4.5, 'measured', 5), 'set');
  assert.strictEqual(decide(4.5, 'measured', ''), null);
  assert.strictEqual(decide(4.5, 'measured', null), null);
  assert.strictEqual(decide(4.5, 'calibrated', 4.5), undefined);
  assert.strictEqual(decide(4.5, 'CALIBRATED', 4.5), undefined);
  assert.strictEqual(decide(4.5, 'set', 4.5), undefined);
  assert.strictEqual(decide(4.5, 'calibrated', 6), 'set');
  assert.strictEqual(decide(4.5, 'set', ''), null);
  assert.strictEqual(decide(null, null, 4), 'set');
  assert.strictEqual(decide(4.5, '', 4.5), undefined);
  var html = fs.readFileSync(path.join(__dirname, '../assets.html'), 'utf8');
  assert.ok(html.indexOf('idleRateSourceForSave(') !== -1);
  assert.ok(html.indexOf("field === 'idle_burn_rate_lph'") !== -1);
  console.log('✓ assets payload keeps measured when unchanged, sets set when changed, null when cleared');
}

function parserMock(assets) {
  var importUpdates = [];
  function from(table) {
    return {
      select: function() {
        var chain = {
          eq: function() { return chain; },
          in: function() { return chain; },
          order: function() { return chain; },
          limit: function() { return chain; },
          then: function(resolve) {
            var data = [];
            if (table === 'assets') data = assets;
            resolve({ data: data, error: null });
          }
        };
        return chain;
      },
      upsert: function() {
        return Promise.resolve({ error: null });
      },
      update: function(payload) {
        var chain = {
          eq: function() { return chain; },
          then: function(resolve) {
            if (table === 'email_imports') importUpdates.push(payload);
            resolve({ error: null });
          }
        };
        return chain;
      }
    };
  }
  return { supabase: { from: from }, importUpdates: importUpdates };
}

var FUEL_HEADER = [
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
  'Working Time %'
].join(',');

var FUEL_CSV = [
  'Fleet Fuel Report',
  'Report Date Range',
  '27/10/2026 00:00 - 27/10/2026 23:59',
  FUEL_HEADER,
  'EQ000001,AAA00001,2017,CAT,558GF,Forestry Excavator,5.2,1.2,4.5,357.2,9.9,35.9,362.5,11.1,32.7,89.6%'
].join('\n');

var UTIL_CSV = [
  'Callouts,Asset ID,Asset Serial Number,Make,Model,Hour Meter (Hours),Hour Meter Last Reported Time,Latest Utilization Report,Timezone Offset,Time Zone,Timezone Display Name,Runtime (Hours),Idle Time (Hours),Working Time (Hours),Idle %,Total Fuel Burned (L)',
  ',EQ000001,AAA00001,CAT,538LL,8000.1000,2026-10-27T10:43:58Z,2026-10-27T10:43:58Z,+13:00,Pacific/Auckland,NZDT,9.5,1.2,8.3,12.6,200.5'
].join('\n');

async function testParsersStayProcessedWhenHelperThrows() {
  var original = idleRates.recomputeMeasuredIdleRates;
  var calls = 0;
  idleRates.recomputeMeasuredIdleRates = function() {
    calls++;
    throw new Error('idle rate boom');
  };
  var assets = [{
    id: 201,
    asset_name: 'Cat 558 (EQ000001)',
    visionlink_serial: 'AAA00001',
    current_hours: 1,
    asset_type: 'Excavator'
  }];
  try {
    var fuelMock = parserMock(assets);
    var fuelResult = await fuel.parseVisionLinkFuelReport(fuelMock.supabase, {
      userId: USER,
      importId: 'imp-fuel-idle',
      rawCsv: FUEL_CSV,
      filename: 'Fleet Fuel invented.csv',
      receivedAt: '2026-10-27T20:00:00Z'
    });
    assert.strictEqual(fuelResult.ok, true);
    assert.ok(fuelResult.recordsUpserted > 0);
    assert.ok(fuelMock.importUpdates.some(function(p) { return p.status === 'processed'; }));
    assert.ok(!fuelMock.importUpdates.some(function(p) { return p.status === 'failed'; }));

    var utilMock = parserMock(assets);
    var utilResult = await visionlink.parseVisionLinkReport(utilMock.supabase, {
      userId: USER,
      importId: 'imp-util-idle',
      rawCsv: UTIL_CSV,
      filename: 'Fleet_Utilization_27-10-2026_27-10-2026_27-10-2026.csv',
      receivedAt: '2026-10-27T20:00:00Z'
    });
    assert.strictEqual(utilResult.ok, true);
    assert.ok(utilResult.recordsUpserted > 0);
    assert.ok(utilMock.importUpdates.some(function(p) { return p.status === 'processed'; }));
    assert.ok(!utilMock.importUpdates.some(function(p) { return p.status === 'failed'; }));
    assert.ok(calls >= 2);
  } finally {
    idleRates.recomputeMeasuredIdleRates = original;
  }
  console.log('✓ fuel and utilization imports stay processed when the helper throws');
}

async function main() {
  await testWeighted();
  await testTooFewDays();
  await testTooFewHours();
  await testImplausible();
  await testBoundsInclusive();
  await testProtectedSources();
  testIsOnRoadFromAssetType();
  testSchemaColumnLists();
  await testMockRejectsUnknownColumns();
  await testTrucksSkipped();
  await testMeasuredUpdateAndSkip();
  await testIgnoredRowsAndWindow();
  await testOneFailureDoesNotStopTheNext();
  testPayloadRule();
  await testParsersStayProcessedWhenHelperThrows();
  console.log('ALL VISIONLINK IDLE RATE TESTS PASSED');
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
