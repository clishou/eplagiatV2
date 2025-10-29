// api/server.js
const app = require('../index');

module.exports = async (req, res) => {
  await app.ready();
  // On confie la requête HTTP à Fastify :
  app.server.emit('request', req, res);
};
