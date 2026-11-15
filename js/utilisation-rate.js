/**
 * Fleet utilisation rate for one asset over one period.
 * Money is NZD. This returns full-precision numbers. Round only when displaying.
 *
 * Required: hoursAvailable (greater than zero), hoursWorked (zero or more,
 * and not more than hours available).
 * Optional inputs left blank are left out: targetRatePercent, owningCost.
 */
function fleetUtilisation(input) {
  input = input || {};

  function problem(value) {
    if (value && typeof value === 'object' && value.error) return value;
    return null;
  }

  function hoursAvailable(value) {
    if (value == null || String(value).trim() === '') {
      return { error: 'Enter the hours the asset was available.' };
    }
    var n = Number(value);
    if (!isFinite(n) || n <= 0) {
      return { error: 'Enter the hours the asset was available.' };
    }
    return n;
  }

  function hoursWorked(value) {
    if (value == null || String(value).trim() === '') {
      return { error: 'Enter the hours the asset worked.' };
    }
    var n = Number(value);
    if (!isFinite(n) || n < 0) {
      return { error: 'Enter the hours the asset worked.' };
    }
    return n;
  }

  function optionalNumber(value, label) {
    if (value == null || String(value).trim() === '') return null;
    var n = Number(value);
    if (!isFinite(n)) return { error: label + ' needs a number.' };
    if (n < 0) return { error: label + ' cannot be negative.' };
    return n;
  }

  var available = hoursAvailable(input.hoursAvailable);
  var availableError = problem(available);
  if (availableError) return availableError;

  var worked = hoursWorked(input.hoursWorked);
  var workedError = problem(worked);
  if (workedError) return workedError;

  if (worked > available) {
    return { error: 'Hours worked is more than hours available. Check your figures.' };
  }

  var target = optionalNumber(input.targetRatePercent, 'Target utilisation rate');
  var targetError = problem(target);
  if (targetError) return targetError;

  var cost = optionalNumber(input.owningCost, 'Owning cost');
  var costError = problem(cost);
  if (costError) return costError;

  var utilisationRatePercent = (worked / available) * 100;
  var result = { utilisationRatePercent: utilisationRatePercent };

  if (target != null) {
    result.variancePoints = utilisationRatePercent - target;
    result.hoursToTarget = ((target / 100) * available) - worked;
  }

  if (cost != null) {
    result.owningCostPerAvailableHour = cost / available;
    result.costOfUnusedHours = cost * (1 - (utilisationRatePercent / 100));
    if (worked > 0) result.owningCostPerWorkedHour = cost / worked;
  }

  var keys = Object.keys(result);
  for (var i = 0; i < keys.length; i++) {
    if (!isFinite(result[keys[i]])) {
      return { error: 'Enter the hours the asset was available.' };
    }
  }

  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = fleetUtilisation;
}
