/**
 * FleetMagnify shared depreciation, servicing, and maintenance cost model.
 */
(function(global) {
  var ON_ROAD_TYPES = ['Light Vehicle', 'Rigid Truck', 'Semi Trailer'];
  var ON_ROAD_SET = { 'Light Vehicle': true, 'Rigid Truck': true, 'Semi Trailer': true };

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function isOnRoad(asset) {
    if (!asset) return false;
    if (asset.is_on_road === true) return true;
    if (asset.is_on_road === false) return false;
    return !!ON_ROAD_SET[(asset.asset_type || '').trim()];
  }

  function formatMissingMessage(fields) {
    if (!fields || !fields.length) return '';
    return 'Cannot calculate — missing: ' + fields.join(', ');
  }

  function getMissingDepreciationFields(asset, context) {
    context = context || {};
    var missing = [];
    if (num(asset.current_value) === null) missing.push('Current Value');
    if (num(asset.estimated_end_of_life_value) === null) missing.push('Estimated End of Life Value');
    if (isOnRoad(asset)) {
      if (num(asset.expected_life_km) === null) missing.push('Expected Total Life (km)');
      var odo = context.currentOdometer !== undefined && context.currentOdometer !== null
        ? num(context.currentOdometer) : num(asset.current_odometer);
      if (odo === null) missing.push('Current Odometer (km)');
    } else {
      if (num(asset.expected_life_hours) === null) missing.push('Expected Total Life (hours)');
      var hours = context.totalEngineHours !== undefined && context.totalEngineHours !== null
        ? num(context.totalEngineHours) : null;
      if (hours === null) missing.push('total engine hours (telematics)');
    }
    return missing;
  }

  function getMissingMaintenanceFields(asset) {
    var missing = [];
    if (num(asset.estimated_annual_repair_cost) === null) missing.push('Estimated Annual Repair Cost');
    if (isOnRoad(asset)) {
      if (num(asset.estimated_annual_km) === null) missing.push('Estimated Annual KM');
    } else {
      if (num(asset.available_hours_per_week) === null) missing.push('Available Hours Per Week');
      if (num(asset.target_utilisation_percent) === null) missing.push('Target Utilisation Percent');
    }
    return missing;
  }

  function getMissingServicingFields(asset) {
    if (isOnRoad(asset)) {
      return num(asset.service_cost_per_km) === null ? ['Service Cost Per KM'] : [];
    }
    return num(asset.service_cost_per_hour) === null ? ['Service Cost Per Hour'] : [];
  }

  function calcDepreciationPerHour(asset, totalEngineHours) {
    var missing = getMissingDepreciationFields(asset, { totalEngineHours: totalEngineHours });
    if (missing.length) return { ok: false, missing: missing };
    var currentValue = num(asset.current_value);
    var eolValue = num(asset.estimated_end_of_life_value);
    var lifeHours = num(asset.expected_life_hours);
    var currentHours = num(totalEngineHours);
    var remaining = lifeHours - currentHours;
    if (remaining <= 0) {
      return { ok: false, missing: ['remaining life hours (expected life hours must exceed current engine hours)'] };
    }
    var perHour = (currentValue - eolValue) / remaining;
    return { ok: true, value: perHour < 0 ? 0 : perHour };
  }

  function calcDepreciationPerKm(asset, currentOdometer) {
    var odo = currentOdometer !== undefined && currentOdometer !== null
      ? num(currentOdometer) : num(asset.current_odometer);
    var missing = getMissingDepreciationFields(asset, { currentOdometer: odo });
    if (missing.length) return { ok: false, missing: missing };
    var currentValue = num(asset.current_value);
    var eolValue = num(asset.estimated_end_of_life_value);
    var lifeKm = num(asset.expected_life_km);
    var remaining = lifeKm - odo;
    if (remaining <= 0) {
      return { ok: false, missing: ['remaining life km (expected life km must exceed current odometer)'] };
    }
    var perKm = (currentValue - eolValue) / remaining;
    return { ok: true, value: perKm < 0 ? 0 : perKm };
  }

  function calcAnnualUsageHours(asset) {
    var avail = num(asset.available_hours_per_week);
    var target = num(asset.target_utilisation_percent);
    if (avail === null || target === null) return null;
    return avail * 52 * (target / 100);
  }

  function calcMaintenancePerHour(asset) {
    var missing = getMissingMaintenanceFields(asset);
    if (missing.length) return { ok: false, missing: missing };
    var annualUsage = calcAnnualUsageHours(asset);
    if (annualUsage === null || annualUsage <= 0) {
      return { ok: false, missing: ['estimated annual usage (set Available Hours Per Week and Target Utilisation Percent)'] };
    }
    return { ok: true, value: num(asset.estimated_annual_repair_cost) / annualUsage };
  }

  function calcMaintenancePerKm(asset) {
    var missing = getMissingMaintenanceFields(asset);
    if (missing.length) return { ok: false, missing: missing };
    var annualKm = num(asset.estimated_annual_km);
    if (annualKm === null || annualKm <= 0) {
      return { ok: false, missing: ['Estimated Annual KM'] };
    }
    return { ok: true, value: num(asset.estimated_annual_repair_cost) / annualKm };
  }

  function getServicingPerHour(asset) {
    var missing = getMissingServicingFields(asset);
    if (missing.length) return { ok: false, missing: missing };
    return { ok: true, value: num(asset.service_cost_per_hour) };
  }

  function getServicingPerKm(asset) {
    var missing = getMissingServicingFields(asset);
    if (missing.length) return { ok: false, missing: missing };
    return { ok: true, value: num(asset.service_cost_per_km) };
  }

  /** Idle-hour cost breakdown (construction: all four apply per idle hour; on-road: fuel only during idle). */
  function calcIdleHourCosts(asset, idleHours, avgCostPerLitre, idleRate, totalEngineHours) {
    idleHours = idleHours || 0;
    idleRate = idleRate || 0;
    avgCostPerLitre = avgCostPerLitre || 0;

    var result = {
      fuel: idleHours * idleRate * avgCostPerLitre,
      depreciation: null,
      servicing: null,
      maintenance: null,
      depreciationMissing: null,
      servicingMissing: null,
      maintenanceMissing: null
    };

    if (isOnRoad(asset)) {
      var deprKm = calcDepreciationPerKm(asset);
      result.depreciationMissing = deprKm.ok ? null : deprKm.missing;
      result.depreciation = deprKm.ok ? 0 : null;

      var servKm = getServicingPerKm(asset);
      result.servicingMissing = servKm.ok ? null : servKm.missing;
      result.servicing = servKm.ok ? 0 : null;

      var maintKm = calcMaintenancePerKm(asset);
      result.maintenanceMissing = maintKm.ok ? null : maintKm.missing;
      result.maintenance = maintKm.ok ? 0 : null;
    } else {
      var deprHr = calcDepreciationPerHour(asset, totalEngineHours);
      result.depreciationMissing = deprHr.ok ? null : deprHr.missing;
      result.depreciation = deprHr.ok ? idleHours * deprHr.value : null;

      var servHr = getServicingPerHour(asset);
      result.servicingMissing = servHr.ok ? null : servHr.missing;
      result.servicing = servHr.ok ? idleHours * servHr.value : null;

      var maintHr = calcMaintenancePerHour(asset);
      result.maintenanceMissing = maintHr.ok ? null : maintHr.missing;
      result.maintenance = maintHr.ok ? idleHours * maintHr.value : null;
    }

    result.total = result.fuel +
      (result.depreciation !== null ? result.depreciation : 0) +
      (result.servicing !== null ? result.servicing : 0) +
      (result.maintenance !== null ? result.maintenance : 0);

    result.hasMissing = !!(result.depreciationMissing || result.servicingMissing || result.maintenanceMissing);
    return result;
  }

  /** Per-km running cost components for on-road vehicles. */
  function calcRunningCostPerKm(asset, fuelCostPerKm, currentOdometer) {
    var out = {
      fuel: fuelCostPerKm,
      depreciation: null,
      servicing: null,
      maintenance: null,
      total: null,
      depreciationMissing: null,
      servicingMissing: null,
      maintenanceMissing: null
    };

    var depr = calcDepreciationPerKm(asset, currentOdometer);
    out.depreciationMissing = depr.ok ? null : depr.missing;
    out.depreciation = depr.ok ? depr.value : null;

    var serv = getServicingPerKm(asset);
    out.servicingMissing = serv.ok ? null : serv.missing;
    out.servicing = serv.ok ? serv.value : null;

    var maint = calcMaintenancePerKm(asset);
    out.maintenanceMissing = maint.ok ? null : maint.missing;
    out.maintenance = maint.ok ? maint.value : null;

    if (out.depreciation !== null && out.servicing !== null && out.maintenance !== null && out.fuel !== null && !isNaN(out.fuel)) {
      out.total = out.fuel + out.depreciation + out.servicing + out.maintenance;
    }
    return out;
  }

  function getLatestEngineHours(telRows, assetId) {
    var rows = (telRows || []).filter(function(r) { return Number(r.asset_id) === Number(assetId); });
    if (!rows.length) return null;
    rows.sort(function(a, b) { return String(b.record_date).localeCompare(String(a.record_date)); });
    for (var i = 0; i < rows.length; i++) {
      var h = num(rows[i].total_engine_hours);
      if (h !== null) return h;
    }
    return null;
  }

  function costOrMissing(value, missingFields, fmtFn) {
    if (missingFields && missingFields.length) {
      return { text: formatMissingMessage(missingFields), isMissing: true };
    }
    if (value === null || value === undefined) {
      return { text: '—', isMissing: false };
    }
    return { text: fmtFn ? fmtFn(value) : String(value), isMissing: false };
  }

  global.FleetCostModel = {
    ON_ROAD_TYPES: ON_ROAD_TYPES,
    isOnRoad: isOnRoad,
    num: num,
    formatMissingMessage: formatMissingMessage,
    getMissingDepreciationFields: getMissingDepreciationFields,
    getMissingMaintenanceFields: getMissingMaintenanceFields,
    getMissingServicingFields: getMissingServicingFields,
    calcDepreciationPerHour: calcDepreciationPerHour,
    calcDepreciationPerKm: calcDepreciationPerKm,
    calcMaintenancePerHour: calcMaintenancePerHour,
    calcMaintenancePerKm: calcMaintenancePerKm,
    getServicingPerHour: getServicingPerHour,
    getServicingPerKm: getServicingPerKm,
    calcAnnualUsageHours: calcAnnualUsageHours,
    calcIdleHourCosts: calcIdleHourCosts,
    calcRunningCostPerKm: calcRunningCostPerKm,
    getLatestEngineHours: getLatestEngineHours,
    costOrMissing: costOrMissing
  };
})(window);
