// migrations/run.js
// Applies SQL migration files in order against the configured DATABASE_URL.
// Usage:
//   node migrations/run.js          → run all pending migrations
//   node migrations/run.js down     → drop everything (dev only)

require('dotenv').config();
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  const direction = process.argv[2] || 'up';

  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT    NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    if (direction === 'down') {
      if (process.env.NODE_ENV === 'production') {
        console.error('ERROR: Cannot run migrations down in production.');
        process.exit(1);
      }
      console.log('Rolling back — dropping all tables...');
      await client.query(`
        DROP SCHEMA public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO postgres;
        GRANT ALL ON SCHEMA public TO public;
      `);
      console.log('Rollback complete.');
      return;
    }

    // Find all .sql files in this directory, sorted by name
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // Get already-applied migrations
    const { rows } = await client.query('SELECT filename FROM _migrations');
    const applied  = new Set(rows.map(r => r.filename));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  SKIP  ${file}  (already applied)`);
        continue;
      }
      console.log(`  APPLY ${file} ...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  DONE  ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAIL  ${file}:`, err.message);
        throw err;
      }
    }

    console.log(`\nMigrations complete. ${count} file(s) applied.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error('Migration error:', err); process.exit(1); });
