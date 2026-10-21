/**
 * Divisional manager gating: chip, switcher, blocked pages, settings source.
 *
 *   node scripts/test-division-manager.js
 */
var assert = require('assert');
var filter = require('../js/division-filter');
var manager = require('../js/division-manager');
var settings = require('../js/account-settings');

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

var north = { id: 10, name: 'North' };
var south = { id: 20, name: 'South' };
var one = {
  isDivisionManager: true,
  hasDivisions: true,
  canEditAssets: false,
  divisions: [north]
};
var two = {
  isDivisionManager: true,
  hasDivisions: true,
  canEditAssets: true,
  divisions: [north, south]
};
var owner = {
  isDivisionManager: false,
  isOwner: true,
  hasDivisions: true,
  divisions: [north, south]
};

console.log('\n=== Chip and switcher ===');
check('One division is named on the chip', filter.chipLabel(one) === 'Division: North');
check('Several divisions are listed on the chip', filter.chipLabel(two) === 'Division: North, South');
check('A manager with no division still gets a chip', filter.chipLabel({
  isDivisionManager: true,
  divisions: []
}) === 'Division: none assigned');
check('Owners do not get a division chip', filter.chipLabel(owner) === '');
check('One division does not show a switcher', filter.showsSwitcher(one) === false);
check('Several divisions show a switcher', filter.showsSwitcher(two) === true);
check('The owner filter is not the manager switcher', filter.shouldShow(two) === false && filter.shouldShow(owner) === true);

var assets = [
  { id: 1, division_id: 10 },
  { id: 2, division_id: 20 }
];
check('All still returns the same asset array', filter.filterAssets(assets, '') === assets);
check('A manager switch value keeps one division', filter.filterAssets(assets, '20').length === 1);

console.log('\n=== Blocked pages ===');
['upload.html', 'settings.html', 'integrations.html', 'divisions.html', 'bulk-import.html'].forEach(function(page) {
  check(page + ' is blocked for a manager', manager.isBlockedPage(page));
});
check('Home is not blocked', manager.isBlockedPage('home.html') === false);
check('Assets is not blocked', manager.isBlockedPage('assets.html') === false);
check('redirectIfBlocked sends a manager home', manager.redirectIfBlocked(one, 'settings.html') === true);
check('redirectIfBlocked leaves an owner on settings', manager.redirectIfBlocked(owner, 'settings.html') === false);
check('redirectIfBlocked leaves a manager on the overview', manager.redirectIfBlocked(one, 'home.html') === false);

console.log('\n=== Settings source ===');
check('A manager reads the division settings function', settings.settingsSource(one) === 'rpc');
check('An owner reads user_settings', settings.settingsSource(owner) === 'table');
check('A full-access member reads user_settings', settings.settingsSource({
  isDivisionManager: false,
  effectiveAccountId: 'owner'
}) === 'table');

function fakeSupabase(rpcRow, tableRow) {
  return {
    rpc: function(name) {
      assert.strictEqual(name, 'get_division_account_settings');
      return Promise.resolve({ data: rpcRow, error: null });
    },
    from: function(table) {
      assert.strictEqual(table, 'user_settings');
      var api = {
        select: function() { return api; },
        eq: function() { return api; },
        maybeSingle: function() { return Promise.resolve({ data: tableRow, error: null }); }
      };
      return api;
    }
  };
}

settings.readMachineryFuelCost(fakeSupabase([{ machinery_fuel_cost_per_litre: '2.4' }], null), one)
  .then(function(value) {
    check('The manager price comes from the function result', value === 2.4);
    return settings.readMachineryFuelCost(fakeSupabase(null, { machinery_fuel_cost_per_litre: 3 }), owner);
  })
  .then(function(value) {
    check('The owner price comes from user_settings', value === 3);
    console.log('\nAll division manager tests passed.');
  })
  .catch(function(err) {
    console.error(err);
    process.exit(1);
  });
