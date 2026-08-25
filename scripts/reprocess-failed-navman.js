/**
 * Find and reprocess failed Navman email_imports since a given date.
 *
 * Usage (with env vars set):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/reprocess-failed-navman.js [--since 2026-08-15] [--dry-run]
 *
 * --dry-run prints every candidate import, user_id, parsed records that
 * would be upserted, asset match status (including Default VehicleGroup),
 * and whether telematics_records already has a row for the same asset+date.
 * It does not write anything.
 */
var { createClient } = require('@supabase/supabase-js');
var { parseNavmanDate, parseNavmanDatetime, parseNumeric } = require('../parsers/parser-utils');
var { isNavmanMileageCsv, parseNavmanMileageRows } = require('../parsers/navman-mileage');
var { isNavmanIdleCsv, parseNavmanIdleRows } = require('../parsers/navman-idle');

var DEFAULT_GROUP_VEHICLES = ['T12 Tipper', 'T13 Crane Truck', 'T16 Bucket', 'T17', 'T19 Fault Vehicle', 'T5 Iveco', 'T6'];
var ILS_USER_ID = 'd2ed89c3-dcaf-48b3-826a-f73802e4cf74';

function parseArgs() {
  var since = '2026-08-15';
  var dryRun = false;
  process.argv.slice(2).forEach(function(arg, i, arr) {
    if (arg === '--since') since = arr[i + 1];
    if (arg === '--dry-run') dryRun = true;
  });
  return { since: since, dryRun: dryRun };
}

function buildMileagePreview(rows, assetMap) {
  var dailyMap = {};
  var unmatched = [];
  rows.forEach(function(row) {
    var vehicleName = String(row.Vehicle || '').trim();
    var dateStr = parseNavmanDate(row.ActivityDate);
    var distance = parseNumeric(row.ActualDistance);
    if (!vehicleName || !dateStr || distance === null) return;
    var asset = assetMap[vehicleName];
    if (!asset) {
      unmatched.push({ vehicle: vehicleName, group: row.VehicleGroup, date: dateStr, distance: distance });
      return;
    }
    var key = asset.id + '|' + dateStr;
    if (!dailyMap[key]) {
      dailyMap[key] = {
        asset_id: Number(asset.id),
        asset_name: vehicleName,
        vehicle_group: row.VehicleGroup || '',
        record_date: dateStr,
        distances: [],
      };
    }
    dailyMap[key].distances.push(distance);
  });
  var records = Object.keys(dailyMap).map(function(k) {
    var e = dailyMap[k];
    return {
      asset_id: e.asset_id,
      asset_name: e.asset_name,
      vehicle_group: e.vehicle_group,
      record_date: e.record_date,
      daily_distance_km: Math.max.apply(null, e.distances),
    };
  }).filter(function(r) { return r.daily_distance_km > 0; });
  return { records: records, unmatched: unmatched };
}

function buildIdlePreview(rows, assetMap) {
  var dailyIdleMap = {};
  var unmatched = [];
  var events = [];
  rows.forEach(function(row) {
    var vehicleName = String(row.Vehicle || '').trim();
    var startParsed = parseNavmanDatetime(row.IdleStart);
    var dateStr = startParsed ? startParsed.dateIso : parseNavmanDate(row.IdleStart);
    var duration = parseNumeric(row.Duration);
    var unit = String(row.Unit || '').trim().toLowerCase();
    if (!vehicleName || !dateStr || duration === null) return;
    if (unit && unit !== 'min') return;
    events.push({
      vehicle: vehicleName,
      group: row.VehicleGroup || '',
      idleStart: row.IdleStart,
      idleEnd: row.IdleEnd,
      duration_min: duration,
      record_date: dateStr,
    });
    var asset = assetMap[vehicleName];
    if (!asset) {
      unmatched.push({ vehicle: vehicleName, group: row.VehicleGroup, date: dateStr, duration: duration });
      return;
    }
    var key = asset.id + '|' + dateStr;
    if (!dailyIdleMap[key]) {
      dailyIdleMap[key] = {
        asset_id: Number(asset.id),
        asset_name: vehicleName,
        vehicle_group: row.VehicleGroup || '',
        record_date: dateStr,
        idleMinutes: 0,
      };
    }
    dailyIdleMap[key].idleMinutes += duration;
  });
  var records = Object.keys(dailyIdleMap).map(function(k) {
    var e = dailyIdleMap[k];
    return {
      asset_id: e.asset_id,
      asset_name: e.asset_name,
      vehicle_group: e.vehicle_group,
      record_date: e.record_date,
      idle_hours: e.idleMinutes / 60,
      idle_minutes: e.idleMinutes,
    };
  }).filter(function(r) { return r.idle_minutes > 0; });
  return { records: records, unmatched: unmatched, events: events };
}

async function loadAssetMap(supabase, userId) {
  var result = await supabase
    .from('assets')
    .select('id, asset_name')
    .eq('user_id', userId);
  if (result.error) throw result.error;
  var map = {};
  (result.data || []).forEach(function(a) {
    if (a.asset_name) map[a.asset_name] = a;
  });
  return map;
}

async function findExistingTelematics(supabase, records) {
  if (!records.length) return [];
  var assetIds = Array.from(new Set(records.map(function(r) { return r.asset_id; })));
  var dates = Array.from(new Set(records.map(function(r) { return r.record_date; })));
  var result = await supabase
    .from('telematics_records')
    .select('asset_id, record_date, daily_distance_km, idle_hours, odometer_km')
    .in('asset_id', assetIds)
    .in('record_date', dates);
  if (result.error) throw result.error;
  var existing = result.data || [];
  var byKey = {};
  existing.forEach(function(r) {
    byKey[r.asset_id + '|' + r.record_date] = r;
  });
  return records.map(function(r) {
    var hit = byKey[r.asset_id + '|' + r.record_date] || null;
    return { planned: r, existing: hit };
  });
}

async function main() {
  var args = parseArgs();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  var result = await supabase
    .from('email_imports')
    .select('id, user_id, filename, raw_csv, error_message, received_at, status')
    .eq('status', 'failed')
    .gte('received_at', args.since + 'T00:00:00Z')
    .order('received_at', { ascending: true });

  if (result.error) throw result.error;

  var candidates = (result.data || []).filter(function(row) {
    var csv = row.raw_csv || '';
    if (csv.indexOf('BASE64_XLS:') === 0) return false;
    return isNavmanMileageCsv(csv) || isNavmanIdleCsv(csv);
  });

  console.log('Found', candidates.length, 'failed Navman imports since', args.since);
  console.log('Mode:', args.dryRun ? 'DRY-RUN (no writes)' : 'LIVE REPROCESS');
  console.log('');

  if (!candidates.length) return;

  var assetCache = {};
  var defaultGroupSummary = [];
  var dateIssues = [];
  var existingHits = [];

  for (var i = 0; i < candidates.length; i++) {
    var row = candidates[i];
    var kind = isNavmanMileageCsv(row.raw_csv) ? 'mileage' : 'idle';
    if (!assetCache[row.user_id]) {
      assetCache[row.user_id] = await loadAssetMap(supabase, row.user_id);
    }
    var assetMap = assetCache[row.user_id];

    console.log('────────────────────────────────────────────────────────────');
    console.log('#' + (i + 1), kind.toUpperCase(), '| import', row.id);
    console.log('  received_at:', row.received_at);
    console.log('  filename:   ', row.filename);
    console.log('  user_id:    ', row.user_id,
      row.user_id === ILS_USER_ID ? '(ILS / directors fleet)' : '(OTHER ACCOUNT)');
    console.log('  error:      ', row.error_message);

    var preview;
    if (kind === 'mileage') {
      preview = buildMileagePreview(parseNavmanMileageRows(row.raw_csv), assetMap);
      console.log('  planned upserts (' + preview.records.length + '):');
      preview.records.forEach(function(r) {
        console.log(
          '    asset_id=' + r.asset_id,
          '|', r.asset_name,
          '| group=' + JSON.stringify(r.vehicle_group),
          '| date=' + r.record_date,
          '| daily_distance_km=' + r.daily_distance_km
        );
        if (r.record_date !== '2026-08-25' && String(r.record_date).indexOf('2026-08-') === 0) {
          // only flag Aug samples that aren't the 25th when that's what's expected;
          // still record any non-25th for review when ActivityDate was 8-25-2026
        }
        if (r.record_date !== '2026-08-25') {
          dateIssues.push({ importId: row.id, kind: kind, asset: r.asset_name, date: r.record_date });
        }
      });
    } else {
      preview = buildIdlePreview(parseNavmanIdleRows(row.raw_csv), assetMap);
      console.log('  idle events:');
      preview.events.forEach(function(e) {
        console.log(
          '    ', e.vehicle,
          '| group=' + JSON.stringify(e.group),
          '|', e.idleStart, '→', e.idleEnd,
          '| duration=' + e.duration_min + 'min',
          '| date=' + e.record_date
        );
      });
      console.log('  planned upserts (' + preview.records.length + '):');
      preview.records.forEach(function(r) {
        console.log(
          '    asset_id=' + r.asset_id,
          '|', r.asset_name,
          '| group=' + JSON.stringify(r.vehicle_group),
          '| date=' + r.record_date,
          '| idle_hours=' + r.idle_hours,
          '(' + r.idle_minutes + ' min)'
        );
        if (r.record_date !== '2026-08-25') {
          dateIssues.push({ importId: row.id, kind: kind, asset: r.asset_name, date: r.record_date });
        }
      });
    }

    if (preview.unmatched.length) {
      console.log('  UNMATCHED vehicles (' + preview.unmatched.length + '):');
      preview.unmatched.forEach(function(u) {
        console.log('    ', u.vehicle, '| group=' + JSON.stringify(u.group), '| date=' + u.date);
      });
    }

    // Default VehicleGroup focus vehicles
    preview.records.forEach(function(r) {
      var isDefaultGroup = String(r.vehicle_group).trim() === 'Default';
      var isWatchVehicle = DEFAULT_GROUP_VEHICLES.some(function(name) {
        return r.asset_name === name || r.asset_name.indexOf(name.split(' ')[0]) === 0;
      });
      if (isDefaultGroup || isWatchVehicle) {
        defaultGroupSummary.push({
          importId: row.id,
          kind: kind,
          user_id: row.user_id,
          asset_id: r.asset_id,
          asset_name: r.asset_name,
          vehicle_group: r.vehicle_group,
          record_date: r.record_date,
          value: r.daily_distance_km != null ? r.daily_distance_km + ' km' : r.idle_minutes + ' min',
        });
      }
    });

    var overlap = await findExistingTelematics(supabase, preview.records);
    var hits = overlap.filter(function(o) { return o.existing; });
    if (hits.length) {
      console.log('  EXISTING telematics_records for same asset+date (' + hits.length + '):');
      hits.forEach(function(h) {
        console.log(
          '    asset_id=' + h.planned.asset_id,
          h.planned.asset_name,
          h.planned.record_date,
          '| existing daily_distance_km=' + h.existing.daily_distance_km,
          'idle_hours=' + h.existing.idle_hours,
          'odometer_km=' + h.existing.odometer_km,
          '| would UPSERT (onConflict asset_id,record_date) — merges, does not insert a second row'
        );
        existingHits.push({
          importId: row.id,
          asset_id: h.planned.asset_id,
          asset_name: h.planned.asset_name,
          record_date: h.planned.record_date,
          existing: h.existing,
        });
      });
    } else {
      console.log('  existing telematics overlap: none');
    }
    console.log('');
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('  imports:', candidates.length);
  console.log('  Default/watch-vehicle planned matches:');
  if (!defaultGroupSummary.length) {
    console.log('    (none found in these imports)');
  } else {
    defaultGroupSummary.forEach(function(d) {
      var ilsOk = d.user_id === ILS_USER_ID ? 'YES under ILS user' : 'WARNING: not ILS user ' + d.user_id;
      console.log(
        '   ', d.asset_name,
        '| group=' + JSON.stringify(d.vehicle_group),
        '| user_id=' + d.user_id,
        '|', ilsOk,
        '|', d.record_date,
        '|', d.value
      );
    });
  }
  console.log('  dates other than 2026-08-25:', dateIssues.length ? JSON.stringify(dateIssues) : 'none (all 2026-08-25 or outside Aug-25 samples)');
  console.log('  existing asset+date overlaps:', existingHits.length,
    existingHits.length ? '(upsert will merge — no duplicate rows)' : '');

  if (args.dryRun) {
    console.log('\nDry-run complete. No writes performed.');
    return;
  }

  // Live reprocess
  var { parseNavmanMileageReport } = require('../parsers/navman-mileage');
  var { parseNavmanIdleReport } = require('../parsers/navman-idle');
  var ok = 0;
  var fail = 0;
  for (var j = 0; j < candidates.length; j++) {
    var live = candidates[j];
    var liveKind = isNavmanMileageCsv(live.raw_csv) ? 'mileage' : 'idle';
    process.stdout.write('Reprocessing ' + live.id + ' (' + liveKind + ')... ');
    try {
      if (liveKind === 'mileage') {
        await parseNavmanMileageReport(supabase, {
          userId: live.user_id,
          importId: live.id,
          rawCsv: live.raw_csv,
        });
      } else {
        await parseNavmanIdleReport(supabase, {
          userId: live.user_id,
          importId: live.id,
          rawCsv: live.raw_csv,
        });
      }
      console.log('OK → email_imports.status set to processed');
      ok++;
    } catch (err) {
      console.log('FAIL:', err.message);
      fail++;
    }
  }
  console.log('Done. ok=' + ok + ' fail=' + fail);
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
