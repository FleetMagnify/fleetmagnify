/**
 * Owning and operating cost per hour for one machine.
 * Money is NZD. This returns full-precision numbers. Round only when displaying.
 *
 * Required: purchasePrice, resaleValue, hoursPerYear, yearsKept,
 * workingBurnLph, fuelPrice, servicingPerHour.
 * Optional inputs left blank count as 0: interestRatePercent, insurancePerYear,
 * tracksCost, tracksHours, idleSharePercent, idleBurnLph, operatorPerHour.
 *
 * Hours per year, years kept, and working burn must be greater than zero.
 */
function machineOperatingCost(input) {
  input = input || {};

  function requiredNumber(value, label, allowZero) {
    if (value == null || value === '') return { error: 'Enter ' + label + '.' };
    var n = Number(value);
    if (!isFinite(n)) return { error: label + ' needs a number.' };
    if (n < 0) return { error: label + ' cannot be negative.' };
    if (!allowZero && n === 0) return { error: 'Enter ' + label + '.' };
    return n;
  }

  function optionalNumber(value, label) {
    if (value == null || value === '') return 0;
    var n = Number(value);
    if (!isFinite(n)) return { error: label + ' needs a number.' };
    if (n < 0) return { error: label + ' cannot be negative.' };
    return n;
  }

  function take(value) {
    if (value && typeof value === 'object' && value.error) return value;
    return null;
  }

  var purchasePrice = requiredNumber(input.purchasePrice, 'the purchase price', true);
  var resaleValue = requiredNumber(input.resaleValue, 'the resale value', true);
  var hoursPerYear = requiredNumber(input.hoursPerYear, 'the hours it works per year', false);
  var yearsKept = requiredNumber(input.yearsKept, 'how long you keep it', false);
  var workingBurnLph = requiredNumber(input.workingBurnLph, 'the working fuel burn', false);
  var fuelPrice = requiredNumber(input.fuelPrice, 'the fuel price', true);
  var servicingPerHour = requiredNumber(input.servicingPerHour, 'servicing and repairs per hour', true);
  var interestRatePercent = optionalNumber(input.interestRatePercent, 'the interest rate');
  var insurancePerYear = optionalNumber(input.insurancePerYear, 'insurance and registration');
  var tracksCost = optionalNumber(input.tracksCost, 'the tracks or tyres cost');
  var tracksHours = optionalNumber(input.tracksHours, 'the hours a set of tracks or tyres lasts');
  var idleSharePercent = optionalNumber(input.idleSharePercent, 'the idle share');
  var idleBurnLph = optionalNumber(input.idleBurnLph, 'the idle fuel burn');
  var operatorPerHour = optionalNumber(input.operatorPerHour, 'the operator wage');

  var fields = [
    purchasePrice, resaleValue, hoursPerYear, yearsKept, workingBurnLph,
    fuelPrice, servicingPerHour, interestRatePercent, insurancePerYear,
    tracksCost, tracksHours, idleSharePercent, idleBurnLph, operatorPerHour
  ];
  for (var i = 0; i < fields.length; i++) {
    var problem = take(fields[i]);
    if (problem) return problem;
  }

  if (idleSharePercent > 100) {
    return { error: 'Idle share cannot be more than 100%.' };
  }
  if (tracksCost > 0 && tracksHours === 0) {
    return { error: 'Enter how many hours a set of tracks or tyres lasts.' };
  }

  var lifeHours = hoursPerYear * yearsKept;
  var averageInvestment = (purchasePrice + resaleValue) / 2;
  var depreciationPerHour = (purchasePrice - resaleValue) / lifeHours;
  var financePerHour = (interestRatePercent / 100) * averageInvestment / hoursPerYear;
  var insurancePerHour = insurancePerYear / hoursPerYear;
  var owningPerHour = depreciationPerHour + financePerHour + insurancePerHour;

  var idleShare = idleSharePercent / 100;
  var workingShare = 1 - idleShare;
  var averageBurnLph = (workingShare * workingBurnLph) + (idleShare * idleBurnLph);
  var fuelPerHour = averageBurnLph * fuelPrice;
  var idleFuelPerHour = idleShare * idleBurnLph * fuelPrice;
  var idleHoursPerYear = idleShare * hoursPerYear;
  var idleLitresPerYear = idleHoursPerYear * idleBurnLph;
  var idleFuelPerYear = idleLitresPerYear * fuelPrice;
  var tracksPerHour = tracksHours > 0 ? tracksCost / tracksHours : 0;
  var operatingPerHour = fuelPerHour + servicingPerHour + tracksPerHour + operatorPerHour;

  return {
    lifeHours: lifeHours,
    averageInvestment: averageInvestment,
    depreciationPerHour: depreciationPerHour,
    financePerHour: financePerHour,
    insurancePerHour: insurancePerHour,
    owningPerHour: owningPerHour,
    workingShare: workingShare,
    idleShare: idleShare,
    averageBurnLph: averageBurnLph,
    fuelPerHour: fuelPerHour,
    idleFuelPerHour: idleFuelPerHour,
    idleHoursPerYear: idleHoursPerYear,
    idleLitresPerYear: idleLitresPerYear,
    idleFuelPerYear: idleFuelPerYear,
    servicingPerHour: servicingPerHour,
    tracksPerHour: tracksPerHour,
    operatorPerHour: operatorPerHour,
    operatingPerHour: operatingPerHour,
    totalPerHour: owningPerHour + operatingPerHour
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = machineOperatingCost;
}
