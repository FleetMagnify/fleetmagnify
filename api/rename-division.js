const routes = require('../lib/division-routes');

module.exports = function handler(req, res) {
  return routes.renameDivision(req, res);
};
