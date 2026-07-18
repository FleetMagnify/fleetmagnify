/**
 * Fuel Regression Engine — standalone script.
 *
 * Calibrates per-asset travel rate (litres/km) via single-variable NNLS
 * regression through the origin, then derives idle rate (litres/hour) as
 * the residual. Writes results to assets.travel_rate_lpk,
 * assets.idle_burn_rate_lph, and a full audit trail to
 * fuel_calibration_intervals.
 *
 * Usage:
 *   node fuel-regression.js --self-test
 *     Runs the five synthetic sanity checks. Touches no real data.
 *
 *   node fuel-regression.js --user-id <uuid> [--dry-run]
 *     Runs against real data for the given account. --dry-run computes
 *     and prints results without writing anything to the database.
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var MIN_INTERVALS_TO_CALIBRATE = 6;
var CORRECTION_CAP_FRACTION = 0.30; // ±30%
var IDLE_ANOMALY_THRESHOLD_FRACTION = 0.50; // flag if new idle rate is 50%+ above previous

// Hardcoded NZ national public holidays relevant to the Jan-Jul 2026 window.
// TODO: move to a proper nz_public_holidays table (region-tagged) — this is
// a stand-in for tonight's build only, per last night's design discussion.
var NZ_PUBLIC_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', // New Year
  '2026-02-06', // Waitangi Day
  '2026-04-03', '2026-04-06', // Good Friday, Easter Monday (2026 dates)
  '2026-04-25', // ANZAC Day
  '2026-06-01', // King's Birthday (first Monday of June, 2026)
  '2026-07-10', // Matariki (2026 date)
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function isWeekend(date) {
  var day = date.getUTCDay();
  return day === 0 || day === 6;
}

function isNzPublicHoliday(dateStr) {
  return NZ_PUBLIC_HOLIDAYS_2026.indexOf(dateStr) !== -1;
}

function eachDateBetween(startStr, endStr) {
  var out = [];
  var cur = toDate(startStr);
  var end = toDate(endStr);
  while (cur < end) {
    out.push(toDateStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core regression math
// ---------------------------------------------------------------------------

/**
 * Single-variable NNLS regression through the origin.
 * Closed-form solution: unconstrained slope = sum(x*y) / sum(x*x).
 * Non-negativity constraint: if that's negative, clamp to 0 (the correct
 * NNLS solution for a single-variable, origin-forced problem).
 *
 * Returns { slope, r2 } where r2 is UNCENTERED R² (compares residuals
 * against sum(y^2), not against the mean — correct for a through-origin fit).
 */
function nnlsRegressionThroughOrigin(points) {
  var sumXY = 0, sumXX = 0, sumYY = 0;
  for (var i = 0; i < points.length; i++) {
    sumXY += points[i].x * points[i].y;
    sumXX += points[i].x * points[i].x;
    sumYY += points[i].y * points[i].y;
  }

  var rawSlope = sumXX > 0 ? sumXY / sumXX : 0;
  var slope = Math.max(0, rawSlope);

  var ssRes = 0;
  for (var j = 0; j < points.length; j++) {
    var resid = points[j].y - slope * points[j].x;
    ssRes += resid * resid;
  }

  var r2 = sumYY > 0 ? 1 - (ssRes / sumYY) : null;

  return { slope: slope, r2: r2, rawSlope: rawSlope };
}

// ---------------------------------------------------------------------------
// Self-test: five synthetic scenarios, no real data touched
// ---------------------------------------------------------------------------

function runSelfTest() {
  var pass = true;

  function check(label, condition, detail) {
    var status = condition ? 'PASS' : 'FAIL';
    if (!condition) pass = false;
    console.log('[' + status + '] ' + label + (detail ? ' — ' + detail : ''));
  }

  // 1. Perfect fit — exact known rate, zero noise
  var perfectPoints = [];
  for (var i = 1; i <= 10; i++) {
    perfectPoints.push({ x: i * 100, y: i * 100 * 0.35 });
  }
  var r1 = nnlsRegressionThroughOrigin(perfectPoints);
  check('Perfect fit: slope ≈ 0.35', Math.abs(r1.slope - 0.35) < 0.0001, 'got ' + r1.slope);
  check('Perfect fit: R² ≈ 1.0', r1.r2 > 0.999, 'got ' + r1.r2);

  // 2. Noisy-but-honest — same rate + small random variation
  var noisyPoints = [];
  for (var n = 1; n <= 20; n++) {
    var dist = n * 100;
    var noise = (Math.random() - 0.5) * 0.02; // ±1% noise on rate
    noisyPoints.push({ x: dist, y: dist * (0.35 + noise) });
  }
  var r2test = nnlsRegressionThroughOrigin(noisyPoints);
  check('Noisy fit: slope within 5% of 0.35', Math.abs(r2test.slope - 0.35) / 0.35 < 0.05, 'got ' + r2test.slope);
  check('Noisy fit: R² still high (> 0.9)', r2test.r2 > 0.9, 'got ' + r2test.r2);

  // 3. Single outlier — one garbage interval injected
  var outlierPoints = perfectPoints.slice();
  outlierPoints.push({ x: 10, y: 500 }); // absurd: 10km, 500L
  var r3 = nnlsRegressionThroughOrigin(outlierPoints);
  check(
    'Single outlier: slope still roughly sane (< 1.0)',
    r3.slope < 1.0,
    'got ' + r3.slope + ' (this is RAW regression — the ±30% cap, applied separately at calibration time, is what protects a live asset from a single bad interval; this check just confirms the raw math does not explode)'
  );

  // 4. Forced-negative case — NOTE: for genuine distance/litres data (both
  // always >= 0), sum(x*y) can NEVER be negative, so the raw regression
  // slope can never actually go negative from real fuel data alone. This
  // test therefore uses an artificial negative y value purely to prove the
  // clamp-to-zero code path activates correctly — it does not represent a
  // realistic input. The NNLS floor is kept as defense-in-depth (e.g.
  // against a corrupted row slipping past the other exclusion filters),
  // not because real data is expected to trigger it.
  var negPoints = [
    { x: 100, y: -50 }, { x: 200, y: -100 }, { x: 50, y: -25 }
  ];
  var r4 = nnlsRegressionThroughOrigin(negPoints);
  check(
    'Artificial negative input: NNLS clamps to 0, never negative',
    r4.slope === 0 && r4.rawSlope < 0,
    'raw unconstrained was ' + r4.rawSlope.toFixed(4) + ' (correctly negative for this artificial input), NNLS clamped to ' + r4.slope
  );

  // 5. Genuine rate-change — first half at one rate, second half at another.
  // This just demonstrates the raw regression blends both periods together
  // (expected) — the ±30% cap behavior for real recalibration is tested
  // separately, not as part of this single-shot regression check.
  var changePoints = [];
  for (var a = 1; a <= 6; a++) changePoints.push({ x: a * 100, y: a * 100 * 0.35 });
  for (var b = 7; b <= 12; b++) changePoints.push({ x: b * 100, y: b * 100 * 0.28 });
  var r5 = nnlsRegressionThroughOrigin(changePoints);
  check(
    'Rate-change data: blended slope sits between 0.28 and 0.35',
    r5.slope > 0.28 && r5.slope < 0.35,
    'got ' + r5.slope + ' (expected — a single regression over both periods blends them; this is why the ±30% cap + manual reset exists for real recalibration over time, not this test)'
  );

  console.log('');
  console.log(pass ? 'ALL SELF-TESTS PASSED' : 'SOME SELF-TESTS FAILED — do not proceed to real data until fixed');
  return pass;
}

// ---------------------------------------------------------------------------
// Interval construction from real data
// ---------------------------------------------------------------------------

/**
 * Builds fill-to-fill intervals for one asset from its fuel purchases,
 * sorted chronologically. Each interval spans two consecutive purchases.
 */
function buildIntervals(fuelPurchases) {
  var sorted = fuelPurchases.slice().sort(function(a, b) {
    return a.purchase_date < b.purchase_date ? -1 : (a.purchase_date > b.purchase_date ? 1 : 0);
  });

  var intervals = [];
  for (var i = 1; i < sorted.length; i++) {
    intervals.push({
      startDate: sorted[i - 1].purchase_date,
      endDate: sorted[i].purchase_date,
      litres: sorted[i].litres, // fuel used to cover this interval is the fill AT THE END
    });
  }
  return intervals;
}

/**
 * Computes distance and idle hours for an interval from telematics_records,
 * and checks data quality (gap of 2+ consecutive weekdays, excluding NZ
 * public holidays, with no telematics row at all).
 *
 * telematicsByDate: map of dateStr -> { odometer_km, idle_hours } for this asset.
 */
function evaluateInterval(interval, telematicsByDate) {
  var datesInWindow = eachDateBetween(interval.startDate, interval.endDate);
  // Include the end date itself for odometer lookup purposes (need boundary reading)
  var allDatesForOdo = datesInWindow.concat([interval.endDate]);

  // Find odometer at/nearest start and end (walk forward/backward for nearest available)
  function findOdometerNear(dateStr, direction) {
    var d = toDate(dateStr);
    for (var step = 0; step <= 3; step++) {
      var candidate = new Date(d);
      candidate.setUTCDate(candidate.getUTCDate() + (direction * step));
      var key = toDateStr(candidate);
      if (telematicsByDate[key] && telematicsByDate[key].odometer_km != null) {
        return telematicsByDate[key].odometer_km;
      }
    }
    return null;
  }

  var startOdo = findOdometerNear(interval.startDate, 1);
  var endOdo = findOdometerNear(interval.endDate, -1);

  var distanceKm = (startOdo != null && endOdo != null) ? (endOdo - startOdo) : null;

  var idleHours = 0;
  datesInWindow.forEach(function(d) {
    if (telematicsByDate[d] && telematicsByDate[d].idle_hours != null) {
      idleHours += telematicsByDate[d].idle_hours;
    }
  });

  // Gap check: find missing weekdays (excluding holidays) in the window
  var missingWeekdays = datesInWindow.filter(function(d) {
    var date = toDate(d);
    if (isWeekend(date) || isNzPublicHoliday(d)) return false;
    return !telematicsByDate[d];
  });

  // Find max run of consecutive missing weekdays
  var maxRun = 0, curRun = 0, lastDate = null;
  missingWeekdays.forEach(function(d) {
    if (lastDate) {
      var diff = (toDate(d) - toDate(lastDate)) / 86400000;
      curRun = (diff <= 3) ? curRun + 1 : 1; // allow for weekend gap between weekdays
    } else {
      curRun = 1;
    }
    maxRun = Math.max(maxRun, curRun);
    lastDate = d;
  });

  var excluded = false;
  var exclusionReason = null;

  if (distanceKm === null) {
    excluded = true;
    exclusionReason = 'missing_odometer_boundary';
  } else if (distanceKm <= 0) {
    excluded = true;
    exclusionReason = 'non_positive_distance';
  } else if (maxRun >= 2) {
    excluded = true;
    exclusionReason = 'telematics_gap';
  } else if (interval.litres == null || interval.litres <= 0) {
    excluded = true;
    exclusionReason = 'invalid_litres';
  }

  return {
    distanceKm: distanceKm,
    idleHours: idleHours,
    litres: interval.litres,
    included: !excluded,
    exclusionReason: exclusionReason,
  };
}

// ---------------------------------------------------------------------------
// Per-asset calibration
// ---------------------------------------------------------------------------

function calibrateAsset(intervals, previousTravelRate) {
  var included = intervals.filter(function(iv) { return iv.included; });

  if (included.length < MIN_INTERVALS_TO_CALIBRATE) {
    return {
      calibrated: false,
      reason: 'insufficient_intervals',
      includedCount: included.length,
    };
  }

  var points = included.map(function(iv) {
    return { x: iv.distanceKm, y: iv.litres };
  });

  var reg = nnlsRegressionThroughOrigin(points);
  var rawRate = reg.slope;
  var finalRate = rawRate;
  var wasCapped = false;

  if (previousTravelRate != null && previousTravelRate > 0) {
    var lower = previousTravelRate * (1 - CORRECTION_CAP_FRACTION);
    var upper = previousTravelRate * (1 + CORRECTION_CAP_FRACTION);
    if (rawRate < lower) { finalRate = lower; wasCapped = true; }
    if (rawRate > upper) { finalRate = upper; wasCapped = true; }
  }

  // Idle residual — aggregate across all included intervals (sum litres / sum hours),
  // not averaged per-interval, for statistical stability.
  var totalLitres = 0, totalDistance = 0, totalIdleHours = 0, totalIdleLitresRaw = 0;
  included.forEach(function(iv) {
    totalLitres += iv.litres;
    totalDistance += iv.distanceKm;
    totalIdleHours += iv.idleHours;
  });
  var travelLitresTotal = finalRate * totalDistance;
  var idleLitresTotal = totalLitres - travelLitresTotal;
  var idleRateFloorTriggered = idleLitresTotal < 0;
  var idleRate = (totalIdleHours > 0)
    ? Math.max(0, idleLitresTotal) / totalIdleHours
    : null;

  return {
    calibrated: true,
    travelRateLpk: finalRate,
    rawRate: rawRate,
    wasCapped: wasCapped,
    r2: reg.r2,
    includedCount: included.length,
    idleRateLph: idleRate,
    idleRateFloorTriggered: idleRateFloorTriggered,
  };
}

// ---------------------------------------------------------------------------
// Main — real data run
// ---------------------------------------------------------------------------

async function runForUser(supabase, userId, dryRun) {
  var assetsResult = await supabase
    .from('assets')
    .select('id, asset_name, travel_rate_lpk, idle_burn_rate_lph, idle_anomaly_confirmed')
    .eq('user_id', userId)
    .eq('is_ignored', false);

  if (assetsResult.error) throw new Error('Failed to load assets: ' + assetsResult.error.message);
  var assets = assetsResult.data || [];

  console.log('Found ' + assets.length + ' active assets for user ' + userId);
  console.log('');

  for (var i = 0; i < assets.length; i++) {
    var asset = assets[i];

    var fuelResult = await supabase
      .from('fuel_purchases')
      .select('purchase_date, litres')
      .eq('vehicle_id', asset.id)
      .order('purchase_date', { ascending: true });

    if (fuelResult.error) {
      console.log(asset.asset_name + ': ERROR loading fuel — ' + fuelResult.error.message);
      continue;
    }

    var telResult = await supabase
      .from('telematics_records')
      .select('record_date, odometer_km, idle_hours')
      .eq('asset_id', asset.id);

    if (telResult.error) {
      console.log(asset.asset_name + ': ERROR loading telematics — ' + telResult.error.message);
      continue;
    }

    var telematicsByDate = {};
    (telResult.data || []).forEach(function(r) {
      telematicsByDate[r.record_date] = { odometer_km: r.odometer_km, idle_hours: r.idle_hours };
    });

    var rawIntervals = buildIntervals(fuelResult.data || []);
    var evaluated = rawIntervals.map(function(iv) {
      return Object.assign({}, iv, evaluateInterval(iv, telematicsByDate));
    });

    var result = calibrateAsset(evaluated, asset.travel_rate_lpk);

    if (!result.calibrated) {
      console.log(
        asset.asset_name + ': NOT calibrated — ' + result.reason +
        ' (' + result.includedCount + '/' + MIN_INTERVALS_TO_CALIBRATE + ' valid intervals)'
      );
    } else {
      console.log(
        asset.asset_name + ': travel=' + result.travelRateLpk.toFixed(4) + ' L/km' +
        (result.wasCapped ? ' [CAPPED, raw was ' + result.rawRate.toFixed(4) + ']' : '') +
        ', R²=' + (result.r2 != null ? result.r2.toFixed(3) : 'n/a') +
        ', idle=' + (result.idleRateLph != null ? result.idleRateLph.toFixed(3) + ' L/hr' : 'n/a') +
        (result.idleRateFloorTriggered ? ' [FLOOR TRIGGERED — travel rate may be overestimated]' : '') +
        ', intervals=' + result.includedCount
      );

      var anomalous = false;
      if (result.idleRateLph != null && asset.idle_burn_rate_lph != null && asset.idle_burn_rate_lph > 0) {
        var pctIncrease = (result.idleRateLph - asset.idle_burn_rate_lph) / asset.idle_burn_rate_lph;
        if (pctIncrease > IDLE_ANOMALY_THRESHOLD_FRACTION && !asset.idle_anomaly_confirmed) {
          anomalous = true;
          console.log('  -> IDLE ANOMALY: ' + (pctIncrease * 100).toFixed(0) + '% above previous rate. Needs customer confirmation (hydraulics/PTO?) before this is treated as normal.');
        }
      }

      if (!dryRun) {
        var updatePayload = {
          travel_rate_lpk: result.travelRateLpk,
          travel_rate_r2: result.r2,
          calibration_interval_count: result.includedCount,
          last_calibrated_at: new Date().toISOString(),
        };
        if (!anomalous) {
          updatePayload.idle_burn_rate_lph = result.idleRateLph;
        } else {
          updatePayload.idle_anomaly_flagged_at = new Date().toISOString();
        }
        var updateResult = await supabase.from('assets').update(updatePayload).eq('id', asset.id);
        if (updateResult.error) {
          console.log('  -> FAILED TO WRITE: ' + updateResult.error.message);
        }
      }
    }

    // Write audit trail regardless of calibration success, dry-run or not (unless dry-run)
    if (!dryRun && evaluated.length > 0) {
      // Dedupe by (interval_start_date, interval_end_date) before upserting —
      // if two intervals happen to share identical boundaries (e.g. same-day
      // fills from different fuel sources producing coincident dates), a
      // batch upsert can't apply two updates to the same conflict target in
      // one statement ("ON CONFLICT DO UPDATE command cannot affect row a
      // second time"). Keep the first occurrence; this only affects the audit
      // trail record, not the calibration itself, which already uses the
      // full evaluated interval list.
      var seenIntervalKeys = {};
      var auditRows = [];
      evaluated.forEach(function(iv) {
        var key = iv.startDate + '|' + iv.endDate;
        if (seenIntervalKeys[key]) return;
        seenIntervalKeys[key] = true;
        auditRows.push({
          asset_id: asset.id,
          interval_start_date: iv.startDate,
          interval_end_date: iv.endDate,
          distance_km: iv.distanceKm,
          litres: iv.litres,
          idle_hours: iv.idleHours,
          included: iv.included,
          exclusion_reason: iv.exclusionReason,
        });
      });
      var auditResult = await supabase
        .from('fuel_calibration_intervals')
        .upsert(auditRows, { onConflict: 'asset_id,interval_start_date,interval_end_date' });
      if (auditResult.error) {
        console.log('  -> FAILED TO WRITE AUDIT TRAIL: ' + auditResult.error.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  var args = process.argv.slice(2);

  if (args.indexOf('--self-test') !== -1) {
    var passed = runSelfTest();
    process.exit(passed ? 0 : 1);
    return;
  }

  var userIdIdx = args.indexOf('--user-id');
  if (userIdIdx === -1 || !args[userIdIdx + 1]) {
    console.log('Usage: node fuel-regression.js --self-test');
    console.log('       node fuel-regression.js --user-id <uuid> [--dry-run]');
    process.exit(1);
    return;
  }
  var userId = args[userIdIdx + 1];
  var dryRun = args.indexOf('--dry-run') !== -1;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.');
    process.exit(1);
    return;
  }

  var supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  console.log(dryRun ? 'DRY RUN — no data will be written' : 'LIVE RUN — results will be written to the database');
  console.log('');

  await runForUser(supabase, userId, dryRun);
}

main().catch(function(err) {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
