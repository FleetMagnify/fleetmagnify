/**
 * Division select for owner and full-access member analyst pages.
 *
 * "All" returns the same asset array the page already loaded, so totals stay
 * identical to an account with the filter absent. A chosen division or
 * Unassigned is applied to that list before any calculation.
 *
 * The choice is kept in sessionStorage. A ?division= link (from Division
 * comparison) wins for that visit and is then stored. Storage access is
 * wrapped so a blocked sessionStorage does not break the page.
 *
 * Divisional managers do not get this control: their rows are already limited
 * to the divisions they manage.
 */
(function(global) {
  var STORAGE_KEY = 'fleetmagnify.divisionFilter';
  var UNASSIGNED = 'unassigned';
  var pageSelectionCache = null;

  function shouldShow(account) {
    return !!(account && account.hasDivisions && !account.isDivisionManager);
  }

  function normaliseSelection(raw, divisions) {
    if (raw == null) return '';
    var value = String(raw).trim();
    if (value === '' || value.toLowerCase() === 'all') return '';
    if (value.toLowerCase() === UNASSIGNED) return UNASSIGNED;
    var known = (divisions || []).some(function(division) {
      return division && String(division.id) === value;
    });
    return known ? value : '';
  }

  function matches(asset, selection) {
    if (!selection || selection === 'all') return true;
    var divisionId = asset && asset.division_id != null && asset.division_id !== ''
      ? String(asset.division_id)
      : '';
    if (selection === UNASSIGNED) return divisionId === '';
    return divisionId === String(selection);
  }

  /**
   * selection '' or 'all' returns the same array reference.
   */
  function filterAssets(assets, selection) {
    if (!assets) return assets;
    if (selection == null || selection === '' || selection === 'all') return assets;
    return assets.filter(function(asset) { return matches(asset, selection); });
  }

  function safeGet(storage) {
    if (!storage) return null;
    try { return storage.getItem(STORAGE_KEY); }
    catch (e) { return null; }
  }

  function safeSet(storage, value) {
    if (!storage) return;
    try { storage.setItem(STORAGE_KEY, value); }
    catch (e) { /* private mode or blocked storage */ }
  }

  function safeRemove(storage) {
    if (!storage) return;
    try { storage.removeItem(STORAGE_KEY); }
    catch (e) { /* private mode or blocked storage */ }
  }

  function remember(storage, normalised) {
    if (normalised) safeSet(storage, normalised);
    else safeRemove(storage);
  }

  /**
   * urlValue undefined reads storage. A provided urlValue (including '') wins
   * and is written back when storage allows it.
   */
  function selectionFromStorage(storage, divisions, urlValue) {
    var raw = urlValue !== undefined ? urlValue : safeGet(storage);
    var normalised = normaliseSelection(raw, divisions);
    if (urlValue !== undefined) remember(storage, normalised);
    return normalised;
  }

  function browserStorage() {
    try { return global.sessionStorage || null; }
    catch (e) { return null; }
  }

  function urlDivision() {
    try {
      if (!global.location) return undefined;
      var params = new URLSearchParams(global.location.search);
      if (!params.has('division')) return undefined;
      return params.get('division');
    } catch (e) {
      return undefined;
    }
  }

  function stripUrlDivision() {
    try {
      if (!global.history || !global.location) return;
      var url = new URL(global.location.href);
      if (!url.searchParams.has('division')) return;
      url.searchParams.delete('division');
      var next = url.pathname + url.search + url.hash;
      global.history.replaceState(null, '', next);
    } catch (e) { /* keep the query; storage already has the choice */ }
  }

  function pageSelection(divisions) {
    if (pageSelectionCache !== null) return pageSelectionCache;
    var fromUrl = urlDivision();
    var storage = browserStorage();
    if (fromUrl !== undefined) {
      pageSelectionCache = selectionFromStorage(storage, divisions, fromUrl);
      stripUrlDivision();
      return pageSelectionCache;
    }
    pageSelectionCache = selectionFromStorage(storage, divisions);
    return pageSelectionCache;
  }

  function apply(assets, account) {
    if (!shouldShow(account)) return assets;
    return filterAssets(assets, pageSelection(account.divisions || []));
  }

  function assetIdSet(assets, account) {
    if (!shouldShow(account)) return null;
    var selection = pageSelection(account.divisions || []);
    if (!selection) return null;
    var ids = {};
    (assets || []).forEach(function(asset) {
      if (asset && asset.id != null) ids[String(asset.id)] = true;
    });
    return ids;
  }

  function restrictByAssetId(rows, idSet, field) {
    if (!idSet) return rows;
    field = field || 'asset_id';
    return (rows || []).filter(function(row) {
      return !!(row && idSet[String(row[field])]);
    });
  }

  function touchingJobIds(rows, idSet) {
    if (!idSet) return null;
    var ids = {};
    (rows || []).forEach(function(row) {
      if (!row || row.job_id == null) return;
      if (!idSet[String(row.asset_id)]) return;
      ids[String(row.job_id)] = true;
    });
    return ids;
  }

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('division-filter-style')) return;
    var style = document.createElement('style');
    style.id = 'division-filter-style';
    style.textContent = [
      '.division-filter-wrap { display: flex; align-items: center; gap: 10px; margin: 0 0 22px; }',
      '.division-filter-wrap label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #6B7785; }',
      '#division-filter { background: #111827; border: 1px solid #2D3748; color: #F0F2F5; border-radius: 8px; padding: 8px 32px 8px 12px; font-family: inherit; font-size: 13px; min-width: 180px; cursor: pointer; }',
      '#division-filter:focus { outline: none; border-color: rgba(14,165,122,0.45); }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function reloadWithoutDivisionParam() {
    try {
      var url = new URL(global.location.href);
      url.searchParams.delete('division');
      global.location.href = url.pathname + url.search + url.hash;
    } catch (e) {
      global.location.reload();
    }
  }

  function mount(account) {
    if (!shouldShow(account) || typeof document === 'undefined') return false;
    if (document.getElementById('division-filter-wrap')) return true;
    var anchor = document.querySelector('.page-content .page-sub') ||
      document.querySelector('.page-content h1.page-title');
    if (!anchor || !anchor.parentNode) return false;
    ensureStyles();
    var divisions = account.divisions || [];
    var selection = pageSelection(divisions);
    var wrap = document.createElement('div');
    wrap.id = 'division-filter-wrap';
    wrap.className = 'division-filter-wrap';
    var label = document.createElement('label');
    label.htmlFor = 'division-filter';
    label.textContent = 'Division';
    var select = document.createElement('select');
    select.id = 'division-filter';
    select.setAttribute('aria-label', 'Division');

    function addOption(value, text) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }

    addOption('', 'All');
    divisions.forEach(function(division) {
      addOption(String(division.id), division.name || 'Division');
    });
    addOption(UNASSIGNED, 'Unassigned');
    select.value = selection || '';
    select.addEventListener('change', function() {
      var next = normaliseSelection(select.value, divisions);
      remember(browserStorage(), next);
      pageSelectionCache = next;
      reloadWithoutDivisionParam();
    });
    wrap.appendChild(label);
    wrap.appendChild(select);
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    return true;
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    UNASSIGNED: UNASSIGNED,
    shouldShow: shouldShow,
    normaliseSelection: normaliseSelection,
    filterAssets: filterAssets,
    selectionFromStorage: selectionFromStorage,
    apply: apply,
    assetIdSet: assetIdSet,
    restrictByAssetId: restrictByAssetId,
    touchingJobIds: touchingJobIds,
    mount: mount
  };

  global.FleetMagnifyDivisionFilter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
