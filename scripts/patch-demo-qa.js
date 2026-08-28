/**
 * Lightweight demo-account profile patches from the QA audit (FM-02, FM-08,
 * FM-12, FM-13, Priority 2, FM-19). Does not regenerate telematics/fuel
 * history — only asset profile fields and job created_at.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/patch-demo-qa.js
 *   node scripts/patch-demo-qa.js --dry-run
 */
var { createClient } = require('@supabase/supabase-js');

var DEMO_USER_ID = '023182a8-1563-46dd-a7c3-1430fbfad5df';

var PATCHES = [
  { match: /hitachi.*zx350|zx350.*excavator/i, idle_burn_rate_lph: 6.4, telematics_provider: 'VisionLink' },
  { match: /komatsu.*gd655|gd655.*grader/i, idle_burn_rate_lph: 5.2, telematics_provider: 'VisionLink', current_value: 215000 },
  { match: /caterpillar.*d8|d8.*bulldozer|d8t/i, idle_burn_rate_lph: 8.2, telematics_provider: 'VisionLink' },
  { match: /volvo.*a30g|a30g.*articulated|articulated dump/i, idle_burn_rate_lph: 6.0, telematics_provider: 'VisionLink' },
  { match: /caterpillar.*cs56|cs56.*compactor/i, idle_burn_rate_lph: 3.4, telematics_provider: 'VisionLink' },
  { match: /isuzu.*frr|frr.*tipper/i, idle_burn_rate_lph: null, telematics_provider: 'eRoad' },
  { match: /hino.*500|500.*tipper/i, idle_burn_rate_lph: null, telematics_provider: 'eRoad' },
  { match: /volvo.*fh|fh.*volvo/i, idle_burn_rate_lph: null, telematics_provider: 'eRoad' },
  { match: /kenworth/i, idle_burn_rate_lph: 3.0, telematics_provider: 'eRoad' },
  { match: /freightliner.*argosy|argosy.*low-?loader|transporter/i, idle_burn_rate_lph: 3.0, telematics_provider: 'eRoad', usage_profile: 'intermittent' }
];

async function probeColumn(supabase, table, col) {
  var result = await supabase.from(table).select(col).limit(0);
  return !result.error;
}

async function main() {
  var dryRun = process.argv.indexOf('--dry-run') !== -1;
  var url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or run --dry-run against no DB).');
    if (!dryRun) process.exit(1);
    console.log('Dry-run without credentials — listing intended patches only.');
    PATCHES.forEach(function(p) { console.log('  ', p); });
    return;
  }

  var supabase = createClient(url, key, { auth: { persistSession: false } });
  var assets = await supabase.from('assets').select('*').eq('user_id', DEMO_USER_ID).eq('is_ignored', false);
  if (assets.error) throw new Error(assets.error.message);

  var hasUsage = await probeColumn(supabase, 'assets', 'usage_profile');
  var hasRuc = await probeColumn(supabase, 'assets', 'ruc_rate_per_km');
  console.log('usage_profile column:', hasUsage ? 'yes' : 'no');
  console.log('ruc_rate_per_km column:', hasRuc ? 'yes' : 'no');

  var rows = assets.data || [];
  for (var i = 0; i < rows.length; i++) {
    var asset = rows[i];
    var spec = PATCHES.filter(function(p) { return p.match.test(asset.asset_name || ''); })[0];
    if (!spec) {
      console.log('  skip unmatched:', asset.asset_name);
      continue;
    }
    var patch = {
      idle_burn_rate_lph: spec.idle_burn_rate_lph,
      telematics_provider: spec.telematics_provider
    };
    if (spec.current_value != null) patch.current_value = spec.current_value;
    if (spec.usage_profile && hasUsage) patch.usage_profile = spec.usage_profile;
    if (spec.ruc_rate_per_km != null && hasRuc) patch.ruc_rate_per_km = spec.ruc_rate_per_km;
    console.log('  ' + (dryRun ? 'would patch' : 'patch') + ' ' + asset.asset_name, patch);
    if (!dryRun) {
      var upd = await supabase.from('assets').update(patch).eq('id', asset.id).eq('user_id', DEMO_USER_ID);
      if (upd.error) throw new Error(asset.asset_name + ': ' + upd.error.message);
    }
  }

  var jobs = await supabase.from('jobs').select('id, job_name, start_date, created_at').eq('user_id', DEMO_USER_ID);
  if (jobs.error) throw new Error(jobs.error.message);
  var jobRows = jobs.data || [];
  for (var j = 0; j < jobRows.length; j++) {
    var job = jobRows[j];
    if (!job.start_date) continue;
    var start = new Date(job.start_date + 'T00:00:00+12:00');
    start.setDate(start.getDate() - 4);
    var created = start.toISOString();
    console.log('  ' + (dryRun ? 'would backdate' : 'backdate') + ' job ' + job.job_name + ' created_at -> ' + created);
    if (!dryRun) {
      var jUpd = await supabase.from('jobs').update({ created_at: created }).eq('id', job.id).eq('user_id', DEMO_USER_ID);
      if (jUpd.error) console.log('    WARN created_at not writable:', jUpd.error.message);
    }
  }

  console.log(dryRun ? '\nDRY RUN complete.' : '\nDemo QA profile patches applied.');
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
