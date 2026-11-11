const logger = require('../src/utils/logger');
const { convertTextLinks } = require('../src/services/converterService');

module.exports = async function handler(req, res) {
  logger.logEnter('api/convert', { method: req.method });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    logger.logLeave('api/convert', { status: 200 });
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    logger.warning('api/convert', 'Method not allowed', { method: req.method });
    return res.status(405).json({ error: 'Method Not Allowed. Please use POST.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    const { text, config } = body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      logger.warning('api/convert', 'Empty text submitted');
      return res.status(400).json({
        error: 'Vui lòng dán ít nhất 1 link hoặc đoạn văn bản chứa link Shopee / TikTok.'
      });
    }

    const result = await convertTextLinks(text, config || {});
    logger.logLeave('api/convert', {
      total: result.summary.total,
      successCount: result.summary.successCount
    });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('api/convert', 'Unhandled error in serverless handler', { error: err.message });
    return res.status(500).json({
      error: `Lỗi hệ thống: ${err.message}`
    });
  }
};
