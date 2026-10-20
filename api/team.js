var routes = require('../lib/division-routes');
var inviteAccountMember = require('../lib/invite-account-member');
var removeAccountMember = require('../lib/remove-account-member');
var listAccountMembers = require('../lib/list-account-members');

var HANDLERS = {
  invite: inviteAccountMember,
  remove: removeAccountMember,
  list: listAccountMembers,
  'create-division': routes.createDivision,
  'rename-division': routes.renameDivision,
  'delete-division': routes.deleteDivision,
  'set-division-managers': routes.setDivisionManagers
};

function actionValue(raw) {
  if (Array.isArray(raw)) raw = raw.length ? raw[0] : '';
  if (raw == null) return '';
  return String(raw).trim();
}

/**
 * The action is the query parameter only. A rewrite from an old /api/<name>
 * URL sets it. The body is not consulted, so a posted field cannot choose
 * the handler.
 */
function actionFromRequest(req) {
  if (req && req.query && Object.prototype.hasOwnProperty.call(req.query, 'action')) {
    return actionValue(req.query.action);
  }
  if (!req || typeof req.url !== 'string') return '';
  var query = req.url.indexOf('?');
  if (query === -1) return '';
  return actionValue(new URLSearchParams(req.url.slice(query + 1)).get('action'));
}

function handler(req, res, deps) {
  var action = actionFromRequest(req);
  var run = HANDLERS[action];
  if (!action || !run) {
    return res.status(400).json({ error: action ? 'Unknown action' : 'action is required' });
  }
  return run(req, res, deps);
}

module.exports = handler;
