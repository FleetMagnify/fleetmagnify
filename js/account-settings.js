/**
 * Machinery fuel price for analyst pages.
 *
 * Owners and full-access members read user_settings. Divisional managers
 * cannot read that table (it also holds the upload email), so they use
 * get_division_account_settings, which returns only the fuel price.
 * This module does not write user_settings.
 */
(function(global) {
  function settingsSource(account) {
    return account && account.isDivisionManager ? 'rpc' : 'table';
  }

  function priceFrom(value) {
    if (value == null || value === '') return null;
    var number = parseFloat(value);
    return isNaN(number) ? null : number;
  }

  async function readMachineryFuelCost(supabase, account) {
    if (!supabase || !account) return null;
    if (settingsSource(account) === 'rpc') {
      var rpc = await supabase.rpc('get_division_account_settings');
      if (rpc && rpc.error) {
        console.warn('FleetMagnifyAccountSettings: division settings lookup failed', rpc.error.message || rpc.error);
        return null;
      }
      var rows = rpc && rpc.data;
      var row = Array.isArray(rows) ? rows[0] : rows;
      return priceFrom(row && row.machinery_fuel_cost_per_litre);
    }
    var result = await supabase
      .from('user_settings')
      .select('machinery_fuel_cost_per_litre')
      .eq('user_id', account.effectiveAccountId)
      .maybeSingle();
    if (result && result.error) {
      console.warn('FleetMagnifyAccountSettings: user_settings lookup failed', result.error.message || result.error);
      return null;
    }
    return priceFrom(result && result.data && result.data.machinery_fuel_cost_per_litre);
  }

  var api = {
    settingsSource: settingsSource,
    readMachineryFuelCost: readMachineryFuelCost
  };

  global.FleetMagnifyAccountSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
