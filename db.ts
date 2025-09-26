import { Client, Pool } from 'pg';

// Database connection configuration
const DB_CONFIG = {
  connectionString: process.env.PAYJOB_DB_URI || process.env.DATABASE_URL,
  ssl: false, // Adjust based on your setup
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// Create a connection pool
const pool = new Pool(DB_CONFIG);

/**
 * Execute a query using the pool
 */
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Get a client for transaction operations
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Execute a transaction with automatic rollback on error
 */
export async function transaction<T>(
  fn: (client: any) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * End the pool (for graceful shutdown)
 */
export async function endPool() {
  await pool.end();
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  await endPool();
});

process.on('SIGINT', async () => {
  await endPool();
});