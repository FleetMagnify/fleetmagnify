/**
 * Fleet utilisation rate.
 * The worked example uses invented figures. No network.
 *
 *   node scripts/test-utilisation-rate.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var fleetUtilisation = require('../js/utilisation-rate');

function money(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function rate(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function assertNoRate(result) {
  assert.ok(result && result.error, 'expected an error object');
  assert.strictEqual(result.utilisationRatePercent, undefined);
  assert.ok(!Object.keys(result).some(function (key) {
    return typeof result[key] === 'number' && !isFinite(result[key]);
  }));
}

var example = fleetUtilisation({
  hoursAvailable: 2600,
  hoursWorked: 1820,
  targetRatePercent: 80,
  owningCost: 48500
});
assert.strictEqual(example.error, undefined);
assert.strictEqual(rate(example.utilisationRatePercent), '70.0');
assert.strictEqual(rate(example.variancePoints), '-10.0');
assert.strictEqual(example.hoursToTarget, 260);
assert.strictEqual(money(example.owningCostPerAvailableHour), '18.65');
assert.strictEqual(money(example.owningCostPerWorkedHour), '26.65');
assert.strictEqual(money(example.costOfUnusedHours), '14550.00');
console.log('[PASS] worked example displays as 70.0%, -10.0 points, 260 hours, $18.65, $26.65, $14,550.00');

var mainOnly = fleetUtilisation({
  hoursAvailable: 2600,
  hoursWorked: 1820
});
assert.strictEqual(mainOnly.error, undefined);
assert.strictEqual(rate(mainOnly.utilisationRatePercent), '70.0');
assert.strictEqual(mainOnly.variancePoints, undefined);
assert.strictEqual(mainOnly.hoursToTarget, undefined);
assert.strictEqual(mainOnly.owningCostPerAvailableHour, undefined);
assert.strictEqual(mainOnly.owningCostPerWorkedHour, undefined);
assert.strictEqual(mainOnly.costOfUnusedHours, undefined);
console.log('[PASS] the two main inputs give 70.0% and none of the optional lines');

var blankOptional = fleetUtilisation({
  hoursAvailable: '2600',
  hoursWorked: '1820',
  targetRatePercent: '',
  owningCost: '  '
});
assert.strictEqual(rate(blankOptional.utilisationRatePercent), '70.0');
assert.strictEqual(blankOptional.variancePoints, undefined);
assert.strictEqual(blankOptional.hoursToTarget, undefined);
assert.strictEqual(blankOptional.owningCostPerWorkedHour, undefined);
assert.strictEqual(blankOptional.costOfUnusedHours, undefined);
console.log('[PASS] a blank target and a blank owning cost leave those lines out');

var zeroAvailable = fleetUtilisation({ hoursAvailable: 0, hoursWorked: 1820 });
assertNoRate(zeroAvailable);
assert.strictEqual(zeroAvailable.error, 'Enter the hours the asset was available.');
var missingAvailable = fleetUtilisation({ hoursWorked: 1820 });
assertNoRate(missingAvailable);
var notANumber = fleetUtilisation({ hoursAvailable: 'abc', hoursWorked: 10 });
assertNoRate(notANumber);
console.log('[PASS] hours available of 0 returns an error object, not NaN or Infinity');

var tooMany = fleetUtilisation({ hoursAvailable: 2600, hoursWorked: 2601 });
assertNoRate(tooMany);
assert.strictEqual(tooMany.error, 'Hours worked is more than hours available. Check your figures.');
console.log('[PASS] hours worked above hours available returns an error object');

var noWork = fleetUtilisation({
  hoursAvailable: 2600,
  hoursWorked: 0,
  owningCost: 48500
});
assert.strictEqual(noWork.error, undefined);
assert.strictEqual(rate(noWork.utilisationRatePercent), '0.0');
assert.strictEqual(money(noWork.costOfUnusedHours), '48500.00');
assert.strictEqual(noWork.owningCostPerWorkedHour, undefined);
assert.strictEqual(noWork.variancePoints, undefined);
console.log('[PASS] zero hours worked keeps a 0.0% rate, the full owning cost as unused, and no cost per worked hour');

var blankWorked = fleetUtilisation({ hoursAvailable: 2600, hoursWorked: '' });
assertNoRate(blankWorked);
var negativeWorked = fleetUtilisation({ hoursAvailable: 2600, hoursWorked: -1 });
assertNoRate(negativeWorked);
console.log('[PASS] blank or negative hours worked returns an error object');

var page = fs.readFileSync(path.join(__dirname, '..', 'fleet-utilisation-rate-formula.html'), 'utf8');
[
  '2,600',
  '1,820',
  '80%',
  '$48,500',
  '70.0%',
  '-10.0',
  '260',
  '$18.65',
  '$26.65',
  '$14,550.00',
  'In this example the machine works 35 of 50 available hours a week, so 30% of its owning cost, $14,550 a year, pays for hours it did not work.'
].forEach(function (figure) {
  assert.ok(page.indexOf(figure) !== -1, 'page is missing ' + figure);
});
console.log('[PASS] the worked-example table on the page shows the same figures');

console.log('All utilisation rate tests passed.');
