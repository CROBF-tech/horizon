import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import { adminUsers } from '../db/schema';
import { err, ok, type Result, type ServiceError } from './types';

/**
 * Result of a successful admin authentication.
 */
export type AdminSession = {
  id: number;
  username: string;
};

/**
 * Create the CROBF admin account. Fails with CONFLICT if a row already exists.
 *
 * @param username - Admin login.
 * @param password - Plaintext password; will be hashed with bcrypt (cost 10).
 * @returns Result with the created admin id/username.
 */
export async function createAdminUser(
  username: string,
  password: string,
): Promise<Result<AdminSession, ServiceError>> {
  try {
    const u = (username ?? '').trim();
    if (u.length < 3 || u.length > 60) {
      return err('VALIDATION', 'username must be 3..60 chars');
    }
    if (!password || password.length < 8) {
      return err('VALIDATION', 'password must be at least 8 chars');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const inserted = await db
      .insert(adminUsers)
      .values({ username: u, passwordHash })
      .returning({ id: adminUsers.id, username: adminUsers.username });
    const row = inserted[0];
    if (!row) return err('DATABASE', 'insert returned no rows');
    return ok(row);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', 'admin user already exists', cause);
    }
    return err('DATABASE', 'failed to create admin user', cause);
  }
}

/**
 * Authenticate against the admin_users table. Returns UNAUTHORIZED when the
 * username/password pair does not match. The same code is returned for both
 * "user not found" and "bad password" to avoid leaking which one failed.
 *
 * @param username - Submitted username.
 * @param password - Submitted plaintext password.
 * @returns Result with AdminSession on success.
 */
export async function authenticateAdmin(
  username: string,
  password: string,
): Promise<Result<AdminSession, ServiceError>> {
  try {
    const u = (username ?? '').trim();
    if (!u || !password) {
      return err('VALIDATION', 'username and password are required');
    }
    const rows = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.username, u))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return err('UNAUTHORIZED', 'invalid credentials');
    }
    const ok_ = await bcrypt.compare(password, row.passwordHash);
    if (!ok_) {
      return err('UNAUTHORIZED', 'invalid credentials');
    }
    return ok({ id: row.id, username: row.username });
  } catch (cause) {
    return err('DATABASE', 'failed to authenticate admin', cause);
  }
}

/**
 * Change the admin password. Requires the current password.
 *
 * @param username - Admin username.
 * @param currentPassword - Current plaintext password.
 * @param newPassword - New plaintext password (>= 8 chars).
 * @returns Result with confirmation.
 */
export async function changeAdminPassword(
  username: string,
  currentPassword: string,
  newPassword: string,
): Promise<Result<{ updated: true }, ServiceError>> {
  try {
    const auth = await authenticateAdmin(username, currentPassword);
    if (!auth.ok) return auth;
    if (!newPassword || newPassword.length < 8) {
      return err('VALIDATION', 'new password must be at least 8 chars');
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    const updated = await db
      .update(adminUsers)
      .set({ passwordHash: newHash })
      .where(eq(adminUsers.id, auth.value.id))
      .returning({ id: adminUsers.id });
    if (updated.length === 0) {
      return err('NOT_FOUND', 'admin user vanished');
    }
    return ok({ updated: true });
  } catch (cause) {
    return err('DATABASE', 'failed to change admin password', cause);
  }
}

/**
 * Fetch the currently configured admin (no credentials).
 *
 * @returns Result with AdminSession or NOT_FOUND if no admin row exists.
 */
export async function getCurrentAdmin(): Promise<
  Result<AdminSession, ServiceError>
> {
  try {
    const rows = await db
      .select({ id: adminUsers.id, username: adminUsers.username })
      .from(adminUsers)
      .limit(1);
    const row = rows[0];
    if (!row) return err('NOT_FOUND', 'no admin user seeded');
    return ok(row);
  } catch (cause) {
    return err('DATABASE', 'failed to fetch current admin', cause);
  }
}
