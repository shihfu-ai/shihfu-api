// config/database.js
// PostgreSQL connection pool using node-postgres (pg)

const { Pool } = require('pg');
const logger   = require('../src/utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min:  parseInt(process.env.DB_POOL_MIN  || '2'),
  max:  parseInt(process.env.DB_POOL_MAX  || '10'),
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('connect', () => logger.debug('DB: new client connected'));
pool.on('error',  (err) => logger.error('DB pool error', { error: err.message }));

// Convenience query wrapper — automatically releases client back to pool
// Supabase's pooler occasionally drops an idle connection just as a query
// is handed to it. Re-running a read-only query once is harmless and saves
// the user a spurious 500; writes are never retried (they might have run).
const DROPPED = /Connection terminated|ECONNRESET|terminating connection/i;
const isReadOnly = (t) => /^s*(select|with)/i.test(t) && !/(insert|update|delete)/i.test(t);

async function query(text, params) {
  const start = Date.now();
  let res;
  try {
    res = await pool.query(text, params);
  } catch (err) {
    if (!DROPPED.test(err.message) || !isReadOnly(text)) throw err;
    logger.warn('DB connection dropped; retrying read query once', { error: err.message });
    res = await pool.query(text, params);
  }
  const duration = Date.now() - start;
  logger.debug('DB query', { text: text.slice(0, 80), duration, rows: res.rowCount });
  return res;
}

// Transaction helper — pass an async callback that receives a client
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // The connection may be what failed, in which case ROLLBACK throws too
    // and would hide the real error.
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
