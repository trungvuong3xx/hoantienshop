const fs = require('fs');
const path = require('path');

// ================= ENVIRONMENT LOADER (.env with quotes, export, and comments support) =================
function loadEnvConfig() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of envContent.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) {
        line = line.slice(7).trim();
      }
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const k = line.slice(0, eqIdx).trim();
      let v = line.slice(eqIdx + 1).trim();

      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      } else {
        const commentIdx = v.indexOf(' #');
        if (commentIdx !== -1) {
          v = v.slice(0, commentIdx).trim();
        }
      }
      if (!process.env[k]) {
        process.env[k] = v;
      }
    }
  } catch (err) {
    // Non-blocking for cloud environments where env is injected by host
  }
}
loadEnvConfig();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./src/utils/logger');
const { registerCashbackRoutes } = require('./src/services/cashbackController');
const { ensureDbLoaded, getDatabaseStatus, initPostgresIfConfigured } = require('./src/services/dbService');

const app = express();
const PORT = process.env.PORT || 3456;

// Configurable trust proxy based on deployment environment (1 on Vercel, loopback locally)
const trustProxyConfig = process.env.TRUST_PROXY
  ? (process.env.TRUST_PROXY === 'true' ? true : (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : parseInt(process.env.TRUST_PROXY, 10)))
  : (process.env.VERCEL ? 1 : 'loopback');
app.set('trust proxy', trustProxyConfig);

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
        connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
        frameSrc: ['https://challenges.cloudflare.com'],
        frameAncestors: ["'none'"]
      }
    }
  })
);

// CORS origin whitelist: restrict strictly to authorized origins and official hoantienshop preview deployments
const defaultOrigins = [
  'https://hoantiensan.online',
  'https://www.hoantiensan.online',
  'https://hoantienshop.vercel.app',
  'http://localhost:3456',
  'http://127.0.0.1:3456'
];
const allowedOrigins = (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : defaultOrigins)
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Allow only preview deployments belonging to this specific project (hoantienshop-*.vercel.app)
      const isProjectVercelPreview = /^https:\/\/hoantienshop(-[a-z0-9-]+)?\.vercel\.app$/i.test(origin);
      if (isProjectVercelPreview) {
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

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));

// Ensure Postgres is ready before serving API or health checks
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/go')) {
    try {
      await initPostgresIfConfigured();
    } catch (err) {
      logger.error('server', 'Postgres startup error', { error: err.message });
      if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
        return res.status(503).json({
          error: 'Cơ sở dữ liệu đang đồng bộ hoặc khởi động. Vui lòng tải lại trang sau vài giây.',
          details: err.message
        });
      }
    }
  }
  next();
});

// Readiness and liveness health check
app.get('/api/health', (req, res) => {
  logger.logEnter('GET /api/health');
  try {
    const db = ensureDbLoaded();
    const dbStatus = typeof getDatabaseStatus === 'function' ? getDatabaseStatus() : { status: 'ok' };

    // If DATABASE_URL is configured, ensure Postgres is active
    if (process.env.DATABASE_URL && dbStatus.mode !== 'postgres') {
      logger.warning('GET /api/health', 'Database Postgres chưa sẵn sàng', dbStatus);
      return res.status(503).json({
        status: 'degraded',
        message: 'Cơ sở dữ liệu đang khởi tạo hoặc chưa sẵn sàng',
        database: dbStatus,
        time: new Date().toISOString()
      });
    }

    const payload = {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      database: {
        mode: dbStatus.mode,
        isPersistent: dbStatus.isPersistentOnCloud,
        usersCount: Array.isArray(db.users) ? db.users.length : 0,
        ordersCount: Array.isArray(db.orders) ? db.orders.length : 0
      },
      time: new Date().toISOString()
    };

    logger.logLeave('GET /api/health', { status: 'ok' });
    return res.json(payload);
  } catch (err) {
    logger.error('GET /api/health', 'Lỗi kiểm tra trạng thái máy chủ', { error: err.message });
    return res.status(503).json({
      status: 'unhealthy',
      error: 'Không thể truy cập cơ sở dữ liệu',
      time: new Date().toISOString()
    });
  }
});

// Register all API routes
registerCashbackRoutes(app);

// Strict 404 JSON response for unhandled API endpoints
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint không tồn tại.' });
});

// SPA fallback for frontend client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handling middleware (differentiate status codes and avoid leaking internals)
app.use((err, req, res, next) => {
  logger.error('server', 'Unhandled error', {
    name: err.name,
    message: err.message,
    status: err.status || err.statusCode,
    path: req.path
  });

  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: 'Origin not allowed by CORS' });
  }

  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Dữ liệu gửi lên vượt quá giới hạn cho phép (tối đa 10KB).' });
  }

  if (err instanceof SyntaxError && (err.status === 400 || 'body' in err)) {
    return res.status(400).json({ error: 'Định dạng dữ liệu JSON không hợp lệ.' });
  }

  const statusCode = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

  const clientMessage = statusCode >= 500
    ? 'Đã xảy ra lỗi máy chủ nội bộ. Vui lòng thử lại sau.'
    : (err.message || 'Yêu cầu không hợp lệ.');

  return res.status(statusCode).json({ error: clientMessage });
});

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    logger.error('process', 'Unhandled Rejection tại promise', {
      reason: reason instanceof Error ? reason.stack : String(reason)
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('process', 'Uncaught Exception', {
      error: err ? err.stack || err.message : 'Unknown error'
    });
  });

  initPostgresIfConfigured().catch((err) => {
    logger.error('server', 'Khởi tạo kết nối Postgres nền thất bại', { error: err.message });
  });

  const server = app.listen(PORT, () => {
    logger.log('server', `HoanTienShop Web App running at http://localhost:${PORT}`, {
      port: PORT
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('server', `Cổng ${PORT} đã bị chiếm dụng bởi tiến trình khác (EADDRINUSE). Hãy tắt tiến trình cũ hoặc đổi PORT trong .env`, { port: PORT, code: err.code });
    } else {
      logger.error('server', `Lỗi khởi động máy chủ: ${err.message}`, { error: err.stack, code: err.code });
    }
    process.exit(1);
  });
}

module.exports = app;
