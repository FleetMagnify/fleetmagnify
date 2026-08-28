/**
 * Idle rate source labels: last_calibrated_at is travel-only.
 *
 *   node scripts/test-idle-rate-label.js
 */
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
