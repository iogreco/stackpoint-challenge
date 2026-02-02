/**
 * One-time database schema setup (run when starting from scratch).
 * Runs schema/init.sql to create tables and indexes.
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { config, logger } from '@stackpoint/shared';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.databaseUrl,
});

async function runInitSchema(): Promise<void> {
  const client = await pool.connect();

  try {
    logger.info('Running database schema (init.sql)');

    const schemaPath = path.join(__dirname, '..', 'src', 'schema', 'init.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    await client.query(sql);

    logger.info('Database schema complete');
  } catch (error) {
    logger.error('Schema init failed', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runInitSchema()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
