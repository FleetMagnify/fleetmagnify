/**
 * Shared daily-distance resolution for telematics rows.
 *
 * Navman writes daily_distance_km from a distinct mileage report and
 * odometer_km from the fleet-overview report. When the mileage report is
 * missing, daily_distance_km is null even though odometer_km is populated.
 * Callers that treat a null distance as zero silently drop travel fuel.
 *
 * Prefer the mileage-report value when present. Otherwise derive km from
 * this row's odometer minus the same asset's most recent prior record that
 * has a valid odometer_km, in true date order. Do not invent a number when
 * there is no prior odometer — leave distance unavailable.
 *
 * distanceSource distinguishes the two success states:
 *   'mileage'         — direct from Navman's mileage report
 *   'odometer_delta'  — derived from consecutive odometer readings
 *   null              — genuinely unavailable
 *
 * Operator UIs may surface 'odometer_delta'. Customer-facing Orion PDF/CSV
 * submissions should not: the litres are the same physical quantity the
 * method already describes (km driven × calibrated travel rate).
 */
(function(global) {
  var DEFAULT_TRAVEL_RATE_LPK = 0.35;
  var DEFAULT_IDLE_RATE_LPH = 3.0;
  var LOOKBACK_DAYS = 60;

  function dateKey(value) {
    if (value == null || value === '') return '';
    return String(value).slice(0, 10);
  }

  function numOrNull(value) {
    if (value == null || value === '') return null;
    var n = typeof value === 'number' ? value : parseFloat(value);
    return isNaN(n) ? null : n;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function compareRecords(a, b) {
    var da = dateKey(a && a.record_date);
    var db = dateKey(b && b.record_date);
    if (da < db) return -1;
    if (da > db) return 1;
    var ia = a && a.id != null ? Number(a.id) : 0;
    var ib = b && b.id != null ? Number(b.id) : 0;
    if (!isNaN(ia) && !isNaN(ib) && ia !== ib) return ia - ib;
    return 0;
  }

  function addDaysIso(iso, days) {
    var parts = dateKey(iso).split('-').map(Number);
    if (parts.length < 3 || !parts[0]) return '';
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return dt.toISOString().slice(0, 10);
  }

  function findPriorOdometerRecord(records, dateIso) {
    var target = dateKey(dateIso);
    if (!target) return null;
    var best = null;
    (records || []).forEach(function(r) {
      if (!r) return;
      var d = dateKey(r.record_date);
      if (!d || d >= target) return;
      if (numOrNull(r.odometer_km) == null) return;
      if (
        !best ||
        d > dateKey(best.record_date) ||
        (d === dateKey(best.record_date) && Number(r.id || 0) > Number(best.id || 0))
      ) {
        best = r;
      }
    });
    return best;
  }

  /**
   * Resolve km driven for one telematics row.
   * priorRecord must be the same asset's most recent earlier row with
   * odometer_km, or null.
   *
   * Returns { km, source, hasDistance, skipReason }.
   */
  function resolveDailyDistance(today, priorRecord) {
    if (!today) {
      return { km: null, source: null, hasDistance: false, skipReason: 'no_row' };
    }
    var mileage = numOrNull(today.daily_distance_km);
    if (mileage != null) {
      return {
        km: Math.max(0, mileage),
        source: 'mileage',
        hasDistance: true,
        skipReason: null
      };
    }
    var todayOdo = numOrNull(today.odometer_km);
    var priorOdo = priorRecord ? numOrNull(priorRecord.odometer_km) : null;
    if (todayOdo == null) {
      return { km: null, source: null, hasDistance: false, skipReason: 'no_odometer' };
    }
    if (priorOdo == null) {
      return { km: null, source: null, hasDistance: false, skipReason: 'no_prior' };
    }
    var delta = todayOdo - priorOdo;
    if (delta < 0) {
      return { km: null, source: null, hasDistance: false, skipReason: 'negative_delta' };
    }
    return {
      km: round1(delta),
      source: 'odometer_delta',
      hasDistance: true,
      skipReason: null
    };
  }

  function effectiveTravelRate(asset, fallback) {
    var n = asset ? numOrNull(asset.travel_rate_lpk) : null;
    return n != null ? n : (fallback != null ? fallback : DEFAULT_TRAVEL_RATE_LPK);
  }

  function effectiveIdleRate(asset, fallback) {
    var n = asset ? numOrNull(asset.idle_burn_rate_lph) : null;
    return n != null ? n : (fallback != null ? fallback : DEFAULT_IDLE_RATE_LPH);
  }

  /**
   * Litres for one asset on one date.
   *
   * hasData is true only when travel km is resolvable (direct mileage or a
   * valid odometer delta). Idle hours alone used to make hasData true and
   * silently report idle-only litres — that is the bug this closes.
   *
   * A derived-delta day is hasData true with distanceSource 'odometer_delta',
   * which is a different state from a day with no prior odometer at all
   * (hasData false, distanceSource null).
   */
  function dailyLitres(asset, records, dateIso, options) {
    options = options || {};
    var empty = {
      litres: 0,
      hasData: false,
      distanceSource: null,
      km: null,
      idleHours: 0,
      skipReason: 'no_row'
    };
    if (!records || records.length === 0) return empty;

    var today = null;
    var target = dateKey(dateIso);
    for (var i = 0; i < records.length; i++) {
      if (dateKey(records[i].record_date) === target) {
        today = records[i];
        break;
      }
    }
    if (!today) return empty;

    var prior = findPriorOdometerRecord(records, dateIso);
    var distance = resolveDailyDistance(today, prior);
    var idleHours = numOrNull(today.idle_hours);
    if (idleHours == null) idleHours = 0;

    if (!distance.hasDistance) {
      return {
        litres: 0,
        hasData: false,
        distanceSource: null,
        km: null,
        idleHours: idleHours,
        skipReason: distance.skipReason
      };
    }

    var litres =
      (distance.km * effectiveTravelRate(asset, options.defaultTravelRateLpk)) +
      (idleHours * effectiveIdleRate(asset, options.defaultIdleRateLph));

    return {
      litres: litres,
      hasData: true,
      distanceSource: distance.source,
      km: distance.km,
      idleHours: idleHours,
      skipReason: null
    };
  }

  /**
   * Plan daily_distance_km updates from odometer deltas.
   *
   * Input may be unsorted and mixed across assets. Group by asset, walk in
   * true record_date order (id as a stable tie-break), and compute each
   * null-distance row against that asset's most recent prior valid
   * odometer_km. Rows with no prior odometer are skipped, not guessed.
   *
   * Existing non-null daily_distance_km values are left untouched.
   */
  function planDailyDistanceBackfill(rows) {
    var byAsset = {};
    (rows || []).forEach(function(r) {
      if (!r || r.asset_id == null) return;
      var key = String(r.asset_id);
      byAsset[key] = byAsset[key] || [];
      byAsset[key].push(r);
    });

    var updates = [];
    var skippedNoPrior = [];
    var skippedNegative = [];

    Object.keys(byAsset).forEach(function(assetId) {
      var list = byAsset[assetId].slice().sort(compareRecords);
      var lastOdo = null;
      var lastRecord = null;
      list.forEach(function(r) {
        var odo = numOrNull(r.odometer_km);
        var dist = numOrNull(r.daily_distance_km);
        var needsFill = dist == null && odo != null;
        if (needsFill) {
          if (lastOdo == null) {
            skippedNoPrior.push(r);
          } else {
            var delta = odo - lastOdo;
            if (delta < 0) {
              skippedNegative.push(r);
            } else {
              updates.push({
                id: r.id,
                user_id: r.user_id,
                asset_id: r.asset_id,
                record_date: dateKey(r.record_date),
                daily_distance_km: round1(delta),
                odometer_km: odo,
                prior_date: lastRecord ? dateKey(lastRecord.record_date) : null,
                prior_odometer_km: lastOdo
              });
            }
          }
        }
        if (odo != null) {
          lastOdo = odo;
          lastRecord = r;
        }
      });
    });

    return {
      updates: updates,
      skippedNoPrior: skippedNoPrior,
      skippedNegative: skippedNegative
    };
  }

  var api = {
    DEFAULT_TRAVEL_RATE_LPK: DEFAULT_TRAVEL_RATE_LPK,
    DEFAULT_IDLE_RATE_LPH: DEFAULT_IDLE_RATE_LPH,
    LOOKBACK_DAYS: LOOKBACK_DAYS,
    dateKey: dateKey,
    numOrNull: numOrNull,
    round1: round1,
    compareRecords: compareRecords,
    addDaysIso: addDaysIso,
    findPriorOdometerRecord: findPriorOdometerRecord,
    resolveDailyDistance: resolveDailyDistance,
    dailyLitres: dailyLitres,
    planDailyDistanceBackfill: planDailyDistanceBackfill,
    effectiveTravelRate: effectiveTravelRate,
    effectiveIdleRate: effectiveIdleRate
  };

  global.FleetMagnifyTelematicsDistance = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
