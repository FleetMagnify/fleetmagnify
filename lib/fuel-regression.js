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
// Defensive floor: no legitimate fuel fill is realistically under this many
// litres. Catches historical bad rows (e.g. BP non-fuel line items like car
// washes/shop items that used a placeholder litres value of 1) that predate
// the parser-level Product allowlist fix, plus any edge case where a
// non-fuel item's price happens to coincidentally fall within the plausible
// price-per-litre band.
var MIN_PLAUSIBLE_FILL_LITRES = 3;

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

  // Second, separate presence check: the device can be reporting every day
  // (a telematicsByDate row exists) while odometer_km specifically is null
  // for an extended stretch — findOdometerNear() then has to reach past the
  // whole stretch to find a valid boundary reading, producing a real but
  // meaningless near-zero distance. Distinct from missingWeekdays above,
  // which only catches days with no telematics row at all.
  var missingOdometerWeekdays = datesInWindow.filter(function(d) {
    var date = toDate(d);
    if (isWeekend(date) || isNzPublicHoliday(d)) return false;
    return !!telematicsByDate[d] && telematicsByDate[d].odometer_km == null;
  });

  var maxOdoRun = 0, curOdoRun = 0, lastOdoDate = null;
  missingOdometerWeekdays.forEach(function(d) {
    if (lastOdoDate) {
      var diffOdo = (toDate(d) - toDate(lastOdoDate)) / 86400000;
      curOdoRun = (diffOdo <= 3) ? curOdoRun + 1 : 1;
    } else {
      curOdoRun = 1;
    }
    maxOdoRun = Math.max(maxOdoRun, curOdoRun);
    lastOdoDate = d;
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
  } else if (maxOdoRun >= 2) {
    excluded = true;
    exclusionReason = 'odometer_gap';
  } else if (interval.litres == null || interval.litres <= 0) {
    excluded = true;
    exclusionReason = 'invalid_litres';
  } else if (interval.litres < MIN_PLAUSIBLE_FILL_LITRES) {
    excluded = true;
    exclusionReason = 'implausible_litres';
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
// Orphaned-litres merge pass
// ---------------------------------------------------------------------------

/**
 * Pre-processing pass, run after evaluateInterval() but before calibration
 * and the audit trail: when an interval is excluded specifically for
 * non_positive_distance (two fills that resolve to the same nearest
 * telematics odometer reading — a genuine double-fill, not a data gap),
 * its litres would otherwise vanish entirely, silently understating the
 * litres total for the NEXT interval (whose distance accounting continues
 * unaffected and unaware a fill was dropped in between).
 *
 * Carries the zero-distance interval's litres forward onto the very next
 * interval in the list — whether or not that next interval itself ends up
 * included or excluded — then marks the zero-distance interval's
 * exclusionReason to note the merge (still excluded, for audit/display).
 * Other exclusion reasons (e.g. telematics_gap) are left untouched, since
 * those represent genuine data gaps, not legitimate double-fills.
 *
 * Walks in list order so that a chain of consecutive non_positive_distance
 * intervals cascades correctly (each one's forwarded total includes what
 * it already absorbed from the one before it).
 *
 * Mutates the array elements in place.
 */
function mergeOrphanedLitresForward(evaluated) {
  for (var i = 0; i < evaluated.length; i++) {
    var iv = evaluated[i];
    if (iv.exclusionReason !== 'non_positive_distance') continue;

    var next = evaluated[i + 1];
    if (!next) continue; // last interval in the list — nothing to merge into, litres still lost

    next.litres = (next.litres || 0) + (iv.litres || 0);
    iv.exclusionReason = 'non_positive_distance_litres_merged_forward';
  }
  return evaluated;
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
// EXPERIMENTAL: pooled-class calibration (comparison mode only, writes nothing)
//
// The current per-asset model regresses total litres against distance alone,
// then assigns the leftover residual to idle. Because distance and idle hours
// are correlated within a single asset, distance absorbs most idle fuel and
// the residual idle rate is structurally squeezed toward zero (confirmed on
// real data: T4 Line Truck showed 0.52 L/hr, physically implausible for a
// diesel truck). This pooled model instead:
//   - keeps travel rate per-asset (well identified by each asset's own data)
//   - estimates ONE idle rate per asset CLASS, fitted jointly across every
//     included interval of every asset in that class (cross-asset variation
//     in the driving/idling mix is what makes the two separable)
//   - constrains all rates to physically plausible bounds, starting from
//     industry priors ("flag rather than fabricate", applied to coefficients)
// ---------------------------------------------------------------------------

var IDLE_CLASS_TABLE = {
  // priorLph: starting estimate; boundsLph: hard physical clamps.
  // Anchored against published OEM base-idle figures for medium/heavy
  // diesel trucks (~1.3-2.5 L/hr for Hino 700-class engines): the fitted
  // standard_truck rate of ~2.1 L/hr from real fleet data lands inside
  // that band — two independent sources agreeing. Bounds are deliberately
  // wide enough for the fit to settle unpinned where the data supports it,
  // with floors at the bottom of the published physical range.
  // NOTE: pto_heavy is a BLENDED stationary rate (base idle + low-RPM
  // aerial/hydraulic work — Navman cannot separate PTO time from idle).
  // FUTURE: class assignment should move from name keywords to GVM bands
  // once assets.gvm_tonnes is populated (currently exists but empty).
  pto_heavy:      { priorLph: 1.8, boundsLph: [1.2, 8.0] },  // crane / bucket / EWP
  light_vehicle:  { priorLph: 1.0, boundsLph: [0.5, 2.0] },  // utes, cars
  standard_truck: { priorLph: 2.0, boundsLph: [1.3, 4.5] },  // medium/heavy diesel truck
};

function idleClassForAsset(assetName) {
  var name = String(assetName || '').toLowerCase();
  if (/crane|bucket/.test(name)) return 'pto_heavy';
  if (/\bute\b|ranger|hilux|navara|triton|honda|civic|corolla/.test(name)) return 'light_vehicle';
  return 'standard_truck';
}

function throughOriginSlope(xs, ys) {
  var sxy = 0, sxx = 0;
  for (var i = 0; i < xs.length; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
  return sxx > 0 ? sxy / sxx : 0;
}

function centeredR2(actual, predicted) {
  var mean = 0;
  for (var i = 0; i < actual.length; i++) mean += actual[i];
  mean /= actual.length;
  var ssRes = 0, ssTot = 0;
  for (var j = 0; j < actual.length; j++) {
    ssRes += Math.pow(actual[j] - predicted[j], 2);
    ssTot += Math.pow(actual[j] - mean, 2);
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : null;
}

// Alternating refinement: hold class idle rates fixed and fit each asset's
// travel rate on idle-corrected litres; then hold travel rates fixed and fit
// each class's idle rate on the pooled travel-corrected residuals. Repeat
// until stable. Clamp throughout.
function fitPooledModel(assetIntervals) {
  // assetIntervals: array of { assetId, assetName, idleClass, intervals: [{distanceKm, litres, idleHours}] }
  var classRates = {};
  for (var cls in IDLE_CLASS_TABLE) classRates[cls] = IDLE_CLASS_TABLE[cls].priorLph;

  var travelRates = {};
  var MAX_ITERS = 10;

  for (var iter = 0; iter < MAX_ITERS; iter++) {
    // Step 1: per-asset travel rates on idle-corrected litres
    assetIntervals.forEach(function(a) {
      var xs = [], ys = [];
      a.intervals.forEach(function(iv) {
        var corrected = iv.litres - classRates[a.idleClass] * iv.idleHours;
        xs.push(iv.distanceKm);
        ys.push(Math.max(0, corrected));
      });
      travelRates[a.assetId] = Math.max(0, throughOriginSlope(xs, ys));
    });

    // Step 2: per-class idle rates on pooled travel-corrected residuals
    var maxChange = 0;
    for (var cls2 in IDLE_CLASS_TABLE) {
      var xs2 = [], ys2 = [];
      assetIntervals.forEach(function(a) {
        if (a.idleClass !== cls2) return;
        a.intervals.forEach(function(iv) {
          var residual = iv.litres - travelRates[a.assetId] * iv.distanceKm;
          xs2.push(iv.idleHours);
          ys2.push(residual);
        });
      });
      if (xs2.length === 0) continue;
      var raw = throughOriginSlope(xs2, ys2);
      var bounds = IDLE_CLASS_TABLE[cls2].boundsLph;
      var clamped = Math.min(bounds[1], Math.max(bounds[0], raw));
      maxChange = Math.max(maxChange, Math.abs(clamped - classRates[cls2]));
      classRates[cls2] = clamped;
    }
    if (maxChange < 0.01) break;
  }

  return { classRates: classRates, travelRates: travelRates };
}

// Leave-one-interval-out median absolute prediction error (%), the honest
// "can this model actually predict fuel it hasn't seen" measure. For the new
// model the class idle rate is held fixed (it is fitted fleet-wide, one
// interval barely moves it) and only the asset's travel rate is refitted.
// For the old model the distance-only slope is refitted the same way.
function looMedianAbsErrorPct(intervals, predictFactory) {
  var errors = [];
  for (var i = 0; i < intervals.length; i++) {
    var train = intervals.filter(function(_, idx) { return idx !== i; });
    if (train.length < 2) continue;
    var predict = predictFactory(train);
    var held = intervals[i];
    if (held.litres <= 0) continue;
    var predicted = predict(held);
    errors.push(Math.abs(predicted - held.litres) / held.litres * 100);
  }
  if (errors.length === 0) return null;
  errors.sort(function(a, b) { return a - b; });
  var mid = Math.floor(errors.length / 2);
  return errors.length % 2 ? errors[mid] : (errors[mid - 1] + errors[mid]) / 2;
}

async function runPooledComparison(supabase, userId) {
  console.log('POOLED-CLASS COMPARISON MODE — nothing will be written to the database');
  console.log('');

  var assetsResult = await supabase
    .from('assets')
    .select('id, asset_name, travel_rate_lpk, idle_burn_rate_lph')
    .eq('user_id', userId)
    .eq('is_ignored', false);
  if (assetsResult.error) throw new Error('Failed to load assets: ' + assetsResult.error.message);
  var assets = assetsResult.data || [];

  // Load and evaluate intervals for every asset (deliberately duplicates the
  // small loading block from runForUser rather than refactoring the live
  // path — this mode must not risk changing live behaviour).
  var assetIntervals = [];
  for (var i = 0; i < assets.length; i++) {
    var asset = assets[i];
    var fuelResult = await supabase
      .from('fuel_purchases')
      .select('purchase_date, litres')
      .eq('vehicle_id', asset.id)
      .order('purchase_date', { ascending: true });
    if (fuelResult.error) { console.log(asset.asset_name + ': ERROR loading fuel'); continue; }
    var telResult = await supabase
      .from('telematics_records')
      .select('record_date, odometer_km, idle_hours')
      .eq('asset_id', asset.id);
    if (telResult.error) { console.log(asset.asset_name + ': ERROR loading telematics'); continue; }
    var telematicsByDate = {};
    (telResult.data || []).forEach(function(r) {
      telematicsByDate[r.record_date] = { odometer_km: r.odometer_km, idle_hours: r.idle_hours };
    });
    var rawIntervals = buildIntervals(fuelResult.data || []);
    var evaluated = rawIntervals.map(function(iv) {
      return Object.assign({}, iv, evaluateInterval(iv, telematicsByDate));
    });
    mergeOrphanedLitresForward(evaluated);
    var included = evaluated.filter(function(iv) { return iv.included; });
    if (included.length < MIN_INTERVALS_TO_CALIBRATE) {
      console.log(asset.asset_name + ': skipped (only ' + included.length + ' valid intervals)');
      continue;
    }
    assetIntervals.push({
      assetId: asset.id,
      assetName: asset.asset_name,
      idleClass: idleClassForAsset(asset.asset_name),
      currentTravelRate: asset.travel_rate_lpk,
      currentIdleRate: asset.idle_burn_rate_lph,
      intervals: included.map(function(iv) {
        return { distanceKm: iv.distanceKm, litres: iv.litres, idleHours: iv.idleHours };
      }),
      evaluated: evaluated,
    });
  }

  var pooled = fitPooledModel(assetIntervals);

  console.log('=== Fitted class idle rates ===');
  for (var cls in IDLE_CLASS_TABLE) {
    var members = assetIntervals.filter(function(a) { return a.idleClass === cls; });
    console.log(cls + ': ' + pooled.classRates[cls].toFixed(2) + ' L/hr' +
      ' (prior ' + IDLE_CLASS_TABLE[cls].priorLph.toFixed(1) +
      ', bounds ' + IDLE_CLASS_TABLE[cls].boundsLph.join('-') +
      ', ' + members.length + ' assets)');
  }
  console.log('');
  console.log('=== Per-asset comparison (old model vs pooled model) ===');

  var oldErrs = [], newErrs = [];
  assetIntervals.forEach(function(a) {
    var oldResult = calibrateAsset(a.evaluated, a.currentTravelRate);
    var classRate = pooled.classRates[a.idleClass];
    var newTravel = pooled.travelRates[a.assetId];

    var actual = a.intervals.map(function(iv) { return iv.litres; });
    var oldPred = a.intervals.map(function(iv) { return oldResult.travelRateLpk * iv.distanceKm; });
    var newPred = a.intervals.map(function(iv) { return newTravel * iv.distanceKm + classRate * iv.idleHours; });

    var oldLoo = looMedianAbsErrorPct(a.intervals, function(train) {
      var s = Math.max(0, throughOriginSlope(
        train.map(function(t) { return t.distanceKm; }),
        train.map(function(t) { return t.litres; })
      ));
      return function(iv) { return s * iv.distanceKm; };
    });
    var newLoo = looMedianAbsErrorPct(a.intervals, function(train) {
      var s = Math.max(0, throughOriginSlope(
        train.map(function(t) { return t.distanceKm; }),
        train.map(function(t) { return Math.max(0, t.litres - classRate * t.idleHours); })
      ));
      return function(iv) { return s * iv.distanceKm + classRate * iv.idleHours; };
    });
    if (oldLoo != null) oldErrs.push(oldLoo);
    if (newLoo != null) newErrs.push(newLoo);

    console.log(
      a.assetName + ' [' + a.idleClass + ']' +
      '\n  old: travel ' + oldResult.travelRateLpk.toFixed(3) + ' L/km, idle ' +
        (oldResult.idleRateLph != null ? oldResult.idleRateLph.toFixed(2) : 'n/a') + ' L/hr' +
        ', centered R2 ' + (centeredR2(actual, oldPred) != null ? centeredR2(actual, oldPred).toFixed(3) : 'n/a') +
        ', LOO err ' + (oldLoo != null ? oldLoo.toFixed(1) + '%' : 'n/a') +
      '\n  new: travel ' + newTravel.toFixed(3) + ' L/km, idle ' + classRate.toFixed(2) + ' L/hr (class)' +
        ', centered R2 ' + (centeredR2(actual, newPred) != null ? centeredR2(actual, newPred).toFixed(3) : 'n/a') +
        ', LOO err ' + (newLoo != null ? newLoo.toFixed(1) + '%' : 'n/a')
    );
  });

  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function(a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  console.log('');
  console.log('=== Fleet-wide LOO median abs error ===');
  console.log('old model: ' + (median(oldErrs) != null ? median(oldErrs).toFixed(1) + '%' : 'n/a'));
  console.log('new model: ' + (median(newErrs) != null ? median(newErrs).toFixed(1) + '%' : 'n/a'));
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
    mergeOrphanedLitresForward(evaluated);

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
          var idleClass = idleClassForAsset(asset.asset_name);
          var bounds = (IDLE_CLASS_TABLE[idleClass] && IDLE_CLASS_TABLE[idleClass].boundsLph) || [1.5, 4.5];
          if (result.idleRateLph != null && result.idleRateLph >= bounds[0] && result.idleRateLph <= bounds[1]) {
            updatePayload.idle_burn_rate_lph = result.idleRateLph;
          } else {
            console.log(
              '  -> idle ' +
              (result.idleRateLph != null ? result.idleRateLph.toFixed(3) : 'n/a') +
              ' L/hr is outside the plausible ' + bounds[0] + '–' + bounds[1] +
              ' L/hr band for this class — not stored; UI will show the default estimate'
            );
          }
        } else {
          updatePayload.idle_anomaly_flagged_at = new Date().toISOString();
        }
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
  var comparePooled = args.indexOf('--compare-pooled') !== -1;

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

  if (comparePooled) {
    await runPooledComparison(supabase, userId);
    return;
  }

  console.log(dryRun ? 'DRY RUN — no data will be written' : 'LIVE RUN — results will be written to the database');
  console.log('');

  await runForUser(supabase, userId, dryRun);
}

main().catch(function(err) {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
