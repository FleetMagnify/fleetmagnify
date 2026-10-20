/**
 * Division billing decisions and owner-gated route behaviour.
 * Stripe and Supabase are in-memory stubs. No network calls.
 *
 *   node scripts/test-divisions-api.js
 */
var assert = require('assert');
var billing = require('../lib/division-billing');
var routes = require('../lib/division-routes');
var invite = require('../api/invite-account-member');
var listMembers = require('../api/list-account-members');
var sync = require('../lib/sync-subscription-quantity');

var DIVISION_PRICE = 'price_division_test';
var PLATFORM_PRICE = 'price_platform_test';

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status: function (code) { this.statusCode = code; return this; },
    json: function (body) { this.body = body; return this; }
  };
}

function copy(row) {
  var out = {};
  Object.keys(row).forEach(function (key) { out[key] = row[key]; });
  return out;
}

function memoryAdmin(seed) {
  var tables = {
    account_members: (seed.account_members || []).map(copy),
    profiles: (seed.profiles || []).map(copy),
    divisions: (seed.divisions || []).map(copy),
    division_managers: (seed.division_managers || []).map(copy)
  };
  var seq = 100;
  var failInsertTable = null;

  function matches(row, filters) {
    return filters.every(function (filter) {
      if (filter.op === 'eq') return row[filter.col] === filter.val;
      if (filter.op === 'in') return filter.val.indexOf(row[filter.col]) !== -1;
      return true;
    });
  }

  function from(table) {
    var filters = [];
    var action = 'select';
    var payload = null;
    var one = false;

    function result(data, error) {
      return { data: data, error: error || null };
    }

    function run() {
      var rows = tables[table] || [];
      if (action === 'insert') {
        if (failInsertTable === table) {
          failInsertTable = null;
          return result(null, { code: 'insert_failed', message: 'insert failed' });
        }
        var incoming = Array.isArray(payload) ? payload : [payload];
        var inserted = [];
        for (var i = 0; i < incoming.length; i++) {
          var row = copy(incoming[i]);
          if (row.id == null) row.id = seq++;
          if (table === 'divisions') {
            var key = String(row.name || '').trim().toLowerCase();
            var clash = rows.some(function (existing) {
              return existing.account_owner_user_id === row.account_owner_user_id &&
                String(existing.name || '').trim().toLowerCase() === key;
            });
            if (clash) return result(null, { code: '23505', message: 'duplicate key value violates unique constraint' });
          }
          rows.push(row);
          inserted.push(row);
        }
        tables[table] = rows;
        return result(one ? copy(inserted[0]) : inserted.map(copy));
      }

      var found = rows.filter(function (row) { return matches(row, filters); });

      if (action === 'delete') {
        tables[table] = rows.filter(function (row) { return !matches(row, filters); });
        return result(found.map(copy));
      }

      if (action === 'update') {
        var updated = [];
        for (var u = 0; u < rows.length; u++) {
          if (!matches(rows[u], filters)) continue;
          var next = Object.assign({}, rows[u], payload);
          if (table === 'divisions' && payload && payload.name != null) {
            var nextKey = String(next.name).trim().toLowerCase();
            var nameClash = rows.some(function (existing) {
              return existing.id !== rows[u].id &&
                existing.account_owner_user_id === next.account_owner_user_id &&
                String(existing.name || '').trim().toLowerCase() === nextKey;
            });
            if (nameClash) return result(null, { code: '23505', message: 'duplicate key value violates unique constraint' });
          }
          rows[u] = next;
          updated.push(copy(next));
        }
        return result(one ? (updated[0] || null) : updated);
      }

      return result(one ? (found[0] ? copy(found[0]) : null) : found.map(copy));
    }

    var builder = {
      select: function () { return builder; },
      insert: function (body) { action = 'insert'; payload = body; return builder; },
      update: function (body) { action = 'update'; payload = body; return builder; },
      delete: function () { action = 'delete'; return builder; },
      eq: function (col, val) { filters.push({ op: 'eq', col: col, val: val }); return builder; },
      in: function (col, val) { filters.push({ op: 'in', col: col, val: val }); return builder; },
      order: function () { return builder; },
      maybeSingle: function () { one = true; return Promise.resolve(run()); },
      single: function () { one = true; return Promise.resolve(run()); },
      then: function (resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
    };
    return builder;
  }

  return {
    from: from,
    tables: tables,
    failNextInsert: function (table) { failInsertTable = table; }
  };
}

function userClient(userId) {
  return {
    auth: {
      getUser: function () {
        return Promise.resolve({ data: { user: { id: userId } }, error: null });
      }
    }
  };
}

function stripeStub(options) {
  options = options || {};
  var updates = [];
  var api = {
    updates: updates,
    subscriptions: {
      retrieve: function () {
        return Promise.resolve({
          id: 'sub_owner',
          items: { data: options.items || [] }
        });
      },
      update: function (id, params) {
        if (options.fail) return Promise.reject(new Error('stripe down'));
        updates.push({ id: id, params: params });
        return Promise.resolve({ id: id });
      }
    }
  };
  return api;
}

function ownerProfile(status) {
  return {
    id: 'owner-1',
    subscription_status: status || 'active',
    stripe_subscription_id: 'sub_owner'
  };
}

function depsFor(admin, stripe, userId) {
  return {
    supabaseUser: userClient(userId || 'owner-1'),
    supabaseAdmin: admin,
    stripe: stripe
  };
}

async function run() {
  process.env.STRIPE_DIVISION_PRICE_ID = DIVISION_PRICE;
  process.env.STRIPE_PRICE_PLATFORM = PLATFORM_PRICE;

  console.log('\n=== Name validation ===');
  check('Blank name is rejected', billing.validateDivisionName('   ').ok === false);
  check('Missing name is rejected', billing.validateDivisionName(null).ok === false);
  var sixty = new Array(61).join('a');
  var trimmed = billing.validateDivisionName('  ' + sixty + '  ');
  check('60 characters after trim is accepted', trimmed.ok === true && trimmed.name.length === 60);
  check('61 characters is rejected', billing.validateDivisionName(sixty + 'b').ok === false);
  check('Name is trimmed', billing.validateDivisionName('  North  ').name === 'North');

  console.log('\n=== Quantity decisions ===');
  var add = billing.planDivisionQuantityChange(2, null, DIVISION_PRICE);
  check('Count above zero with no item adds a line', add.action === 'add' && add.items[0].quantity === 2);
  check('Add uses the divisions price and prorates', add.items[0].price === DIVISION_PRICE && add.proration_behavior === 'create_prorations');
  var update = billing.planDivisionQuantityChange(3, { id: 'si_div', quantity: 1 }, DIVISION_PRICE);
  check('Existing item updates quantity', update.action === 'update' && update.items[0].id === 'si_div' && update.items[0].quantity === 3);
  var same = billing.planDivisionQuantityChange(3, { id: 'si_div', quantity: 3 }, DIVISION_PRICE);
  check('Matching quantity does not write', same.action === 'unchanged' && same.items === null);
  var remove = billing.planDivisionQuantityChange(0, { id: 'si_div', quantity: 2 }, DIVISION_PRICE);
  check('Zero count deletes the item', remove.action === 'remove' && remove.items[0].deleted === true);
  var untouched = billing.planDivisionQuantityChange(0, null, DIVISION_PRICE);
  check('Zero count with no item is untouched', untouched.action === 'untouched');

  console.log('\n=== Owner and subscription gating ===');
  var memberAdmin = memoryAdmin({
    account_members: [{ id: 1, member_auth_user_id: 'member-1', account_owner_user_id: 'owner-1', scope: 'all' }],
    profiles: [ownerProfile('active')]
  });
  var memberRes = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: 'North' } },
    memberRes,
    depsFor(memberAdmin, stripeStub(), 'member-1')
  );
  check('A team member is rejected', memberRes.statusCode === 403);
  check('A team member creates nothing', memberAdmin.tables.divisions.length === 0);

  var pastDue = memoryAdmin({ profiles: [ownerProfile('past_due')] });
  var pastDueRes = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: 'North' } },
    pastDueRes,
    depsFor(pastDue, stripeStub())
  );
  check('past_due cannot create a division', pastDueRes.statusCode === 403 && pastDue.tables.divisions.length === 0);

  var trialing = memoryAdmin({ profiles: [ownerProfile('trialing')] });
  var trialStripe = stripeStub();
  var trialRes = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: 'North' } },
    trialRes,
    depsFor(trialing, trialStripe)
  );
  check('trialing owner can create a division', trialRes.statusCode === 200 && trialing.tables.divisions.length === 1);
  check('Creating the first division adds quantity 1', trialStripe.updates[0].params.items[0].quantity === 1);

  delete process.env.STRIPE_DIVISION_PRICE_ID;
  var unconfigured = memoryAdmin({ profiles: [ownerProfile('active')] });
  var missingRes = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: 'North' } },
    missingRes,
    depsFor(unconfigured, stripeStub())
  );
  check(
    'Missing price id returns 500 and creates nothing',
    missingRes.statusCode === 500 &&
      missingRes.body.error === 'Divisions billing is not configured' &&
      unconfigured.tables.divisions.length === 0
  );
  process.env.STRIPE_DIVISION_PRICE_ID = DIVISION_PRICE;

  console.log('\n=== Create, rename, delete ===');
  var admin = memoryAdmin({ profiles: [ownerProfile('active')] });
  var stripe = stripeStub();
  var created = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: '  North ' } },
    created,
    depsFor(admin, stripe)
  );
  check('Create stores the trimmed name', admin.tables.divisions[0].name === 'North');
  var duplicate = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: 'north' } },
    duplicate,
    depsFor(admin, stripeStub())
  );
  check('Duplicate name is a 409', duplicate.statusCode === 409 && admin.tables.divisions.length === 1);

  var failedStripe = stripeStub({ fail: true });
  var beforeFail = admin.tables.divisions.length;
  var failed = mockRes();
  await routes.createDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { name: 'South' } },
    failed,
    depsFor(admin, failedStripe)
  );
  check('Stripe failure rolls the division back', failed.statusCode === 502 && admin.tables.divisions.length === beforeFail);

  var other = memoryAdmin({
    profiles: [ownerProfile('active')],
    divisions: [{ id: 7, name: 'Theirs', account_owner_user_id: 'other-owner' }]
  });
  var foreign = mockRes();
  await routes.renameDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: 7, name: 'Mine' } },
    foreign,
    depsFor(other, stripeStub())
  );
  check('Another account\'s division cannot be renamed', foreign.statusCode === 404 && other.tables.divisions[0].name === 'Theirs');

  var renamed = mockRes();
  await routes.renameDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: admin.tables.divisions[0].id, name: 'Northern' } },
    renamed,
    depsFor(admin, stripeStub())
  );
  check('Owner can rename their division', renamed.statusCode === 200 && admin.tables.divisions[0].name === 'Northern');

  admin.tables.division_managers.push({
    division_id: admin.tables.divisions[0].id,
    member_auth_user_id: 'manager-1'
  });
  var blocked = mockRes();
  await routes.deleteDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: admin.tables.divisions[0].id } },
    blocked,
    depsFor(admin, stripeStub())
  );
  check('Delete is refused while a manager is assigned', blocked.statusCode === 409 && admin.tables.divisions.length === 1);
  admin.tables.division_managers.length = 0;

  var removeStripe = stripeStub({
    items: [{ id: 'si_div', quantity: 1, price: { id: DIVISION_PRICE } }]
  });
  var removed = mockRes();
  await routes.deleteDivision(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: admin.tables.divisions[0].id } },
    removed,
    depsFor(admin, removeStripe)
  );
  check('Deleting the last division removes the Stripe item', removed.statusCode === 200 && admin.tables.divisions.length === 0);
  check('Removal marks the item deleted', removeStripe.updates[0].params.items[0].deleted === true);

  console.log('\n=== Manager assignment and invites ===');
  var team = memoryAdmin({
    profiles: [ownerProfile('active')],
    divisions: [{ id: 4, name: 'North', account_owner_user_id: 'owner-1' }],
    account_members: [
      { id: 11, account_owner_user_id: 'owner-1', member_auth_user_id: 'manager-1', scope: 'division', role: 'Divisional Manager' },
      { id: 12, account_owner_user_id: 'owner-1', member_auth_user_id: 'viewer-1', scope: 'all', role: 'Viewer' }
    ]
  });
  var badManager = mockRes();
  await routes.setDivisionManagers(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: 4, member_auth_user_ids: ['viewer-1'] } },
    badManager,
    depsFor(team, stripeStub())
  );
  check('A full-access member cannot be assigned as a division manager', badManager.statusCode === 400 && team.tables.division_managers.length === 0);

  var assigned = mockRes();
  await routes.setDivisionManagers(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: 4, member_auth_user_ids: ['manager-1'] } },
    assigned,
    depsFor(team, stripeStub())
  );
  check('A divisional manager can be assigned', assigned.statusCode === 200 && team.tables.division_managers.length === 1);

  var cleared = mockRes();
  await routes.setDivisionManagers(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: { division_id: 4, member_auth_user_ids: [] } },
    cleared,
    depsFor(team, stripeStub())
  );
  check('An empty list replaces the managers', cleared.statusCode === 200 && team.tables.division_managers.length === 0);

  var invites = 0;
  var legacy = {
    auth: {
      admin: {
        inviteUserByEmail: function () {
          invites += 1;
          return Promise.resolve({ data: { user: { id: 'new-user' } }, error: null });
        },
        getUserById: function (id) {
          return Promise.resolve({ data: { user: { id: id, email: id + '@example.com' } }, error: null });
        }
      }
    }
  };
  var inviteBody = {
    email: 'new@example.com',
    role: 'Viewer',
    can_edit_assets: true,
    can_edit_jobs: true,
    can_view_change_log: true
  };
  var classic = mockRes();
  await invite(
    { method: 'POST', headers: { authorization: 'Bearer token' }, body: inviteBody },
    classic,
    { supabase: userClient('owner-1'), supabaseAdmin: team, supabaseLegacyAdmin: legacy }
  );
  var classicRow = team.tables.account_members.filter(function (row) { return row.member_auth_user_id === 'new-user'; })[0];
  check('An invite with no scope is still scope all', classic.statusCode === 200 && classicRow.scope === 'all' && classicRow.role === 'Viewer');
  check('An invite with no scope keeps the requested job permission', classicRow.can_edit_jobs === true);
  check('An invite with no scope does not write division_managers', team.tables.division_managers.length === 0);

  var divisionInvite = mockRes();
  await invite(
    {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: Object.assign({}, inviteBody, { email: 'mgr@example.com', scope: 'division', division_ids: [4] })
    },
    divisionInvite,
    { supabase: userClient('owner-1'), supabaseAdmin: team, supabaseLegacyAdmin: legacy }
  );
  var managerRow = team.tables.account_members.filter(function (row) { return row.member_auth_user_id === 'new-user' && row.scope === 'division'; })[0];
  check('Division invite forces the Divisional Manager role', divisionInvite.statusCode === 200 && managerRow.role === 'Divisional Manager');
  check('Division invite forces can_edit_jobs false', managerRow.can_edit_jobs === false && managerRow.can_view_change_log === false);
  check('Division invite keeps can_edit_assets', managerRow.can_edit_assets === true);
  check('Division invite writes division_managers', team.tables.division_managers.length === 1 && team.tables.division_managers[0].division_id === 4);

  team.failNextInsert('division_managers');
  var invitesBefore = invites;
  var membersBefore = team.tables.account_members.length;
  var rolled = mockRes();
  await invite(
    {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: Object.assign({}, inviteBody, { email: 'rollback@example.com', scope: 'division', division_ids: [4] })
    },
    rolled,
    { supabase: userClient('owner-1'), supabaseAdmin: team, supabaseLegacyAdmin: legacy }
  );
  check('A failed division assignment undoes the member row', rolled.statusCode === 500 && team.tables.account_members.length === membersBefore);
  check('The invite email was still attempted before the assignment failed', invites === invitesBefore + 1);

  var listed = mockRes();
  await listMembers(
    { method: 'GET', headers: { authorization: 'Bearer token' } },
    listed,
    { supabase: userClient('owner-1'), supabaseAdmin: team, supabaseLegacyAdmin: legacy }
  );
  var listedManager = listed.body.members.filter(function (member) {
    return member.role === 'Divisional Manager' && member.division_ids && member.division_ids.indexOf(4) !== -1;
  })[0];
  check('Team list includes scope and division_ids', listed.statusCode === 200 && listedManager.scope === 'division');

  console.log('\n=== Asset quantity ignores a divisions line item ===');
  var assetUpdates = [];
  var assetOutcome = await sync.syncUserSubscription({
    userId: 'owner-1',
    subscriptionId: 'sub_owner',
    supabase: {
      from: function () {
        return {
          select: function () {
            return {
              eq: function () {
                return Promise.resolve({
                  data: [{ id: 1, is_ignored: false }, { id: 2, is_ignored: false }],
                  error: null
                });
              }
            };
          }
        };
      }
    },
    stripe: {
      subscriptions: {
        retrieve: function () {
          return Promise.resolve({
            items: {
              data: [
                { id: 'si_div', quantity: 4, price: { id: DIVISION_PRICE } },
                { id: 'si_plat', quantity: 1, price: { id: PLATFORM_PRICE } }
              ]
            }
          });
        },
        update: function (id, params) {
          assetUpdates.push(params);
          return Promise.resolve({ id: id });
        }
      }
    }
  });
  check('Asset sync updates the platform item, not the divisions item', assetOutcome.to === 2 && assetUpdates[0].items[0].id === 'si_plat');
  check('Asset sync sends only that one item', assetUpdates[0].items.length === 1);

  var ignored = [];
  var noPlatform = await sync.syncUserSubscription({
    userId: 'owner-1',
    subscriptionId: 'sub_owner',
    supabase: {
      from: function () {
        return {
          select: function () {
            return { eq: function () { return Promise.resolve({ data: [{ id: 1 }], error: null }); } };
          }
        };
      }
    },
    stripe: {
      subscriptions: {
        retrieve: function () {
          return Promise.resolve({ items: { data: [{ id: 'si_div', quantity: 1, price: DIVISION_PRICE }] } });
        },
        update: function () { ignored.push(true); return Promise.resolve({}); }
      }
    }
  });
  check('An unknown price is not treated as the asset quantity', noPlatform.reason === 'no_platform_item' && ignored.length === 0);

  console.log('\n=== Daily division reconciliation ===');
  var cronUpdates = [];
  var cron = await sync.reconcileDivisionQuantities({
    profiles: [
      { id: 'owner-empty', stripe_subscription_id: 'sub_empty' },
      { id: 'owner-two', stripe_subscription_id: 'sub_two' },
      { id: 'owner-clear', stripe_subscription_id: 'sub_clear' }
    ],
    supabase: {
      from: function () {
        return {
          select: function () {
            return Promise.resolve({
              data: [
                { account_owner_user_id: 'owner-two' },
                { account_owner_user_id: 'owner-two' }
              ],
              error: null
            });
          }
        };
      }
    },
    stripe: {
      subscriptions: {
        retrieve: function (id) {
          if (id === 'sub_two') {
            return Promise.resolve({ items: { data: [{ id: 'si_two', quantity: 1, price: { id: DIVISION_PRICE } }] } });
          }
          if (id === 'sub_clear') {
            return Promise.resolve({ items: { data: [{ id: 'si_clear', quantity: 1, price: { id: DIVISION_PRICE } }] } });
          }
          return Promise.resolve({ items: { data: [{ id: 'si_plat', quantity: 5, price: { id: PLATFORM_PRICE } }] } });
        },
        update: function (id, params) {
          cronUpdates.push({ id: id, params: params });
          return Promise.resolve({ id: id });
        }
      }
    }
  });
  var untouched = cron.results.filter(function (row) { return row.userId === 'owner-empty'; })[0];
  check('An account with no divisions and no division item is untouched', untouched.action === 'untouched');
  check('The untouched account is not sent to Stripe', cronUpdates.every(function (update) { return update.id !== 'sub_empty'; }));
  var raised = cronUpdates.filter(function (update) { return update.id === 'sub_two'; })[0];
  check('Two divisions set the line quantity to 2', raised.params.items[0].quantity === 2 && raised.params.proration_behavior === 'create_prorations');
  var clearedItem = cronUpdates.filter(function (update) { return update.id === 'sub_clear'; })[0];
  check('A leftover division item is removed when the count is zero', clearedItem.params.items[0].deleted === true);

  console.log('\nAll division API tests passed.');
}

run().catch(function (err) {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
