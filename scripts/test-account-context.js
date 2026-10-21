/**
 * Pure account-context rules and the page-load query cache.
 *
 *   node scripts/test-account-context.js
 */
var assert = require('assert');
var ctx = require('../js/account-context');

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

function legacyEffectiveAccountId(userId, memberRow) {
  if (memberRow && memberRow.account_owner_user_id) return memberRow.account_owner_user_id;
  return userId;
}

var ownerId = 'owner-1';
var memberId = 'member-1';
var north = { id: 'div-north', name: 'North' };
var south = { id: 'div-south', name: 'South' };
var west = { id: 'div-west', name: 'West' };

console.log('\n=== Owner and full member keep the previous account id ===');

var owner = ctx.deriveAccountContext(ownerId, null, [], []);
check('Owner with no member row uses their own id', owner.effectiveAccountId === ownerId);
check('Owner isOwner', owner.isOwner === true);
check('Owner scope is all', owner.scope === 'all');
check('Owner is not a division manager', owner.isDivisionManager === false);
check('Owner can edit assets', owner.canEditAssets === true);
check('Owner can edit jobs', owner.canEditJobs === true);
check('Owner with no divisions has hasDivisions false', owner.hasDivisions === false);
check('Owner with no divisions has an empty division list', owner.divisionIds.length === 0 && owner.divisions.length === 0);

var fullMemberRow = {
  account_owner_user_id: ownerId,
  scope: 'all',
  can_edit_assets: true,
  can_edit_jobs: false
};
var fullMember = ctx.deriveAccountContext(memberId, fullMemberRow, [south, north], [
  { division_id: north.id }
]);
check(
  'Full member effectiveAccountId matches the old lookup',
  fullMember.effectiveAccountId === legacyEffectiveAccountId(memberId, fullMemberRow)
);
check('Full member is not the owner', fullMember.isOwner === false);
check('Full member scope stays all', fullMember.scope === 'all');
check('Full member is not a division manager', fullMember.isDivisionManager === false);
check('Full member keeps can_edit_assets', fullMember.canEditAssets === true);
check('Full member keeps can_edit_jobs', fullMember.canEditJobs === false);
check('Full member sees every account division', fullMember.divisionIds.join(',') === 'div-north,div-south');
check('Full member hasDivisions', fullMember.hasDivisions === true);
check('Manager rows do not filter a full member', fullMember.divisions.length === 2);

var missingScope = ctx.deriveAccountContext(memberId, {
  account_owner_user_id: ownerId,
  scope: null,
  can_edit_assets: false,
  can_edit_jobs: true
}, [], []);
check('Null scope is treated as all', missingScope.scope === 'all' && missingScope.isDivisionManager === false);
check('Null scope keeps the member edit flags', missingScope.canEditAssets === false && missingScope.canEditJobs === true);
check(
  'Member row without an owner id falls back to the caller',
  ctx.deriveAccountContext(memberId, { account_owner_user_id: '', scope: 'division' }, [], []).effectiveAccountId === memberId
);

console.log('\n=== Divisional manager ===');

var managerRow = {
  account_owner_user_id: ownerId,
  scope: 'division',
  can_edit_assets: true,
  can_edit_jobs: true
};
var manager = ctx.deriveAccountContext(memberId, managerRow, [west, north, south], [
  { division_id: south.id },
  { division_id: north.id },
  { division_id: 'div-other-account' }
]);
check(
  'Manager effectiveAccountId matches the old lookup',
  manager.effectiveAccountId === legacyEffectiveAccountId(memberId, managerRow)
);
check('Manager scope is division', manager.scope === 'division' && manager.isDivisionManager === true && manager.isOwner === false);
check('Manager can edit assets when the row allows it', manager.canEditAssets === true);
check('Manager canEditJobs is forced false', manager.canEditJobs === false);
check('Manager divisionIds are only their account divisions', manager.divisionIds.join(',') === 'div-north,div-south');
check('Manager divisions keep id and name', manager.divisions[0].name === 'North' && manager.divisions[1].name === 'South');
check('Account divisions still set hasDivisions', manager.hasDivisions === true);

var unassigned = ctx.deriveAccountContext(memberId, {
  account_owner_user_id: ownerId,
  scope: 'division',
  can_edit_assets: false,
  can_edit_jobs: false
}, [north], []);
check('Manager with no division rows has an empty list', unassigned.divisionIds.length === 0);
check('Manager with no division rows still reports account hasDivisions', unassigned.hasDivisions === true);
check('Manager without can_edit_assets cannot edit assets', unassigned.canEditAssets === false);

var named = ctx.deriveAccountContext(ownerId, null, [
  { id: 'b', name: null },
  { id: 'a', name: 'Alpha' },
  { id: 'a', name: 'Duplicate' }
], []);
check('Null division name becomes an empty string and sorts first', named.divisions[0].id === 'b' && named.divisions[0].name === '');
check('Duplicate division ids are dropped', named.divisionIds.join(',') === 'b,a');

console.log('\n=== load() queries and cache ===');

function fakeSupabase(fixtures) {
  var calls = [];
  return {
    calls: calls,
    from: function(table) {
      var state = { table: table, select: null, filters: [], maybeSingle: false };
      function run() {
        calls.push({
          table: state.table,
          select: state.select,
          filters: state.filters.slice(),
          maybeSingle: state.maybeSingle
        });
        var tableFixtures = fixtures[table];
        if (tableFixtures && tableFixtures.error) {
          return Promise.resolve({ data: null, error: tableFixtures.error });
        }
        if (tableFixtures && tableFixtures.throw) {
          return Promise.reject(tableFixtures.throw);
        }
        var rows = ((tableFixtures && tableFixtures.rows) || []).filter(function(row) {
          return state.filters.every(function(filter) {
            return row[filter.col] === filter.val;
          });
        });
        if (state.maybeSingle) {
          return Promise.resolve({ data: rows[0] || null, error: null });
        }
        return Promise.resolve({ data: rows, error: null });
      }
      var builder = {
        select: function(columns) { state.select = columns; return builder; },
        eq: function(col, val) { state.filters.push({ col: col, val: val }); return builder; },
        maybeSingle: function() { state.maybeSingle = true; return run(); },
        then: function(resolve, reject) { return run().then(resolve, reject); }
      };
      return builder;
    }
  };
}

function memberFixtures(row) {
  return {
    account_members: { rows: row ? [Object.assign({ member_auth_user_id: memberId }, row)] : [] },
    divisions: { rows: [Object.assign({ account_owner_user_id: ownerId }, north), Object.assign({ account_owner_user_id: ownerId }, south)] },
    division_managers: { rows: [{ member_auth_user_id: memberId, division_id: north.id }] }
  };
}

async function runLoadTests() {
  ctx.clearCache();
  var ownerClient = fakeSupabase(memberFixtures(null));
  var loadedOwner = await ctx.load(ownerClient, ownerId);
  check('load() owner id matches derive', loadedOwner.effectiveAccountId === ownerId && loadedOwner.isOwner === true);
  check('load() keeps the latest context for the sidebar', ctx.current() === loadedOwner);
  check('load() reads account_members once for an owner', ownerClient.calls.filter(function(call) { return call.table === 'account_members'; }).length === 1);
  check(
    'account_members select includes scope and edit flags',
    ownerClient.calls[0].select === ctx.MEMBER_COLUMNS && ownerClient.calls[0].maybeSingle === true
  );
  check('load() reads divisions for the owner account', ownerClient.calls.some(function(call) {
    return call.table === 'divisions' && call.filters[0].col === 'account_owner_user_id' && call.filters[0].val === ownerId;
  }));
  check('load() does not read division_managers for an owner', ownerClient.calls.every(function(call) {
    return call.table !== 'division_managers';
  }));

  var again = await ctx.load(ownerClient, ownerId);
  check('Second load on the same page does not query again', ownerClient.calls.length === 2 && again === loadedOwner);

  ctx.clearCache();
  var memberClient = fakeSupabase(memberFixtures(fullMemberRow));
  var loadedMember = await ctx.load(memberClient, memberId);
  check('load() full member uses the owner id', loadedMember.effectiveAccountId === ownerId && loadedMember.scope === 'all');
  check('load() does not read division_managers for scope all', memberClient.calls.every(function(call) {
    return call.table !== 'division_managers';
  }));
  check('load() full member still lists account divisions', loadedMember.hasDivisions === true && loadedMember.divisionIds.length === 2);

  ctx.clearCache();
  var managerClient = fakeSupabase(memberFixtures(managerRow));
  var loadedManager = await ctx.load(managerClient, memberId);
  check('load() manager queries division_managers', managerClient.calls.some(function(call) {
    return call.table === 'division_managers' && call.filters[0].val === memberId;
  }));
  check('load() manager divisionIds come from division_managers', loadedManager.divisionIds.join(',') === 'div-north');
  check('load() manager canEditJobs is false', loadedManager.canEditJobs === false);
  check('load() still reads account_members only once for a manager', managerClient.calls.filter(function(call) {
    return call.table === 'account_members';
  }).length === 1);

  ctx.clearCache();
  var brokenDivisions = fakeSupabase({
    account_members: { rows: [Object.assign({ member_auth_user_id: memberId }, fullMemberRow)] },
    divisions: { error: { message: 'relation divisions does not exist' } }
  });
  var despiteDivisions = await ctx.load(brokenDivisions, memberId);
  check(
    'A divisions lookup failure keeps the member account id',
    despiteDivisions.effectiveAccountId === ownerId && despiteDivisions.hasDivisions === false
  );

  ctx.clearCache();
  var thrownDivisions = fakeSupabase({
    account_members: { rows: [Object.assign({ member_auth_user_id: memberId }, fullMemberRow)] },
    divisions: { throw: new Error('network down') }
  });
  var despiteThrow = await ctx.load(thrownDivisions, memberId);
  check('A thrown divisions lookup still resolves the member account id', despiteThrow.effectiveAccountId === ownerId);
}

runLoadTests().then(function() {
  console.log('\nAll account context tests passed.');
}).catch(function(err) {
  console.error(err);
  process.exit(1);
});
