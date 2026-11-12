const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
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

app.get('/api/debug-og', async (req, res) => {
  const shopId = req.query.shopId || '968599922';
  const itemId = req.query.itemId || '15696940827';
  const targetUrl = `https://shopee.vn/product/${shopId}/${itemId}`;
  try {
    const r = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'SPC_SI=test; SPC_U=test;'
      },
      signal: AbortSignal.timeout(6000)
    });
    const text = await r.text();
    const hasItem = text.includes('15696940827');
    const hasDownVn = text.includes('down-vn.img.susercontent.com');
    const matchesImg = [...text.matchAll(/https:\/\/[^"'\s]*susercontent\.com\/file\/[^"'\s<>()]+/g)].map(m => m[0]);
    const matchesJson = [...text.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(m => m[1]);
    const matchesMeta = [...text.matchAll(/<meta[^>]+>/g)].map(m => m[0]);
    res.json({
      status: r.status,
      len: text.length,
      hasItem,
      hasDownVn,
      imgMatches: matchesImg.slice(0, 5),
      jsonLd: matchesJson,
      metaTags: matchesMeta.slice(0, 20)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
