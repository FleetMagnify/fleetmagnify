/**
 * Pages a divisional manager must not open. Settings has no password form,
 * so the whole settings page (billing, team, fuel price) redirects home.
 */
(function(global) {
  var BLOCKED_PAGES = [
    'upload.html',
    'settings.html',
    'integrations.html',
    'divisions.html',
    'bulk-import.html'
  ];

  function isBlockedPage(page) {
    return BLOCKED_PAGES.indexOf(page) !== -1;
  }

  function redirectIfBlocked(account, page) {
    if (!account || !account.isDivisionManager || !isBlockedPage(page)) return false;
    if (global.location) global.location.href = 'home.html';
    return true;
  }

  var api = {
    BLOCKED_PAGES: BLOCKED_PAGES,
    isBlockedPage: isBlockedPage,
    redirectIfBlocked: redirectIfBlocked
  };

  global.FleetMagnifyDivisionManager = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
