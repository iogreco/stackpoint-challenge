/**
 * Database Migration Runner
 *
 * Runs SQL migration files on startup.
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { config, logger } from '@stackpoint/shared';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.databaseUrl,
});

async function runMigrations(): Promise<void> {
  const client = await pool.connect();

  try {
    logger.info('Running database migrations');

    // Read migration files
    const migrationsDir = path.join(__dirname, '../src/migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      logger.info('Running migration', { file });

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query(sql);

      logger.info('Migration complete', { file });
    }

    logger.info('All migrations complete');
  } catch (error) {
    logger.error('Migration failed', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
