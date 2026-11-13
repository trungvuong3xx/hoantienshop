const fs = require('fs');
const path = require('path');

// Auto-load .env for local environments without external dependencies
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[k]) {
        process.env[k] = v;
      }
    }
  }
}

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./src/utils/logger');
const { registerCashbackRoutes } = require('./src/services/cashbackController');

const app = express();
const PORT = process.env.PORT || 3456;

app.set('trust proxy', 1);

// Security headers via Helmet + strict no-referrer to hide cashback site origin from Shopee/TikTok
app.use(
  helmet({
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: [
          "'self'",
          'data:',
          'https://api.qrserver.com',
          'https://img.vietqr.io',
          'https://*.shopee.vn',
          'https://*.susercontent.com',
          'https://*.tiktokcdn.com',
          'https://*.ibyteimg.com'
        ],
        connectSrc: ["'self'"],
        frameSrc: ['https://challenges.cloudflare.com'],
        frameAncestors: ["'none'"]
      }
    }
  })
);

// CORS origin whitelist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://hoantienshop.vercel.app,http://localhost:3456')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      return callback(new Error('Origin not allowed by CORS'));
    }
  })
);

// Default strict 10kb JSON body limit (Admin CSV import route overrides internally)
app.use((req, res, next) => {
  if (req.path === '/api/admin/import-orders') {
    return next();
  }
  return express.json({ limit: '10kb' })(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  logger.logEnter('GET /api/health');
  res.json({ status: 'ok', time: new Date().toISOString() });
  logger.logLeave('GET /api/health', { status: 'ok' });
});

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
