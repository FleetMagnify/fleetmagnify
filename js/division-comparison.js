/**
 * Division comparison rows.
 *
 * Fuel, running cost per km, idle-hour inputs, and machinery hourly rates
 * come from FleetCostModel. This file only groups those results by division
 * and normalises them (per asset, per km, per operating hour).
 *
 * Every asset is in exactly one row (its division, or Unassigned), so asset
 * counts, litres, fuel cost, and running cost add up to the account row.
 * A job that uses assets in two divisions is counted in both rows; the
 * account jobs figure is the distinct set.
 */
(function(global) {
  var DEFAULT_HOURS_PER_WEEK = 40;
  var RATE_KEYS = [
    'litresPerAsset',
    'fuelPerAsset',
    'costPerKm',
    'costPerHour',
    'idlePct',
    'utilisation',
    'runningPerAsset'
  ];

  function model() {
    return global.FleetCostModel;
  }

  function daysInRange(dateFrom, dateTo) {
    if (!dateFrom || !dateTo) return 0;
    var start = new Date(dateFrom + 'T00:00:00');
    var end = new Date(dateTo + 'T00:00:00');
    var days = Math.round((end - start) / 86400000) + 1;
    return days > 0 ? days : 0;
  }

  function hoursPerWeek(asset) {
    var FCM = model();
    var hours = asset && asset.available_hours_per_week != null
      ? FCM.num(asset.available_hours_per_week)
      : DEFAULT_HOURS_PER_WEEK;
    if (hours === null) return DEFAULT_HOURS_PER_WEEK;
    return hours;
  }

  function blankRow(id, name, kind) {
    return {
      id: id,
      name: name,
      kind: kind,
      assetCount: 0,
      truckCount: 0,
      machineCount: 0,
      litres: 0,
      fuelCost: 0,
      litresPerAsset: null,
      fuelPerAsset: null,
      km: 0,
      ratedKm: 0,
      ratedRunning: 0,
      costPerKm: null,
      operatingHours: 0,
      machineOperatingHours: 0,
      idleHours: 0,
      machineRunning: 0,
      costPerHour: null,
      idlePct: null,
      availableHours: 0,
      utilisation: null,
      runningCost: 0,
      runningPerAsset: null,
      jobs: 0,
      jobIds: {},
      marks: {}
    };
  }

  function groupKey(asset) {
    if (!asset || asset.division_id == null || asset.division_id === '') return 'unassigned';
    return String(asset.division_id);
  }

  function addNumber(row, key, value) {
    row[key] += value || 0;
  }

  function runningForAsset(asset, fuel, km, operatingHours, engineHours) {
    var FCM = model();
    var fuelCost = fuel.cost || 0;
    if (FCM.isOnRoad(asset)) {
      var fuelPerKm = km > 0 ? fuelCost / km : 0;
      var running = FCM.calcRunningCostPerKm(asset, fuelPerKm, asset.current_odometer);
      var perKm = null;
      if (km > 0) {
        if (running.total != null) {
          perKm = running.total;
        } else {
          perKm = fuelPerKm;
          if (running.depreciation != null) perKm += running.depreciation;
          if (running.servicing != null) perKm += running.servicing;
          if (running.maintenance != null) perKm += running.maintenance;
        }
      }
      var period = fuelCost;
      if (km > 0 && running.depreciation != null) period += running.depreciation * km;
      if (km > 0 && running.servicing != null) period += running.servicing * km;
      if (km > 0 && running.maintenance != null) period += running.maintenance * km;
      return { cost: period, perKm: perKm, km: km > 0 ? km : 0, machineHours: 0 };
    }

    var depreciation = FCM.calcDepreciationPerHour(asset, engineHours);
    var servicing = FCM.getServicingPerHour(asset);
    var maintenance = FCM.calcMaintenancePerHour(asset);
    var periodCost = fuelCost;
    if (operatingHours > 0 && depreciation.ok) periodCost += depreciation.value * operatingHours;
    if (operatingHours > 0 && servicing.ok) periodCost += servicing.value * operatingHours;
    if (operatingHours > 0 && maintenance.ok) periodCost += maintenance.value * operatingHours;
    return {
      cost: periodCost,
      perKm: null,
      km: 0,
      machineHours: operatingHours > 0 ? operatingHours : 0
    };
  }

  function contributeAsset(row, asset, input) {
    var FCM = model();
    var telRows = (input.telRows || []).filter(function(rowTel) {
      return Number(rowTel.asset_id) === Number(asset.id);
    });
    var purchaseRows = (input.purchaseRows || []).filter(function(purchase) {
      return Number(purchase.vehicle_id) === Number(asset.id);
    });
    var fuel = FCM.assetFuelTotals(asset, {
      telRows: telRows,
      purchaseRows: purchaseRows,
      machineryCpl: input.machineryCpl
    });
    var operatingHours = 0;
    var idleHours = 0;
    var km = 0;
    telRows.forEach(function(record) {
      operatingHours += parseFloat(record.operating_hours) || 0;
      idleHours += parseFloat(record.idle_hours) || 0;
      km += parseFloat(record.daily_distance_km) || 0;
    });
    var engineHours = FCM.getLatestEngineHours(input.latestTelRows || [], asset.id);
    var weeks = daysInRange(input.dateFrom, input.dateTo) / 7;
    var running = runningForAsset(asset, fuel, km, operatingHours, engineHours);

    row.assetCount += 1;
    addNumber(row, 'litres', fuel.litres);
    addNumber(row, 'fuelCost', fuel.cost);
    addNumber(row, 'operatingHours', operatingHours);
    addNumber(row, 'idleHours', idleHours);
    addNumber(row, 'availableHours', hoursPerWeek(asset) * weeks);
    addNumber(row, 'runningCost', running.cost);
    if (FCM.isOnRoad(asset)) {
      row.truckCount += 1;
      addNumber(row, 'km', km);
      if (running.perKm != null && running.km > 0) {
        addNumber(row, 'ratedKm', running.km);
        addNumber(row, 'ratedRunning', running.perKm * running.km);
      }
    } else {
      row.machineCount += 1;
      if (running.machineHours > 0) {
        addNumber(row, 'machineRunning', running.cost);
        addNumber(row, 'machineOperatingHours', running.machineHours);
      }
    }
  }

  function finalise(row) {
    row.jobs = Object.keys(row.jobIds).length;
    delete row.jobIds;
    row.litresPerAsset = row.assetCount > 0 ? row.litres / row.assetCount : null;
    row.fuelPerAsset = row.assetCount > 0 ? row.fuelCost / row.assetCount : null;
    row.runningPerAsset = row.assetCount > 0 ? row.runningCost / row.assetCount : null;
    row.costPerKm = row.ratedKm > 0 ? row.ratedRunning / row.ratedKm : null;
    row.costPerHour = row.machineOperatingHours > 0 ? row.machineRunning / row.machineOperatingHours : null;
    delete row.ratedKm;
    delete row.ratedRunning;
    var activity = row.idleHours + row.operatingHours;
    row.idlePct = activity > 0 ? (row.idleHours / activity) * 100 : null;
    row.utilisation = row.availableHours > 0 ? (row.operatingHours / row.availableHours) * 100 : null;
    return row;
  }

  function markExtremes(rows) {
    RATE_KEYS.forEach(function(key) {
      var values = [];
      rows.forEach(function(row) {
        if (row[key] != null && isFinite(row[key])) values.push(row[key]);
      });
      if (values.length < 2) return;
      var lowest = Math.min.apply(null, values);
      var highest = Math.max.apply(null, values);
      if (lowest === highest) return;
      rows.forEach(function(row) {
        if (row[key] === lowest) row.marks[key] = 'lowest';
        else if (row[key] === highest) row.marks[key] = 'highest';
      });
    });
  }

  function dateInRange(value, dateFrom, dateTo) {
    if (!value) return false;
    var date = String(value).slice(0, 10);
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return true;
  }

  /**
   * analyst page that matches what is in the division.
   * Trucks only -> cost per km. Machinery only -> fuel analyst. Mixed -> overview.
   */
  function analystHref(row) {
    var page = 'home.html';
    if (row.truckCount > 0 && row.machineCount === 0) page = 'cost-per-km-analyst.html';
    else if (row.machineCount > 0 && row.truckCount === 0) page = 'fuel-analyst.html';
    var division = row.kind === 'unassigned' ? 'unassigned' : String(row.id);
    return page + '?division=' + encodeURIComponent(division);
  }

  function buildDivisionComparison(input) {
    input = input || {};
    var divisions = (input.divisions || []).map(function(division) {
      return { id: division.id, name: division.name || 'Division' };
    });
    var rowsByKey = {};
    var rows = divisions.map(function(division) {
      var row = blankRow(division.id, division.name, 'division');
      rowsByKey[String(division.id)] = row;
      return row;
    });
    var unassigned = blankRow('unassigned', 'Unassigned', 'unassigned');
    rowsByKey.unassigned = unassigned;
    var account = blankRow('account', 'Account total', 'account');
    var assetsById = {};

    (input.assets || []).forEach(function(asset) {
      if (!asset || asset.id == null) return;
      assetsById[String(asset.id)] = asset;
      var key = groupKey(asset);
      var row = rowsByKey[key];
      if (!row) {
        row = blankRow(key, 'Division', 'division');
        rowsByKey[key] = row;
        rows.push(row);
      }
      contributeAsset(row, asset, input);
      contributeAsset(account, asset, input);
    });

    (input.jobRows || []).forEach(function(job) {
      if (!job || job.job_id == null) return;
      var asset = assetsById[String(job.asset_id)];
      if (!asset) return;
      if (!dateInRange(job.work_date, input.dateFrom, input.dateTo)) return;
      var row = rowsByKey[groupKey(asset)];
      if (!row) return;
      row.jobIds[String(job.job_id)] = true;
      account.jobIds[String(job.job_id)] = true;
    });

    rows.push(unassigned);
    rows.forEach(finalise);
    finalise(account);
    markExtremes(rows);
    rows.forEach(function(row) { row.href = analystHref(row); });
    return { rows: rows, account: account };
  }

  var api = {
    DEFAULT_HOURS_PER_WEEK: DEFAULT_HOURS_PER_WEEK,
    RATE_KEYS: RATE_KEYS,
    analystHref: analystHref,
    buildDivisionComparison: buildDivisionComparison
  };

  global.FleetMagnifyDivisionComparison = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
