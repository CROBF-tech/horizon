import 'dotenv/config';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';

let _client: ReturnType<typeof createClient> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is not set');
  }
  _client = createClient({ url, authToken });
  return _client;
}

function getDb() {
  if (_db) return _db;
  _db = drizzle({ client: getClient(), schema });
  return _db;
}

/**
 * Lazily-constructed Drizzle DB proxy. Throws at call time (not at import time)
 * if env vars are missing, so importing this module in non-runtime contexts
 * (e.g. Astro build) doesn't crash.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export type Database = typeof db;
