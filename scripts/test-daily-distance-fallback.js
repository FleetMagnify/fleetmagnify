/**
 * dailyLitres odometer-delta fallback + backfill planner.
 *
 *   node scripts/test-daily-distance-fallback.js
 */
var fs = require('fs');
var path = require('path');
var dist = require('../js/telematics-distance');

var pass = true;
function check(label, condition, detail) {
  var status = condition ? 'PASS' : 'FAIL';
  if (!condition) pass = false;
  console.log('[' + status + '] ' + label + (detail ? ' — ' + detail : ''));
}

var page = fs.readFileSync(path.join(__dirname, '..', 'orion-fuel-report.html'), 'utf8');

check(
  'Orion page loads the shared telematics-distance helper',
  /<script src="js\/telematics-distance\.js"><\/script>/.test(page)
);
check(
  'Orion page no longer defaults null daily_distance_km to zero km',
  !/today\.daily_distance_km != null \? Math\.max\(0, today\.daily_distance_km\) : 0/.test(page)
);
check(
  'Orion telematics select includes odometer_km',
  /select\('asset_id, record_date, daily_distance_km, idle_hours, odometer_km'\)/.test(page)
);
check(
  'Orion loadTelematics looks back before the report min date',
  /LOOKBACK_DAYS/.test(page) && /bufferedStart/.test(page)
);
check(
  'Orion table can mark odometer-derived km (operator HTML only)',
  /badge-derived/.test(page) && /odometer_delta/.test(page)
);

// ---------------------------------------------------------------------------
// dailyLitres — T5 Iveco 5 Aug style: mileage missing, both odometers present
// ---------------------------------------------------------------------------
var t5Asset = { travel_rate_lpk: 10.5 / 38.7, idle_burn_rate_lph: 3.0 };
var t5Records = [
  { record_date: '2026-08-04', daily_distance_km: null, odometer_km: 9132.4, idle_hours: 0.4 },
  { record_date: '2026-08-05', daily_distance_km: null, odometer_km: 9171.1, idle_hours: 2.2 / 3.0 }
];
var t5 = dist.dailyLitres(t5Asset, t5Records, '2026-08-05');
check(
  'dailyLitres falls back to odometer delta when daily_distance_km is null',
  t5.hasData === true && t5.distanceSource === 'odometer_delta' && t5.km === 38.7,
  JSON.stringify({ km: t5.km, source: t5.distanceSource, litres: t5.litres })
);
check(
  'T5-style litres include travel + idle, not idle-only 2.2L',
  Math.abs(t5.litres - 12.7) < 0.0001,
  'litres=' + t5.litres
);

var shuffled = [
  t5Records[1],
  { record_date: '2026-08-03', daily_distance_km: 10, odometer_km: 9000, idle_hours: 0 },
  t5Records[0]
];
var t5Shuffled = dist.dailyLitres(t5Asset, shuffled, '2026-08-05');
check(
  'dailyLitres prior odometer is chosen by date, not array order',
  t5Shuffled.km === 38.7 && t5Shuffled.distanceSource === 'odometer_delta',
  'km=' + t5Shuffled.km
);

var withMileage = dist.dailyLitres(t5Asset, [
  { record_date: '2026-08-04', daily_distance_km: null, odometer_km: 9132.4, idle_hours: 0 },
  { record_date: '2026-08-05', daily_distance_km: 12.0, odometer_km: 9171.1, idle_hours: 0 }
], '2026-08-05');
check(
  'direct mileage reading wins over a differing odometer delta',
  withMileage.hasData === true && withMileage.distanceSource === 'mileage' && withMileage.km === 12,
  JSON.stringify({ km: withMileage.km, source: withMileage.distanceSource })
);

// ---------------------------------------------------------------------------
// hasData: false when neither mileage nor a valid odometer delta exists
// ---------------------------------------------------------------------------
var idleOnly = dist.dailyLitres(t5Asset, [
  { record_date: '2026-08-05', daily_distance_km: null, odometer_km: null, idle_hours: 0.733 }
], '2026-08-05');
check(
  'idle-only row with no odometer is hasData false, not a fabricated idle-only litres figure',
  idleOnly.hasData === false && idleOnly.litres === 0 && idleOnly.distanceSource === null,
  JSON.stringify(idleOnly)
);

var noPrior = dist.dailyLitres(t5Asset, [
  { record_date: '2026-08-05', daily_distance_km: null, odometer_km: 9171.1, idle_hours: 0.733 }
], '2026-08-05');
check(
  'odometer today but no prior reading is hasData false (do not guess)',
  noPrior.hasData === false && noPrior.skipReason === 'no_prior',
  JSON.stringify(noPrior)
);

var missingDay = dist.dailyLitres(t5Asset, t5Records, '2026-08-12');
check(
  'no telematics row for that date is hasData false',
  missingDay.hasData === false && missingDay.skipReason === 'no_row'
);

var negative = dist.dailyLitres(t5Asset, [
  { record_date: '2026-08-04', daily_distance_km: null, odometer_km: 9200, idle_hours: 0 },
  { record_date: '2026-08-05', daily_distance_km: null, odometer_km: 9100, idle_hours: 0.5 }
], '2026-08-05');
check(
  'negative odometer delta is skipped rather than clamped to zero km',
  negative.hasData === false && negative.skipReason === 'negative_delta',
  JSON.stringify(negative)
);

var parked = dist.dailyLitres(t5Asset, [
  { record_date: '2026-08-04', daily_distance_km: null, odometer_km: 9171.1, idle_hours: 0 },
  { record_date: '2026-08-05', daily_distance_km: null, odometer_km: 9171.1, idle_hours: 1 }
], '2026-08-05');
check(
  'zero odometer delta (parked) is valid derived km, hasData true',
  parked.hasData === true && parked.km === 0 && parked.distanceSource === 'odometer_delta' &&
    Math.abs(parked.litres - 3.0) < 0.0001,
  JSON.stringify({ km: parked.km, litres: parked.litres })
);

// ---------------------------------------------------------------------------
// Backfill planner — chronological per asset, skip when no prior
// ---------------------------------------------------------------------------
var mixed = [
  // Asset B first in the array, later date — must not be used as A's prior
  { id: 20, asset_id: 'B', record_date: '2026-08-05', daily_distance_km: null, odometer_km: 500 },
  { id: 11, asset_id: 'A', record_date: '2026-08-05', daily_distance_km: null, odometer_km: 9171.1 },
  { id: 10, asset_id: 'A', record_date: '2026-08-04', daily_distance_km: 40, odometer_km: 9132.4 },
  { id: 9, asset_id: 'A', record_date: '2026-08-01', daily_distance_km: null, odometer_km: 9000 },
  { id: 19, asset_id: 'B', record_date: '2026-08-01', daily_distance_km: null, odometer_km: 400 },
  { id: 30, asset_id: 'C', record_date: '2026-08-03', daily_distance_km: null, odometer_km: 12 }
];
var plan = dist.planDailyDistanceBackfill(mixed);

function updateFor(assetId, date) {
  return plan.updates.filter(function(u) {
    return String(u.asset_id) === String(assetId) && u.record_date === date;
  })[0];
}

check(
  'backfill computes A 5 Aug as 9171.1 − 9132.4 = 38.7 against the prior date, not an earlier row',
  updateFor('A', '2026-08-05') && updateFor('A', '2026-08-05').daily_distance_km === 38.7 &&
    updateFor('A', '2026-08-05').prior_date === '2026-08-04',
  JSON.stringify(updateFor('A', '2026-08-05'))
);
check(
  'backfill does not overwrite a row that already has daily_distance_km',
  !updateFor('A', '2026-08-04'),
  'updates for A 4 Aug: ' + (updateFor('A', '2026-08-04') ? 'present' : 'none')
);
check(
  'backfill A 1 Aug is skipped — first odometer for that asset, no prior',
  plan.skippedNoPrior.some(function(r) { return r.id === 9; }) && !updateFor('A', '2026-08-01'),
  'skippedNoPrior ids=' + plan.skippedNoPrior.map(function(r) { return r.id; }).join(',')
);
check(
  'backfill B 5 Aug uses B\'s own 1 Aug odometer (400→500), not A\'s 9132.4',
  updateFor('B', '2026-08-05') && updateFor('B', '2026-08-05').daily_distance_km === 100 &&
    updateFor('B', '2026-08-05').prior_odometer_km === 400,
  JSON.stringify(updateFor('B', '2026-08-05'))
);
check(
  'backfill B 1 Aug skipped (no prior for B)',
  plan.skippedNoPrior.some(function(r) { return r.id === 19; })
);
check(
  'backfill C 3 Aug skipped rather than guessed — only row, no prior odometer',
  plan.skippedNoPrior.some(function(r) { return r.id === 30; }) && plan.updates.filter(function(u) {
    return String(u.asset_id) === 'C';
  }).length === 0
);
check(
  'backfill skipped-no-prior count is visible (3: A 1 Aug, B 1 Aug, C 3 Aug)',
  plan.skippedNoPrior.length === 3,
  'skippedNoPrior=' + plan.skippedNoPrior.length
);

var gapRows = [
  { id: 1, asset_id: 7, record_date: '2026-07-31', daily_distance_km: 20, odometer_km: 100 },
  { id: 2, asset_id: 7, record_date: '2026-08-01', daily_distance_km: null, odometer_km: 138.7 },
  { id: 3, asset_id: 7, record_date: '2026-08-02', daily_distance_km: null, odometer_km: 150 }
];
var gapPlan = dist.planDailyDistanceBackfill(gapRows);
check(
  'backfill walks date order so 2 Aug uses 1 Aug odometer (150−138.7), not 31 Jul',
  gapPlan.updates.length === 2 &&
    gapPlan.updates[0].record_date === '2026-08-01' && gapPlan.updates[0].daily_distance_km === 38.7 &&
    gapPlan.updates[1].record_date === '2026-08-02' && gapPlan.updates[1].daily_distance_km === 11.3,
  JSON.stringify(gapPlan.updates)
);

var reverseInput = gapRows.slice().reverse();
var reversePlan = dist.planDailyDistanceBackfill(reverseInput);
check(
  'backfill result is identical when input rows are reversed',
  reversePlan.updates.length === 2 &&
    reversePlan.updates[0].daily_distance_km === 38.7 &&
    reversePlan.updates[1].daily_distance_km === 11.3
);

console.log('');
console.log(pass ? 'ALL DAILY-DISTANCE FALLBACK TESTS PASSED' : 'SOME DAILY-DISTANCE FALLBACK TESTS FAILED');
process.exit(pass ? 0 : 1);
