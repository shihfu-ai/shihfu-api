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
async function query(text, params) {
  const start = Date.now();
  const res   = await pool.query(text, params);
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
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
