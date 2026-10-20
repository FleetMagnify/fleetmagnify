/**
 * Signed-in account identity for app pages.
 *
 * Owners have no account_members row: effectiveAccountId is their own user id.
 * A team member row points effectiveAccountId at account_owner_user_id.
 * That rule matches the previous per-page resolveAccountId copies.
 *
 * scope 'all' is a full-access member. scope 'division' is a divisional
 * manager: divisionIds are only the divisions they manage, and canEditJobs
 * is forced false. An account with no divisions leaves hasDivisions false
 * and divisionIds empty.
 *
 * account_members is read once per page load. divisions is read for the
 * resolved account. division_managers is read only for scope 'division'.
 * A divisions lookup failure does not change effectiveAccountId.
 */
(function(global) {
  var MEMBER_COLUMNS = 'account_owner_user_id, scope, can_edit_assets, can_edit_jobs';
  var cache = null;

  function compareDivisions(a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    var aId = String(a.id);
    var bId = String(b.id);
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return 0;
  }

  function normaliseDivisions(rows) {
    var seen = {};
    var out = [];
    (rows || []).forEach(function(row) {
      if (!row || row.id == null || row.id === '') return;
      var key = String(row.id);
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        id: row.id,
        name: row.name == null ? '' : String(row.name)
      });
    });
    out.sort(compareDivisions);
    return out;
  }

  /**
   * Pure account context. memberRow is the account_members row, or null when
   * the caller is the owner. divisionRows are the account's divisions.
   * managerRows is used only when scope is 'division'.
   */
  function deriveAccountContext(userId, memberRow, divisionRows, managerRows) {
    var ownerId = memberRow && memberRow.account_owner_user_id;
    var effectiveAccountId = ownerId || userId;
    var isOwner = effectiveAccountId === userId;
    var scope = 'all';
    if (!isOwner && memberRow && memberRow.scope === 'division') {
      scope = 'division';
    }
    var isDivisionManager = scope === 'division';
    var canEditAssets = isOwner ? true : !!(memberRow && memberRow.can_edit_assets === true);
    var canEditJobs = isOwner ? true : (isDivisionManager ? false : !!(memberRow && memberRow.can_edit_jobs === true));

    var accountDivisions = normaliseDivisions(divisionRows);
    var divisions = accountDivisions;
    if (isDivisionManager) {
      var managed = {};
      (managerRows || []).forEach(function(row) {
        if (row && row.division_id != null && row.division_id !== '') {
          managed[String(row.division_id)] = true;
        }
      });
      divisions = accountDivisions.filter(function(division) {
        return managed[String(division.id)] === true;
      });
    }

    var hasDivisions = accountDivisions.length > 0;
    return {
      userId: userId,
      effectiveAccountId: effectiveAccountId,
      isOwner: isOwner,
      scope: scope,
      isDivisionManager: isDivisionManager,
      canEditAssets: canEditAssets,
      canEditJobs: canEditJobs,
      divisionIds: divisions.map(function(division) { return division.id; }),
      divisions: divisions,
      hasDivisions: hasDivisions
    };
  }

  function memberRowFromResult(result) {
    var row = result && result.data;
    if (!row || !row.account_owner_user_id) return null;
    return row;
  }

  async function readRows(supabase, table, columns, column, value) {
    try {
      var result = await supabase
        .from(table)
        .select(columns)
        .eq(column, value);
      if (result && result.error) {
        console.warn(
          'FleetMagnifyAccountContext: ' + table + ' lookup failed',
          result.error.message || result.error
        );
        return [];
      }
      return (result && result.data) || [];
    } catch (err) {
      console.warn(
        'FleetMagnifyAccountContext: ' + table + ' lookup failed',
        err && err.message ? err.message : err
      );
      return [];
    }
  }

  async function fetchContext(supabase, userId) {
    var memberResult = await supabase
      .from('account_members')
      .select(MEMBER_COLUMNS)
      .eq('member_auth_user_id', userId)
      .maybeSingle();

    var memberRow = memberRowFromResult(memberResult);
    var preview = deriveAccountContext(userId, memberRow, [], []);
    var divisionRows = await readRows(
      supabase,
      'divisions',
      'id, name',
      'account_owner_user_id',
      preview.effectiveAccountId
    );
    var managerRows = [];
    if (preview.isDivisionManager) {
      managerRows = await readRows(
        supabase,
        'division_managers',
        'division_id',
        'member_auth_user_id',
        userId
      );
    }
    return deriveAccountContext(userId, memberRow, divisionRows, managerRows);
  }

  function load(supabase, userId) {
    if (cache && cache.userId === userId && cache.supabase === supabase) {
      return cache.promise;
    }
    var entry = { userId: userId, supabase: supabase, promise: null, context: null };
    entry.promise = fetchContext(supabase, userId).then(function(ctx) {
      entry.context = ctx;
      return ctx;
    }).catch(function(err) {
      if (cache === entry) cache = null;
      throw err;
    });
    cache = entry;
    return entry.promise;
  }

  function current() {
    return cache && cache.context ? cache.context : null;
  }

  function clearCache() {
    cache = null;
  }

  global.FleetMagnifyAccountContext = {
    load: load,
    current: current,
    deriveAccountContext: deriveAccountContext,
    clearCache: clearCache,
    MEMBER_COLUMNS: MEMBER_COLUMNS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FleetMagnifyAccountContext;
  }
})(typeof window !== 'undefined' ? window : globalThis);
