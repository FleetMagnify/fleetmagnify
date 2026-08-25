/**
 * Find and reprocess failed Navman email_imports since a given date.
 *
 * Usage (with env vars set):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/reprocess-failed-navman.js [--since 2026-08-15] [--dry-run]
 *
 * Selects failed rows whose raw_csv looks like Navman mileage/idle,
 * re-runs the fixed parsers, and updates email_imports status.
 */
var { createClient } = require('@supabase/supabase-js');
var { isNavmanMileageCsv, parseNavmanMileageReport } = require('../parsers/navman-mileage');
var { isNavmanIdleCsv, parseNavmanIdleReport } = require('../parsers/navman-idle');

async function main() {
  var since = '2026-08-15';
  var dryRun = false;
  process.argv.slice(2).forEach(function(arg, i, arr) {
    if (arg === '--since') since = arr[i + 1];
    if (arg === '--dry-run') dryRun = true;
  });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Same filter as the SQL query documented in the PR:
  //   status = 'failed'
  //   received_at >= since
  //   error_message mentions mileage/idle OR filename/raw looks like Navman
  var result = await supabase
    .from('email_imports')
    .select('id, user_id, filename, raw_csv, error_message, received_at, status')
    .eq('status', 'failed')
    .gte('received_at', since + 'T00:00:00Z')
    .order('received_at', { ascending: true });

  if (result.error) throw result.error;

  var candidates = (result.data || []).filter(function(row) {
    var csv = row.raw_csv || '';
    if (csv.indexOf('BASE64_XLS:') === 0) return false;
    return isNavmanMileageCsv(csv) || isNavmanIdleCsv(csv);
  });

  console.log('Found', candidates.length, 'failed Navman imports since', since);
  if (dryRun) {
    candidates.forEach(function(r) {
      var kind = isNavmanMileageCsv(r.raw_csv) ? 'mileage' : 'idle';
      console.log('-', r.id, r.received_at, kind, r.filename, '|', r.error_message);
    });
    return;
  }

  var ok = 0;
  var fail = 0;
  for (var i = 0; i < candidates.length; i++) {
    var row = candidates[i];
    var kind = isNavmanMileageCsv(row.raw_csv) ? 'mileage' : 'idle';
    process.stdout.write('Reprocessing ' + row.id + ' (' + kind + ')... ');
    try {
      if (kind === 'mileage') {
        await parseNavmanMileageReport(supabase, {
          userId: row.user_id,
          importId: row.id,
          rawCsv: row.raw_csv,
        });
      } else {
        await parseNavmanIdleReport(supabase, {
          userId: row.user_id,
          importId: row.id,
          rawCsv: row.raw_csv,
        });
      }
      console.log('OK');
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
