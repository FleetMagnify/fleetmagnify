/**
 * Idle rate source labels: last_calibrated_at is travel-only.
 *
 *   node scripts/test-idle-rate-label.js
 */
var fs = require('fs');
var path = require('path');
var FCM = require('../js/fleet-cost-model');
var fuelReg = require('../lib/fuel-regression');

var pass = true;
function check(label, condition, detail) {
  var status = condition ? 'PASS' : 'FAIL';
  if (!condition) pass = false;
  console.log('[' + status + '] ' + label + (detail ? ' — ' + detail : ''));
}

var argosy = {
  asset_name: 'Freightliner Argosy Low Loader',
  asset_type: 'Semi Trailer',
  last_calibrated_at: '2026-08-28T00:00:00Z'
};

var idleNull = FCM.resolvedIdleRate(Object.assign({}, argosy, { idle_burn_rate_lph: null }));
check(
  'Argosy idle null + travel timestamp → Default estimate 3.00',
  idleNull.source === 'default' && idleNull.label === 'Default estimate' && idleNull.rate === 3,
  JSON.stringify(idleNull)
);

var staleDefault = FCM.resolvedIdleRate(Object.assign({}, argosy, {
  idle_burn_rate_lph: 3.0
}));
check(
  'Argosy leftover 3.00 + last_calibrated_at is NOT Calibrated',
  staleDefault.source !== 'calibrated' && staleDefault.label !== 'Calibrated',
  JSON.stringify(staleDefault)
);

var genuine = FCM.resolvedIdleRate(Object.assign({}, argosy, {
  idle_burn_rate_lph: 3.0,
  idle_rate_source: 'calibrated'
}));
check(
  'Kenworth-style 3.00 with idle_rate_source=calibrated stays Calibrated',
  genuine.source === 'calibrated' && genuine.label === 'Calibrated' && genuine.rate === 3,
  JSON.stringify(genuine)
);

var setOnAsset = FCM.resolvedIdleRate({
  asset_type: 'Rigid Truck',
  idle_burn_rate_lph: 2.1,
  last_calibrated_at: '2026-08-28T00:00:00Z'
});
check(
  'Stored plausible idle without idle_rate_source → Set on asset (travel timestamp ignored)',
  setOnAsset.source === 'set' && setOnAsset.label === 'Set on asset',
  JSON.stringify(setOnAsset)
);

var measured = FCM.resolvedIdleRate({
  asset_type: 'Excavator',
  idle_burn_rate_lph: 4.25,
  idle_rate_source: 'measured'
});
check(
  'Machinery measured rate keeps the stored value and Measured from VisionLink',
  measured.source === 'measured' &&
    measured.label === 'Measured from VisionLink' &&
    measured.rate === 4.25,
  JSON.stringify(measured)
);
check(
  'Measured label renders as 3.50 L/hr (measured from VisionLink)',
  FCM.formatIdleRate(3.5) + ' L/hr (' + FCM.formatIdleRateLabel(measured.label) + ')' ===
    '3.50 L/hr (measured from VisionLink)',
  FCM.formatIdleRateLabel(measured.label)
);
check(
  'Other idle labels still lowercase inside the rate parentheses',
  FCM.formatIdleRateLabel('Set on asset') === 'set on asset' &&
    FCM.formatIdleRateLabel('Calibrated') === 'calibrated' &&
    FCM.formatIdleRateLabel('Default estimate') === 'default estimate'
);

var fuelPage = fs.readFileSync(path.join(__dirname, '../fuel-analyst.html'), 'utf8');
var truckFuelPage = fs.readFileSync(path.join(__dirname, '../truck-fuel-analyst.html'), 'utf8');
check(
  'Fuel Analyst does not lowercase the whole idle label',
  fuelPage.indexOf('idle.label.toLowerCase') === -1 &&
    fuelPage.indexOf('FCM.formatIdleRateLabel(idle.label)') !== -1
);
check(
  'Truck Fuel Analyst keeps VisionLink capitalised when it shows a measured rate',
  truckFuelPage.indexOf('idle.label.toLowerCase') === -1 &&
    truckFuelPage.indexOf('FCM.formatIdleRateLabel(idle.label)') !== -1
);

var measuredTrimmed = FCM.resolvedIdleRate({
  asset_type: 'Excavator',
  idle_burn_rate_lph: 4.25,
  idle_rate_source: ' Measured '
});
check(
  'Measured source is matched case-insensitively',
  measuredTrimmed.source === 'measured' && measuredTrimmed.label === 'Measured from VisionLink',
  JSON.stringify(measuredTrimmed)
);

var measuredOutOfBand = FCM.resolvedIdleRate({
  asset_type: 'Excavator',
  idle_burn_rate_lph: 20,
  idle_rate_source: 'measured'
});
check(
  'Measured rate outside the existing machinery band falls back to the class default',
  measuredOutOfBand.source === 'default' &&
    measuredOutOfBand.label === 'Default estimate' &&
    measuredOutOfBand.rate === 4,
  JSON.stringify(measuredOutOfBand)
);

var implausible = FCM.resolvedIdleRate(Object.assign({}, argosy, {
  idle_burn_rate_lph: 0.059,
  last_calibrated_at: '2026-08-28T00:00:00Z'
}));
check(
  'Historical Argosy 0.059 L/hr is out of band → Default estimate',
  implausible.source === 'default' && implausible.rate === 3,
  JSON.stringify(implausible)
);

var argosyFit = {
  calibrated: true,
  idleRateLph: 1.623,
  totalIdleHours: 10.4
};
var argosyDecision = fuelReg.idleStoreDecision(argosy, argosyFit);
check(
  'Argosy 1.62 L/hr residual is not stored (intermittent + too few idle hours)',
  argosyDecision.store === false &&
    (argosyDecision.reason === 'intermittent' || argosyDecision.reason === 'insufficient_idle_hours'),
  JSON.stringify(argosyDecision)
);

var kenworthDecision = fuelReg.idleStoreDecision(
  { asset_name: 'Kenworth T610', asset_type: 'Truck & Trailer' },
  { calibrated: true, idleRateLph: 3.0007, totalIdleHours: 93.7 }
);
check(
  'Kenworth 3.00 L/hr residual is stored as calibrated',
  kenworthDecision.store === true && kenworthDecision.idleRateLph === 3.0007,
  JSON.stringify(kenworthDecision)
);

// One-variable km OLS on intermittent km-correlated idle squeezes residual toward 0.
var intervals = [];
for (var i = 1; i <= 10; i++) {
  var km = 400 + i * 80;
  var idleH = km / 52 * 0.9; // idle hours track distance
  var litres = km * 0.455 + idleH * 3.0;
  intervals.push({ distanceKm: km, idleHours: idleH, litres: litres, included: true });
}
var fit = fuelReg.calibrateAsset(intervals, null);
check('synthetic Argosy-like data calibrates travel', fit.calibrated === true, 'travel=' + fit.travelRateLpk);
check(
  'synthetic Argosy-like residual is far below 3.00 (structurally squeezed)',
  fit.idleRateLph != null && fit.idleRateLph < 1.3,
  'idle=' + fit.idleRateLph
);
var bounds = fuelReg.IDLE_CLASS_TABLE.standard_truck.boundsLph;
check(
  'that residual is outside the standard_truck band and must not be stored',
  fit.idleRateLph < bounds[0] || fit.idleRateLph > bounds[1],
  'band=' + bounds.join('–') + ' idle=' + fit.idleRateLph
);

console.log('');
console.log(pass ? 'ALL IDLE-LABEL TESTS PASSED' : 'SOME IDLE-LABEL TESTS FAILED');
process.exit(pass ? 0 : 1);
