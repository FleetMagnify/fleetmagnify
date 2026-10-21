/**
 * Browser edit gates for team permission ticks.
 *
 * canEditJobs covers jobs and job_assets.
 * canEditAssets covers truck_payloads, truck_cost_overrides, and
 * vehicle_id_aliases.
 *
 * Owners and divisional managers already have those flags resolved in
 * account-context.js (owner always true, a manager's canEditJobs always
 * false). This module only reads the resolved flags and turns a refused
 * write into a short message.
 */
(function(global) {
  var PERMISSION_DENIED = "You don't have permission to change this";

  function canEditJobs(account) {
    return !!(account && account.canEditJobs === true);
  }

  function canEditAssets(account) {
    return !!(account && account.canEditAssets === true);
  }

  function errorCode(error) {
    if (!error || error.code == null) return '';
    return String(error.code);
  }

  function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return [error.message, error.details, error.hint].filter(function(part) {
      return part != null && String(part).trim() !== '';
    }).join(' ');
  }

  function isPermissionError(error) {
    if (!error) return false;
    if (errorCode(error) === '42501') return true;
    var msg = errorText(error).toLowerCase();
    if (!msg) return false;
    return msg.indexOf('row-level security') !== -1
      || msg.indexOf('permission denied') !== -1
      || msg.indexOf('insufficient privilege') !== -1;
  }

  /**
   * Permission refusals become PERMISSION_DENIED.
   * Any other error keeps its message, with an optional prefix
   * (for example "Failed to delete job: ").
   * An empty error still returns a sentence so the screen does not
   * fail silently.
   */
  function writeErrorMessage(error, prefix) {
    if (isPermissionError(error)) return PERMISSION_DENIED;
    var msg = '';
    if (error && typeof error !== 'string' && error.message) msg = String(error.message);
    else if (typeof error === 'string') msg = error;
    if (msg) return prefix ? prefix + msg : msg;
    if (prefix) return prefix;
    return PERMISSION_DENIED;
  }

  var api = {
    PERMISSION_DENIED: PERMISSION_DENIED,
    canEditJobs: canEditJobs,
    canEditAssets: canEditAssets,
    isPermissionError: isPermissionError,
    writeErrorMessage: writeErrorMessage
  };

  global.FleetMagnifyEditPermissions = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
