/**
 * Edit-tick decisions and refused-write messages.
 *
 *   node scripts/test-edit-permissions.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ctx = require('../js/account-context');
var perms = require('../js/edit-permissions');

function check(label, condition, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  console.log('[PASS] ' + label + (detail ? ' — ' + detail : ''));
}

var ownerId = 'owner-1';
var memberId = 'member-1';

function member(flags) {
  return ctx.deriveAccountContext(memberId, {
    account_owner_user_id: ownerId,
    scope: flags.scope || 'all',
    can_edit_assets: flags.can_edit_assets,
    can_edit_jobs: flags.can_edit_jobs
  }, flags.divisions || [], flags.managerRows || []);
}

console.log('\n=== Owner and members with the ticks on ===');

var owner = ctx.deriveAccountContext(ownerId, null, [], []);
check('Owner can edit jobs', perms.canEditJobs(owner) === true);
check('Owner can edit assets', perms.canEditAssets(owner) === true);

var both = member({ can_edit_assets: true, can_edit_jobs: true });
check('Member with both ticks can edit jobs', perms.canEditJobs(both) === true);
check('Member with both ticks can edit assets', perms.canEditAssets(both) === true);

console.log('\n=== Peter: assets on, jobs off ===');

var peter = member({ can_edit_assets: true, can_edit_jobs: false });
check('Peter is not a division manager', peter.isDivisionManager === false);
check('Peter can edit assets', perms.canEditAssets(peter) === true);
check('Peter cannot edit jobs', perms.canEditJobs(peter) === false);

console.log('\n=== Both ticks off ===');

var viewer = member({ can_edit_assets: false, can_edit_jobs: false });
check('Viewer cannot edit assets', perms.canEditAssets(viewer) === false);
check('Viewer cannot edit jobs', perms.canEditJobs(viewer) === false);

console.log('\n=== Divisional manager ===');

var north = { id: 'div-north', name: 'North' };
var manager = member({
  scope: 'division',
  can_edit_assets: true,
  can_edit_jobs: true,
  divisions: [north],
  managerRows: [{ division_id: north.id }]
});
check('Manager canEditJobs is forced false even when the row says true', perms.canEditJobs(manager) === false);
check('Manager keeps canEditAssets from the row', perms.canEditAssets(manager) === true);

var managerNoAssets = member({
  scope: 'division',
  can_edit_assets: false,
  can_edit_jobs: false,
  divisions: [north],
  managerRows: [{ division_id: north.id }]
});
check('Manager without the asset tick cannot edit assets', perms.canEditAssets(managerNoAssets) === false);
check('Manager without the asset tick cannot edit jobs', perms.canEditJobs(managerNoAssets) === false);

check('Missing account cannot edit', perms.canEditJobs(null) === false && perms.canEditAssets(undefined) === false);

console.log('\n=== Refused writes ===');

var denied = "You don't have permission to change this";
check('42501 is a permission error', perms.isPermissionError({ code: '42501', message: 'permission denied for table jobs' }));
check('RLS wording is a permission error', perms.isPermissionError({
  message: 'new row violates row-level security policy for table jobs'
}));
check('Insufficient privilege is a permission error', perms.isPermissionError({
  details: 'insufficient privilege'
}));
check('A network error is not a permission error', perms.isPermissionError({ message: 'Failed to fetch' }) === false);
check('Null is not a permission error', perms.isPermissionError(null) === false);

check('Permission errors use the friendly sentence', perms.writeErrorMessage({
  code: '42501',
  message: 'permission denied for table jobs'
}, 'Failed to delete job: ') === denied);
check('Other errors keep their message', perms.writeErrorMessage({
  message: 'null value in column "job_name"'
}) === 'null value in column "job_name"');
check('Other errors keep a prefix', perms.writeErrorMessage({
  message: 'null value in column "job_name"'
}, 'Failed to delete job: ') === 'Failed to delete job: null value in column "job_name"');
check('An empty refusal still says something', perms.writeErrorMessage({}) === denied);

console.log('\n=== Screens wire the same gates ===');

function source(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

var job = source('job-cost-analyst.html');
var cost = source('cost-per-km-analyst.html');
var emissions = source('truck-emissions-analyst.html');
var orion = source('orion-fuel-report.html');

check('Job page includes the permission helper', job.indexOf('js/edit-permissions.js') !== -1);
check('Job page shows the view-only note', job.indexOf('You have view-only access to jobs.') !== -1);
check('Job page asks canEditJobs', job.indexOf('canEditJobs') !== -1);
check('Cost per km includes the permission helper', cost.indexOf('js/edit-permissions.js') !== -1);
check('Cost per km asks canEditAssets', cost.indexOf('canEditAssets') !== -1);
check('Truck emissions includes the permission helper', emissions.indexOf('js/edit-permissions.js') !== -1);
check('Truck emissions asks canEditAssets', emissions.indexOf('canEditAssets') !== -1);
check('Orion includes the permission helper', orion.indexOf('js/edit-permissions.js') !== -1);
check('Orion asks canEditAssets before saving aliases', orion.indexOf('canEditAssets') !== -1);
check('Friendly sentence lives in the helper', source('js/edit-permissions.js').indexOf(denied) !== -1);

console.log('\nAll edit-permission checks passed.');
