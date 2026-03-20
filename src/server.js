// src/server.js
// Shih-Fu CRM+ — Express API Server
// India-focused retention platform for Veterinary, Salon & Auto verticals

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const logger   = require('./utils/logger');
const R        = require('./utils/response');
const { pool } = require('../config/database');
const { startReminderCron } = require('./services/reminderCron');

// ─── Routes ───────────────────────────────────────────────────────
const authRoutes         = require('./routes/auth');
const customerRoutes     = require('./routes/customers');
const serviceEventRoutes = require('./routes/serviceEvents');
const reminderRoutes     = require('./routes/reminders');
const analyticsRoutes    = require('./routes/analytics');

const app     = express();
const VERSION = process.env.API_VERSION || 'v1';
const PORT    = parseInt(process.env.PORT || '4000');

// ─── Security & Parsing ───────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== 'production')      return cb(null, true);
    cb(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── HTTP Logging ─────────────────────────────────────────────────
app.use(morgan(
  process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
  { stream: { write: msg => logger.http(msg.trim()) } }
));

// ─── Rate Limiting ────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 min
  max:      parseInt(process.env.RATE_LIMIT_MAX        || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min window
  max: 10,                    // 10 login attempts per window
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' },
});

app.use(`/api/${VERSION}`, limiter);
app.use(`/api/${VERSION}/auth/login`,    authLimiter);
app.use(`/api/${VERSION}/auth/register`, authLimiter);

// ─── Routes ───────────────────────────────────────────────────────
app.use(`/api/${VERSION}/auth`,           authRoutes);
app.use(`/api/${VERSION}/customers`,      customerRoutes);
app.use(`/api/${VERSION}/service-events`, serviceEventRoutes);
app.use(`/api/${VERSION}/reminders`,      reminderRoutes);
app.use(`/api/${VERSION}/analytics`,      analyticsRoutes);

// ─── Health Check ─────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch { /* db not available */ }

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status:    dbOk ? 'ok' : 'degraded',
    version:   VERSION,
    timestamp: new Date().toISOString(),
    database:  dbOk ? 'connected' : 'unavailable',
    env:       process.env.NODE_ENV,
  });
});

// ─── 404 ──────────────────────────────────────────────────────────
app.use((req, res) => {
  R.notFound(res, `Route ${req.method} ${req.path} not found`);
});

// ─── Global Error Handler ─────────────────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error('Unhandled error', {
    error:   err.message,
    stack:   process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    path:    req.path,
    method:  req.method,
  });

  if (err.type === 'entity.too.large') {
    return R.badRequest(res, 'Request payload too large');
  }

  R.error(res, process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message);
});

// ─── Startup ──────────────────────────────────────────────────────
async function start() {
  // Verify DB connection before accepting traffic
  try {
    await pool.query('SELECT NOW()');
    logger.info('Database connected');
  } catch (err) {
    logger.error('Database connection failed', { error: err.message });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`Shih-Fu API running on port ${PORT}`, {
      version: VERSION,
      env:     process.env.NODE_ENV,
      base:    `/api/${VERSION}`,
    });
  });

  // Start scheduled reminder processing
  if (process.env.NODE_ENV !== 'test') {
    startReminderCron();
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await pool.end();
  process.exit(0);
});

module.exports = app; // for testing
