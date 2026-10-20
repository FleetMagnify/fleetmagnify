const routes = require('../lib/division-routes');

module.exports = function handler(req, res) {
  return routes.deleteDivision(req, res);
};
