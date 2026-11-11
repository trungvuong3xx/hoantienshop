const logger = require('../src/utils/logger');

module.exports = async function handler(req, res) {
  logger.logEnter('api/health', { method: req.method });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    logger.logLeave('api/health', { status: 200 });
    return res.status(200).end();
  }

  const payload = { status: 'ok', platform: 'vercel', time: new Date().toISOString() };
  logger.logLeave('api/health', { status: 'ok' });
  return res.status(200).json(payload);
};
