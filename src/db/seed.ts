import 'dotenv/config';
import { count } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from './index';
import { adminUsers } from './schema';

const username = process.env.ADMIN_USERNAME;
const passwordHash = process.env.ADMIN_PASSWORD_HASH;

if (!username || !passwordHash) {
  throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD_HASH must be set');
}

async function seedAdmin() {
  const [{ value: total }] = await db
    .select({ value: count() })
    .from(adminUsers);

  if (total > 0) {
    console.log(`admin_users already has ${total} row(s); skipping seed`);
    return;
  }

  await db.insert(adminUsers).values({ username, passwordHash });
  console.log(`seeded admin '${username}' into admin_users`);
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
