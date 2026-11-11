const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./src/utils/logger');
const { convertTextLinks } = require('./src/services/converterService');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  logger.logEnter('GET /api/health');
  res.json({ status: 'ok', time: new Date().toISOString() });
  logger.logLeave('GET /api/health', { status: 'ok' });
});

app.post('/api/convert', async (req, res) => {
  logger.logEnter('POST /api/convert');
  try {
    const { text, config } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      logger.warning('POST /api/convert', 'Empty text submitted');
      return res.status(400).json({
        error: 'Vui lòng dán ít nhất 1 link hoặc đoạn văn bản chứa link Shopee / TikTok.'
      });
    }

    const result = await convertTextLinks(text, config || {});
    logger.logLeave('POST /api/convert', {
      total: result.summary.total,
      successCount: result.summary.successCount
    });
    return res.json(result);
  } catch (err) {
    logger.error('POST /api/convert', 'Unhandled server error', { error: err.message });
    return res.status(500).json({
      error: `Lỗi hệ thống: ${err.message}`
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.log('server', `Affiliate Converter Web App running at http://localhost:${PORT}`, {
      port: PORT
    });
  });
}

module.exports = app;
