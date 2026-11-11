const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./src/utils/logger');
const { registerCashbackRoutes } = require('./src/services/cashbackController');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  logger.logEnter('GET /api/health');
  res.json({ status: 'ok', time: new Date().toISOString() });
  logger.logLeave('GET /api/health', { status: 'ok' });
});

// Register all Cashback Platform & Admin routes
registerCashbackRoutes(app);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.log('server', `HoanTienShop Web App running at http://localhost:${PORT}`, {
      port: PORT
    });
  });
}

module.exports = app;
