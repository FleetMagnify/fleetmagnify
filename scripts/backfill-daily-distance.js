/**
 * One-off backfill: fill telematics_records.daily_distance_km from odometer
 * deltas when the Navman mileage report was missing.
 *
 * For every row with daily_distance_km null and odometer_km not null,
 * set daily_distance_km to (this odometer − same asset's most recent prior
 * valid odometer_km) in true date order. Rows with no prior odometer are
 * skipped and counted — never guessed.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/backfill-daily-distance.js --user-id <uuid> [--dry-run]
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/backfill-daily-distance.js --scan [--dry-run]
 *
 *   --scan        list every account that has the null-distance + odometer
 *                 gap, then (unless --dry-run) backfill each of them
 *   --user-id     backfill a single account
 *   --dry-run     plan and print, write nothing
 *   --verify      after a live run, re-pull T5 Iveco 5 Aug / T34 1 Aug /
 *                 T9 Bucket 31 Aug for the ILS account and print litres
 */
var { createClient } = require('@supabase/supabase-js');
var dist = require('../js/telematics-distance');

var ILS_USER_ID = 'd2ed89c3-dcaf-48b3-826a-f73802e4cf74';
var PAGE_SIZE = 1000;
var UPDATE_CHUNK = 200;

var VERIFY_EXAMPLES = [
  { name: /T5 Iveco/i, date: '2026-08-05', label: 'T5 Iveco' },
  { name: /T34 Civils/i, date: '2026-08-01', label: 'T34 Civils Truck' },
  { name: /T9 Bucket/i, date: '2026-08-31', label: 'T9 Bucket' }
];

function parseArgs() {
  var userId = null;
  var dryRun = false;
  var scan = false;
  var verify = false;
  process.argv.slice(2).forEach(function(arg, i, arr) {
    if (arg === '--user-id') userId = arr[i + 1];
    if (arg === '--dry-run') dryRun = true;
    if (arg === '--scan') scan = true;
    if (arg === '--verify') verify = true;
  });
  return { userId: userId, dryRun: dryRun, scan: scan, verify: verify };
}

async function fetchAll(build) {
  var rows = [];
  var from = 0;
  while (true) {
    var result = await build().range(from, from + PAGE_SIZE - 1);
    if (result.error) throw result.error;
    var batch = result.data || [];
    rows = rows.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function createSupabase() {
  var url = process.env.SUPABASE_URL || 'https://pddsgvuzvuwueuvpoytw.supabase.co';
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function loadProfileMap(supabase, userIds) {
  var map = {};
  if (!userIds.length) return map;
  for (var i = 0; i < userIds.length; i += 50) {
    var chunk = userIds.slice(i, i + 50);
    var result = await supabase.from('profiles').select('id, company_name').in('id', chunk);
    if (result.error) {
      console.warn('profiles lookup failed:', result.error.message);
      continue;
    }
    (result.data || []).forEach(function(p) {
      map[p.id] = p.company_name || '';
    });
  }
  return map;
}

async function scanGaps(supabase) {
  var rows = await fetchAll(function() {
    return supabase
      .from('telematics_records')
      .select('user_id, asset_id, record_date')
      .is('daily_distance_km', null)
      .not('odometer_km', 'is', null);
  });

  var byUser = {};
  rows.forEach(function(r) {
    var id = r.user_id;
    if (!byUser[id]) byUser[id] = { user_id: id, rows: 0, assets: {}, dates: {} };
    byUser[id].rows += 1;
    byUser[id].assets[r.asset_id] = true;
    var d = dist.dateKey(r.record_date);
    if (d) byUser[id].dates[d] = (byUser[id].dates[d] || 0) + 1;
  });

  var userIds = Object.keys(byUser);
  var profiles = await loadProfileMap(supabase, userIds);

  var accounts = userIds.map(function(id) {
    var e = byUser[id];
    var dates = Object.keys(e.dates).sort();
    return {
      user_id: id,
      company_name: profiles[id] || '',
      rows: e.rows,
      assets: Object.keys(e.assets).length,
      first_date: dates[0] || null,
      last_date: dates[dates.length - 1] || null
    };
  }).sort(function(a, b) { return b.rows - a.rows; });

  console.log('Accounts with daily_distance_km null and odometer_km present:');
  if (!accounts.length) {
    console.log('  (none)');
  } else {
    accounts.forEach(function(a) {
      var ils = a.user_id === ILS_USER_ID ? '  ← ILS' : '';
      var monro = /monro/i.test(a.company_name) ? '  ← MONRO' : '';
      console.log(
        '  ' + (a.company_name || '(no company_name)') +
        '  user_id=' + a.user_id +
        '  rows=' + a.rows +
        '  assets=' + a.assets +
        '  ' + a.first_date + ' → ' + a.last_date +
        ils + monro
      );
    });
  }
  return accounts;
}

async function loadRowsForUser(supabase, userId) {
  var needy = await fetchAll(function() {
    return supabase
      .from('telematics_records')
      .select('asset_id')
      .eq('user_id', userId)
      .is('daily_distance_km', null)
      .not('odometer_km', 'is', null);
  });
  var assetIds = Array.from(new Set(needy.map(function(r) { return r.asset_id; })));
  if (!assetIds.length) return [];

  var rows = [];
  for (var i = 0; i < assetIds.length; i += 50) {
    var chunk = assetIds.slice(i, i + 50);
    var batch = await fetchAll(function() {
      return supabase
        .from('telematics_records')
        .select('id, user_id, asset_id, record_date, daily_distance_km, odometer_km, idle_hours')
        .eq('user_id', userId)
        .in('asset_id', chunk);
    });
    rows = rows.concat(batch);
  }
  return rows;
}

async function applyUpdates(supabase, updates) {
  var ok = 0;
  var fail = 0;
  for (var i = 0; i < updates.length; i += UPDATE_CHUNK) {
    var chunk = updates.slice(i, i + UPDATE_CHUNK);
    for (var j = 0; j < chunk.length; j++) {
      var u = chunk[j];
      var q = supabase
        .from('telematics_records')
        .update({ daily_distance_km: u.daily_distance_km })
        .is('daily_distance_km', null);
      if (u.id != null) {
        q = q.eq('id', u.id);
      } else {
        q = q.eq('user_id', u.user_id).eq('asset_id', u.asset_id).eq('record_date', u.record_date);
      }
      var result = await q;
      if (result.error) {
        fail++;
        console.error('  update failed id=' + u.id + ' ' + result.error.message);
      } else {
        ok++;
      }
    }
    process.stdout.write('  wrote ' + Math.min(i + chunk.length, updates.length) + '/' + updates.length + '\r');
  }
  if (updates.length) process.stdout.write('\n');
  return { ok: ok, fail: fail };
}

function printPlan(plan, companyName) {
  console.log('Plan' + (companyName ? ' for ' + companyName : '') + ':');
  console.log('  updates:            ' + plan.updates.length);
  console.log('  skipped (no prior): ' + plan.skippedNoPrior.length);
  console.log('  skipped (negative): ' + plan.skippedNegative.length);
  if (plan.skippedNoPrior.length) {
    var byAsset = {};
    plan.skippedNoPrior.forEach(function(r) {
      byAsset[r.asset_id] = (byAsset[r.asset_id] || 0) + 1;
    });
    console.log('  no-prior assets:    ' + Object.keys(byAsset).length +
      ' (first odometer day for that asset — left null)');
  }
  var large = plan.updates.filter(function(u) { return u.daily_distance_km > 500; });
  if (large.length) {
    console.log('  warnings: ' + large.length + ' deltas > 500 km (still applied — actual odometer change):');
    large.slice(0, 10).forEach(function(u) {
      console.log(
        '    asset_id=' + u.asset_id,
        u.record_date,
        u.prior_odometer_km + ' → ' + u.odometer_km,
        '=' + u.daily_distance_km + ' km (prior ' + u.prior_date + ')'
      );
    });
  }
}

async function backfillUser(supabase, userId, dryRun, companyName) {
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('Backfill user_id=' + userId + (companyName ? ' (' + companyName + ')' : ''));
  console.log('Mode:', dryRun ? 'DRY-RUN (no writes)' : 'LIVE WRITE');

  var rows = await loadRowsForUser(supabase, userId);
  console.log('  loaded ' + rows.length + ' telematics rows for affected assets');
  var plan = dist.planDailyDistanceBackfill(rows);
  printPlan(plan, companyName);

  if (dryRun) {
    plan.updates.slice(0, 8).forEach(function(u) {
      console.log(
        '    would set',
        'asset_id=' + u.asset_id,
        u.record_date,
        'daily_distance_km=' + u.daily_distance_km,
        '(' + u.prior_odometer_km + ' → ' + u.odometer_km + ', prior ' + u.prior_date + ')'
      );
    });
    if (plan.updates.length > 8) console.log('    … ' + (plan.updates.length - 8) + ' more');
    return plan;
  }

  var result = await applyUpdates(supabase, plan.updates);
  console.log('  wrote ok=' + result.ok + ' fail=' + result.fail);
  plan.write = result;
  return plan;
}

async function verifyExamples(supabase, userId) {
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('Verify Orion examples against live telematics (ILS)');

  var assetsResult = await supabase
    .from('assets')
    .select('id, asset_name, travel_rate_lpk, idle_burn_rate_lph')
    .eq('user_id', userId);
  if (assetsResult.error) throw assetsResult.error;
  var assets = assetsResult.data || [];

  for (var i = 0; i < VERIFY_EXAMPLES.length; i++) {
    var ex = VERIFY_EXAMPLES[i];
    var asset = assets.filter(function(a) { return ex.name.test(a.asset_name || ''); })[0];
    if (!asset) {
      console.log('  ' + ex.label + ' ' + ex.date + ': ASSET NOT FOUND');
      continue;
    }
    var lookback = dist.addDaysIso(ex.date, -dist.LOOKBACK_DAYS);
    var tel = await supabase
      .from('telematics_records')
      .select('asset_id, record_date, daily_distance_km, idle_hours, odometer_km')
      .eq('user_id', userId)
      .eq('asset_id', asset.id)
      .gte('record_date', lookback)
      .lte('record_date', ex.date)
      .order('record_date', { ascending: true });
    if (tel.error) throw tel.error;
    var dl = dist.dailyLitres(asset, tel.data || [], ex.date);
    var today = (tel.data || []).filter(function(r) {
      return dist.dateKey(r.record_date) === ex.date;
    })[0];
    var prior = dist.findPriorOdometerRecord(tel.data || [], ex.date);
    console.log('  ' + asset.asset_name + '  ' + ex.date);
    console.log('    travel_rate_lpk=' + asset.travel_rate_lpk +
      '  idle_burn_rate_lph=' + asset.idle_burn_rate_lph);
    console.log('    today daily_distance_km=' + (today ? today.daily_distance_km : '(no row)') +
      '  odometer_km=' + (today ? today.odometer_km : '—') +
      '  idle_hours=' + (today ? today.idle_hours : '—'));
    console.log('    prior odometer_km=' + (prior ? prior.odometer_km : '(none)') +
      '  prior_date=' + (prior ? dist.dateKey(prior.record_date) : '—'));
    console.log('    dailyLitres hasData=' + dl.hasData +
      '  source=' + dl.distanceSource +
      '  km=' + dl.km +
      '  litres=' + (dl.hasData ? dist.round1(dl.litres) : 'null') +
      (dl.skipReason ? '  skip=' + dl.skipReason : ''));
    if (dl.hasData && dl.km > 0) {
      var idleL = dl.idleHours * dist.effectiveIdleRate(asset);
      var travelL = dl.km * dist.effectiveTravelRate(asset);
      console.log('    breakdown travel=' + dist.round1(travelL) + ' L  idle=' + dist.round1(idleL) + ' L');
    }
  }
}

async function main() {
  var args = parseArgs();
  if (!args.scan && !args.userId) {
    console.log('Usage: node scripts/backfill-daily-distance.js --user-id <uuid> [--dry-run] [--verify]');
    console.log('       node scripts/backfill-daily-distance.js --scan [--dry-run] [--verify]');
    process.exit(1);
  }

  var supabase = createSupabase();

  if (args.scan) {
    var accounts = await scanGaps(supabase);
    for (var i = 0; i < accounts.length; i++) {
      await backfillUser(supabase, accounts[i].user_id, args.dryRun, accounts[i].company_name);
    }
    if (args.verify) await verifyExamples(supabase, ILS_USER_ID);
    return;
  }

  var profiles = await loadProfileMap(supabase, [args.userId]);
  await backfillUser(supabase, args.userId, args.dryRun, profiles[args.userId] || '');
  if (args.verify) await verifyExamples(supabase, args.userId);
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
